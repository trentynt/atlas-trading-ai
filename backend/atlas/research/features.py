"""Statistical feature engineering + feature-importance via rank information coefficient.

All features at index t are computed from data available at the close of t. Forward returns are
used ONLY as the evaluation target, never as an input."""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..data.validation import resample
from .indicators import efficiency_ratio, log_returns, realized_vol, rsi, sma, zscore


FEATURE_DOCS: dict[str, str] = {
    "ret_1": "1-bar log return", "ret_5": "5-bar log return", "mom_20": "20-bar momentum (log)",
    "mom_60": "60-bar momentum (log)", "mom_120": "120-bar momentum (log)", "vol_20": "20-bar annualised realised vol",
    "vol_ratio": "10/60-bar volatility ratio", "z_20": "20-bar price z-score", "rsi_14": "RSI(14)",
    "dist_sma_50": "distance from SMA(50)", "dist_sma_200": "distance from SMA(200)",
    "efficiency_30": "Kaufman efficiency ratio (30)", "skew_60": "60-bar return skewness",
    "volume_z_20": "20-bar log-volume z-score (crypto only)", "w_mom_12": "12-week momentum (weekly bars, causal)",
    "w_trend": "weekly close vs weekly SMA(20) (causal)",
}


def align_higher_tf(daily_index: pd.DatetimeIndex, higher: pd.Series) -> pd.Series:
    """Map a higher-timeframe series (labelled by period END) onto daily bars. A weekly value becomes
    visible on the day its week closes, never before."""
    u = daily_index.union(higher.index)
    return higher.reindex(u).ffill().reindex(daily_index)


def build_features(df: pd.DataFrame, periods_per_year: int = 252) -> pd.DataFrame:
    c = df["close"]
    lr = log_returns(c)
    f = pd.DataFrame(index=df.index)
    f["ret_1"] = lr
    f["ret_5"] = np.log(c / c.shift(5))
    f["mom_20"] = np.log(c / c.shift(20))
    f["mom_60"] = np.log(c / c.shift(60))
    f["mom_120"] = np.log(c / c.shift(120))
    f["vol_20"] = realized_vol(c, 20, periods_per_year)
    f["vol_ratio"] = realized_vol(c, 10, periods_per_year) / realized_vol(c, 60, periods_per_year)
    f["z_20"] = zscore(c, 20)
    f["rsi_14"] = rsi(c, 14)
    f["dist_sma_50"] = c / sma(c, 50) - 1
    f["dist_sma_200"] = c / sma(c, 200) - 1
    f["efficiency_30"] = efficiency_ratio(c, 30)
    f["skew_60"] = lr.rolling(60, min_periods=60).skew()
    if df["volume"].notna().mean() > 0.99:
        f["volume_z_20"] = zscore(np.log(df["volume"].replace(0, np.nan)), 20)
    # Multi-timeframe: weekly trend & momentum, aligned causally
    w = resample(df, "W-FRI")
    f["w_mom_12"] = align_higher_tf(df.index, np.log(w["close"] / w["close"].shift(12)))
    f["w_trend"] = align_higher_tf(df.index, np.sign(w["close"] - sma(w["close"], 20)))
    return f


def feature_importance(df: pd.DataFrame, periods_per_year: int = 252, horizon: int = 5,
                       train_frac: float = 0.7) -> dict:
    """Spearman rank-IC between each feature and the forward `horizon`-bar log return, computed on the
    training portion and re-checked on the held-out tail (to expose unstable relationships)."""
    feats = build_features(df, periods_per_year)
    fwd = np.log(df["close"].shift(-horizon) / df["close"])
    data = feats.join(fwd.rename("fwd")).dropna()
    if len(data) < 200:
        return {"horizon": horizon, "features": [], "note": "insufficient data"}
    cut = int(len(data) * train_frac)
    # Purge `horizon` bars between train and test so overlapping targets don't leak.
    train, test = data.iloc[:cut - horizon], data.iloc[cut:]
    out = []
    for col in feats.columns:
        if col not in data:
            continue
        ic_tr = _spearman(train[col], train["fwd"])
        ic_te = _spearman(test[col], test["fwd"])
        n = len(train)
        t_stat = ic_tr * np.sqrt((n / horizon - 2) / max(1e-12, 1 - ic_tr ** 2)) if np.isfinite(ic_tr) else np.nan
        out.append({"feature": col, "ic_train": _n(ic_tr), "ic_test": _n(ic_te), "t_stat_adj": _n(t_stat),
                    "sign_stable": bool(np.sign(ic_tr) == np.sign(ic_te)) if np.isfinite(ic_tr) and np.isfinite(ic_te) else None})
    out.sort(key=lambda r: -abs(r["ic_train"] or 0))
    return {"horizon": horizon, "train_rows": len(train), "test_rows": len(test), "features": out,
            "method": "Spearman rank IC vs forward log return; t-stat adjusted for overlapping horizons; "
                      f"{horizon}-bar purge between train and test."}


def _spearman(a: pd.Series, b: pd.Series) -> float:
    if len(a) < 30:
        return float("nan")
    return float(a.rank().corr(b.rank()))


def _n(x) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), 5)
