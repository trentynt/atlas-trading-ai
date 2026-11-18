"""Durable job queue, worker and per-user research scheduler.

The queue lives in SQLite, not in memory: queued jobs survive a restart, a job that was running when
the process died is retried (or marked interrupted once attempts are exhausted), and every job records
estimated and measured resource use. Work runs in the backend process, independent of any browser tab.
It cannot run while the host (e.g. a Codespace) is stopped or suspended — scheduled runs missed during
that time collapse into a single run when the host is back, never a backlog.

Job lifecycle:  queued → running → completed | failed | cancelled | limited | skipped | interrupted
                failed/interrupted with attempts left → queued again after a backoff (retry)
"""
from __future__ import annotations

import socket
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator

from .db import Database, dumps, loads, utcnow
from .events import EventBus
from .usage import Limits, Meter, ResourceLimit

TERMINAL = ("completed", "failed", "cancelled", "limited", "skipped", "interrupted")


class Cancelled(Exception):
    pass


class LimitError(RuntimeError):
    """A request was refused because a configured limit would be exceeded (HTTP 429)."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat(timespec="milliseconds")


class JobContext:
    def __init__(self, manager: "JobManager", job_id: int, user_id: int, meter: Meter):
        self.m = manager
        self.job_id = job_id
        self.user_id = user_id
        self.meter = meter
        self.cancel_event = threading.Event()
        self._last_db_check = 0.0

    def _cancel_flag(self) -> bool:
        if self.cancel_event.is_set():
            return True
        if time.monotonic() - self._last_db_check > 2:  # cancellation requested from another process
            self._last_db_check = time.monotonic()
            r = self.m.db.one("SELECT cancel_requested FROM jobs WHERE id=?", (self.job_id,))
            if r and r["cancel_requested"]:
                self.cancel_event.set()
        return self.cancel_event.is_set()

    def cancelled(self) -> bool:
        try:
            self.meter.check()
        except ResourceLimit:
            return True
        return self._cancel_flag()

    def check(self) -> None:
        if self._cancel_flag():
            raise Cancelled("cancelled by user")
        self.meter.check()

    def progress(self, frac: float, message: str = "") -> None:
        self.m.db.execute("UPDATE jobs SET progress=?, message=?, heartbeat_at=? WHERE id=?",
                          (round(min(max(frac, 0), 1), 4), message, utcnow(), self.job_id))
        self.m.bus.emit("job", f"Job #{self.job_id}: {message}", source="jobs", user_id=self.user_id,
                        data={"job_id": self.job_id, "progress": frac, "node": f"job:{self.job_id}"})


@dataclass
class JobType:
    name: str
    handler: Callable[[JobContext, dict], Any]
    max_attempts: int = 1
    backoff_s: float = 30.0
    lane: str = "default"  # at most one running job per (user, lane)
    estimate: Callable[[int, dict], dict] | None = None
    limits: Callable[[int, dict], Limits] | None = None
    preflight: Callable[[int, dict, dict], str | None] | None = None  # returns a reason to skip


class JobManager:
    def __init__(self, db: Database, bus: EventBus, workers: int = 2, max_runtime_s: float = 900,
                 max_memory_mb: float | None = None, poll_s: float = 0.25, autostart: bool = True,
                 heartbeat_timeout_s: float = 120.0):
        self.db = db
        self.bus = bus
        self.workers = workers
        self.max_runtime_s = max_runtime_s
        self.max_memory_mb = max_memory_mb
        self.poll_s = poll_s
        self.heartbeat_timeout_s = heartbeat_timeout_s
        self.worker_id = f"{socket.gethostname()}:{id(self):x}"
        self.types: dict[str, JobType] = {}
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="atlas-job")
        self._ctx: dict[int, JobContext] = {}
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.recover()
        if autostart:
            self.start()

    # ---------- registration & submission ----------
    def register(self, jt: JobType) -> None:
        self.types[jt.name] = jt

    def submit(self, job_type: str, params: dict | None = None, *, user_id: int = 1, idempotency_key: str | None = None,
               trigger: str = "manual", delay_s: float = 0) -> int:
        if job_type not in self.types:
            raise ValueError(f"unknown job type {job_type!r}")
        jt = self.types[job_type]
        params = params or {}
        if idempotency_key:
            row = self.db.one("SELECT id FROM jobs WHERE user_id=? AND idempotency_key=?", (user_id, idempotency_key))
            if row:
                return row["id"]
        estimate = jt.estimate(user_id, params) if jt.estimate else {}
        try:
            jid = self.db.insert("jobs", {
                "type": job_type, "status": "queued", "created_at": utcnow(), "params_json": dumps(params),
                "user_id": user_id, "idempotency_key": idempotency_key, "attempts": 0, "max_attempts": jt.max_attempts,
                "next_run_at": _iso(_now() + timedelta(seconds=delay_s)), "trigger": trigger,
                "estimate_json": dumps(estimate)})
        except Exception:
            if idempotency_key:  # lost a race with an identical submission
                row = self.db.one("SELECT id FROM jobs WHERE user_id=? AND idempotency_key=?", (user_id, idempotency_key))
                if row:
                    return row["id"]
            raise
        self.bus.emit("job", f"Queued {job_type} job #{jid}", source="jobs", user_id=user_id,
                      data={"job_id": jid, "type": job_type, "trigger": trigger, "node": f"job:{jid}"})
        self._wake.set()
        return jid

    # ---------- worker ----------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._dispatch_loop, name="atlas-dispatch", daemon=True)
        self._thread.start()

    def _dispatch_loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._dispatch_once()
                self._heartbeat()
            except Exception as e:  # the dispatcher must never die
                self.bus.emit("system", f"Job dispatcher error: {e}", level="error", source="jobs")
            self._wake.wait(self.poll_s)
            self._wake.clear()

    def _running_lanes(self) -> set[tuple[int, str]]:
        rows = self.db.query("SELECT user_id, type FROM jobs WHERE status='running'")
        return {(r["user_id"], self.types[r["type"]].lane if r["type"] in self.types else r["type"]) for r in rows}

    def _dispatch_once(self) -> None:
        with self._lock:
            free = self.workers - len(self._ctx)
        if free <= 0:
            return
        busy = self._running_lanes()
        rows = self.db.query("SELECT * FROM jobs WHERE status='queued' AND (next_run_at IS NULL OR next_run_at <= ?) "
                             "ORDER BY id LIMIT 50", (_iso(_now()),))
        for row in rows:
            if free <= 0:
                break
            jt = self.types.get(row["type"])
            if jt is None:
                continue  # registered later in startup, or by a newer build
            lane = (row["user_id"], jt.lane)
            if lane in busy:
                continue
            if row["cancel_requested"]:
                self._finish(row["id"], "cancelled", error="cancelled before it started")
                continue
            params = loads(row["params_json"], {})
            reason = jt.preflight(row["user_id"], params, loads(row["estimate_json"], {})) if jt.preflight else None
            if reason:
                self._finish(row["id"], "skipped", error=reason)
                self.bus.emit("job", f"Skipped {row['type']} job #{row['id']}: {reason}", level="warn", source="jobs",
                              user_id=row["user_id"], data={"job_id": row["id"]})
                continue
            claimed = self.db.execute(
                "UPDATE jobs SET status='running', started_at=?, heartbeat_at=?, worker_id=?, attempts=attempts+1, "
                "error=NULL WHERE id=? AND status='queued'", (utcnow(), utcnow(), self.worker_id, row["id"])).rowcount
            if not claimed:
                continue
            busy.add(lane)
            limits = jt.limits(row["user_id"], params) if jt.limits else Limits(max_runtime_s=self.max_runtime_s)
            if self.max_memory_mb and limits.max_memory_mb is None:
                limits.max_memory_mb = self.max_memory_mb
            ctx = JobContext(self, row["id"], row["user_id"], Meter(limits))
            with self._lock:
                self._ctx[row["id"]] = ctx
            free -= 1
            self.pool.submit(self._run, row["id"], jt, ctx, params, row["attempts"] + 1, row["max_attempts"] or jt.max_attempts)

    def _heartbeat(self) -> None:
        with self._lock:
            ids = list(self._ctx)
        if ids:
            self.db.execute(f"UPDATE jobs SET heartbeat_at=? WHERE id IN ({','.join('?' * len(ids))})", (utcnow(), *ids))

    def _finish(self, jid: int, status: str, *, error: str | None = None, result: Any = None, usage: dict | None = None) -> None:
        self.db.execute("UPDATE jobs SET status=?, finished_at=?, error=?, result_json=COALESCE(?, result_json), "
                        "usage_json=COALESCE(?, usage_json), progress=CASE WHEN ?='completed' THEN 1 ELSE progress END WHERE id=?",
                        (status, utcnow(), error, dumps(result) if result is not None else None,
                         dumps(usage) if usage is not None else None, status, jid))

    def _run(self, jid: int, jt: JobType, ctx: JobContext, params: dict, attempt: int, max_attempts: int) -> None:
        uid = ctx.user_id
        ctx.meter.bind()
        self.bus.emit("job", f"Started {jt.name} job #{jid}" + (f" (attempt {attempt}/{max_attempts})" if attempt > 1 else ""),
                      source="jobs", user_id=uid, data={"job_id": jid, "node": f"job:{jid}"})
        try:
            result = jt.handler(ctx, params)
            self._finish(jid, "completed", result=result, usage=ctx.meter.snapshot())
            self.bus.emit("job", f"Completed {jt.name} job #{jid}", source="jobs", user_id=uid, data={"job_id": jid, "node": f"job:{jid}"})
        except Cancelled as e:
            self._finish(jid, "cancelled", error=str(e), usage=ctx.meter.snapshot())
            self.bus.emit("job", f"Job #{jid} cancelled: {e}", level="warn", source="jobs", user_id=uid, data={"job_id": jid})
        except ResourceLimit as e:
            self._finish(jid, "limited", error=str(e), usage=ctx.meter.snapshot())
            self.bus.emit("job", f"Job #{jid} stopped: {e}", level="warn", source="jobs", user_id=uid, data={"job_id": jid})
        except Exception as e:
            err = f"{type(e).__name__}: {e}\n{traceback.format_exc()[-2000:]}"
            if attempt < max_attempts:
                delay = jt.backoff_s * 2 ** (attempt - 1)
                self.db.execute("UPDATE jobs SET status='queued', error=?, next_run_at=?, usage_json=? WHERE id=?",
                                (err, _iso(_now() + timedelta(seconds=delay)), dumps(ctx.meter.snapshot()), jid))
                self.bus.emit("job", f"Job #{jid} failed ({type(e).__name__}: {e}); retrying in {delay:.0f}s "
                              f"(attempt {attempt + 1}/{max_attempts})", level="warn", source="jobs", user_id=uid,
                              data={"job_id": jid})
            else:
                self._finish(jid, "failed", error=err, usage=ctx.meter.snapshot())
                self.bus.emit("job", f"Job #{jid} failed: {type(e).__name__}: {e}", level="error", source="jobs",
                              user_id=uid, data={"job_id": jid})
        finally:
            Meter.unbind()
            with self._lock:
                self._ctx.pop(jid, None)
            self._wake.set()

    # ---------- recovery, cancellation, queries ----------
    def recover(self) -> None:
        """Jobs left 'running' by a dead process are retried if they have attempts left, else interrupted.
        Queued jobs simply stay queued."""
        rows = self.db.query("SELECT id, type, user_id, attempts, max_attempts FROM jobs WHERE status='running'")
        retried = 0
        for r in rows:
            if (r["attempts"] or 0) < (r["max_attempts"] or 1):
                self.db.execute("UPDATE jobs SET status='queued', next_run_at=?, error='process restarted while running; retrying' "
                                "WHERE id=?", (utcnow(), r["id"]))
                retried += 1
            else:
                self.db.execute("UPDATE jobs SET status='interrupted', finished_at=?, error='process restarted while job active' "
                                "WHERE id=?", (utcnow(), r["id"]))
        if rows:
            self.bus.emit("job", f"Recovered {len(rows)} job(s) after restart: {retried} requeued, {len(rows) - retried} interrupted",
                          level="warn", source="jobs")

    def cancel(self, jid: int, user_id: int | None = None) -> bool:
        row = self.db.one("SELECT id, status, user_id FROM jobs WHERE id=?", (jid,))
        if not row or (user_id is not None and row["user_id"] != user_id) or row["status"] in TERMINAL:
            return False
        self.db.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (jid,))
        if row["status"] == "queued":
            self.db.execute("UPDATE jobs SET status='cancelled', finished_at=?, error='cancelled before it started' "
                            "WHERE id=? AND status='queued'", (utcnow(), jid))
        with self._lock:
            ctx = self._ctx.get(jid)
        if ctx:
            ctx.cancel_event.set()
        self.bus.emit("job", f"Cancellation requested for job #{jid}", level="warn", source="jobs", user_id=row["user_id"],
                      data={"job_id": jid})
        return True

    def active(self, job_type: str | None = None, user_id: int | None = None) -> list[dict]:
        rows = self.db.query("SELECT id, type, status, user_id FROM jobs WHERE status IN ('queued','running')")
        return [r for r in rows if (job_type is None or r["type"] == job_type) and (user_id is None or r["user_id"] == user_id)]

    def get(self, jid: int) -> dict | None:
        r = self.db.one("SELECT * FROM jobs WHERE id=?", (jid,))
        return _decode(r) if r else None

    def list(self, limit: int = 50, user_id: int | None = None, job_type: str | None = None) -> list[dict]:
        q, args = "SELECT * FROM jobs WHERE 1=1", []
        if user_id is not None:
            q += " AND user_id IN (?, 0)"
            args.append(user_id)
        if job_type:
            q += " AND type=?"
            args.append(job_type)
        return [_decode(r) for r in self.db.query(q + " ORDER BY id DESC LIMIT ?", (*args, limit))]

    def month_usage(self, user_id: int, month_start: datetime | None = None) -> dict:
        start = month_start or _now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        tot = {"cpu_s": 0.0, "wall_s": 0.0, "data_requests": 0, "llm_tokens": 0, "jobs": 0}
        for r in self.db.query("SELECT usage_json FROM jobs WHERE user_id=? AND created_at >= ? AND usage_json IS NOT NULL",
                               (user_id, _iso(start))):
            u = loads(r["usage_json"], {})
            tot["jobs"] += 1
            for k in ("cpu_s", "wall_s", "data_requests", "llm_tokens"):
                tot[k] += u.get(k, 0) or 0
        with self._lock:  # include what running jobs have used so far
            for c in self._ctx.values():
                if c.user_id == user_id:
                    s = c.meter.snapshot() if threading.get_ident() == c.meter._thread else {
                        "cpu_s": c.meter._cpu_sample, "wall_s": c.meter.wall_s,
                        "data_requests": c.meter.data_requests, "llm_tokens": c.meter.llm_tokens}
                    for k in ("cpu_s", "wall_s", "data_requests", "llm_tokens"):
                        tot[k] += s.get(k, 0) or 0
        tot["cpu_s"] = round(tot["cpu_s"], 3)
        tot["wall_s"] = round(tot["wall_s"], 3)
        return tot

    def wait(self, jid: int, timeout: float = 60) -> dict:
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            j = self.get(jid)
            if j and j["status"] in TERMINAL:
                return j
            time.sleep(0.05)
        raise TimeoutError(f"job {jid} did not finish within {timeout}s")

    def shutdown(self) -> None:
        self._stop.set()
        self._wake.set()
        with self._lock:
            for c in self._ctx.values():
                c.cancel_event.set()
        self.pool.shutdown(wait=False, cancel_futures=True)


def _decode(r: dict) -> dict:
    r["params"] = loads(r.pop("params_json", None), {})
    r["result"] = loads(r.pop("result_json", None), None)
    r["estimate"] = loads(r.pop("estimate_json", None), {})
    r["usage"] = loads(r.pop("usage_json", None), None)
    return r


# =============================================================================================
# Autonomy: per-user, opt-in schedules with hard limits
# =============================================================================================
class AutonomyConfig(BaseModel):
    enabled: bool = False  # opt-in: nothing runs on a schedule until the user turns this on
    paused: bool = False
    enabled_at: str | None = None
    schedule: Literal["daily", "interval", "manual"] = "daily"
    daily_time: str = "02:00"  # local time in `timezone`
    timezone: str = "UTC"
    interval_hours: int = Field(6, ge=1, le=168)
    # Limits (each also capped by the operator's system maxima in Settings)
    max_hypotheses_per_cycle: int = Field(12, ge=1, le=100)
    max_cycles_per_day: int = Field(4, ge=1, le=48)
    max_job_runtime_s: int = Field(900, ge=30, le=7200)
    max_data_requests_per_cycle: int = Field(300, ge=10, le=5000)
    monthly_cpu_budget_s: int = Field(36_000, ge=60, le=3_600_000)
    monthly_llm_token_budget: int = Field(200_000, ge=0, le=50_000_000)
    paper_tick_after_refresh: bool = True
    auto_deploy_paper: bool = True  # strategies that survive validation go to the PAPER portfolio only

    @field_validator("daily_time")
    @classmethod
    def _hhmm(cls, v: str) -> str:
        h, m = v.split(":")
        if not (0 <= int(h) < 24 and 0 <= int(m) < 60):
            raise ValueError("daily_time must be HH:MM")
        return f"{int(h):02d}:{int(m):02d}"

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as e:
            raise ValueError(f"unknown timezone {v!r}") from e
        return v


def schedule_slot(cfg: AutonomyConfig, now: datetime) -> datetime | None:
    """The most recent scheduled run time at or before `now` (UTC), or None for manual schedules.
    Each slot runs at most once (idempotency key), so restarts can't double-run and missed slots
    collapse into the latest one."""
    if cfg.schedule == "manual":
        return None
    if cfg.schedule == "interval":
        anchor = datetime.fromisoformat(cfg.enabled_at) if cfg.enabled_at else now
        k = int((now - anchor).total_seconds() // (cfg.interval_hours * 3600))
        return anchor + timedelta(hours=cfg.interval_hours * max(k, 0))
    tz = ZoneInfo(cfg.timezone)
    h, m = map(int, cfg.daily_time.split(":"))
    local = now.astimezone(tz)
    slot = datetime(local.year, local.month, local.day, h, m, tzinfo=tz)
    if slot > local:
        prev = local.date() - timedelta(days=1)
        slot = datetime(prev.year, prev.month, prev.day, h, m, tzinfo=tz)
    return slot.astimezone(timezone.utc)


def next_slot(cfg: AutonomyConfig, now: datetime) -> datetime | None:
    cur = schedule_slot(cfg, now)
    if cur is None:
        return None
    if cfg.schedule == "interval":
        nxt = cur + timedelta(hours=cfg.interval_hours)
        return nxt if nxt > now else nxt + timedelta(hours=cfg.interval_hours)
    tz = ZoneInfo(cfg.timezone)
    h, m = map(int, cfg.daily_time.split(":"))
    d = cur.astimezone(tz).date() + timedelta(days=1)
    return datetime(d.year, d.month, d.day, h, m, tzinfo=tz).astimezone(timezone.utc)


class Scheduler:
    """Every few seconds: for each user with autonomy enabled and not paused, submit the current schedule
    slot's research cycle once; keep shared market data fresh while anyone has autonomy on."""

    def __init__(self, db: Database, bus: EventBus, jobs: JobManager, actions: dict[str, Callable],
                 defaults: AutonomyConfig, caps: dict | None = None, data_refresh_minutes: int = 30):
        self.db = db
        self.bus = bus
        self.jobs = jobs
        self.actions = actions
        self.defaults = defaults
        self.caps = caps or {}
        self.data_refresh_minutes = data_refresh_minutes
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ---------- config ----------
    def config(self, user_id: int = 1) -> AutonomyConfig:
        saved = self.db.kv_get(f"autonomy:{user_id}")
        if saved is None and user_id == 1:
            saved = self.db.kv_get("autonomy", {})  # pre-migration single-user setting
        merged = {**self.defaults.model_dump(), **{k: v for k, v in (saved or {}).items() if k in AutonomyConfig.model_fields}}
        return AutonomyConfig(**merged)

    def update(self, patch: dict, user_id: int = 1) -> AutonomyConfig:
        unknown = set(patch) - set(AutonomyConfig.model_fields) - {"enabled_at"}
        if unknown:
            raise ValueError(f"unknown setting(s): {', '.join(sorted(unknown))}")
        for k, cap in self.caps.items():
            if k in patch and patch[k] is not None and patch[k] > cap:
                raise ValueError(f"{k} cannot exceed the system limit of {cap}")
        cur = self.config(user_id)
        data = {**cur.model_dump(), **patch}
        if patch.get("enabled") and not cur.enabled:
            data["enabled_at"] = _iso(_now())
            data["paused"] = False
        cfg = AutonomyConfig(**data)
        self.db.kv_set(f"autonomy:{user_id}", cfg.model_dump())
        changes = ", ".join(f"{k}={v}" for k, v in patch.items())
        self.bus.emit("system", f"Autonomy settings changed: {changes}", source="scheduler", user_id=user_id,
                      data={"node": "orchestrator", "patch": patch})
        return cfg

    def users(self) -> list[int]:
        ids = {int(r["key"].split(":")[1]) for r in self.db.query("SELECT key FROM kv WHERE key LIKE 'autonomy:%'")
               if r["key"].split(":")[1].isdigit()}
        if self.db.kv_get("autonomy") is not None:
            ids.add(1)
        return sorted(ids)

    def cycles_today(self, user_id: int) -> int:
        day = _now().date().isoformat()
        return self.db.one("SELECT COUNT(*) n FROM jobs WHERE type='research_cycle' AND user_id=? AND created_at >= ? "
                           "AND status NOT IN ('skipped','cancelled')", (user_id, day))["n"]

    # ---------- loop ----------
    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="atlas-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.wait(10):
            try:
                self.tick()
            except Exception as e:  # never let the scheduler die
                self.bus.emit("system", f"Scheduler error: {e}", level="error", source="scheduler")

    def tick(self, now: datetime | None = None) -> list[int]:
        now = now or _now()
        submitted: list[int] = []
        any_on = False
        for uid in self.users():
            cfg = self.config(uid)
            if not cfg.enabled or cfg.paused:
                continue
            any_on = True
            slot = schedule_slot(cfg, now)
            if slot is None or (cfg.enabled_at and slot < datetime.fromisoformat(cfg.enabled_at)):
                continue
            key = f"schedule:{_iso(slot)}"
            if self.db.one("SELECT 1 FROM jobs WHERE user_id=? AND idempotency_key=?", (uid, key)):
                continue
            if self.cycles_today(uid) >= cfg.max_cycles_per_day:
                self.bus.emit("system", f"Scheduled cycle for {_iso(slot)} skipped: daily limit of {cfg.max_cycles_per_day} reached",
                              level="warn", source="scheduler", user_id=uid)
                self.db.insert("jobs", {"type": "research_cycle", "status": "skipped", "created_at": utcnow(), "finished_at": utcnow(),
                                        "user_id": uid, "idempotency_key": key, "trigger": "schedule",
                                        "error": f"daily cycle limit ({cfg.max_cycles_per_day}) reached", "params_json": "{}"})
                continue
            try:
                submitted.append(self.actions["research_cycle"](
                    {"max_hypotheses": cfg.max_hypotheses_per_cycle, "trigger": "schedule", "user_id": uid},
                    user_id=uid, idempotency_key=key, trigger="schedule"))
            except LimitError as e:
                self.bus.emit("system", f"Scheduled cycle not started: {e}", level="warn", source="scheduler", user_id=uid)
        if any_on:
            r = self.db.one("SELECT created_at FROM jobs WHERE type='data_refresh' ORDER BY id DESC LIMIT 1")
            last = datetime.fromisoformat(r["created_at"]) if r else None
            if (not last or (now - last).total_seconds() >= self.data_refresh_minutes * 60) and not self.jobs.active("data_refresh"):
                defaults = self.config(1)
                self.actions["data_refresh"]({"paper_tick": defaults.paper_tick_after_refresh}, user_id=0, trigger="schedule")
        return submitted

    def status(self, user_id: int = 1) -> dict:
        cfg = self.config(user_id)
        now = _now()
        nxt = next_slot(cfg, now) if cfg.enabled and not cfg.paused else None
        last = self.db.one("SELECT id, created_at, status, trigger FROM jobs WHERE type='research_cycle' AND user_id=? "
                           "ORDER BY id DESC LIMIT 1", (user_id,))
        usage = self.jobs.month_usage(user_id)
        state = "off" if not cfg.enabled else "paused" if cfg.paused else "on"
        return {
            "config": cfg.model_dump(), "state": state,
            "running": bool(self._thread and self._thread.is_alive()),
            "next_run_at": _iso(nxt) if nxt else None,
            "last_cycle": last,
            "cycles_today": self.cycles_today(user_id),
            "active": self.jobs.active(user_id=user_id),
            "usage_month": usage,
            "budget": {"cpu_s": cfg.monthly_cpu_budget_s, "llm_tokens": cfg.monthly_llm_token_budget,
                       "cpu_remaining_s": max(0.0, cfg.monthly_cpu_budget_s - usage["cpu_s"]),
                       "llm_tokens_remaining": max(0, cfg.monthly_llm_token_budget - usage["llm_tokens"])},
            "caps": self.caps,
            "note": "Runs inside the SIGNAL backend, independent of your browser. It cannot run while the host "
                    "(for example a stopped Codespace) is off; missed runs collapse into one when it is back.",
        }
