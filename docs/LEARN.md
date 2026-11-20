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
