# Autonomous research engine

How SIGNAL runs research in the background, what limits it, and what it records. The code is in `backend/atlas/jobs.py`, `backend/atlas/usage.py`, `backend/atlas/services.py` and `backend/atlas/reports.py`. Tests are in `backend/tests/test_jobs.py` and `backend/tests/test_system.py`.

## Where it runs

Jobs run inside the backend process, so they don't depend on a browser tab being open. The backend has to be running for anything to happen. On a stopped or suspended Codespace, nothing runs. When the host comes back, missed scheduled runs collapse into a single run rather than a backlog.

## Job queue

The queue is stored in the `jobs` table, not in memory.

| Property | How |
|---|---|
| Survives restart | Queued jobs stay queued. A dispatcher thread claims them with an atomic `UPDATE … WHERE status='queued'`. |
| Crash recovery | On startup, a job left `running` by a dead process is requeued if it has attempts left. Otherwise it is marked `interrupted`. |
| Retries | Failures are retried with exponential backoff. Data refresh: 3 attempts, 30 s base. Research cycle: 2 attempts, 60 s base. Revalidation: no retry. |
| Idempotency | Optional per-user `idempotency_key` (unique index). Each scheduled run uses `schedule:<slot time>`, so a slot can never run twice. |
| Cancellation | `POST /api/jobs/{id}/cancel`. A queued job is cancelled immediately. A running job stops at its next checkpoint. The cancellation is also written to the database, so another process can see it. |
| Concurrency | At most `ATLAS_WORKER_THREADS` jobs at once, and at most one research job per user (its "lane"). Different users run in parallel. |
| Status and history | `GET /api/jobs`, `GET /api/jobs/{id}`, `GET /api/autonomy/history`. Users see only their own jobs, plus shared market-data refreshes. |

Statuses: `queued`, `running`, `completed`, `failed`, `cancelled`, `limited` (stopped at a resource limit), `skipped` (refused before starting, e.g. budget or daily limit), `interrupted`.

## Autonomy is opt-in

Autonomy is off for every user until they turn it on (Research → Autonomous research). The controls are:

- **Turn on / Turn off.** Turning on records `enabled_at`. Schedule slots before that moment never run.
- **Pause / Resume.** While paused, scheduled slots are skipped. A job that is already running continues.
- **Run now.** Starts one cycle immediately. It counts toward the daily limit.
- **Schedule.** Choose one of:
  - daily at a local time in an IANA time zone (DST-aware)
  - every N hours
  - only when started manually

## Limits

Each user sets their own limits. They can lower them below the operator's system caps (`ATLAS_*` settings), but never raise them above.

| Limit | User default | System cap setting | Enforcement |
|---|---|---|---|
| Ideas per cycle | 12 | `ATLAS_MAX_HYPOTHESES_PER_CYCLE` (40) | Request refused (HTTP 429) |
| Cycles per day | 4 | `ATLAS_MAX_CYCLES_PER_DAY` (24) | Request refused (HTTP 429). A scheduled slot is recorded as `skipped`. |
| Runtime per cycle | 15 min | `ATLAS_MAX_JOB_RUNTIME_S` (30 min) | Job stops (`limited`) |
| Concurrent research jobs | 1 per user | `ATLAS_WORKER_THREADS` total | Queued until the lane is free |
| Market-data requests per job | 300 | `ATLAS_MAX_DATA_REQUESTS_PER_JOB` (2000) | Job stops (`limited`) |
| Monthly CPU budget | 10 h | `ATLAS_MAX_MONTHLY_CPU_S` (100 h) | Skipped if the estimate exceeds what remains. Stopped if it runs out mid-job. |
| Monthly LLM tokens | 200,000 | `ATLAS_MAX_MONTHLY_LLM_TOKENS` | Narration skipped when exhausted. Research itself never depends on an LLM. |
| Memory | — | `ATLAS_MAX_MEMORY_MB` (3072) | Job stops if backend process RSS exceeds it |

## Estimated versus measured

Before a cycle runs, SIGNAL stores an estimate:

- **CPU-seconds.** Ideas × the median measured CPU-seconds per idea from the last 10 completed cycles. With no history, it assumes 4 s per idea and says so.
- **Data requests** and **LLM tokens.**

After the cycle, it stores what was measured:

| Measurement | What it covers |
|---|---|
| CPU time | The job's worker thread |
| Wall time | Elapsed time |
| Data requests | Requests to market-data providers |
| LLM tokens | As reported by the API |
| Peak RSS | The whole process, because threads share memory |

Run history shows both side by side.

In the first measured run (2026-11-18), the estimate for 4 ideas was 18 CPU-seconds, from the default assumption. The measured cost was 5.0 CPU-seconds and 7 data requests.

## "While you were away"

`GET /api/reports/away` builds the Overview card. It covers the time since the user's previous visit, or the last 24 hours on a first visit. A new window starts only after a 30-minute gap (`POST /api/me/seen`).

The report counts stored rows only:

- jobs
- experiments and dispositions
- trials
- sealed-data looks
- paper orders, fills and risk blocks
- paper equity change
- data warnings
- problems

The headline is assembled from those counts, with no generated text. Zero survivors is always stated.
