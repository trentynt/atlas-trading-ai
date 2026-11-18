"""Statistical-integrity primitives used by the research critic.

Every function here is pure and deterministic so it can be tested against worked examples.
See docs/STATISTICS.md for the methodology, assumptions and references.
"""
from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np
import pandas as pd

_N = NormalDist()


def newey_west_lag(n: int) -> int:
    """Automatic bandwidth (Newey & West 1994 rule of thumb): floor(4 (n/100)^(2/9))."""
    return max(0, int(math.floor(4 * (n / 100.0) ** (2.0 / 9.0)))) if n > 0 else 0


def hac_t_test(returns: pd.Series | np.ndarray, lag: int | None = None) -> tuple[float | None, float | None]:
    """One-sided test of H0: mean return <= 0 using a Newey–West (Bartlett kernel) HAC standard error.

    Returns (t statistic, p-value). The p-value is continuous, which matters for false-discovery
    procedures that need resolution far below what a 1,000-draw bootstrap can provide.
    Uses a normal reference distribution (large-sample); returns (None, None) for n < 30."""
    x = np.asarray(pd.Series(returns).dropna(), dtype=float)
    n = len(x)
    if n < 30:
        return None, None
    mu = x.mean()
    e = x - mu
    L = newey_west_lag(n) if lag is None else lag
    gamma0 = float(e @ e) / n
    s = gamma0
    for k in range(1, L + 1):
        w = 1.0 - k / (L + 1.0)
        s += 2.0 * w * float(e[k:] @ e[:-k]) / n
    if s <= 0:
        return None, None
    t = mu / math.sqrt(s / n)
    return float(t), float(1.0 - _N.cdf(t))


def holm_adjust(pvals: list[float]) -> list[float]:
    """Holm (1979) step-down adjusted p-values (controls family-wise error under any dependence)."""
    m = len(pvals)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: pvals[i])
    adj = [0.0] * m
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * pvals[i]))
        adj[i] = running
    return adj


def by_adjust(pvals: list[float]) -> list[float]:
    """Benjamini–Yekutieli (2001) adjusted p-values (q-values).

    Controls the false discovery rate under ARBITRARY dependence between tests, at the price of a
    harmonic factor c(m) = sum_{i=1..m} 1/i. Chosen over Benjamini–Hochberg because strategy returns
    in one family can be negatively correlated (trend vs. mean-reversion, long vs. short), which
    violates the PRDS condition BH requires."""
    m = len(pvals)
    if m == 0:
        return []
    c = sum(1.0 / i for i in range(1, m + 1))
    order = sorted(range(m), key=lambda i: pvals[i], reverse=True)
    adj = [0.0] * m
    running = 1.0
    for idx, i in enumerate(order):
        rank = m - idx  # 1-based rank in ascending order
        running = min(running, min(1.0, pvals[i] * m * c / rank))
        adj[i] = running
    return adj


def effective_trials(returns: list[np.ndarray] | np.ndarray) -> float:
    """Effective number of independent trials from the correlation matrix of trial returns
    (Galwey 2009): M_eff = (sum_i sqrt(λ_i))^2 / sum_i λ_i, with eigenvalues clipped at 0.

    Identical strategies count once, uncorrelated strategies count fully, and k independent blocks
    of identical strategies count k. Chosen over Li & Ji (2005), whose floor() term makes the
    estimate jump under sampling noise. Input: an (n_obs, k) matrix or a list of equal-length
    return arrays. Constant columns are dropped."""
    M = np.column_stack(returns) if isinstance(returns, list) else np.asarray(returns, dtype=float)
    if M.ndim != 2 or M.shape[1] == 0:
        return 0.0
    keep = [j for j in range(M.shape[1]) if np.nanstd(M[:, j]) > 0]
    if not keep:
        return 1.0
    M = M[:, keep]
    if M.shape[1] == 1:
        return 1.0
    C = np.corrcoef(np.nan_to_num(M), rowvar=False)
    C = np.nan_to_num(C, nan=0.0)
    np.fill_diagonal(C, 1.0)
    lam = np.clip(np.linalg.eigvalsh(C), 0.0, None)
    return float(np.sqrt(lam).sum() ** 2 / lam.sum())


def per_bar_sharpe(returns: pd.Series | np.ndarray) -> float | None:
    x = np.asarray(pd.Series(returns).dropna(), dtype=float)
    if len(x) < 3 or x.std(ddof=1) == 0:
        return None
    return float(x.mean() / x.std(ddof=1))
