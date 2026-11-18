from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from ..agents.core import backtest_config_for
from ..agents.llm import llm_status
from ..backtest.engine import CostModel, run_backtest
from ..backtest.walkforward import full_evaluation, neighbours
from ..config import code_version
from ..data.instruments import INSTRUMENTS, get_instrument, unslug
from ..data.licensing import describe as describe_licenses
from ..data.service import FX_LABEL, INTRADAY, DataUnavailable, data_label
from ..db import LOCAL_USER_ID, dumps, loads, utcnow
from ..jobs import LimitError
from ..reports import away_report, mark_seen
from ..research.registry import METHODOLOGY
from ..research.validation import DISPOSITION_LABEL, GATES_V2
from ..forecasting.models import MODELS, forecast, rolling_evaluation
from ..paper.broker import PaperError
from ..research.features import FEATURE_DOCS, feature_importance
from ..research.regime import classify, summarize
from ..research.strategies.library import REGISTRY, get_strategy
from ..risk.manager import RiskLimits
from . import schemas as S

router = APIRouter(prefix="/api")


def uid(request: Request) -> int:
    """The authenticated user's id (set by the auth layer); the local owner in single-user mode."""
    return int(getattr(request.state, "user_id", LOCAL_USER_ID))
STARTED = time.time()


def svc(request: Request):
    return request.app.state.services


def _sym(s: str) -> str:
    try:
        return get_instrument(unslug(s) if "/" not in s else s).symbol
    except KeyError as e:
        raise HTTPException(404, str(e))


def _load(sv, symbol: str, timeframe: str = "1d", min_rows: int = 260):
    try:
        return sv.data.require(symbol, timeframe, min_rows)
    except DataUnavailable as e:
        raise HTTPException(409, str(e))


# ---------------- system ----------------
@router.get("/health")
def health(request: Request):
    sv = svc(request)
    return {"status": "ok", "uptime_s": round(time.time() - STARTED), "code_version": code_version(), "mode": "PAPER_ONLY",
            "live_trading": False, "db": str(sv.settings.db_path)}


@router.get("/system/overview")
def overview(request: Request):
    sv = svc(request)
    q = sv.db.one
    counts = {
        "bars": q("SELECT COUNT(*) n FROM bars")["n"],
        "datasets": q("SELECT COUNT(*) n FROM datasets")["n"],
        "experiments": q("SELECT COUNT(*) n FROM experiments WHERE kind='hypothesis_test' AND user_id=?", (uid(request),))["n"],
        "accepted": q("SELECT COUNT(*) n FROM experiments WHERE kind='hypothesis_test' AND disposition='survived' AND user_id=?", (uid(request),))["n"],
        "requires_confirmation": q("SELECT COUNT(*) n FROM experiments WHERE kind='hypothesis_test' AND disposition='requires_confirmation' AND user_id=?", (uid(request),))["n"],
        "insufficient_evidence": q("SELECT COUNT(*) n FROM experiments WHERE kind='hypothesis_test' AND disposition='insufficient_evidence' AND user_id=?", (uid(request),))["n"],
        "requires_revalidation": q("SELECT COUNT(*) n FROM experiments WHERE kind='hypothesis_test' AND disposition='requires_revalidation' AND user_id=?", (uid(request),))["n"],
        "trials": q("SELECT COUNT(*) n FROM trials WHERE user_id=?", (uid(request),))["n"],
        "manual_backtests": q("SELECT COUNT(*) n FROM experiments WHERE kind='manual_backtest'")["n"],
        "reports": q("SELECT COUNT(*) n FROM experiments WHERE kind='research_report'")["n"],
        "deployed": q("SELECT COUNT(*) n FROM strategy_configs WHERE status='deployed'")["n"],
        "events": q("SELECT COUNT(*) n FROM events")["n"],
        "agent_runs": q("SELECT COUNT(*) n FROM agent_runs")["n"],
        "risk_rejections": q("SELECT COUNT(*) n FROM risk_events WHERE decision='reject'")["n"],
        "jobs_active": len(sv.jobs.active(user_id=uid(request))),
    }
    try:
        load = os.getloadavg()
    except OSError:
        load = None
    db_size = sv.settings.db_path.stat().st_size if sv.settings.db_path.exists() else 0
    return {"counts": counts, "uptime_s": round(time.time() - STARTED), "code_version": code_version(), "load_avg": load,
            "db_bytes": db_size, "autonomy": sv.scheduler.status(uid(request)), "llm": llm_status(), "paper": sv.paper.account(),
            "kill_switch": sv.risk.limits().kill_switch, "mode": "PAPER_ONLY"}


@router.get("/events")
def events(request: Request, limit: int = Query(200, le=2000), category: str | None = None, before: int | None = None):
    sql, args = "SELECT * FROM events WHERE 1=1", []
    if category:
        sql += " AND category=?"; args.append(category)
    if before:
        sql += " AND id<?"; args.append(before)
    rows = svc(request).db.query(sql + " ORDER BY id DESC LIMIT ?", (*args, limit))
    for r in rows:
        r["data"] = loads(r.pop("data_json"), {})
    return rows


