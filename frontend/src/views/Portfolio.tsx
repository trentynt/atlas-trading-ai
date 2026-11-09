import { useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { TimeChart } from '../components/charts/TimeChart'
import { Badge, Button, Empty, ErrorBox, Field, Panel, SERIES, SimTag, Stat } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { ago, money, num, pct, strategyLabel, tone } from '../lib/format'
import type { Account, Market, Order, Position, StrategyConfig } from '../lib/types'

export function PortfolioView({ reloadOverview }: ViewProps) {
  const acct = useApi<Account>('/paper/account', { poll: 15000 })
  const pos = useApi<Position[]>('/paper/positions', { poll: 15000 })
  const orders = useApi<Order[]>('/paper/orders?limit=200')
  const fills = useApi<any[]>('/paper/fills?limit=200')
  const snaps = useApi<any[]>('/paper/snapshots')
  const strats = useApi<StrategyConfig[]>('/paper/strategies')
  const markets = useApi<Market[]>('/markets')
  const reloadAll = () => { acct.reload(); pos.reload(); orders.reload(); fills.reload(); snaps.reload(); strats.reload(); reloadOverview() }
  useEventTrigger((e) => e.category === 'paper' || e.category === 'risk', reloadAll, 500)

  const control = useAction(async (action: string) => { await api.post('/paper/control', { action }); reloadAll() })
  const tick = useAction(async () => { await api.post('/paper/tick'); reloadAll() })
  const [form, setForm] = useState({ symbol: 'EUR/USD', side: 'buy', qty: '10000', type: 'market', limit_price: '' })
  const place = useAction(async () => {
    const o = await api.post<Order>('/paper/orders', { ...form, qty: Number(form.qty), limit_price: form.type === 'limit' ? Number(form.limit_price) : null })
    reloadAll()
    if (o.status === 'rejected') throw new Error(`Rejected by risk layer: ${o.reject_reason}`)
  })
  const cancel = useAction(async (id: number) => { await api.del(`/paper/orders/${id}`); reloadAll() })
  const setStrat = useAction(async (id: number, status: string) => { await api.patch(`/paper/strategies/${id}`, { status }); reloadAll() })

  const a = acct.data
  const eqSeries = useMemo(() => {
    const byDay = new Map<string, number>()
    snaps.data?.forEach((s) => byDay.set(s.ts.slice(0, 10), s.equity))
    return [{ kind: 'area' as const, id: 'eq', label: 'Paper equity', color: SERIES[1], data: [...byDay].map(([t, v]) => ({ time: t, value: v })) }]
  }, [snaps.data])
  const fmtMoney = useMemo(() => (v: number) => `$${Math.round(v).toLocaleString()}`, [])
  const px = markets.data?.find((m) => m.symbol === form.symbol)?.last_close
  const notional = px ? Number(form.qty) * px : null

  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12" kicker="PAPER" title="Simulated execution account" tag={<SimTag />}
        right={
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={a?.state === 'running' ? 'cy' : a?.state === 'halted' ? 'dn' : 'mute'} dot={a?.state === 'running'}>{a?.state ?? '—'}</Badge>
            {a?.state !== 'running' && a?.state !== 'halted' && <Button small tone="primary" onClick={() => control.run('start')}>▶ start</Button>}
            {a?.state === 'running' && <Button small onClick={() => control.run('pause')}>❚❚ pause</Button>}
            {a?.state === 'halted' && <Button small onClick={() => control.run('release')}>release kill switch</Button>}
            <Button small onClick={() => tick.run()} disabled={tick.pending}>tick now</Button>
            <Button small tone="danger" onClick={() => confirm('Emergency stop: halt engine, cancel open orders and flatten all PAPER positions?') && control.run('emergency_stop')}>■ emergency stop</Button>
            <Button small tone="ghost" onClick={() => confirm('Reset the paper account? This deletes paper positions, orders, fills and snapshots.') && control.run('reset')}>reset</Button>
          </div>
        }>
        <ErrorBox error={control.error || tick.error} />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-8">
          <Stat label="equity" value={money(a?.equity)} sub={`start ${money(a?.initial_cash)}`} />
          <Stat label="total return" value={pct(a?.total_return)} valueClass={tone(a?.total_return)} />
          <Stat label="cash" value={money(a?.cash)} />
          <Stat label="gross exposure" value={money(a?.gross_exposure)} sub={a ? pct(a.gross_exposure / a.equity, 0, false) + ' of equity' : ''} />
          <Stat label="unrealised" value={money(a?.unrealized_pnl)} valueClass={tone(a?.unrealized_pnl)} />
          <Stat label="realised" value={money(a?.realized_pnl)} valueClass={tone(a?.realized_pnl)} />
          <Stat label="fees paid" value={money(a?.fees_paid, 2)} />
          <Stat label="drawdown" value={pct(a?.drawdown)} valueClass={a && a.drawdown < 0 ? 'text-dn' : ''} />
        </div>
        <p className="mt-2 text-[10.5px] text-ink-300">All execution is simulated. Fills use the {a?.pricing} plus instrument spread, slippage and fees. There is no broker connection and no code path to place real orders.</p>
      </Panel>

      <Panel className="col-span-12 xl:col-span-8" title="Paper equity curve" tag={<Badge>{snaps.data?.length ?? 0} snapshots</Badge>}>
        {eqSeries[0].data.length > 1 ? <TimeChart series={eqSeries} height={240} format={fmtMoney} /> : <Empty>Equity snapshots accumulate with each engine tick / data refresh (one point per day shown).</Empty>}
      </Panel>

      <Panel className="col-span-12 xl:col-span-4" title="Manual paper order" tag={<Badge tone="am">risk-checked</Badge>}>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Symbol"><select value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}>{markets.data?.map((m) => <option key={m.symbol}>{m.symbol}</option>)}</select></Field>
          <Field label="Side"><select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value })}><option>buy</option><option>sell</option></select></Field>
          <Field label="Quantity (units)"><input type="number" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></Field>
          <Field label="Type"><select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option>market</option><option>limit</option></select></Field>
          {form.type === 'limit' && <Field label="Limit price"><input type="number" value={form.limit_price} onChange={(e) => setForm({ ...form, limit_price: e.target.value })} /></Field>}
        </div>
        <div className="mt-2 font-mono text-[10.5px] text-ink-300">last {num(px, 5)} · notional ≈ {money(notional)} {a && notional ? `(${pct(notional / a.equity, 1, false)} of equity)` : ''}</div>
        <div className="mt-2"><Button tone="primary" onClick={() => place.run()} disabled={place.pending}>submit paper order</Button></div>
        <div className="mt-2"><ErrorBox error={place.error || cancel.error} /></div>
      </Panel>

      <Panel className="col-span-12 lg:col-span-6" title="Positions" bodyClass="p-0">
        {pos.data?.length ? (
          <table className="data">
            <thead><tr><th>symbol</th><th>book</th><th>qty</th><th>avg</th><th>mark</th><th>value</th><th>unreal.</th></tr></thead>
            <tbody>{pos.data.map((p) => (
              <tr key={p.symbol + p.strategy_id}><td className="text-white">{p.symbol}</td><td className="text-ink-300">{p.strategy_id}</td>
                <td className={p.qty > 0 ? 'text-up' : 'text-dn'}>{num(p.qty, 4)}</td><td>{num(p.avg_price, 5)}</td><td>{num(p.mark, 5)}</td>
                <td>{money(p.market_value)}</td><td className={tone(p.unrealized_pnl)}>{money(p.unrealized_pnl, 2)}</td></tr>
            ))}</tbody>
          </table>
        ) : <Empty>No open paper positions.</Empty>}
      </Panel>

      <Panel className="col-span-12 lg:col-span-6" title="Strategy allocations (paper)" bodyClass="p-0">
        {strats.data?.length ? (
          <table className="data">
            <thead><tr><th>#</th><th>strategy</th><th>symbol</th><th>alloc.</th><th>source</th><th>status</th><th /></tr></thead>
            <tbody>{strats.data.map((s) => (
              <tr key={s.id} title={s.notes ?? ''}>
                <td className="text-ink-300">{s.id}</td><td>{strategyLabel(s.strategy)}</td><td>{s.symbol}</td><td>{pct(s.allocation, 0, false)}</td>
                <td className="text-ink-300">{s.source_experiment ? `exp #${s.source_experiment}` : 'manual'}</td>
                <td className={s.status === 'deployed' ? 'text-cy' : s.status === 'retired' ? 'text-dn' : 'text-ink-300'}>{s.status}</td>
                <td>{s.status === 'deployed' ? <Button small onClick={() => setStrat.run(s.id, 'paused')}>pause</Button> : s.status === 'paused' ? <Button small onClick={() => setStrat.run(s.id, 'deployed')}>resume</Button> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>No strategies deployed. Critic-approved strategies are promoted automatically (if enabled) or deploy one from the Experiments registry.</Empty>}
      </Panel>

      <Panel className="col-span-12 xl:col-span-7" title="Order blotter" bodyClass="p-0">
        <div className="scroll-thin max-h-[340px] overflow-auto">
          <table className="data">
            <thead><tr><th>#</th><th>time</th><th>symbol</th><th>side</th><th>qty</th><th>type</th><th>status</th><th>fill</th><th>book</th><th>reason / rejection</th><th /></tr></thead>
            <tbody>{orders.data?.map((o) => (
              <tr key={o.id}>
                <td className="text-ink-300">{o.id}</td><td>{ago(o.created_at)}</td><td>{o.symbol}</td>
                <td className={o.side === 'buy' ? 'text-up' : 'text-dn'}>{o.side}</td><td>{num(o.qty, 4)}</td><td>{o.type}{o.limit_price ? ` @${num(o.limit_price, 5)}` : ''}</td>
                <td className={o.status === 'filled' ? 'text-up' : o.status === 'rejected' ? 'text-dn' : o.status === 'open' ? 'text-cy' : 'text-ink-300'}>{o.status}</td>
                <td>{num(o.filled_price, 5)}</td><td className="text-ink-300">{o.strategy_id}</td>
                <td className="max-w-[300px] truncate text-ink-300" title={o.reject_reason ?? o.reason ?? ''}>{o.reject_reason ?? o.reason}</td>
                <td>{o.status === 'open' && <Button small onClick={() => cancel.run(o.id)}>cancel</Button>}</td>
              </tr>
            ))}</tbody>
          </table>
          {!orders.data?.length && <Empty>No orders yet.</Empty>}
        </div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-5" title="Fills (trade history)" bodyClass="p-0">
        <div className="scroll-thin max-h-[340px] overflow-auto">
          <table className="data">
            <thead><tr><th>time</th><th>symbol</th><th>side</th><th>qty</th><th>price</th><th>fee</th><th>realised</th></tr></thead>
            <tbody>{fills.data?.map((f) => (
              <tr key={f.id}><td>{ago(f.ts)}</td><td>{f.symbol}</td><td className={f.side === 'buy' ? 'text-up' : 'text-dn'}>{f.side}</td>
                <td>{num(f.qty, 4)}</td><td>{num(f.price, 5)}</td><td>{num(f.fee, 2)}</td><td className={tone(f.realized_pnl)}>{money(f.realized_pnl, 2)}</td></tr>
            ))}</tbody>
          </table>
          {!fills.data?.length && <Empty>No fills yet.</Empty>}
        </div>
      </Panel>
    </div>
  )
}
