"""Strategy library. Add a new strategy by subclassing Strategy and decorating with @register."""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..features import align_higher_tf
from ..indicators import donchian, ema, realized_vol, rolling_percentile, rsi, sma, zscore
from ...data.validation import resample
from .base import Param, Strategy

REGISTRY: dict[str, type[Strategy]] = {}


def register(cls: type[Strategy]) -> type[Strategy]:
    REGISTRY[cls.key] = cls
    return cls


def get_strategy(key: str) -> type[Strategy]:
    if key not in REGISTRY:
        raise KeyError(f"Unknown strategy {key!r}. Available: {sorted(REGISTRY)}")
    return REGISTRY[key]


def _hold_state(entry_long: pd.Series, entry_short: pd.Series, exit_long: pd.Series, exit_short: pd.Series) -> pd.Series:
    """Stateful position from entry/exit conditions (causal loop)."""
    pos = np.zeros(len(entry_long))
    el, es, xl, xs = (x.fillna(False).to_numpy(bool) for x in (entry_long, entry_short, exit_long, exit_short))
    cur = 0.0
    for i in range(len(pos)):
        if cur > 0 and xl[i]:
            cur = 0.0
        elif cur < 0 and xs[i]:
            cur = 0.0
        if cur == 0:
            cur = 1.0 if el[i] else (-1.0 if es[i] else 0.0)
        pos[i] = cur
    return pd.Series(pos, index=entry_long.index)


@register
class MovingAverageCrossover(Strategy):
    key = "ma_crossover"
    name = "Moving-Average Crossover"
    family = "trend"
    description = "Classic trend-following: long when the fast average is above the slow average, short below."
    rules = ["LONG when MA(fast) > MA(slow) at close", "SHORT when MA(fast) < MA(slow) at close (if shorts allowed)",
             "Average type: simple or exponential"]
    params = (
        Param("fast", "int", 20, 2, 200, (10, 20, 50), "Fast window"),
        Param("slow", "int", 100, 5, 400, (50, 100, 200), "Slow window"),
        Param("exponential", "bool", False, grid=(False, True), description="Use EMA instead of SMA"),
    )
    preferred_regimes = ["trend_up", "trend_down"]

    def validate(self):
        if self.p["fast"] >= self.p["slow"]:
            raise ValueError("fast must be < slow")

    def raw_signal(self, df):
        f = ema if self.p["exponential"] else sma
        a, b = f(df["close"], self.p["fast"]), f(df["close"], self.p["slow"])
        return np.sign(a - b).where(b.notna())


@register
class DonchianBreakout(Strategy):
    key = "donchian_breakout"
    name = "Donchian Channel Breakout"
    family = "breakout"
    description = "Turtle-style breakout: enter when price closes beyond the prior N-bar extreme, exit on the opposite M-bar extreme."
    rules = ["LONG when close > highest high of prior `entry` bars", "SHORT when close < lowest low of prior `entry` bars",
             "EXIT long when close < lowest low of prior `exit` bars (mirror for short)"]
    params = (
        Param("entry", "int", 55, 5, 300, (20, 55, 100), "Entry channel lookback"),
        Param("exit", "int", 20, 3, 200, (10, 20), "Exit channel lookback"),
    )
    preferred_regimes = ["trend_up", "trend_down"]

    def validate(self):
        if self.p["exit"] >= self.p["entry"]:
            raise ValueError("exit must be < entry")

    def raw_signal(self, df):
        c = df["close"]
        hi_e, lo_e = donchian(df, self.p["entry"])
        hi_x, lo_x = donchian(df, self.p["exit"])
        return _hold_state(c > hi_e, c < lo_e, c < lo_x, c > hi_x)


@register
class BollingerReversion(Strategy):
    key = "bollinger_reversion"
    name = "Bollinger Mean Reversion"
    family = "mean_reversion"
    description = "Fade statistically stretched moves: buy when price is far below its rolling mean, exit near the mean."
    rules = ["LONG when z-score(close, window) < -entry_z", "SHORT when z-score > +entry_z",
             "EXIT when |z| < exit_z"]
    params = (
        Param("window", "int", 20, 5, 200, (10, 20, 40), "Rolling window"),
        Param("entry_z", "float", 2.0, 0.5, 4.0, (1.5, 2.0, 2.5), "Entry threshold (std devs)"),
        Param("exit_z", "float", 0.25, 0.0, 2.0, (0.0, 0.5), "Exit threshold (std devs)"),
    )
    preferred_regimes = ["range"]

    def validate(self):
        if self.p["exit_z"] >= self.p["entry_z"]:
            raise ValueError("exit_z must be < entry_z")

    def raw_signal(self, df):
        z = zscore(df["close"], self.p["window"])
        return _hold_state(z < -self.p["entry_z"], z > self.p["entry_z"], z > -self.p["exit_z"], z < self.p["exit_z"])


