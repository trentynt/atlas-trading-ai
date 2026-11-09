import { useState } from 'react'
import type { ViewProps } from '../App'
import { Heatmap } from '../components/charts/Svg'
import { Badge, Button, Empty, ErrorBox, Meter, Panel, Segmented } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { ago, num, pct } from '../lib/format'
import type { RiskEvent } from '../lib/types'

const PCT_KEYS = new Set(['max_drawdown_pct', 'max_daily_loss_pct', 'max_position_exposure_pct', 'max_gross_exposure_pct', 'strategy_budget_pct', 'max_order_notional_pct', 'max_vol_percentile'])

export function RiskView({ reloadOverview }: ViewProps) {
  const status = useApi<any>('/risk/status', { poll: 20000 })
  const limits = useApi<{ limits: Record<string, number | boolean>; schema: Record<string, { description: string }> }>('/risk/limits')
  const events = useApi<RiskEvent[]>('/risk/events?limit=300')
  const [filter, setFilter] = useState<'all' | 'reject' | 'approve'>('all')
  const [open, setOpen] = useState<number | null>(null)
  useEventTrigger((e) => e.category === 'risk' || e.category === 'paper', () => { status.reload(); events.reload(); limits.reload() }, 600)
  const save = useAction(async (patch: Record<string, unknown>) => {
    const r = await api.put<{ limits: Record<string, number | boolean> }>('/risk/limits', patch)
    limits.setData({ ...limits.data!, limits: r.limits })
    status.reload(); events.reload(); reloadOverview()
  })
  const L = limits.data?.limits
  const s = status.data
  const evs = (events.data ?? []).filter((e) => filter === 'all' || e.decision === filter)

  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12" kicker="ENFORCED BY BACKEND" title="Risk intelligence centre"
        tag={L?.kill_switch ? <Badge tone="dn" dot>kill switch engaged</Badge> : <Badge tone="up">armed</Badge>}
        right={<Button tone={L?.kill_switch ? 'primary' : 'danger'} onClick={() => save.run({ kill_switch: !L?.kill_switch })}>{L?.kill_switch ? 'release kill switch' : '■ engage kill switch'}</Button>}>
        <ErrorBox error={save.error} />
        {s ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(s.gauges as Record<string, { value: number; limit: number }>).map(([k, g]) => {
              const u = Math.abs(g.value) / Math.abs(g.limit || 1)
              return (
                <div key={k} className="rounded border border-ink-600 bg-ink-850 p-3">
                  <div className="label">{k.replace('_', ' ')}</div>
                  <div className="num mt-1 text-[22px] text-white">{pct(g.value, 2, false)}</div>
                  <div className="mb-1 font-mono text-[10px] text-ink-300">limit {pct(g.limit, 0, false)} · {pct(u, 0, false)} utilised {u >= 1 ? '· BREACH' : u >= 0.75 ? '· WARNING' : ''}</div>
                  <Meter value={g.value} limit={g.limit} />
                </div>
              )
            })}
          </div>
        ) : <Empty>loading…</Empty>}
        <p className="mt-2 text-[10.5px] text-ink-300">Every paper order — manual or automated — passes the backend risk gate. Exposure-reducing orders are always allowed; all others must pass every rule. Drawdown breaches trigger an automatic emergency stop.</p>
      </Panel>

      <Panel className="col-span-12 lg:col-span-5" title="Limit configuration">
        {L ? (
          <div className="space-y-2">
            {Object.entries(L).filter(([k]) => k !== 'kill_switch').map(([k, v]) => (
              <div key={k} className="grid grid-cols-[1fr_110px] items-center gap-2" title={limits.data!.schema[k]?.description}>
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px] text-white">{k}</div>
                  <div className="truncate text-[10.5px] text-ink-300">{limits.data!.schema[k]?.description}</div>
                </div>
                <div className="flex items-center gap-1">
                  <input key={`${k}-${v}`} type="number" step={PCT_KEYS.has(k) ? 1 : 1} defaultValue={PCT_KEYS.has(k) ? +((v as number) * 100).toFixed(2) : (v as number)}
                    onBlur={(e) => {
                      const n = Number(e.target.value)
                      const val = PCT_KEYS.has(k) ? n / 100 : n
                      if (val !== v) save.run({ [k]: val })
                    }} className="w-full text-right" />
                  <span className="w-3 font-mono text-[10px] text-ink-300">{PCT_KEYS.has(k) ? '%' : ''}</span>
                </div>
              </div>
            ))}
          </div>
        ) : <Empty>loading…</Empty>}
      </Panel>

      <div className="col-span-12 flex flex-col gap-3 lg:col-span-7">
        <Panel title="Instrument monitors" bodyClass="p-0">
          {s && (
            <table className="data">
              <thead><tr><th>instrument</th><th>net exposure</th><th>20d vol percentile (1y)</th><th>data age</th><th>status</th></tr></thead>
              <tbody>{s.instruments.map((i: any) => (
                <tr key={i.symbol}>
                  <td className="text-white">{i.symbol}</td><td>{pct(i.net_exposure_pct, 1)}</td>
                  <td><div className="flex items-center gap-2"><span className="w-10">{i.vol_percentile === null ? '—' : pct(i.vol_percentile, 0, false)}</span><div className="w-24"><Meter value={i.vol_percentile ?? 0} limit={L ? (L.max_vol_percentile as number) : 1} /></div></div></td>
                  <td>{num(i.stale_days, 1)}d</td>
                  <td>{i.stale ? <Badge tone="am">stale data</Badge> : i.vol_percentile > (L?.max_vol_percentile as number) ? <Badge tone="dn">vol blocked</Badge> : <Badge tone="up">ok</Badge>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Panel>
        <Panel title="Correlation monitor (90d)" tag={<Badge>clusters share one exposure limit above |ρ| ≥ {num(L?.max_correlation as number)}</Badge>}>
          {s?.correlation.symbols.length ? <Heatmap labels={s.correlation.symbols} matrix={s.correlation.matrix} size={40} /> : <Empty>insufficient data</Empty>}
        </Panel>
      </div>

      <Panel className="col-span-12" title="Risk audit log" tag={<Badge>{events.data?.length ?? 0} decisions</Badge>}
        right={<Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'all' }, { value: 'reject', label: 'rejected' }, { value: 'approve', label: 'approved' }]} />} bodyClass="p-0">
        <div className="scroll-thin max-h-[420px] overflow-auto">
          <table className="data">
            <thead><tr><th>time</th><th>rule</th><th>decision</th><th>order</th><th>message</th></tr></thead>
            <tbody>{evs.map((e) => (
              <>
                <tr key={e.id} onClick={() => setOpen(open === e.id ? null : e.id)} className="cursor-pointer">
                  <td>{ago(e.ts)}</td><td>{e.rule}</td>
                  <td className={e.decision === 'reject' || e.decision === 'halt' ? 'text-dn' : e.decision === 'approve' ? 'text-up' : 'text-am'}>{e.decision}</td>
                  <td className="text-ink-300">{e.order_id ?? '—'}</td>
                  <td className="max-w-[640px] truncate text-ink-100" title={e.message}>{e.message}</td>
                </tr>
                {open === e.id && e.data.checks && (
                  <tr key={`${e.id}-d`}><td colSpan={5} className="bg-ink-850">
                    <div className="grid gap-x-6 gap-y-0.5 py-1 sm:grid-cols-2">
                      {e.data.checks.map((c) => <div key={c.rule} className="whitespace-normal"><span className={c.approved ? 'text-up' : 'text-dn'}>{c.approved ? '✓' : '✕'}</span> <span className="text-white">{c.rule}</span> <span className="text-ink-300">{c.message}</span></div>)}
                    </div>
                  </td></tr>
                )}
              </>
            ))}</tbody>
          </table>
          {!evs.length && <Empty>No risk decisions recorded yet.</Empty>}
        </div>
      </Panel>
    </div>
  )
}
