# SIGNAL — your personal AI trading research company

*Working brand **SIGNAL** (provisional, pending trademark clearance). Engineering codename **ATLAS**.*

SIGNAL (codename ATLAS) is a research operating system for systematic trading hypotheses: real market data, an
event-driven backtester with walk-forward evaluation, deterministic research agents that generate,
test and criticise strategies, a forecasting lab, and a **paper-only** execution engine behind a
backend-enforced risk layer.

> **Paper only.** There is no broker integration and no code path that places real orders.
> Every backtest is a historical simulation; passing the research critic is not evidence of
> future profitability.

## Quick start (Codespaces)

```bash
make setup      # once: Python venv + npm install
make backend    # terminal 1 → http://127.0.0.1:8000  (API docs at /docs)
make frontend   # terminal 2 → http://localhost:5173
```

Or `make dev` to run both in one terminal. Open the forwarded port **5173** in your browser; the
dev server proxies `/api` (HTTP + WebSocket) to the backend, so only one port needs forwarding.

On first start the backend downloads history for all five instruments (~15 s) and the Overview's
research network populates as datasets, features and experiments appear.

| Page | URL (port 5173) |
|---|---|
| The app — nine workspaces | `/#overview`, `/#markets`, `/#research`, `/#strategies`, `/#forecasts`, `/#discoveries`, `/#portfolio`, `/#risk`, `/#activity` |
| Landing page + private-beta sign-up | `/landing.html` |

Keyboard: `⌘K` / `Ctrl+K` or `/` opens search (workspaces, instruments, discoveries, actions); `Alt+1…9` jumps between workspaces.

```bash
make test       # 31 backend tests (offline, deterministic fake providers)
make build      # tsc + lint + production build of the frontend
```

## What's in the box

| Area | Where | Notes |
|---|---|---|
| Market data | `backend/atlas/data/` | ECB reference rates via Frankfurter (EUR/USD, GBP/USD, USD/JPY — **close only, no OHLC/volume**); Coinbase daily candles with Kraken failover (BTC/USD, ETH/USD). Validation, dedup, gap detection, content-hash dataset versions, gzip snapshots per version. |
| Research | `backend/atlas/research/` | Causal indicators, regime classifier, feature engineering with rank-IC importance, six strategies behind one `Strategy` interface (`strategies/library.py` — add a class + `@register`). |
| Backtesting | `backend/atlas/backtest/` | Bar-by-bar engine: next-bar fills, spread/fee/slippage, ATR stops/targets, order ledger, attribution. Chronological train/validation/test splits, rolling walk-forward, cost stress, parameter neighbourhood, PSR/deflated Sharpe, block bootstrap. |
| Forecasting | `backend/atlas/forecasting/` | Five baselines with Gaussian intervals, rolling-origin evaluation, calibration, regime-specific error. |
| Agents | `backend/atlas/agents/` | Market Intelligence, Strategy Discovery, Backtesting, Risk Analysis, Research Critic, Portfolio Research, Orchestrator. Deterministic; every run logged with inputs/outputs/errors. Optional LLM *narration* of reports (off by default). |
| Autonomy | `backend/atlas/jobs.py` | Persistent job queue with cancellation, runtime limits and crash recovery; scheduler with interval/daily caps. Runs only while the process is alive — a stopped Codespace pauses it. |
| Paper trading | `backend/atlas/paper/` | Virtual account, market/limit orders, fills at last close ± frictions, positions, snapshots, start/pause/emergency-stop, automatic signal execution for deployed strategies. |
| Risk | `backend/atlas/risk/` | Drawdown, daily loss, per-position/gross/per-strategy exposure, order size, correlation clusters, volatility regime, data staleness, consecutive losses, kill switch. Enforced on every order server-side; every decision audited. |
| Frontend | `frontend/src/` | React 19 + TypeScript + Vite + Tailwind 4 + Lightweight Charts. Nine workspaces; the computation graph's topology comes from the database and animates only on real backend events. |

## Configuration

All settings are `ATLAS_*` environment variables (or `backend/.env`); see `backend/atlas/config.py`.
No API keys are required for the default providers.

Optional LLM narration of research reports:

```bash
pip install anthropic
export ATLAS_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=...      # never commit this
```

The LLM only rewrites already-computed numbers as prose; it makes no research or trading decisions.

## Legacy files

`app.py` (Streamlit) and `index.html` (ATLAS V6 single-page prototype) are the previous versions,
kept for reference. They are not used by the new platform.

## Marketing assets

Genuine captures of the running product (no mock data) live in `marketing/`:

- `marketing/screenshots/` — 3200×2000 desktop PNGs and a 1170×2532 mobile PNG.
- `marketing/recordings/` — 1920×1080 H.264 MP4 clips of real interactions (one clip runs a real research cycle).
- `marketing/tools/` — the Playwright scripts that produced them. To re-film: `npm i playwright && npx playwright install --with-deps chromium`, start both servers, then `node marketing/tools/market.mjs marketing all`.
