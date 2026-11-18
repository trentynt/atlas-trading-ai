"""Research agents. Each agent is a deterministic program with a narrow responsibility, recorded
inputs/outputs, and an execution history. No LLM is required for any decision."""
from __future__ import annotations

import hashlib
import json
import random
import threading
import time
from typing import Any

import numpy as np
import pandas as pd

from ..backtest.engine import BacktestConfig, CostModel
from ..backtest.walkforward import full_evaluation, neighbours
from ..data.instruments import INSTRUMENTS, Instrument, get_instrument
from ..db import Database, dumps, loads, utcnow
from ..events import EventBus
from ..research.regime import classify, summarize
from ..research.strategies.library import REGISTRY, get_strategy


def backtest_config_for(inst: Instrument, **overrides) -> BacktestConfig:
    cfg = BacktestConfig(periods_per_year=inst.periods_per_year,
                         costs=CostModel(inst.default_spread_bps, inst.default_fee_bps, inst.default_slippage_bps))
    for k, v in overrides.items():
        setattr(cfg, k, v)
    return cfg


def _loggable(o: Any) -> Any:
    """Drop private in-memory objects (keys starting with '_', e.g. BacktestResult) and stringify unknown types."""
    if isinstance(o, dict):
        return {k: _loggable(v) for k, v in o.items() if not str(k).startswith("_")}
    if isinstance(o, (list, tuple)):
        return [_loggable(v) for v in o]
    if isinstance(o, pd.Series):
        return f"<series len={len(o)}>"
    if o is None or isinstance(o, (str, int, float, bool, np.generic)):
        return o
    return f"<{type(o).__name__}>"


def _compact(obj: Any, limit: int = 4000) -> Any:
    """Trim large outputs for the agent-run log (full results live in experiments)."""
    obj = _loggable(obj)
    s = dumps(obj)
    return obj if len(s) <= limit else {"_truncated": True, "preview": s[:limit]}


class Agent:
    name: str = "agent"
    title: str = "Agent"
    role: str = ""
    tools: list[str] = []

    def __init__(self, db: Database, bus: EventBus, services: Any):
        self.db = db
        self.bus = bus
        self.s = services
        self.status = "idle"
        self.current: dict | None = None
        self._lock = threading.Lock()

    def run(self, inputs: dict, job_id: int | None = None, ctx=None) -> dict:
        t0 = time.perf_counter()
        rid = self.db.insert("agent_runs", {"agent": self.name, "job_id": job_id, "started_at": utcnow(), "status": "running",
                                            "inputs_json": dumps(_compact(inputs, 2000))})
        with self._lock:
            self.status, self.current = "running", {"run_id": rid, "since": utcnow()}
        self.bus.emit("agent", f"{self.title} started", source=self.name, data={"node": f"agent:{self.name}", "run_id": rid, "state": "running"})
        try:
            out = self.execute(inputs, ctx)
            dt = (time.perf_counter() - t0) * 1000
            self.db.execute("UPDATE agent_runs SET status='ok', finished_at=?, outputs_json=?, duration_ms=? WHERE id=?",
                            (utcnow(), dumps(_compact(out.get("summary", out))), dt, rid))
            self.bus.emit("agent", f"{self.title} finished in {dt:.0f} ms: {out.get('headline', '')}", source=self.name,
                          data={"node": f"agent:{self.name}", "run_id": rid, "state": "ok", "ms": dt})
            return out
        except Exception as e:
            dt = (time.perf_counter() - t0) * 1000
            self.db.execute("UPDATE agent_runs SET status='error', finished_at=?, error=?, duration_ms=? WHERE id=?",
                            (utcnow(), f"{type(e).__name__}: {e}", dt, rid))
            self.bus.emit("agent", f"{self.title} error: {e}", level="error", source=self.name,
                          data={"node": f"agent:{self.name}", "run_id": rid, "state": "error"})
            raise
        finally:
            with self._lock:
                self.status, self.current = "idle", None

    def execute(self, inputs: dict, ctx) -> dict:
        raise NotImplementedError

    def describe(self) -> dict:
        last = self.db.one("SELECT * FROM agent_runs WHERE agent=? ORDER BY id DESC LIMIT 1", (self.name,))
        stats = self.db.one("SELECT COUNT(*) n, SUM(status='error') errors, AVG(duration_ms) avg_ms FROM agent_runs WHERE agent=?", (self.name,))
        if last:
            last["inputs"] = loads(last.pop("inputs_json"), None)
            last["outputs"] = loads(last.pop("outputs_json"), None)
        return {"name": self.name, "title": self.title, "role": self.role, "tools": self.tools, "status": self.status,
                "current": self.current, "last_run": last, "runs": stats["n"], "errors": stats["errors"] or 0,
                "avg_ms": stats["avg_ms"], "llm": False}


