"""Orchestrator: runs the autonomous research loop and records every decision.

Cycle: collect/validate data → detect dataset updates → re-validate deployed strategies on new data →
generate hypotheses → backtest → risk analysis → multiple-testing-aware critique → compare survivors →
portfolio proposal → persist experiments → report → queue follow-up experiments."""
from __future__ import annotations

import math
import time

import numpy as np

from ..backtest.metrics import deflated_sharpe
from ..backtest.walkforward import neighbours
from ..config import code_version
from ..data.instruments import get_instrument
from ..db import dumps, loads, utcnow
from ..research.strategies.library import get_strategy
from .core import (Agent, BacktestingAgent, MarketIntelligenceAgent, PortfolioResearchAgent, ResearchCriticAgent,
                   RiskAnalysisAgent, StrategyDiscoveryAgent)
from .llm import narrate


class Orchestrator(Agent):
    name, title = "orchestrator", "Orchestrator"
    role = "Coordinates research cycles, enforces execution limits, persists experiments, writes reports, and queues follow-up work."
    tools = ["JobManager", "all agents", "experiments store", "research_queue"]

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

    def execute(self, params, ctx):
        t0 = time.time()
        cycle_id = int(self.db.kv_get("cycle_counter", 0)) + 1
        self.db.kv_set("cycle_counter", cycle_id)
        decisions: list[str] = []
        log = lambda m: (decisions.append(m), self.bus.emit("research", m, source="orchestrator", data={"node": "agent:orchestrator", "cycle": cycle_id}))
        A = self.agents
        auto = self.s.scheduler.config()

        ctx.progress(0.02, f"cycle {cycle_id}: market intelligence")
        market = A["market"].run({"symbols": params.get("symbols"), "refresh": params.get("refresh", True)}, ctx.job_id, ctx)
        log(f"Data: {market['headline']}")

        # Re-validate deployed strategies whose dataset changed
        changed = set(market["changed_datasets"])
        revalidated = []
        for sc in self.db.query("SELECT * FROM strategy_configs WHERE status='deployed'"):
            if sc["symbol"] not in changed:
                continue
            ctx.check()
            h = {"symbol": sc["symbol"], "strategy": sc["strategy"], "params": loads(sc["params_json"])}
            bt = A["backtester"].run({"hypothesis": h}, ctx.job_id, ctx)
            rk = A["risk_analyst"].run({"evaluation": bt["evaluation"]}, ctx.job_id, ctx)
            cr = A["critic"].run({"evaluation": bt["evaluation"], "risk": rk}, ctx.job_id, ctx)
            revalidated.append({"id": sc["id"], "verdict": cr["verdict"]})
            if cr["verdict"] != "accepted":
                self.db.execute("UPDATE strategy_configs SET status='retired', notes=? WHERE id=?",
                                (f"Retired in cycle {cycle_id}: failed re-validation on new data: {'; '.join(cr['reasons'][:3])}", sc["id"]))
                log(f"Deployed strategy #{sc['id']} RETIRED after failing re-validation on updated {sc['symbol']} data")
            else:
                log(f"Deployed strategy #{sc['id']} re-validated on new data")

        ctx.progress(0.1, "generating hypotheses")
        disc = A["discovery"].run({"market": market, "max_hypotheses": params.get("max_hypotheses", auto.max_hypotheses_per_cycle),
                                   "cycle_id": cycle_id}, ctx.job_id, ctx)
        hyps = disc["hypotheses"]
        log(f"Discovery: {disc['headline']}")
        if not hyps:
            log("No untested hypotheses on current data versions — waiting for new data")

        # Backtest each hypothesis
        results = []
        for k, h in enumerate(hyps):
            ctx.check()
            ctx.progress(0.1 + 0.7 * k / max(len(hyps), 1), f"backtesting {k + 1}/{len(hyps)}: {h['strategy']} on {h['symbol']}")
            try:
                bt = A["backtester"].run({"hypothesis": h}, ctx.job_id, ctx)
                rk = A["risk_analyst"].run({"evaluation": bt["evaluation"]}, ctx.job_id, ctx)
                results.append({"h": h, "bt": bt, "risk": rk})
            except Exception as e:
                log(f"Hypothesis {h['strategy']}/{h['symbol']} failed to evaluate: {e}")

        # Multiple-testing correction: cumulative trials per symbol (all cycles), SR variance across trials
        ctx.progress(0.82, "critic review with multiple-testing correction")
        accepted = []
        for r in results:
            sym = r["h"]["symbol"]
            ppy = get_instrument(sym).periods_per_year
            prior = self.db.one("SELECT COUNT(*) n FROM experiments WHERE kind='hypothesis_test' AND symbol=?", (sym,))["n"]
            same = [x for x in results if x["h"]["symbol"] == sym]
            srs = [(x["bt"]["evaluation"]["in_sample"].get("sharpe") or 0) / math.sqrt(ppy) for x in same]
            hist = [loads(m["metrics_json"], {}).get("in_sample_sharpe") for m in
                    self.db.query("SELECT metrics_json FROM experiments WHERE kind='hypothesis_test' AND symbol=? ORDER BY id DESC LIMIT 300", (sym,))]
            srs += [(x or 0) / math.sqrt(ppy) for x in hist if x is not None]
            n_trials = prior + len(same)
            var = float(np.var(srs, ddof=1)) if len(srs) > 2 else 0.0
            ev = r["bt"]["evaluation"]
            ev["dsr_test"] = deflated_sharpe(ev["_test_result"].returns, max(n_trials, 2), var) if var > 0 else ev["psr_test"]
            ev["n_trials"] = n_trials
            cr = A["critic"].run({"evaluation": ev, "risk": r["risk"], "n_trials": n_trials}, ctx.job_id, ctx)
            r["critic"] = cr
            r["exp_id"] = self._persist(r, cycle_id, ctx.job_id)
            if cr["verdict"] == "accepted":
                accepted.append(r)
            elif cr["near_miss"]:
                self._queue_followups(r)

        log(f"Critic: {len(accepted)} accepted / {len(results) - len(accepted)} rejected")
        # Portfolio proposal over accepted candidates + already-deployed strategies
        ctx.progress(0.9, "portfolio research")
        cands = [{"id": r["exp_id"], "label": f"#{r['exp_id']} {r['h']['strategy']} {r['h']['symbol']}",
                  "returns": r["bt"]["evaluation"]["_test_result"].returns} for r in accepted]
        port = A["portfolio"].run({"candidates": cands, "max_weight": 0.25}, ctx.job_id, ctx) if cands else {"allocations": []}
        deployed = []
        if auto.auto_deploy_paper and params.get("auto_deploy", True) and accepted:
            deployed = self._promote(accepted, port, cycle_id)
            for d in deployed:
                log(f"Promoted experiment #{d['source_experiment']} to paper strategy #{d['id']} (allocation {d['allocation']:.0%})")

        # queue re-tests of accepted candidates on the next data version
        for r in accepted:
            self._enqueue({"symbol": r["h"]["symbol"], "strategy": r["h"]["strategy"], "params": r["h"]["params"],
                           "rationale": f"Re-test accepted candidate #{r['exp_id']} on the next dataset version (out-of-time confirmation)."})

        ranked = sorted(results, key=lambda r: -(r["critic"]["score"] + (r["bt"]["evaluation"]["test"].get("sharpe") or -5) / 10))
        report = {
            "cycle_id": cycle_id, "started": params.get("trigger", "manual"), "duration_s": round(time.time() - t0, 1),
            "code_version": code_version(),
            "datasets": {s: m.get("version") for s, m in market["symbols"].items()},
            "dataset_changes": list(changed), "revalidated": revalidated,
            "hypotheses": len(hyps), "evaluated": len(results), "accepted": len(accepted),
            "rejection_reasons": _reason_histogram(results),
            "leaderboard": [{"experiment_id": r["exp_id"], "symbol": r["h"]["symbol"], "strategy": r["h"]["strategy"],
                             "params": r["h"]["params"], "verdict": r["critic"]["verdict"], "score": r["critic"]["score"],
                             "test_sharpe": r["bt"]["evaluation"]["test"].get("sharpe"),
                             "test_return": r["bt"]["evaluation"]["test"].get("total_return"),
                             "dsr": r["bt"]["evaluation"].get("dsr_test"), "n_trials": r["bt"]["evaluation"].get("n_trials")}
                            for r in ranked[:15]],
            "portfolio": {k: v for k, v in port.items() if k in ("allocations", "diversification_ratio", "correlation")},
            "promoted": deployed, "decisions": decisions,
            "queue_length": len(self.db.kv_get("research_queue", [])),
            "disclaimer": "Historical simulation only. Passing these tests does not establish future profitability.",
        }
        narration = narrate(report)
        if narration:
            report["narration"] = narration
        rid = self.db.insert("experiments", {"created_at": utcnow(), "kind": "research_report", "status": "completed",
                                             "config_json": dumps(params), "code_version": code_version(),
                                             "metrics_json": dumps({k: report[k] for k in ("hypotheses", "evaluated", "accepted")}),
                                             "job_id": ctx.job_id, "cycle_id": cycle_id})
        self.db.insert("experiment_artifacts", {"experiment_id": rid, "name": "report", "json": dumps(report)})
        ctx.progress(1.0, f"cycle {cycle_id} complete: {len(accepted)}/{len(results)} accepted")
        return {"report_id": rid, **{k: report[k] for k in ("cycle_id", "hypotheses", "evaluated", "accepted")},
                "headline": f"Cycle {cycle_id}: {len(accepted)}/{len(results)} hypotheses survived", "summary": {"report_id": rid}}

    # ---------- persistence ----------
    def _persist(self, r, cycle_id, job_id) -> int:
        h, ev, cr = r["h"], r["bt"]["evaluation"], r["critic"]
        test = ev["_test_result"]
        metrics = {"train": ev["train"], "validation": ev["validation"], "test": ev["test"], "benchmark_test": ev["benchmark_test"],
                   "in_sample_sharpe": ev["in_sample"].get("sharpe"), "psr_test": ev["psr_test"], "dsr_test": ev.get("dsr_test"),
                   "n_trials": ev.get("n_trials"), "bootstrap_p_test": ev["bootstrap_p_test"], "cost_stress": ev["cost_stress"],
                   "neighbour_positive_frac": ev["neighbour_positive_frac"], "score": cr["score"],
                   "walk_forward": {k: v for k, v in (ev.get("walk_forward") or {}).items() if k != "oos_equity"}}
        eid = self.db.insert("experiments", {
            "created_at": utcnow(), "kind": "hypothesis_test", "status": "completed", "symbol": h["symbol"],
            "strategy": h["strategy"], "params_json": h["params_json"], "config_json": dumps({**r["bt"]["config"], "splits": ev["splits"]}),
            "dataset_version": h["dataset_version"], "code_version": code_version(), "metrics_json": dumps(metrics),
            "verdict": cr["verdict"], "reasons_json": dumps(cr["reasons"]), "job_id": job_id, "cycle_id": cycle_id,
            "hypothesis_json": dumps({"rationale": h["rationale"], "origin": h["origin"]})})
        for name, payload in (("critic", {"checks": cr["checks"], "verdict": cr["verdict"]}),
                              ("risk", {k: v for k, v in r["risk"].items() if k not in ("headline", "summary")}),
                              ("test_backtest", test.to_payload(600)),
                              ("walk_forward_equity", (ev.get("walk_forward") or {}).get("oos_equity", [])),
                              ("neighbours", ev["neighbours"]), ("attribution", ev["attribution_test"])):
            self.db.insert("experiment_artifacts", {"experiment_id": eid, "name": name, "json": dumps(payload)})
        self.bus.emit("research", f"Experiment #{eid} {h['strategy']} {h['symbol']}: {cr['verdict'].upper()}", source="orchestrator",
                      data={"node": f"exp:{eid}", "verdict": cr["verdict"], "strategy": h["strategy"], "symbol": h["symbol"]})
        return eid

    def _enqueue(self, item: dict) -> None:
        q = self.db.kv_get("research_queue", [])
        if not any(x["symbol"] == item["symbol"] and x["strategy"] == item["strategy"] and x["params"] == item["params"] for x in q):
            q.append({**item, "queued_at": utcnow()})
        self.db.kv_set("research_queue", q[-100:])

    def _queue_followups(self, r) -> None:
        cls = get_strategy(r["h"]["strategy"])
        full = {**r["h"]["params"]}
        for nb in neighbours(cls, {k: v for k, v in full.items() if k in {p.name for p in cls.params}})[:2]:
            self._enqueue({"symbol": r["h"]["symbol"], "strategy": r["h"]["strategy"], "params": {**full, **nb},
                           "rationale": f"Neighbourhood probe around near-miss experiment #{r['exp_id']} ({', '.join(r['critic']['reasons'][:1])[:120]})."})

    def _promote(self, accepted, port, cycle_id) -> list[dict]:
        weights = {a["id"]: a["weight"] for a in port.get("allocations", [])}
        max_deployed = 5
        n_dep = self.db.one("SELECT COUNT(*) n FROM strategy_configs WHERE status='deployed'")["n"]
        out = []
        for r in sorted(accepted, key=lambda r: -r["critic"]["score"]):
            if n_dep >= max_deployed:
                break
            h = r["h"]
            dup = self.db.one("SELECT id FROM strategy_configs WHERE status='deployed' AND symbol=? AND strategy=? AND params_json=?",
                              (h["symbol"], h["strategy"], h["params_json"]))
            if dup:
                continue
            alloc = round(min(0.25, weights.get(r["exp_id"], 0.1)) * 0.8, 4)
            sid = self.db.insert("strategy_configs", {
                "created_at": utcnow(), "name": f"{get_strategy(h['strategy']).name} · {h['symbol']}", "strategy": h["strategy"],
                "symbol": h["symbol"], "params_json": h["params_json"], "status": "deployed", "allocation": alloc,
                "source_experiment": r["exp_id"], "notes": f"Auto-promoted to PAPER in cycle {cycle_id} after passing all blocking critic checks."})
            out.append({"id": sid, "source_experiment": r["exp_id"], "allocation": alloc})
            n_dep += 1
        return out


def _reason_histogram(results) -> dict:
    hist: dict[str, int] = {}
    for r in results:
        for c in r["critic"]["checks"]:
            if c["blocking"] and not c["passed"]:
                hist[c["name"]] = hist.get(c["name"], 0) + 1
    return dict(sorted(hist.items(), key=lambda kv: -kv[1]))
