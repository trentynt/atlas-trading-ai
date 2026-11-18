# SIGNAL closed-beta build — progress

Persistent state for the final build directive. Updated at the end of every phase.

| Phase | Status | Commit | Tests |
|---|---|---|---|
| 0 Audit | complete | e87ae76 | backend 31/31 |
| 1 Statistical integrity | complete | 126ea03 | backend 44/44 · tsc 0 · lint 0 · build ok |
| 2 Crypto-first market data | complete | bb786a0 | backend 55/55 · tsc 0 · lint 0 errors · build ok |
| 3 Autonomous research engine | complete | (this commit) | backend 73/73 · tsc 0 · lint 0 errors · build ok |
| 4 Design system & accessibility | pending | | |
| 5 Closed-beta infrastructure | pending | | |
| 6 Marketing capture | pending | | |
| 7 Deployment readiness | pending | | |
| 8 Verification | pending | | |
| 9 Launch report | pending | | |

## Phase 1 — what was done
- Schema migrations framework (`schema_migrations`), `users` table, `user_id` on every research/trading table (owner = user 1).
- Persistent trial registry: every hypothesis, parameter variant, manual backtest and manual validation is recorded with its return series.
- Multiple-testing safeguards: deflated Sharpe with effective trial count (Galwey), Benjamini–Yekutieli FDR (q ≤ 0.10) over Newey–West HAC p-values, Holm diagnostic, sealed holdout with single look and Bonferroni across looks.
- Dispositions: survived / rejected / insufficient evidence / requires out-of-sample confirmation / requires revalidation. Only "survived" can be paper-traded.
- Re-evaluation of all 50 legacy hypotheses (`python -m atlas.research.revalidate --user 1`): all 50 rejected, including Donchian ETH #18 (DSR 0.77 under 12 trials → 0.32 under 94 recorded attempts, ≈34.9 independent). Paper strategy #1 retired. Thresholds unchanged. Zero survivors is displayed as zero.
- UI: Discoveries disposition filter, "Research attempts considered", tests performed, limitations, "How validation works" drawer; Strategies separates research data from sealed data; Overview summary uses dispositions.
- `docs/STATISTICS.md` documents methodology, gates, rationale and limitations.
- Visual check: Discoveries #18, methodology drawer, Overview — rendered, 0 console errors.

## Phase 2 — what was done
- `docs/DATA_LICENSING.md`: terms checked 2026-11-18. ECB/Frankfurter verified (reuse with attribution, unmodified). Coinbase unverified (terms page 403 to automated access). Kraken restricted ("own benefit", no third-party display). Binance not integrated.
- `ATLAS_DEPLOYMENT_MODE` = personal | beta. Beta mode makes no requests to, and serves no stored data from, unverified sources (tested).
- Quality controls: invalid candles quarantined (never repaired), UTC alignment, out-of-order, conflicting duplicates, gaps never filled, outliers flagged, zero volume, staleness, ok/warn/fail grade; failing datasets refused for research.
- Cross-source check vs second venue: BTC median 0.64 bps, ETH 0.85 bps over 120 days (real).
- Configurable crypto universe (`ATLAS_CRYPTO_ASSETS`, liquid allow-list, crypto first); historical 1h/6h candles for charts; per-instrument costs served to UI.
- Labels: crypto "historical … not live"; FX exactly "Daily ECB reference rates — not live forex quotes."; nothing labelled live.
- Frankfurter requested with `providers=ecb` explicitly (default blends providers).
- `docs/BYO_DATA.md`: Alpaca/OANDA read-only design.

## Phase 3 — what was done
- Durable SQLite job queue with dispatcher thread: survives restarts, crash recovery (requeue or interrupted), retries with exponential backoff, per-user idempotency keys, DB-visible cancellation, one research job per user lane.
- Metering (`atlas/usage.py`): worker-thread CPU, wall time, provider requests, LLM tokens, process RSS. Hard limits stop jobs (`limited`); budget preflight skips them (`skipped`).
- Per-user opt-in autonomy: on/off, pause/resume, run now; daily (IANA tz, DST-aware) / every N hours / manual schedules; slot idempotency so nothing runs twice and missed slots don't backfill; per-user limits capped by system maxima.
- Estimated vs measured cost on every cycle (first real cycle: est. 18 CPU-s default assumption → measured 5.0 CPU-s, 7 requests).
- "While you were away" report from stored records only; Overview card; Run history panel. Legacy v1 cycles show "earlier method", never a survivor count.
- `docs/RESEARCH_ENGINE.md`.

## Genuine blockers
1. **Crypto data licence for beta** — no crypto source is verified for display to invited users. Needs owner decision: written permission/licence from an exchange, BYO data build, or a paid vendor (requires approval). Until then a beta deployment offers ECB forex only; personal mode is unaffected.

## Next executable task
Phase 4: official design tokens as CSS variables, WCAG AA contrast audit, keyboard/focus/reduced motion, accessible charts, red/green preference, sphere controls (strands off by default, motion control, mobile), Overview priorities, nine workspaces review, landing page.
