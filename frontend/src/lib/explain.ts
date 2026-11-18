// Plain-language translations of research terminology. Used so a user never needs backend vocabulary.

export const CHECK_PLAIN: Record<string, { short: string; long: string }> = {
  sample_size: { short: 'Too few trades', long: 'It made too few trades in the held-out period to tell skill from luck.' },
  oos_sharpe: { short: 'Weak in selection test', long: 'On the later selection-test period, not used for fitting, its risk-adjusted return was too low.' },
  validation_sharpe: { short: 'Failed validation', long: 'It lost money, after risk, in the validation period between design and final test.' },
  is_oos_decay: { short: 'Overfit', long: 'It looked much better on the data it was designed on than on new data — a classic sign of overfitting.' },
  deflated_sharpe: { short: 'Likely luck', long: 'Given how many ideas have been tried, a result this good is plausible by chance alone.' },
  bootstrap_p: { short: 'Not significant', long: 'Resampling the returns shows the average gain is not reliably above zero.' },
  cost_robustness: { short: 'Fragile to costs', long: 'With trading costs doubled, the edge disappears.' },
  parameter_stability: { short: 'Fragile settings', long: 'Small changes to its settings break it, so the result probably depends on lucky tuning.' },
  drawdown: { short: 'Drawdown too deep', long: 'Its worst peak-to-trough loss in the test period exceeded the limit.' },
  walk_forward: { short: 'Inconsistent over time', long: 'When re-tuned and re-tested period by period, it did not hold up consistently.' },
  beats_benchmark: { short: 'Below buy-and-hold', long: 'Simply holding the instrument would have done better on a risk-adjusted basis (advisory).' },
  profit_concentration: { short: 'A few lucky trades', long: 'Most of the profit came from a handful of trades (advisory).' },
  fdr: { short: 'Explained by the number of ideas tried', long: 'Across every idea you have tested, a result this strong is expected by chance (false-discovery control).' },
  holdout_confirmation: { short: 'Failed on sealed data', long: 'Its single look at sealed data it was never selected on did not confirm the result.' },
  data: { short: 'Data unavailable', long: 'The data this result used is no longer available.' },
}

export function checkName(reason: string): string {
  return reason.split(':')[0].trim()
}

export function plainReasons(reasons: string[] | null | undefined, max = 3): string[] {
  return (reasons ?? []).map(checkName).filter((n) => CHECK_PLAIN[n]).slice(0, max).map((n) => CHECK_PLAIN[n].short)
}

export const STRATEGY_PLAIN: Record<string, string> = {
  ma_crossover: 'Follows the trend when a fast moving average crosses a slow one.',
  donchian_breakout: 'Buys breakouts to new highs and sells breakdowns to new lows.',
  bollinger_reversion: 'Bets that unusually stretched prices snap back toward their average.',
  rsi_reversion: 'Buys short-term dips inside an uptrend (and the reverse in a downtrend).',
  ts_momentum: 'Positions in the direction of the recent multi-week move.',
  mtf_vol_trend: 'Trades the daily trend only when the weekly trend agrees and volatility is calm.',
}

export const AGENT_PLAIN: Record<string, { role: string; verb: string }> = {
  orchestrator: { role: 'Runs the research cycle and records every decision.', verb: 'Coordinating' },
  market: { role: 'Refreshes market data, checks its quality and reads the current regime.', verb: 'Reading markets' },
  discovery: { role: 'Proposes testable strategy ideas suited to current conditions.', verb: 'Proposing ideas' },
  backtester: { role: 'Tests each idea on historical data it was not designed on.', verb: 'Testing ideas' },
  risk_analyst: { role: 'Measures drawdowns, tail risk and how ideas could fail.', verb: 'Stress-testing' },
  critic: { role: 'Rejects anything that could be luck, overfitting or too fragile.', verb: 'Reviewing evidence' },
  portfolio: { role: 'Combines surviving strategies and sizes them sensibly.', verb: 'Allocating' },
}

export const REGIME_PLAIN: Record<string, string> = {
  trend_up: 'Trending up', trend_down: 'Trending down', range: 'Range-bound',
  low_vol: 'calm', normal_vol: 'normal volatility', high_vol: 'volatile',
}

export function greeting(d = new Date()) {
  const h = d.getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export const STRATEGY_NAME: Record<string, string> = {
  ma_crossover: 'Moving-average crossover', donchian_breakout: 'Channel breakout', bollinger_reversion: 'Bollinger mean reversion',
  rsi_reversion: 'RSI dip-buying', ts_momentum: 'Time-series momentum', mtf_vol_trend: 'Multi-timeframe trend',
}
export const strategyName = (k: string | null | undefined) => (k ? STRATEGY_NAME[k] ?? k.replace(/_/g, ' ') : '—')

export const shortDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}


