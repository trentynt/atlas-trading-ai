import { useState } from 'react'
import type { ViewProps } from '../App'
import { Badge, Button, Disclosure, Drawer, EmptyState, ErrorBox, Loading, Meter, Notice, Panel, PageHeader, Spinner, StatusDot } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { AGENT_PLAIN, CHECK_PLAIN, DISPOSITION, dispositionOf, strategyName } from '../lib/explain'
import { ago, duration, num, pct, tone } from '../lib/format'
import { useToast } from '../lib/toast'
import type { AgentInfo, Job } from '../lib/types'
import { AutonomyPanel, CycleHistoryPanel } from '../components/Autonomy'

const PIPELINE: [string, string][] = [['market', 'Read markets'], ['discovery', 'Propose ideas'], ['backtester', 'Test'], ['risk_analyst', 'Stress-test'], ['critic', 'Review'], ['portfolio', 'Allocate']]

export function ResearchView({ go, reloadOverview }: ViewProps) {
  const agents = useApi<AgentInfo[]>('/agents', { poll: 6000 })
  const jobs = useApi<Job[]>('/jobs?limit=20', { poll: 4000 })
  const reports = useApi<{ id: number; created_at: string; report: any }[]>('/research/reports?limit=10')
  const queue = useApi<any[]>('/research/queue')
  const [agentSel, setAgentSel] = useState<string | null>(null)
  const runs = useApi<any[]>(agentSel ? `/agents/${agentSel}/runs?limit=40` : null, { deps: [agentSel] })
  const [n, setN] = useState(8)
  const toast = useToast()
  useEventTrigger((e) => e.category === 'agent' || e.category === 'job', () => { agents.reload(); jobs.reload(); if (agentSel) runs.reload() }, 500)
  useEventTrigger((e) => e.category === 'job' && /Completed/.test(e.message), () => { reports.reload(); queue.reload() }, 800)

  const cycle = useAction(async () => {
    const r = await api.post<{ job_id: number }>('/jobs/research-cycle', { max_hypotheses: n })
    toast({ tone: 'info', title: 'Research cycle started', body: `Testing up to ${n} new ideas (job #${r.job_id}).` })
    jobs.reload(); reloadOverview()
  })
  const cancel = useAction(async (id: number) => { await api.post(`/jobs/${id}/cancel`); toast({ tone: 'warning', title: 'Cancelling research cycle' }); jobs.reload() })
  const running = jobs.data?.find((j) => j.type === 'research_cycle' && ['queued', 'running'].includes(j.status))
  const byName = Object.fromEntries((agents.data ?? []).map((a) => [a.name, a]))
  const latest = reports.data?.[0]?.report
  const sel = agentSel ? byName[agentSel] : null

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Research" title="Your research team"
        subtitle="Seven specialised agents propose trading ideas, test them on later data not used to design them, and reject anything that could be luck. They are deterministic programs — no AI model makes trading decisions."
        actions={running ? (
          <Button tone="danger" onClick={() => cancel.run(running.id)} disabled={cancel.pending}>Stop this cycle</Button>
        ) : (
          <>
            <label className="flex items-center gap-2 text-[13px] text-ink-300">Ideas to test
              <select value={n} onChange={(e) => setN(+e.target.value)} className="!py-1.5">{[4, 8, 12, 20].map((x) => <option key={x}>{x}</option>)}</select>
            </label>
            <Button tone="primary" onClick={() => cycle.run()} disabled={cycle.pending}>Run research cycle</Button>
          </>
        )} />
      <ErrorBox error={cycle.error || cancel.error} />

      <Panel title="The research cycle" tag={running ? <Badge tone="cy" dot>Running</Badge> : undefined}
        subtitle={running ? (running.message ?? 'Starting…') : 'Six steps, coordinated by the Orchestrator. Results are saved and can be reproduced exactly. Select a step to see its history.'}>
        {running && <div className="mb-4"><div className="mb-1.5 flex justify-between text-[12.5px]"><span className="text-ink-300">Progress</span><span className="num text-white">{pct(running.progress, 0, false)}</span></div><Meter value={running.progress} limit={1.25} /></div>}
        {!agents.data ? <Loading rows={6} /> : (
          <ol className="divide-y divide-white/[0.05]">
            {PIPELINE.map(([k, label], i) => {
              const a = byName[k]
              if (!a) return null
              const on = a.status === 'running'
              const err = a.last_run?.status === 'error'
              return (
                <li key={k}>
                  <button onClick={() => setAgentSel(k)} className={`grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-4 rounded-[10px] px-2 py-3 text-left transition-colors md:grid-cols-[24px_220px_minmax(0,1fr)_auto] ${on ? 'bg-cy/[0.06]' : 'hover:bg-white/[0.03]'}`}>
                    <span className={`num text-[13px] ${on ? 'text-cy' : 'text-ink-400'}`}>{i + 1}</span>
                    <span className="min-w-0"><span className="block text-[14px] font-medium text-white">{label}</span><span className="block text-[12.5px] text-ink-300">{a.title.replace(' Agent', '')}</span></span>
                    <span className="hidden min-w-0 text-[13px] leading-snug text-ink-300 md:block">{AGENT_PLAIN[k]?.role ?? a.role}</span>
                    <span className="flex items-center gap-2 text-[12.5px] whitespace-nowrap text-ink-300">
                      {on ? <><Spinner size={13} /><span className="text-cy">{AGENT_PLAIN[k]?.verb}</span></> : err ? <><StatusDot tone="dn" />Last run failed</> : a.runs ? `${a.runs} run${a.runs === 1 ? '' : 's'} · ${ago(a.last_run?.finished_at)}` : 'Not yet run'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
        {byName.orchestrator && <button onClick={() => setAgentSel('orchestrator')} className="mt-3 px-2 text-[12.5px] text-cy hover:underline">Orchestrator history · {byName.orchestrator.runs} runs</button>}
      </Panel>

      <div className="grid grid-cols-12 gap-5">
        {/* latest cycle */}
        <Panel className="col-span-12 xl:col-span-7" title="What the latest cycle found" right={latest && <Badge>Cycle {latest.cycle_id} · {ago(reports.data![0].created_at)}</Badge>}>
          {!reports.data ? <Loading rows={4} /> : !latest ? (
            <EmptyState title="No research yet" action={<Button tone="primary" small onClick={() => cycle.run()}>Run the first cycle</Button>}>Each cycle proposes ideas, tests them and explains every decision here.</EmptyState>
          ) : (
            <div className="space-y-5">
              <p className="text-[15px] leading-relaxed text-ink-100">
                Tested <b className="text-white">{latest.evaluated}</b> idea{latest.evaluated === 1 ? '' : 's'} in {duration(latest.duration_s)}.{' '}
                {latest.accepted ? <><b className="text-up">{latest.accepted} survived</b> current validation{latest.promoted?.length ? ' and moved to paper trading' : ''}.</> : <>None survived — <b className="text-white">which is the expected outcome most of the time.</b></>}{latest.dispositions?.requires_confirmation ? ` ${latest.dispositions.requires_confirmation} passed every research test and now await${latest.dispositions.requires_confirmation === 1 ? 's' : ''} confirmation on new data.` : ''}
                {latest.dataset_changes?.length ? ` New market data arrived for ${latest.dataset_changes.join(', ')}.` : ''}
              </p>
              <div>
                <div className="mb-2 text-[13px] font-medium text-ink-200">Why ideas were rejected</div>
                <div className="space-y-2.5">
                  {Object.entries(latest.rejection_reasons ?? {}).slice(0, 6).map(([k, v]) => (
                    <div key={k}>
                      <div className="flex justify-between text-[13px]"><span className="text-ink-100">{CHECK_PLAIN[k]?.short ?? k}</span><span className="num text-ink-300">{v as number} of {latest.evaluated}</span></div>
                      <div className="mt-1 h-[6px] rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-dn/70 transition-[width] duration-700" style={{ width: `${((v as number) / Math.max(1, latest.evaluated)) * 100}%` }} /></div>
                    </div>
                  ))}
                  {!Object.keys(latest.rejection_reasons ?? {}).length && <div className="text-[13px] text-ink-300">No rejections in this cycle.</div>}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[13px] font-medium text-ink-200">Top ideas</div>
                <ul className="divide-y divide-white/[0.05]">
                  {latest.leaderboard.slice(0, 5).map((x: any) => (
                    <li key={x.experiment_id}>
                      <button onClick={() => go('experiments', { id: x.experiment_id })} className="flex w-full items-center gap-3 py-2.5 text-left hover:opacity-90">
                        <StatusDot tone={DISPOSITION[dispositionOf(x) ?? 'rejected'].tone} />
                        <span className="flex-1 truncate text-[13.5px] text-white">{strategyName(x.strategy)} <span className="text-ink-300">on</span> {x.symbol}</span>
                        <span className={`num text-[13px] ${tone(x.test_return)}`}>{pct(x.test_return, 1)}</span>
                        <span className="w-[150px] text-right text-[12px] text-ink-300">{DISPOSITION[dispositionOf(x) ?? 'rejected'].short}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              {latest.narration && <Notice tone="vi" title="Narrated summary (AI-written from the numbers above)">{latest.narration.text}</Notice>}
              <Disclosure title="Decision log" meta={`${latest.decisions.length} entries`}>
                <ol className="space-y-1 text-[13px] text-ink-200">{latest.decisions.map((d: string, i: number) => <li key={i} className="flex gap-3"><span className="num w-5 shrink-0 text-ink-400">{i + 1}</span><span>{d}</span></li>)}</ol>
              </Disclosure>
              <p className="text-[12px] text-ink-400">{latest.disclaimer}</p>
            </div>
          )}
        </Panel>

        {/* schedule + queue */}
        <div className="col-span-12 flex flex-col gap-5 xl:col-span-5">
          <AutonomyPanel onChanged={() => { reloadOverview(); jobs.reload() }} />
          <Panel title="What happens next" subtitle="Follow-up experiments your team has queued.">
            {!queue.data ? <Loading /> : queue.data.length === 0 ? <EmptyState title="Nothing queued">Follow-ups are added for near-misses. Each follow-up is a new trial and is counted.</EmptyState> : (
              <ul className="space-y-2">
                {queue.data.slice(0, 6).map((q, i) => (
                  <li key={i} className="rounded-[12px] bg-white/[0.025] px-3.5 py-2.5 ring-1 ring-inset ring-white/[0.05]">
                    <div className="text-[13.5px] font-medium text-white">{strategyName(q.strategy)} <span className="font-normal text-ink-300">on</span> {q.symbol}</div>
                    <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-ink-300">{'Try nearby settings of an idea that almost passed. Counted as a new trial.'}</div>
                  </li>
                ))}
                {queue.data.length > 6 && <li className="text-[12.5px] text-ink-300">+{queue.data.length - 6} more</li>}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <CycleHistoryPanel go={go} />

      <Drawer open={!!sel} onClose={() => setAgentSel(null)} width={640} title={sel ? <span><span className="block text-[12.5px] font-medium text-cy">Research agent</span>{sel.title}</span> : ''}>
        {sel && (
          <div className="space-y-5">
            <p className="text-[14px] leading-relaxed text-ink-200">{AGENT_PLAIN[sel.name]?.role ?? sel.role}</p>
            <div className="grid grid-cols-3 gap-4">
              <div><div className="label">Runs</div><div className="num text-[22px] text-white">{sel.runs}</div></div>
              <div><div className="label">Errors</div><div className={`num text-[22px] ${sel.errors ? 'text-dn' : 'text-white'}`}>{sel.errors}</div></div>
              <div><div className="label">Typical run</div><div className="num text-[22px] text-white">{num(sel.avg_ms, 0)} ms</div></div>
            </div>
            <div><div className="label mb-1.5">Tools it uses</div><div className="flex flex-wrap gap-1.5">{sel.tools.map((t) => <Badge key={t}>{t}</Badge>)}</div></div>
            <div>
              <div className="label mb-1.5">Execution history</div>
              {!runs.data ? <Loading /> : runs.data.length === 0 ? <div className="text-[13px] text-ink-300">No runs yet.</div> : (
                <ul className="space-y-1.5">
                  {runs.data.map((r) => (
                    <li key={r.id}>
                      <details className="group rounded-[12px] bg-white/[0.025] ring-1 ring-inset ring-white/[0.05]">
                        <summary className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-[13px]">
                          <StatusDot tone={r.status === 'ok' ? 'up' : r.status === 'error' ? 'dn' : 'cy'} />
                          <span className="text-white">Run {r.id}</span>
                          <span className="text-ink-300">{ago(r.started_at)}{r.job_id ? ` · job ${r.job_id}` : ''}</span>
                          <span className="num ml-auto text-ink-300">{num(r.duration_ms, 0)} ms</span>
                        </summary>
                        <pre className="scroll-thin mx-3.5 mb-3 max-h-56 overflow-auto rounded-[10px] bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-200">{r.error ?? JSON.stringify(r.outputs, null, 2)}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
