"""Phase 3: durable queue, retries, idempotency, recovery, limits, budgets, schedules, away report."""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from atlas.db import Database, dumps, utcnow
from atlas.events import EventBus
from atlas.jobs import AutonomyConfig, JobManager, JobType, Scheduler, next_slot, schedule_slot
from atlas.reports import away_report, mark_seen
from atlas.usage import Limits, record_data_request


@pytest.fixture
def db(tmp_path):
    return Database(tmp_path / "jobs.db")


def mk(db, **kw):
    jm = JobManager(db, EventBus(db), workers=kw.pop("workers", 2), poll_s=0.02, autostart=False, **kw)
    return jm


def test_queued_jobs_survive_restart(db):
    jm1 = mk(db)
    jm1.register(JobType("echo", lambda ctx, p: {"x": p["x"]}))
    jid = jm1.submit("echo", {"x": 7})  # never started: process "dies" here
    jm1.shutdown()
    jm2 = mk(db)
    jm2.register(JobType("echo", lambda ctx, p: {"x": p["x"]}))
    jm2.start()
    j = jm2.wait(jid, 10)
    assert j["status"] == "completed" and j["result"] == {"x": 7}
    jm2.shutdown()


def test_crash_recovery_retries_or_interrupts(db):
    now = utcnow()
    a = db.insert("jobs", {"type": "echo", "status": "running", "created_at": now, "user_id": 1, "attempts": 1, "max_attempts": 2})
    b = db.insert("jobs", {"type": "echo", "status": "running", "created_at": now, "user_id": 1, "attempts": 2, "max_attempts": 2})
    jm = mk(db)
    assert db.one("SELECT status FROM jobs WHERE id=?", (a,))["status"] == "queued"
    assert db.one("SELECT status FROM jobs WHERE id=?", (b,))["status"] == "interrupted"
    jm.register(JobType("echo", lambda ctx, p: "ok", max_attempts=2))
    jm.start()
    assert jm.wait(a, 10)["status"] == "completed"
    jm.shutdown()


def test_retry_with_backoff_then_success(db):
    calls = []

    def flaky(ctx, p):
        calls.append(time.monotonic())
        if len(calls) == 1:
            raise ConnectionError("provider down")
        return "ok"

    jm = mk(db)
    jm.register(JobType("flaky", flaky, max_attempts=3, backoff_s=0.3))
    jm.start()
    j = jm.wait(jm.submit("flaky"), 10)
    assert j["status"] == "completed" and j["attempts"] == 2
    assert calls[1] - calls[0] >= 0.25  # waited for the backoff
    jm.shutdown()


def test_retries_exhausted_marks_failed(db):
    jm = mk(db)
    jm.register(JobType("bad", lambda ctx, p: 1 / 0, max_attempts=2, backoff_s=0))
    jm.start()
    j = jm.wait(jm.submit("bad"), 10)
    assert j["status"] == "failed" and j["attempts"] == 2 and "ZeroDivisionError" in j["error"]
    jm.shutdown()


def test_idempotency_key(db):
    jm = mk(db)
    jm.register(JobType("echo", lambda ctx, p: 1))
    a = jm.submit("echo", user_id=1, idempotency_key="slot-1")
    assert jm.submit("echo", user_id=1, idempotency_key="slot-1") == a
    assert jm.submit("echo", user_id=2, idempotency_key="slot-1") != a  # keys are per user
    jm.shutdown()


def test_cancel_queued_and_running(db):
    started = threading.Event()

    def slow(ctx, p):
        started.set()
        for _ in range(500):
            ctx.check()
            time.sleep(0.01)
        return "done"

    jm = mk(db, workers=1)
    jm.register(JobType("slow", slow))
    jm.start()
    run = jm.submit("slow")
    started.wait(5)
    queued = jm.submit("slow")
    assert jm.cancel(queued) and jm.get(queued)["status"] == "cancelled"
    assert not jm.cancel(run, user_id=99)  # other users cannot cancel your job
    assert jm.cancel(run)
    assert jm.wait(run, 10)["status"] == "cancelled"
    assert not jm.cancel(run)  # already finished
    jm.shutdown()


def test_one_job_per_user_lane_but_users_run_concurrently(db):
    live: dict[int, int] = {}
    peak: dict[int, int] = {}
    both = threading.Event()
    lock = threading.Lock()

    def work(ctx, p):
        with lock:
            live[ctx.user_id] = live.get(ctx.user_id, 0) + 1
            peak[ctx.user_id] = max(peak.get(ctx.user_id, 0), live[ctx.user_id])
            if len([u for u, n in live.items() if n]) == 2:
                both.set()
        time.sleep(0.2)
        with lock:
            live[ctx.user_id] -= 1

    jm = mk(db, workers=4)
    jm.register(JobType("research", work, lane="research"))
    jm.start()
    ids = [jm.submit("research", user_id=1), jm.submit("research", user_id=1), jm.submit("research", user_id=2)]
    for i in ids:
        assert jm.wait(i, 10)["status"] == "completed"
    assert peak[1] == 1 and both.is_set()
    jm.shutdown()


