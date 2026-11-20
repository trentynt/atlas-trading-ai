"""Data-quality gate for the intraday track. THRESHOLDS ARE FIXED HERE, BEFORE ANY DATA IS SEEN.
Do not change them after looking at results (docs/LEARN.md explains why).

G1  history          >= 3 years between the first and last session with minute data
G2  completeness     median RTH session has >= 380 of 390 one-minute bars
G3  correctness      daily close rebuilt from minute bars (close of the session's last bar: 15:59, or 12:59 on
                     early-close days) is within 10 bps of an
                     independent daily close on >= 95% of days
G4  session edges    the 09:30 bar and the session's last bar are both present on >= 95% of days

Session days come from the INDEPENDENT daily source, so a day with no minute data at all counts as a
failure instead of being silently skipped. Early-close days (13:00) use 12:59 as the last bar (calendar.py)
and are left out of G2's median, which measures full 390-minute sessions. Thresholds are unchanged.

Run:  python -m atlas.futures.gate            (uses stored data)
      python -m atlas.futures.gate --download (fetch/update first; needs API keys)
"""
from __future__ import annotations

import argparse
import json
import sys
from types import MappingProxyType

import numpy as np
import pandas as pd

from ..db import utcnow
from .calendar import EARLY_CLOSES, last_bar
from .minute_data import NY, PROXY_SYMBOL, MinuteStore

THRESHOLDS = MappingProxyType({
    "G1_min_years": 3.0,
    "G2_min_median_bars": 380,
    "G2_session_bars": 390,
    "G3_max_bps": 10.0,
    "G3_min_share": 0.95,
    "G4_min_share": 0.95,
})
WRITTEN = "2026-11-20"  # thresholds written before the first run; never edited after seeing data


def evaluate(minutes: pd.DataFrame, daily: pd.Series) -> dict:
    T = THRESHOLDS
    if minutes.empty or daily.empty:
        return {"passed": False, "reason": "no data", "checks": {}, "thresholds": dict(T)}
    local = minutes.index.tz_convert(NY)
    day = pd.Index(local.date.astype(str))
    hm = local.strftime("%H:%M")
    first_m, last_m = day.min(), day.max()
    sessions = [d for d in daily.index if first_m <= d <= last_m]  # independent calendar within the minute span
    counts = pd.Series(1, index=day).groupby(level=0).sum().reindex(sessions, fill_value=0)
    full_days = [d for d in sessions if d not in EARLY_CLOSES]  # G2 measures full-length sessions
    has_open = pd.Series(hm == "09:30", index=day).groupby(level=0).any().reindex(sessions, fill_value=False)
    expected_last = np.array([last_bar(d) for d in day])  # 15:59, or 12:59 on early-close days
    is_last = hm == expected_last
    has_last = pd.Series(is_last, index=day).groupby(level=0).any().reindex(sessions, fill_value=False)
    last_close = pd.Series(minutes["close"].to_numpy(), index=day)[is_last].groupby(level=0).last()
    ref = daily.reindex(sessions)
    both = last_close.index.intersection(ref.dropna().index)
    diff_bps = ((last_close[both] / ref[both]) - 1).abs() * 1e4

    years = (pd.Timestamp(last_m) - pd.Timestamp(first_m)).days / 365.25
    med = float(counts[full_days].median()) if full_days else 0.0
    g3_share = float((diff_bps <= T["G3_max_bps"]).sum() / len(sessions)) if sessions else 0.0  # missing days count as misses
    edges = has_open & has_last
    g4_share = float(edges.mean()) if len(edges) else 0.0
    checks = {
        "G1": {"value": round(years, 2), "threshold": f">= {T['G1_min_years']} years", "passed": years >= T["G1_min_years"],
               "detail": f"{first_m} to {last_m}"},
        "G2": {"value": med, "threshold": f"median >= {T['G2_min_median_bars']} of {T['G2_session_bars']}",
               "passed": med >= T["G2_min_median_bars"],
               "detail": f"{int((counts == 0).sum())} session(s) with no minute data; {int((counts < 380).sum())} below 380"},
        "G3": {"value": round(g3_share, 4), "threshold": f">= {T['G3_min_share']:.0%} of days within {T['G3_max_bps']} bps",
               "passed": g3_share >= T["G3_min_share"],
               "detail": f"median gap {float(diff_bps.median()) if len(diff_bps) else float('nan'):.2f} bps; "
                         f"p95 {float(diff_bps.quantile(0.95)) if len(diff_bps) else float('nan'):.2f} bps; "
                         f"{len(sessions) - len(both)} day(s) without a last bar or reference close",
               "worst_days": [{"date": d, "bps": round(float(v), 1)} for d, v in diff_bps.sort_values().tail(10).items()]},
        "G4": {"value": round(g4_share, 4), "threshold": f">= {T['G4_min_share']:.0%} of days with 09:30 and 15:59 bars",
               "passed": g4_share >= T["G4_min_share"],
               "detail": f"missing 09:30 on {int((~has_open).sum())} day(s), last bar on {int((~has_last).sum())}; {sum(d in EARLY_CLOSES for d in sessions)} early-close day(s) end at 12:59"},
    }
    return {"passed": all(c["passed"] for c in checks.values()), "sessions": len(sessions),
            "checks": checks, "thresholds": dict(T), "thresholds_written": WRITTEN}


def run(db, symbol: str = PROXY_SYMBOL) -> dict:
    store = MinuteStore(db)
    res = evaluate(store.load(symbol), store.load_daily(symbol))
    res.update(symbol=symbol, proxy_for="MNQ", ran_at=utcnow())
    if res.get("checks"):  # an empty store is "not run", never recorded as a failure
        db.kv_set(f"data_gate:{symbol}", res)
    return res


def main(argv=None) -> int:
    from ..config import get_settings
    from ..db import Database
    ap = argparse.ArgumentParser(description="Intraday data-quality gate (thresholds fixed in code).")
    ap.add_argument("--download", action="store_true", help="fetch/update minute bars and daily closes first")
    ap.add_argument("--years", type=float, default=3.5)
    a = ap.parse_args(argv)
    db = Database(get_settings().db_path)
    if a.download:
        from .minute_data import MissingKey, download
        try:
            download(db, a.years)
        except MissingKey as e:
            print(f"Cannot download: {e}")
            return 2
    res = run(db)
    for k, c in res.get("checks", {}).items():
        print(f"{k} {'PASS' if c['passed'] else 'FAIL'}  {c['value']}  ({c['threshold']})  {c['detail']}")
    if not res.get("checks"):
        print("\nDATA GATE: NOT RUN — no minute data stored yet. Run with --download after adding the API keys.")
        return 2
    print(f"\nDATA GATE: {'PASSED' if res['passed'] else 'FAILED'}")
    return 0 if res["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
