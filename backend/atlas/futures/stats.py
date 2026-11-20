"""Descriptive statistics of the regular-hours session. DESCRIPTIONS, NOT STRATEGIES: they say what
happened on past days, with no claim that trading on them makes money.

All sizes are in basis points (1 bp = 0.01%) of price, so they transfer from the QQQ proxy to NQ/MNQ.
To get rough MNQ points: bps / 10,000 × the Nasdaq-100 level (e.g. 20 bps × 20,000 = 40 points = $80 per MNQ).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .minute_data import NY


def _sessions(df: pd.DataFrame):
    local = df.index.tz_convert(NY)
    return df.assign(_day=local.date.astype(str), _hm=local.strftime("%H:%M")).groupby("_day", sort=True)


def _q(s: pd.Series) -> dict:
    s = s.dropna()
    if s.empty:
        return {"n": 0}
    return {"n": int(len(s)), "mean": round(float(s.mean()), 2), "p25": round(float(s.quantile(0.25)), 2),
            "median": round(float(s.median()), 2), "p75": round(float(s.quantile(0.75)), 2),
            "p90": round(float(s.quantile(0.9)), 2)}


def opening_range(df: pd.DataFrame, minutes: int = 15) -> dict:
    """Opening range = high and low of the first `minutes` minutes (09:30 up to 09:30+minutes).
    A 'break' is a later bar trading above the range high (up) or below the range low (down)."""
    rows = []
    for day, g in _sessions(df):
        first = g.iloc[:minutes]
        rest = g.iloc[minutes:]
        if len(first) < minutes or g["_hm"].iloc[0] != "09:30" or rest.empty:
            continue
        hi, lo, ref = first["high"].max(), first["low"].min(), first["open"].iloc[0]
        up = rest.index[rest["high"] > hi]
        dn = rest.index[rest["low"] < lo]
        t_up = up[0] if len(up) else None
        t_dn = dn[0] if len(dn) else None
        first_break = None if t_up is None and t_dn is None else ("up" if t_dn is None or (t_up is not None and t_up < t_dn) else "down")
        t_first = min([t for t in (t_up, t_dn) if t is not None], default=None)
        rows.append({"day": day, "size_bps": (hi - lo) / ref * 1e4, "up": t_up is not None, "down": t_dn is not None,
                     "first": first_break,
                     "minutes_to_first_break": (t_first - first.index[-1]).total_seconds() / 60 if t_first is not None else None,
                     "close_vs_range": "above" if g["close"].iloc[-1] > hi else "below" if g["close"].iloc[-1] < lo else "inside"})
    r = pd.DataFrame(rows)
    if r.empty:
        return {"minutes": minutes, "days": 0}
    n = len(r)
    return {
        "minutes": minutes, "days": n,
        "size_bps": _q(r["size_bps"]),
        "broke_up_pct": round(r["up"].mean() * 100, 1), "broke_down_pct": round(r["down"].mean() * 100, 1),
        "broke_both_pct": round((r["up"] & r["down"]).mean() * 100, 1),
        "never_broke_pct": round((~r["up"] & ~r["down"]).mean() * 100, 1),
        "first_break_up_pct": round((r["first"] == "up").mean() * 100, 1),
        "first_break_down_pct": round((r["first"] == "down").mean() * 100, 1),
        "minutes_to_first_break": _q(r["minutes_to_first_break"].astype(float)),
        "close_vs_range_pct": {k: round(v * 100, 1) for k, v in r["close_vs_range"].value_counts(normalize=True).items()},
    }


def gaps(df: pd.DataFrame, buckets=(0, 10, 25, 50, 100, np.inf)) -> dict:
    """Gap = today's 09:30 open vs the previous session's last regular-hours close. A gap 'fills' if the
    price trades back to that previous close at any time during the session."""
    rows = []
    prev_close = None
    for day, g in _sessions(df):
        if prev_close is not None and g["_hm"].iloc[0] == "09:30":
            o = g["open"].iloc[0]
            gap = (o - prev_close) / prev_close * 1e4
            if gap > 0:
                hit = g.index[g["low"] <= prev_close]
            elif gap < 0:
                hit = g.index[g["high"] >= prev_close]
            else:
                hit = g.index[:1]
            rows.append({"day": day, "gap_bps": gap, "filled": len(hit) > 0,
                         "minutes_to_fill": (hit[0] - g.index[0]).total_seconds() / 60 if len(hit) else None})
        prev_close = g["close"].iloc[-1]
    r = pd.DataFrame(rows)
    if r.empty:
        return {"days": 0}
    r["abs"] = r["gap_bps"].abs()
    labels = [f"{a:g}–{b:g} bps" if np.isfinite(b) else f"≥ {a:g} bps" for a, b in zip(buckets[:-1], buckets[1:])]
    r["bucket"] = pd.cut(r["abs"], list(buckets), labels=labels, right=False)
    by = []
    for lab, g in r.groupby("bucket", observed=False):
        if len(g):
            by.append({"bucket": str(lab), "days": int(len(g)), "fill_pct": round(g["filled"].mean() * 100, 1),
                       "median_minutes_to_fill": None if not g["filled"].any() else round(float(g["minutes_to_fill"].median()), 1)})
    return {"days": int(len(r)), "gap_bps": _q(r["gap_bps"]), "abs_gap_bps": _q(r["abs"]),
            "fill_pct": round(r["filled"].mean() * 100, 1), "up_gaps": int((r["gap_bps"] > 0).sum()),
            "down_gaps": int((r["gap_bps"] < 0).sum()), "by_size": by}


def volatility_by_time(df: pd.DataFrame, bucket_minutes: int = 15) -> list[dict]:
    """Typical size of a 1-minute move (mean absolute 1-minute return, bps) for each part of the day."""
    local = df.index.tz_convert(NY)
    day = local.date.astype(str)
    r = df["close"].groupby(day).pct_change().abs() * 1e4  # within-session only; overnight gaps excluded
    mins = (local.hour * 60 + local.minute) - (9 * 60 + 30)
    b = (mins // bucket_minutes) * bucket_minutes
    out = []
    for k, g in pd.Series(r.to_numpy(), index=b).dropna().groupby(level=0):
        start = 9 * 60 + 30 + int(k)
        out.append({"from": f"{start // 60:02d}:{start % 60:02d}", "mean_abs_move_bps": round(float(g.mean()), 3),
                    "median_abs_move_bps": round(float(g.median()), 3), "samples": int(len(g))})
    return out


def describe(df: pd.DataFrame, or_minutes: int = 15) -> dict:
    return {"opening_range": opening_range(df, or_minutes), "gaps": gaps(df), "volatility_by_time": volatility_by_time(df),
            "sessions": int(len(set(df.index.tz_convert(NY).date))) if len(df) else 0,
            "note": "Descriptions of past sessions on QQQ (a proxy for the Nasdaq-100). Not strategies, not predictions."}