@register
class RSIReversion(Strategy):
    key = "rsi_reversion"
    name = "RSI Reversion with Trend Filter"
    family = "mean_reversion"
    description = "Buy oversold dips in an uptrend (sell overbought rallies in a downtrend)."
    rules = ["Trend filter: close vs SMA(trend)", "LONG when trend up and RSI(n) < oversold; exit when RSI > 50",
             "SHORT when trend down and RSI(n) > 100-oversold; exit when RSI < 50"]
    params = (
        Param("n", "int", 14, 2, 50, (2, 7, 14), "RSI lookback"),
        Param("oversold", "float", 30.0, 5.0, 45.0, (10.0, 20.0, 30.0), "Oversold level"),
        Param("trend", "int", 200, 20, 400, (100, 200), "Trend-filter SMA"),
    )
    preferred_regimes = ["range", "trend_up"]

    def raw_signal(self, df):
        c = df["close"]
        r = rsi(c, self.p["n"])
        up = c > sma(c, self.p["trend"])
        ob = 100 - self.p["oversold"]
        return _hold_state(up & (r < self.p["oversold"]), ~up & (r > ob), r > 50, r < 50)


@register
class TimeSeriesMomentum(Strategy):
    key = "ts_momentum"
    name = "Time-Series Momentum"
    family = "momentum"
    description = "Position in the direction of the trailing N-bar return when it exceeds a volatility-scaled threshold."
    rules = ["Compute trailing log return over `lookback` bars", "Threshold = `threshold` × trailing vol × sqrt(lookback)",
             "LONG above +threshold, SHORT below −threshold, flat otherwise"]
    params = (
        Param("lookback", "int", 120, 10, 365, (20, 60, 120, 250), "Momentum lookback"),
        Param("threshold", "float", 0.0, 0.0, 2.0, (0.0, 0.5), "Signal threshold in vol units"),
    )
    preferred_regimes = ["trend_up", "trend_down"]

    def raw_signal(self, df):
        c = df["close"]
        n = self.p["lookback"]
        m = np.log(c / c.shift(n))
        vol = np.log(c).diff().rolling(60, min_periods=60).std()
        th = self.p["threshold"] * vol * np.sqrt(n)
        return pd.Series(np.where(m > th, 1.0, np.where(m < -th, -1.0, 0.0)), index=c.index).where(m.notna() & vol.notna())


@register
class VolFilteredTrend(Strategy):
    key = "mtf_vol_trend"
    name = "Multi-Timeframe Trend with Volatility Filter"
    family = "trend"
    description = ("Daily EMA trend aligned with the weekly trend, standing aside when realized volatility is in the "
                   "top of its 1-year range.")
    rules = ["Weekly trend = sign(weekly close − weekly SMA(20)), visible only after the week closes",
             "Daily trend = sign(EMA(daily_fast) − EMA(daily_slow))",
             "Trade only when daily and weekly agree", "FLAT when 20d vol percentile > max_vol_pct"]
    params = (
        Param("daily_fast", "int", 20, 5, 100, (10, 20), "Daily fast EMA"),
        Param("daily_slow", "int", 60, 20, 300, (50, 100), "Daily slow EMA"),
        Param("max_vol_pct", "float", 0.9, 0.5, 1.0, (0.8, 0.95, 1.0), "Max vol percentile to trade"),
    )
    preferred_regimes = ["trend_up", "trend_down"]

    def validate(self):
        if self.p["daily_fast"] >= self.p["daily_slow"]:
            raise ValueError("daily_fast must be < daily_slow")

    def raw_signal(self, df):
        c = df["close"]
        d = np.sign(ema(c, self.p["daily_fast"]) - ema(c, self.p["daily_slow"]))
        w = resample(df, "W-FRI")["close"]
        wt = align_higher_tf(df.index, np.sign(w - sma(w, 20)))
        vp = rolling_percentile(realized_vol(c, 20), 252)
        sig = np.where((d == wt) & (vp.fillna(0) <= self.p["max_vol_pct"]), d, 0.0)
        return pd.Series(sig, index=c.index).where(wt.notna() & d.notna())
