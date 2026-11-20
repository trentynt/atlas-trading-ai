# Learning notes

Plain-language explanations of how ATLAS works and why it was built this way. Facts about the outside world
are labelled **VERIFIED** (with source and date), **INFERENCE** (reasoned, not confirmed) or **SPECULATION**.

## Phase 0: repository cleanup

### Why the data code was missing from git
`.gitignore` contained the line `data/`. Without a leading slash, git applies a rule like that to **every**
folder named `data` anywhere in the repo. It was meant for the top-level `data/` folder (the SQLite database
and snapshots), but it also hid `backend/atlas/data/`, the market-data source code. A fresh clone could not
start. The fix anchors the rules to the repo root: `/data/*.db*` and `/data/snapshots/`.

### Why the codespace branch was merged with the "ours" strategy
That branch was an older copy of the same app, plus compiled `.pyc` files and a database. A normal merge
would have written the old database over the current one, because git overwrites ignored files without
asking. The "ours" strategy records the branch as merged in history but keeps today's files unchanged.

### Counting every attempt: why deflated Sharpe needs an all-time trial count
If you try enough random ideas, one will look good by luck. Deflated Sharpe asks: "given how many ideas
were tried, how likely is it that this result beats the best one luck alone would produce?" That only works
if the count includes **every** attempt ever made, not just today's batch. ATLAS stores every attempt
permanently in the `trials` table: hypotheses, parameter variants and manual backtests.

Two fixes in this phase:
- **No cap.** The correlation-based estimate of how many attempts were truly independent looks at the latest
  300 attempts (correlations among thousands of series are slow). Older attempts used to be ignored. Now each
  one is added as if fully independent. That can only make the test stricter.
- **Global count.** Besides the count for one market, ATLAS now counts attempts across all markets
  (effective counts are summed: an upper bound, since markets are treated as independent of each other).
  Pass/fail uses whichever count gives the lower deflated Sharpe, i.e. the stricter one.

## Phase 1: the MNQ contract and its costs

