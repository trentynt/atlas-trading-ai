"""Technical indicators. Every function is causal: the value at index t uses data at or before t only."""
from __future__ import annotations

import numpy as np
import pandas as pd


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def log_returns(close: pd.Series) -> pd.Series:
    return np.log(close).diff()


def realized_vol(close: pd.Series, n: int = 20, periods_per_year: int = 252) -> pd.Series:
    return log_returns(close).rolling(n, min_periods=n).std() * np.sqrt(periods_per_year)


def true_range(df: pd.DataFrame) -> pd.Series:
    """True range. For close-only data (e.g. ECB fixes) falls back to |close - prev close|."""
    prev = df["close"].shift(1)
    if df[["high", "low"]].notna().all(axis=1).mean() > 0.99:
        return pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)
    return (df["close"] - prev).abs()


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return true_range(df).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = up / dn.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(100.0).where(up.notna())


def zscore(s: pd.Series, n: int) -> pd.Series:
    m = s.rolling(n, min_periods=n).mean()
    sd = s.rolling(n, min_periods=n).std()
    return (s - m) / sd.replace(0, np.nan)


def donchian(df: pd.DataFrame, n: int) -> tuple[pd.Series, pd.Series]:
    """Channel of the PREVIOUS n bars (excludes the current bar, so a breakout compares close[t]
    against levels known before t)."""
    hi = (df["high"] if df["high"].notna().all() else df["close"]).rolling(n, min_periods=n).max().shift(1)
    lo = (df["low"] if df["low"].notna().all() else df["close"]).rolling(n, min_periods=n).min().shift(1)
    return hi, lo


def efficiency_ratio(close: pd.Series, n: int = 20) -> pd.Series:
    """Kaufman efficiency ratio: |net move| / path length. ~1 trending, ~0 choppy."""
    net = (close - close.shift(n)).abs()
    path = close.diff().abs().rolling(n, min_periods=n).sum()
    return net / path.replace(0, np.nan)


def rolling_percentile(s: pd.Series, n: int) -> pd.Series:
    """Percentile rank of the current value within its trailing window (causal)."""
    return s.rolling(n, min_periods=max(20, n // 4)).apply(lambda w: (w[:-1] < w[-1]).mean() if len(w) > 1 else np.nan, raw=True)
