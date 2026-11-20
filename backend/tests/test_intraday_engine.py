"""Phase 3: intraday engine — sessions, costs, stops, loss limit, annualisation, no look-ahead."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from atlas.futures import apex
from atlas.futures.contracts import MNQ, FuturesCosts, round_turn
from atlas.futures.engine import IntradayConfig, assert_causal, run_intraday
from atlas.futures.minute_data import NY

from .test_minute_data import session_minutes

ZERO = FuturesCosts(0, 0)


def bars(prices, day="2025-03-04", start="09:30"):
    """One session of hand-written bars: each item is (open, high, low, close)."""
    idx = pd.date_range(pd.Timestamp(f"{day} {start}", tz=NY), periods=len(prices), freq="min").tz_convert("UTC")
    return pd.DataFrame(prices, columns=["open", "high", "low", "close"], index=idx).assign(volume=1.0)


def flat(n, px=18000.0, day="2025-03-04"):
    return bars([(px, px + 1, px - 1, px)] * n, day)


def sig_at(df, pairs):
    s = pd.Series(0.0, index=df.index)
    for i, v in pairs:
        s.iloc[i:] = v
    return s


def momentum(df):
    """TEST-ONLY causal signal (not a strategy): sign of the last 5-minute change, reset each session."""
    d = df.index.tz_convert(NY).date
    ch = df["close"].groupby(d).diff(5)
    return np.sign(ch).fillna(0.0)


def test_next_bar_fill_and_exact_dollars_match_round_turn():
    df = bars([(18000, 18001, 17999, 18000), (18000, 18002, 17999, 18001), (18005, 18011, 18004, 18010),
               (18010, 18012, 18009, 18011), (18010, 18012, 18009, 18011)])
    s = sig_at(df, [(0, 1), (2, 0)])  # long decided at bar 0 → fills at bar 1 open; exit decided at bar 2 → bar 3 open
    costs = FuturesCosts(0.62, 1)
    r = run_intraday(df, s, IntradayConfig(contracts=2, costs=costs))
    t = r.trades[0]
    assert t["entry_ts"].endswith("09:31:00-05:00") and t["exit_ts"].endswith("09:33:00-05:00")  # timestamps, not dates
    expect = round_turn(MNQ, +1, 2, 18000, 18010, costs)
    assert t["net"] == expect.net and r.metrics["net_pnl"] == expect.net


def test_stop_assumed_first_when_bar_touches_stop_and_target():
    df = bars([(18000, 18000, 18000, 18000), (18000, 18001, 17999, 18000), (18000, 18020, 17980, 18000), (18000, 18001, 17999, 18000)])
    r = run_intraday(df, sig_at(df, [(0, 1)]), IntradayConfig(costs=ZERO, stop_ticks=20, target_ticks=20))
    assert r.trades[0]["exit_reason"] == "stop" and r.trades[0]["exit_price"] == 17995.0


def test_gap_through_stop_fills_at_open_not_stop():
    df = bars([(18000, 18000, 18000, 18000), (18000, 18001, 17999, 18000), (17950, 17955, 17940, 17950), (17950, 17951, 17949, 17950)])
    r = run_intraday(df, sig_at(df, [(0, 1)]), IntradayConfig(costs=FuturesCosts(0, 1), stop_ticks=20))
    t = r.trades[0]
    assert t["exit_reason"] == "stop_gap" and t["exit_price"] == 17949.75  # open 17950 minus 1 tick slippage


def test_no_reentry_same_direction_after_stop_until_signal_resets():
    df = bars([(18000, 18000, 18000, 18000), (18000, 18001, 17999, 18000), (18000, 18000, 17990, 17995)] + [(17995, 17996, 17994, 17995)] * 5)
    r = run_intraday(df, sig_at(df, [(0, 1)]), IntradayConfig(costs=ZERO, stop_ticks=8))
    assert len(r.trades) == 1


def test_always_flat_overnight_and_session_close_exit():
    m, _ = session_minutes(pd.bdate_range("2025-03-03", periods=5), price0=18000)
    r = run_intraday(m, pd.Series(1.0, index=m.index), IntradayConfig(costs=ZERO))
    last = r.position.groupby(r.position.index.tz_convert(NY).date).last()
    assert (last == 0).all()
    assert all(t["exit_reason"] == "session_close" for t in r.trades) and len(r.trades) == 5
    assert all(t["exit_ts"][11:16] == "15:59" for t in r.trades)


def test_signal_on_last_bar_does_not_carry_overnight():
    d1 = flat(3, day="2025-03-04")
    d2 = flat(3, day="2025-03-05")
    df = pd.concat([d1, d2])
    r = run_intraday(df, sig_at(df, [(2, 1), (3, 0)]), IntradayConfig(costs=ZERO))
    assert r.trades == []


def test_daily_loss_limit_flattens_and_blocks_rest_of_day():
    falling = [(18000 - k, 18001 - k, 17999 - 2 * k, 18000 - 2 * k) for k in range(40)]
    df = pd.concat([bars(falling), flat(20, day="2025-03-05")])
    r = run_intraday(df, pd.Series(1.0, index=df.index), IntradayConfig(costs=ZERO, daily_loss_limit=100))
    day1 = [t for t in r.trades if t["session"] == "2025-03-04"]
    assert len(day1) == 1 and day1[0]["exit_reason"] == "daily_loss_limit"
    assert r.daily.loc["2025-03-04", "stopped_by_loss_limit"] is not None
    assert any(t["session"] == "2025-03-05" for t in r.trades)  # next session trades again


def test_no_new_entries_after_last_entry_time():
    df = bars([(18000, 18001, 17999, 18000)] * 12, start="15:48")
    r = run_intraday(df, sig_at(df, [(3, 1)]), IntradayConfig(costs=ZERO))  # decided at 15:51
    assert r.trades == []


def test_whole_contracts_enforced():
    with pytest.raises(ValueError):
        IntradayConfig(contracts=1.5)


def test_annualisation_uses_daily_returns():
    m, _ = session_minutes(pd.bdate_range("2025-01-02", periods=60), price0=18000, seed=3)
    r = run_intraday(m, momentum(m), IntradayConfig(costs=ZERO))
    d = r.daily["return"]
    assert r.metrics["sharpe_daily_annualised"] == pytest.approx(d.mean() / d.std(ddof=1) * np.sqrt(252), abs=1e-3)
    assert len(r.daily) == 60


# ---------------- no look-ahead ----------------
def test_signal_function_is_causal():
    m, _ = session_minutes(pd.bdate_range("2025-01-02", periods=5), price0=18000, seed=4)
    for cut in (100, 777, 1500):
        assert_causal(momentum, m, cut)


def test_deleting_future_bars_does_not_change_the_past():
    m, _ = session_minutes(pd.bdate_range("2025-01-02", periods=8), price0=18000, seed=5)
    cfg = IntradayConfig(costs=FuturesCosts(0.62, 1), stop_ticks=40, target_ticks=60, daily_loss_limit=300)
    full = run_intraday(m, momentum(m), cfg)
    cut_day = sorted(set(m.index.tz_convert(NY).date.astype(str)))[5]
    part_df = m[m.index.tz_convert(NY).date.astype(str) < cut_day]
    part = run_intraday(part_df, momentum(part_df), cfg)
    before = [t for t in full.trades if t["session"] < cut_day]
    assert before == part.trades
    pd.testing.assert_series_equal(full.equity[part.equity.index], part.equity)


def test_changing_future_bars_does_not_change_past_trades():
    m, _ = session_minutes(pd.bdate_range("2025-01-02", periods=6), price0=18000, seed=6)
    cfg = IntradayConfig(costs=FuturesCosts(0.62, 1), stop_ticks=40)
    base = run_intraday(m, momentum(m), cfg)
    k = 900  # mid-session bar index
    m2 = m.copy()
    m2.iloc[k:, :4] = m2.iloc[k:, :4].to_numpy() * 1.03  # scramble everything after bar k
    alt = run_intraday(m2, momentum(m2), cfg)
    t_k = m.index[k].tz_convert(NY).isoformat()
    done_before = [t for t in base.trades if t["exit_ts"] < t_k]
    assert done_before == [t for t in alt.trades if t["exit_ts"] < t_k]
    pd.testing.assert_series_equal(base.equity.iloc[:k], alt.equity.iloc[:k])


def test_apex_rules_refuse_until_verified():
    r = apex.load(require_verified=False)
    assert r["verified"] is False and "daily_loss_limit" not in r  # nothing guessed
    with pytest.raises(apex.UnverifiedRules):
        apex.load()
