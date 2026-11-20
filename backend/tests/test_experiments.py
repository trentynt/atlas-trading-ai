"""No-code experiment builder: exact block behaviour, pre-registration locks, trials, holdout isolation."""
from __future__ import annotations

import pathlib
import sqlite3

import numpy as np
import pandas as pd
import pytest

from atlas.db import Database
from atlas.futures import holdout as H
from atlas.futures.experiments import ORB1, Experiments, LockedError, Spec, ensure_seed, simulate
from atlas.futures.minute_data import NY, MinuteStore
from atlas.futures.proxy import to_index_points

from .test_minute_data import session_minutes


def day(date, rows):
    idx = pd.date_range(pd.Timestamp(f"{date} 09:30", tz=NY), periods=len(rows), freq="min").tz_convert("UTC")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx).assign(volume=1.0)


def flat_bar(p):
    return (p, p + 0.5, p - 0.5, p)


ZERO = {"commission_per_side": 0, "slippage_ticks": 0}


def orb1(**kw):
    return Spec(**{**ORB1["spec"], **kw})


def test_orb1_long_to_session_close_exact():
    # bar0 up (100→101); OR(5) low 99.5; enters 09:35 open 102; session closes at 110
    rows = [(100, 101.5, 99.5, 101)] + [flat_bar(101.5)] * 4 + [flat_bar(102)] * 10 + [flat_bar(110)]
    trades, daily = simulate(day("2025-03-04", rows), orb1(**ZERO))
    t = trades[0]
    assert t["side"] == "long" and t["entry_ts"][11:16] == "09:35" and t["entry"] == 102 and t["stop"] == 99.5
    assert t["exit_reason"] == "session_close" and t["points"] == 8 and t["net"] == 16.0 and t["r"] == pytest.approx(8 / 2.5, abs=1e-3)
    # with costs: 1 tick each side + $0.62/side → fills 102.25 / 109.75 = 7.5 pts = $15.00 − $1.24
    t2 = simulate(day("2025-03-04", rows), orb1())[0][0]
    assert t2["net"] == 13.76


def test_flat_first_bar_means_no_trade_and_short_side():
    flat = [flat_bar(100)] * 20
    assert simulate(day("2025-03-04", flat), orb1(**ZERO))[0] == []
    down = [(100, 100.5, 98.5, 99)] + [flat_bar(99)] * 19
    t = simulate(day("2025-03-04", down), orb1(**ZERO))[0][0]
    assert t["side"] == "short" and t["stop"] == 100.5
    assert simulate(day("2025-03-04", down), orb1(direction="long", **ZERO))[0] == []


def test_stop_first_and_gap_through_stop():
    both = [(100, 101, 99.5, 101)] + [flat_bar(101)] * 5 + [(101, 120, 90, 101)] + [flat_bar(101)] * 5
    t = simulate(day("2025-03-04", both), orb1(exit={"kind": "target_r", "value": 1}, **ZERO))[0][0]
    assert t["exit_reason"] == "stop" and t["exit"] == 99.5
    gap = [(100, 101, 99.5, 101)] + [flat_bar(101)] * 5 + [(95, 96, 94, 95)] + [flat_bar(95)] * 5
    t = simulate(day("2025-03-04", gap), orb1(**ZERO))[0][0]
    assert t["exit_reason"] == "stop_gap" and t["exit"] == 95


def test_breakout_entry_uses_close_then_next_open_and_target_r():
    rows = [flat_bar(100)] * 5 + [(100, 100.75, 100, 100.75), (101, 101.25, 100.75, 101)] + [(101, 103.5, 101, 103.25)] + [flat_bar(103.5)] * 5
    s = Spec(or_minutes=5, entry="or_breakout", stop={"kind": "ticks", "value": 4}, exit={"kind": "target_r", "value": 2}, **ZERO)
    t = simulate(day("2025-03-04", rows), s)[0][0]
    # OR high 100.5; 09:35 closes 100.75 > 100.5 → fill 09:36 open 101; risk 1 pt (4 ticks); target 2R = 103
    assert t["entry_ts"][11:16] == "09:36" and t["entry"] == 101 and t["target"] == 103 and t["exit_reason"] == "target"


def test_clock_exit_and_atr_needs_history():
    rows = [(100, 101, 99.5, 101)] + [flat_bar(101)] * 20 + [flat_bar(105)] * 5
    t = simulate(day("2025-03-04", rows), orb1(exit={"kind": "clock", "value": "09:50"}, **ZERO))[0][0]
    assert t["exit_reason"] == "clock" and t["exit_ts"][11:16] == "09:50"
    assert simulate(day("2025-03-04", rows), orb1(stop={"kind": "atr", "value": 1}, **ZERO))[0] == []  # no prior sessions → no ATR → no trade


