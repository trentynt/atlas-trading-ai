"""Phases 4–5: bar-by-bar practice (PAPER ONLY) uses the backtester's exact rules; journal maths; no broker path."""
from __future__ import annotations

import pathlib
import re

import pandas as pd
import pytest

from atlas.db import Database
from atlas.futures.contracts import FuturesCosts
from atlas.futures.engine import IntradayConfig, run_intraday
from atlas.futures.practice import Journal, Practice, PracticeError

from .test_minute_data import session_minutes


@pytest.fixture
def setup(tmp_path):
    m, _ = session_minutes(pd.bdate_range("2025-03-04", periods=1), price0=18000, seed=9)
    db = Database(tmp_path / "p.db")
    return Practice(db, loader=lambda d: m), m, db


def test_view_never_shows_future_bars(setup):
    p, m, _ = setup
    v = p.start("2025-03-04")
    assert len(v["bars"]) == 1 and v["total_bars"] == 390
    v = p.step(v["id"], 10)
    assert len(v["bars"]) == 11 and v["bars"][-1]["t"] == m.index[10].isoformat()


def test_practice_matches_backtester_exactly(setup):
    p, m, _ = setup
    v = p.start("2025-03-04", contracts=2, stop_ticks=30, commission_per_side=0.62, slippage_ticks=1)
    pid = v["id"]
    plan = {5: 1, 40: 0, 60: -1, 120: 1, 200: 0}
    for i in range(0, 260):
        if i in plan:
            p.decide(pid, plan[i])
        p.step(pid, 1)
    done = p.finish(pid)
    assert done["status"] == "finished"
    # Same decisions through the backtester on the same bars
    k = 260
    sig = pd.Series(0.0, index=m.index)
    for i, d in sorted({**plan, k: 0}.items()):
        sig.iloc[i:] = d
    ref = run_intraday(m.iloc[: k + 2], sig.iloc[: k + 2], IntradayConfig(contracts=2, stop_ticks=30, costs=FuturesCosts(0.62, 1)))
    assert done["trades"] == ref.trades and len(ref.trades) >= 3
    saved = p.paper_trades()
    assert len(saved) == len(ref.trades) and all("Paper only" in t["data_note"] for t in saved)


def test_decision_fills_next_bar_open_with_state(setup):
    p, m, _ = setup
    v = p.start("2025-03-04", slippage_ticks=0, commission_per_side=0)
    v = p.decide(v["id"], 1)
    assert v["state"]["pending"] == {"position": 1, "reason": "signal"} and v["state"]["position"] == 0
    v = p.step(v["id"])
    assert v["state"]["position"] == 1 and v["state"]["entry_price"] == pytest.approx(round(m["open"].iloc[1] * 4) / 4)


def test_finished_session_rejects_changes(setup):
    p, _, _ = setup
    v = p.finish(p.start("2025-03-04")["id"])
    with pytest.raises(PracticeError):
        p.decide(v["id"], 1)
    with pytest.raises(PracticeError):
        p.step(v["id"])


def test_journal_computes_dollars_with_cost_model(tmp_path):
    j = Journal(Database(tmp_path / "j.db"), FuturesCosts(0.62, 1))
    e = j.add({"trade_date": "2025-03-04", "side": "long", "contracts": 2, "entry_price": 18000, "exit_price": 18010,
               "setup": "opening range", "notes": "waited for the retest", "rating": 4})
    assert e["net"] == 35.52  # same worked example as Phase 1
    e = j.update(e["id"], {"exit_price": 17990})
    assert e["net"] < 0 and e["notes"] == "waited for the retest"
    assert j.add({"trade_date": "2025-03-05", "notes": "no trade: choppy open"})["net"] is None
    for bad in ({"trade_date": "2025-03-04", "contracts": 1.5}, {"trade_date": "2025-03-04", "side": "up"},
                {"trade_date": "2025-03-04", "rating": 9}, {"notes": "missing date"}):
        with pytest.raises(PracticeError):
            j.add(bad)
    j.delete(e["id"])
    assert len(j.list()) == 1


def test_no_path_to_a_real_broker():
    """PAPER ONLY: the codebase may contact market-DATA hosts, never a trading/order endpoint."""
    root = pathlib.Path(__file__).resolve().parents[1] / "atlas"
    src = "\n".join(p.read_text() for p in root.rglob("*.py"))
    assert not re.search(r"api\.alpaca\.markets|paper-api\.alpaca|/v2/orders|tradovate|rithmic|ib_insync|ibapi", src, re.I)
    assert "data.alpaca.markets" in src  # the only Alpaca host used is market data
