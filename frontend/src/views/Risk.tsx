import { useState } from 'react'
import type { ViewProps } from '../App'
import { Heatmap } from '../components/charts/Svg'
import { Badge, Button, Disclosure, EmptyState, ErrorBox, InfoTip, Loading, Meter, Notice, Panel, PageHeader, Segmented, StatusDot, useConfirm } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { ago, num, pct } from '../lib/format'
import { useToast } from '../lib/toast'
import type { RiskEvent } from '../lib/types'

const PCT_KEYS = new Set(['max_drawdown_pct', 'max_daily_loss_pct', 'max_position_exposure_pct', 'max_gross_exposure_pct', 'strategy_budget_pct', 'max_order_notional_pct', 'max_vol_percentile'])
const LIMIT_LABEL: Record<string, [string, string]> = {
  max_drawdown_pct: ['Maximum drawdown', 'Halt everything if equity falls this far below its peak.'],
  max_daily_loss_pct: ['Daily loss limit', 'Block new risk after losing this much since the start of the day (UTC).'],
  max_position_exposure_pct: ['Largest position', 'Maximum size of any single market, as a share of equity.'],
  max_gross_exposure_pct: ['Total exposure', 'Sum of all positions, as a share of equity.'],
  strategy_budget_pct: ['Per-strategy budget', 'Maximum size any one strategy can hold.'],
  max_order_notional_pct: ['Largest single order', 'Maximum size of one order, as a share of equity.'],
  max_correlation: ['Correlation threshold', 'Markets that move together above this level share one position limit.'],
  max_vol_percentile: ['Volatility ceiling', 'Block new risk when volatility is above this percentile of the past year.'],
  max_consecutive_losses: ['Losing streak limit', 'Suspend a strategy after this many losing trades in a row.'],
}
const RULE_PLAIN: Record<string, string> = {
  kill_switch: 'Kill switch', account_state: 'Account halted', data_staleness: 'Stale market data', max_drawdown: 'Drawdown limit', max_daily_loss: 'Daily loss limit',
  max_order_notional: 'Order too large', max_position_exposure: 'Position too large', max_gross_exposure: 'Total exposure too high', strategy_budget: 'Strategy budget exceeded',
  correlation_cluster: 'Too much correlated exposure', volatility_regime: 'Volatility too high', consecutive_losses: 'Losing streak', valid_price: 'Invalid price',
  reduce_only_exemption: 'Reduces exposure', order_check: 'Order check', config: 'Limits changed',
}
const GAUGES: [string, string, string][] = [
  ['drawdown', 'Drawdown from peak', 'How far equity is below its highest point.'],
  ['daily_pnl', "Today's loss", 'Loss since 00:00 UTC.'],
  ['gross_exposure', 'Total exposure', 'Sum of all positions relative to equity.'],
  ['max_position', 'Largest position', 'Biggest single-market position relative to equity.'],
]

