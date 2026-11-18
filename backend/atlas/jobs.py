"""Persistent job queue with cooperative cancellation, runtime limits, crash recovery, and an
autonomy scheduler that runs while the host process is alive (it cannot run while a Codespace is
stopped or suspended)."""
from __future__ import annotations

import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable

from pydantic import BaseModel, Field

from .db import Database, dumps, loads, utcnow
from .events import EventBus


class Cancelled(Exception):
    pass


class JobContext:
    def __init__(self, manager: "JobManager", job_id: int, max_runtime_s: float):
        self.m = manager
        self.job_id = job_id
        self.started = time.monotonic()
        self.max_runtime_s = max_runtime_s
        self.cancel_event = threading.Event()

    def cancelled(self) -> bool:
        return self.cancel_event.is_set() or (time.monotonic() - self.started) > self.max_runtime_s

    def check(self) -> None:
        if self.cancel_event.is_set():
            raise Cancelled("cancelled by user")
        if (time.monotonic() - self.started) > self.max_runtime_s:
            raise Cancelled(f"exceeded max runtime {self.max_runtime_s:.0f}s")

    def progress(self, frac: float, message: str = "") -> None:
        self.m.db.execute("UPDATE jobs SET progress=?, message=? WHERE id=?", (round(min(max(frac, 0), 1), 4), message, self.job_id))
        self.m.bus.emit("job", f"Job #{self.job_id}: {message}", source="jobs",
                        data={"job_id": self.job_id, "progress": frac, "node": f"job:{self.job_id}"})


