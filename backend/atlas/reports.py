"""'What happened while I was away?' — a deterministic summary built only from stored records
(jobs, experiments, trials, holdout looks, paper orders/fills, risk events, data events). Every number
links back to the rows it was counted from; nothing is generated or estimated."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone

from .db import Database, loads, utcnow


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def mark_seen(db: Database, user_id: int, min_gap_minutes: int = 30) -> dict:
    """Record a visit. A new 'away' window starts only after a gap, so reloading the page does not
    reset the report."""
    u = db.one("SELECT last_seen_at, previous_seen_at FROM users WHERE id=?", (user_id,))
    if not u:
        return {}
    now = datetime.now(timezone.utc)
    last = datetime.fromisoformat(u["last_seen_at"]) if u["last_seen_at"] else None
    if last is None or (now - last) > timedelta(minutes=min_gap_minutes):
        db.execute("UPDATE users SET previous_seen_at=?, last_seen_at=? WHERE id=?", (u["last_seen_at"], utcnow(), user_id))
    else:
        db.execute("UPDATE users SET last_seen_at=? WHERE id=?", (utcnow(), user_id))
    return dict(db.one("SELECT last_seen_at, previous_seen_at FROM users WHERE id=?", (user_id,)))


def away_report(db: Database, user_id: int, since: str | None = None, until: str | None = None) -> dict:
    now = datetime.now(timezone.utc)
    if since is None:
        u = db.one("SELECT previous_seen_at FROM users WHERE id=?", (user_id,))
        since = (u or {}).get("previous_seen_at") or (now - timedelta(hours=24)).isoformat(timespec="seconds")
        basis = "since your previous visit" if (u or {}).get("previous_seen_at") else "in the last 24 hours"
    else:
        basis = "since the time you chose"
    until = until or now.isoformat(timespec="seconds")
    w = (user_id, since, until)

    jobs = db.query("SELECT id, type, status, trigger, created_at, finished_at, error, result_json, usage_json FROM jobs "
                    "WHERE user_id=? AND created_at >= ? AND created_at <= ? ORDER BY id", w)
    cycles = [j for j in jobs if j["type"] == "research_cycle"]
    by_status = Counter(j["status"] for j in cycles)
    by_trigger = Counter(j["trigger"] or "manual" for j in cycles if j["status"] == "completed")
    problems = [{"job_id": j["id"], "type": j["type"], "status": j["status"], "error": (j["error"] or "").split("\n")[0][:240]}
                for j in jobs if j["status"] in ("failed", "limited", "skipped", "interrupted")]
    usage = {"cpu_s": 0.0, "data_requests": 0, "llm_tokens": 0}
    for j in jobs:
        u = loads(j["usage_json"], {}) or {}
        for k in usage:
            usage[k] += u.get(k, 0) or 0
    usage["cpu_s"] = round(usage["cpu_s"], 3)

    exps = db.query("SELECT id, symbol, strategy, disposition, reasons_json, metrics_json, cycle_id FROM experiments "
                    "WHERE kind='hypothesis_test' AND user_id=? AND created_at >= ? AND created_at <= ? ORDER BY id", w)
    disp = Counter(e["disposition"] or "rejected" for e in exps)
    reasons = Counter()
    for e in exps:
        if e["disposition"] == "rejected":
            for r in loads(e["reasons_json"], []) or []:
                reasons[r.split(":")[0]] += 1
    notable = [{"experiment_id": e["id"], "symbol": e["symbol"], "strategy": e["strategy"], "disposition": e["disposition"],
                "q_value": (loads(e["metrics_json"], {}) or {}).get("q_value")}
               for e in exps if e["disposition"] in ("survived", "requires_confirmation")]
    trials = db.one("SELECT COUNT(*) n FROM trials WHERE user_id=? AND created_at >= ? AND created_at <= ?", w)["n"]
    looks = db.query("SELECT id, symbol, strategy, experiment_id FROM holdout_evaluations "
                     "WHERE user_id=? AND created_at >= ? AND created_at <= ?", w)

    orders = db.query("SELECT id, symbol, side, status, reject_reason FROM orders WHERE user_id=? AND created_at >= ? AND created_at <= ?", w)
    fills = db.query("SELECT id, symbol, side, realized_pnl FROM fills f WHERE ts >= ? AND ts <= ? AND EXISTS "
                     "(SELECT 1 FROM orders o WHERE o.id=f.order_id AND o.user_id=?)", (since, until, user_id))
    blocks = db.query("SELECT id, rule, message, order_id FROM risk_events WHERE decision='reject' AND user_id=? AND ts >= ? AND ts <= ?", w)
    snaps = db.query("SELECT ts, equity FROM portfolio_snapshots WHERE user_id=? AND ts <= ? ORDER BY ts", (user_id, until))
    before = [s for s in snaps if s["ts"] < since]
    eq0 = before[-1]["equity"] if before else (snaps[0]["equity"] if snaps else None)
    eq1 = snaps[-1]["equity"] if snaps else None
    data_issues = db.query("SELECT id, ts, level, message FROM events WHERE category='data' AND level IN ('warn','error') "
                           "AND ts >= ? AND ts <= ? ORDER BY id DESC LIMIT 20", (since, until))

    # Deterministic headline from the counts above.
    lines: list[str] = []
    done = by_status.get("completed", 0)
    if not cycles:
        lines.append("No research cycles ran.")
    else:
        words = {"schedule": "scheduled", "run_now": "run now", "manual": "started by you"}
        trig = ", ".join(f"{n} {words.get(t, t)}" for t, n in by_trigger.most_common())
        lines.append(f"{_plural(done, 'research cycle')} completed" + (f" ({trig})" if trig else "") + ".")
    if exps:
        s, c = disp.get("survived", 0), disp.get("requires_confirmation", 0)
        parts = [f"{s} survived current validation"]  # always stated, including zero
        if c:
            parts.append(f"{c} await{'s' if c == 1 else ''} confirmation on new data")
        if disp.get("insufficient_evidence"):
            parts.append(f"{disp['insufficient_evidence']} had insufficient evidence")
        if disp.get("rejected"):
            parts.append(f"{disp['rejected']} rejected")
        lines.append(f"{_plural(len(exps), 'idea')} tested: {', '.join(parts)}.")
    if orders or blocks:
        bits = [_plural(len(orders), "paper order"), _plural(len(fills), "fill")]
        if blocks:
            bits.append(f"{_plural(len(blocks), 'order')} blocked by risk limits")
        lines.append(", ".join(bits) + ".")
    if eq0 is not None and eq1 is not None and eq0:
        d = eq1 - eq0
        if abs(d) < 0.005:
            lines.append("Paper equity was unchanged (simulated).")
        else:
            lines.append(f"Paper equity {'rose' if d > 0 else 'fell'} by ${abs(d):,.2f} ({abs(d / eq0):.3%}, simulated).")
    if problems:
        lines.append(f"{_plural(len(problems), 'job')} needed attention.")

    return {
        "since": since, "until": until, "basis": basis, "headline": " ".join(lines),
        "research": {"cycles": len(cycles), "by_status": dict(by_status), "by_trigger": dict(by_trigger),
                     "ideas_tested": len(exps), "dispositions": dict(disp), "trials_registered": trials,
                     "holdout_looks": len(looks), "top_rejection_reasons": reasons.most_common(5), "notable": notable[:10],
                     "cycle_job_ids": [j["id"] for j in cycles]},
        "paper": {"orders": len(orders), "fills": len(fills), "risk_blocks": len(blocks),
                  "blocked": [{"risk_event_id": b["id"], "rule": b["rule"], "message": b["message"], "order_id": b["order_id"]} for b in blocks[:10]],
                  "equity_start": eq0, "equity_end": eq1, "realized_pnl": round(sum(f["realized_pnl"] for f in fills), 2)},
        "data_issues": data_issues,
        "problems": problems,
        "usage": usage,
        "provenance": "Counted from stored jobs, experiments, trials, holdout evaluations, paper orders, fills, risk events "
                      "and data events between the two timestamps. Paper results are simulated.",
    }