@router.websocket("/ws")
async def ws(websocket: WebSocket):
    sv = websocket.app.state.services
    await websocket.accept()
    q = sv.bus.subscribe()
    try:
        while True:
            try:
                ev = await asyncio.wait_for(q.get(), timeout=20)
                await websocket.send_text(dumps(ev))
            except asyncio.TimeoutError:
                await websocket.send_text(dumps({"category": "heartbeat", "ts": utcnow()}))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        sv.bus.unsubscribe(q)


# ---------------- markets ----------------
@router.get("/markets")
def markets(request: Request):
    return svc(request).data.status()


@router.post("/markets/refresh")
def refresh(request: Request, body: S.RefreshRequest):
    syms = [_sym(s) for s in body.symbols] if body.symbols else None
    return {"job_id": svc(request).submit_data_refresh({"symbols": syms, "full": body.full})}


@router.get("/markets/{symbol}/bars")
def bars(request: Request, symbol: str, timeframe: str = "1d", limit: int = Query(2000, le=10000)):
    sv = svc(request)
    sym = _sym(symbol)
    inst = get_instrument(sym)
    intraday = timeframe in INTRADAY
    if intraday and inst.asset_class != "crypto":
        raise HTTPException(400, "Intraday candles are available for crypto only. Forex uses daily ECB reference rates.")
    try:
        if intraday:
            last = sv.db.one("SELECT MAX(ts) ts FROM bars WHERE symbol=? AND timeframe=?", (sym, timeframe))["ts"]
            step = 3600 if timeframe == "1h" else 21600
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() if last else None
            if age is None or age > 2 * step:
                sv.data.refresh_intraday(sym, timeframe)
        df = sv.data.load(sym, timeframe).iloc[-limit:]
    except DataUnavailable as e:
        raise HTTPException(409, str(e))
    ds = sv.data.latest_dataset(sym)
    label = data_label(inst, timeframe, sv.data.intraday_days.get(timeframe))
    return {"symbol": sym, "timeframe": timeframe, **label,
            "dataset": {k: ds[k] for k in ("version", "provider", "attribution", "has_ohlc", "has_volume")} if ds and not intraday else None,
            "bars": [{"t": (t.isoformat() if intraday else t.date().isoformat()), "o": _n(r.open), "h": _n(r.high), "l": _n(r.low),
                      "c": float(r.close), "v": _n(r.volume)} for t, r in df.iterrows()]}


@router.get("/markets/{symbol}/quality")
def quality(request: Request, symbol: str):
    sv = svc(request)
    ds = sv.data.latest_dataset(_sym(symbol))
    if not ds:
        raise HTTPException(404, "no dataset yet")
    versions = sv.db.query("SELECT version, provider, rows, end_ts, quality_status, created_at FROM datasets WHERE symbol=? ORDER BY id DESC LIMIT 30", (ds["symbol"],))
    return {**ds, "versions": versions, "quarantine": sv.data.quarantine(ds["symbol"], 50)}


@router.get("/data/licensing")
def licensing(request: Request):
    sv = svc(request)
    return {"deployment_mode": sv.data.mode, "sources": describe_licenses(sv.data.mode),
            "fx_label": FX_LABEL, "doc": "docs/DATA_LICENSING.md"}


@router.get("/markets/{symbol}/regime")
def regime(request: Request, symbol: str):
    sym = _sym(symbol)
    df = _load(svc(request), sym)
    return summarize(classify(df, get_instrument(sym).periods_per_year))


@router.get("/markets/{symbol}/features")
def features(request: Request, symbol: str, horizon: int = Query(5, ge=1, le=60)):
    sym = _sym(symbol)
    df = _load(svc(request), sym, min_rows=400)
    out = feature_importance(df, get_instrument(sym).periods_per_year, horizon)
    out["docs"] = FEATURE_DOCS
    return out


@router.get("/markets/correlations")
def correlations(request: Request, window: int = Query(90, ge=20, le=1000)):
    m = svc(request).risk.correlation_matrix(window=window)
    return {"window": window, "symbols": list(m.columns), "matrix": [[_n(v) for v in row] for row in m.to_numpy()] if not m.empty else []}


# ---------------- strategies & backtests ----------------
@router.get("/strategies")
def strategies():
    return [cls.spec().__dict__ for cls in REGISTRY.values()]


