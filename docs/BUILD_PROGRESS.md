# SIGNAL closed-beta build — progress

Persistent state for the final build directive. Updated at the end of every phase.

| Phase | Status | Commit | Tests |
|---|---|---|---|
| 0 Audit | complete | e87ae76 | backend 31/31 |
| 1 Statistical integrity | complete | (this commit) | backend 44/44 · tsc 0 · lint 0 · build ok |
| 2 Crypto-first market data | pending | | |
| 3 Autonomous research engine | pending | | |
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

## Genuine blockers
_None yet._

## Next executable task
Phase 2: `docs/DATA_LICENSING.md` (verify exchange terms), data-quality controls, configurable crypto universe and intervals, cross-source checks, `docs/BYO_DATA.md`.
