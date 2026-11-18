"""Validation methodology v2 — one implementation used by research cycles, revalidation and the API.

Pipeline for one hypothesis (user, symbol, strategy, params):
  1. Research window = all data before the SEALED HOLDOUT (registry.holdout_start). Nothing in the
     selection process can read holdout data.
  2. Robustness battery on the research window (train / validation / selection test, walk-forward,
     cost stress, parameter neighbourhood).
  3. Register the hypothesis and every parameter variant in the permanent trial registry.
  4. Gates, including the Deflated Sharpe Ratio with an effective trial count and a
     Benjamini–Yekutieli false-discovery test across the user's whole research history.
  5. If every research gate passes, a single look at the sealed holdout (forward data for markets
     that were already researched) with a Bonferroni-corrected significance test.

Dispositions: survived · rejected · insufficient_evidence · requires_confirmation · requires_revalidation
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from ..backtest.engine import BacktestConfig, run_backtest
from ..backtest.metrics import deflated_sharpe, expected_max_sharpe, probabilistic_sharpe
from ..backtest.walkforward import full_evaluation, neighbours, window_cfg
from ..data.instruments import get_instrument
from .integrity import hac_t_test
from .registry import FDR_Q, MIN_HOLDOUT_BARS, TrialRegistry, bonferroni_alpha
from .strategies.library import get_strategy

GATES_V2 = {
    "min_test_trades": 15,          # selection-test trades
    "min_test_sharpe": 0.30,        # economic floor (annualised)
    "min_validation_sharpe": 0.0,
    "min_oos_is_ratio": 0.25,
    "min_dsr": 0.95,                # P(true SR > expected max SR of N_eff unskilled trials)
    "fdr_q": FDR_Q,                 # Benjamini–Yekutieli q-value across the user's research family
    "max_test_drawdown": -0.35,
    "min_neighbour_positive": 0.5,
    "min_wf_positive_frac": 0.5,
    "holdout_alpha": 0.05,          # family-wise, Bonferroni-split across holdout looks per symbol
    "min_holdout_trades": 5,
}

DISPOSITION_LABEL = {
    "survived": "Survived current validation",
    "rejected": "Rejected during testing",
    "insufficient_evidence": "Insufficient evidence",
    "requires_confirmation": "Requires out-of-sample confirmation",
    "requires_revalidation": "Requires revalidation",
}


class Validator:
    def __init__(self, db, data, registry: TrialRegistry):
        self.db = db
        self.data = data
        self.reg = registry

    # ---------- windows ----------
    def windows(self, user_id: int, symbol: str, df: pd.DataFrame | None = None) -> tuple[pd.DataFrame, pd.Timestamp, pd.DataFrame]:
        full = self.data.load(symbol) if df is None else df
        hs = self.reg.holdout_start(user_id, symbol, full.index)
        return full[full.index < hs], hs, full

    # ---------- evaluation + registration ----------
    def evaluate(self, user_id: int, symbol: str, strategy: str, params: dict, *, research_df: pd.DataFrame,
                 dataset_version: str | None, cycle_id: int | None = None, regimes: pd.Series | None = None,
                 cancel=None, kind: str = "hypothesis") -> dict:
        inst = get_instrument(symbol)
        from ..agents.core import backtest_config_for
        cfg = backtest_config_for(inst)
        cls = get_strategy(strategy)
        params = cls(**params).p
        grid = [params] + neighbours(cls, params)[:6]
        ev = full_evaluation(research_df, cls, params, cfg, regimes=regimes, walkforward_grid=grid, cancel=cancel)
        sp = ev["splits"]
        window = (sp["train"][0], sp["test"][1])
        hkey = f"{symbol}|{strategy}|{sorted(params.items())}"
        ev["trial_id"] = self.reg.register(
            user_id=user_id, kind=kind, symbol=symbol, strategy=strategy, params=params, dataset_version=dataset_version,
            window=window, returns=ev["_research_returns"], selection_returns=ev["_test_result"].returns,
            p_value=ev["hac_p_test"], sharpe=ev["test"].get("sharpe"), cycle_id=cycle_id, hypothesis_key=hkey,
            family=cls.family, method="research_window_v2")
        ev["variant_trial_ids"] = [self.reg.register(
            user_id=user_id, kind="variant", symbol=symbol, strategy=strategy, params=nb["params"], dataset_version=dataset_version,
            window=window, returns=nb["returns"], selection_returns=nb["selection_returns"], sharpe=nb["sharpe"], cycle_id=cycle_id,
            hypothesis_key=hkey, family=cls.family, method="neighbour_variant_v2") for nb in ev["_neighbour_runs"]]
        ev["config"] = cfg.to_dict()
        ev["params"] = params
        return ev

    # ---------- gates ----------
    def judge(self, user_id: int, symbol: str, ev: dict, risk: dict | None = None) -> dict:
        R = GATES_V2
        fam = self.reg.family_stats(user_id, symbol)
        ppy = get_instrument(symbol).periods_per_year
        test_r = ev["_test_result"].returns
        sr0 = expected_max_sharpe(max(2, int(round(fam["n_eff"]))), fam["sr_var"]) if fam["sr_var"] > 0 else 0.0
        dsr = deflated_sharpe(test_r, max(2, int(round(fam["n_eff"]))), fam["sr_var"]) if fam["sr_var"] > 0 else probabilistic_sharpe(test_r)
        q, fam_size = self.reg.q_value(user_id, ev["trial_id"])
        t, v, i = ev["test"], ev["validation"], ev["in_sample"]
        wf = ev.get("walk_forward") or {}
        checks: list[dict] = []

        def chk(name, value, ok, threshold, blocking, why):
            checks.append({"name": name, "value": value, "passed": bool(ok), "threshold": threshold, "blocking": blocking, "explanation": why})

        ts, vs, iss = t.get("sharpe"), v.get("sharpe"), i.get("sharpe")
        chk("sample_size", t["num_trades"], t["num_trades"] >= R["min_test_trades"], f">= {R['min_test_trades']} trades in the selection test", True,
            "Too few trades to tell skill from noise.")
        chk("oos_sharpe", ts, ts is not None and ts >= R["min_test_sharpe"], f">= {R['min_test_sharpe']}", True,
            "Risk-adjusted return in the selection test, after costs.")
        chk("validation_sharpe", vs, vs is not None and vs > R["min_validation_sharpe"], "> 0", True,
            "The validation period between design and selection test must also be positive.")
        ratio = (ts / iss) if (ts is not None and iss and iss > 0) else None
        chk("is_oos_decay", ratio, iss is None or iss <= 0 or (ratio is not None and ratio >= R["min_oos_is_ratio"]),
            f"selection/design Sharpe >= {R['min_oos_is_ratio']}", True, "Large decay from design to selection data indicates overfitting.")
        chk("deflated_sharpe", dsr, (dsr or 0) >= R["min_dsr"], f">= {R['min_dsr']} (expected best of {fam['n_eff']:.1f} unskilled trials: SR {sr0 * math.sqrt(ppy):.2f}/yr)", True,
            f"Probability the selection-test Sharpe beats the best result expected by luck among {fam['n_eff']:.1f} effective trials ({fam['n_raw']} recorded attempts on {symbol}).")
        chk("fdr", q, q is not None and q <= R["fdr_q"], f"Benjamini–Yekutieli q <= {R['fdr_q']} across {fam_size} hypotheses", True,
            "False-discovery control across every hypothesis you have tested, valid under any correlation between them.")
        s2 = ev["cost_stress"]["x2"]["sharpe"]
        chk("cost_robustness", s2, s2 is not None and s2 > 0, "Sharpe > 0 at 2× costs", True, "The edge must survive doubled trading costs.")
        nb = ev.get("neighbour_positive_frac")
        chk("parameter_stability", nb, nb is None or nb >= R["min_neighbour_positive"], f">= {R['min_neighbour_positive']:.0%} of nearby settings positive", True,
            "Nearby settings should also work; isolated peaks are overfit.")
        mdd = t.get("max_drawdown")
        chk("drawdown", mdd, mdd is not None and mdd >= R["max_test_drawdown"], f">= {R['max_test_drawdown']:.0%}", True, "Selection-test drawdown limit.")
        if wf.get("folds"):
            frac = wf["positive_oos_folds"] / len(wf["folds"])
            chk("walk_forward", frac, frac >= R["min_wf_positive_frac"] and (wf.get("mean_oos_sharpe") or 0) > 0,
                f">= {R['min_wf_positive_frac']:.0%} positive folds, mean Sharpe > 0", True, "Re-tuned period by period, it must hold up over time.")
        bs = ev["benchmark_test"].get("sharpe")
        chk("beats_benchmark", ts, ts is not None and (bs is None or ts > bs), f"> buy-and-hold Sharpe ({bs if bs is None else round(bs, 2)})", False,
            "Advisory: compare with simply holding the instrument.")
        if risk and (risk.get("profit_concentration_top10pct") or 0) > 0.6:
            chk("profit_concentration", risk["profit_concentration_top10pct"], False, "<= 60%", False, "Advisory: returns depend on a few trades.")
        failed = [c for c in checks if c["blocking"] and not c["passed"]]
        if not failed:
            disposition = "pending_holdout"
        elif {c["name"] for c in failed} <= {"sample_size"}:
            disposition = "insufficient_evidence"
        else:
            disposition = "rejected"
        return {"disposition": disposition, "checks": checks, "failed": [c["name"] for c in failed],
                "reasons": [f"{c['name']}: {c['explanation']} (value {_fmt(c['value'])}, need {c['threshold']})" for c in failed],
                "family": {**fam, "fdr_family_size": fam_size, "q_value": q, "dsr": dsr, "expected_max_sr_annual": sr0 * math.sqrt(ppy)},
                "score": sum(c["passed"] for c in checks) / len(checks),
                "near_miss": disposition != "pending_holdout" and len(failed) <= 2 and (ts or 0) > 0}

    # ---------- sealed holdout ----------
    def confirm(self, user_id: int, symbol: str, strategy: str, params: dict, full_df: pd.DataFrame, holdout_start: pd.Timestamp,
                experiment_id: int | None) -> dict:
        """Single permitted look at the sealed holdout. Returns status: pending | passed | failed."""
        inst = get_instrument(symbol)
        hs = holdout_start.date().isoformat()
        prior = self.reg.holdout_result(user_id, symbol, strategy, params, hs)
        if prior:
            return {**prior["metrics"], "cached": True}
        hold = full_df[full_df.index >= holdout_start]
        need = MIN_HOLDOUT_BARS[inst.asset_class]
        if len(hold) < need:
            return {"status": "pending", "holdout_bars": int(len(hold)), "required_bars": need, "holdout_start": hs}
        from ..agents.core import backtest_config_for
        cfg = backtest_config_for(inst)
        res = run_backtest(full_df, get_strategy(strategy)(**params), window_cfg(cfg, hs, full_df.index[-1].date().isoformat()))
        t, p = hac_t_test(res.returns)
        k = self.reg.holdout_accesses(user_id, symbol) + 1
        alpha = bonferroni_alpha(GATES_V2["holdout_alpha"], k)
        m = res.metrics
        ok = (m["num_trades"] >= GATES_V2["min_holdout_trades"] and (m.get("sharpe") or -1) > 0 and p is not None and p <= alpha
              and (m.get("max_drawdown") or -1) >= GATES_V2["max_test_drawdown"])
        out = {"status": "passed" if ok else "failed", "holdout_start": hs, "holdout_end": full_df.index[-1].date().isoformat(),
               "holdout_bars": int(len(hold)), "trades": m["num_trades"], "sharpe": m.get("sharpe"), "total_return": m.get("total_return"),
               "max_drawdown": m.get("max_drawdown"), "hac_t": t, "hac_p": p, "alpha": alpha, "look_number": k}
        self.reg.record_holdout(user_id=user_id, symbol=symbol, strategy=strategy, params=params, holdout_start=hs,
                                holdout_end=out["holdout_end"], metrics=out, experiment_id=experiment_id)
        return out


def final_disposition(judge_disp: str, holdout: dict | None) -> str:
    if judge_disp != "pending_holdout":
        return judge_disp
    if not holdout or holdout.get("status") == "pending":
        return "requires_confirmation"
    return "survived" if holdout["status"] == "passed" else "rejected"


def _fmt(x) -> str:
    if x is None:
        return "n/a"
    if isinstance(x, (int, float, np.floating)):
        return f"{float(x):.3g}"
    return str(x)
