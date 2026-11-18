import { useEffect, useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { TimeChart } from '../components/charts/TimeChart'
import { Badge, Button, Drawer, EmptyState, ErrorBox, Field, KeyValue, Loading, Notice, Panel, SERIES, Segmented, StatusDot, Tabs, useConfirm } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { strategyName } from '../lib/explain'
import { ago, money, num, pct, price, qty, tone } from '../lib/format'
import { navigate, useRoute } from '../lib/route'
import { useToast } from '../lib/toast'
import type { Account, Market, Order, Position, StrategyConfig } from '../lib/types'

export function PortfolioView({ go, reloadOverview }: ViewProps) {
  const acct = useApi<Account>('/paper/account', { poll: 15000 })
  const pos = useApi<Position[]>('/paper/positions', { poll: 15000 })
  const orders = useApi<Order[]>('/paper/orders?limit=300')
  const fills = useApi<any[]>('/paper/fills?limit=300')
  const snaps = useApi<any[]>('/paper/snapshots')
  const strats = useApi<StrategyConfig[]>('/paper/strategies')
  const markets = useApi<Market[]>('/markets')
  const toast = useToast()
  const confirm = useConfirm()
  const { params } = useRoute()
  const reloadAll = () => { acct.reload(); pos.reload(); orders.reload(); fills.reload(); snaps.reload(); strats.reload(); reloadOverview() }
  useEventTrigger((e) => e.category === 'paper' || e.category === 'risk', reloadAll, 500)

  const control = useAction(async (action: string) => {
    await api.post('/paper/control', { action })
    toast({ tone: action === 'emergency_stop' ? 'warning' : 'success', title: ({ start: 'Paper engine started', pause: 'Paper engine paused', resume: 'Paper engine resumed', emergency_stop: 'Emergency stop engaged', release: 'Kill switch released', reset: 'Paper account reset' } as Record<string, string>)[action] })
    reloadAll()
  })
  const tick = useAction(async () => { const r = await api.post<any>('/paper/tick'); toast({ tone: 'info', title: 'Paper engine evaluated', body: `${r.orders} order${r.orders === 1 ? '' : 's'} placed${r.rejected ? `, ${r.rejected} blocked by risk` : ''}.` }); reloadAll() })
  const setStrat = useAction(async (id: number, status: string) => { await api.patch(`/paper/strategies/${id}`, { status }); reloadAll() })
  const cancel = useAction(async (id: number) => { await api.del(`/paper/orders/${id}`); toast({ tone: 'info', title: `Order #${id} cancelled` }); reloadAll() })
  const [orderOpen, setOrderOpen] = useState(false)
  const [tab, setTab] = useState<'all' | 'open' | 'filled' | 'rejected'>('all')

  const emergency = async () => {
    if (await confirm.ask('Emergency stop?', 'This halts the paper engine, cancels every open paper order, flattens all paper positions and engages the kill switch. No real money is involved.', 'Stop everything', true)) control.run('emergency_stop')
  }
  const reset = async () => {
    if (await confirm.ask('Reset the paper account?', 'All paper positions, orders, fills and equity history will be deleted and cash restored to the starting balance. Research results are not affected.', 'Reset account', true)) control.run('reset')
  }
  useEffect(() => {
    if (params.get('confirm') === 'stop') { navigate('portfolio'); emergency() }
  }, [params]) // eslint-disable-line react-hooks/exhaustive-deps

  const a = acct.data
  const eqSeries = useMemo(() => {
    const byDay = new Map<string, number>()
    snaps.data?.forEach((s) => byDay.set(s.ts.slice(0, 10), s.equity))
    return [{ kind: 'area' as const, id: 'eq', label: 'Paper equity', color: SERIES[0], data: [...byDay].map(([t, v]) => ({ time: t, value: v })) }]
  }, [snaps.data])
  const fmtMoney = useMemo(() => (v: number) => `$${Math.round(v).toLocaleString()}`, [])
  const eqVals = eqSeries[0].data.map((d) => d.value)
  const flat = eqVals.length > 0 && Math.max(...eqVals) - Math.min(...eqVals) < 0.5
  const shown = (orders.data ?? []).filter((o) => tab === 'all' || o.status === tab)
  const deployed = strats.data?.filter((s) => s.status !== 'retired') ?? []
  const count = (s: string) => orders.data?.filter((o) => o.status === s).length ?? 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-[16px] bg-am/[0.08] px-5 py-3.5 ring-1 ring-inset ring-am/20">
        <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-am" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="5" width="14" height="10" rx="2" /><path d="M3 9h14" /></svg>
        <div className="min-w-0 flex-1 text-[13.5px] text-ink-100"><b className="text-am">Paper portfolio — simulated money.</b> Orders fill against the latest daily price plus realistic costs. SIGNAL has no broker connection and cannot place real trades.</div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <div className="flex items-center gap-2 text-[13px] text-ink-300"><StatusDot tone={a?.state === 'running' ? 'cy' : a?.state === 'halted' ? 'dn' : 'mute'} pulse={a?.state === 'running'} />Engine {a?.state ?? '…'}</div>
          <div className="mt-1 num text-[40px] leading-none tracking-[-0.035em] text-white">{money(a?.equity)}</div>
          <div className="mt-2 flex flex-wrap gap-x-4 text-[14px]">
            <span className={`num ${tone(a?.total_return)}`}>{pct(a?.total_return)} total</span>
            <span className="text-ink-300">Started with {money(a?.initial_cash)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {a?.state === 'running' ? <Button onClick={() => control.run('pause')}>Pause engine</Button>
            : a?.state === 'halted' ? <Button onClick={() => control.run('release')}>Release kill switch</Button>
            : <Button tone="primary" onClick={() => control.run('start')}>Start paper engine</Button>}
          <Button onClick={() => tick.run()} disabled={tick.pending}>Evaluate now</Button>
          <Button onClick={() => setOrderOpen(true)}>New paper order</Button>
          <Button tone="danger" onClick={emergency}>Emergency stop</Button>
        </div>
      </div>
      <ErrorBox error={control.error || tick.error || setStrat.error || cancel.error} />

      <div className="panel grid grid-cols-2 gap-x-6 gap-y-5 px-6 py-5 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Cash', money(a?.cash), ''],
          ['Invested', money(a?.gross_exposure), a ? `${pct(a.gross_exposure / a.equity, 0, false)} of equity` : ''],
          ['Unrealised P&L', <span className={tone(a?.unrealized_pnl)}>{money(a?.unrealized_pnl)}</span>, 'Open positions'],
          ['Realised P&L', <span className={tone(a?.realized_pnl)}>{money(a?.realized_pnl)}</span>, 'Closed trades'],
          ['Costs paid', money(a?.fees_paid, 2), 'Simulated fees'],
          ['From peak', <span className={a && a.drawdown < 0 ? 'text-dn' : ''}>{pct(a?.drawdown)}</span>, 'Drawdown'],
        ].map(([l, v, s], i) => (
          <div key={i}><div className="label">{l}</div><div className="num mt-0.5 text-[20px] text-white">{v}</div><div className="text-[12px] text-ink-300">{s}</div></div>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-5">
        <Panel className="col-span-12 xl:col-span-8" title="Performance" subtitle="Simulated equity, one point per day.">
          {eqSeries[0].data.length > 1 && flat && <Notice>Equity has stayed at {money(eqSeries[0].data[0].value)} since {eqSeries[0].data[0].time} — no simulated trade has changed it yet. The curve will draw once it moves.</Notice>}
          {eqSeries[0].data.length > 1 && !flat ? <TimeChart series={eqSeries} height={280} format={fmtMoney} /> : eqSeries[0].data.length > 1 ? null : (
            <EmptyState title="Your equity curve will appear here">It builds day by day while the paper engine runs. Start the engine and SIGNAL will evaluate approved strategies on every data refresh.</EmptyState>
          )}
        </Panel>
        <Panel className="col-span-12 xl:col-span-4" title="Strategy allocations" subtitle="Strategies that passed every research check.">
          {!strats.data ? <Loading /> : deployed.length === 0 ? (
            <EmptyState title="No approved strategies yet" action={<Button small onClick={() => go('research')}>Run research</Button>}>Only ideas that pass every robustness check can trade here.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {deployed.map((s) => (
                <li key={s.id} className="rounded-[14px] bg-white/[0.025] px-4 py-3 ring-1 ring-inset ring-white/[0.05]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-medium text-white">{strategyName(s.strategy)}</div>
                      <div className="text-[12.5px] text-ink-300">{s.symbol}{s.source_experiment ? <> · <button className="text-cy hover:underline" onClick={() => go('experiments', { id: s.source_experiment! })}>evidence</button></> : ' · added manually'}</div>
                    </div>
                    <Badge tone={s.status === 'deployed' ? 'cy' : 'mute'}>{s.status === 'deployed' ? 'Active' : 'Paused'}</Badge>
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-cy" style={{ width: `${Math.min(100, s.allocation * 100 / 0.4)}%` }} /></div>
                    <span className="num w-10 text-right text-[13px] text-white">{pct(s.allocation, 0, false)}</span>
                    <Button small tone="plain" onClick={() => setStrat.run(s.id, s.status === 'deployed' ? 'paused' : 'deployed')}>{s.status === 'deployed' ? 'Pause' : 'Resume'}</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Positions" bodyClass="!px-0">
        {!pos.data ? <div className="px-5"><Loading /></div> : pos.data.length === 0 ? <EmptyState title="No open positions">Positions appear when an approved strategy signals, or when you place a paper order.</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th className="!pl-5">Market</th><th>Held by</th><th className="!text-right">Quantity</th><th className="!text-right">Average price</th><th className="!text-right">Last price</th><th className="!text-right">Value</th><th className="!pr-5 !text-right">Unrealised</th></tr></thead>
              <tbody>{pos.data.map((p) => (
                <tr key={p.symbol + p.strategy_id}>
                  <td className="!pl-5 font-medium text-white">{p.symbol} <span className={`ml-1 text-[12px] ${p.qty > 0 ? 'text-up' : 'text-dn'}`}>{p.qty > 0 ? 'Long' : 'Short'}</span></td>
                  <td className="text-ink-300">{p.strategy_id === 'manual' ? 'Manual' : `Strategy #${p.strategy_id.replace('sc:', '')}`}</td>
                  <td className="text-right">{qty(Math.abs(p.qty))}</td><td className="text-right">{num(p.avg_price, 5)}</td><td className="text-right">{num(p.mark, 5)}</td>
                  <td className="text-right">{money(p.market_value)}</td><td className={`!pr-5 text-right ${tone(p.unrealized_pnl)}`}>{money(p.unrealized_pnl, 2)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Orders & trades" bodyClass="!pt-0">
        <Tabs value={tab} onChange={setTab} options={[{ value: 'all', label: 'All', count: orders.data?.length }, { value: 'open', label: 'Open', count: count('open') }, { value: 'filled', label: 'Filled', count: count('filled') }, { value: 'rejected', label: 'Blocked by risk', count: count('rejected') }]} />
        {!orders.data ? <Loading /> : shown.length === 0 ? <EmptyState title="Nothing here yet">Every paper order is recorded, including those the risk layer blocked.</EmptyState> : (
          <ul className="scroll-thin max-h-[440px] divide-y divide-white/[0.05] overflow-y-auto">
            {shown.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <span className={`w-12 text-[13px] font-medium ${o.side === 'buy' ? 'text-up' : 'text-dn'}`}>{o.side === 'buy' ? 'Buy' : 'Sell'}</span>
                <span className="min-w-[150px] text-[13.5px] text-white">{qty(o.qty)} {o.symbol}</span>
                <span className="text-[12.5px] text-ink-300">{o.type === 'limit' ? `Limit ${num(o.limit_price, 5)}` : 'Market'} · {o.strategy_id === 'manual' ? 'manual' : 'strategy'} · {ago(o.created_at)}</span>
                <span className="ml-auto flex items-center gap-3">
                  {o.status === 'filled' && <span className="tnum text-[12.5px] text-ink-200">@ {num(o.filled_price, 5)}</span>}
                  <Badge tone={o.status === 'filled' ? 'up' : o.status === 'rejected' ? 'dn' : o.status === 'open' ? 'cy' : 'mute'}>{({ filled: 'Filled', rejected: 'Blocked', open: 'Open', cancelled: 'Cancelled', new: 'New' } as Record<string, string>)[o.status]}</Badge>
                  {o.status === 'open' && <Button small onClick={() => cancel.run(o.id)}>Cancel</Button>}
                </span>
                {o.reject_reason && <div className="w-full text-[12.5px] leading-snug text-dn/90">{o.reject_reason.split('; ').map((r) => r.split(':')[0].replace(/_/g, ' ')).join(' · ')} <button className="text-cy hover:underline" onClick={() => go('risk')}>details</button></div>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap justify-between gap-3 border-t border-white/[0.05] pt-4 text-[12.5px] text-ink-300">
          <span>{fills.data?.length ?? 0} fills recorded · costs included in every fill</span>
          <button onClick={reset} className="text-ink-300 hover:text-dn">Reset paper account…</button>
        </div>
      </Panel>

      <NewOrder open={orderOpen} onClose={() => setOrderOpen(false)} markets={markets.data ?? []} equity={a?.equity ?? 0} onDone={reloadAll} goRisk={() => go('risk')} />
      {confirm.node}
    </div>
  )
}

function NewOrder({ open, onClose, markets, equity, onDone, goRisk }: { open: boolean; onClose: () => void; markets: Market[]; equity: number; onDone: () => void; goRisk: () => void }) {
  const [form, setForm] = useState({ symbol: 'EUR/USD', side: 'buy' as 'buy' | 'sell', qty: '10000', type: 'market', limit_price: '' })
  const [result, setResult] = useState<Order | null>(null)
  const toast = useToast()
  const place = useAction(async () => {
    const o = await api.post<Order>('/paper/orders', { ...form, qty: Number(form.qty), limit_price: form.type === 'limit' ? Number(form.limit_price) : null })
    setResult(o)
    onDone()
    if (o.status === 'filled') toast({ tone: 'success', title: 'Paper order filled', body: `${o.side === 'buy' ? 'Bought' : 'Sold'} ${qty(o.qty)} ${o.symbol} at ${num(o.filled_price, 5)} (simulated).` })
  })
  const m = markets.find((x) => x.symbol === form.symbol)
  const notional = m?.last_close ? Number(form.qty) * m.last_close : null
  return (
    <Drawer open={open} onClose={() => { onClose(); setResult(null) }} title={<span><span className="block text-[12.5px] font-medium text-am">Simulated</span>New paper order</span>}
      footer={<><Button onClick={onClose}>Close</Button><Button tone="primary" onClick={() => place.run()} disabled={place.pending || !(Number(form.qty) > 0)}>Place paper order</Button></>}>
      <div className="space-y-4">
        <Segmented value={form.side} onChange={(v) => setForm({ ...form, side: v })} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} />
        <Field label="Market"><select value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}>{markets.map((x) => <option key={x.symbol}>{x.symbol}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity (units)"><input type="number" min={0} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></Field>
          <Field label="Order type"><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="market">Market</option><option value="limit">Limit</option></select></Field>
        </div>
        {form.type === 'limit' && <Field label="Limit price" hint="Fills when the daily price reaches this level."><input type="number" value={form.limit_price} onChange={(e) => setForm({ ...form, limit_price: e.target.value })} /></Field>}
        <KeyValue rows={[['Last price', `${price(m?.last_close, m?.price_decimals ?? 4)} (${m?.asset_class === 'fx' ? 'ECB reference rate' : 'daily close'})`], ['Order size', money(notional)], ['Share of equity', equity && notional ? pct(notional / equity, 1, false) : '—']]} />
        <Notice>Every order passes SIGNAL's independent risk checks — position size, exposure, drawdown, daily loss, data freshness and the kill switch. Orders that break a limit are blocked and recorded.</Notice>
        <ErrorBox error={place.error} />
        {result && (result.status === 'rejected' ? (
          <Notice tone="dn" title="Blocked by risk limits">
            <ul className="mt-1 space-y-0.5">{result.reject_reason?.split('; ').map((r) => <li key={r}>{r.replace(/_/g, ' ')}</li>)}</ul>
            <button className="mt-2 font-medium text-cy hover:underline" onClick={goRisk}>Review limits</button>
          </Notice>
        ) : <Notice tone="up" title={result.status === 'filled' ? 'Filled (simulated)' : 'Order placed'}>{result.status === 'filled' ? `At ${num(result.filled_price, 5)}, including spread and slippage.` : 'It will fill when the daily price reaches your limit.'}</Notice>)}
      </div>
    </Drawer>
  )
}
