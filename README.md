# ATLAS — personal trading research and paper-trading tool

A personal tool (not a product) for learning to research and paper-trade Micro Nasdaq-100 futures (MNQ):
real market data, a backtester with walk-forward evaluation and deflated Sharpe, deterministic research
agents, and a **paper-only** broker behind a risk layer. Concepts and design choices are explained in
[`docs/LEARN.md`](docs/LEARN.md).

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

Keyboard: `⌘K` / `Ctrl+K` or `/` opens search (workspaces, instruments, discoveries, actions); `Alt+1…9` jumps between workspaces.

```bash
make test       # backend tests (offline, deterministic fake providers)
make build      # tsc + lint + production build of the frontend
```

## Intraday MNQ track (personal learning tool)

```bash
# 1. Add free keys to backend/.env (see docs/LEARN.md "Adding your data keys"), then download + run the data gate:
cd backend && set -a && . ./.env && set +a && ../.venv/bin/python -m atlas.futures.gate --download
# 2. Start the app (two terminals), then open port 5173 → Trading → Intraday (MNQ)
make backend
make frontend
```

The gate exits 0 when passed, 1 when failed, and 2 when not run (missing keys or no data).

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
