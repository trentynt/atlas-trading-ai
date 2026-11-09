"""Data validation and normalisation. Pure functions — no I/O — so they are easy to test."""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .providers.base import OHLCV_COLUMNS


def normalize(raw: pd.DataFrame, *, drop_open_period: bool, now: datetime | None = None) -> tuple[pd.DataFrame, dict]:
    """Normalise timestamps to UTC day starts, drop invalid/duplicate rows, repair OHLC consistency.
    Returns (clean frame indexed by ts, report of what was changed)."""
    report: dict = {"raw_rows": int(len(raw))}
    df = raw.copy()
    df["ts"] = pd.to_datetime(df["ts"], utc=True, format="ISO8601").dt.floor("D")
    for c in OHLCV_COLUMNS[1:]:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    invalid = df["close"].isna() | (df["close"] <= 0) | ~np.isfinite(df["close"])
    report["invalid_close_dropped"] = int(invalid.sum())
    df = df[~invalid]

    before = len(df)
    df = df.sort_values("ts").drop_duplicates("ts", keep="last")
    report["duplicates_dropped"] = int(before - len(df))

    if drop_open_period:
        now = now or datetime.now(timezone.utc)
        today = pd.Timestamp(now).tz_convert("UTC").floor("D") if pd.Timestamp(now).tzinfo else pd.Timestamp(now, tz="UTC").floor("D")
        open_mask = df["ts"] >= today
        report["incomplete_period_dropped"] = int(open_mask.sum())
        df = df[~open_mask]

    has_ohlc = df[["open", "high", "low"]].notna().all(axis=1)
    if has_ohlc.any():
        o = df.loc[has_ohlc]
        bad_hi = o["high"] < o[["open", "close"]].max(axis=1)
        bad_lo = o["low"] > o[["open", "close"]].min(axis=1)
        report["ohlc_inconsistencies_repaired"] = int((bad_hi | bad_lo).sum())
        df.loc[o.index[bad_hi], "high"] = o.loc[bad_hi, ["open", "close"]].max(axis=1)
        df.loc[o.index[bad_lo], "low"] = o.loc[bad_lo, ["open", "close"]].min(axis=1)
    else:
        report["ohlc_inconsistencies_repaired"] = 0

    neg_vol = df["volume"] < 0
    df.loc[neg_vol, "volume"] = np.nan
    report["negative_volume_nulled"] = int(neg_vol.sum())
    df = df.set_index("ts")[OHLCV_COLUMNS[1:]]
    report["clean_rows"] = int(len(df))
    return df, report


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
    return {
        "rows": int(len(df)),
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
