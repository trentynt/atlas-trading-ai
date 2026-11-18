import { useEffect, useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { NeuralGraph } from '../components/NeuralGraph'
import { Badge, Button, Drawer, EmptyState, KeyValue, Loading, Meter, Notice, Panel, Sparkline, Spinner, StatusDot, UP, DN, ACCENT, type Tone } from '../components/ui'
import { api, slug, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { AGENT_PLAIN, CHECK_PLAIN, DISPOSITION, dispositionOf, REGIME_PLAIN, STRATEGY_PLAIN, checkName, plainReasons, shortDate, strategyName } from '../lib/explain'
import { ago, money, num, pct, price, tone } from '../lib/format'
import { symToParam } from '../lib/route'
import { useToast } from '../lib/toast'
import type { AgentInfo, Experiment, GraphData, GraphNode, Job, Market, StrategyConfig } from '../lib/types'

type Bars = Record<string, number[]>
type Regimes = Record<string, { trend: string; vol: string } | null>

export function CommandView({ go, overview: o, reloadOverview }: ViewProps) {
  const graph = useApi<GraphData>('/graph?max_experiments=1200')
  const markets = useApi<Market[]>('/markets', { poll: 60000 })
  const agents = useApi<AgentInfo[]>('/agents', { poll: 8000 })
  const jobs = useApi<Job[]>('/jobs?limit=6', { poll: 5000 })
  const exps = useApi<Experiment[]>('/experiments?kind=hypothesis_test&limit=6')
  const risk = useApi<any>('/risk/status', { poll: 20000 })
  const snaps = useApi<any[]>('/paper/snapshots?limit=1000')
  const strats = useApi<StrategyConfig[]>('/paper/strategies')
  const reports = useApi<{ id: number; created_at: string; report: any }[]>('/research/reports?limit=1')
  const [sel, setSel] = useState<GraphNode | null>(null)
  const [bars, setBars] = useState<Bars>({})
  const [regimes, setRegimes] = useState<Regimes>({})
  const toast = useToast()

  useEffect(() => {
    if (!markets.data) return
    let live = true
    Promise.all(markets.data.map(async (m) => {
      const [b, r] = await Promise.all([
        api.get<{ bars: { c: number }[] }>(`/markets/${slug(m.symbol)}/bars?limit=90`).catch(() => null),
        api.get<{ current: { trend: string; vol: string } | null }>(`/markets/${slug(m.symbol)}/regime`).catch(() => null),
      ])
      return [m.symbol, b?.bars.map((x) => x.c) ?? [], r?.current ?? null] as const
    })).then((rows) => {
      if (!live) return
      setBars(Object.fromEntries(rows.map((r) => [r[0], r[1]])))
      setRegimes(Object.fromEntries(rows.map((r) => [r[0], r[2]])))
    })
    return () => { live = false }
  }, [markets.data])

  useEventTrigger((e) => e.category === 'job' && /Completed|failed|cancelled/.test(e.message), () => {
    graph.reload(); markets.reload(); agents.reload(); exps.reload(); strats.reload(); reports.reload(); reloadOverview()
  }, 1000)
  useEventTrigger((e) => e.category === 'agent' || e.category === 'job', () => { agents.reload(); jobs.reload() }, 400)

  const running = jobs.data?.find((j) => j.type === 'research_cycle' && ['queued', 'running'].includes(j.status))
  const cycle = useAction(async () => {
    const r = await api.post<{ job_id: number }>('/jobs/research-cycle', { max_hypotheses: 8 })
    toast({ tone: 'info', title: 'Research cycle started', body: `Your research team is proposing and testing new ideas (job #${r.job_id}).` })
    jobs.reload(); reloadOverview()
  })

  const c = o?.counts
  const equity = useMemo(() => {
    const byDay = new Map<string, number>()
    snaps.data?.forEach((s) => byDay.set(s.ts.slice(0, 10), s.equity))
    return [...byDay.values()]
  }, [snaps.data])
  const deployed = strats.data?.filter((s) => s.status === 'deployed') ?? []
  const lastCycle = reports.data?.[0]?.report
  const topReasons = Object.entries(lastCycle?.rejection_reasons ?? {}).slice(0, 3) as [string, number][]

  const summary = (() => {
    if (!o || !c) return 'Connecting to your research engine…'
    const fresh = markets.data?.filter((m) => !m.is_stale).length ?? 0
    const parts = [
      `Your research team has tested ${c.experiments} strategy idea${c.experiments === 1 ? '' : 's'}${c.experiments ? `; ${c.accepted === 0 ? 'none' : c.accepted} survived current validation${c.requires_confirmation ? ` and ${c.requires_confirmation} await${c.requires_confirmation === 1 ? 's' : ''} confirmation on new data` : ''}` : ''}.`,
      `${fresh} of ${markets.data?.length ?? 5} markets have up-to-date data.`,
      `Your paper portfolio is ${o.paper.state === 'running' ? 'running' : o.paper.state === 'halted' ? 'halted by the kill switch' : 'paused'} at ${money(o.paper.equity)}.`,
    ]
    return parts.join(' ')
  })()

  const attention: { tone: Tone; title: string; body: string; action?: [string, () => void] }[] = []
  if (o?.kill_switch) attention.push({ tone: 'dn', title: 'The kill switch is engaged', body: 'Only orders that reduce exposure will be accepted.', action: ['Review risk', () => go('risk')] })
  if (running) attention.push({ tone: 'cy', title: 'Research in progress', body: `${running.message ?? 'Working'} · ${Math.round(running.progress * 100)}% complete`, action: ['Follow along', () => go('research')] })
  markets.data?.filter((m) => m.is_stale).forEach((m) => attention.push({ tone: 'am', title: `${m.symbol} data is stale`, body: `Last bar ${m.last_ts}. Strategies on it won't trade until it refreshes.`, action: ['Open market', () => go('markets', { sym: symToParam(m.symbol) })] }))
  if (deployed.length && o?.paper.state !== 'running') attention.push({ tone: 'am', title: `${deployed.length} paper strateg${deployed.length === 1 ? 'y is' : 'ies are'} waiting`, body: 'They survived current validation, but the paper engine is paused.', action: ['Open portfolio', () => go('portfolio')] })
  if ((c?.risk_rejections ?? 0) > 0) attention.push({ tone: 'mute', title: `${c!.risk_rejections} paper order${c!.risk_rejections === 1 ? ' was' : 's were'} blocked by risk limits`, body: 'Every block is recorded with the rule that triggered it.', action: ['See why', () => go('risk')] })
  if (o && !o.autonomy.config.enabled) attention.push({ tone: 'mute', title: 'Autonomous research is off', body: 'Research runs only when you start it.', action: ['Set a schedule', () => go('research')] })

  return (
    <div className="space-y-6">
      {/* hero */}
      <section className="rise flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="max-w-[820px]">
          <div className="text-[13px] font-medium text-ink-300">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <h1 className="mt-1 text-[30px] leading-[1.15] font-semibold tracking-[-0.025em] text-white">Overview</h1>
          <p className="mt-2 text-[15.5px] leading-relaxed text-ink-200">{summary}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button tone="primary" onClick={() => cycle.run()} disabled={cycle.pending || !!running}
            icon={running ? <Spinner size={14} /> : <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor"><path d="M4.5 3v10l8.5-5-8.5-5Z" /></svg>}>
            {running ? 'Research running…' : 'Run research cycle'}
          </Button>
          <Button onClick={() => go('experiments')}>View discoveries</Button>
        </div>
      </section>
      {cycle.error && <Notice tone="dn" title="Couldn't start research">{cycle.error}</Notice>}

      {/* network + side column */}
      <div className="grid grid-cols-12 gap-5">
        <Panel className="rise col-span-12 xl:col-span-8" title="Your research network"
          subtitle={graph.data ? `${graph.data.nodes.length} entities and ${graph.data.edges.length} recorded relationships from your research database. Light travels only when something actually happens.` : 'Loading the research database…'}
          bodyClass="!p-0">
          <div className="relative">
            {graph.error ? <div className="p-5"><Notice tone="dn">{graph.error}</Notice></div>
              : <NeuralGraph data={graph.data} onSelect={setSel} selected={sel?.id ?? null} height={560} />}
            <div className="pointer-events-none absolute bottom-3 left-5 flex max-w-[calc(100%-140px)] flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-ink-300">
              {([['#5eead4', 'Agents'], ['#7cb4ff', 'Markets'], ['#b4a7f5', 'Strategy families'], ['#6ee7a8', 'Survived'], ['#f5b553', 'Awaiting confirmation'], ['#ff6b6b', 'Rejected'], ['#f5b553', 'Paper trading'] ] as const).map(([col, l]) => (
                <span key={l} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: col }} />{l}</span>
              ))}
            </div>
          </div>
        </Panel>

        <div className="col-span-12 flex flex-col gap-5 xl:col-span-4">
          <Panel className="rise flex-1" title="Needs your attention" right={attention.length ? <Badge>{attention.length}</Badge> : undefined}>
            {!o ? <Loading /> : attention.length === 0 ? (
              <EmptyState title="All clear" icon={<svg viewBox="0 0 20 20" className="h-5 w-5 text-up" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m5 10 3.5 3.5L15 7" strokeLinecap="round" strokeLinejoin="round" /></svg>}>Nothing needs you right now.</EmptyState>
            ) : (
              <ul className="stagger -mx-1 space-y-1">
                {attention.slice(0, 5).map((a) => (
                  <li key={a.title}>
                    <button onClick={a.action?.[1]} className="group flex w-full items-start gap-3 rounded-[12px] px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.04]">
                      <StatusDot tone={a.tone} pulse={a.tone === 'cy'} />
                      <span className="-mt-[5px] min-w-0 flex-1">
                        <span className="block text-[13.5px] font-medium text-white">{a.title}</span>
                        <span className="block text-[12.5px] leading-snug text-ink-300">{a.body}</span>
                      </span>
                      {a.action && <span className="-mt-[3px] shrink-0 text-[12.5px] font-medium text-cy opacity-80 group-hover:opacity-100">{a.action[0]} →</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {/* markets */}
      <section>
        <SectionTitle title="Your markets" action={['All markets', () => go('markets')]} note="Daily data. Forex prices are ECB reference rates, not live quotes." />
        <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {(markets.data ?? Array.from({ length: 5 }, () => null)).map((m, i) => m ? (
            <button key={m.symbol} onClick={() => go('markets', { sym: symToParam(m.symbol) })}
              className="panel group px-5 pt-4 pb-3 text-left outline outline-1 outline-transparent transition-[outline-color] hover:outline-white/[0.12]">
              <div className="flex items-center justify-between">
                <span className="text-[14.5px] font-semibold text-white">{m.symbol}</span>
                <span className="text-[12px] text-ink-300">{m.asset_class === 'fx' ? 'Forex' : 'Crypto'}</span>
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="num text-[22px] text-white">{price(m.last_close, m.price_decimals)}</span>
                <span className={`num text-[13px] ${tone(m.change_1d)}`}>{pct(m.change_1d)}</span>
              </div>
              <div className="mt-2 -mx-1"><Sparkline values={bars[m.symbol] ?? []} color={(bars[m.symbol]?.at(-1) ?? 0) >= (bars[m.symbol]?.[0] ?? 0) ? UP : DN} height={40} /></div>
              <div className="mt-2 flex items-center justify-between text-[12px] text-ink-300">
                <span className="truncate">{regimes[m.symbol] ? REGIME_PLAIN[regimes[m.symbol]!.trend] : '\u00a0'}{regimes[m.symbol]?.vol === 'high_vol' ? ' · volatile' : ''}</span>
                <span className={`shrink-0 pl-2 ${m.is_stale ? 'text-am' : ''}`}>{m.is_stale ? 'Stale' : shortDate(m.last_ts)}</span>
              </div>
            </button>
          ) : <div key={i} className="panel h-[168px] p-5"><Loading /></div>)}
        </div>
      </section>

      {/* findings + team */}
      <div className="grid grid-cols-12 gap-5">
        <Panel className="col-span-12 lg:col-span-7" title="Latest findings" subtitle="What your research team concluded, in plain language."
          right={<Button small tone="ghost" onClick={() => go('experiments')}>All discoveries</Button>}>
          {!exps.data ? <Loading rows={4} /> : exps.data.length === 0 ? (
            <EmptyState title="No findings yet" action={<Button tone="primary" small onClick={() => cycle.run()}>Run your first research cycle</Button>}>
              Your research team proposes strategy ideas, tests them on data they've never seen, and rejects anything that could be luck.
            </EmptyState>
          ) : (
            <ul className="stagger divide-y divide-white/[0.05]">
              {exps.data.map((e) => <Finding key={e.id} e={e} onOpen={() => go('experiments', { id: e.id })} />)}
            </ul>
          )}
        </Panel>
        <Panel className="col-span-12 lg:col-span-5" title="Research cycle"
          subtitle={running ? 'Running now.' : o?.autonomy.config.enabled ? `Runs every ${o.autonomy.config.research_interval_minutes} minutes while SIGNAL is running.` : 'Runs when you start it. Set a schedule on the Research page.'}
          right={<Button small tone="ghost" onClick={() => go('research')}>Open research</Button>}>
          {running ? (
            <div>
              <div className="flex items-baseline justify-between gap-3 text-[13.5px]"><span className="min-w-0 truncate text-ink-100">{running.message ?? 'Starting…'}</span><span className="num text-white">{pct(running.progress, 0, false)}</span></div>
              <div className="mt-2"><Meter value={running.progress} limit={1.25} /></div>
            </div>
          ) : !reports.data ? <Loading /> : !lastCycle ? (
            <EmptyState title="No cycles yet">A cycle proposes ideas, tests them on later data not used for fitting and explains every rejection.</EmptyState>
          ) : (
            <div className="space-y-4">
              <p className="text-[14.5px] leading-relaxed text-ink-100">
                The last cycle ({ago(reports.data[0].created_at)}) tested <b className="text-white">{lastCycle.evaluated}</b> ideas. {lastCycle.accepted ? <><b className="text-up">{lastCycle.accepted}</b> survived current validation.</> : 'None survived, which is the usual outcome.'}
              </p>
              {topReasons.length > 0 && (
                <div>
                  <div className="label mb-1">Most common reasons for rejection</div>
                  <ul className="divide-y divide-white/[0.05]">
                    {topReasons.map(([k, v]) => <li key={k} className="flex justify-between py-2 text-[13.5px]"><span className="text-ink-100">{CHECK_PLAIN[k]?.short ?? k}</span><span className="num text-ink-300">{v} of {lastCycle.evaluated}</span></li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>

      {/* portfolio + risk */}
      <div className="grid grid-cols-12 gap-5">
        <Panel className="col-span-12 lg:col-span-6" title="Paper portfolio" tag={<Badge tone="am">Simulated</Badge>} right={<Button small tone="ghost" onClick={() => go('portfolio')}>Open portfolio</Button>}>
          {!o ? <Loading /> : (
            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <div>
                <div className="num text-[30px] leading-none tracking-[-0.03em] text-white">{money(o.paper.equity)}</div>
                <div className={`num mt-1.5 text-[13.5px] ${tone(o.paper.total_return)}`}>{pct(o.paper.total_return)} since start</div>
                <div className="mt-4"><KeyValue rows={[['Engine', <span className="capitalize">{o.paper.state}</span>], ['Paper strategies', deployed.length], ['Open exposure', money(o.paper.gross_exposure)]]} /></div>
              </div>
              <div className="flex flex-col justify-end">
                {equity.length > 1 ? <Sparkline values={equity} color={ACCENT} height={110} minRange={(equity[0] ?? 0) * 0.02} /> : (
                  <div className="flex h-[110px] items-center justify-center rounded-[12px] bg-white/[0.025] px-4 text-center text-[12.5px] text-ink-300">The equity curve builds as the paper engine runs — one point per day.</div>
                )}
              </div>
            </div>
          )}
        </Panel>
        <Panel className="col-span-12 lg:col-span-6" title="Risk" tag={o?.kill_switch ? <Badge tone="dn">Kill switch on</Badge> : <Badge tone="up">Within limits</Badge>} right={<Button small tone="ghost" onClick={() => go('risk')}>Open risk</Button>}>
          {!risk.data ? <Loading /> : (
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              {([['drawdown', 'Drawdown from peak'], ['daily_pnl', "Today's loss"], ['gross_exposure', 'Total exposure'], ['max_position', 'Largest position']] as const).map(([k, l]) => {
                const g = risk.data.gauges[k]
                return (
                  <div key={k}>
                    <div className="flex items-baseline justify-between"><span className="text-[13px] text-ink-200">{l}</span><span className="num text-[13px] text-white">{pct(Math.abs(g.value), 1, false)} <span className="font-normal text-ink-300">of {pct(Math.abs(g.limit), 0, false)}</span></span></div>
                    <div className="mt-1.5"><Meter value={g.value} limit={g.limit} /></div>
                  </div>
                )
              })}
            </div>
          )}
        </Panel>
      </div>

      <NodeInspector node={sel} onClose={() => setSel(null)} go={go} />
    </div>
  )
}

function SectionTitle({ title, action, note }: { title: string; action?: [string, () => void]; note?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-white">{title}</h2>
        {note && <p className="text-[12.5px] text-ink-300">{note}</p>}
      </div>
      {action && <Button small tone="ghost" onClick={action[1]}>{action[0]}</Button>}
    </div>
  )
}

function Finding({ e, onOpen }: { e: Experiment; onOpen: () => void }) {
  const t = e.metrics?.test ?? {}
  const d = dispositionOf(e) ?? 'rejected'
  const ok = d === 'survived'
  const reasons = plainReasons(e.reasons, 2)
  return (
    <li>
      <button onClick={onOpen} className="group -mx-2 flex w-[calc(100%+16px)] items-start gap-4 rounded-[12px] px-2 py-3 text-left transition-colors hover:bg-white/[0.03]">
        <span className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${ok ? 'bg-up/[0.13] text-up' : d === 'rejected' ? 'bg-dn/[0.12] text-dn' : 'bg-am/[0.12] text-am'}`}>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">{ok ? <path d="m4 8.5 2.5 2.5L12 5" /> : <path d="M5 5l6 6M11 5l-6 6" />}</svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium text-white">{strategyName(e.strategy)} <span className="font-normal text-ink-300">on</span> {e.symbol}</span>
          <span className="mt-0.5 block text-[13px] leading-snug text-ink-200">
            {d === 'rejected' ? `Rejected — ${reasons.join(', ').toLowerCase() || 'did not meet the evidence bar'}.` : `${DISPOSITION[d].label}.`}
          </span>
          <span className="mt-1 block text-[12px] text-ink-300">{STRATEGY_PLAIN[e.strategy ?? ''] ?? ''}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className={`num block text-[14px] ${tone(t.total_return)}`}>{pct(t.total_return, 1)}</span>
          <span className="block text-[11.5px] text-ink-300">selection test</span>
        </span>
      </button>
    </li>
  )
}

function NodeInspector({ node, onClose, go }: { node: GraphNode | null; onClose: () => void; go: ViewProps['go'] }) {
  const expId = node?.kind === 'experiment' ? node.id.split(':')[1] : null
  const exp = useApi<Experiment>(expId ? `/experiments/${expId}` : null, { deps: [expId] })
  const e = exp.data
  const kindName: Record<string, string> = { core: 'System', agent: 'Research agent', risk: 'Risk control', paper: 'Paper broker', forecast: 'Forecasting', data: 'Market dataset', strategy_type: 'Strategy family', feature: 'Feature', experiment: 'Strategy experiment', deployed: 'Approved strategy', job: 'Job', run: 'Agent run' }
  const id = node?.id.split(':').slice(1).join(':') ?? ''
  const links: [string, () => void][] = []
  if (node?.kind === 'experiment') links.push(['Open in Discoveries', () => go('experiments', { id })])
  if (node?.kind === 'data') links.push(['Open market', () => go('markets', { sym: symToParam(id) })], ['Test a strategy on it', () => go('strategy', { sym: symToParam(id) })])
  if (node?.kind === 'strategy_type') links.push(['Test this strategy', () => go('strategy', { strategy: id })])
  if (node?.kind === 'agent' || node?.kind === 'run' || node?.kind === 'core') links.push(['Open research', () => go('research')])
  if (node?.kind === 'risk') links.push(['Open risk', () => go('risk')])
  if (node?.kind === 'paper' || node?.kind === 'deployed') links.push(['Open portfolio', () => go('portfolio')])
  if (node?.kind === 'forecast') links.push(['Open forecasts', () => go('forecast')])
  if (node?.kind === 'job') links.push(['Open activity', () => go('telemetry')])
  const attrs = node ? Object.entries(node).filter(([k, v]) => ['verdict', 'sharpe', 'trades', 'rows', 'version', 'status', 'family', 'allocation', 'ms'].includes(k) && v !== null && v !== undefined) : []
  return (
    <Drawer open={!!node} onClose={onClose} width={460} title={node ? <span><span className="block text-[12.5px] font-medium text-cy">{kindName[node.kind] ?? node.kind}</span>{node.label}</span> : ''}
      footer={links.map(([l, f], i) => <Button key={l} tone={i === 0 ? 'primary' : 'default'} onClick={() => { f(); onClose() }}>{l}</Button>)}>
      {node && (
        <div className="space-y-5">
          <p className="text-[13.5px] leading-relaxed text-ink-200">
            {node.kind === 'agent' ? AGENT_PLAIN[id]?.role
              : node.kind === 'strategy_type' ? STRATEGY_PLAIN[id]
              : node.kind === 'data' ? 'A versioned daily dataset. Every experiment records exactly which version it used, so results can be reproduced.'
              : node.kind === 'feature' ? 'A statistical feature computed from market data using only information available at the time.'
              : node.kind === 'run' ? 'One recorded execution of a research agent, with its inputs and outputs stored for audit.'
              : node.kind === 'deployed' ? 'A strategy that survived current validation and trades in the simulated paper portfolio.'
              : node.kind === 'experiment' ? (e?.hypothesis?.rationale ?? (exp.loading ? '' : 'A strategy idea tested on historical data.'))
              : 'Part of your SIGNAL research operation.'}
          </p>
          {node.kind === 'experiment' && (exp.loading && !e ? <Loading /> : e && (
            <>
              <div className={`rounded-[14px] px-4 py-3 ring-1 ring-inset ${dispositionOf(e) === 'survived' ? 'bg-up/[0.07] ring-up/20' : dispositionOf(e) === 'rejected' ? 'bg-dn/[0.07] ring-dn/20' : 'bg-am/[0.07] ring-am/20'}`}>
                <div className={`text-[14px] font-semibold ${dispositionOf(e) === 'survived' ? 'text-up' : dispositionOf(e) === 'rejected' ? 'text-dn' : 'text-am'}`}>{DISPOSITION[dispositionOf(e) ?? 'rejected'].label}</div>
                <ul className="mt-1 space-y-1 text-[13px] text-ink-200">
                  {(e.reasons ?? []).slice(0, 4).map((r) => <li key={r}>{CHECK_PLAIN[checkName(r)]?.long ?? r}</li>)}
                  {dispositionOf(e) !== 'rejected' && <li>{DISPOSITION[dispositionOf(e) ?? 'rejected'].explain}</li>}
                </ul>
              </div>
              <KeyValue rows={[
                ['Return, selection test', <span className={tone(e.metrics?.test?.total_return)}>{pct(e.metrics?.test?.total_return)}</span>],
                ['Sharpe, selection test', num(e.metrics?.test?.sharpe)],
                ['Worst drawdown', pct(e.metrics?.test?.max_drawdown)],
                ['Trades', e.metrics?.test?.num_trades ?? '—'],
                ['Attempts on this market', e.metrics?.n_trials ? `${e.metrics.n_trials} (≈${num(e.metrics.n_eff, 0)} independent)` : '—'],
                ['Dataset version', <span className="font-mono text-[12px]">{e.dataset_version}</span>],
              ]} />
              <p className="text-[12px] text-ink-300">Historical simulation. Passing these tests is not evidence of future profit.</p>
            </>
          ))}
          {node.kind !== 'experiment' && attrs.length > 0 && <KeyValue rows={attrs.map(([k, v]) => [<span className="capitalize">{k}</span>, typeof v === 'number' ? num(v, Number.isInteger(v) ? 0 : 3) : String(v)])} />}
          <div className="text-[12.5px] text-ink-300">{String(node.deg ?? 0)} recorded relationship{node.deg === 1 ? '' : 's'} in your research database.</div>
        </div>
      )}
    </Drawer>
  )
}
