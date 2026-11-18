"""Causal market-regime classification (trend × volatility)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .indicators import efficiency_ratio, realized_vol, rolling_percentile, sma

TREND_LABELS = ("trend_up", "trend_down", "range")
VOL_LABELS = ("low_vol", "normal_vol", "high_vol")


def classify(df: pd.DataFrame, periods_per_year: int = 252, trend_n: int = 50, er_n: int = 30,
             er_threshold: float = 0.25) -> pd.DataFrame:
    close = df["close"]
    ma = sma(close, trend_n)
    slope = ma.pct_change(10)
    er = efficiency_ratio(close, er_n)
    trend = np.where(er.isna() | slope.isna(), None,
                     np.where(er >= er_threshold, np.where(slope > 0, "trend_up", "trend_down"), "range"))
    vol = realized_vol(close, 20, periods_per_year)
    pct = rolling_percentile(vol, 252)
    vreg = np.where(pct.isna(), None, np.where(pct >= 0.8, "high_vol", np.where(pct <= 0.2, "low_vol", "normal_vol")))
    return pd.DataFrame({"trend": trend, "vol": vreg, "efficiency": er, "ann_vol": vol, "vol_pct": pct}, index=df.index)


def summarize(reg: pd.DataFrame) -> dict:
    r = reg.dropna(subset=["trend", "vol"])
    if r.empty:
        return {"current": None}
    last = r.iloc[-1]
    # segments for timeline visualisation
    key = r["trend"] + "|" + r["vol"]
    seg_id = (key != key.shift()).cumsum()
    segs = [{"start": g.index[0].date().isoformat(), "end": g.index[-1].date().isoformat(),
             "trend": g["trend"].iloc[0], "vol": g["vol"].iloc[0], "bars": len(g)}
            for _, g in r.groupby(seg_id)]
    return {
        "current": {"trend": last["trend"], "vol": last["vol"], "efficiency": _num(last["efficiency"]),
                    "ann_vol": _num(last["ann_vol"]), "vol_pct": _num(last["vol_pct"]), "since": segs[-1]["start"]},
        "distribution": {k: float(v) for k, v in key.value_counts(normalize=True).items()},
        "segments": segs[-120:],
    }


def _num(x) -> float | None:
    return None if x is None or pd.isna(x) else float(x)
