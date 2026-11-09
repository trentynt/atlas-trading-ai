"""Baseline forecasting models + rolling-origin evaluation.

Models forecast LOG PRICE at horizons 1..H using only data up to the forecast origin. Prediction
intervals are Gaussian in log space with sigma from trailing realised volatility × sqrt(h), plus the
model's own parameter-free assumptions. Calibration of those intervals is measured empirically.

These are statistical baselines. A forecast is a distribution, not a promise."""
from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np
import pandas as pd

from ..research.regime import classify

_N = NormalDist()
LEVELS = (0.5, 0.8, 0.95)


def _naive(lp: np.ndarray, h: int) -> np.ndarray:
    return np.full(h, lp[-1])


def _drift(lp: np.ndarray, h: int, window: int = 252) -> np.ndarray:
    w = lp[-window:]
    mu = (w[-1] - w[0]) / max(len(w) - 1, 1)
    return lp[-1] + mu * np.arange(1, h + 1)


def _rolling_mean(lp: np.ndarray, h: int, window: int = 20) -> np.ndarray:
    return np.full(h, lp[-window:].mean())


def _ar1(lp: np.ndarray, h: int, window: int = 500) -> np.ndarray:
    r = np.diff(lp[-window - 1:])
    if len(r) < 30:
        return _naive(lp, h)
    x, y = r[:-1], r[1:]
    xm, ym = x.mean(), y.mean()
    var = ((x - xm) ** 2).sum()
    phi = float(((x - xm) * (y - ym)).sum() / var) if var > 0 else 0.0
    phi = max(-0.99, min(0.99, phi))
    c = ym - phi * xm
    out, last, cur = [], r[-1], lp[-1]
    for _ in range(h):
        last = c + phi * last
        cur = cur + last
        out.append(cur)
    return np.array(out)


def _holt(lp: np.ndarray, h: int, alpha: float = 0.2, beta: float = 0.05, window: int = 500) -> np.ndarray:
    y = lp[-window:]
    level, trend = y[0], 0.0
    for v in y[1:]:
        prev = level
        level = alpha * v + (1 - alpha) * (level + trend)
        trend = beta * (level - prev) + (1 - beta) * trend
    # damped trend (phi=0.9) — undamped Holt extrapolates trends far too aggressively
    phi = 0.9
    damp = np.cumsum(phi ** np.arange(1, h + 1))
    return level + trend * damp


MODELS = {
    "naive": ("Random walk (naive)", _naive, "Tomorrow equals today. The benchmark every model must beat."),
    "drift": ("Random walk with drift", _drift, "Extrapolates the trailing 1-year average log-return."),
    "rolling_mean": ("Rolling mean (20)", _rolling_mean, "Mean-reversion baseline: price reverts to its 20-bar mean."),
    "ar1": ("AR(1) on returns", _ar1, "Linear autoregression on daily log-returns, OLS on trailing 500 bars."),
    "holt": ("Damped Holt trend", _holt, "Exponential smoothing with damped trend on log price."),
}


def _sigma(lp: np.ndarray, window: int = 60) -> float:
    r = np.diff(lp[-window - 1:])
    return float(r.std(ddof=1)) if len(r) > 5 else float("nan")


def forecast(df: pd.DataFrame, model: str, horizon: int) -> dict:
    lp = np.log(df["close"].to_numpy(float))
    name, fn, _ = MODELS[model]
    mean = fn(lp, horizon)
    sig = _sigma(lp)
    hs = np.arange(1, horizon + 1)
    freq = pd.infer_freq(df.index[-30:]) or ("B" if df.index[-30:].dayofweek.max() < 5 else "D")
    future = pd.date_range(df.index[-1], periods=horizon + 1, freq="B" if freq.startswith("B") or freq.startswith("C") else "D")[1:]
    path = []
    for i, h in enumerate(hs):
        row = {"t": future[i].date().isoformat(), "h": int(h), "mean": float(np.exp(mean[i]))}
        for lvl in LEVELS:
            z = _N.inv_cdf(0.5 + lvl / 2)
            row[f"lo{int(lvl * 100)}"] = float(np.exp(mean[i] - z * sig * math.sqrt(h)))
            row[f"hi{int(lvl * 100)}"] = float(np.exp(mean[i] + z * sig * math.sqrt(h)))
        path.append(row)
    return {"model": model, "name": name, "origin": df.index[-1].date().isoformat(),
            "origin_price": float(df["close"].iloc[-1]), "sigma_daily": sig, "path": path}