def test_resource_limits_stop_jobs(db):
    def greedy(ctx, p):
        for _ in range(100):
            record_data_request()
        return "ok"

    def spin(ctx, p):
        t0 = time.monotonic()
        while time.monotonic() - t0 < 5:
            ctx.check()

    jm = mk(db)
    jm.register(JobType("greedy", greedy, limits=lambda u, p: Limits(max_data_requests=10)))
    jm.register(JobType("spin", spin, limits=lambda u, p: Limits(max_runtime_s=0.3)))
    jm.register(JobType("cpu", spin, limits=lambda u, p: Limits(max_cpu_s=0.2)))
    jm.register(JobType("mem", spin, limits=lambda u, p: Limits(max_memory_mb=1)))
    jm.start()
    g = jm.wait(jm.submit("greedy"), 10)
    assert g["status"] == "limited" and "data request limit" in g["error"] and g["usage"]["data_requests"] == 11
    assert "runtime limit" in jm.wait(jm.submit("spin"), 10)["error"]
    c = jm.wait(jm.submit("cpu"), 10)
    assert c["status"] == "limited" and "compute budget" in c["error"] and c["usage"]["cpu_s"] >= 0.2
    assert "memory limit" in jm.wait(jm.submit("mem"), 10)["error"]
    jm.shutdown()


def test_budget_preflight_skips_and_usage_is_measured(db):
    def burn(ctx, p):
        t0 = time.thread_time()
        while time.thread_time() - t0 < 0.15:
            pass
        return "ok"

    jm = mk(db)
    budget = {"cpu_s": 0.4}

    def preflight(uid, p, est):
        used = jm.month_usage(uid)["cpu_s"]
        return None if used + est["cpu_s"] <= budget["cpu_s"] else f"budget: used {used:.2f}"

    jm.register(JobType("burn", burn, lane="r", estimate=lambda u, p: {"cpu_s": 0.15}, preflight=preflight))
    jm.start()
    a = jm.wait(jm.submit("burn"), 10)
    assert a["status"] == "completed" and a["estimate"]["cpu_s"] == 0.15 and a["usage"]["cpu_s"] >= 0.14
    jm.wait(jm.submit("burn"), 10)
    c = jm.wait(jm.submit("burn"), 10)
    assert c["status"] == "skipped" and "budget" in c["error"]
    assert jm.month_usage(1)["cpu_s"] >= 0.28
    jm.shutdown()


# ---------------- schedules ----------------
def test_daily_schedule_respects_timezone_and_dst():
    cfg = AutonomyConfig(enabled=True, schedule="daily", daily_time="02:00", timezone="America/Toronto")
    winter = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)
    assert schedule_slot(cfg, winter) == datetime(2026, 1, 15, 7, 0, tzinfo=timezone.utc)  # EST = UTC-5
    summer = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)
    assert schedule_slot(cfg, summer) == datetime(2026, 7, 15, 6, 0, tzinfo=timezone.utc)  # EDT = UTC-4
    early = datetime(2026, 7, 15, 5, 0, tzinfo=timezone.utc)  # before today's 02:00 local
    assert schedule_slot(cfg, early) == datetime(2026, 7, 14, 6, 0, tzinfo=timezone.utc)
    assert next_slot(cfg, early) == datetime(2026, 7, 15, 6, 0, tzinfo=timezone.utc)


def test_interval_and_manual_schedules():
    t0 = datetime(2026, 3, 1, 0, 0, tzinfo=timezone.utc)
    cfg = AutonomyConfig(enabled=True, schedule="interval", interval_hours=6, enabled_at=t0.isoformat())
    assert schedule_slot(cfg, t0 + timedelta(hours=13)) == t0 + timedelta(hours=12)
    assert next_slot(cfg, t0 + timedelta(hours=13)) == t0 + timedelta(hours=18)
    assert schedule_slot(AutonomyConfig(schedule="manual"), t0) is None


def _sched(db, jm):
    submitted = []

    def research(params, *, user_id, idempotency_key, trigger):
        jid = jm.submit("research_cycle", params, user_id=user_id, idempotency_key=idempotency_key, trigger=trigger)
        submitted.append(jid)
        return jid

    s = Scheduler(db, EventBus(db), jm, {"research_cycle": research, "data_refresh": lambda p, **k: None},
                  AutonomyConfig(), data_refresh_minutes=10_000)
    return s, submitted


