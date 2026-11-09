"""Performance and statistical-robustness metrics."""
from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np
import pandas as pd

_N = NormalDist()
EULER_GAMMA = 0.5772156649


def _f(x) -> float | None:
    if x is None:
        return None
    x = float(x)
    return x if math.isfinite(x) else None


def max_drawdown(equity: pd.Series) -> tuple[float, pd.Series]:
    dd = equity / equity.cummax() - 1
    return float(dd.min()) if len(dd) else 0.0, dd


def sharpe(r: pd.Series, ppy: int) -> float | None:
    sd = r.std(ddof=1)
    return _f(r.mean() / sd * math.sqrt(ppy)) if len(r) > 2 and sd > 0 else None


def sortino(r: pd.Series, ppy: int) -> float | None:
    downside = np.sqrt((np.minimum(r, 0) ** 2).mean())
    return _f(r.mean() / downside * math.sqrt(ppy)) if len(r) > 2 and downside > 0 else None


def performance(equity: pd.Series, trades: list[dict], ppy: int, exposure: float | None = None) -> dict:
    """Standard metric block. `equity` is indexed by timestamp over the evaluation window only."""
    if len(equity) < 2:
        return {"bars": len(equity), "num_trades": 0}
    r = equity.pct_change().dropna()
    total = equity.iloc[-1] / equity.iloc[0] - 1
    days = (equity.index[-1] - equity.index[0]).days
    years = days / 365.25
    mdd, dd = max_drawdown(equity)
    pnl = np.array([t["pnl"] for t in trades]) if trades else np.array([])
    wins, losses = pnl[pnl > 0], pnl[pnl <= 0]
    gross_win, gross_loss = wins.sum(), -losses.sum()
    durations = [t["bars_held"] for t in trades]
    # Longest drawdown duration in bars
    underwater = (dd < 0).astype(int).to_numpy()
    longest, cur = 0, 0
    for u in underwater:
        cur = cur + 1 if u else 0
        longest = max(longest, cur)
    out = {
        "bars": int(len(equity)),
        "start": equity.index[0].date().isoformat(),
        "end": equity.index[-1].date().isoformat(),
        "total_return": _f(total),
        # Annualising a short window produces misleading numbers, so we only report it for >= 1 year.
        "annualized_return": _f((1 + total) ** (1 / years) - 1) if years >= 1 and total > -1 else None,
        "annualized_vol": _f(r.std(ddof=1) * math.sqrt(ppy)),
        "max_drawdown": _f(mdd),
        "longest_drawdown_bars": int(longest),
        "sharpe": sharpe(r, ppy),
        "sortino": sortino(r, ppy),
        "calmar": _f(((1 + total) ** (1 / years) - 1) / abs(mdd)) if years >= 1 and mdd < 0 else None,
        "num_trades": int(len(trades)),
        "win_rate": _f(len(wins) / len(pnl)) if len(pnl) else None,
        "profit_factor": _f(gross_win / gross_loss) if gross_loss > 0 else (None if not len(pnl) else None),
        "expectancy": _f(pnl.mean()) if len(pnl) else None,
        "expectancy_pct": _f(np.mean([t["return"] for t in trades])) if trades else None,
        "avg_win": _f(wins.mean()) if len(wins) else None,
        "avg_loss": _f(losses.mean()) if len(losses) else None,
        "avg_trade_bars": _f(np.mean(durations)) if durations else None,
        "exposure": _f(exposure),
        "skew": _f(r.skew()),
        "kurtosis": _f(r.kurt()),
        "var_95": _f(np.percentile(r, 5)),
        "cvar_95": _f(r[r <= np.percentile(r, 5)].mean()),
        "best_bar": _f(r.max()),
        "worst_bar": _f(r.min()),
    }
    return out


def probabilistic_sharpe(r: pd.Series, sr_benchmark: float = 0.0) -> float | None:
    """PSR (Bailey & López de Prado): probability the true per-bar Sharpe exceeds sr_benchmark,
    accounting for sample length, skew and kurtosis."""
    r = r.dropna()
    n = len(r)
    if n < 30 or r.std() == 0:
        return None
    sr = r.mean() / r.std(ddof=1)
    g3, g4 = r.skew(), r.kurt() + 3
    denom = math.sqrt(max(1e-12, 1 - g3 * sr + (g4 - 1) / 4 * sr ** 2))
    return _f(_N.cdf((sr - sr_benchmark) * math.sqrt(n - 1) / denom))


def expected_max_sharpe(n_trials: int, sr_var: float) -> float:
    """Expected maximum per-bar Sharpe among n_trials unskilled strategies (False Strategy Theorem)."""
    if n_trials < 2 or sr_var <= 0:
        return 0.0
    return math.sqrt(sr_var) * ((1 - EULER_GAMMA) * _N.inv_cdf(1 - 1 / n_trials)
                                + EULER_GAMMA * _N.inv_cdf(1 - 1 / (n_trials * math.e)))


def deflated_sharpe(r: pd.Series, n_trials: int, sr_var: float) -> float | None:
    return probabilistic_sharpe(r, expected_max_sharpe(n_trials, sr_var))


def block_bootstrap_pvalue(r: pd.Series, n_boot: int = 1000, block: int = 10, seed: int = 7) -> float | None:
    """One-sided p-value for H0: mean return <= 0, via circular block bootstrap of demeaned returns
    (preserves short-range autocorrelation)."""
    x = r.dropna().to_numpy()
    n = len(x)
    if n < 30:
        return None
    rng = np.random.default_rng(seed)
    obs = x.mean()
    x0 = x - obs
    nb = int(math.ceil(n / block))
    starts = rng.integers(0, n, size=(n_boot, nb))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(n_boot, -1)[:, :n] % n
    means = x0[idx].mean(axis=1)
    return _f((means >= obs).mean())
