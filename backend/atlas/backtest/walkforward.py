"""Chronological splits, in-sample optimisation, walk-forward evaluation and robustness checks."""
from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np
import pandas as pd

from ..research.strategies.base import Strategy
from .engine import BacktestConfig, CostModel, run_backtest
from .metrics import block_bootstrap_pvalue, deflated_sharpe, performance, probabilistic_sharpe


@dataclass
class Splits:
    train: tuple[str, str]
    validation: tuple[str, str]
    test: tuple[str, str]


def chronological_splits(index: pd.DatetimeIndex, train: float = 0.6, val: float = 0.2, warmup: int = 252) -> Splits:
    """Split the tradeable range (after a warm-up for indicators) into train/validation/test, in time order."""
    usable = index[min(warmup, len(index) // 4):]
    n = len(usable)
    a, b = int(n * train), int(n * (train + val))
    d = lambda t: t.date().isoformat()
    return Splits((d(usable[0]), d(usable[a - 1])), (d(usable[a]), d(usable[b - 1])), (d(usable[b]), d(usable[-1])))


def window_cfg(cfg: BacktestConfig, start: str, end: str) -> BacktestConfig:
    return replace(cfg, start=start, end=end)


def evaluate_window(df, strategy_cls, params, cfg, start, end, regimes=None):
    return run_backtest(df, strategy_cls(**params), window_cfg(cfg, start, end), regimes)


def optimize(df: pd.DataFrame, strategy_cls: type[Strategy], grid: list[dict], cfg: BacktestConfig,
             start: str, end: str, min_trades: int = 5, cancel=None) -> tuple[dict, list[dict]]:
    """Grid search on [start, end] only. Objective: Sharpe, with a penalty for too few trades."""
    results = []
    for params in grid:
        if cancel and cancel():
            break
        try:
            r = evaluate_window(df, strategy_cls, params, cfg, start, end)
        except ValueError:
            continue
        m = r.metrics
        score = (m.get("sharpe") or -9.0) - (1.0 if m["num_trades"] < min_trades else 0.0)
        results.append({"params": params, "score": score, "sharpe": m.get("sharpe"), "trades": m["num_trades"],
                        "total_return": m.get("total_return")})
    if not results:
        raise ValueError("optimisation produced no valid runs")
    results.sort(key=lambda x: -x["score"])
    return results[0]["params"], results


def walk_forward(df: pd.DataFrame, strategy_cls: type[Strategy], grid: list[dict], cfg: BacktestConfig,
                 n_folds: int = 5, train_bars: int = 504, test_bars: int | None = None, warmup: int = 252,
                 cancel=None) -> dict:
    """Rolling walk-forward: optimise on each train window, trade the following unseen test window
    with the chosen parameters, and stitch the out-of-sample equity."""
    idx = df.index
    avail = len(idx) - warmup - train_bars
    if avail < 60:
        return {"folds": [], "note": "insufficient history for walk-forward"}
    test_bars = test_bars or max(40, avail // n_folds)
    folds = []
    oos_returns = []
    oos_trades: list[dict] = []
    k = 0
    pos = warmup
    while pos + train_bars + 20 <= len(idx) and k < n_folds:
        if cancel and cancel():
            break
        tr_s, tr_e = idx[pos], idx[pos + train_bars - 1]
        te_s = idx[pos + train_bars]
        te_e = idx[min(pos + train_bars + test_bars - 1, len(idx) - 1)]
        d = lambda t: t.date().isoformat()
        best, _ = optimize(df, strategy_cls, grid, cfg, d(tr_s), d(tr_e), cancel=cancel)
        is_r = evaluate_window(df, strategy_cls, best, cfg, d(tr_s), d(tr_e))
        oos = evaluate_window(df, strategy_cls, best, cfg, d(te_s), d(te_e))
        oos_returns.append(oos.returns)
        oos_trades += oos.trades
        folds.append({"fold": k + 1, "train": [d(tr_s), d(tr_e)], "test": [d(te_s), d(te_e)], "params": best,
                      "is_sharpe": is_r.metrics.get("sharpe"), "oos_sharpe": oos.metrics.get("sharpe"),
                      "oos_return": oos.metrics.get("total_return"), "oos_trades": oos.metrics["num_trades"],
                      "oos_max_drawdown": oos.metrics.get("max_drawdown")})
        pos += test_bars
        k += 1
    if not oos_returns:
        return {"folds": [], "note": "no folds completed"}
    r = pd.concat(oos_returns)
    r = r[~r.index.duplicated()]
    eq = cfg.initial_cash * (1 + r).cumprod()
    eq = pd.concat([pd.Series([cfg.initial_cash], index=[r.index[0] - pd.Timedelta(days=1)]), eq])
    m = performance(eq, oos_trades, cfg.periods_per_year)
    # Parameter stability across folds: share of folds choosing the modal parameter set
    keys = [tuple(sorted(f["params"].items())) for f in folds]
    stability = max(keys.count(x) for x in set(keys)) / len(keys)
    is_s = [f["is_sharpe"] for f in folds if f["is_sharpe"] is not None]
    oos_s = [f["oos_sharpe"] for f in folds if f["oos_sharpe"] is not None]
    return {
        "folds": folds, "oos_metrics": m,
        "oos_equity": [{"t": t.date().isoformat(), "v": float(v)} for t, v in eq.items()][:: max(1, len(eq) // 800)],
        "param_stability": stability,
        "mean_is_sharpe": float(np.mean(is_s)) if is_s else None,
        "mean_oos_sharpe": float(np.mean(oos_s)) if oos_s else None,
        "positive_oos_folds": sum(1 for s in oos_s if s > 0),
    }


def neighbours(strategy_cls: type[Strategy], params: dict) -> list[dict]:
    """Parameter sets one grid-step away in each numeric dimension."""
    out = []
    for p in strategy_cls.params:
        if p.kind not in ("int", "float") or not p.grid:
            continue
        g = sorted(p.grid)
        cur = params.get(p.name, p.default)
        lower = [x for x in g if x < cur]
        higher = [x for x in g if x > cur]
        for v in ([lower[-1]] if lower else []) + ([higher[0]] if higher else []):
            cand = {**params, p.name: v}
            try:
                strategy_cls(**cand)
                out.append(cand)
            except ValueError:
                pass
    return out


def full_evaluation(df: pd.DataFrame, strategy_cls: type[Strategy], params: dict, cfg: BacktestConfig,
                    regimes: pd.Series | None = None, n_trials: int = 1, trial_sharpe_var: float = 0.0,
                    walkforward_grid: list[dict] | None = None, cancel=None) -> dict:
    """The complete robustness battery for a single hypothesis.

    `df` must already be truncated to the RESEARCH WINDOW (everything before the sealed holdout);
    nothing in this function can see holdout data. Splits within it: train / validation / selection
    test, in time order. Private keys (prefixed `_`) carry return series for the trial registry."""
    from ..research.integrity import hac_t_test

    sp = chronological_splits(df.index)
    res = {}
    for name, (s, e) in (("train", sp.train), ("validation", sp.validation), ("test", sp.test)):
        res[name] = run_backtest(df, strategy_cls(**params), window_cfg(cfg, s, e), regimes)
    test = res["test"]
    stress = {}
    for mult in (2, 3):
        c = cfg.costs
        cfg2 = replace(cfg, costs=CostModel(c.spread_bps * mult, c.fee_bps * mult, c.slippage_bps * mult))
        r2 = run_backtest(df, strategy_cls(**params), window_cfg(cfg2, *sp.test))
        stress[f"x{mult}"] = {"sharpe": r2.metrics.get("sharpe"), "total_return": r2.metrics.get("total_return")}
    # One continuous run over the whole research window: registry returns for correlation / N_eff.
    research_run = run_backtest(df, strategy_cls(**params), window_cfg(cfg, sp.train[0], sp.test[1]))
    research_returns = research_run.returns
    # Parameter neighbourhood: each variant is run over the research window; stability is judged on
    # train+validation only, and every variant is registered as a trial (it is part of the search).
    nb, nb_runs = [], []
    tv_end = pd.Timestamp(sp.validation[1], tz="UTC")
    test_start = pd.Timestamp(sp.test[0], tz="UTC")
    for q in neighbours(strategy_cls, params):
        if cancel and cancel():
            break
        r3 = run_backtest(df, strategy_cls(**q), window_cfg(cfg, sp.train[0], sp.test[1]))
        rr = r3.returns
        tv = rr[rr.index <= tv_end]
        sh = sharpe_of(tv, cfg.periods_per_year)
        nb.append({"params": q, "sharpe": sh})
        nb_runs.append({"params": q, "returns": rr, "selection_returns": rr[rr.index >= test_start], "sharpe": sh})
    is_r = run_backtest(df, strategy_cls(**params), window_cfg(cfg, sp.train[0], sp.validation[1]))
    wf = walk_forward(df, strategy_cls, walkforward_grid or [params], cfg, cancel=cancel) if walkforward_grid is not None else None
    oos_r = test.returns
    t_stat, hac_p = hac_t_test(oos_r)
    return {
        "splits": {"train": sp.train, "validation": sp.validation, "test": sp.test},
        "train": res["train"].metrics, "validation": res["validation"].metrics, "test": test.metrics,
        "benchmark_test": test.benchmark,
        "in_sample": is_r.metrics,
        "attribution_test": test.attribution,
        "cost_stress": stress,
        "neighbours": nb,
        "neighbour_positive_frac": (sum(1 for n in nb if (n["sharpe"] or 0) > 0) / len(nb)) if nb else None,
        "psr_test": probabilistic_sharpe(oos_r),
        "dsr_test": deflated_sharpe(oos_r, max(n_trials, 1), trial_sharpe_var) if n_trials > 1 else probabilistic_sharpe(oos_r),
        "bootstrap_p_test": block_bootstrap_pvalue(oos_r),
        "hac_t_test": t_stat,
        "hac_p_test": hac_p,
        "walk_forward": wf,
        "_test_result": test,
        "_research_returns": research_returns,
        "_neighbour_runs": nb_runs,
    }


def sharpe_of(r: pd.Series, ppy: int) -> float | None:
    from .metrics import sharpe
    return sharpe(r.dropna(), ppy)
