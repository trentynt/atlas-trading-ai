"""Data validation and normalisation. Pure functions — no I/O — so they are easy to test."""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .providers.base import OHLCV_COLUMNS


FREQ_ALIAS = {"1d": "D", "6h": "6h", "1h": "h"}


def normalize(raw: pd.DataFrame, *, drop_open_period: bool, now: datetime | None = None,
              freq: str = "D") -> tuple[pd.DataFrame, dict]:
    """Validate and normalise raw provider rows. Nothing is invented or repaired:
    rows that fail a check are QUARANTINED (excluded and listed in the report), so a bad candle becomes
    a visible missing candle rather than a silently corrected one.

    Checks: unparseable/non-UTC-aligned timestamps, out-of-order rows, duplicates, invalid close,
    invalid OHLC (non-positive, high below open/close, low above open/close, high < low), negative volume
    (volume set to unknown, price kept), and the still-open current period.
    Returns (clean frame indexed by ts, report)."""
    report: dict = {"raw_rows": int(len(raw)), "freq": freq}
    quarantine: list[dict] = []

    def _q(mask: pd.Series, reason: str, frame: pd.DataFrame) -> pd.DataFrame:
        n = int(mask.sum())
        report[f"{reason}_quarantined"] = n
        for _, r in frame[mask].head(50).iterrows():
            quarantine.append({"ts": str(r["ts"]), "reason": reason,
                               "row": {c: (None if pd.isna(r.get(c)) else float(r[c])) for c in OHLCV_COLUMNS[1:] if c in r}})
        return frame[~mask]

    df = raw.copy()
    ts = pd.to_datetime(df["ts"], utc=True, format="ISO8601", errors="coerce")
    df["ts"] = ts
    df = _q(df["ts"].isna(), "bad_timestamp", df)
    # UTC alignment: a daily candle must start at 00:00 UTC, an hourly one on the hour, etc.
    df = _q(df["ts"] != df["ts"].dt.floor(freq), "misaligned", df)
    order = df["ts"].diff().dt.total_seconds()
    report["out_of_order_rows"] = int((order < 0).sum())  # reported, then sorted (order carries no information)
    for c in OHLCV_COLUMNS[1:]:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    df = _q(df["close"].isna() | (df["close"] <= 0) | ~np.isfinite(df["close"]), "invalid_close", df)

    before = len(df)
    df = df.sort_values("ts", kind="stable")
    dup = df["ts"].duplicated(keep=False)
    conflicting = df[dup].groupby("ts")["close"].nunique()
    report["duplicates_dropped"] = int(before - len(df.drop_duplicates("ts", keep="last")))
    report["conflicting_duplicates"] = int((conflicting > 1).sum())  # same time, different prices
    df = df.drop_duplicates("ts", keep="last")

    if drop_open_period:
        now = now or datetime.now(timezone.utc)
        cur = pd.Timestamp(now)
        cur = (cur.tz_convert("UTC") if cur.tzinfo else cur.tz_localize("UTC")).floor(freq)
        open_mask = df["ts"] >= cur
        report["incomplete_period_dropped"] = int(open_mask.sum())
        df = df[~open_mask]

    has_ohlc = df[["open", "high", "low"]].notna().all(axis=1)
    o = df[has_ohlc]
    bad = pd.Series(False, index=df.index)
    if len(o):
        bad.loc[o.index] = ((o[["open", "high", "low"]] <= 0).any(axis=1)
                            | (o["high"] < o[["open", "close"]].max(axis=1) * (1 - 1e-9))
                            | (o["low"] > o[["open", "close"]].min(axis=1) * (1 + 1e-9))
                            | (o["high"] < o["low"]))
    df = _q(bad, "invalid_ohlc", df)

    neg_vol = df["volume"] < 0
    df.loc[neg_vol, "volume"] = np.nan
    report["negative_volume_nulled"] = int(neg_vol.sum())
    df = df.set_index("ts")[OHLCV_COLUMNS[1:]]
    report["clean_rows"] = int(len(df))
    report["quarantined"] = sum(v for k, v in report.items() if k.endswith("_quarantined"))
    report["quarantine_sample"] = quarantine[:50]
    return df, report


