"""Integration tests: real FastAPI app, SQLite, job threads and risk layer. Only the market-data
provider is replaced by a deterministic offline fake (see conftest.py)."""
import time

import pytest
from fastapi.testclient import TestClient

from atlas.main import create_app


def wait_job(c, jid, timeout=240):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = next(x for x in c.get("/api/jobs").json() if x["id"] == jid)
        if j["status"] not in ("queued", "running"):
            return j
        time.sleep(0.2)
    raise AssertionError("job timeout")


@pytest.fixture
def client(settings, providers):
    app = create_app(settings, providers=providers, start_background=False)
    with TestClient(app) as c:
        j = wait_job(c, c.post("/api/markets/refresh", json={}).json()["job_id"])
        assert j["status"] == "completed", j.get("error")
        yield c


def test_ingestion_failover_and_status(client, providers):
    st = {m["symbol"]: m for m in client.get("/api/markets").json()}
    assert st["EUR/USD"]["provider"] == "frankfurter" and st["EUR/USD"]["has_ohlc"] is False
    assert st["BTC/USD"]["provider"] == "kraken"  # coinbase outage → failover
    assert providers["coinbase"].calls >= 1
    assert all(m["rows"] > 500 for m in st.values())
    assert any("failed" in e["message"] for e in client.get("/api/events?category=data").json())
    bars = client.get("/api/markets/EUR-USD/bars?limit=10").json()
    assert len(bars["bars"]) == 10 and bars["bars"][0]["o"] is None
    assert client.get("/api/markets/BTC-USD/quality").json()["quality"]["missing_periods"] == 0