@router.post("/backtest")
def backtest(request: Request, body: S.BacktestRequest):
    sv = svc(request)
    sym = _sym(body.symbol)
    inst = get_instrument(sym)
    try:
        cls = get_strategy(body.strategy)
        strat = cls(**body.params)
    except (KeyError, ValueError) as e:
        raise HTTPException(422, str(e))
    df = _load(sv, sym, body.timeframe, 60)
    cfg = backtest_config_for(inst, sizing=body.sizing, fraction=body.fraction, vol_target=body.vol_target,
                              max_leverage=body.max_leverage, initial_cash=body.initial_cash, start=body.start, end=body.end)
    if body.timeframe == "1w":
        cfg.periods_per_year = 52
    c = body.costs
    cfg.costs = CostModel(inst.default_spread_bps if c.spread_bps is None else c.spread_bps,
                          inst.default_fee_bps if c.fee_bps is None else c.fee_bps,
                          inst.default_slippage_bps if c.slippage_bps is None else c.slippage_bps)
    holdout = None
    if body.timeframe == "1d":
        hs = sv.registry.holdout_start(uid(request), sym, df.index)
        holdout = {**(sv.registry.holdout_info(uid(request), sym) or {}), "included": body.include_holdout}
        if not body.include_holdout:
            before = df.index[df.index < hs]
            if len(before) < 60:
                raise HTTPException(409, "Not enough data before the sealed holdout for a backtest.")
            last = before[-1].date().isoformat()
            cfg.end = min(cfg.end, last) if cfg.end else last  # recorded in the config so the run is reproducible
    t0 = time.perf_counter()
    try:
        res = run_backtest(df, strat, cfg, classify(df, cfg.periods_per_year)["trend"])
    except ValueError as e:
        raise HTTPException(422, str(e))
    payload = res.to_payload()
    payload["runtime_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    ds = sv.data.latest_dataset(sym)
    payload["dataset_version"] = ds["version"] if ds else None
    payload["data_note"] = ("Close-only ECB reference data: orders fill at the NEXT reference fix (one full bar delay)."
                            if not ds or not ds["has_ohlc"] else "OHLC data: orders fill at the next bar's open.")
    payload["holdout"] = holdout
    if body.save and body.timeframe == "1d":
        eid = sv.db.insert("experiments", {"created_at": utcnow(), "kind": "manual_backtest", "status": "completed", "symbol": sym,
                                           "user_id": uid(request), "methodology": METHODOLOGY,
                                           "strategy": strat.key, "params_json": dumps(strat.p), "config_json": dumps(cfg.to_dict()),
                                           "dataset_version": payload["dataset_version"], "code_version": code_version(),
                                           "metrics_json": dumps({"test": res.metrics, "benchmark_test": res.benchmark})})
        sv.db.insert("experiment_artifacts", {"experiment_id": eid, "name": "test_backtest", "json": dumps(res.to_payload(600))})
        payload["experiment_id"] = eid
        sv.registry.register(user_id=uid(request), kind="manual_backtest", symbol=sym, strategy=strat.key, params=strat.p,
                             dataset_version=payload["dataset_version"], window=(res.equity.index[0].date().isoformat(), res.equity.index[-1].date().isoformat()),
                             returns=None, selection_returns=res.returns, sharpe=res.metrics.get("sharpe"), experiment_id=eid,
                             method="manual_backtest", touches_holdout=bool(body.include_holdout))
        sv.bus.emit("research", f"Manual backtest #{eid}: {strat.key} on {sym} → {res.metrics.get('total_return', 0):+.2%}",
                    source="api", data={"node": f"exp:{eid}"})
    return payload


@router.post("/evaluate")
def evaluate(request: Request, body: S.EvaluateRequest):
    """Full robustness battery for one hypothesis (synchronous; typically 1–5 s)."""
    sv = svc(request)
    sym = _sym(body.symbol)
    inst = get_instrument(sym)
    try:
        cls = get_strategy(body.strategy)
        params = cls(**body.params).p
    except (KeyError, ValueError) as e:
        raise HTTPException(422, str(e))
    _load(sv, sym, min_rows=700)
    df, hs, _ = sv.validator.windows(uid(request), sym)
    if len(df) < 700:
        raise HTTPException(409, "Not enough data before the sealed holdout to validate.")
    grid = [params] + neighbours(cls, params)[:6] if body.walk_forward else None
    ev = full_evaluation(df, cls, params, backtest_config_for(inst), classify(df, inst.periods_per_year)["trend"], walkforward_grid=grid)
    test = ev.pop("_test_result")
    rr, nb = ev.pop("_research_returns"), ev.pop("_neighbour_runs")
    ds = sv.data.latest_dataset(sym)
    sv.registry.register(user_id=uid(request), kind="manual_validation", symbol=sym, strategy=cls.key, params=params,
                         dataset_version=ds["version"] if ds else None, window=(ev["splits"]["train"][0], ev["splits"]["test"][1]),
                         returns=rr, selection_returns=test.returns, p_value=None, sharpe=ev["test"].get("sharpe"), method="manual_validation")
    for v in nb:
        sv.registry.register(user_id=uid(request), kind="manual_validation", symbol=sym, strategy=cls.key, params=v["params"],
                             dataset_version=ds["version"] if ds else None, window=(ev["splits"]["train"][0], ev["splits"]["test"][1]),
                             returns=v["returns"], selection_returns=v["selection_returns"], sharpe=v["sharpe"], method="manual_validation_variant")
    fam = sv.registry.family_stats(uid(request), sym)
    return {**ev, "test_series": test.to_payload(600)["series"], "trades": test.trades[-200:], "research_end": hs.date().isoformat(),
            "holdout": sv.registry.holdout_info(uid(request), sym), "family": fam}


# ---------------- forecasting ----------------
@router.get("/forecast/models")
def forecast_models():
    return [{"key": k, "name": v[0], "description": v[2]} for k, v in MODELS.items()]


@router.post("/forecast")
def run_forecast(request: Request, body: S.ForecastRequest):
    sym = _sym(body.symbol)
    df = _load(svc(request), sym, min_rows=400)
    ppy = get_instrument(sym).periods_per_year
    out = {"forecast": forecast(df, body.model, body.horizon),
           "history": [{"t": t.date().isoformat(), "c": float(v)} for t, v in df["close"].iloc[-250:].items()],
           "disclaimer": "Statistical baseline forecast with prediction intervals. Not a price target or trading advice."}
    if body.evaluate:
        out["evaluation"] = rolling_evaluation(df, horizon=body.horizon, n_origins=body.eval_origins, periods_per_year=ppy)
    svc(request).bus.emit("research", f"Forecast {body.model} h={body.horizon} on {sym}", source="forecast", data={"node": "forecast"})
    return out


# ---------------- experiments ----------------
@router.get("/experiments")
def experiments(request: Request, kind: str | None = None, verdict: str | None = None, symbol: str | None = None,
                disposition: str | None = None, limit: int = Query(200, le=2000)):
    sql, args = "SELECT * FROM experiments WHERE user_id=?", [uid(request)]
    for col, val in (("kind", kind), ("verdict", verdict), ("disposition", disposition), ("symbol", _sym(symbol) if symbol else None)):
        if val:
            sql += f" AND {col}=?"; args.append(val)
    rows = svc(request).db.query(sql + " ORDER BY id DESC LIMIT ?", (*args, limit))
    return [_exp(r) for r in rows]


@router.get("/experiments/{eid}")
def experiment(request: Request, eid: int):
    sv = svc(request)
    r = sv.db.one("SELECT * FROM experiments WHERE id=? AND user_id=?", (eid, uid(request)))
    if not r:
        raise HTTPException(404, "not found")
    arts = {a["name"]: loads(a["json"]) for a in sv.db.query("SELECT name,json FROM experiment_artifacts WHERE experiment_id=?", (eid,))}
    return {**_exp(r), "artifacts": arts}


@router.post("/experiments/{eid}/reproduce")
def reproduce(request: Request, eid: int):
    """Re-run an experiment from its saved config, dataset snapshot and parameters; compare metrics."""
    sv = svc(request)
    r = sv.db.one("SELECT * FROM experiments WHERE id=? AND user_id=?", (eid, uid(request)))
    if not r or r["kind"] not in ("hypothesis_test", "manual_backtest"):
        raise HTTPException(404, "reproducible experiment not found")
    from ..backtest.engine import BacktestConfig
    cfg_d = loads(r["config_json"], {})
    splits = cfg_d.pop("splits", None)
    cfg_d.pop("strategy", None); cfg_d.pop("params", None); cfg_d.pop("research_end", None)
    cfg = BacktestConfig.from_dict(cfg_d)
    if splits:
        cfg.start, cfg.end = splits["test"]
    try:
        df = sv.data.load_version(r["symbol"], r["dataset_version"])
    except DataUnavailable as e:
        raise HTTPException(409, str(e))
    res = run_backtest(df, get_strategy(r["strategy"])(**loads(r["params_json"])), cfg)
    stored = loads(r["metrics_json"], {}).get("test", {})
    keys = ("total_return", "sharpe", "max_drawdown", "num_trades")
    diffs = {k: {"stored": stored.get(k), "reproduced": res.metrics.get(k)} for k in keys}
    match = all((a["stored"] is None and a["reproduced"] is None) or
                (a["stored"] is not None and a["reproduced"] is not None and abs(a["stored"] - a["reproduced"]) < 1e-9) for a in diffs.values())
    current = code_version()
    sv.bus.emit("research", f"Reproduced experiment #{eid}: {'MATCH' if match else 'MISMATCH'}", source="api",
                level="info" if match else "warn", data={"node": f"exp:{eid}"})
    return {"experiment_id": eid, "match": match, "metrics": diffs, "dataset_version": r["dataset_version"],
            "code_version_then": r["code_version"], "code_version_now": current,
            "note": None if r["code_version"] == current else "Code version differs from the original run; differences may stem from code changes."}


@router.get("/experiments-stats/distribution")
def distribution(request: Request):
    rows = svc(request).db.query("SELECT id, symbol, strategy, verdict, disposition, metrics_json FROM experiments WHERE kind='hypothesis_test' AND user_id=? ORDER BY id", (uid(request),))
    pts = []
    for r in rows:
        m = loads(r["metrics_json"], {})
        pts.append({"id": r["id"], "symbol": r["symbol"], "strategy": r["strategy"], "verdict": r["verdict"], "disposition": r["disposition"],
                    "is_sharpe": m.get("in_sample_sharpe"), "oos_sharpe": (m.get("test") or {}).get("sharpe"),
                    "val_sharpe": (m.get("validation") or {}).get("sharpe"), "dsr": m.get("dsr_test"),
                    "test_return": (m.get("test") or {}).get("total_return"), "max_dd": (m.get("test") or {}).get("max_drawdown")})
    return {"points": pts, "critic_rules": GATES_V2, "labels": DISPOSITION_LABEL}


@router.get("/research/integrity")
def research_integrity(request: Request):
    """How much searching has been done, and how the validation accounts for it — per market."""
    sv = svc(request)
    u = uid(request)
    reg = sv.registry
    symbols = [r["symbol"] for r in sv.db.query("SELECT DISTINCT symbol FROM trials WHERE user_id=? ORDER BY symbol", (u,))]
    per = []
    for s in symbols:
        per.append({"symbol": s, "counts": reg.counts(u, s), "family": reg.family_stats(u, s), "holdout": reg.holdout_info(u, s)})
    disp = {r["disposition"] or "unvalidated": r["n"] for r in sv.db.query(
        "SELECT disposition, COUNT(*) n FROM experiments WHERE user_id=? AND kind='hypothesis_test' GROUP BY disposition", (u,))}
    return {"methodology": METHODOLOGY, "gates": GATES_V2, "labels": DISPOSITION_LABEL, "totals": reg.counts(u),
            "fdr_family_size": len(reg.fdr_family(u)), "dispositions": disp, "markets": per,
            "documentation": "docs/STATISTICS.md"}


@router.post("/research/revalidate")
def research_revalidate(request: Request):
    """Re-evaluate legacy findings under the current methodology (background job)."""
    return {"job_id": svc(request).submit_revalidation(uid(request))}


# ---------------- agents & jobs ----------------
@router.get("/agents")
def agents(request: Request):
    return [a.describe() for a in svc(request).orchestrator.all_agents()]


@router.get("/agents/{name}/runs")
def agent_runs(request: Request, name: str, limit: int = Query(50, le=500)):
    rows = svc(request).db.query("SELECT * FROM agent_runs WHERE agent=? ORDER BY id DESC LIMIT ?", (name, limit))
    for r in rows:
        r["inputs"] = loads(r.pop("inputs_json"), None)
        r["outputs"] = loads(r.pop("outputs_json"), None)
    return rows


@router.get("/jobs")
def jobs(request: Request, limit: int = Query(50, le=500), type: str | None = None):
    """Your jobs plus shared system jobs (market-data refreshes, user 0)."""
    return svc(request).jobs.list(limit, user_id=uid(request), job_type=type)


@router.get("/jobs/{jid}")
def job(request: Request, jid: int):
    j = svc(request).jobs.get(jid)
    if not j or j["user_id"] not in (uid(request), 0):
        raise HTTPException(404, "job not found")
    return j


@router.post("/jobs/research-cycle")
def research_cycle(request: Request, body: S.CycleRequest):
    try:
        return {"job_id": svc(request).submit_research_cycle(
            {**body.model_dump(), "trigger": "manual", "symbols": [_sym(s) for s in body.symbols] if body.symbols else None},
            user_id=uid(request))}
    except LimitError as e:
        raise HTTPException(429, str(e))


@router.post("/jobs/{jid}/cancel")
def cancel(request: Request, jid: int):
    if not svc(request).jobs.cancel(jid, user_id=uid(request)):
        raise HTTPException(409, "job is not active")
    return {"cancel_requested": jid}


# ---------------- autonomy (opt-in, per user) ----------------
@router.get("/autonomy")
def autonomy(request: Request):
    return svc(request).scheduler.status(uid(request))


@router.put("/autonomy")
def autonomy_update(request: Request, patch: dict):
    try:
        svc(request).scheduler.update(patch, uid(request))
    except Exception as e:  # pydantic ValidationError or cap violation
        raise HTTPException(422, str(e))
    return svc(request).scheduler.status(uid(request))


@router.post("/autonomy/{action}")
def autonomy_action(request: Request, action: str):
    sv, u = svc(request), uid(request)
    if action == "enable":
        sv.scheduler.update({"enabled": True}, u)
    elif action == "disable":
        sv.scheduler.update({"enabled": False}, u)
    elif action == "pause":
        sv.scheduler.update({"paused": True}, u)
    elif action == "resume":
        sv.scheduler.update({"paused": False}, u)
    elif action == "run-now":
        cfg = sv.scheduler.config(u)
        try:
            jid = sv.submit_research_cycle({"max_hypotheses": cfg.max_hypotheses_per_cycle, "trigger": "run_now"},
                                           user_id=u, trigger="run_now")
        except LimitError as e:
            raise HTTPException(429, str(e))
        return {**sv.scheduler.status(u), "job_id": jid}
    else:
        raise HTTPException(404, "unknown action")
    return sv.scheduler.status(u)


@router.get("/autonomy/history")
def autonomy_history(request: Request, limit: int = Query(30, le=200)):
    rows = svc(request).jobs.list(limit, user_id=uid(request), job_type="research_cycle")
    return [{"job_id": r["id"], "trigger": r["trigger"], "status": r["status"], "created_at": r["created_at"],
             "started_at": r["started_at"], "finished_at": r["finished_at"], "attempts": r["attempts"],
             "error": (r["error"] or "").split("\n")[0][:240] or None,
             "estimate": r["estimate"], "usage": r["usage"],
             "result": _cycle_result(r["result"])} for r in rows]


def _cycle_result(res: dict | None) -> dict | None:
    """Cycles from before methodology v2 reported an 'accepted' count that was later re-evaluated
    (docs/STATISTICS.md). Their outcome counts are withheld rather than shown as survivors."""
    if not res:
        return None
    out = {k: res.get(k) for k in ("cycle_id", "hypotheses", "evaluated", "accepted", "dispositions", "report_id")}
    if "dispositions" not in res:
        out.update(accepted=None, legacy=True)
    return out


@router.get("/reports/away")
def report_away(request: Request, since: str | None = None):
    if since:
        try:
            datetime.fromisoformat(since)
        except ValueError:
            raise HTTPException(422, "since must be an ISO-8601 timestamp")
    return away_report(svc(request).db, uid(request), since)


@router.post("/me/seen")
def me_seen(request: Request):
    return mark_seen(svc(request).db, uid(request))


@router.get("/research/queue")
def research_queue(request: Request):
    return svc(request).db.kv_get(f"research_queue:{uid(request)}", [])


@router.get("/research/reports")
def reports(request: Request, limit: int = Query(20, le=200)):
    sv = svc(request)
    rows = sv.db.query("SELECT id, created_at, cycle_id FROM experiments WHERE kind='research_report' ORDER BY id DESC LIMIT ?", (limit,))
    for r in rows:
        a = sv.db.one("SELECT json FROM experiment_artifacts WHERE experiment_id=? AND name='report'", (r["id"],))
        r["report"] = loads(a["json"]) if a else None
    return rows


# ---------------- paper trading ----------------
@router.get("/paper/account")
def account(request: Request):
    return svc(request).paper.account()


@router.get("/paper/positions")
def positions(request: Request):
    sv = svc(request)
    px = sv.paper.prices()
    out = []
    for p in sv.paper.positions():
        mark = px.get(p["symbol"], p["avg_price"])
        out.append({**p, "mark": mark, "market_value": p["qty"] * mark, "unrealized_pnl": p["qty"] * (mark - p["avg_price"])})
    return out


@router.get("/paper/orders")
def orders(request: Request, limit: int = Query(200, le=2000)):
    return svc(request).db.query("SELECT * FROM orders ORDER BY id DESC LIMIT ?", (limit,))


@router.get("/paper/fills")
def fills(request: Request, limit: int = Query(200, le=2000)):
    return svc(request).db.query("SELECT * FROM fills ORDER BY id DESC LIMIT ?", (limit,))


@router.get("/paper/snapshots")
def snapshots(request: Request, limit: int = Query(2000, le=20000)):
    return svc(request).db.query("SELECT * FROM (SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?) ORDER BY id", (limit,))


@router.post("/paper/orders")
def place(request: Request, body: S.OrderRequest):
    try:
        return svc(request).paper.place_order(_sym(body.symbol), body.side, body.qty, body.type, body.limit_price)
    except PaperError as e:
        raise HTTPException(422, str(e))


@router.delete("/paper/orders/{oid}")
def cancel_order(request: Request, oid: int):
    try:
        return svc(request).paper.cancel_order(oid)
    except PaperError as e:
        raise HTTPException(409, str(e))


@router.post("/paper/control")
def control(request: Request, body: S.ControlRequest):
    sv = svc(request)
    try:
        return sv.paper.reset() if body.action == "reset" else sv.paper.set_state(body.action)
    except PaperError as e:
        raise HTTPException(409, str(e))


@router.post("/paper/tick")
def tick(request: Request):
    return svc(request).paper.tick()


@router.get("/paper/strategies")
def paper_strategies(request: Request):
    return [_sc(r) for r in svc(request).db.query("SELECT * FROM strategy_configs ORDER BY id DESC")]


@router.post("/paper/strategies")
def deploy(request: Request, body: S.DeployRequest):
    sv = svc(request)
    if body.experiment_id:
        e = sv.db.one("SELECT * FROM experiments WHERE id=?", (body.experiment_id,))
        if not e or not e["strategy"]:
            raise HTTPException(404, "experiment not found")
        sym, key, params = e["symbol"], e["strategy"], loads(e["params_json"])
    else:
        if not (body.symbol and body.strategy):
            raise HTTPException(422, "experiment_id or symbol+strategy required")
        sym, key, params = _sym(body.symbol), body.strategy, body.params
    try:
        params = get_strategy(key)(**params).p
    except (KeyError, ValueError) as e:
        raise HTTPException(422, str(e))
    sid = sv.db.insert("strategy_configs", {"created_at": utcnow(), "name": f"{get_strategy(key).name} · {sym}", "strategy": key,
                                            "symbol": sym, "params_json": dumps(params), "status": "deployed",
                                            "allocation": body.allocation, "source_experiment": body.experiment_id,
                                            "notes": "Manually deployed to PAPER portfolio"})
    sv.bus.emit("paper", f"Strategy #{sid} deployed to paper ({key} {sym}, {body.allocation:.0%})", source="api", data={"node": f"strategy:{sid}"})
    return _sc(sv.db.one("SELECT * FROM strategy_configs WHERE id=?", (sid,)))


@router.patch("/paper/strategies/{sid}")
def strategy_status(request: Request, sid: int, body: S.StrategyStatusRequest):
    sv = svc(request)
    if not sv.db.one("SELECT id FROM strategy_configs WHERE id=?", (sid,)):
        raise HTTPException(404, "not found")
    sv.db.execute("UPDATE strategy_configs SET status=?, allocation=COALESCE(?, allocation) WHERE id=?", (body.status, body.allocation, sid))
    sv.bus.emit("paper", f"Strategy #{sid} → {body.status}", source="api", data={"node": f"strategy:{sid}"})
    return _sc(sv.db.one("SELECT * FROM strategy_configs WHERE id=?", (sid,)))


# ---------------- risk ----------------
@router.get("/risk/limits")
def limits(request: Request):
    return {"limits": svc(request).risk.limits().model_dump(),
            "schema": {k: {"description": f.description} for k, f in RiskLimits.model_fields.items()}}


@router.put("/risk/limits")
def update_limits(request: Request, patch: dict):
    try:
        return {"limits": svc(request).risk.update_limits(patch).model_dump()}
    except Exception as e:
        raise HTTPException(422, str(e))


@router.get("/risk/events")
def risk_events(request: Request, limit: int = Query(200, le=2000)):
    return svc(request).risk.events(limit)


@router.get("/risk/status")
def risk_status(request: Request):
    sv = svc(request)
    a = sv.paper.account()
    L = sv.risk.limits()
    px = sv.paper.prices()
    pos = sv.paper.positions()
    eq = a["equity"] or 1
    by_sym: dict[str, float] = {}
    by_strat: dict[str, float] = {}
    for p in pos:
        n = p["qty"] * px.get(p["symbol"], p["avg_price"])
        by_sym[p["symbol"]] = by_sym.get(p["symbol"], 0) + n
        by_strat[p["strategy_id"]] = by_strat.get(p["strategy_id"], 0) + abs(n)
    instruments = []
    for s in INSTRUMENTS:
        vp = sv.risk.vol_percentile(s) if sv.data.load(s).shape[0] > 300 else None
        st = sv.risk.staleness_days(s)
        instruments.append({"symbol": s, "net_exposure_pct": by_sym.get(s, 0) / eq, "vol_percentile": vp, "stale_days": st,
                            "stale": st is None or st > get_instrument(s).max_stale_days + 1})
    corr = sv.risk.correlation_matrix()
    gauges = {
        "drawdown": {"value": a["drawdown"], "limit": -L.max_drawdown_pct},
        "daily_pnl": {"value": a["daily_pnl_pct"], "limit": -L.max_daily_loss_pct},
        "gross_exposure": {"value": a["gross_exposure"] / eq, "limit": L.max_gross_exposure_pct},
        "max_position": {"value": max([abs(v) / eq for v in by_sym.values()], default=0), "limit": L.max_position_exposure_pct},
    }
    return {"account": a, "limits": L.model_dump(), "gauges": gauges, "instruments": instruments,
            "strategy_exposure": {k: v / eq for k, v in by_strat.items()},
            "correlation": {"symbols": list(corr.columns), "matrix": [[_n(v) for v in row] for row in corr.to_numpy()] if not corr.empty else []}}


# ---------------- private beta waitlist ----------------
@router.post("/waitlist")
def waitlist_join(request: Request, body: S.WaitlistRequest):
    """Record beta interest. Idempotent per email; stores only what the visitor submits (no IP, no tracking)."""
    sv = svc(request)
    email = body.email.strip().lower()
    existing = sv.db.one("SELECT id FROM waitlist WHERE email=?", (email,))
    if existing:
        return {"status": "already_registered"}
    sv.db.insert("waitlist", {"created_at": utcnow(), "email": email, "markets_json": dumps(sorted(set(body.markets))),
                              "experience": body.experience, "source": body.source})
    sv.bus.emit("system", "New private-beta sign-up", source="waitlist")
    return {"status": "registered"}


@router.get("/waitlist/count")
def waitlist_count(request: Request):
    return {"count": svc(request).db.one("SELECT COUNT(*) n FROM waitlist")["n"]}


# ---------------- computation graph ----------------
@router.get("/graph")
def graph(request: Request, max_experiments: int = Query(800, le=5000)):
    """Topology of the ACTUAL system: every node/edge is a real entity or dependency in the database."""
    sv = svc(request)
    N, E = [], []
    add = lambda i, label, kind, **meta: N.append({"id": i, "label": label, "kind": kind, **meta})
    link = lambda s, t, kind: E.append({"s": s, "t": t, "kind": kind})
    add("agent:orchestrator", "Orchestrator", "core")
    for a in sv.orchestrator.agents.values():
        add(f"agent:{a.name}", a.title.replace(" Agent", ""), "agent", status=a.status)
        link("agent:orchestrator", f"agent:{a.name}", "control")
    add("risk:gate", "Risk Gate", "risk")
    add("paper:broker", "Paper Broker", "paper")
    add("scheduler", "Scheduler", "core")
    add("forecast", "Forecast Lab", "forecast")
    link("scheduler", "agent:orchestrator", "control")
    link("risk:gate", "paper:broker", "control")
    link("agent:risk_analyst", "risk:gate", "flow")
    status = {d["symbol"]: d for d in sv.data.status()}
    feats = list(FEATURE_DOCS)
    for f in feats:
        add(f"feat:{f}", f, "feature")
    for s in INSTRUMENTS:
        add(f"data:{s}", s, "data", rows=status[s]["rows"], version=status[s]["version"], stale=status[s]["is_stale"])
        link("agent:market", f"data:{s}", "flow")
        link(f"data:{s}", "forecast", "flow")
        link(f"data:{s}", "risk:gate", "flow")
        for f in feats:
            if f == "volume_z_20" and not status[s]["has_volume"]:
                continue
            link(f"data:{s}", f"feat:{f}", "derive")
    for k, cls in REGISTRY.items():
        add(f"stype:{k}", cls.name, "strategy_type", family=cls.family)
        link("agent:discovery", f"stype:{k}", "flow")
    siblings: dict[tuple, list[int]] = {}
    for r in sv.db.query("SELECT id, symbol, strategy, verdict, disposition, metrics_json FROM experiments WHERE kind IN ('hypothesis_test','manual_backtest') AND user_id=? ORDER BY id DESC LIMIT ?", (uid(request), max_experiments)):
        m = loads(r["metrics_json"], {})
        sh = (m.get("test") or {}).get("sharpe")
        add(f"exp:{r['id']}", f"#{r['id']} {r['strategy']} {r['symbol']}", "experiment", verdict=r["disposition"] or ("manual" if not r["verdict"] else r["verdict"]), sharpe=sh,
            trades=(m.get("test") or {}).get("num_trades") or 0)
        link(f"stype:{r['strategy']}", f"exp:{r['id']}", "derive")
        link(f"data:{r['symbol']}", f"exp:{r['id']}", "derive")
        link("agent:backtester", f"exp:{r['id']}", "eval")
        if r["verdict"]:
            link("agent:critic", f"exp:{r['id']}", "judge")
            link("agent:risk_analyst", f"exp:{r['id']}", "eval")
        siblings.setdefault((r["symbol"], r["strategy"]), []).append(r["id"])
    # experiments testing the same strategy family on the same market are siblings (same multiple-testing family)
    for ids in siblings.values():
        for a, b in zip(ids, ids[1:]):
            link(f"exp:{a}", f"exp:{b}", "sibling")
    by_symbol: dict[str, list[int]] = {}
    for (sym, _), ids in siblings.items():
        by_symbol.setdefault(sym, []).extend(ids)
    for ids in by_symbol.values():  # ring through all experiments sharing a dataset
        ids = sorted(ids)
        for a, b in zip(ids, ids[2:]):
            link(f"exp:{a}", f"exp:{b}", "sibling")
    for r in sv.db.query("SELECT id, agent, job_id, status, duration_ms FROM agent_runs ORDER BY id DESC LIMIT 400"):
        add(f"run:{r['id']}", f"run #{r['id']} {r['agent']}", "run", status=r["status"], ms=r["duration_ms"])
        link(f"agent:{r['agent']}", f"run:{r['id']}", "exec")
        if r["job_id"]:
            link(f"job:{r['job_id']}", f"run:{r['id']}", "exec")
    for sc in sv.db.query("SELECT * FROM strategy_configs WHERE status='deployed'"):
        add(f"strategy:{sc['id']}", sc["name"], "deployed", allocation=sc["allocation"])
        if sc["source_experiment"]:
            link(f"exp:{sc['source_experiment']}", f"strategy:{sc['id']}", "promote")
        link(f"strategy:{sc['id']}", "risk:gate", "flow")
        link(f"data:{sc['symbol']}", f"strategy:{sc['id']}", "flow")
    for j in sv.db.query("SELECT id, type, status FROM jobs ORDER BY id DESC LIMIT 60"):
        add(f"job:{j['id']}", f"job #{j['id']} {j['type']}", "job", status=j["status"])
        link("scheduler" if j["type"] == "data_refresh" else "agent:orchestrator", f"job:{j['id']}", "control")
    ids = {n["id"] for n in N}
    E = [e for e in E if e["s"] in ids and e["t"] in ids]
    return {"nodes": N, "edges": E, "generated_at": utcnow(),
            "provenance": "Every node and edge is derived from database entities (datasets, features, strategies, experiments, jobs, agents)."}


def _exp(r: dict) -> dict:
    r = dict(r)
    for k in ("params_json", "config_json", "metrics_json", "reasons_json", "hypothesis_json", "evidence_json"):
        if k in r:
            r[k.replace("_json", "")] = loads(r.pop(k), None)
    r["disposition_label"] = DISPOSITION_LABEL.get(r.get("disposition") or "", None)
    return r


def _sc(r: dict) -> dict:
    r = dict(r)
    r["params"] = loads(r.pop("params_json"), {})
    return r


def _n(x):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else float(x)