def cross_source_compare(primary: pd.DataFrame, secondary: pd.DataFrame, tolerance_bps: float = 50.0) -> dict:
    """Compare closes from two independent venues on overlapping dates. Venue prices legitimately differ a
    little; large or persistent gaps point to a bad feed, a wrong pair, or a timestamp shift."""
    a, b = primary["close"].dropna(), secondary["close"].dropna()
    common = a.index.intersection(b.index)
    if len(common) == 0:
        return {"overlap": 0, "status": "no_overlap"}
    diff_bps = ((a[common] / b[common]) - 1).abs() * 1e4
    over = diff_bps[diff_bps > tolerance_bps]
    # Shift test: if yesterday's secondary matches today's primary better, timestamps are misaligned.
    shifted = ((a[common[1:]].values / b.reindex(common[:-1]).values) - 1) if len(common) > 2 else np.array([])
    shift_med = float(np.nanmedian(np.abs(shifted)) * 1e4) if shifted.size else None
    med = float(diff_bps.median())
    status = "ok"
    if len(over) / len(common) > 0.05 or med > tolerance_bps / 2:
        status = "mismatch"
    if shift_med is not None and shift_med < med * 0.5 and med > 5:
        status = "possible_time_shift"
    return {"overlap": int(len(common)), "start": common[0].date().isoformat(), "end": common[-1].date().isoformat(),
            "median_abs_bps": round(med, 2), "p95_abs_bps": round(float(diff_bps.quantile(0.95)), 2),
            "max_abs_bps": round(float(diff_bps.max()), 2), "days_over_tolerance": int(len(over)),
            "tolerance_bps": tolerance_bps, "worst_days": [{"ts": t.date().isoformat(), "bps": round(float(v), 1)}
                                                            for t, v in over.sort_values().tail(5).items()],
            "status": status}


def quality_report(df: pd.DataFrame, asset_class: str, now: datetime | None = None) -> dict:
    """Missing-data detection, outlier flags, staleness."""
    if df.empty:
        return {"rows": 0, "missing_periods": 0, "gaps": [], "outliers": [], "stale_days": None}
    idx = df.index
    if asset_class == "fx":
        expected = pd.bdate_range(idx[0], idx[-1], tz="UTC")
        note = "Expected = Mon–Fri business days; TARGET holidays (e.g. 25 Dec, 1 Jan, Good Friday) are legitimately absent."
    else:
        expected = pd.date_range(idx[0], idx[-1], freq="D", tz="UTC")
        note = "Expected = every calendar day (24/7 market)."
    missing = expected.difference(idx)
    # Group consecutive missing dates into gaps
    gaps: list[dict] = []
    if len(missing):
        step = pd.Timedelta(days=4 if asset_class == "fx" else 1)
        start = prev = missing[0]
        for d in missing[1:]:
            if d - prev > step:
                gaps.append({"start": start.date().isoformat(), "end": prev.date().isoformat()})
                start = d
            prev = d
        gaps.append({"start": start.date().isoformat(), "end": prev.date().isoformat()})
    lr = np.log(df["close"]).diff().dropna()
    med = lr.median()
    mad = (lr - med).abs().median() * 1.4826 or lr.std() or 1.0
    z = (lr - med) / mad
    outliers = [{"ts": t.date().isoformat(), "log_return": float(lr[t]), "robust_z": float(z[t])}
                for t in z[z.abs() > 10].index[-20:]]
    now_ts = pd.Timestamp(now or datetime.now(timezone.utc))
    stale_days = (now_ts.tz_convert("UTC") if now_ts.tzinfo else now_ts.tz_localize("UTC")) - idx[-1]
    zero_vol = int((df["volume"] == 0).sum()) if df["volume"].notna().any() else 0
    return {
        "rows": int(len(df)),
        "zero_volume_periods": zero_vol,
        "start": idx[0].date().isoformat(),
        "end": idx[-1].date().isoformat(),
        "expected_periods": int(len(expected)),
        "missing_periods": int(len(missing)),
        "completeness": float(1 - len(missing) / max(len(expected), 1)),
        "gaps": gaps[-50:],
        "gap_count": len(gaps),
        "outliers": outliers,
        "stale_days": round(stale_days.total_seconds() / 86400, 2),
        "has_ohlc": bool(df[["open", "high", "low"]].notna().all(axis=1).mean() > 0.99),
        "has_volume": bool(df["volume"].notna().mean() > 0.99),
        "calendar_note": note,
    }