class MarketIntelligenceAgent(Agent):
    name, title = "market", "Market Intelligence Agent"
    role = "Refreshes and validates datasets, classifies regimes, measures volatility and cross-asset correlation."
    tools = ["DataService.refresh", "validation.quality_report", "regime.classify", "RiskManager.correlation_matrix"]

    def execute(self, inputs, ctx):
        symbols = inputs.get("symbols") or list(INSTRUMENTS)
        refreshed = []
        if inputs.get("refresh", True):
            for s in symbols:
                if ctx:
                    ctx.check()
                try:
                    refreshed.append(self.s.data.refresh(s))
                except Exception as e:
                    refreshed.append({"symbol": s, "error": str(e)})
        report = {}
        for s in symbols:
            df = self.s.data.load(s)
            if len(df) < 260:
                report[s] = {"available": False, "rows": len(df)}
                continue
            inst = get_instrument(s)
            reg = summarize(classify(df, inst.periods_per_year))
            c = df["close"]
            ds = self.s.data.latest_dataset(s)
            report[s] = {"available": True, "rows": len(df), "version": ds["version"] if ds else None,
                         "last": c.index[-1].date().isoformat(), "close": float(c.iloc[-1]),
                         "mom_20": float(np.log(c.iloc[-1] / c.iloc[-21])), "mom_120": float(np.log(c.iloc[-1] / c.iloc[-121])),
                         "regime": reg["current"], "missing_periods": (ds or {}).get("quality", {}).get("missing_periods")}
        corr = self.s.risk.correlation_matrix([s for s in symbols if report.get(s, {}).get("available")])
        changed = [r["symbol"] for r in refreshed if r.get("changed")]
        return {"symbols": report, "refresh": refreshed, "changed_datasets": changed,
                "correlation": {a: {b: float(v) for b, v in row.items()} for a, row in corr.to_dict().items()} if not corr.empty else {},
                "headline": f"{sum(1 for r in report.values() if r.get('available'))} datasets ready, {len(changed)} new version(s)",
                "summary": {"changed": changed, "regimes": {s: (r.get("regime") or {}).get("trend") for s, r in report.items()}}}


class StrategyDiscoveryAgent(Agent):
    name, title = "discovery", "Strategy Discovery Agent"
    role = "Generates explicit, testable hypotheses (strategy × instrument × parameters) prioritised by current regime; avoids re-testing identical hypotheses on unchanged data."
    tools = ["strategies.REGISTRY", "Strategy.grid", "experiments (dedup)", "research_queue"]

    def execute(self, inputs, ctx):
        market = inputs["market"]["symbols"]
        n_max = int(inputs.get("max_hypotheses", 12))
        uid = int(inputs.get("user_id", 1))
        seed_src = json.dumps({s: m.get("version") for s, m in market.items()}, sort_keys=True) + f"{uid}:{inputs.get('cycle_id')}"
        rng = random.Random(int(hashlib.sha256(seed_src.encode()).hexdigest()[:8], 16))
        # Never re-test a configuration already in this user's history: the research window is fixed by the
        # sealed holdout, so a repeat would only add a duplicate trial.
        tested = {(r["symbol"], r["strategy"], r["params_json"])
                  for r in self.db.query("SELECT symbol,strategy,params_json FROM experiments WHERE kind='hypothesis_test' AND user_id=?", (uid,))}
        hyps: list[dict] = []

        def add(sym, key, params, rationale, origin):
            m = market.get(sym, {})
            if not m.get("available"):
                return False
            pj = dumps(get_strategy(key).resolve_params(params))
            if (sym, key, pj) in tested or any(h["symbol"] == sym and h["strategy"] == key and h["params_json"] == pj for h in hyps):
                return False
            hyps.append({"symbol": sym, "strategy": key, "params": loads(pj), "params_json": pj, "rationale": rationale,
                         "origin": origin, "dataset_version": m["version"]})
            return True

        # 1. queued follow-ups from previous cycles take priority
        qkey = f"research_queue:{uid}"
        queue = self.db.kv_get(qkey, self.db.kv_get("research_queue", []) if uid == 1 else [])
        remaining = []
        for q in queue:
            if len(hyps) < n_max // 2 and add(q["symbol"], q["strategy"], q["params"], q["rationale"], "queue"):
                continue
            remaining.append(q)
        self.db.kv_set(qkey, remaining[:100])
        # 2. regime-aware exploration
        candidates = []
        for sym, m in market.items():
            if not m.get("available"):
                continue
            trend = (m.get("regime") or {}).get("trend")
            for key, cls in REGISTRY.items():
                fit = 1.0 if trend in cls.preferred_regimes else 0.35
                candidates.append((fit * rng.uniform(0.6, 1.0), sym, key, trend))
        candidates.sort(reverse=True)
        attempts = 0
        while len(hyps) < n_max and candidates and attempts < 400:
            attempts += 1
            _, sym, key, trend = candidates[attempts % len(candidates)]
            cls = REGISTRY[key]
            params = cls.sample(rng, 1)[0]
            fit = "matches" if trend in cls.preferred_regimes else "does not match"
            add(sym, key, params,
                f"{cls.family} hypothesis on {sym}: current regime '{trend}' {fit} the family's preferred regimes "
                f"{cls.preferred_regimes}. H1: {cls.name} with {params} earns positive risk-adjusted return out-of-sample net of costs.",
                "exploration")
        return {"hypotheses": hyps, "headline": f"{len(hyps)} hypotheses generated ({sum(h['origin']=='queue' for h in hyps)} from queue)",
                "summary": [{k: h[k] for k in ("symbol", "strategy", "params", "origin")} for h in hyps]}


