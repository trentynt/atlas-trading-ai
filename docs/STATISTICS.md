# SIGNAL validation methodology (v2)

This document describes how SIGNAL decides whether a research finding survives, which statistical safeguards it applies, what they assume, and what they cannot do. Code: `backend/atlas/research/{integrity,registry,validation,revalidate}.py`. Tests: `backend/tests/test_integrity.py`.

**A finding that survives validation is evidence under the stated assumptions. It is never proof of future profitability.**

## 1. The problem being solved

Testing many strategy ideas on the same history guarantees that some will look good by chance. Before v2, SIGNAL:

- judged every hypothesis on one shared final test window (25 ETH/USD tests used 4 near-identical windows), so the "unseen" window was repeatedly used for selection;
- counted only hypothesis-level tests, ignoring parameter variants, manual backtests and manual validations;
- applied no family-wise or false-discovery control (each p-value was judged alone at 0.20).

## 2. Data windows

For each user and market the history is split, in time order:

| Window | Used for |
|---|---|
| Warm-up (first 252 bars) | indicator initialisation only |
| Train (60% of research window) | designing / fitting |
| Validation (20%) | checking before selection |
| Selection test (20%) | the out-of-sample gates below |
| **Sealed holdout** | a single confirmation look per configuration |

The research window is everything before the sealed holdout. `full_evaluation` only ever receives research-window data (`test_research_evaluation_cannot_see_holdout` poisons the holdout ×25 and verifies identical results).

### Sealing policy (`TrialRegistry.holdout_start`)
- **Market never researched before:** the last 20% of history is sealed at first use.
- **Market already researched:** all existing history has already been used for selection, so no part of it can honestly be called unseen. The holdout is **forward-only**: it starts the day after the latest bar at sealing time and fills as new data arrives. This applies to EUR/USD, GBP/USD, USD/JPY, BTC/USD and ETH/USD.
- Sealing is permanent and recorded (`kv: holdout:{user}:{symbol}`).
- A forward holdout needs ≥ 90 daily bars (crypto) or ≥ 63 (forex) before a confirmation is attempted. Until then a finding that passes every research gate is labelled **Requires out-of-sample confirmation**.

## 3. Trial registry

Every attempt is recorded permanently in `trials`: user, cycle, strategy family, hypothesis key, parameters, dataset version, code version, window, method, Sharpe, per-bar Sharpe, p-value, research-window return series (float32), disposition, timestamp, and whether it touched the holdout.

Kinds: `hypothesis`, `variant` (parameter neighbours searched during walk-forward / stability checks), `manual_backtest`, `manual_validation`. Repeating an identical configuration is counted again (it is a repeated search). Nothing is deleted.

**Known undercount:** manual validations run before the registry existed (before v2) were never stored, so the historical count is a lower bound.

## 4. Gates (all blocking unless marked advisory)

| Gate | Threshold | Purpose |
|---|---|---|
| Sample size | ≥ 15 trades in the selection test | enough events to judge |
| Selection-test Sharpe | ≥ 0.30 annualised | economic floor after costs |
| Validation Sharpe | > 0 | consistency before selection |
| Decay | selection/design Sharpe ≥ 0.25 | overfitting signal |
| **Deflated Sharpe Ratio** | ≥ 0.95 | luck given the search effort (§5.1) |
| **False discovery** | Benjamini–Yekutieli q ≤ 0.10 | multiplicity across all hypotheses (§5.2) |
| Cost stress | Sharpe > 0 at 2× costs | fragility to frictions |
| Parameter stability | ≥ 50% of neighbouring settings positive (train+validation) | isolated peaks |
| Drawdown | ≥ −35% in selection test | risk |
| Walk-forward | ≥ 50% positive folds, mean OOS Sharpe > 0 | stability over time |
| Beats buy-and-hold | advisory | context only |
| **Sealed holdout** | ≥ 5 trades, Sharpe > 0, drawdown ≥ −35%, HAC p ≤ 0.05 / k | single confirmation look (§5.3) |

Dispositions: **Survived current validation** (all gates incl. holdout) · **Rejected during testing** · **Insufficient evidence** (only the sample-size gate failed, or data missing) · **Requires out-of-sample confirmation** (all research gates passed, holdout not yet long enough) · **Requires revalidation** (the original dataset snapshot is unavailable).

## 5. Multiple-testing safeguards

### 5.1 Deflated Sharpe Ratio with an effective trial count
DSR (Bailey & López de Prado 2014) is the Probabilistic Sharpe Ratio of the selection-test returns against the Sharpe ratio expected from the best of N unskilled trials:

SR₀ = √V · [(1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))], γ ≈ 0.5772,

where V is the cross-trial variance of per-bar Sharpe ratios. PSR adjusts for sample length, skewness and kurtosis.

**N is the effective number of independent trials**, not the raw count. Variants of one idea are highly correlated; counting them raw overstates N, and ignoring them understates it. SIGNAL estimates N_eff from the eigenvalues λ of the correlation matrix of research-window returns of all hypothesis and variant trials for the market (Galwey 2009):

