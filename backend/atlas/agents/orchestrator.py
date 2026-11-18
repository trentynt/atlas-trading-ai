"""Orchestrator: runs the research loop for ONE user and records every decision.

Cycle (methodology v2, see docs/STATISTICS.md):
  read markets → check pending forward confirmations → propose untested hypotheses → evaluate each on
  the research window (everything before the sealed holdout) and register every trial → judge with
  multiple-testing control → single holdout look for configurations that pass every research gate →
  re-apply false-discovery control to earlier positives → portfolio proposal → persist → report.
"""
from __future__ import annotations

import time

from ..config import code_version
from ..db import LOCAL_USER_ID, dumps, loads, utcnow
from ..research.registry import FDR_Q, METHODOLOGY
from ..research.strategies.library import get_strategy
from ..research.validation import DISPOSITION_LABEL, final_disposition
from .core import (Agent, BacktestingAgent, MarketIntelligenceAgent, PortfolioResearchAgent, ResearchCriticAgent,
                   RiskAnalysisAgent, StrategyDiscoveryAgent)
from .llm import narrate


class Orchestrator(Agent):
    name, title = "orchestrator", "Orchestrator"
    role = "Coordinates research cycles, enforces execution limits, persists experiments, writes reports, and queues follow-up work."
    tools = ["JobManager", "all agents", "trial registry", "experiments store", "research_queue"]

    def __init__(self, db, bus, services):
        super().__init__(db, bus, services)
        self.agents: dict[str, Agent] = {a.name: a for a in (
            MarketIntelligenceAgent(db, bus, services), StrategyDiscoveryAgent(db, bus, services),
            BacktestingAgent(db, bus, services), RiskAnalysisAgent(db, bus, services),
            ResearchCriticAgent(db, bus, services), PortfolioResearchAgent(db, bus, services))}

    def all_agents(self) -> list[Agent]:
        return [self, *self.agents.values()]

    def research_cycle(self, ctx, params: dict) -> dict:
        return self.run(params, job_id=ctx.job_id, ctx=ctx)

    def next_cycle_id(self, uid: int) -> int:
        key = f"cycle_counter:{uid}"
        cur = self.db.kv_get(key)
        if cur is None:
            cur = self.db.kv_get("cycle_counter", 0) if uid == LOCAL_USER_ID else 0
        self.db.kv_set(key, int(cur) + 1)
        return int(cur) + 1

    def execute(self, params, ctx):
        t0 = time.time()
        uid = int(params.get("user_id", LOCAL_USER_ID))
        cycle_id = self.next_cycle_id(uid)
        decisions: list[str] = []

        def log(m: str) -> None:
            decisions.append(m)
            self.bus.emit("research", m, source="orchestrator", user_id=uid, data={"node": "agent:orchestrator", "cycle": cycle_id})

        A = self.agents
        V = self.s.validator
        auto = self.s.scheduler.config(uid)

        ctx.progress(0.02, f"cycle {cycle_id}: reading markets")
        market = A["market"].run({"symbols": params.get("symbols"), "refresh": params.get("refresh", True)}, ctx.job_id, ctx)
        log(f"Data: {market['headline']}")

        ctx.progress(0.06, "checking pending forward confirmations")
        confirmations = self._check_pending(uid, auto.auto_deploy_paper, log)

        ctx.progress(0.1, "generating hypotheses")
        disc = A["discovery"].run({"market": market, "max_hypotheses": params.get("max_hypotheses", auto.max_hypotheses_per_cycle),
                                   "cycle_id": cycle_id, "user_id": uid}, ctx.job_id, ctx)
        hyps = disc["hypotheses"]
        log(f"Discovery: {disc['headline']}")
        if not hyps:
            log("No untested hypotheses remain for the selected markets.")

        results = []
        for k, h in enumerate(hyps):
            ctx.check()
            ctx.progress(0.1 + 0.65 * k / max(len(hyps), 1), f"testing {k + 1}/{len(hyps)}: {h['strategy']} on {h['symbol']}")
            try:
                research_df, hs, full = V.windows(uid, h["symbol"])
                bt = A["backtester"].run({"hypothesis": h, "user_id": uid, "cycle_id": cycle_id, "research_df": research_df,
                                          "research_end": hs.date().isoformat()}, ctx.job_id, ctx)
                rk = A["risk_analyst"].run({"evaluation": bt["evaluation"]}, ctx.job_id, ctx)
                results.append({"h": h, "bt": bt, "risk": rk, "hs": hs, "full": full})
            except Exception as e:  # recorded, never hidden
                log(f"Hypothesis {h['strategy']}/{h['symbol']} failed to evaluate: {type(e).__name__}: {e}")

        # Judge only after every trial of this cycle is registered, so family statistics include it.
        ctx.progress(0.8, "review with multiple-testing control")
        survived, outcomes = [], []
        for r in results:
            ev = r["bt"]["evaluation"]
            cr = A["critic"].run({"evaluation": ev, "risk": r["risk"], "user_id": uid, "symbol": r["h"]["symbol"]}, ctx.job_id, ctx)
            holdout = None
            if cr["disposition"] == "pending_holdout":
                holdout = V.confirm(uid, r["h"]["symbol"], r["h"]["strategy"], ev["params"], r["full"], r["hs"], None)
                log(f"{r['h']['strategy']} on {r['h']['symbol']} passed every research gate; sealed holdout: {holdout['status']}")
            disp = final_disposition(cr["disposition"], holdout)
            r.update(critic=cr, holdout=holdout, disposition=disp)
            r["exp_id"] = self._persist(r, cycle_id, ctx.job_id, uid)
            outcomes.append(disp)
            if disp == "survived":
                survived.append(r)
            elif cr.get("near_miss"):
                self._queue_followups(uid, r)

        demoted = self._fdr_recheck(uid, log)
        counts = {d: outcomes.count(d) for d in set(outcomes)}
        log("Review: " + (", ".join(f"{v} {DISPOSITION_LABEL[k].lower()}" for k, v in sorted(counts.items())) or "nothing evaluated"))

        ctx.progress(0.92, "portfolio research")
        cands = [{"id": r["exp_id"], "label": f"#{r['exp_id']} {r['h']['strategy']} {r['h']['symbol']}",
                  "returns": r["bt"]["evaluation"]["_test_result"].returns} for r in survived]
        port = A["portfolio"].run({"candidates": cands, "max_weight": 0.25}, ctx.job_id, ctx) if cands else {"allocations": []}
        promoted = self._promote(uid, survived, port, cycle_id) if (auto.auto_deploy_paper and params.get("auto_deploy", True) and survived) else []
        for d in promoted:
            log(f"Experiment #{d['source_experiment']} added to the paper portfolio as strategy #{d['id']} ({d['allocation']:.0%} allocation)")

        reg = self.s.registry
        fam = {sym: reg.family_stats(uid, sym) for sym in sorted({r["h"]["symbol"] for r in results})}
        ranked = sorted(results, key=lambda r: -(r["critic"]["score"] + (r["bt"]["evaluation"]["test"].get("sharpe") or -5) / 10))
        report = {
            "cycle_id": cycle_id, "user_id": uid, "methodology": METHODOLOGY, "started": params.get("trigger", "manual"),
            "duration_s": round(time.time() - t0, 1), "code_version": code_version(),
            "datasets": {s: m.get("version") for s, m in market["symbols"].items()},
            "dataset_changes": market["changed_datasets"],
            "hypotheses": len(hyps), "evaluated": len(results), "accepted": counts.get("survived", 0),
            "dispositions": counts, "confirmations": confirmations, "demoted": demoted,
            "rejection_reasons": _reason_histogram(results),
            "trial_accounting": {"registered_this_cycle": sum(1 + len(r["bt"]["evaluation"]["variant_trial_ids"]) for r in results),
                                 "families": {s: {k: round(v, 3) if isinstance(v, float) else v for k, v in f.items()} for s, f in fam.items()},
                                 "fdr_q": FDR_Q},
            "leaderboard": [{"experiment_id": r["exp_id"], "symbol": r["h"]["symbol"], "strategy": r["h"]["strategy"],
                             "params": r["h"]["params"], "disposition": r["disposition"],
                             "verdict": "accepted" if r["disposition"] == "survived" else "rejected", "score": r["critic"]["score"],
                             "test_sharpe": r["bt"]["evaluation"]["test"].get("sharpe"),
                             "test_return": r["bt"]["evaluation"]["test"].get("total_return"),
                             "dsr": r["critic"]["family"]["dsr"], "q_value": r["critic"]["family"]["q_value"],
                             "n_trials": r["critic"]["family"]["n_raw"], "n_eff": r["critic"]["family"]["n_eff"]}
                            for r in ranked[:15]],
            "portfolio": {k: v for k, v in port.items() if k in ("allocations", "diversification_ratio", "correlation")},
            "promoted": promoted, "decisions": decisions,
            "queue_length": len(self.db.kv_get(f"research_queue:{uid}", [])),
            "disclaimer": "Historical simulation. Surviving these tests is evidence under the stated assumptions, not a promise of future profit.",
        }
        narration = narrate(report)
        if narration:
            report["narration"] = narration
        rid = self.db.insert("experiments", {"created_at": utcnow(), "kind": "research_report", "status": "completed", "user_id": uid,
                                             "config_json": dumps({k: v for k, v in params.items() if k != "research_df"}),
                                             "code_version": code_version(), "methodology": METHODOLOGY,
                                             "metrics_json": dumps({k: report[k] for k in ("hypotheses", "evaluated", "accepted")}),
                                             "job_id": ctx.job_id, "cycle_id": cycle_id})
        self.db.insert("experiment_artifacts", {"experiment_id": rid, "name": "report", "json": dumps(report)})
        ctx.progress(1.0, f"cycle {cycle_id} complete: {counts.get('survived', 0)} of {len(results)} survived")
        return {"report_id": rid, "cycle_id": cycle_id, "hypotheses": len(hyps), "evaluated": len(results),
                "accepted": counts.get("survived", 0), "dispositions": counts,
                "headline": f"Cycle {cycle_id}: {counts.get('survived', 0)} of {len(results)} survived current validation",
                "summary": {"report_id": rid}}

    # ---------- persistence ----------
    def _persist(self, r, cycle_id, job_id, uid) -> int:
        h, ev, cr = r["h"], r["bt"]["evaluation"], r["critic"]
        test = ev["_test_result"]
        disp = r["disposition"]
        fam = cr["family"]
        metrics = {"train": ev["train"], "validation": ev["validation"], "test": ev["test"], "benchmark_test": ev["benchmark_test"],
                   "in_sample_sharpe": ev["in_sample"].get("sharpe"), "psr_test": ev["psr_test"], "dsr_test": fam["dsr"],
                   "n_trials": fam["n_raw"], "n_eff": fam["n_eff"], "q_value": fam["q_value"], "fdr_family_size": fam["fdr_family_size"],
                   "hac_p_test": ev["hac_p_test"], "hac_t_test": ev["hac_t_test"], "bootstrap_p_test": ev["bootstrap_p_test"],
                   "cost_stress": ev["cost_stress"], "neighbour_positive_frac": ev["neighbour_positive_frac"], "score": cr["score"],
                   "holdout": r.get("holdout"),
                   "walk_forward": {k: v for k, v in (ev.get("walk_forward") or {}).items() if k != "oos_equity"}}
        reasons = list(cr["reasons"])
        if r.get("holdout") and r["holdout"].get("status") == "failed":
            reasons.append("holdout_confirmation: The single look at the sealed holdout did not confirm the result.")
        eid = self.db.insert("experiments", {
            "created_at": utcnow(), "kind": "hypothesis_test", "status": "completed", "user_id": uid, "symbol": h["symbol"],
            "strategy": h["strategy"], "params_json": dumps(ev["params"]),
            "config_json": dumps({**ev["config"], "splits": ev["splits"], "research_end": r["hs"].date().isoformat()}),
            "dataset_version": h["dataset_version"], "code_version": code_version(), "metrics_json": dumps(metrics),
            "verdict": "accepted" if disp == "survived" else "rejected", "disposition": disp, "methodology": METHODOLOGY,
            "evidence_json": dumps({"checks": cr["checks"], "family": fam, "holdout": r.get("holdout")}),
            "reasons_json": dumps(reasons), "job_id": job_id, "cycle_id": cycle_id,
            "hypothesis_json": dumps({"rationale": h["rationale"], "origin": h["origin"]})})
        ids = [ev["trial_id"], *ev["variant_trial_ids"]]
        self.db.execute(f"UPDATE trials SET experiment_id=? WHERE id IN ({','.join('?' * len(ids))})", (eid, *ids))
        self.db.execute("UPDATE trials SET disposition=? WHERE id=?", (disp, ev["trial_id"]))
        if r.get("holdout") and not r["holdout"].get("cached") and r["holdout"].get("status") in ("passed", "failed"):
            self.db.execute("UPDATE holdout_evaluations SET experiment_id=? WHERE user_id=? AND symbol=? AND strategy=? AND params_json=? AND experiment_id IS NULL",
                            (eid, uid, h["symbol"], h["strategy"], dumps(ev["params"])))
        for name, payload in (("critic", {"checks": cr["checks"], "disposition": disp, "family": fam, "holdout": r.get("holdout")}),
                              ("risk", {k: v for k, v in r["risk"].items() if k not in ("headline", "summary")}),
                              ("test_backtest", test.to_payload(600)),
                              ("walk_forward_equity", (ev.get("walk_forward") or {}).get("oos_equity", [])),
                              ("neighbours", ev["neighbours"]), ("attribution", ev["attribution_test"])):
            self.db.insert("experiment_artifacts", {"experiment_id": eid, "name": name, "json": dumps(payload)})
        self.bus.emit("research", f"Experiment #{eid} {h['strategy']} {h['symbol']}: {DISPOSITION_LABEL[disp]}", source="orchestrator",
                      user_id=uid, data={"node": f"exp:{eid}", "verdict": disp, "strategy": h["strategy"], "symbol": h["symbol"]})
        return eid

    def _check_pending(self, uid: int, auto_deploy: bool, log) -> list[dict]:
        out = []
        V = self.s.validator
        for e in self.db.query("SELECT id, symbol, strategy, params_json, evidence_json FROM experiments WHERE user_id=? AND disposition='requires_confirmation'", (uid,)):
            _, hs, full = V.windows(uid, e["symbol"])
            res = V.confirm(uid, e["symbol"], e["strategy"], loads(e["params_json"]), full, hs, e["id"])
            if res["status"] == "pending":
                out.append({"experiment_id": e["id"], "status": "pending", "holdout_bars": res["holdout_bars"], "required_bars": res["required_bars"]})
                continue
            disp = "survived" if res["status"] == "passed" else "rejected"
            evidence = loads(e["evidence_json"], {}) or {}
            evidence["holdout"] = res
            self.db.execute("UPDATE experiments SET disposition=?, verdict=?, evidence_json=? WHERE id=?",
                            (disp, "accepted" if disp == "survived" else "rejected", dumps(evidence), e["id"]))
            self.db.execute("UPDATE trials SET disposition=? WHERE experiment_id=? AND kind='hypothesis'", (disp, e["id"]))
            log(f"Experiment #{e['id']}: forward confirmation {res['status']} on {res['holdout_bars']} unseen bars")
            out.append({"experiment_id": e["id"], "status": res["status"]})
        return out

    def _fdr_recheck(self, uid: int, log) -> list[int]:
        """As the search grows, earlier positives must still pass false-discovery control."""
        demoted = []
        fam = {r["experiment_id"]: r["q_value"] for r in self.s.registry.fdr_family(uid) if r["experiment_id"]}
        for e in self.db.query("SELECT id, reasons_json FROM experiments WHERE user_id=? AND methodology=? AND disposition IN ('survived','requires_confirmation')",
                               (uid, METHODOLOGY)):
            q = fam.get(e["id"])
            if q is not None and q > FDR_Q:
                reasons = loads(e["reasons_json"], []) + [f"fdr: No longer significant as more ideas were tested (q = {q:.3f} > {FDR_Q})."]
                self.db.execute("UPDATE experiments SET disposition='rejected', verdict='rejected', reasons_json=? WHERE id=?", (dumps(reasons), e["id"]))
                self._retire_from(uid, e["id"], "no longer significant after further research")
                demoted.append(e["id"])
                log(f"Experiment #{e['id']} demoted: no longer significant after further testing (q = {q:.3f})")
        return demoted

    def _retire_from(self, uid: int, exp_id: int, why: str) -> None:
        for sc in self.db.query("SELECT id FROM strategy_configs WHERE user_id=? AND source_experiment=? AND status!='retired'", (uid, exp_id)):
            self.db.execute("UPDATE strategy_configs SET status='retired', notes=? WHERE id=?", (f"Retired: source experiment {why}.", sc["id"]))
            self.bus.emit("paper", f"Paper strategy #{sc['id']} retired: source experiment {why}", source="orchestrator", user_id=uid,
                          data={"node": f"strategy:{sc['id']}"})

    def _enqueue(self, uid: int, item: dict) -> None:
        key = f"research_queue:{uid}"
        q = self.db.kv_get(key, [])
        if not any(x["symbol"] == item["symbol"] and x["strategy"] == item["strategy"] and x["params"] == item["params"] for x in q):
            q.append({**item, "queued_at": utcnow()})
        self.db.kv_set(key, q[-100:])

    def _queue_followups(self, uid: int, r) -> None:
        from ..backtest.walkforward import neighbours
        cls = get_strategy(r["h"]["strategy"])
        full = {**r["bt"]["evaluation"]["params"]}
        for nb in neighbours(cls, {k: v for k, v in full.items() if k in {p.name for p in cls.params}})[:2]:
            self._enqueue(uid, {"symbol": r["h"]["symbol"], "strategy": r["h"]["strategy"], "params": {**full, **nb},
                                "rationale": f"Nearby settings of near-miss experiment #{r['exp_id']}. Counted as a new trial."})

    def _promote(self, uid: int, survived, port, cycle_id) -> list[dict]:
        weights = {a["id"]: a["weight"] for a in port.get("allocations", [])}
        n_dep = self.db.one("SELECT COUNT(*) n FROM strategy_configs WHERE user_id=? AND status='deployed'", (uid,))["n"]
        out = []
        for r in sorted(survived, key=lambda r: -r["critic"]["score"]):
            if n_dep >= 5:
                break
            h = r["h"]
            pj = dumps(r["bt"]["evaluation"]["params"])
            if self.db.one("SELECT id FROM strategy_configs WHERE user_id=? AND status='deployed' AND symbol=? AND strategy=? AND params_json=?",
                           (uid, h["symbol"], h["strategy"], pj)):
                continue
            alloc = round(min(0.25, weights.get(r["exp_id"], 0.1)) * 0.8, 4)
            sid = self.db.insert("strategy_configs", {
                "created_at": utcnow(), "user_id": uid, "name": f"{get_strategy(h['strategy']).name} · {h['symbol']}", "strategy": h["strategy"],
                "symbol": h["symbol"], "params_json": pj, "status": "deployed", "allocation": alloc, "source_experiment": r["exp_id"],
                "notes": f"Added to PAPER trading in cycle {cycle_id} after surviving validation (methodology {METHODOLOGY})."})
            out.append({"id": sid, "source_experiment": r["exp_id"], "allocation": alloc})
            n_dep += 1
        return out


def _reason_histogram(results) -> dict:
    hist: dict[str, int] = {}
    for r in results:
        for name in r["critic"]["failed"]:
            hist[name] = hist.get(name, 0) + 1
        if r.get("holdout") and r["holdout"].get("status") == "failed":
            hist["holdout_confirmation"] = hist.get("holdout_confirmation", 0) + 1
    return dict(sorted(hist.items(), key=lambda kv: -kv[1]))