def dataset_version(df: pd.DataFrame) -> str:
    """Content hash of the dataset — the dataset version used for reproducibility."""
    canon = df.round(10).to_csv(float_format="%.10g", date_format="%Y-%m-%d").encode()
    return hashlib.sha256(canon).hexdigest()[:16]


def resample(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample daily bars to a coarser timeframe (e.g. 'W-FRI'). Bars are labelled by their period
    END and therefore become known only after that period closes."""
    agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    out = df.resample(rule, label="right", closed="right").agg(agg)
    out.loc[df["volume"].resample(rule, label="right", closed="right").count() == 0, "volume"] = np.nan
    out = out.dropna(subset=["close"])
    # Drop the still-open trailing period: its label lies beyond the last observed daily bar.
    return out[out.index <= df.index[-1]] if len(df) else out


def assess(quality: dict, norm: dict, *, max_stale_days: float, asset_class: str) -> dict:
    """Grade a dataset: "ok", "warn" (usable, caveats shown) or "fail" (not used for research)."""
    issues: list[dict] = []
    raw = max(norm.get("raw_rows", 0), 1)
    q = norm.get("quarantined", 0)
    if q:
        issues.append({"level": "warn" if q / raw <= 0.05 else "fail", "code": "quarantined",
                       "text": f"{q} candle(s) failed validation and were excluded, not repaired."})
    if norm.get("conflicting_duplicates"):
        issues.append({"level": "warn", "code": "conflicting_duplicates",
                       "text": f"{norm['conflicting_duplicates']} timestamp(s) arrived twice with different prices; the latest was kept."})
    if norm.get("out_of_order_rows"):
        issues.append({"level": "info", "code": "out_of_order",
                       "text": f"{norm['out_of_order_rows']} row(s) arrived out of order and were sorted."})
    comp = quality.get("completeness")
    if comp is not None and comp < (0.97 if asset_class == "fx" else 0.995):
        issues.append({"level": "warn" if comp >= 0.9 else "fail", "code": "missing",
                       "text": f"{quality['missing_periods']} expected period(s) are missing ({comp:.1%} complete). Gaps are left empty, never filled."})
    stale = quality.get("stale_days")
    if stale is not None and stale > max_stale_days:
        issues.append({"level": "warn", "code": "stale", "text": f"Latest bar is {stale:.1f} days old."})
    if quality.get("outliers"):
        issues.append({"level": "info", "code": "outliers",
                       "text": f"{len(quality['outliers'])} unusually large move(s) flagged for review; kept as reported."})
    if quality.get("zero_volume_periods"):
        issues.append({"level": "info", "code": "zero_volume",
                       "text": f"{quality['zero_volume_periods']} period(s) report zero volume."})
    cs = quality.get("cross_source")
    if cs and cs.get("status") in ("mismatch", "possible_time_shift"):
        issues.append({"level": "warn", "code": "cross_source",
                       "text": f"Closes disagree with a second venue (median {cs['median_abs_bps']} bps, {cs['days_over_tolerance']} day(s) over {cs['tolerance_bps']:.0f} bps)."})
    levels = {i["level"] for i in issues}
    return {"status": "fail" if "fail" in levels else "warn" if "warn" in levels else "ok", "issues": issues}