**VERIFIED** (CME Group, Micro E-mini Nasdaq-100 contract specs page,
<https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.contractSpecs.html>, read 2026-11-20
via CME's own page text in search results; the page itself timed out from this environment):
MNQ is **$2 × the Nasdaq-100 index**, with a minimum price move (tick) of **0.25 index points = $0.50**. The
full-size NQ is $20 × index with the same 0.25 tick ($5.00). One MNQ is one-tenth of an NQ.

### How futures profit and loss works
- Profit is **points × $2 × contracts**. A 10-point move on 1 MNQ is $20, whatever the index level.
- Prices move in whole ticks. 18,000.13 cannot trade; ATLAS snaps it to 18,000.25 (`round_to_tick`).
- Quantities are **whole contracts**. Asking for 1.5 contracts is an error, not something to round silently.

### Costs
- **Commission:** a flat dollar amount per contract per side. A round turn (in and out) pays it twice.
  The default of **$0.62/side is a PLACEHOLDER: VERIFY** with your broker or Apex (the all-in figure
  includes exchange and NFA fees and differs between firms).
- **Slippage:** the gap between the price you expected and the price you got, measured in **ticks**.
  The default is 1 tick per side, always against you: buys fill higher, sells fill lower.
  INFERENCE: 1 tick is reasonable for 1–2 MNQ in liquid RTH hours and optimistic around news or the open.

### Worked example (it is a test: `test_known_long_round_turn_exact_dollars`)
Buy 2 MNQ at 18,000.00 and sell at 18,010.00, with $0.62/side commission and 1 tick of slippage.
- Fills: buy 18,000.25, sell 18,009.75, so 9.50 points captured.
- Gross: 9.5 × $2 × 2 = **$38.00**.
- Commission: $0.62 × 2 sides × 2 contracts = **$2.48**.
- Net: **$35.52**. Slippage cost $2.00 (already inside the fill prices).

A 10-point move turned into 9.5 points after slippage, and 7% of the gross went to commission. Costs
like this are why small, frequent intraday edges often vanish.

## Phase 2: minute data and the data-quality gate

### Why QQQ instead of NQ/MNQ (a PROXY)
- **VERIFIED** (Yahoo Finance via yfinance docs, 2026-11-20): Yahoo serves 1-minute bars for only about the
  last 30 days. That is far short of 3 years.
- **VERIFIED** (Barchart, FirstRate Data, PortaraCQG product pages, 2026-11-20): multi-year 1-minute NQ
  futures history is sold, not free. QuantConnect staff say exchange licensing prevents them from allowing
  futures data downloads.
- So ATLAS uses **QQQ**, the ETF that holds the Nasdaq-100 stocks, as a **proxy** for the index MNQ follows.
  - **INFERENCE:** QQQ's 1-minute returns during regular hours track NQ very closely. They are not
    identical: futures trade nearly 24 hours, carry a small premium or discount (the basis) to the index,
    and QQQ pays dividends.
  - Everything built on this data is a **proxy** result, labelled as such.

### The sources
- **Minute bars: Alpaca Market Data API, free plan.**
  - **VERIFIED** (docs.alpaca.markets, "About Market Data API" and Alpaca staff forum reply, 2026-11-20):
    the free plan can query full-market SIP bars older than 15 minutes. The docs list history "since 2016",
    but that figure was not confirmed for the current plan; gate G1 measures it directly.
  - ATLAS asks for **raw** (unadjusted) prices and keeps only regular-hours bars (09:30–15:59 New York time,
    each labelled by its start minute).
- **Independent daily closes: Tiingo end-of-day API, free plan.**
  - **VERIFIED** (api.tiingo.com product pages, 2026-11-20): the free plan allows 50 requests an hour and
    1,000 a day, for internal use only.
  - ATLAS uses the raw `close`, not the dividend-adjusted `adjClose`.
- **Not used:**
  - Yahoo's daily endpoint and Stooq both block automated requests (HTTP 429, and a browser check).
    ATLAS does not disguise itself as a browser to get around that.
  - The Nasdaq API timed out.

### The gate, and why its thresholds are fixed first
If you set pass marks after seeing the data, you will (often unconsciously) choose marks the data passes.
The thresholds sit in `backend/atlas/futures/gate.py` as a read-only table, dated 2026-11-20, and a test
pins their values.

| Check | Question | Pass mark |
|---|---|---|
| G1 | Is there enough history? | ≥ 3 years |
| G2 | Are sessions complete? | Median session has ≥ 380 of 390 one-minute bars |
| G3 | Are prices right? | Close of the 15:59 bar within 10 bps (0.10%) of Tiingo's close on ≥ 95% of days |
| G4 | Are the open and close there? | 09:30 and 15:59 bars both present on ≥ 95% of days |

Trading days come from Tiingo, the **independent** source. A day with no minute data at all is counted
as a miss, never skipped.
- **INFERENCE:** G3 is demanding. The official close is set by a closing auction at 16:00, while the 15:59
  bar ends a minute earlier, so a few volatile closes may differ by more than 10 bps.
- **INFERENCE:** half-day sessions (13:00 close, about 3 a year) have no 15:59 bar. That is too few to
  matter at the 95% level.

### Adding your data keys
Both are free accounts you create yourself:
1. **Alpaca:** sign up at alpaca.markets and create **paper-trading API keys** (ATLAS only reads market
   data with them).
2. **Tiingo:** sign up at tiingo.com and copy your API token.
3. Add them to `backend/.env`. That file is git-ignored; never commit it.
   ```
   ALPACA_API_KEY_ID=...
   ALPACA_API_SECRET_KEY=...
   TIINGO_API_KEY=...
   ```
4. Download the data and run the gate (3.5 years of history, roughly 30–60 minutes the first time):
   ```
   cd backend && set -a && . ./.env && set +a && ../.venv/bin/python -m atlas.futures.gate --download
   ```
   Exit code 0 means passed, 1 failed, 2 not run (missing keys or no data).
