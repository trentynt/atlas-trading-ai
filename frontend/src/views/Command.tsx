import { useState } from 'react'
import type { ViewProps } from '../App'
import { NeuralGraph } from '../components/NeuralGraph'
import { Badge, Button, Empty, ErrorBox, LiveTag, Meter, Panel, Stat } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { useEvents, useEventTrigger } from '../lib/events'
import { ago, compact, num, pct, price, strategyLabel, time, tone } from '../lib/format'
import type { AgentInfo, Experiment, GraphData, GraphNode, Job, Market } from '../lib/types'

export function CommandView({ go, overview: o, reloadOverview }: ViewProps) {
  const graph = useApi<GraphData>('/graph?max_experiments=1200')
  const markets = useApi<Market[]>('/markets', { poll: 60000 })
  const agents = useApi<AgentInfo[]>('/agents', { poll: 8000 })
  const jobs = useApi<Job[]>('/jobs?limit=8', { poll: 5000 })
  const reports = useApi<{ id: number; report: any }[]>('/research/reports?limit=1')
  const risk = useApi<any>('/risk/status', { poll: 20000 })
  const [sel, setSel] = useState<GraphNode | null>(null)

  useEventTrigger((e) => e.category === 'job' && /Completed|failed|cancelled/.test(e.message), () => {
    graph.reload(); reports.reload(); markets.reload(); agents.reload()
  }, 1000)
  useEventTrigger((e) => e.category === 'agent' || e.category === 'job', () => { agents.reload(); jobs.reload() }, 400)

  const cycle = useAction(async () => {
    await api.post('/jobs/research-cycle', { max_hypotheses: 8 })
    jobs.reload(); reloadOverview()
  })
  const c = o?.counts
  const activeJob = jobs.data?.find((j) => j.status === 'running' || j.status === 'queued')

  return (
    <div className="grid grid-cols-12 gap-3">
      {/* KPI strip */}
      <div className="panel col-span-12 grid grid-cols-2 gap-4 px-4 py-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Market bars" value={compact(c?.bars)} sub={`${c?.datasets ?? '—'} dataset versions`} />
        <Stat label="Hypotheses tested" value={c?.experiments ?? '—'} sub={<span><span className="text-up">{c?.accepted ?? 0} accepted</span> · {(c?.experiments ?? 0) - (c?.accepted ?? 0)} rejected</span>} />
        <Stat label="Agent executions" value={compact(c?.agent_runs)} sub={`${c?.reports ?? 0} research reports`} />
        <Stat label="Paper equity" value={o ? `$${compact(o.paper.equity)}` : '—'} valueClass={tone(o?.paper.total_return)} sub={o ? `${pct(o.paper.total_return)} · ${o.paper.state}` : ''} />
        <Stat label="Deployed (paper)" value={c?.deployed ?? '—'} sub={`${c?.risk_rejections ?? 0} orders blocked by risk`} />
        <Stat label="Active jobs" value={c?.jobs_active ?? '—'} sub={activeJob ? `#${activeJob.id} ${activeJob.message ?? activeJob.type}` : 'queue idle'} />
      </div>

      {/* left column */}
      <div className="col-span-12 flex flex-col gap-3 lg:col-span-3">
        <Panel title="Market tape" kicker="LIVE" tag={<LiveTag what="REAL DATA" />} right={<Button small tone="ghost" onClick={() => go('markets')}>open →</Button>}>
          <div className="flex flex-col divide-y divide-ink-700">
            {markets.data?.map((m) => (
              <div key={m.symbol} className="flex items-center justify-between py-1.5">
                <div className="min-w-0">
                  <div className="font-mono text-[12px] text-white">{m.symbol}</div>
                  <div className="truncate font-mono text-[9.5px] text-ink-300">{m.provider} · {m.last_ts} {m.is_stale && <span className="text-am">STALE</span>}</div>
                </div>
                <div className="text-right">
                  <div className="num text-[12.5px] text-white">{price(m.last_close, m.price_decimals)}</div>
                  <div className={`num text-[10.5px] ${tone(m.change_1d)}`}>{pct(m.change_1d)}</div>
                </div>
              </div>
            )) ?? <Empty>loading…</Empty>}
          </div>
        </Panel>
        <Panel title="Research agents" right={<Button small tone="ghost" onClick={() => go('research')}>lab →</Button>} className="flex-1">
          <div className="flex flex-col gap-1.5">
            {agents.data?.map((a) => (
              <div key={a.name} className="flex items-center gap-2" title={a.role}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.status === 'running' ? 'pulse-dot bg-cy' : a.last_run?.status === 'error' ? 'bg-dn' : 'bg-ink-400'}`} />
                <span className="flex-1 truncate text-[12px] text-ink-100">{a.title.replace(' Agent', '')}</span>
                <span className="font-mono text-[10px] text-ink-300">{a.runs} runs</span>
                <span className={`w-14 text-right font-mono text-[10px] ${a.status === 'running' ? 'text-cy' : 'text-ink-300'}`}>{a.status === 'running' ? 'RUNNING' : ago(a.last_run?.finished_at)}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* centre: computation graph */}
      <Panel className="col-span-12 lg:col-span-6" kicker="CORE" title="Computation graph"
        tag={<Badge tone="cy" title={graph.data?.provenance}>TOPOLOGY = DATABASE · PULSES = LIVE EVENTS</Badge>}
        right={<span className="font-mono text-[10px] text-ink-300">{graph.data ? `${graph.data.nodes.length} nodes · ${graph.data.edges.length} edges` : ''}</span>}
        bodyClass="p-0">
        <div className="grid-bg relative">
          {graph.error ? <ErrorBox error={graph.error} /> : <NeuralGraph data={graph.data} onSelect={setSel} selected={sel?.id ?? null} height={540} />}
          <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9.5px] text-ink-300">
            {[['#22d3ee', 'agent'], ['#3b82f6', 'dataset'], ['#a78bfa', 'strategy family'], ['#5f7491', 'feature'], ['#34d399', 'accepted exp.'], ['#f87171', 'rejected exp. / risk'], ['#f5a524', 'paper / deployed']].map(([c, l]) => (
              <span key={l} className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />{l}</span>
            ))}
          </div>
          {sel && <Inspector node={sel} onClose={() => setSel(null)} go={go} />}
        </div>
      </Panel>

      {/* right column */}
      <div className="col-span-12 flex flex-col gap-3 lg:col-span-3">
        <Panel title="Orchestration" right={o?.autonomy.config.enabled ? <Badge tone="cy" dot>autonomous</Badge> : <Badge>manual</Badge>}>
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 font-mono text-[10.5px] text-ink-200">
              <span>cycles today</span><span className="text-right text-white">{o?.autonomy.cycles_today ?? '—'}/{o?.autonomy.config.max_cycles_per_day ?? '—'}</span>
              <span>next cycle</span><span className="text-right text-white">{o?.autonomy.config.enabled ? `${Math.round((o.autonomy.research_cycle.next_in_s ?? 0) / 60)}m` : 'off'}</span>
              <span>LLM narration</span><span className="text-right text-white">{o?.llm.enabled ? o.llm.model : 'off (deterministic)'}</span>
            </div>
            <Button tone="primary" onClick={() => cycle.run()} disabled={cycle.pending || !!jobs.data?.some((j) => j.type === 'research_cycle' && ['queued', 'running'].includes(j.status))}>▶ Run research cycle</Button>
            <ErrorBox error={cycle.error} />
            <div className="space-y-1.5 pt-1">
              {jobs.data?.slice(0, 5).map((j) => (
                <div key={j.id}>
                  <div className="flex justify-between font-mono text-[10px]">
                    <span className="text-ink-100">#{j.id} {j.type.replace('_', ' ')}</span>
                    <span className={j.status === 'completed' ? 'text-up' : j.status === 'failed' ? 'text-dn' : j.status === 'running' ? 'text-cy' : 'text-ink-300'}>{j.status}</span>
                  </div>
                  {j.status === 'running' && <><Meter value={j.progress} limit={1.25} /><div className="truncate font-mono text-[9.5px] text-ink-300">{j.message}</div></>}
                </div>
              ))}
            </div>
          </div>
        </Panel>
        <EventStream />
      </div>

      {/* bottom row */}
      <Panel className="col-span-12 xl:col-span-7" title="Latest research report" tag={reports.data?.[0] && <Badge tone="vi">cycle {reports.data[0].report?.cycle_id}</Badge>}
        right={<Button small tone="ghost" onClick={() => go('experiments')}>registry →</Button>}>
        {!reports.data?.length ? <Empty>No research cycle has completed yet. Run one to populate this panel.</Empty> : <ReportSummary r={reports.data[0].report} />}
      </Panel>
      <Panel className="col-span-12 xl:col-span-5" title="Risk posture" tag={<Badge tone="am">PAPER PORTFOLIO</Badge>} right={<Button small tone="ghost" onClick={() => go('risk')}>centre →</Button>}>
        {risk.data ? (
          <div className="grid grid-cols-2 gap-x-5 gap-y-3">
            {Object.entries(risk.data.gauges as Record<string, { value: number; limit: number }>).map(([k, g]) => (
              <div key={k}>
                <div className="flex justify-between"><span className="label">{k.replace('_', ' ')}</span><span className="num text-[11px] text-white">{pct(g.value, 1, false)} <span className="text-ink-300">/ {pct(g.limit, 0, false)}</span></span></div>
                <div className="mt-1"><Meter value={g.value} limit={g.limit} /></div>
              </div>
            ))}
            <div className="col-span-2 flex flex-wrap gap-1.5 pt-1">
              {risk.data.instruments.map((i: any) => (
                <Badge key={i.symbol} tone={i.stale ? 'am' : i.vol_percentile > 0.9 ? 'dn' : 'mute'} title={`vol percentile ${num(i.vol_percentile)}, stale ${num(i.stale_days, 1)}d`}>
                  {i.symbol} vol p{i.vol_percentile === null ? '—' : Math.round(i.vol_percentile * 100)}
                </Badge>
              ))}
            </div>
          </div>
        ) : <Empty>loading…</Empty>}
      </Panel>
    </div>
  )
}

function ReportSummary({ r }: { r: any }) {
  const reasons = Object.entries(r.rejection_reasons ?? {}) as [string, number][]
  const maxR = Math.max(1, ...reasons.map(([, v]) => v))
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_220px]">
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-ink-200">
          <span>{r.hypotheses} hypotheses</span><span>{r.evaluated} evaluated</span>
          <span className="text-up">{r.accepted} accepted</span><span>{r.duration_s}s</span><span>code {r.code_version}</span>
        </div>
        <div className="scroll-thin max-h-[220px] overflow-auto">
          <table className="data">
            <thead><tr><th>#</th><th>strategy</th><th>symbol</th><th>verdict</th><th>OOS sharpe</th><th>OOS return</th><th>DSR</th><th>trials</th></tr></thead>
            <tbody>
              {r.leaderboard?.map((x: any) => (
                <tr key={x.experiment_id}>
                  <td className="text-ink-300">{x.experiment_id}</td>
                  <td>{strategyLabel(x.strategy)}</td>
                  <td>{x.symbol}</td>
                  <td><Badge tone={x.verdict === 'accepted' ? 'up' : 'dn'}>{x.verdict}</Badge></td>
                  <td className={tone(x.test_sharpe)}>{num(x.test_sharpe)}</td>
                  <td className={tone(x.test_return)}>{pct(x.test_return)}</td>
                  <td>{num(x.dsr)}</td>
                  <td className="text-ink-300">{x.n_trials}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.narration && <p className="mt-2 border-l-2 border-vi/50 pl-2 text-[12px] text-ink-100"><Badge tone="vi">LLM narration</Badge> {r.narration.text}</p>}
        <p className="mt-2 text-[10.5px] text-ink-300">{r.disclaimer}</p>
      </div>
      <div>
        <div className="label mb-2">Why hypotheses were rejected</div>
        {reasons.length ? reasons.map(([k, v]) => (
          <div key={k} className="mb-1.5">
            <div className="flex justify-between font-mono text-[10.5px]"><span className="text-ink-200">{k.replace(/_/g, ' ')}</span><span className="text-white">{v}</span></div>
            <div className="mt-0.5 h-1 rounded-full bg-ink-700"><div className="h-1 rounded-full bg-dn/70" style={{ width: `${(v / maxR) * 100}%` }} /></div>
          </div>
        )) : <div className="text-[11px] text-ink-300">none</div>}
      </div>
    </div>
  )
}

function EventStream() {
  const { events } = useEvents()
  const color = (c: string, l: string) => l === 'error' ? 'text-dn' : l === 'warn' ? 'text-am' : ({ agent: 'text-cy', research: 'text-vi', paper: 'text-am', risk: 'text-dn', data: 'text-bl', job: 'text-ink-200' } as Record<string, string>)[c] ?? 'text-ink-200'
  return (
    <Panel title="Event stream" tag={<LiveTag what="WEBSOCKET" />} className="min-h-[300px] flex-1" bodyClass="p-0">
      <div className="scroll-thin h-[330px] overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-[1.55]">
        {events.slice(0, 120).map((e, i) => (
          <div key={e.id ?? `${e.ts}-${i}`} className="flex gap-2">
            <span className="shrink-0 text-ink-400">{time(e.ts)}</span>
            <span className={`w-14 shrink-0 uppercase ${color(e.category, e.level)}`}>{e.category}</span>
            <span className="min-w-0 break-words text-ink-100">{e.message}</span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function Inspector({ node, onClose, go }: { node: GraphNode; onClose: () => void; go: (v: any) => void }) {
  const expId = node.kind === 'experiment' ? node.id.split(':')[1] : null
  const exp = useApi<Experiment>(expId ? `/experiments/${expId}` : null, { deps: [expId] })
  const e = exp.data
  return (
    <div className="absolute top-3 right-3 z-20 w-[min(300px,calc(100%-24px))] rounded border border-ink-500 bg-ink-900/95 p-3 shadow-2xl backdrop-blur fade-in">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="label">{node.kind.replace('_', ' ')} · inspector</div>
          <div className="mt-0.5 text-[13px] font-semibold text-white">{node.label}</div>
        </div>
        <button onClick={onClose} className="font-mono text-ink-300 hover:text-white">✕</button>
      </div>
      <div className="mt-2 space-y-0.5 font-mono text-[10.5px]">
        {Object.entries(node).filter(([k]) => !['id', 'label', 'kind', 'x', 'y', 'r', 'color', 'deg'].includes(k)).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2"><span className="text-ink-300">{k}</span><span className="truncate text-white">{typeof v === 'number' ? num(v, 3) : String(v)}</span></div>
        ))}
      </div>
      {e && (
        <div className="mt-2 space-y-1 border-t border-ink-600 pt-2 text-[11px]">
          <div className="text-ink-200">{e.hypothesis?.rationale ?? 'Manual backtest'}</div>
          <div className="grid grid-cols-3 gap-2 pt-1">
            <Stat label="OOS sharpe" value={num(e.metrics?.test?.sharpe)} />
            <Stat label="OOS ret" value={pct(e.metrics?.test?.total_return, 1)} />
            <Stat label="DSR" value={num(e.metrics?.dsr_test)} />
          </div>
          {e.reasons?.slice(0, 3).map((r) => <div key={r} className="text-[10.5px] text-dn">✕ {r}</div>)}
          <Button small onClick={() => go('experiments')}>open in registry</Button>
        </div>
      )}
    </div>
  )
}