def rolling_evaluation(df: pd.DataFrame, horizon: int = 10, n_origins: int = 120, step: int = 5,
                       periods_per_year: int = 252, models: list[str] | None = None) -> dict:
    """Rolling-origin evaluation: at each origin, fit on the past only, forecast `horizon` bars, score."""
    models = models or list(MODELS)
    lp_all = np.log(df["close"].to_numpy(float))
    n = len(lp_all)
    origins = [o for o in range(n - horizon - 1, 300, -step)][:n_origins][::-1]
    if not origins:
        return {"error": "insufficient history"}
    reg = classify(df, periods_per_year)["vol"].to_numpy()
    rows = []
    for o in origins:
        hist = lp_all[: o + 1]
        actual = lp_all[o + 1: o + 1 + horizon]
        sig = _sigma(hist)
        for m in models:
            pred = MODELS[m][1](hist, horizon)
            err = actual - pred
            hs = np.arange(1, horizon + 1)
            cover = {}
            for lvl in LEVELS:
                z = _N.inv_cdf(0.5 + lvl / 2)
                cover[lvl] = (np.abs(err) <= z * sig * np.sqrt(hs)).astype(float)
            rows.append({"origin": o, "model": m, "err": err, "dir_hit": float(np.sign(pred[-1] - hist[-1]) == np.sign(actual[-1] - hist[-1]))
                         if pred[-1] != hist[-1] else np.nan, "cover": cover, "regime": reg[o]})
    naive_mae_h = np.mean([np.abs(r["err"][-1]) for r in rows if r["model"] == "naive"])
    out_models = []
    for m in models:
        rs = [r for r in rows if r["model"] == m]
        E = np.vstack([r["err"] for r in rs])
        mae_h = np.abs(E).mean(axis=0)
        rmse_h = np.sqrt((E ** 2).mean(axis=0))
        dirs = [r["dir_hit"] for r in rs if not np.isnan(r["dir_hit"])]
        regimes = {}
        for g in ("low_vol", "normal_vol", "high_vol"):
            sub = [abs(r["err"][-1]) for r in rs if r["regime"] == g]
            if sub:
                regimes[g] = {"mae_pct": float(np.mean(sub) * 100), "n": len(sub)}
        out_models.append({
            "model": m, "name": MODELS[m][0], "description": MODELS[m][2],
            "mae_pct": float(mae_h[-1] * 100), "rmse_pct": float(rmse_h[-1] * 100),
            "mase": float(mae_h[-1] / naive_mae_h) if naive_mae_h > 0 else None,
            "directional_accuracy": float(np.mean(dirs)) if dirs else None,
            "bias_pct": float(E[:, -1].mean() * 100),
            "mae_by_horizon_pct": [float(x * 100) for x in mae_h],
            "coverage": {str(int(l * 100)): float(np.mean([r["cover"][l][-1] for r in rs])) for l in LEVELS},
            "coverage_by_horizon": {str(int(l * 100)): [float(x) for x in np.mean([r["cover"][l] for r in rs], axis=0)] for l in LEVELS},
            "by_regime": regimes,
        })
    out_models.sort(key=lambda x: x["mae_pct"])
    return {"horizon": horizon, "origins": len(origins), "step": step,
            "first_origin": df.index[origins[0]].date().isoformat(), "last_origin": df.index[origins[-1]].date().isoformat(),
            "models": out_models,
            "note": "Errors are in log-price % at the final horizon. MASE < 1 means better than the naive random walk."}