N_eff = (Σ √λᵢ)² / Σ λᵢ

which equals 1 for identical strategies, k for k independent ones, and k for k independent blocks of identical ones. Manual runs (different windows) are added as fully independent — the conservative choice. Li & Ji (2005) was considered and rejected: its floor term makes the estimate jump under sampling noise (verified in tests).

*Assumptions:* returns are stationary over the window; the normal approximation in PSR holds after the skew/kurtosis adjustment; the cross-trial Sharpe variance is estimated from the recorded trials.

### 5.2 False discovery rate — Benjamini–Yekutieli
Each hypothesis gets a one-sided p-value for "mean return > 0" from a **Newey–West (HAC) t-test** on selection-test returns (Bartlett kernel, lag ⌊4(n/100)^{2/9}⌋). HAC is used because strategy returns are autocorrelated (verified: HAC is more conservative than the naive t-test on an AR(1) series), and because a continuous p-value is needed — a 1,000-draw bootstrap cannot resolve the very small p-values FDR procedures require.

The family is **every hypothesis-level trial the user has ever run**, across all markets. SIGNAL applies **Benjamini–Yekutieli** at q = 0.10. BY controls FDR under arbitrary dependence. Benjamini–Hochberg was rejected because it requires positive regression dependence (PRDS), which fails for strategy families that include opposing positions (trend vs. mean reversion, long vs. short). Holm (FWER) is available as a diagnostic but not used as a gate: with correlated tests it is far more conservative than the claim being made.

Positives are re-checked after every cycle: if the growing family pushes a finding's q above 0.10 it is demoted ("no longer significant as more ideas were tested") and any paper strategy using it is retired.

### 5.3 Sealed holdout with a Bonferroni split
Only configurations that pass every research gate may look at the holdout, and each configuration looks **once** (enforced by a unique index in `holdout_evaluations`; repeated requests return the stored result). Because several configurations may each take their one look, the k-th look on a market must reach HAC p ≤ 0.05 / k (Bonferroni across looks, valid under any dependence).

### Considered and not implemented (yet)
- **White's Reality Check / Hansen's SPA test:** statistically appropriate (they test the best of many strategies on a common sample with a bootstrap). Not implemented because research-window returns are only stored for hypothesis and variant trials, and differing windows across manual runs complicate the common-sample requirement. Planned.
- **Probability of Backtest Overfitting (CSCV):** requires a large, pre-specified grid on one sample; SIGNAL's search is sequential and adaptive.
- **Raw Bonferroni across all trials:** valid but so conservative with correlated variants that it would test the counting convention rather than the evidence.

## 6. Leakage and bias checks
- Signals and features are causal; orders fill on the next bar (`test_strategies_are_causal`, `test_features_are_causal`, `test_fills_happen_at_next_bar_open`).
- Weekly features become visible only after the week closes.
- Selection uses the research window only; the holdout is poisoned in tests to prove isolation.
- Survivorship: the instrument list is fixed in advance, not chosen by performance. It is small, which limits generality but does not bias selection.

## 7. Re-evaluation of legacy findings (run on this database)

`python -m atlas.research.revalidate --user 1` reloaded each experiment's own dataset snapshot, re-ran it on the research window, registered every hypothesis and variant, and judged all of them against the final family statistics.

| | Count |
|---|---|
| Legacy hypothesis tests re-evaluated | 50 |
| Legacy manual backtests registered as trials | 19 |
| Missing snapshots | 0 |
| **Survived current validation** | **0** |
| Rejected during testing | 50 |
| Paper strategies retired | 1 (strategy #1, sourced from experiment #18) |

Experiment #18 (Channel breakout, ETH/USD), previously "accepted": DSR fell from 0.77 (computed with 12 trials) to 0.32 against 94 recorded attempts on ETH/USD (≈35 effective); BY q = 1.0. Its earlier acceptance relied on a reused test window, an undercounted search and a lenient p ≤ 0.20 gate. No threshold was changed to preserve it.

## 8. Limitations
- Daily data only; five markets; the effective sample for any strategy is a few hundred to a few thousand days.
- Forward-only holdouts mean confirmation takes ~3 months of new data for markets already researched.
- PSR/DSR rely on asymptotic normality; HAC p-values are large-sample.
- Trial counts before v2 are a lower bound (unrecorded manual validations).
- All results are historical simulations with modelled costs; live execution would differ.

## References
Bailey & López de Prado (2014), *The Deflated Sharpe Ratio*, J. Portfolio Management · Bailey & López de Prado (2012), *The Sharpe Ratio Efficient Frontier* (PSR) · Benjamini & Yekutieli (2001), Annals of Statistics · Benjamini & Hochberg (1995), JRSS-B · Holm (1979), Scand. J. Statistics · Newey & West (1987, 1994) · Galwey (2009), Genetic Epidemiology · Li & Ji (2005), Heredity · White (2000), Econometrica · Hansen (2005), JBES.
