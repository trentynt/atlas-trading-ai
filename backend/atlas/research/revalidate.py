"""Re-evaluate legacy findings under methodology v2.

For every hypothesis test recorded before v2:
  * reload the exact dataset snapshot the experiment used (no snapshot → `requires_revalidation`);
  * restrict it to the research window (before the sealed holdout);
  * re-run the robustness battery and register the hypothesis and its variants as trials;
  * after ALL legacy trials are registered, judge each one with the final family statistics
    (the most conservative ordering: every finding is judged against the full search);
  * configurations that pass every research gate get their single holdout look (forward-only for
    markets that were already researched, so they normally become `requires_confirmation`).
Manual backtests are registered as trials too, because they were part of the search.
Thresholds are never adjusted to preserve a previous result.

Run:  cd backend && ../.venv/bin/python -m atlas.research.revalidate [--user 1]
"""
from __future__ import annotations

import argparse
import logging

from ..data.instruments import get_instrument
from ..data.service import DataUnavailable
from ..db import LOCAL_USER_ID, dumps, loads, utcnow
from ..research.regime import classify
from .registry import METHODOLOGY
from .strategies.library import get_strategy
from .validation import final_disposition

log = logging.getLogger("atlas.revalidate")


def revalidate(services, user_id: int = LOCAL_USER_ID, cancel=None, progress=None) -> dict:
    db, V, reg = services.db, services.validator, services.registry
    legacy = db.query("SELECT * FROM experiments WHERE user_id=? AND kind='hypothesis_test' AND (methodology IS NULL OR methodology != ?) ORDER BY id",
                      (user_id, METHODOLOGY))
    manual = db.query("SELECT * FROM experiments WHERE user_id=? AND kind='manual_backtest' AND (methodology IS NULL OR methodology != ?) ORDER BY id",
                      (user_id, METHODOLOGY))
    summary = {"legacy_hypotheses": len(legacy), "legacy_manual_backtests": len(manual), "dispositions": {}, "missing_snapshot": [],
               "retired_paper_strategies": [], "details": []}
    evaluated = []
    for k, e in enumerate(legacy):
        if cancel and cancel():
            break
        if progress:
            progress(0.05 + 0.6 * k / max(1, len(legacy)), f"re-evaluating #{e['id']} {e['strategy']} {e['symbol']}")
        try:
            snap = services.data.load_version(e["symbol"], e["dataset_version"])
        except DataUnavailable:
            _set(db, e["id"], "requires_revalidation", ["data: The dataset snapshot this result used is no longer available, so it cannot be reproduced."], None)
            summary["missing_snapshot"].append(e["id"])
            summary["retired_paper_strategies"] += _retire(services, user_id, e["id"], "requires_revalidation")
            continue
        # Holdout is decided from the CURRENT data (sealing happens once); research uses the snapshot before it.
        research_df, hs, full = V.windows(user_id, e["symbol"])
        snap = snap[snap.index < hs]
        params = get_strategy(e["strategy"])(**loads(e["params_json"], {})).p
        inst = get_instrument(e["symbol"])
        ev = V.evaluate(user_id, e["symbol"], e["strategy"], params, research_df=snap, dataset_version=e["dataset_version"],
                        cycle_id=e["cycle_id"], regimes=classify(snap, inst.periods_per_year)["trend"], kind="hypothesis")
        db.execute("UPDATE trials SET experiment_id=? WHERE id IN (%s)" % ",".join("?" * (1 + len(ev["variant_trial_ids"]))),
                   (e["id"], ev["trial_id"], *ev["variant_trial_ids"]))
        evaluated.append((e, ev, hs, full))
    for e in manual:
        try:
            snap = services.data.load_version(e["symbol"], e["dataset_version"])
            cfg = loads(e["config_json"], {})
            from ..backtest.engine import BacktestConfig, run_backtest
            c = {k: v for k, v in cfg.items() if k in BacktestConfig.__dataclass_fields__}
            res = run_backtest(snap, get_strategy(e["strategy"])(**loads(e["params_json"], {})), BacktestConfig.from_dict(c))
            reg.register(user_id=user_id, kind="manual_backtest", symbol=e["symbol"], strategy=e["strategy"], params=loads(e["params_json"], {}),
                         dataset_version=e["dataset_version"], window=(res.equity.index[0].date().isoformat(), res.equity.index[-1].date().isoformat()),
                         returns=None, selection_returns=res.returns, sharpe=res.metrics.get("sharpe"), experiment_id=e["id"],
                         method="legacy_manual_backtest", touches_holdout=True)
        except Exception as ex:  # still counted: the attempt happened even if it can't be rebuilt
            reg.register(user_id=user_id, kind="manual_backtest", symbol=e["symbol"], strategy=e["strategy"], params=loads(e["params_json"], {}),
                         dataset_version=e["dataset_version"], window=None, returns=None, experiment_id=e["id"],
                         method=f"legacy_manual_backtest_unrebuilt: {type(ex).__name__}")
        db.execute("UPDATE experiments SET methodology=?, revalidated_at=? WHERE id=?", (METHODOLOGY, utcnow(), e["id"]))
    # Judge with the final family statistics.
    for k, (e, ev, hs, full) in enumerate(evaluated):
        if progress:
            progress(0.7 + 0.25 * k / max(1, len(evaluated)), f"judging #{e['id']}")
        verdict = V.judge(user_id, e["symbol"], ev, None)
        holdout = V.confirm(user_id, e["symbol"], e["strategy"], ev["params"], full, hs, e["id"]) if verdict["disposition"] == "pending_holdout" else None
        disp = final_disposition(verdict["disposition"], holdout)
        fam = verdict["family"]
        m = loads(e["metrics_json"], {}) or {}
        m.update({"dsr_test": fam["dsr"], "n_trials": fam["n_raw"], "n_eff": fam["n_eff"], "q_value": fam["q_value"],
                  "fdr_family_size": fam["fdr_family_size"], "hac_p_test": ev["hac_p_test"], "hac_t_test": ev["hac_t_test"],
                  "test": ev["test"], "validation": ev["validation"], "train": ev["train"], "holdout": holdout,
                  "legacy_verdict": e["verdict"], "legacy_dsr": m.get("dsr_test"), "legacy_n_trials": m.get("n_trials")})
        reasons = list(verdict["reasons"])
        if holdout and holdout.get("status") == "failed":
            reasons.append("holdout_confirmation: The single look at the sealed holdout did not confirm the result.")
        db.execute("UPDATE experiments SET metrics_json=?, config_json=? WHERE id=?",
                   (dumps(m), dumps({**loads(e["config_json"], {}), "splits": ev["splits"], "research_end": hs.date().isoformat()}), e["id"]))
        db.execute("INSERT OR REPLACE INTO experiment_artifacts(experiment_id, name, json) VALUES(?,?,?)",
                   (e["id"], "critic", dumps({"checks": verdict["checks"], "disposition": disp, "family": fam, "holdout": holdout})))
        _set(db, e["id"], disp, reasons, {"checks": verdict["checks"], "family": fam, "holdout": holdout})
        db.execute("UPDATE trials SET disposition=? WHERE id=?", (disp, ev["trial_id"]))
        summary["dispositions"][disp] = summary["dispositions"].get(disp, 0) + 1
        summary["details"].append({"experiment_id": e["id"], "symbol": e["symbol"], "strategy": e["strategy"], "legacy": e["verdict"],
                                   "now": disp, "dsr": fam["dsr"], "q": fam["q_value"], "n_raw": fam["n_raw"], "n_eff": round(fam["n_eff"], 2)})
        if disp != "survived":
            summary["retired_paper_strategies"] += _retire(services, user_id, e["id"], disp)
    for d in missing_details(summary):
        summary["dispositions"]["requires_revalidation"] = summary["dispositions"].get("requires_revalidation", 0) + 1
    services.bus.emit("research", f"Revalidation complete: {summary['dispositions']}", source="revalidation", user_id=user_id)
    return summary