def test_scheduler_is_opt_in_idempotent_pausable_and_limited(db):
    jm = mk(db)
    jm.register(JobType("research_cycle", lambda ctx, p: "ok", lane="research"))
    s, submitted = _sched(db, jm)
    now = datetime(2026, 5, 2, 12, 0, tzinfo=timezone.utc)
    assert s.tick(now) == []  # nobody opted in
    s.update({"schedule": "interval", "interval_hours": 1}, user_id=3)
    assert s.tick(now) == []  # configured but not enabled
    s.update({"enabled": True}, user_id=3)
    cfg = s.config(3)
    db.kv_set("autonomy:3", {**cfg.model_dump(), "enabled_at": (now - timedelta(hours=5)).isoformat()})
    first = s.tick(now)
    assert len(first) == 1
    assert s.tick(now) == [] and s.tick(now + timedelta(minutes=30)) == []  # same slot: never twice
    s.update({"paused": True}, user_id=3)
    assert s.tick(now + timedelta(hours=2)) == []
    s.update({"paused": False, "max_cycles_per_day": 1}, user_id=3)
    db.execute("UPDATE jobs SET created_at=? WHERE id=?", (datetime.now(timezone.utc).isoformat(), first[0]))
    assert s.tick(now + timedelta(hours=3)) == []  # daily limit reached → recorded as skipped
    skipped = db.query("SELECT * FROM jobs WHERE user_id=3 AND status='skipped'")
    assert skipped and "daily cycle limit" in skipped[0]["error"]
    jm.shutdown()


def test_scheduler_does_not_backfill_slots_before_enabling(db):
    jm = mk(db)
    jm.register(JobType("research_cycle", lambda ctx, p: "ok"))
    s, _ = _sched(db, jm)
    now = datetime.now(timezone.utc)
    s.update({"enabled": True, "schedule": "daily", "daily_time": (now - timedelta(hours=1)).strftime("%H:%M")}, user_id=4)
    assert s.tick(now) == []  # today's slot was before the user enabled autonomy
    jm.shutdown()


def test_caps_cannot_be_exceeded(db):
    jm = mk(db)
    s = Scheduler(db, EventBus(db), jm, {}, AutonomyConfig(), caps={"max_hypotheses_per_cycle": 20})
    with pytest.raises(ValueError):
        s.update({"max_hypotheses_per_cycle": 21}, user_id=1)
    assert s.update({"max_hypotheses_per_cycle": 20}, user_id=1).max_hypotheses_per_cycle == 20
    jm.shutdown()


# ---------------- away report ----------------
def test_away_report_counts_only_this_users_records(db):
    t_old = "2026-01-01T00:00:00+00:00"
    since = "2026-01-02T00:00:00+00:00"
    t_new = "2026-01-02T03:00:00+00:00"
    for uid in (1, 2):
        db.insert("jobs", {"type": "research_cycle", "status": "completed", "created_at": t_new, "user_id": uid,
                           "trigger": "schedule", "usage_json": dumps({"cpu_s": 2.5, "data_requests": 4})})
        db.insert("experiments", {"created_at": t_new, "kind": "hypothesis_test", "status": "completed", "user_id": uid,
                                  "symbol": "BTC/USD", "strategy": "x", "disposition": "rejected",
                                  "reasons_json": dumps(["oos_sharpe: weak", "dsr: luck"])})
    db.insert("jobs", {"type": "research_cycle", "status": "failed", "created_at": t_new, "user_id": 1, "trigger": "schedule",
                       "error": "RuntimeError: provider down\ntrace"})
    db.insert("jobs", {"type": "research_cycle", "status": "completed", "created_at": t_old, "user_id": 1, "trigger": "manual"})
    db.insert("experiments", {"created_at": t_new, "kind": "hypothesis_test", "status": "completed", "user_id": 1,
                              "symbol": "ETH/USD", "strategy": "y", "disposition": "requires_confirmation", "reasons_json": "[]"})
    db.insert("risk_events", {"ts": t_new, "rule": "max_position", "decision": "reject", "severity": "high",
                              "message": "too big", "user_id": 1})
    r = away_report(db, 1, since, "2026-01-03T00:00:00+00:00")
    assert r["research"]["cycles"] == 2 and r["research"]["by_status"] == {"completed": 1, "failed": 1}
    assert r["research"]["ideas_tested"] == 2 and r["research"]["dispositions"] == {"rejected": 1, "requires_confirmation": 1}
    assert r["research"]["notable"][0]["symbol"] == "ETH/USD"
    assert dict(r["research"]["top_rejection_reasons"]) == {"oos_sharpe": 1, "dsr": 1}
    assert r["paper"]["risk_blocks"] == 1 and r["problems"][0]["error"] == "RuntimeError: provider down"
    assert r["usage"]["cpu_s"] == 2.5
    assert "1 research cycle completed (1 scheduled)" in r["headline"] and "1 awaits confirmation" in r["headline"] and "0 survived" in r["headline"]
    empty = away_report(db, 1, "2026-02-01T00:00:00+00:00", "2026-02-02T00:00:00+00:00")
    assert empty["headline"].startswith("No research cycles ran") and empty["research"]["ideas_tested"] == 0


def test_mark_seen_starts_new_window_only_after_gap(db):
    first = mark_seen(db, 1)
    again = mark_seen(db, 1)  # page reload: window unchanged
    assert again["previous_seen_at"] == first["previous_seen_at"]
    old = (datetime.now(timezone.utc) - timedelta(hours=8)).isoformat(timespec="seconds")
    db.execute("UPDATE users SET last_seen_at=? WHERE id=1", (old,))
    assert mark_seen(db, 1)["previous_seen_at"] == old
