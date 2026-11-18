"""Service container — constructs and wires every subsystem exactly once."""
from __future__ import annotations

from dataclasses import dataclass, field

from .config import Settings
from .data.instruments import INSTRUMENTS
from .data.service import DataService
from .db import Database
from .events import EventBus
from .jobs import AutonomyConfig, JobManager, Scheduler
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
    def build(cls, settings: Settings, providers: dict | None = None) -> "Services":
        db = Database(settings.db_path)
        bus = EventBus(db)
        data = DataService(db, bus, settings.snapshot_dir, settings.history_start, providers=providers,
                           timeout=settings.http_timeout_s, min_interval_s=settings.provider_min_interval_s)
        risk = RiskManager(db, bus, data)
        paper = PaperBroker(db, bus, data, risk, settings.paper_initial_cash)
        jobs = JobManager(db, bus, settings.worker_threads, settings.max_job_runtime_s)
        s = cls(settings, db, bus, data, risk, paper, jobs)
        s.registry = TrialRegistry(db)
        s.validator = Validator(db, data, s.registry)
        from .agents.orchestrator import Orchestrator
        s.orchestrator = Orchestrator(db, bus, s)
        defaults = AutonomyConfig(enabled=settings.autonomy_on_start, research_interval_minutes=settings.research_interval_minutes,
                                  data_refresh_minutes=settings.data_refresh_minutes,
                                  max_hypotheses_per_cycle=settings.max_hypotheses_per_cycle, max_cycles_per_day=settings.max_cycles_per_day)
        s.scheduler = Scheduler(db, bus, jobs, {"data_refresh": s.submit_data_refresh, "research_cycle": s.submit_research_cycle}, defaults)
        return s

    # ---------- job entry points ----------
    def submit_data_refresh(self, params: dict | None = None) -> int:
        params = params or {}

        def run(ctx, p):
            out = []
            syms = p.get("symbols") or list(INSTRUMENTS)
            for k, sym in enumerate(syms):
                ctx.check()
                ctx.progress(k / len(syms), f"refreshing {sym}")
                try:
                    out.append(self.data.refresh(sym, full=bool(p.get("full"))))
                except Exception as e:
                    out.append({"symbol": sym, "error": str(e)})
            tick = self.paper.tick() if p.get("paper_tick") else None
            return {"datasets": out, "paper_tick": tick}

        return self.jobs.submit("data_refresh", run, params)

    def submit_research_cycle(self, params: dict | None = None) -> int:
        active = self.jobs.active("research_cycle")
        if active:
            raise RuntimeError(f"A research cycle is already active (job #{active[0]['id']})")
        return self.jobs.submit("research_cycle", self.orchestrator.research_cycle, params or {})

    def shutdown(self) -> None:
        self.scheduler.stop()
        self.jobs.shutdown()
