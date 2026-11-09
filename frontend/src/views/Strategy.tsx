import { useEffect, useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { Histogram } from '../components/charts/Svg'
import { TimeChart, toLine } from '../components/charts/TimeChart'
import { Badge, Button, DN, Empty, ErrorBox, Field, HistTag, Legend, NEUTRAL, Panel, SERIES, Stat, UP } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { money, num, pct, strategyLabel, tone } from '../lib/format'
import type { BacktestPayload, Market, StrategySpec } from '../lib/types'

export function StrategyView(_: ViewProps) {
  const specs = useApi<StrategySpec[]>('/strategies')
  const markets = useApi<Market[]>('/markets')
  const [key, setKey] = useState('ma_crossover')
  const [sym, setSym] = useState('BTC/USD')
  const [params, setParams] = useState<Record<string, number | boolean>>({})
  const [sizing, setSizing] = useState<'fixed_fraction' | 'vol_target'>('fixed_fraction')
  const [start, setStart] = useState('')
  const [costMult, setCostMult] = useState(1)
  const [res, setRes] = useState<BacktestPayload | null>(null)
  const [ev, setEv] = useState<any>(null)
  const spec = specs.data?.find((s) => s.key === key)

  useEffect(() => {
    if (spec) setParams(Object.fromEntries(spec.params.map((p) => [p.name, p.default])))
  }, [spec])

  const friction = scaledCosts(sym, costMult)
  const bt = useAction(async () => {
    setEv(null)
    // costMult === 1 → backend applies the instrument's default frictions
    const r = await api.post<BacktestPayload>('/backtest', {
      symbol: sym, strategy: key, params, sizing, start: start || null,
      costs: costMult === 1 ? {} : scaledCosts(sym, costMult),
    })
    setRes(r)
  })
  const evaluate = useAction(async () => {
    setEv(await api.post('/evaluate', { symbol: sym, strategy: key, params }))
  })

  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12 xl:col-span-3" title="Hypothesis" kicker="DEFINE">
        <div className="space-y-3">
          <Field label="Strategy">
            <select value={key} onChange={(e) => { setKey(e.target.value); setRes(null) }}>
              {specs.data?.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Instrument">
            <select value={sym} onChange={(e) => setSym(e.target.value)}>
              {markets.data?.map((m) => <option key={m.symbol}>{m.symbol}</option>)}
            </select>
          </Field>
          {spec && (
            <>
              <p className="text-[11.5px] text-ink-200">{spec.description}</p>
              <ul className="space-y-0.5 text-[11px] text-ink-100">{spec.rules.map((r) => <li key={r} className="before:mr-1.5 before:text-cy before:content-['›']">{r}</li>)}</ul>
              <div className="grid grid-cols-2 gap-2">
                {spec.params.map((p) => (
                  <Field key={p.name} label={p.name} hint={p.description}>
                    {p.kind === 'bool' ? (
                      <select value={String(params[p.name] ?? p.default)} onChange={(e) => setParams({ ...params, [p.name]: e.target.value === 'true' })}>
                        <option value="true">true</option><option value="false">false</option>
                      </select>
                    ) : (
                      <input type="number" step={p.kind === 'int' ? 1 : 0.1} min={p.low ?? undefined} max={p.high ?? undefined}
                        value={String(params[p.name] ?? p.default)} onChange={(e) => setParams({ ...params, [p.name]: Number(e.target.value) })} />
                    )}
                  </Field>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Sizing">
                  <select value={sizing} onChange={(e) => setSizing(e.target.value as typeof sizing)}>
                    <option value="fixed_fraction">fixed 1× notional</option><option value="vol_target">vol target 10%</option>
                  </select>
                </Field>
                <Field label="Costs">
                  <select value={costMult} onChange={(e) => setCostMult(Number(e.target.value))}>
                    <option value={1}>instrument default</option><option value={2}>2× stress</option><option value={3}>3× stress</option><option value={0}>zero (unrealistic)</option>
                  </select>
                </Field>
                <Field label="Start (optional)"><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              </div>
              <div className="rounded border border-ink-600 bg-ink-850 p-2 font-mono text-[10.5px] text-ink-200">
                frictions ×{costMult}: spread {friction.spread_bps} bps · fee {friction.fee_bps} bps · slippage {friction.slippage_bps} bps
              </div>
              <div className="flex flex-wrap gap-2">
                <Button tone="primary" onClick={() => bt.run()} disabled={bt.pending}>{bt.pending ? 'running…' : '▶ Backtest'}</Button>
                <Button onClick={() => evaluate.run()} disabled={evaluate.pending}>{evaluate.pending ? 'evaluating…' : 'Robustness battery'}</Button>
              </div>
              <ErrorBox error={bt.error || evaluate.error} />
              <ul className="space-y-0.5 text-[10.5px] text-ink-300">{spec.risk_assumptions.map((r) => <li key={r}>· {r}</li>)}</ul>
            </>
          )}
        </div>
      </Panel>

      <div className="col-span-12 flex flex-col gap-3 xl:col-span-9">
        {!res && !ev && <Panel title="Results"><Empty>Configure a hypothesis and run a backtest. Results are historical simulations net of modelled costs — never evidence of future profitability.</Empty></Panel>}
        {res && <BacktestResult r={res} sym={sym} />}
        {ev && <Robustness ev={ev} />}
      </div>
    </div>
  )
}

// Mirrors backend/atlas/data/instruments.py defaults (shown to the user; backend is the source of truth).
function scaledCosts(sym: string, mult: number) {
  const fx = !sym.includes('BTC') && !sym.includes('ETH')
  const base = fx ? { spread_bps: sym === 'EUR/USD' ? 1 : 1.5, fee_bps: 0, slippage_bps: 0.5 } : { spread_bps: 5, fee_bps: 10, slippage_bps: 5 }
  return { spread_bps: base.spread_bps * mult, fee_bps: base.fee_bps * mult, slippage_bps: base.slippage_bps * mult }
}

function BacktestResult({ r, sym }: { r: BacktestPayload; sym: string }) {
  const m = r.metrics
  const eq = useMemo(() => [
    { kind: 'line' as const, id: 'eq', label: 'Strategy equity', color: SERIES[0], data: toLine(r.series.equity) },
    { kind: 'line' as const, id: 'bm', label: `Buy & hold ${sym}`, color: NEUTRAL, data: toLine(r.series.benchmark), dashed: true, width: 1 },
  ], [r, sym])
  const dd = useMemo(() => [{ kind: 'area' as const, id: 'dd', label: 'Drawdown', color: SERIES[3], data: toLine(r.series.drawdown) }], [r])
  const fmtMoney = useMemo(() => (v: number) => `$${Math.round(v).toLocaleString()}`, [])
  const tradeRets = r.trades.map((t) => t.return)
  return (
    <>
      <Panel title="Backtest result" tag={<HistTag />} right={<span className="font-mono text-[10px] text-ink-300">{r.runtime_ms} ms · dataset {r.dataset_version} {r.experiment_id ? `· saved as experiment #${r.experiment_id}` : ''}</span>}>
        <div className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-8">
          <Stat label="total return" value={pct(m.total_return)} valueClass={tone(m.total_return)} sub={`B&H ${pct(r.benchmark.total_return)}`} />
          <Stat label="CAGR" value={pct(m.annualized_return)} sub={m.annualized_return === null ? '< 1 year' : ''} />
          <Stat label="sharpe" value={num(m.sharpe)} sub={`B&H ${num(r.benchmark.sharpe)}`} />
          <Stat label="sortino" value={num(m.sortino)} />
          <Stat label="max drawdown" value={pct(m.max_drawdown)} valueClass="text-dn" sub={`${m.longest_drawdown_bars} bars underwater`} />
          <Stat label="trades" value={m.num_trades} sub={`win ${pct(m.win_rate, 0, false)}`} />
          <Stat label="profit factor" value={num(m.profit_factor)} sub={`exp. ${money(m.expectancy)}`} />
          <Stat label="exposure" value={pct(m.exposure, 0, false)} sub={`avg ${num(m.avg_trade_bars, 0)} bars`} />
        </div>
        <Legend items={[{ label: 'Strategy equity', color: SERIES[0] }, { label: `Buy & hold ${sym}`, color: NEUTRAL, dashed: true }]} />
        <TimeChart series={eq} height={280} format={fmtMoney} />
        <div className="label mt-2">drawdown</div>
        <TimeChart series={dd} height={110} percent />
        <p className="mt-2 text-[10.5px] text-ink-300">{r.data_note} Costs paid: fees {money(m.costs_paid?.fees)} · spread {money(m.costs_paid?.spread)} · slippage {money(m.costs_paid?.slippage)}.</p>
      </Panel>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Performance attribution">
          <div className="grid grid-cols-3 gap-3">
            {(['by_side', 'by_exit_reason', 'by_regime'] as const).map((k) => (
              <div key={k}>
                <div className="label mb-1">{k.replace('by_', '').replace('_', ' ')}</div>
                {Object.entries(r.attribution[k]).map(([g, v]) => (
                  <div key={g} className="flex justify-between font-mono text-[10.5px]"><span className="truncate text-ink-200">{g}</span><span className={tone(v.pnl)}>{money(v.pnl)}</span></div>
                ))}
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-between border-t border-ink-600 pt-2 font-mono text-[11px]">
            <span className="text-ink-300">gross P&L before costs</span><span className={tone(r.attribution.gross_pnl_before_costs)}>{money(r.attribution.gross_pnl_before_costs)}</span>
          </div>
        </Panel>
        <Panel title="Trade return distribution" tag={<Badge>{r.trades.length} trades</Badge>}>
          {tradeRets.length ? <Histogram values={tradeRets} color={SERIES[2]} xLabel="return per trade" refLine={0} format={(v) => `${(v * 100).toFixed(0)}%`} /> : <Empty>no trades</Empty>}
        </Panel>
      </div>
      <Panel title="Trade ledger" bodyClass="p-0">
        <div className="scroll-thin max-h-[300px] overflow-auto">
          <table className="data">
            <thead><tr><th>side</th><th>entry</th><th>entry px</th><th>exit</th><th>exit px</th><th>reason</th><th>bars</th><th>regime</th><th>costs</th><th>P&L</th><th>return</th></tr></thead>
            <tbody>
              {[...r.trades].reverse().map((t, i) => (
                <tr key={i}>
                  <td className={t.side === 'long' ? 'text-up' : 'text-dn'}>{t.side}</td><td>{t.entry_ts}</td><td>{num(t.entry_price, 5)}</td>
                  <td>{t.exit_ts}</td><td>{num(t.exit_price, 5)}</td><td className="text-ink-300">{t.exit_reason}</td><td>{t.bars_held}</td>
                  <td className="text-ink-300">{t.regime ?? '—'}</td><td>{money(t.costs)}</td><td className={tone(t.pnl)}>{money(t.pnl)}</td><td className={tone(t.return)}>{pct(t.return)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  )
}

function Robustness({ ev }: { ev: any }) {
  const wf = ev.walk_forward
  const eq = useMemo(() => [{ kind: 'line' as const, id: 'oos', label: 'Stitched OOS equity', color: SERIES[1], data: toLine(wf?.oos_equity ?? []) }], [wf])
  const fmtMoney = useMemo(() => (v: number) => `$${Math.round(v).toLocaleString()}`, [])
  const splits = ['train', 'validation', 'test'] as const
  return (
    <Panel title="Robustness battery" tag={<HistTag />} right={<span className="font-mono text-[10px] text-ink-300">{strategyLabel(ev.config?.strategy)}</span>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="label mb-1">chronological splits (fixed parameters)</div>
          <table className="data">
            <thead><tr><th>split</th><th>window</th><th>return</th><th>sharpe</th><th>max dd</th><th>trades</th></tr></thead>
            <tbody>
              {splits.map((s) => (
                <tr key={s}><td className={s === 'test' ? 'text-cy' : ''}>{s}</td><td className="text-ink-300">{ev.splits[s][0]} → {ev.splits[s][1]}</td>
                  <td className={tone(ev[s].total_return)}>{pct(ev[s].total_return)}</td><td>{num(ev[s].sharpe)}</td><td>{pct(ev[s].max_drawdown)}</td><td>{ev[s].num_trades}</td></tr>
              ))}
              <tr><td className="text-ink-300">B&H test</td><td /><td className={tone(ev.benchmark_test.total_return)}>{pct(ev.benchmark_test.total_return)}</td><td>{num(ev.benchmark_test.sharpe)}</td><td>{pct(ev.benchmark_test.max_drawdown)}</td><td /></tr>
            </tbody>
          </table>
          <div className="mt-3 grid grid-cols-4 gap-3">
            <Stat label="PSR (test)" value={num(ev.psr_test)} sub="P(true SR > 0)" />
            <Stat label="bootstrap p" value={num(ev.bootstrap_p_test, 3)} sub="H0: mean ≤ 0" />
            <Stat label="2× costs SR" value={num(ev.cost_stress.x2.sharpe)} valueClass={tone(ev.cost_stress.x2.sharpe)} />
            <Stat label="neighbours +" value={pct(ev.neighbour_positive_frac, 0, false)} sub={`${ev.neighbours.length} param sets`} />
          </div>
        </div>
        <div>
          <div className="label mb-1">walk-forward (re-optimised each fold, traded on unseen data)</div>
          {wf?.folds?.length ? (
            <>
              <TimeChart series={eq} height={150} format={fmtMoney} />
              <table className="data mt-2">
                <thead><tr><th>fold</th><th>test window</th><th>IS SR</th><th>OOS SR</th><th>OOS ret</th></tr></thead>
                <tbody>{wf.folds.map((f: any) => (
                  <tr key={f.fold}><td>{f.fold}</td><td className="text-ink-300">{f.test[0]} → {f.test[1]}</td><td>{num(f.is_sharpe)}</td>
                    <td className={tone(f.oos_sharpe)}>{num(f.oos_sharpe)}</td><td className={tone(f.oos_return)}>{pct(f.oos_return)}</td></tr>
                ))}</tbody>
              </table>
              <p className="mt-1 font-mono text-[10.5px] text-ink-300">param stability {pct(wf.param_stability, 0, false)} · mean IS SR {num(wf.mean_is_sharpe)} → OOS {num(wf.mean_oos_sharpe)}</p>
            </>
          ) : <Empty>{wf?.note ?? 'not run'}</Empty>}
        </div>
      </div>
      <p className="mt-3 text-[10.5px]" style={{ color: ev.test.sharpe > 0 ? UP : DN }}>
        {ev.test.sharpe > 0.3 ? 'Positive out-of-sample result — still subject to multiple-testing correction in the research loop.' : 'Out-of-sample performance does not support this hypothesis.'}
      </p>
    </Panel>
  )
}
