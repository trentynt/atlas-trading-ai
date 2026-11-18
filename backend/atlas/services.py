"""Service container — constructs and wires every subsystem exactly once."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .config import Settings
from .data.instruments import INSTRUMENTS
from .data.service import DataService
from .db import Database
from .events import EventBus
from .agents.llm import llm_status
from .db import LOCAL_USER_ID, loads
from .jobs import AutonomyConfig, JobManager, JobType, LimitError, Scheduler
from .usage import Limits, ResourceLimit
from .paper.broker import PaperBroker
from .research.registry import TrialRegistry
from .research.validation import Validator
from .risk.manager import RiskManager


@dataclass
class Services:
    settings: Settings
    db: Database
    bus: EventBus
    data: DataService
    risk: RiskManager
    paper: PaperBroker
    jobs: JobManager
    scheduler: Scheduler = field(init=False)
    registry: TrialRegistry = field(init=False)
    validator: Validator = field(init=False)
    orchestrator: object = field(init=False)

    @classmethod
    def build(cls, settings: Settings, providers: dict | None = None, autostart_jobs: bool = True) -> "Services":
        db = Database(settings.db_path)
        bus = EventBus(db)
        data = DataService(db, bus, settings.snapshot_dir, settings.history_start, providers=providers,
                           timeout=settings.http_timeout_s, min_interval_s=settings.provider_min_interval_s,
                           mode=settings.deployment_mode, cross_source_tolerance_bps=settings.cross_source_tolerance_bps,
                           intraday_history_days=settings.intraday_history_days)
        risk = RiskManager(db, bus, data)
        paper = PaperBroker(db, bus, data, risk, settings.paper_initial_cash)
        jobs = JobManager(db, bus, settings.worker_threads, settings.max_job_runtime_s,
                          max_memory_mb=settings.max_memory_mb, autostart=False)
        s = cls(settings, db, bus, data, risk, paper, jobs)
        s.registry = TrialRegistry(db)
        s.validator = Validator(db, data, s.registry)
        from .agents.orchestrator import Orchestrator
        s.orchestrator = Orchestrator(db, bus, s)
        defaults = AutonomyConfig(enabled=settings.autonomy_on_start,
                                  max_hypotheses_per_cycle=min(12, settings.max_hypotheses_per_cycle),
                                  max_cycles_per_day=min(4, settings.max_cycles_per_day),
                                  max_job_runtime_s=settings.max_job_runtime_s)
        caps = {"max_hypotheses_per_cycle": settings.max_hypotheses_per_cycle, "max_cycles_per_day": settings.max_cycles_per_day,
                "max_job_runtime_s": settings.max_job_runtime_s, "max_data_requests_per_cycle": settings.max_data_requests_per_job,
                "monthly_cpu_budget_s": settings.max_monthly_cpu_s, "monthly_llm_token_budget": settings.max_monthly_llm_tokens}
        s.scheduler = Scheduler(db, bus, jobs, {"data_refresh": s.submit_data_refresh, "research_cycle": s.submit_research_cycle},
                                defaults, caps=caps, data_refresh_minutes=settings.data_refresh_minutes)
        s._register_jobs()
        if autostart_jobs:
            jobs.start()
        return s

    # ---------- job types ----------
    def _limits(self, uid: int, params: dict) -> Limits:
        cfg = self.scheduler.config(uid if uid else LOCAL_USER_ID)
        used = self.jobs.month_usage(uid) if uid else {"cpu_s": 0, "llm_tokens": 0}
        return Limits(max_runtime_s=min(cfg.max_job_runtime_s, self.settings.max_job_runtime_s),
                      max_cpu_s=max(0.0, cfg.monthly_cpu_budget_s - used["cpu_s"]) if uid else None,
                      max_data_requests=min(cfg.max_data_requests_per_cycle, self.settings.max_data_requests_per_job),
                      max_llm_tokens=max(0, cfg.monthly_llm_token_budget - used["llm_tokens"]) if uid else None,
                      max_memory_mb=self.settings.max_memory_mb)

    def _budget_preflight(self, uid: int, params: dict, estimate: dict) -> str | None:
        if not uid:
            return None
        cfg = self.scheduler.config(uid)
        used = self.jobs.month_usage(uid)
        need = estimate.get("cpu_s", 0)
        if used["cpu_s"] >= cfg.monthly_cpu_budget_s:
            return f"monthly compute budget used ({used['cpu_s']:.0f} of {cfg.monthly_cpu_budget_s} CPU-seconds)"
        if used["cpu_s"] + need > cfg.monthly_cpu_budget_s:
            return (f"estimated {need:.0f} CPU-seconds would exceed the remaining monthly budget "
                    f"({cfg.monthly_cpu_budget_s - used['cpu_s']:.0f} CPU-seconds left)")
        return None

    def estimate_research(self, uid: int, params: dict) -> dict:
        cfg = self.scheduler.config(uid or LOCAL_USER_ID)
        n = int(params.get("max_hypotheses") or cfg.max_hypotheses_per_cycle)
        rates = []
        for r in self.db.query("SELECT usage_json, result_json FROM jobs WHERE type='research_cycle' AND status='completed' "
                               "AND usage_json IS NOT NULL ORDER BY id DESC LIMIT 10"):
            u, res = loads(r["usage_json"], {}), loads(r["result_json"], {}) or {}
            if res.get("evaluated"):
                rates.append(u.get("cpu_s", 0) / res["evaluated"])
        per = float(np.median(rates)) if rates else 4.0
        syms = params.get("symbols") or list(INSTRUMENTS)
        return {"hypotheses": n, "cpu_s": round(per * n + 2.0, 1), "cpu_s_per_hypothesis": round(per, 2),
                "data_requests": (2 * len(syms)) if params.get("refresh", True) else 0,
                "llm_tokens": 8000 if llm_status()["enabled"] else 0,
                "basis": f"median of {len(rates)} measured cycle(s)" if rates else "default assumption (no measured cycles yet)"}

    def _register_jobs(self) -> None:
        self.jobs.register(JobType("data_refresh", self._run_data_refresh, max_attempts=3, backoff_s=30, lane="data",
                                   estimate=lambda u, p: {"data_requests": 2 * len(p.get("symbols") or INSTRUMENTS),
                                                          "basis": "about two requests per market (incremental)"},
                                   limits=self._limits))
        self.jobs.register(JobType("research_cycle", self.orchestrator.research_cycle, max_attempts=2, backoff_s=60,
                                   lane="research", estimate=self.estimate_research, limits=self._limits,
                                   preflight=self._budget_preflight))
        self.jobs.register(JobType("revalidation", self._run_revalidation, max_attempts=1, lane="research",
                                   limits=self._limits, preflight=self._budget_preflight))

    def _run_data_refresh(self, ctx, p):
        out = []
        syms = p.get("symbols") or list(INSTRUMENTS)
        for k, sym in enumerate(syms):
            ctx.check()
            ctx.progress(k / len(syms), f"refreshing {sym}")
            try:
                out.append(self.data.refresh(sym, full=bool(p.get("full"))))
            except ResourceLimit:
                raise
            except Exception as e:
                out.append({"symbol": sym, "error": str(e)})
        tick = self.paper.tick() if p.get("paper_tick") else None
        if out and all("error" in o for o in out):
            raise RuntimeError("every market failed to refresh: " + "; ".join(o["error"][:120] for o in out))
        return {"datasets": out, "paper_tick": tick}

    def _run_revalidation(self, ctx, p):
        from .research.revalidate import revalidate
        return revalidate(self, ctx.user_id, ctx.cancelled, ctx.progress)

    # ---------- job entry points ----------
    def submit_data_refresh(self, params: dict | None = None, *, user_id: int = 0, trigger: str = "manual") -> int:
        return self.jobs.submit("data_refresh", params or {}, user_id=user_id, trigger=trigger)

    def submit_research_cycle(self, params: dict | None = None, *, user_id: int = LOCAL_USER_ID,
                              idempotency_key: str | None = None, trigger: str = "manual") -> int:
        params = {**(params or {}), "user_id": user_id}
        if not idempotency_key:
            active = self.jobs.active("research_cycle", user_id=user_id)
            if active:
                raise LimitError(f"A research cycle is already active (job #{active[0]['id']})")
        cfg = self.scheduler.config(user_id)
        if self.scheduler.cycles_today(user_id) >= cfg.max_cycles_per_day:
            raise LimitError(f"Daily research-cycle limit reached ({cfg.max_cycles_per_day}). Raise it in Research settings or try tomorrow.")
        if params.get("max_hypotheses") and int(params["max_hypotheses"]) > cfg.max_hypotheses_per_cycle:
            raise LimitError(f"At most {cfg.max_hypotheses_per_cycle} hypotheses per cycle (your limit).")
        return self.jobs.submit("research_cycle", params, user_id=user_id, idempotency_key=idempotency_key, trigger=trigger)

    def submit_revalidation(self, user_id: int) -> int:
        return self.jobs.submit("revalidation", {"user_id": user_id}, user_id=user_id)

    def shutdown(self) -> None:
        self.scheduler.stop()
        self.jobs.shutdown()
