import { useEffect, useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { Histogram, Scatter } from '../components/charts/Svg'
import { TimeChart, toLine } from '../components/charts/TimeChart'
import { Badge, Button, DN, Disclosure, Drawer, EmptyState, ErrorBox, HistTag, KeyValue, Legend, Loading, NEUTRAL, Notice, Panel, PageHeader, SERIES, Segmented, StatusDot, Tabs, UP } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { CHECK_NAME, CHECK_PLAIN, STRATEGY_PLAIN, plainReasons, shortDate, strategyName } from '../lib/explain'
import { ago, num, pct, tone } from '../lib/format'
import { navigate, paramToSym, useRoute } from '../lib/route'
import { useToast } from '../lib/toast'
import type { CriticCheck, Experiment } from '../lib/types'

export function ExperimentsView({ go }: ViewProps) {
  const { params } = useRoute()
  const [kind, setKind] = useState<'hypothesis_test' | 'manual_backtest'>('hypothesis_test')
  const [verdict, setVerdict] = useState<'all' | 'accepted' | 'rejected'>('all')
  const [market, setMarket] = useState(params.get('sym') ? paramToSym(params.get('sym')!) : 'all')
  const [q, setQ] = useState('')
  const [compare, setCompare] = useState<number[]>([])
  const [compareOpen, setCompareOpen] = useState(false)
  const list = useApi<Experiment[]>(`/experiments?kind=${kind}&limit=1000`, { deps: [kind] })
  const dist = useApi<{ points: any[]; critic_rules: Record<string, number> }>('/experiments-stats/distribution')
  const selId = params.get('id') ? Number(params.get('id')) : null
  const setSel = (id: number | null) => navigate('experiments', { id: id ?? undefined, sym: params.get('sym') ?? undefined })
  useEventTrigger((e) => e.category === 'research', () => { list.reload(); dist.reload() }, 1500)

  const rows = useMemo(() => (list.data ?? []).filter((e) =>
    (kind !== 'hypothesis_test' || verdict === 'all' || e.verdict === verdict) &&
    (market === 'all' || e.symbol === market) &&
    (!q || `${strategyName(e.strategy)} ${e.symbol} ${e.id}`.toLowerCase().includes(q.toLowerCase()))), [list.data, kind, verdict, market, q])
  useEffect(() => { if (!selId && rows.length && window.innerWidth >= 1280) setSel(rows[0].id) }, [rows.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const pts = useMemo(() => (dist.data?.points ?? []).filter((p) => p.is_sharpe !== null && p.oos_sharpe !== null).map((p) => ({
    id: p.id, x: p.is_sharpe, y: p.oos_sharpe, group: p.verdict, color: p.verdict === 'accepted' ? UP : DN, label: `${strategyName(p.strategy)} · ${p.symbol}`,
  })), [dist.data])
  const oos = (dist.data?.points ?? []).map((p) => p.oos_sharpe).filter((x): x is number => x !== null)
  const total = dist.data?.points.length ?? 0
  const acc = (dist.data?.points ?? []).filter((p) => p.verdict === 'accepted').length
  const markets = [...new Set((list.data ?? []).map((e) => e.symbol).filter(Boolean))] as string[]

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Discoveries" title="Research evidence library"
        subtitle="Every strategy idea your research team has tested, the evidence behind it, and the verdict. Rejection is the default — an idea is accepted only when the evidence is strong."
        actions={compare.length > 0 && <Button onClick={() => setCompareOpen(true)}>Compare {compare.length}</Button>} />

      <p className="-mt-2 text-[14.5px] leading-relaxed text-ink-200">
        {total ? <><b className="text-white">{total}</b> ideas tested so far, <b className="text-up">{acc}</b> accepted ({pct(acc / total, 0, false)}). The bar rises with every idea tried, so a lucky result can’t slip through.</> : 'No ideas have been tested yet.'}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={kind} onChange={(v) => { setKind(v); setSel(null) }} options={[{ value: 'hypothesis_test', label: 'Research ideas' }, { value: 'manual_backtest', label: 'Your backtests' }]} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {kind === 'hypothesis_test' && <Segmented size="sm" value={verdict} onChange={setVerdict} options={[{ value: 'all', label: 'All' }, { value: 'accepted', label: 'Accepted' }, { value: 'rejected', label: 'Rejected' }]} />}
          <select value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Market" className="!py-1.5"><option value="all">All markets</option>{markets.map((m) => <option key={m}>{m}</option>)}</select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="w-40 !py-1.5" aria-label="Search discoveries" />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-5">
        <div className="col-span-12 xl:col-span-5">
          {!list.data ? <Panel><Loading rows={6} /></Panel> : rows.length === 0 ? (
            <Panel><EmptyState title="No discoveries match" action={<Button small onClick={() => go('research')}>Run research</Button>}>Try a different filter, or run a research cycle to test new ideas.</EmptyState></Panel>
          ) : (
            <ul className="scroll-thin stagger space-y-2.5 xl:max-h-[1100px] xl:overflow-y-auto xl:pr-1">
              {rows.map((e) => {
                const t = e.metrics?.test ?? {}
                const on = e.id === selId
                return (
                  <li key={e.id}>
                    <div role="button" tabIndex={0} onClick={() => setSel(e.id)} onKeyDown={(k) => k.key === 'Enter' && setSel(e.id)}
                      className={`panel cursor-pointer px-5 py-4 transition-all duration-150 ${on ? '!border-cy/40' : 'outline outline-1 outline-transparent hover:outline-white/[0.12]'}`}>
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-[14.5px] font-medium text-white">{strategyName(e.strategy)} <span className="font-normal text-ink-300">on</span> {e.symbol}</div>
                          <div className="mt-0.5 text-[12.5px] text-ink-300">#{e.id} · {ago(e.created_at)}{e.cycle_id ? ` · cycle ${e.cycle_id}` : ''}</div>
                        </div>
                        {e.verdict ? <Badge tone={e.verdict === 'accepted' ? 'up' : 'dn'}>{e.verdict === 'accepted' ? 'Accepted' : 'Rejected'}</Badge> : <Badge>Backtest</Badge>}
                      </div>
                      <div className="mt-3 flex items-end justify-between gap-3">
                        <div className="flex min-w-0 flex-wrap gap-1.5">{plainReasons(e.reasons, 3).map((r) => <span key={r} className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[12px] text-ink-200">{r}</span>)}</div>
                        <div className="shrink-0 text-right"><div className={`num text-[16px] ${tone(t.total_return)}`}>{pct(t.total_return, 1)}</div><div className="text-[11.5px] text-ink-300">{e.verdict ? 'unseen data' : 'full history'}</div></div>
                      </div>
                      <label onClick={(ev) => ev.stopPropagation()} className="mt-3 inline-flex items-center gap-2 text-[12.5px] text-ink-300">
                        <input type="checkbox" checked={compare.includes(e.id)} onChange={(ev) => setCompare(ev.target.checked ? [...compare, e.id].slice(-3) : compare.filter((x) => x !== e.id))} />Compare
                      </label>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="col-span-12 xl:col-span-7">
          <div className="xl:sticky xl:top-0">
            {selId ? <Detail id={selId} go={go} /> : <Panel><EmptyState title="Select a discovery">See its evidence, the critic's checks, risk analysis and how to reproduce it.</EmptyState></Panel>}
          </div>
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-[18px] font-semibold tracking-[-0.015em] text-white">The bigger picture</h2>
        <div className="grid grid-cols-12 gap-5">
          <Panel className="col-span-12 lg:col-span-7" title="Looked good vs. held up" subtitle="Each dot is an idea. Far below the diagonal = it looked great on design data and fell apart on new data."
            right={<Legend items={[{ label: 'Accepted', color: UP }, { label: 'Rejected', color: DN }, { label: 'Equal', color: NEUTRAL, dashed: true }]} />}>
            {pts.length ? <Scatter points={pts} xLabel="Sharpe on design data" yLabel="Sharpe on unseen data" diagonal refY={dist.data?.critic_rules.min_test_sharpe} onPick={(id) => setSel(Number(id))} height={300} /> : <EmptyState title="No data yet" />}
          </Panel>
          <Panel className="col-span-12 lg:col-span-5" title="How ideas performed on unseen data" tag={<HistTag />}>
            {oos.length ? <Histogram values={oos} color={SERIES[0]} xLabel="Sharpe on unseen data" refLine={0} height={250} /> : <EmptyState title="No data yet" />}
          </Panel>
        </div>
      </section>

      <CompareDrawer ids={compare} open={compareOpen} onClose={() => setCompareOpen(false)} />
    </div>
  )
}

function Detail({ id, go }: { id: number; go: ViewProps['go'] }) {
  const e = useApi<Experiment>(`/experiments/${id}`, { deps: [id] })
  const [repro, setRepro] = useState<any>(null)
  const toast = useToast()
  useEffect(() => setRepro(null), [id])
  const reproduce = useAction(async () => setRepro(await api.post(`/experiments/${id}/reproduce`)))
  const deploy = useAction(async () => {
    const r = await api.post<{ id: number }>('/paper/strategies', { experiment_id: id, allocation: 0.1 })
    toast({ tone: 'success', title: 'Added to paper portfolio', body: `Strategy #${r.id} with a 10% allocation. It trades only when the paper engine is running.` })
  })
  const x = e.data
  const bt = x?.artifacts?.test_backtest
  const series = useMemo(() => bt ? [
    { kind: 'line' as const, id: 'eq', label: 'Strategy', color: SERIES[0], data: toLine(bt.series.equity) },
    { kind: 'line' as const, id: 'bm', label: 'Buy & hold', color: NEUTRAL, data: toLine(bt.series.benchmark), dashed: true, width: 1 },
  ] : [], [bt])
  const fmtMoney = useMemo(() => (v: number) => `$${Math.round(v).toLocaleString()}`, [])
  if (!x) return <Panel>{e.error ? <ErrorBox error={e.error} /> : <Loading rows={8} />}</Panel>
  const m = x.metrics ?? {}
  const checks: CriticCheck[] = x.artifacts?.critic?.checks ?? []
  const risk = x.artifacts?.risk
  const ok = x.verdict === 'accepted'
  return (
    <Panel title={<span>{strategyName(x.strategy)} <span className="font-normal text-ink-300">on</span> {x.symbol}</span>} subtitle={`Experiment #${id} · ${new Date(x.created_at).toLocaleString()}`}
      right={<><Button small onClick={() => reproduce.run()} disabled={reproduce.pending}>{reproduce.pending ? 'Reproducing…' : 'Reproduce'}</Button>{ok && <Button small tone="primary" onClick={() => deploy.run()} disabled={deploy.pending}>Paper-trade it</Button>}</>}>
      <div className="space-y-5">
        <ErrorBox error={reproduce.error || deploy.error} />
        {x.verdict && (
          <div className={`rounded-[14px] px-5 py-4 ring-1 ring-inset ${ok ? 'bg-up/[0.06] ring-up/20' : 'bg-dn/[0.06] ring-dn/20'}`}>
            <div className={`text-[16px] font-semibold ${ok ? 'text-up' : 'text-dn'}`}>{ok ? 'Accepted — the evidence held up' : 'Rejected — the evidence was not strong enough'}</div>
            <ul className="mt-1.5 space-y-1 text-[13.5px] leading-relaxed text-ink-100">
              {ok ? <li>It passed every blocking check, including tests on unseen data, doubled costs, nearby settings and a correction for how many ideas have been tried.</li>
                : (x.reasons ?? []).map((r) => r.split(':')[0]).map((k) => <li key={k}>{CHECK_PLAIN[k]?.long ?? k}</li>)}
            </ul>
          </div>
        )}
        {repro && <Notice tone={repro.match ? 'up' : 'am'} title={repro.match ? 'Reproduced exactly' : 'Result differs'}>Re-ran from dataset snapshot {repro.dataset_version}. {repro.note ?? 'Same code version, same numbers.'}</Notice>}
        <p className="text-[13.5px] leading-relaxed text-ink-200">{STRATEGY_PLAIN[x.strategy ?? '']} {x.hypothesis?.origin === 'queue' ? 'This was a follow-up queued by an earlier cycle.' : ''}</p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[['Return, unseen data', pct(m.test?.total_return, 1), tone(m.test?.total_return)], ['Sharpe, unseen data', num(m.test?.sharpe), ''], ['Worst drawdown', pct(m.test?.max_drawdown, 1), 'text-dn'], ['Trades', m.test?.num_trades ?? '—', '']].map(([l, v, c]) => (
            <div key={l as string}><div className="label">{l}</div><div className={`num text-[20px] text-white ${c}`}>{v}</div></div>
          ))}
        </div>
        {bt && <div><Legend items={[{ label: 'Strategy (final test period)', color: SERIES[0] }, { label: 'Buy & hold', color: NEUTRAL, dashed: true }]} /><TimeChart series={series} height={210} format={fmtMoney} /></div>}
        {checks.length > 0 && (
          <div>
            <div className="mb-2 text-[14px] font-medium text-white">The critic's checks <span className="font-normal text-ink-300">· {checks.filter((c) => c.passed).length} of {checks.length} passed</span></div>
            <ul className="grid gap-x-6 sm:grid-cols-2">
              {checks.map((c) => (
                <li key={c.name} className="flex items-center gap-2.5 border-b border-white/[0.04] py-2" title={c.explanation}>
                  <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full ${c.passed ? 'bg-up/[0.15] text-up' : c.blocking ? 'bg-dn/[0.13] text-dn' : 'bg-am/[0.13] text-am'}`}>
                    <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">{c.passed ? <path d="m4 8.5 2.5 2.5L12 5" /> : <path d="M5 5l6 6M11 5l-6 6" />}</svg>
                  </span>
                  <span className="flex-1 text-[13px] text-ink-100">{CHECK_NAME[c.name] ?? c.name}{!c.blocking && <span className="text-ink-400"> · advisory</span>}</span>
                  <span className="tnum text-[12px] text-ink-300">{typeof c.value === 'number' ? num(c.value, 2) : String(c.value ?? '—')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {risk?.failure_scenarios?.length > 0 && (
          <Disclosure title="How it could fail" meta={`${risk.failure_scenarios.length} scenarios`} defaultOpen>
            <ul className="space-y-1.5 text-[13px] text-ink-200">{risk.failure_scenarios.map((s: string) => <li key={s} className="flex gap-2"><StatusDot tone="am" /><span className="-mt-[5px]">{s}</span></li>)}</ul>
          </Disclosure>
        )}
        <Disclosure title="Reproducibility" meta={x.dataset_version ?? ''}>
          <KeyValue rows={[
            ['Dataset version', <span className="font-mono text-[12px]">{x.dataset_version}</span>],
            ['Code version', <span className="font-mono text-[12px]">{x.code_version}</span>],
            ['Settings', Object.entries(x.params ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')],
            ...(x.config?.splits ? Object.entries(x.config.splits as Record<string, string[]>).map(([k, v]) => [{ train: 'Design period', validation: 'Validation', test: 'Final test' }[k] ?? k, `${shortDate(v[0])} ${v[0].slice(0, 4)} – ${shortDate(v[1])} ${v[1].slice(0, 4)}`] as [string, string]) : []),
            ['Ideas tried on this market', m.n_trials ?? '—'],
          ]} />
        </Disclosure>
        <div className="flex flex-wrap gap-2">
          <Button small tone="ghost" onClick={() => go('strategy', { strategy: x.strategy ?? undefined, sym: x.symbol?.replace('/', '-') })}>Open in Strategies</Button>
          <Button small tone="ghost" onClick={() => go('markets', { sym: x.symbol?.replace('/', '-') })}>View {x.symbol}</Button>
        </div>
        <p className="text-[12px] text-ink-400">Historical simulation. Passing these checks is not evidence of future profit.</p>
      </div>
    </Panel>
  )
}

function CompareDrawer({ ids, open, onClose }: { ids: number[]; open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<Experiment[]>([])
  useEffect(() => {
    if (!open) return
    Promise.all(ids.map((i) => api.get<Experiment>(`/experiments/${i}`))).then(setRows).catch(() => setRows([]))
  }, [open, ids])
  const metric = (label: string, f: (e: Experiment) => React.ReactNode) => (
    <tr><td className="text-ink-300">{label}</td>{rows.map((e) => <td key={e.id} className="text-right">{f(e)}</td>)}</tr>
  )
  return (
    <Drawer open={open} onClose={onClose} width={760} title="Compare discoveries">
      {!rows.length ? <Loading /> : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th />{rows.map((e) => <th key={e.id} className="!text-right">{strategyName(e.strategy)}<div className="font-normal text-ink-400">{e.symbol} · #{e.id}</div></th>)}</tr></thead>
            <tbody>
              {metric('Verdict', (e) => e.verdict ? <Badge tone={e.verdict === 'accepted' ? 'up' : 'dn'}>{e.verdict === 'accepted' ? 'Accepted' : 'Rejected'}</Badge> : 'Backtest')}
              {metric('Return, design period', (e) => <span className={tone(e.metrics?.train?.total_return)}>{pct(e.metrics?.train?.total_return, 1)}</span>)}
              {metric('Return, validation', (e) => <span className={tone(e.metrics?.validation?.total_return)}>{pct(e.metrics?.validation?.total_return, 1)}</span>)}
              {metric('Return, unseen data', (e) => <span className={tone(e.metrics?.test?.total_return)}>{pct(e.metrics?.test?.total_return, 1)}</span>)}
              {metric('Sharpe, unseen data', (e) => num(e.metrics?.test?.sharpe))}
              {metric('Worst drawdown', (e) => pct(e.metrics?.test?.max_drawdown, 1))}
              {metric('Trades', (e) => e.metrics?.test?.num_trades ?? '—')}
              {metric('Luck-adjusted confidence', (e) => num(e.metrics?.dsr_test))}
              {metric('Significance (p)', (e) => num(e.metrics?.bootstrap_p_test, 2))}
              {metric('Sharpe with 2× costs', (e) => num(e.metrics?.cost_stress?.x2?.sharpe))}
            </tbody>
          </table>
        </div>
      )}
    </Drawer>
  )
}
