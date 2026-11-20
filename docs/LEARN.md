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