class BacktestingAgent(Agent):
    name, title = "backtester", "Backtesting Agent"
    role = "Runs the event-driven engine on the research window only (train / validation / selection test), walk-forward, cost stress and parameter-neighbourhood tests, and registers every trial."
    tools = ["backtest.run_backtest", "walkforward.full_evaluation", "trial registry"]

    def execute(self, inputs, ctx):
        h = inputs["hypothesis"]
        uid = int(inputs.get("user_id", 1))
        inst = get_instrument(h["symbol"])
        research_df = inputs.get("research_df")
        if research_df is None:
            research_df, _, _ = self.s.validator.windows(uid, h["symbol"])
        regimes = classify(research_df, inst.periods_per_year)["trend"]
        ev = self.s.validator.evaluate(uid, h["symbol"], h["strategy"], h["params"], research_df=research_df,
                                       dataset_version=h.get("dataset_version"), cycle_id=inputs.get("cycle_id"), regimes=regimes,
                                       cancel=(ctx.cancelled if ctx else None))
        t = ev["test"]
        return {"evaluation": ev, "config": ev["config"],
                "headline": f"{h['strategy']} {h['symbol']}: selection-test Sharpe {_fmt(t.get('sharpe'))}, {t['num_trades']} trades, {1 + len(ev['variant_trial_ids'])} trials registered",
                "summary": {"test": {k: t.get(k) for k in ("sharpe", "total_return", "max_drawdown", "num_trades")},
                            "research_end": inputs.get("research_end"), "trials_registered": 1 + len(ev["variant_trial_ids"])}}