def test_backtest_reproduce_and_input_validation(client):
    r = client.post("/api/backtest", json={"symbol": "BTC/USD", "strategy": "ma_crossover", "params": {"fast": 10, "slow": 50}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["metrics"]["num_trades"] > 0 and body["series"]["equity"]
    assert client.post(f"/api/experiments/{body['experiment_id']}/reproduce").json()["match"] is True
    assert client.post("/api/backtest", json={"symbol": "BTC/USD", "strategy": "ma_crossover",
                                              "params": {"fast": 50, "slow": 10}}).status_code == 422
    assert client.post("/api/backtest", json={"symbol": "XXX/USD", "strategy": "ma_crossover"}).status_code == 404


def test_evaluate_forecast_features_regime_graph(client):
    ev = client.post("/api/evaluate", json={"symbol": "ETH/USD", "strategy": "donchian_breakout"}).json()
    assert ev["walk_forward"]["folds"]
    fc = client.post("/api/forecast", json={"symbol": "EUR/USD", "model": "drift", "horizon": 10, "eval_origins": 30}).json()
    assert len(fc["forecast"]["path"]) == 10 and fc["evaluation"]["models"]
    assert client.get("/api/markets/GBP-USD/features").json()["features"]
    assert client.get("/api/markets/USD-JPY/regime").json()["current"]
    g = client.get("/api/graph").json()
    assert len(g["nodes"]) > 30 and len(g["edges"]) > 60


def test_research_cycle_end_to_end(client):
    j = wait_job(client, client.post("/api/jobs/research-cycle", json={"max_hypotheses": 4}).json()["job_id"])
    assert j["status"] == "completed", j.get("error")
    assert j["result"]["evaluated"] >= 1
    exps = client.get("/api/experiments?kind=hypothesis_test").json()
    assert exps and all(e["verdict"] in ("accepted", "rejected") for e in exps)
    detail = client.get(f"/api/experiments/{exps[0]['id']}").json()
    assert {"critic", "risk", "test_backtest"} <= set(detail["artifacts"])
    assert client.post(f"/api/experiments/{exps[0]['id']}/reproduce").json()["match"] is True
    agents = {a["name"]: a for a in client.get("/api/agents").json()}
    assert agents["critic"]["runs"] >= 1 and agents["backtester"]["last_run"]["status"] == "ok"
    assert client.get("/api/research/reports").json()[0]["report"]["evaluated"] == j["result"]["evaluated"]
    # a second cycle on unchanged data must not re-test identical exploration hypotheses
    j2 = wait_job(client, client.post("/api/jobs/research-cycle", json={"max_hypotheses": 4, "refresh": False}).json()["job_id"])
    assert j2["status"] == "completed", j2.get("error")
    rows = client.get("/api/experiments?kind=hypothesis_test&limit=2000").json()
    keys = [(e["symbol"], e["strategy"], str(e["params"]), e["dataset_version"]) for e in rows if e["hypothesis"]["origin"] == "exploration"]
    assert len(keys) == len(set(keys))


def test_job_cancellation(client):
    jid = client.post("/api/jobs/research-cycle", json={"max_hypotheses": 40, "refresh": False}).json()["job_id"]
    time.sleep(0.5)
    assert client.post(f"/api/jobs/{jid}/cancel").status_code == 200
    assert wait_job(client, jid, 120)["status"] == "cancelled"


def test_paper_trading_and_backend_risk_enforcement(client):
    acct = client.get("/api/paper/account").json()
    assert acct["mode"] == "PAPER" and acct["state"] == "paused"
    px = {m["symbol"]: m["last_close"] for m in client.get("/api/markets").json()}
    eq = acct["equity"]
    qty = 0.1 * eq / px["EUR/USD"]
    assert client.post("/api/paper/orders", json={"symbol": "EUR/USD", "side": "buy", "qty": qty}).json()["status"] == "filled"
    big = client.post("/api/paper/orders", json={"symbol": "BTC/USD", "side": "buy", "qty": 0.45 * eq / px["BTC/USD"]}).json()
    assert big["status"] == "rejected" and "max_position_exposure" in big["reject_reason"]
    lim = client.post("/api/paper/orders", json={"symbol": "ETH/USD", "side": "buy", "qty": 1, "type": "limit",
                                                 "limit_price": px["ETH/USD"] * 0.5}).json()
    assert lim["status"] == "open"
    assert client.delete(f"/api/paper/orders/{lim['id']}").json()["status"] == "cancelled"
    assert client.delete(f"/api/paper/orders/{lim['id']}").status_code == 409
    # kill switch: new risk rejected, exposure reduction allowed
    client.put("/api/risk/limits", json={"kill_switch": True})
    rej = client.post("/api/paper/orders", json={"symbol": "GBP/USD", "side": "buy", "qty": 100}).json()
    assert rej["status"] == "rejected" and "kill_switch" in rej["reject_reason"]
    assert client.post("/api/paper/orders", json={"symbol": "EUR/USD", "side": "sell", "qty": qty / 2}).json()["status"] == "filled"
    client.put("/api/risk/limits", json={"kill_switch": False})
    # autonomous strategy execution
    client.post("/api/paper/strategies", json={"symbol": "BTC/USD", "strategy": "ts_momentum", "params": {"lookback": 20}, "allocation": 0.2})
    assert client.post("/api/paper/control", json={"action": "start"}).json()["state"] == "running"
    assert client.post("/api/paper/tick").json()["state"] == "running"
    # emergency stop flattens and halts; resume refused until released
    assert client.post("/api/paper/control", json={"action": "emergency_stop"}).json()["state"] == "halted"
    assert client.get("/api/paper/positions").json() == []
    assert client.post("/api/paper/control", json={"action": "resume"}).status_code == 409
    client.post("/api/paper/control", json={"action": "release"})
    assert client.post("/api/paper/control", json={"action": "resume"}).json()["state"] == "running"
    ev = client.get("/api/risk/events").json()
    assert any(e["decision"] == "reject" for e in ev) and any(e["rule"] == "kill_switch" for e in ev)
    assert set(client.get("/api/risk/status").json()["gauges"]) == {"drawdown", "daily_pnl", "gross_exposure", "max_position"}


def test_websocket_streams_real_events(client):
    with client.websocket_connect("/api/ws") as ws:
        client.post("/api/paper/tick")
        assert ws.receive_json()["category"] in ("paper", "risk", "heartbeat")


def test_autonomy_config_validation(client):
    assert client.put("/api/autonomy", json={"research_interval_minutes": 1}).status_code == 422
    st = client.put("/api/autonomy", json={"enabled": True, "research_interval_minutes": 30}).json()
    assert st["config"]["enabled"] is True and "Codespace" in st["note"]


def test_waitlist_signup_validation_and_idempotency(client):
    assert client.get("/api/waitlist/count").json()["count"] == 0
    ok = client.post("/api/waitlist", json={"email": "Trader@Example.com", "markets": ["crypto", "forex"], "experience": "intermediate"})
    assert ok.status_code == 200 and ok.json()["status"] == "registered"
    again = client.post("/api/waitlist", json={"email": "trader@example.com"})
    assert again.json()["status"] == "already_registered"
    assert client.get("/api/waitlist/count").json()["count"] == 1
    assert client.post("/api/waitlist", json={"email": "not-an-email"}).status_code == 422
    assert client.post("/api/waitlist", json={"email": "a@b.co", "markets": ["lottery"]}).status_code == 422