def test_filters_weekday_and_unknown_gap_means_no_trade():
    up = [(100, 101, 99.5, 101)] + [flat_bar(101)] * 10
    two = pd.concat([day("2025-03-03", up), day("2025-03-04", up)])  # Mon, Tue
    assert [t["session"] for t in simulate(two, orb1(filters={"weekdays": [1]}, **ZERO))[0]] == ["2025-03-04"]
    sessions = [t["session"] for t in simulate(two, orb1(filters={"gap_max_bps": 10_000}, **ZERO))[0]]
    assert sessions == ["2025-03-04"]  # Monday has no prior session → gap unknown → no trade


def test_daily_series_includes_no_trade_days():
    two = pd.concat([day("2025-03-03", [flat_bar(100)] * 10), day("2025-03-04", [(100, 101, 99.5, 101)] + [flat_bar(101)] * 9)])
    _, daily = simulate(two, orb1(**ZERO))
    assert list(daily.index) == ["2025-03-03", "2025-03-04"] and daily["2025-03-03"] == 0


# ---------------- registration, locks, trials, holdout ----------------
@pytest.fixture
def ex(tmp_path):
    db = Database(tmp_path / "x.db")
    m, _ = session_minutes(pd.bdate_range("2025-01-02", "2026-04-30"), price0=500, seed=11)
    MinuteStore(db).save("QQQ", m, "test")
    return Experiments(db), db


def test_registered_experiment_cannot_be_edited_or_deleted(ex):
    e, db = ex
    d = e.create("T-1", "Testing the lock: a reason of at least ten characters.", ORB1["spec"])
    e.update(d["id"], spec={**ORB1["spec"], "or_minutes": 10})
    r = e.register(d["id"])
    assert r["status"] == "registered" and r["spec"]["or_minutes"] == 10 and r["spec_hash"]
    with pytest.raises(LockedError):
        e.update(d["id"], spec={**ORB1["spec"], "or_minutes": 15})
    with pytest.raises(LockedError):
        e.delete_draft(d["id"])
    with pytest.raises(sqlite3.IntegrityError, match="locked"):  # even a direct SQL edit is refused
        db.execute("UPDATE intraday_experiments SET spec_json='{}' WHERE id=?", (d["id"],))
    with pytest.raises(ValueError, match="already exists"):
        e.create("T-1", "Same name again should be refused.", ORB1["spec"])


def test_draft_cannot_run_and_registration_needs_a_reason(ex):
    e, _ = ex
    with pytest.raises(ValueError):
        e.create("T-2", "short", ORB1["spec"])
    d = e.create("T-2", "A real one-sentence reason why it might work.", ORB1["spec"])
    with pytest.raises(LockedError, match="Register"):
        e.run(d["id"])


def test_run_records_trial_and_never_reads_holdout(ex):
    e, db = ex
    d = e.register(e.create("T-3", "A real one-sentence reason why it might work.", ORB1["spec"])["id"])
    before = e.trial_counts()
    res = e.run(d["id"])
    after = e.trial_counts()
    assert after["global"] == before["global"] + 1 and after["mnq"] == before["mnq"] + 1
    assert res["data"]["to"] < H.HOLDOUT_START  # fixture runs to 2026-04-30; sealed part is invisible
    assert not any(H.in_holdout(t["session"]) for t in res["trades"])
    assert H.unlocks(db) == []
    names = [c["gate"] for c in res["checks"]]
    assert len(names) == 4 and res["deflated_sharpe"]["trials_market"] == after["mnq"]
    f = e.reg.family_stats(1, "MNQ")
    assert f["n_manual"] == 1 and f["n_eff"] >= 1  # counted in the effective-trials estimate
    assert e.get_run(res["run_id"])["summary"] == res["summary"]
    assert len(res["equity_without_best_days"]) == len(res["equity"]) - 5


def test_builder_has_no_holdout_unlock_path():
    src = (pathlib.Path(__file__).resolve().parents[1] / "atlas" / "futures" / "experiments.py").read_text()
    assert "unlock_reason" not in src


def test_orb1_seeded_registered_and_not_run(ex):
    e, db = ex
    ensure_seed(db)
    ensure_seed(db)  # idempotent
    orb = [x for x in e.list() if x["name"] == "ORB-1"]
    assert len(orb) == 1 and orb[0]["status"] == "registered" and orb[0]["runs"] == []
    s = orb[0]["spec"]
    assert (s["or_minutes"], s["entry"], s["stop"]["kind"], s["exit"]["kind"], s["contracts"], s["commission_per_side"], s["slippage_ticks"]) == \
        (5, "first_bar_direction", "or_opposite", "session_close", 1, 0.62, 1.0)
    assert orb[0]["gates"] == {"min_net_expectancy": 0.0, "max_bootstrap_p": 0.05, "drop_best_days": 5, "slippage_multiple": 2.0}
