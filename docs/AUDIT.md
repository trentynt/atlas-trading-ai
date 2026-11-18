# SIGNAL — Phase 0 repository audit

Audited on branch `feature/atlas-platform` at commit `6c0c57f`. Every statement below was verified against the running code or the research database, not taken from earlier reports.

## Verified baseline
- Backend tests: **31 passed** (`cd backend && ../.venv/bin/python -m pytest -q`).
- Frontend: `tsc -b`, `oxlint`, `vite build` pass. 14/14 scripted browser flows passed in the previous session.
- Stack: FastAPI + SQLite (single file `data/atlas.db`, WAL) · React 19 / Vite 8 / Tailwind 4 · lightweight-charts · Playwright (dev only).
- Research database at audit time: 50 hypothesis tests (1 "accepted", 49 rejected), 19 manual backtests, 1 deployed paper strategy (source: experiment #18).

## Architecture inventory
| Area | Module | State |
|---|---|---|
| Market data | `atlas/data/*` | Real. Frankfurter (ECB) for EUR/USD, GBP/USD, USD/JPY; Coinbase Exchange daily candles for BTC/ETH with Kraken failover. Validation, versioning, gzip snapshots. Daily only. |
| Research | `atlas/research/*` | Real. Causal indicators, regime classifier, features + rank IC, 6 strategies. |
| Backtesting | `atlas/backtest/*` | Real. Event-driven engine, next-bar fills, costs, ATR stops, chronological 60/20/20 split, walk-forward, cost stress, neighbours, PSR/DSR, block bootstrap. |
| Agents | `atlas/agents/*` | Real, deterministic. 7 agents + orchestrator. Optional LLM narration (off). |
| Jobs | `atlas/jobs.py` | In-process ThreadPool; jobs persisted, but the queue itself is in memory (lost on restart; marked `interrupted`, never retried). Scheduler: interval-based, daily cap. |
| Paper/risk | `atlas/paper`, `atlas/risk` | Real. Single global paper account (`paper_account.id = 1`). 9 risk rules + kill switch enforced server-side. |
| Auth/users | — | **None.** No users table, no sessions; every endpoint is open. |
| Payments, analytics, legal | — | **None.** |

## Workspaces
| Workspace | Endpoints | Works | Gaps for beta |
|---|---|---|---|
| Overview | graph, markets, agents, jobs, experiments, research/reports, risk/status, paper/* | Summary sentence, sphere, attention items, findings, research cycle panel, portfolio + risk. | No "since your last visit" report; "passed every check" wording overstates evidence; no next-scheduled time when autonomy is off. |
| Markets | markets, bars, quality, regime, features, correlations, refresh | Real data, provenance, ECB notice. | Daily only; no cross-source price check; OHLC inconsistencies are *repaired* instead of quarantined. |
| Research | agents, autonomy, jobs, research-cycle, queue, reports | Runs real cycles, schedule controls, history drawer. | Not opt-in; schedule is interval-only; no retries/idempotency; not per-user. |
| Strategies | strategies, backtest, evaluate, distribution | Real backtests and validation. | "Validate on unseen data" reveals the final test window on demand — repeated peeking contaminates it. Manual runs are not counted as trials. |
| Forecasts | forecast, forecast/models | Real statistical baselines with rolling evaluation. | None blocking. |
| Discoveries | experiments, distribution, reproduce, paper/strategies | Evidence library, compare, reproduce. | Verdict language overstates ("Accepted", "Paper-trade it"). |
| Portfolio | paper/* | Real simulated broker. | Single global account; no per-user isolation. |
| Risk | risk/* | Real enforcement + audit. | Limits are global, not per user. |
| Activity | jobs, events (WS) | Real event log. | WebSocket broadcasts every event to every client. |

No workspace shows mock or seeded data. When the backend is down every view shows an error state with retry; when data is missing views show empty states.

## Statistical engine — what it actually does
Acceptance gates (`CRITIC_RULES`, `agents/core.py`), all blocking unless noted:

| Gate | Threshold |
|---|---|
| Test-period trades | ≥ 8 |
| Test Sharpe | ≥ 0.30 |
| Validation Sharpe | > 0 |
| OOS/IS Sharpe ratio | ≥ 0.25 (when IS > 0) |
| Deflated Sharpe (test) | ≥ 0.60 |
| Block-bootstrap p (test mean ≤ 0) | ≤ 0.20 |
| Sharpe at 2× costs | > 0 |
| Neighbour parameter sets positive | ≥ 50% |
| Test max drawdown | ≥ −35% |
| Walk-forward | ≥ 50% positive folds and mean OOS Sharpe > 0 |
| Beats buy-and-hold Sharpe | advisory |

### Problems found
1. **The "test" window is not sealed.** Every hypothesis on a symbol is judged on the same final 20% of history (25 ETH tests used 4 distinct windows, differing only by data refreshes). Selecting the best of many on one window is data snooping; the window can no longer be called unseen. The manual *Validate* tool reveals it on demand as well.
2. **Trial counting is incomplete.** `n_trials` counts only hypothesis-level experiments for the symbol. It ignores parameter variants evaluated in neighbour and walk-forward searches (≈7 per hypothesis), manual backtests and manual validations. The DSR therefore understates the search.
3. **Trial correlation is ignored.** Variants of one strategy are highly correlated; raw counts are both too high (when including variants) and too low (when excluding them). An effective-trial estimate is needed.
4. **No family-wise or FDR control.** Each bootstrap p-value is judged alone at 0.20. With 50 tests, ~10 false positives at p ≤ 0.20 are expected under the null.
5. **Gate thresholds are lenient** for a public claim: p ≤ 0.20 and 8 trades is weak evidence.
6. **Experiment #18 ("accepted")**: 8 test trades (the minimum), bootstrap p = 0.154, DSR 0.77 computed with 12 trials; 25 ETH trials now exist plus uncounted variants. It is the paper portfolio's only deployed strategy.
7. **Data handling**: OHLC inconsistencies are silently repaired (`normalize`) — this modifies data instead of quarantining it.

### Checked and not found
- Look-ahead bias: strategy signals and features are causal (tests `test_strategies_are_causal`, `test_features_are_causal`). Orders fill on the next bar.
- Weekly resampling drops the open period; weekly features become visible only after the week closes.
- Survivorship bias: the instrument list is fixed a priori (5 instruments), not filtered by performance. Its small size limits generality; it does not bias selection.

## Security review (pre-beta)
| Severity | Finding |
|---|---|
| Critical | No authentication; every endpoint (paper orders, risk limits, kill switch, research jobs) is open to anyone who can reach the port. |
| Critical | No per-user data model; one shared paper account, research history and risk configuration. |
| High | WebSocket broadcasts all events to all clients. |
| High | No rate limiting on any endpoint, including the waitlist. |
| Medium | No CSRF protection beyond CORS (acceptable only while there are no cookie sessions). |
| Medium | `/api/system/overview` exposes server details (DB path in `/api/health`, load average). |
| Low | Error handler returns exception type/message to clients. |
| OK | No secrets in the repository; database and `.env` are git-ignored; backend binds to 127.0.0.1 in dev. |

## Market-data licensing (to verify in Phase 2)
Coinbase, Kraken and Frankfurter/ECB are used without any recorded licence review. Binance is geo-blocked from this environment (HTTP 451).

## What needs to happen for beta (summary)
Statistical integrity fixes (Phase 1) → data licensing and quality (Phase 2) → durable, opt-in, per-user research (Phase 3) → design tokens and accessibility (Phase 4) → authentication, isolation, onboarding, analytics, test-mode payments, draft legal pages (Phase 5) → replay-based marketing capture (Phase 6) → deployment kit and security verification (Phase 7) → full verification (Phase 8).
