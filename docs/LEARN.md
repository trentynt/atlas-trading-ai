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

## Phase 3: the intraday backtester

Code: `backend/atlas/futures/engine.py`; tests: `backend/tests/test_intraday_engine.py`.

### Rules the engine enforces, and why
- **Decide on the close, act on the next open.** A signal computed at the close of the 10:15 bar fills at
  the open of the 10:16 bar. Filling at the close you used to decide would assume you can trade at a
  price you only learned after it happened.
- **Stops and targets are set in ticks** from your actual fill. If one bar touches both, the engine assumes
  the **stop** happened first. A 1-minute bar doesn't say which came first, so the worse case is assumed.
- **Gaps:** if a bar opens beyond your stop, you are filled at the open (worse than the stop), not at the
  stop. That is what happens to real stop orders.
- **No immediate re-entry** in the same direction after a stop or target exit; the signal has to reset first.
- **Regular Trading Hours only** (09:30–16:00 New York). Orders never carry overnight. Any open position
  is closed on the session's last bar, and a signal on that bar is dropped. You are always flat overnight.
- **No new positions after 15:50** (configurable). Exits are still allowed.
- **Daily loss limit:** once the session's realised plus open P&L reaches −limit, the position exits at
  the next bar's open and the rest of the day is blocked. Prop-firm accounts enforce rules like this.
- **Whole contracts** and **dollar costs**, using the Phase 1 cost model on every fill. Targets also pay
  slippage, which is conservative: a real limit order may fill without it.
- **Trade log timestamps** include the time and the New York offset, e.g. `2025-03-04T09:31:00-05:00`.

### Annualisation, in plain words
A Sharpe ratio is "average return ÷ variability", scaled to a year. With minute bars, the per-minute
returns are mostly zero and not independent of each other, so scaling by √(252 × 390) would make results
look far more precise than they are. ATLAS sums P&L per **session** and scales daily returns by √252.

### Proving there is no look-ahead
Look-ahead bias means using information you could not have had at the time; it is the most common
reason backtests look too good. The tests check it three ways:
1. `assert_causal`: a signal computed on all data must equal the same signal computed on data cut off at
   any bar, up to that bar. Use it on every new signal function.
2. Delete the last sessions: every trade and equity value before the cut must be unchanged.
3. Scramble every price after a mid-session bar: trades finished before it, and equity up to it,
   must be unchanged.

### Apex rules
`backend/config/apex_rules.toml` is **deliberately empty**: VERIFY on apextraderfunding.com. ATLAS doesn't
guess prop-firm rules, and the loader refuses the file until you fill it in with the source page and date
and set `verified = true`. The engine already supports a daily loss limit; plug the verified value in.

## Phase 4: learning tools

Open the app and go to **Trading → Intraday (MNQ)**.

### Bar-by-bar replay
Pick a past session. You see one 1-minute bar at a time and step forward with **Next bar / +5 / +30**.
The app never sends bars beyond your cursor, so you cannot peek. This is the safest way to practise
reading the open without risking money or seeing the answer first.

### Proxy scaling
QQQ trades around $500 while the Nasdaq-100 index is around 20,000 points. To apply MNQ dollar maths,
replay prices are multiplied by `ATLAS_PROXY_SCALE` (default 41).
- **INFERENCE:** the index-to-QQQ ratio has been about 41 recently.
- Check it yourself: today's Nasdaq-100 level ÷ QQQ's price.
- It only changes the dollar size of results, never when anything happens.

### Opening statistics (descriptions, not strategies)
All sizes are in basis points (1 bp = 0.01%) so they carry over from QQQ to NQ. At an index level of
20,000, 10 bps ≈ 20 points ≈ $40 per MNQ.
- **Opening range:** the high and low of the first N minutes (5, 15, 30 or 60). How big it usually is, how
  often price later breaks above or below it, which side breaks first, how long that takes, and where the
  day closes relative to it.
- **Overnight gaps:** today's 09:30 open versus yesterday's 15:59 close. How often price trades back to
  yesterday's close ("fills") the same day, split by gap size, and how long it takes.
