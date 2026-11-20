import { useEffect, useMemo, useRef, useState } from 'react'
import type { ViewProps } from '../App'
import { Histogram } from '../components/charts/Svg'
import { TimeChart, toLine } from '../components/charts/TimeChart'
import { Button, Disclosure, EmptyState, ErrorBox, Field, HistTag, InfoTip, KeyValue, Legend, Loading, NEUTRAL, Notice, Panel, PageHeader, SERIES, Spinner, Stat, StatusDot } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { STRATEGY_PLAIN, shortDate, strategyName } from '../lib/explain'
import { money, num, pct, tone } from '../lib/format'
import { paramToSym, useRoute } from '../lib/route'
import type { BacktestPayload, Market, StrategySpec } from '../lib/types'

const FAMILY: Record<string, string> = { trend: 'Trend', breakout: 'Breakout', mean_reversion: 'Mean reversion', momentum: 'Momentum' }
const PARAM_LABEL: Record<string, string> = {
  fast: 'Fast average (days)', slow: 'Slow average (days)', exponential: 'Use exponential averages', entry: 'Breakout window (days)', exit: 'Exit window (days)',
  window: 'Look-back (days)', entry_z: 'Enter when stretched by (σ)', exit_z: 'Exit when within (σ)', n: 'RSI length (days)', oversold: 'Oversold level',
  trend: 'Trend filter (days)', lookback: 'Momentum look-back (days)', threshold: 'Signal threshold (vol units)', daily_fast: 'Daily fast average',
  daily_slow: 'Daily slow average', max_vol_pct: 'Skip when volatility above percentile', stop_atr: 'Stop-loss (× average daily range)',
  take_profit_atr: 'Take-profit (× average daily range)', allow_short: 'Allow short positions',
}
const ADVANCED = new Set(['stop_atr', 'take_profit_atr', 'allow_short'])