export function RiskView({ reloadOverview }: ViewProps) {
  const status = useApi<any>('/risk/status', { poll: 20000 })
  const limits = useApi<{ limits: Record<string, number | boolean>; schema: Record<string, { description: string }> }>('/risk/limits')
  const events = useApi<RiskEvent[]>('/risk/events?limit=300')
  const [filter, setFilter] = useState<'all' | 'reject' | 'approve'>('reject')
  const toast = useToast()
  const confirm = useConfirm()
  useEventTrigger((e) => e.category === 'risk' || e.category === 'paper', () => { status.reload(); events.reload(); limits.reload() }, 600)
  const save = useAction(async (patch: Record<string, unknown>) => {
    const r = await api.put<{ limits: Record<string, number | boolean> }>('/risk/limits', patch)
    limits.setData({ ...limits.data!, limits: r.limits })
    toast({ tone: 'success', title: 'Risk limits updated', body: 'The change is enforced immediately and recorded in the audit log.' })
    status.reload(); events.reload(); reloadOverview()
  })
  const L = limits.data?.limits
  const s = status.data
  const evs = (events.data ?? []).filter((e) => filter === 'all' || e.decision === filter)
  const rejected = events.data?.filter((e) => e.decision === 'reject').length ?? 0
  const kill = !!L?.kill_switch
  const toggleKill = async () => {
    if (kill) { save.run({ kill_switch: false }); return }
    if (await confirm.ask('Engage the kill switch?', 'All new paper risk will be blocked. Only orders that reduce exposure will be accepted until you release it.', 'Engage kill switch', true)) save.run({ kill_switch: true })
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Risk" title="Risk controls"
        subtitle="Independent limits enforced by the SIGNAL engine on every paper order — manual or automated. The research agents cannot override them."
        actions={<Button tone={kill ? 'primary' : 'danger'} onClick={toggleKill} disabled={save.pending}>{kill ? 'Release kill switch' : 'Engage kill switch'}</Button>} />
      <ErrorBox error={save.error || status.error} />

      {kill ? (
      <div className={`flex flex-wrap items-center gap-4 rounded-[18px] px-6 py-5 ring-1 ring-inset ${kill ? 'bg-dn/[0.09] ring-dn/30' : 'bg-up/[0.05] ring-up/15'}`}>
        <span className={`flex h-11 w-11 items-center justify-center rounded-full ${kill ? 'bg-dn/[0.18] text-dn' : 'bg-up/[0.14] text-up'}`}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" />{kill ? <path d="M9 9l6 6M15 9l-6 6" /> : <path d="m8.5 12 2.5 2.5 4.5-5" />}</svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className={`text-[17px] font-semibold ${kill ? 'text-dn' : 'text-white'}`}>{kill ? 'Kill switch engaged — new risk is blocked' : 'All limits armed'}</div>
          <div className="text-[13.5px] text-ink-300">{kill ? 'Only exposure-reducing orders are accepted.' : 'Every order is checked against nine independent rules. Exposure-reducing orders are always allowed.'} {rejected > 0 && <>{rejected} order{rejected === 1 ? ' has' : 's have'} been blocked so far.</>}</div>
        </div>
      </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-200"><StatusDot tone="up" />All limits are armed and checked on every paper order.{rejected > 0 && <span className="text-ink-300">{` ${rejected} order${rejected === 1 ? ' has' : 's have'} been blocked so far.`}</span>}</div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {GAUGES.map(([k, label, help]) => {
          const g = s?.gauges?.[k]
          const u = g ? Math.abs(g.value) / Math.abs(g.limit || 1) : 0
          return (
            <div key={k} className="panel px-5 py-4">
              <div className="flex items-center gap-1"><span className="label">{label}</span><InfoTip text={help} /></div>
              {!g ? <Loading rows={2} /> : (
                <>
                  <div className="mt-1 flex items-baseline gap-2"><span className="num text-[28px] text-white">{pct(Math.abs(g.value), 1, false)}</span><span className="text-[13px] text-ink-300">of {pct(Math.abs(g.limit), 0, false)} limit</span></div>
                  <div className="mt-3"><Meter value={g.value} limit={g.limit} /></div>
                  <div className={`mt-2 text-[12.5px] ${u >= 1 ? 'font-medium text-dn' : u >= 0.75 ? 'font-medium text-am' : 'text-ink-300'}`}>{u >= 1 ? 'Limit reached' : u >= 0.75 ? 'Approaching limit' : `${pct(u, 0, false)} of limit used`}</div>
                </>
              )}
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-12 gap-5">
        <Panel className="col-span-12 xl:col-span-7" title="Market conditions" subtitle="Exposure, volatility and data freshness for every market." bodyClass="!px-0">
          {!s ? <div className="px-5"><Loading /></div> : (
            <div className="overflow-x-auto">
              <table className="data">
                <thead><tr><th className="!pl-5">Market</th><th className="!text-right">Exposure</th><th>Volatility vs. past year</th><th className="!text-right">Data age</th><th className="!pr-5">Status</th></tr></thead>
                <tbody>{s.instruments.map((i: any) => {
                  const hot = i.vol_percentile !== null && i.vol_percentile > (L?.max_vol_percentile as number)
                  return (
                    <tr key={i.symbol}>
                      <td className="!pl-5 font-medium text-white">{i.symbol}</td>
                      <td className="text-right">{pct(i.net_exposure_pct, 1)}</td>
                      <td><div className="flex items-center gap-3"><div className="w-28"><Meter value={i.vol_percentile ?? 0} limit={(L?.max_vol_percentile as number) ?? 1} /></div><span className="tnum text-ink-200">{i.vol_percentile === null ? '—' : `${Math.round(i.vol_percentile * 100)}th pct.`}</span></div></td>
                      <td className="text-right">{num(i.stale_days, 1)} days</td>
                      <td className="!pr-5">{i.stale ? <Badge tone="am">Stale data</Badge> : hot ? <Badge tone="dn">Too volatile</Badge> : <Badge tone="up">Tradable</Badge>}</td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel className="col-span-12 xl:col-span-5" title="Concentration" subtitle={`Markets moving together above ${num(L?.max_correlation as number, 2)} share one position limit.`}>
          {s?.correlation.symbols.length ? <Heatmap labels={s.correlation.symbols} matrix={s.correlation.matrix} size={42} /> : <Loading />}
        </Panel>
      </div>

      <div className="grid grid-cols-12 gap-5">
        <Panel className="col-span-12 xl:col-span-5" title="Limits" subtitle="Changes apply immediately and are recorded.">
          {!L ? <Loading rows={6} /> : (
            <ul className="divide-y divide-white/[0.05]">
              {Object.entries(L).filter(([k]) => k !== 'kill_switch').map(([k, v]) => (
                <li key={k} className="flex items-center gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-white">{LIMIT_LABEL[k]?.[0] ?? k}</div>
                    <div className="text-[12.5px] leading-snug text-ink-300">{LIMIT_LABEL[k]?.[1] ?? limits.data!.schema[k]?.description}</div>
                  </div>
                  <div className="flex w-[110px] shrink-0 items-center gap-1.5">
                    <input key={`${k}-${v}`} aria-label={LIMIT_LABEL[k]?.[0] ?? k} type="number" step={PCT_KEYS.has(k) ? 1 : k === 'max_correlation' ? 0.05 : 1}
                      defaultValue={PCT_KEYS.has(k) ? +((v as number) * 100).toFixed(2) : (v as number)}
                      onBlur={(e) => { const n = Number(e.target.value); const val = PCT_KEYS.has(k) ? n / 100 : n; if (val !== v) save.run({ [k]: val }) }}
                      className="w-full text-right" />
                    <span className="w-3 text-[12.5px] text-ink-300">{PCT_KEYS.has(k) ? '%' : ''}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel className="col-span-12 xl:col-span-7" title="Risk events" subtitle="Every decision the risk engine has made, with the rule that triggered it."
          right={<Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'reject', label: 'Blocked' }, { value: 'approve', label: 'Approved' }, { value: 'all', label: 'All' }]} />}>
          {!events.data ? <Loading rows={5} /> : evs.length === 0 ? <EmptyState title={filter === 'reject' ? 'Nothing has been blocked' : 'No events yet'}>Risk decisions appear here as soon as a paper order is checked.</EmptyState> : (
            <ul className="scroll-thin max-h-[560px] space-y-2 overflow-y-auto pr-1">
              {evs.slice(0, 120).map((e) => {
                const failed = e.data.checks?.filter((c) => !c.approved) ?? []
                const t = e.decision === 'reject' || e.decision === 'halt' ? 'dn' : e.decision === 'approve' ? 'up' : 'am'
                return (
                  <li key={e.id} className="rounded-[12px] bg-white/[0.02] px-4 py-3 ring-1 ring-inset ring-white/[0.05]">
                    <div className="flex items-center gap-2.5">
                      <StatusDot tone={t} />
                      <span className="text-[13.5px] font-medium text-white">{e.decision === 'reject' ? 'Order blocked' : e.decision === 'approve' ? (e.rule === 'config' ? 'Limits changed' : 'Order approved') : RULE_PLAIN[e.rule] ?? e.rule}</span>
                      {e.order_id && <span className="text-[12.5px] text-ink-300">#{e.order_id}</span>}
                      <span className="ml-auto text-[12px] text-ink-300">{ago(e.ts)}</span>
                    </div>
                    {failed.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[18px]">{failed.map((c) => <Badge key={c.rule} tone="dn" title={c.message}>{RULE_PLAIN[c.rule] ?? c.rule}</Badge>)}</div>}
                    {e.data.checks ? (
                      <div className="pl-[18px]"><Disclosure title="All checks" meta={`${e.data.checks.filter((c) => c.approved).length} of ${e.data.checks.length} passed`}>
                        <ul className="space-y-1 text-[12.5px]">{e.data.checks.map((c) => <li key={c.rule} className="flex gap-2"><span className={c.approved ? 'text-up' : 'text-dn'}>{c.approved ? '✓' : '✕'}</span><span className="text-white">{RULE_PLAIN[c.rule] ?? c.rule}</span><span className="text-ink-300">{c.message}</span></li>)}</ul>
                      </Disclosure></div>
                    ) : <div className="mt-1 pl-[18px] text-[12.5px] text-ink-300">{e.message}</div>}
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </div>
      <Notice>Paper trading only. These controls protect the simulated portfolio; SIGNAL has no connection to any broker or real account.</Notice>
      {confirm.node}
    </div>
  )
}