class JobManager:
    def __init__(self, db: Database, bus: EventBus, workers: int = 2, max_runtime_s: float = 900):
        self.db = db
        self.bus = bus
        self.max_runtime_s = max_runtime_s
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="atlas-job")
        self._ctx: dict[int, JobContext] = {}
        self._lock = threading.Lock()
        self.recover()

    def recover(self) -> None:
        """Jobs that were queued/running when the process died are marked interrupted."""
        rows = self.db.query("SELECT id FROM jobs WHERE status IN ('queued','running')")
        for r in rows:
            self.db.execute("UPDATE jobs SET status='interrupted', finished_at=?, error='process restarted while job active' WHERE id=?",
                            (utcnow(), r["id"]))
        if rows:
            self.bus.emit("job", f"Recovered {len(rows)} interrupted job(s) from previous run", level="warn", source="jobs")

    def submit(self, job_type: str, fn: Callable[[JobContext, dict], Any], params: dict | None = None,
               max_runtime_s: float | None = None) -> int:
        params = params or {}
        jid = self.db.insert("jobs", {"type": job_type, "status": "queued", "created_at": utcnow(), "params_json": dumps(params)})
        ctx = JobContext(self, jid, max_runtime_s or self.max_runtime_s)
        with self._lock:
            self._ctx[jid] = ctx
        self.bus.emit("job", f"Queued {job_type} job #{jid}", source="jobs", data={"job_id": jid, "type": job_type, "node": f"job:{jid}"})
        self.pool.submit(self._run, jid, fn, ctx, params, job_type)
        return jid

    def _run(self, jid: int, fn, ctx: JobContext, params: dict, job_type: str) -> None:
        if ctx.cancel_event.is_set():
            self.db.execute("UPDATE jobs SET status='cancelled', finished_at=? WHERE id=?", (utcnow(), jid))
            return
        ctx.started = time.monotonic()
        self.db.execute("UPDATE jobs SET status='running', started_at=? WHERE id=?", (utcnow(), jid))
        self.bus.emit("job", f"Started {job_type} job #{jid}", source="jobs", data={"job_id": jid, "node": f"job:{jid}"})
        try:
            result = fn(ctx, params)
            self.db.execute("UPDATE jobs SET status='completed', finished_at=?, progress=1, result_json=? WHERE id=?",
                            (utcnow(), dumps(result), jid))
            self.bus.emit("job", f"Completed {job_type} job #{jid}", source="jobs", data={"job_id": jid, "node": f"job:{jid}"})
        except Cancelled as e:
            self.db.execute("UPDATE jobs SET status='cancelled', finished_at=?, error=? WHERE id=?", (utcnow(), str(e), jid))
            self.bus.emit("job", f"Job #{jid} cancelled: {e}", level="warn", source="jobs", data={"job_id": jid})
        except Exception as e:
            self.db.execute("UPDATE jobs SET status='failed', finished_at=?, error=? WHERE id=?",
                            (utcnow(), f"{type(e).__name__}: {e}\n{traceback.format_exc()[-2000:]}", jid))
            self.bus.emit("job", f"Job #{jid} failed: {type(e).__name__}: {e}", level="error", source="jobs", data={"job_id": jid})
        finally:
            with self._lock:
                self._ctx.pop(jid, None)

    def cancel(self, jid: int) -> bool:
        with self._lock:
            ctx = self._ctx.get(jid)
        if not ctx:
            return False
        ctx.cancel_event.set()
        self.bus.emit("job", f"Cancellation requested for job #{jid}", level="warn", source="jobs", data={"job_id": jid})
        return True

    def active(self, job_type: str | None = None) -> list[dict]:
        q = "SELECT id,type,status FROM jobs WHERE status IN ('queued','running')"
        return [r for r in self.db.query(q) if job_type is None or r["type"] == job_type]

    def list(self, limit: int = 50) -> list[dict]:
        rows = self.db.query("SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["params"] = loads(r.pop("params_json"), {})
            r["result"] = loads(r.pop("result_json"), None)
        return rows

    def shutdown(self) -> None:
        with self._lock:
            for c in self._ctx.values():
                c.cancel_event.set()
        self.pool.shutdown(wait=False, cancel_futures=True)


class AutonomyConfig(BaseModel):
    enabled: bool = False
    research_interval_minutes: int = Field(60, ge=5, le=1440)
    data_refresh_minutes: int = Field(30, ge=5, le=1440)
    max_hypotheses_per_cycle: int = Field(12, ge=1, le=100)
    max_cycles_per_day: int = Field(24, ge=1, le=288)
    paper_tick_after_refresh: bool = True
    auto_deploy_paper: bool = True  # promote critic-approved strategies to the PAPER portfolio


class Scheduler:
    """Wakes every few seconds; enqueues data refreshes and research cycles according to config."""

    def __init__(self, db: Database, bus: EventBus, jobs: JobManager, actions: dict[str, Callable], defaults: AutonomyConfig):
        self.db = db
        self.bus = bus
        self.jobs = jobs
        self.actions = actions
        self.defaults = defaults
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def config(self) -> AutonomyConfig:
        return AutonomyConfig(**{**self.defaults.model_dump(), **self.db.kv_get("autonomy", {})})

    def update(self, patch: dict) -> AutonomyConfig:
        cfg = AutonomyConfig(**{**self.config().model_dump(), **patch})
        self.db.kv_set("autonomy", cfg.model_dump())
        self.bus.emit("system", f"Autonomy config updated: {patch}", source="scheduler", data={"node": "orchestrator"})
        return cfg

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="atlas-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _last(self, job_type: str) -> datetime | None:
        r = self.db.one("SELECT created_at FROM jobs WHERE type=? ORDER BY id DESC LIMIT 1", (job_type,))
        return datetime.fromisoformat(r["created_at"]) if r else None

    def status(self) -> dict:
        cfg = self.config()
        now = datetime.now(timezone.utc)
        out = {"config": cfg.model_dump(), "running": bool(self._thread and self._thread.is_alive())}
        for jt, mins in (("data_refresh", cfg.data_refresh_minutes), ("research_cycle", cfg.research_interval_minutes)):
            last = self._last(jt)
            out[jt] = {"last": last.isoformat() if last else None,
                       "next_in_s": max(0, mins * 60 - (now - last).total_seconds()) if last and cfg.enabled else (0 if cfg.enabled else None)}
        day = now.date().isoformat()
        out["cycles_today"] = self.db.one("SELECT COUNT(*) n FROM jobs WHERE type='research_cycle' AND created_at >= ?", (day,))["n"]
        out["note"] = "Runs only while this backend process is alive. A stopped or suspended Codespace pauses all autonomy."
        return out

    def _loop(self) -> None:
        while not self._stop.wait(10):
            try:
                self.tick()
            except Exception as e:  # never let the scheduler die
                self.bus.emit("system", f"Scheduler error: {e}", level="error", source="scheduler")

    def tick(self) -> None:
        cfg = self.config()
        if not cfg.enabled:
            return
        now = datetime.now(timezone.utc)
        last = self._last("data_refresh")
        if (not last or (now - last).total_seconds() >= cfg.data_refresh_minutes * 60) and not self.jobs.active("data_refresh"):
            self.actions["data_refresh"]({"paper_tick": cfg.paper_tick_after_refresh})
        last = self._last("research_cycle")
        if (not last or (now - last).total_seconds() >= cfg.research_interval_minutes * 60) and not self.jobs.active("research_cycle"):
            day = now.date().isoformat()
            n = self.db.one("SELECT COUNT(*) n FROM jobs WHERE type='research_cycle' AND created_at >= ?", (day,))["n"]
            if n < cfg.max_cycles_per_day:
                self.actions["research_cycle"]({"max_hypotheses": cfg.max_hypotheses_per_cycle, "trigger": "schedule"})
            else:
                self.bus.emit("system", f"Daily research-cycle limit reached ({n}/{cfg.max_cycles_per_day})", level="warn", source="scheduler")