- **Volatility by time of day:** the typical size of a one-minute move in each 15-minute block. Most
  sessions are busiest near the open and the close.

These describe the past. A high break or fill rate is not, by itself, a trading edge: costs, how far price
travels after the break, and how often a stop gets hit decide that. Any strategy idea must later go
through the backtester and the multiple-testing checks.

## Phase 5: paper trading and the journal

### Practice (paper trading on replays)
During a replay, choose **Long / Short / Flat**. The choice fills at the **next bar's open**, using exactly
the same engine as the backtester. A test proves a practice session and a backtest with the same decisions
produce identical trades to the cent. The same rules apply: commission, slippage, whole contracts,
optional stop and target in ticks, optional daily loss limit, nothing new after 15:50, flat by the close.
Finished sessions are saved as paper trades.

**Why replays, not live data:**
- **VERIFIED:** Alpaca's free plan only serves bars older than 15 minutes.
- Practising on delayed "live" prices would teach the wrong reactions. Replays are honest about being
  historical.

**PAPER ONLY:** a test scans the code and fails if any trading or order endpoint (Alpaca trading API,
Tradovate, Rithmic, Interactive Brokers) appears. The only Alpaca host used is market data.

### Journal
Log every practice trade: date, side, contracts, times and prices, the setup you saw, notes, mistakes,
the lesson and a 1–5 rating. Net P&L is computed with the same MNQ cost model, e.g. 2 contracts long
18,000 → 18,010 = **$35.52**. Entries without prices (e.g. "no trade: choppy open") are allowed. Days
you chose not to trade are worth recording too.

## Data gate result (2026-11-20)

The first real run, on QQQ 1-minute bars from Alpaca and daily closes from Tiingo, **passed**:

| Check | Result | Pass mark |
|---|---|---|
| G1 history | 3.49 years (2023-05-23 → 2026-11-19) | ≥ 3 |
| G2 completeness | median session has 390 of 390 bars | ≥ 380 |
| G3 correctness | 99.2% of days within 10 bps; median gap 0.70 bps, 95th percentile 3.2 bps | ≥ 95% |
| G4 open and close bars | 100% of days | ≥ 95% |

### A bug the gate did not catch, found by looking at the numbers
The first run also passed, but 8 sessions had fewer than 380 bars while only 1 lacked a 15:59 bar. That
doesn't add up: a half-day (13:00 close) shouldn't have a 15:59 bar at all. Those afternoon bars were
**after-hours trades**, and the time filter had counted them as regular hours. The engine would have
traded thin after-hours prices, and the statistics would have used a 15:59 after-hours price as the close.

The fix, `backend/atlas/futures/calendar.py`:
- **Early-close calendar.** 2026–2028 dates are VERIFIED from the NYSE hours page (read 2026-11-20).
  2023–2025 dates are INFERENCE: the same NYSE rules, corroborated by the data. Every one of those days
  is truncated after 13:00, while normal sessions are complete.
- **Applied on read.** On early-close days the session ends at 12:59, the backtester stops new entries at
  12:50 and goes flat on the 12:59 bar, and the gate uses 12:59 as the last bar.
- **Incomplete sessions are excluded on read:** today's unfinished session, and the first stored day
  (the download began mid-afternoon). Nothing is deleted from the database.
- **The thresholds were not changed.** G2 now measures full-length sessions only; early-close days are
  expected to be short.

The lesson: a passing check is not proof. Numbers that don't fit together are worth chasing.

## Sealed holdout (2026-11-20)
Sessions **2026-02-20 → 2026-11-19** (the last ~9 months at sealing) are set aside in
`backend/atlas/futures/holdout.py`. Replay, opening statistics and backtests can't see them unless you pass an explicit
unlock reason. Every unlock is logged in `holdout_unlocks` (`GET /api/intraday/holdout`). The data gate is a logged reader too:
it checks quality only and produces no results. Sessions after 2026-11-19 are never sealed.

Why: once you've looked at a period while forming ideas, it can no longer test them honestly. Keep this one for a single
final check of an idea designed on the open data.