def _retire(services, user_id: int, exp_id: int, disp: str) -> list[int]:
    """Paper strategies may only trade findings that currently survive validation."""
    out = []
    for sc in services.db.query("SELECT id FROM strategy_configs WHERE user_id=? AND source_experiment=? AND status='deployed'", (user_id, exp_id)):
        services.db.execute("UPDATE strategy_configs SET status='retired', notes=? WHERE id=?",
                            (f"Retired after revalidation (methodology {METHODOLOGY}): source experiment is now '{disp.replace('_', ' ')}'.", sc["id"]))
        services.bus.emit("paper", f"Paper strategy #{sc['id']} retired after revalidation: source experiment is now '{disp.replace('_', ' ')}'",
                          source="revalidation", user_id=user_id, data={"node": f"strategy:{sc['id']}"})
        out.append(sc["id"])
    return out


def missing_details(summary: dict) -> list[int]:
    return summary["missing_snapshot"]


def _set(db, eid: int, disp: str, reasons: list[str], evidence: dict | None) -> None:
    db.execute("UPDATE experiments SET disposition=?, verdict=?, methodology=?, revalidated_at=?, reasons_json=?, evidence_json=? WHERE id=?",
               (disp, "accepted" if disp == "survived" else "rejected", METHODOLOGY, utcnow(), dumps(reasons), dumps(evidence) if evidence else None, eid))


def main() -> None:
    ap = argparse.ArgumentParser(description="Re-evaluate legacy research findings under methodology v2")
    ap.add_argument("--user", type=int, default=LOCAL_USER_ID)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO)
    from ..config import get_settings
    from ..services import Services
    sv = Services.build(get_settings())
    out = revalidate(sv, a.user, progress=lambda f, m: print(f"{f:5.0%} {m}"))
    print(dumps({k: v for k, v in out.items() if k != "details"}))
    for d in out["details"]:
        print(d)


if __name__ == "__main__":
    main()