export function StrategyView({ go }: ViewProps) {
  const { params: rp } = useRoute()
  const specs = useApi<StrategySpec[]>('/strategies')
  const markets = useApi<Market[]>('/markets')
  const rules = useApi<{ critic_rules: Record<string, number> }>('/experiments-stats/distribution')
  const [key, setKey] = useState(rp.get('strategy') ?? 'ma_crossover')
  const [sym, setSym] = useState(rp.get('sym') ? paramToSym(rp.get('sym')!) : 'BTC/USD')
  const [params, setParams] = useState<Record<string, number | boolean>>({})
  const [sizing, setSizing] = useState<'fixed_fraction' | 'vol_target'>('fixed_fraction')
  const [start, setStart] = useState('')
  const [includeHoldout, setIncludeHoldout] = useState(false)
  const [costMult, setCostMult] = useState(1)
  const [res, setRes] = useState<BacktestPayload | null>(null)
  const [ev, setEv] = useState<any>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const spec = specs.data?.find((s) => s.key === key)

  useEffect(() => {
    if (spec) setParams(Object.fromEntries(spec.params.map((p) => [p.name, p.default])))
  }, [spec])

  const friction = scaledCosts(markets.data?.find((x) => x.symbol === sym)?.costs, costMult)
  const bt = useAction(async () => {
    setEv(null)
    const r = await api.post<BacktestPayload>('/backtest', { symbol: sym, strategy: key, params, sizing, start: start || null, costs: costMult === 1 ? {} : friction, include_holdout: includeHoldout })
    setRes(r)
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
  const evaluate = useAction(async () => {
    setEv(await api.post('/evaluate', { symbol: sym, strategy: key, params }))
    setTimeout(() => document.getElementById('validation')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  })
  const busy = bt.pending || evaluate.pending

  const paramField = (p: StrategySpec['params'][number]) => (
    <Field key={p.name} label={PARAM_LABEL[p.name] ?? p.name} hint={p.description}>
      {p.kind === 'bool' ? (
        <select value={String(params[p.name] ?? p.default)} onChange={(e) => setParams({ ...params, [p.name]: e.target.value === 'true' })}><option value="true">Yes</option><option value="false">No</option></select>
      ) : (
        <input type="number" step={p.kind === 'int' ? 1 : 0.1} min={p.low ?? undefined} max={p.high ?? undefined} value={String(params[p.name] ?? p.default)} onChange={(e) => setParams({ ...params, [p.name]: Number(e.target.value) })} />
      )}
    </Field>
  )

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Strategies" title="Test a trading idea"
        subtitle="Pick a strategy and a market, then see how it would have performed — including costs — and whether it holds up on data it has never seen." />

      <div className="grid grid-cols-12 gap-5">
        <div className="col-span-12 space-y-5 xl:col-span-5 2xl:col-span-4">
          <Panel title="1. Choose a strategy">
            {!specs.data ? <Loading rows={4} /> : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {specs.data.map((s) => (
                  <button key={s.key} onClick={() => { setKey(s.key); setRes(null); setEv(null) }} aria-pressed={key === s.key}
                    className={`rounded-[14px] px-3.5 py-3 text-left transition-all duration-150 ${key === s.key ? 'bg-cy/[0.08] ring-1 ring-inset ring-cy/45' : 'bg-white/[0.025] ring-1 ring-inset ring-white/[0.06] hover:bg-white/[0.05]'}`}>
                    <div className="flex items-center justify-between gap-2"><span className="text-[13.5px] font-medium text-white">{strategyName(s.key)}</span></div>
                    <div className="mt-0.5 text-[12px] text-ink-300">{FAMILY[s.family] ?? s.family}</div>
                    <p className="mt-1.5 text-[12.5px] leading-snug text-ink-200">{STRATEGY_PLAIN[s.key]}</p>
                  </button>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="2. Choose a market">
            <div className="flex flex-wrap gap-2">
              {markets.data?.map((m) => (
                <button key={m.symbol} onClick={() => { setSym(m.symbol); setRes(null); setEv(null) }} aria-pressed={sym === m.symbol}
                  className={`rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${sym === m.symbol ? 'bg-white text-ink-950' : 'bg-white/[0.06] text-ink-100 hover:bg-white/[0.1]'}`}>{m.symbol}</button>
              ))}
            </div>
            {markets.data?.find((m) => m.symbol === sym)?.asset_class === 'fx' && <p className="mt-3 text-[12.5px] text-ink-300">Forex uses daily ECB reference rates, so simulated orders fill at the next day's rate.</p>}
          </Panel>

          {spec && (
            <Panel title="3. Settings" subtitle="Defaults are sensible starting points.">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{spec.params.filter((p) => !ADVANCED.has(p.name)).map(paramField)}</div>
              <div className="mt-4">
                <Disclosure title="Advanced: risk, sizing and costs">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {spec.params.filter((p) => ADVANCED.has(p.name)).map(paramField)}
                    <Field label="Position size" hint="Fixed: full notional. Volatility target: scales size to aim for 10% annual volatility.">
                      <select value={sizing} onChange={(e) => setSizing(e.target.value as typeof sizing)}><option value="fixed_fraction">Full position (1×)</option><option value="vol_target">Volatility target (10%)</option></select>
                    </Field>
                    <Field label="Trading costs" hint="Stress-test the idea against higher spreads, fees and slippage.">
                      <select value={costMult} onChange={(e) => setCostMult(Number(e.target.value))}><option value={1}>Realistic</option><option value={2}>Doubled</option><option value={3}>Tripled</option><option value={0}>None (unrealistic)</option></select>
                    </Field>
                    <Field label="Start date (optional)"><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
                    <label className="col-span-full flex items-start gap-2.5 text-[13px] text-ink-200">
                      <input type="checkbox" className="mt-0.5" checked={includeHoldout} onChange={(e) => setIncludeHoldout(e.target.checked)} />
                      <span>Include sealed data (exploratory). Results that use sealed data are labelled as such and never count as validation evidence.</span>
                    </label>
                  </div>
                  <p className="mt-3 text-[12px] text-ink-300">Costs per trade: spread {friction.spread_bps} bps · fee {friction.fee_bps} bps · slippage {friction.slippage_bps} bps.</p>
                </Disclosure>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button tone="primary" onClick={() => bt.run()} disabled={busy} icon={bt.pending ? <Spinner size={14} /> : undefined}>{bt.pending ? 'Testing…' : 'Run backtest'}</Button>
                <Button onClick={() => evaluate.run()} disabled={busy} icon={evaluate.pending ? <Spinner size={14} /> : undefined}>{evaluate.pending ? 'Validating…' : 'Validate on research data'}</Button>
              </div>
              <div className="mt-3"><ErrorBox error={bt.error || evaluate.error} /></div>
            </Panel>
          )}
        </div>

        <div ref={resultsRef} className="col-span-12 scroll-mt-4 space-y-5 xl:col-span-7 2xl:col-span-8">
          {!res && !ev && (
            <Panel>
              <EmptyState title="Results appear here" icon={<svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 17l5-5 4 4 8-8M14 8h6v6" /></svg>}
                action={<Button tone="primary" onClick={() => bt.run()} disabled={busy || !spec}>Run backtest</Button>}>
                <b className="font-medium text-ink-100">Backtest</b> replays history to show how the idea would have traded, net of costs.{' '}
                <b className="font-medium text-ink-100">Validate</b> goes further: it designs on older data and judges on newer data it never saw.
              </EmptyState>
            </Panel>
          )}
          {res && <BacktestResult r={res} sym={sym} strategy={key} onValidate={() => evaluate.run()} validating={evaluate.pending} />}
          {ev && <div id="validation" className="scroll-mt-4"><Validation ev={ev} rules={rules.data?.critic_rules} onResearch={() => go('research')} /></div>}
        </div>
      </div>
    </div>
  )
}

// Cost assumptions come from the backend instrument definition (backend/atlas/data/instruments.py).
function scaledCosts(base: Market['costs'] | undefined, mult: number) {
  if (!base) return {}
  return { spread_bps: base.spread_bps * mult, fee_bps: base.fee_bps * mult, slippage_bps: base.slippage_bps * mult }
}

function BacktestResult({ r, sym, strategy, onValidate, validating }: { r: BacktestPayload; sym: string; strategy: string; onValidate: () => void; validating: boolean }) {
  const m = r.metrics
  const eq = useMemo(() => [
    { kind: 'line' as const, id: 'eq', label: 'Strategy', color: SERIES[0], data: toLine(r.series.equity) },
    { kind: 'line' as const, id: 'bm', label: `Buy & hold ${sym}`, color: NEUTRAL, data: toLine(r.series.benchmark), dashed: true, width: 1 },
  ], [r, sym])
  const dd = useMemo(() => [{ kind: 'area' as const, id: 'dd', label: 'Drawdown', color: SERIES[3], data: toLine(r.series.drawdown) }], [r])
  const fmtMoney = useMemo(() => (v: number) => `$${Math.round(v).toLocaleString()}`, [])
  const start = Number(r.config.initial_cash ?? 100000)
  const end = start * (1 + (m.total_return ?? 0))
  const beat = (m.total_return ?? 0) > (r.benchmark.total_return ?? 0)
  return (
    <>
      <Panel title={`${strategyName(strategy)} on ${sym}`} tag={<HistTag />} subtitle={`${shortDate(m.start)} ${m.start?.slice(0, 4)} – ${shortDate(m.end)} ${m.end?.slice(0, 4)} · computed in ${r.runtime_ms} ms${r.experiment_id ? ` · saved as experiment #${r.experiment_id}` : ''}`}>
        <p className="text-[15px] leading-relaxed text-ink-100">
          Starting with <b className="text-white">{money(start)}</b>, this strategy would have ended with <b className={tone(m.total_return)}>{money(end)}</b> ({pct(m.total_return, 1)}) after costs.
          Simply holding {sym} returned <b className="text-white">{pct(r.benchmark.total_return, 1)}</b>, so it {beat ? 'beat' : 'trailed'} buy-and-hold.
          Its worst fall from a peak was <b className="text-dn">{pct(m.max_drawdown, 1)}</b>, across {m.num_trades} trades.
        </p>
        <Notice tone="vi">{r.holdout?.included ? 'Exploratory: this run includes sealed data, so it cannot count as validation evidence. ' : r.holdout?.policy === 'last_20pct' ? `Sealed data from ${r.holdout.start} is excluded. ` : ''}A single backtest over all history can flatter an idea. Validation separates design data from the data it is judged on.{' '}
          <button onClick={onValidate} disabled={validating} className="font-medium text-cy hover:underline">{validating ? 'Validating…' : 'Validate now →'}</button>
        </Notice>
        <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
          <Stat label="Annual return" value={pct(m.annualized_return, 1)} sub={m.annualized_return === null ? 'Less than a year' : 'Compounded'} />
          <Stat label="Sharpe ratio" value={num(m.sharpe)} sub={`Buy & hold ${num(r.benchmark.sharpe)}`} help="Return per unit of volatility. Above 1 is strong; below 0.5 is weak." />
          <Stat label="Win rate" value={pct(m.win_rate, 0, false)} sub={`Profit factor ${num(m.profit_factor)}`} />
          <Stat label="Time in market" value={pct(m.exposure, 0, false)} sub={`Avg hold ${num(m.avg_trade_bars, 0)} days`} />
        </div>
        <div className="mt-5"><Legend items={[{ label: 'Strategy', color: SERIES[0] }, { label: `Buy & hold ${sym}`, color: NEUTRAL, dashed: true }]} /></div>
        <TimeChart series={eq} height={300} format={fmtMoney} />
        <div className="mt-3 mb-1 text-[12.5px] text-ink-300">Drawdown — distance below the previous peak</div>
        <TimeChart series={dd} height={110} percent />
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Where the result came from">
          <KeyValue rows={[
            ['Long trades', <span className={tone(r.attribution.by_side.long?.pnl)}>{money(r.attribution.by_side.long?.pnl ?? 0)}</span>],
            ['Short trades', <span className={tone(r.attribution.by_side.short?.pnl)}>{money(r.attribution.by_side.short?.pnl ?? 0)}</span>],
            ...Object.entries(r.attribution.by_regime).filter(([k]) => k !== 'None' && k !== 'null').map(([k, v]) => [`In ${k.replace('_', ' ')} markets`, <span className={tone(v.pnl)}>{money(v.pnl)}</span>] as [string, React.ReactNode]),
            ['Before trading costs', <span className={tone(r.attribution.gross_pnl_before_costs)}>{money(r.attribution.gross_pnl_before_costs)}</span>],
            ['Trading costs paid', <span className="text-am">{money(r.attribution.total_costs)}</span>],
          ]} />
          <p className="mt-3 text-[12px] text-ink-300">{r.data_note}</p>
        </Panel>
        <Panel title="Every trade's return" subtitle={`${r.trades.length} closed trades`}>
          {r.trades.length ? <Histogram values={r.trades.map((t) => t.return)} color={SERIES[2]} xLabel="Return per trade" refLine={0} format={(v) => `${(v * 100).toFixed(0)}%`} /> : <EmptyState title="No trades">The strategy never entered a position in this period.</EmptyState>}
        </Panel>
      </div>

      <Disclosure title="Trade ledger" meta={`${r.trades.length} trades`}>
        <div className="scroll-thin max-h-[360px] overflow-auto rounded-[12px] ring-1 ring-white/[0.05]">
          <table className="data">
            <thead><tr><th>Side</th><th>Entry</th><th>Entry price</th><th>Exit</th><th>Exit price</th><th>Why it closed</th><th>Days</th><th>Costs</th><th>P&L</th><th>Return</th></tr></thead>
            <tbody>
              {[...r.trades].reverse().map((t, i) => (
                <tr key={i}>
                  <td className={t.side === 'long' ? 'text-up' : 'text-dn'}>{t.side === 'long' ? 'Long' : 'Short'}</td><td>{t.entry_ts}</td><td>{num(t.entry_price, 5)}</td>
                  <td>{t.exit_ts}</td><td>{num(t.exit_price, 5)}</td><td className="text-ink-300">{({ signal: 'Signal', stop_loss: 'Stop-loss', take_profit: 'Take-profit', end_of_test: 'End of test' } as Record<string, string>)[t.exit_reason] ?? t.exit_reason}</td>
                  <td>{t.bars_held}</td><td>{money(t.costs)}</td><td className={tone(t.pnl)}>{money(t.pnl)}</td><td className={tone(t.return)}>{pct(t.return)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Disclosure>
    </>
  )
}

function Validation({ ev, rules, onResearch }: { ev: any; rules?: Record<string, number>; onResearch: () => void }) {
  const wf = ev.walk_forward
  const eq = useMemo(() => [{ kind: 'line' as const, id: 'oos', label: 'Unseen-data equity', color: SERIES[1], data: toLine(wf?.oos_equity ?? []) }], [wf])
  const fmtMoney = useMemo(() => (v: number) => `$${Math.round(v).toLocaleString()}`, [])
  const R = { min_test_sharpe: 0.3, min_neighbour_positive: 0.5, max_test_drawdown: -0.35, min_test_trades: 15, ...(rules ?? {}) }
  const fam = ev.family
  const t = ev.test
  const checks: [string, boolean, string, string][] = [
    ['Enough trades to judge', t.num_trades >= R.min_test_trades, `${t.num_trades} trades`, `needs ${R.min_test_trades}+`],
    ['Profitable in the selection test', (t.sharpe ?? -9) >= R.min_test_sharpe, `Sharpe ${num(t.sharpe)}`, `needs ${R.min_test_sharpe}+`],
    ['Positive in validation period', (ev.validation.sharpe ?? -9) > 0, `Sharpe ${num(ev.validation.sharpe)}`, 'needs above 0'],
    ['Significant on its own (unadjusted)', ev.hac_p_test !== null && ev.hac_p_test <= 0.05, `p = ${num(ev.hac_p_test, 3)}`, 'needs ≤ 0.05'],
    ['Survives doubled costs', (ev.cost_stress.x2.sharpe ?? -9) > 0, `Sharpe ${num(ev.cost_stress.x2.sharpe)}`, 'needs above 0'],
    ['Stable to nearby settings', ev.neighbour_positive_frac === null || ev.neighbour_positive_frac >= R.min_neighbour_positive, pct(ev.neighbour_positive_frac, 0, false) + ' positive', `needs ${pct(R.min_neighbour_positive, 0, false)}+`],
    ['Drawdown within limit', (t.max_drawdown ?? -1) >= R.max_test_drawdown, pct(t.max_drawdown, 1), `needs ≥ ${pct(R.max_test_drawdown, 0)}`],
    ['Consistent over time', !!wf?.folds?.length && wf.positive_oos_folds / wf.folds.length >= 0.5 && (wf.mean_oos_sharpe ?? 0) > 0, wf?.folds?.length ? `${wf.positive_oos_folds} of ${wf.folds.length} periods positive` : 'not run', 'needs half or more'],
  ]
  const passed = checks.filter((c) => c[1]).length
  const splits = [['train', 'Design period', 'Settings are fitted here'], ['validation', 'Validation', 'Checked before the final test'], ['test', 'Selection test', 'Not used for fitting']] as const
  return (
    <Panel title="Validation on research data" tag={<HistTag />} subtitle={`History is split in time order, ending ${ev.research_end ? `before sealed data (${ev.research_end})` : 'at the latest bar'}. This is indicative: the final check on sealed data happens only inside a research cycle.`}>
      <div className="grid gap-3 sm:grid-cols-3">
        {splits.map(([k, title, note]) => (
          <div key={k} className={`rounded-[14px] px-4 py-3.5 ring-1 ring-inset ${k === 'test' ? 'bg-cy/[0.05] ring-cy/25' : 'bg-white/[0.025] ring-white/[0.06]'}`}>
            <div className="text-[13px] font-medium text-white">{title}</div>
            <div className="text-[12px] text-ink-300">{shortDate(ev.splits[k][0])} {ev.splits[k][0].slice(0, 4)} – {shortDate(ev.splits[k][1])} {ev.splits[k][1].slice(0, 4)}</div>
            <div className={`num mt-2 text-[22px] ${tone(ev[k].total_return)}`}>{pct(ev[k].total_return, 1)}</div>
            <div className="text-[12px] text-ink-300">Sharpe {num(ev[k].sharpe)} · {ev[k].num_trades} trades</div>
            <div className="mt-1 text-[11.5px] text-ink-300">{note}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[14px] font-medium text-white">Evidence checks</span>
            <span className="text-[13px] text-ink-300"><b className={passed === checks.length ? 'text-up' : 'text-white'}>{passed}</b> of {checks.length} passed</span>
          </div>
          <ul className="divide-y divide-white/[0.05]">
            {checks.map(([label, ok, value, need]) => (
              <li key={label} className="flex items-center gap-3 py-2">
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${ok ? 'bg-up/[0.15] text-up' : 'bg-dn/[0.13] text-dn'}`}>
                  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">{ok ? <path d="m4 8.5 2.5 2.5L12 5" /> : <path d="M5 5l6 6M11 5l-6 6" />}</svg>
                </span>
                <span className="flex-1 text-[13.5px] text-ink-100">{label}</span>
                <span className="text-right text-[12.5px]"><span className="tnum text-ink-100">{value}</span> <span className="text-ink-300">· {need}</span></span>
              </li>
            ))}
          </ul>
          {fam && <p className="mt-3 text-[12.5px] leading-relaxed text-ink-200">Search effort on this market so far: <b className="text-white">{fam.n_raw}</b> recorded attempts (≈{num(fam.n_eff, 1)} independent), including this one. A result has to beat what luck alone would produce across all of them.</p>}
          <p className="mt-2 text-[12px] leading-relaxed text-ink-300">These checks are indicative. The official outcome also applies the deflated Sharpe ratio and false-discovery control, then one look at sealed data, and is given only inside a <button onClick={onResearch} className="text-cy hover:underline">research cycle</button>.</p>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[14px] font-medium text-white">Re-tuned period by period <InfoTip text="Walk-forward: settings are re-chosen on each past window, then traded on the next window they never saw. The unseen windows are stitched together." /></div>
          {wf?.folds?.length ? (
            <>
              <TimeChart series={eq} height={170} format={fmtMoney} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {wf.folds.map((f: any) => <span key={f.fold} title={`${f.test[0]} → ${f.test[1]}`} className={`rounded-full px-2 py-0.5 text-[12px] ${f.oos_return > 0 ? 'bg-up/[0.12] text-up' : 'bg-dn/[0.12] text-dn'}`}>{f.test[0].slice(0, 7)} {pct(f.oos_return, 1)}</span>)}
              </div>
            </>
          ) : <div className="text-[13px] text-ink-300">{wf?.note ?? 'Not run.'}</div>}
        </div>
      </div>
      <div className="mt-5 flex items-center gap-2 text-[12.5px] text-ink-300"><StatusDot tone="vi" />Historical simulation. Passing these checks does not mean the strategy will make money in future.</div>
    </Panel>
  )
}