/** Neutral names for critic checks (used with a pass/fail mark). */
export const CHECK_NAME: Record<string, string> = {
  sample_size: 'Enough trades', oos_sharpe: 'Strong in selection test', validation_sharpe: 'Passed validation', is_oos_decay: 'Not overfit',
  deflated_sharpe: 'Not explained by luck', bootstrap_p: 'Statistically significant', cost_robustness: 'Survives higher costs',
  parameter_stability: 'Stable to nearby settings', drawdown: 'Drawdown within limit', walk_forward: 'Consistent over time',
  beats_benchmark: 'Beats buy-and-hold', profit_concentration: 'Profits spread across trades',
  fdr: 'Survives false-discovery control', holdout_confirmation: 'Confirmed on sealed data',
}

/** Plain-language rendering of common engine events; falls back to the raw message. */
export function humanizeEvent(msg: string): string {
  let m: RegExpMatchArray | null
  if ((m = msg.match(/^(\S+): (\d+) bars, \+(\d+) new, version \w+ \((new dataset version|unchanged)\)/)))
    return +m[3] > 0 ? `${m[1]} updated with ${m[3]} new day${m[3] === '1' ? '' : 's'} of data` : `${m[1]} checked — already up to date`
  if ((m = msg.match(/^Fetching (\S+) from (\w+)/))) return `Checking ${m[2] === 'frankfurter' ? 'the ECB' : m[2][0].toUpperCase() + m[2].slice(1)} for new ${m[1]} data`
  if ((m = msg.match(/^Job #\d+: refreshing (\S+)/))) return `Refreshing ${m[1]}`
  if ((m = msg.match(/^(Completed|Started|Queued) (\w+) job #(\d+)/))) {
    const name = ({ data_refresh: 'Market data refresh', research_cycle: 'Research cycle' } as Record<string, string>)[m[2]] ?? m[2]
    return `${name} ${m[1] === 'Completed' ? 'finished' : m[1] === 'Started' ? 'started' : 'queued'}`
  }
  if ((m = msg.match(/^Forecast (\w+) h=(\d+) on (\S+)/))) return `Forecast generated for ${m[3]}, ${m[2]} days ahead`
  if ((m = msg.match(/^Experiment #(\d+) (\w+) (\S+): (.+)$/))) return `${strategyName(m[2])} on ${m[3]}: ${m[4]} (#${m[1]})`
  if ((m = msg.match(/^Manual backtest #(\d+): (\w+) on (\S+) → (\S+)/))) return `You backtested ${strategyName(m[2])} on ${m[3]}: ${m[4]}`
  if ((m = msg.match(/^REJECTED (\S+) /))) return `A paper order on ${m[1]} was blocked by risk limits`
  if ((m = msg.match(/^APPROVED (\S+) /))) return `A paper order on ${m[1]} passed every risk check`
  if ((m = msg.match(/^Paper tick: \{'limit_fills': (\d+), 'orders': (\d+)/))) return `Paper engine evaluated strategies — ${m[2]} order${m[2] === '1' ? '' : 's'} placed`
  if ((m = msg.match(/^(.+?) started$/))) return `${m[1]} began work`
  if ((m = msg.match(/^(.+?) finished in (\d+) ms: (.*)$/))) return `${m[1]} finished${m[3] ? ` — ${m[3]}` : ''}`
  return msg
}

/** Research outcomes (methodology v2). Never "approved" or "accepted": survival is evidence, not a recommendation. */
export type Disposition = 'survived' | 'rejected' | 'insufficient_evidence' | 'requires_confirmation' | 'requires_revalidation'
export const DISPOSITION: Record<Disposition, { label: string; short: string; tone: 'up' | 'dn' | 'am' | 'mute'; explain: string }> = {
  survived: { label: 'Survived current validation', short: 'Survived', tone: 'up', explain: 'It passed every blocking test, including the correction for how many ideas have been tried and a single look at sealed data it was never selected on. This is evidence under stated assumptions, not a promise of future profit.' },
  rejected: { label: 'Rejected during testing', short: 'Rejected', tone: 'dn', explain: 'At least one blocking test failed.' },
  insufficient_evidence: { label: 'Insufficient evidence', short: 'Insufficient evidence', tone: 'am', explain: 'There were too few trades to judge either way.' },
  requires_confirmation: { label: 'Requires out-of-sample confirmation', short: 'Awaiting confirmation', tone: 'am', explain: 'It passed every research test. It still has to hold up on market data that arrives after it was selected — about three months of new data — before it can be called a survivor.' },
  requires_revalidation: { label: 'Requires revalidation', short: 'Requires revalidation', tone: 'mute', explain: 'The data this result used is no longer available, so it cannot be reproduced or re-checked.' },
}
export const dispositionOf = (e: { disposition?: string | null; verdict?: string | null }): Disposition | null =>
  (e.disposition as Disposition) ?? (e.verdict === 'accepted' ? 'requires_revalidation' : e.verdict ? 'rejected' : null)