class RiskAnalysisAgent(Agent):
    name, title = "risk_analyst", "Risk Analysis Agent"
    role = "Quantifies tail risk, drawdown structure, cost sensitivity and regime dependence; writes explicit failure scenarios."
    tools = ["metrics.var/cvar", "cost stress", "attribution.by_regime"]

    def execute(self, inputs, ctx):
        ev = inputs["evaluation"]
        t, stress = ev["test"], ev["cost_stress"]
        res = ev["_test_result"]
        scenarios = []
        if t.get("sharpe") is not None and stress["x2"]["sharpe"] is not None:
            scenarios.append(f"Doubling spread/fees/slippage moves test Sharpe from {_fmt(t['sharpe'])} to {_fmt(stress['x2']['sharpe'])}.")
        if t.get("max_drawdown") is not None:
            scenarios.append(f"Worst test drawdown {_pct(t['max_drawdown'])}; underwater for up to {t.get('longest_drawdown_bars')} bars.")
        if t.get("cvar_95") is not None:
            scenarios.append(f"On the worst 5% of days the average loss is {_pct(t['cvar_95'])} of equity.")
        by_reg = ev["attribution_test"].get("by_regime", {})
        if by_reg:
            worst = min(by_reg.items(), key=lambda kv: kv[1]["pnl"])
            scenarios.append(f"Weakest regime at entry: '{worst[0]}' (P&L {worst[1]['pnl']:,.0f} over {worst[1]['trades']} trades).")
        worst_trades = sorted(res.trades, key=lambda x: x["pnl"])[:5]
        conc = None
        if res.trades:
            pnl = np.array([x["pnl"] for x in res.trades])
            tot = pnl[pnl > 0].sum()
            conc = float(np.sort(pnl)[::-1][:max(1, len(pnl) // 10)].sum() / tot) if tot > 0 else None
            if conc and conc > 0.6:
                scenarios.append(f"Profit concentration: top 10% of trades produce {conc:.0%} of gross profit — fragile.")
        out = {"var_95": t.get("var_95"), "cvar_95": t.get("cvar_95"), "max_drawdown": t.get("max_drawdown"),
               "longest_drawdown_bars": t.get("longest_drawdown_bars"), "exposure": t.get("exposure"),
               "cost_sensitivity": stress, "profit_concentration_top10pct": conc,
               "worst_trades": worst_trades, "failure_scenarios": scenarios}
        return {**out, "headline": f"{len(scenarios)} failure scenarios; maxDD {_pct(t.get('max_drawdown'))}",
                "summary": {k: out[k] for k in ("var_95", "cvar_95", "max_drawdown", "profit_concentration_top10pct")}}


from ..research.validation import GATES_V2 as CRITIC_RULES  # noqa: E402  (methodology v2 thresholds)


class ResearchCriticAgent(Agent):
    name, title = "critic", "Research Critic Agent"
    role = ("Adversarial reviewer. Rejects strategies that fail on data they were not designed on, could be explained by the "
            "number of ideas tried (deflated Sharpe, false-discovery control), are fragile to costs or settings, or draw down too far.")
    tools = ["deflated Sharpe ratio (effective trials)", "Benjamini–Yekutieli FDR", "Newey–West t-test", "walk-forward", "sealed holdout"]

    def execute(self, inputs, ctx):
        out = self.s.validator.judge(int(inputs.get("user_id", 1)), inputs["symbol"], inputs["evaluation"], inputs.get("risk"))
        n = len(out["checks"])
        passed = sum(c["passed"] for c in out["checks"])
        return {**out, "headline": f"{out['disposition'].replace('_', ' ')} ({passed}/{n} checks)",
                "summary": {"disposition": out["disposition"], "failed": out["failed"], "n_eff": out["family"]["n_eff"],
                            "q_value": out["family"]["q_value"]}}


class PortfolioResearchAgent(Agent):
    name, title = "portfolio", "Portfolio Research Agent"
    role = "Studies correlation between surviving strategies' out-of-sample returns and proposes risk-budgeted inverse-volatility allocations."
    tools = ["correlation of OOS returns", "inverse-volatility weighting", "diversification ratio"]

    def execute(self, inputs, ctx):
        cands = inputs["candidates"]  # [{"id", "label", "returns": pd.Series}]
        cap = float(inputs.get("max_weight", 0.25))
        if not cands:
            return {"allocations": [], "headline": "no surviving candidates", "summary": {}}
        R = pd.DataFrame({c["label"]: c["returns"] for c in cands}).fillna(0.0)
        vol = R.std().replace(0, np.nan)
        w = (1 / vol).fillna(0)
        w = w / w.sum() if w.sum() > 0 else w
        for _ in range(10):  # iterative capping
            over = w > cap
            if not over.any():
                break
            excess = (w[over] - cap).sum()
            w[over] = cap
            under = ~over
            if w[under].sum() > 0:
                w[under] += excess * w[under] / w[under].sum()
        corr = R.corr().fillna(0)
        port_vol = float(np.sqrt(w @ R.cov() @ w)) if len(R) > 2 else None
        div_ratio = float((w * vol.fillna(0)).sum() / port_vol) if port_vol else None
        allocs = [{"id": c["id"], "label": c["label"], "weight": float(w[c["label"]])} for c in cands]
        return {"allocations": allocs, "correlation": {a: {b: float(v) for b, v in row.items()} for a, row in corr.to_dict().items()},
                "diversification_ratio": div_ratio,
                "headline": f"{len(allocs)} strategies, diversification ratio {_fmt(div_ratio)}",
                "summary": {"allocations": allocs, "diversification_ratio": div_ratio}}


def _fmt(x) -> str:
    return "n/a" if x is None or (isinstance(x, float) and not np.isfinite(x)) else (f"{x:.2f}" if isinstance(x, (int, float)) else str(x))


def _pct(x) -> str:
    return "n/a" if x is None else f"{x:+.1%}"
