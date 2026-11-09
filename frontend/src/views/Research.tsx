import { useState } from 'react'
import type { ViewProps } from '../App'
import { Badge, Button, Empty, ErrorBox, Field, Meter, Panel, Stat } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { ago, duration, num, pct, strategyLabel, tone } from '../lib/format'
import type { AgentInfo, AutonomyStatus, Job } from '../lib/types'

const PIPELINE = ['market', 'discovery', 'backtester', 'risk_analyst', 'critic', 'portfolio']

export function ResearchView({ reloadOverview }: ViewProps) {
  const agents = useApi<AgentInfo[]>('/agents', { poll: 6000 })
  const auto = useApi<AutonomyStatus>('/autonomy', { poll: 15000 })
  const jobs = useApi<Job[]>('/jobs?limit=20', { poll: 4000 })
  const reports = useApi<{ id: number; created_at: string; report: any }[]>('/research/reports?limit=10')
  const queue = useApi<any[]>('/research/queue')
  const [agentSel, setAgentSel] = useState<string>('critic')
  const runs = useApi<any[]>(`/agents/${agentSel}/runs?limit=25`, { deps: [agentSel] })
  const [n, setN] = useState(8)
  useEventTrigger((e) => e.category === 'agent' || e.category === 'job', () => { agents.reload(); jobs.reload(); runs.reload() }, 500)
  useEventTrigger((e) => e.category === 'job' && /Completed/.test(e.message), () => { reports.reload(); queue.reload() }, 800)

  const cycle = useAction(async () => { await api.post('/jobs/research-cycle', { max_hypotheses: n }); jobs.reload(); reloadOverview() })
  const cancel = useAction(async (id: number) => { await api.post(`/jobs/${id}/cancel`); jobs.reload() })
  const setAuto = useAction(async (patch: Record<string, unknown>) => { auto.setData(await api.put<AutonomyStatus>('/autonomy', patch)); reloadOverview() })
  const running = jobs.data?.find((j) => j.type === 'research_cycle' && ['queued', 'running'].includes(j.status))
  const byName = Object.fromEntries((agents.data ?? []).map((a) => [a.name, a]))
  const cfg = auto.data?.config

  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12" kicker="PIPELINE" title="Autonomous research loop"
        tag={<Badge tone="cy">deterministic agents · no LLM required</Badge>}
        right={running ? <Button small tone="danger" onClick={() => cancel.run(running.id)}>cancel job #{running.id}</Button> : null}>
        <div className="flex flex-wrap items-stretch gap-2">
          <PipeNode a={byName.orchestrator} first />
          {PIPELINE.map((k) => <PipeNode key={k} a={byName[k]} />)}
        </div>
        {running && (
          <div className="mt-3">
            <div className="flex justify-between font-mono text-[10.5px]"><span className="text-cy">job #{running.id} · {running.message}</span><span className="text-white">{pct(running.progress, 0, false)}</span></div>
            <div className="mt-1"><Meter value={running.progress} limit={1.25} /></div>
          </div>
        )}
        <p className="mt-3 text-[11px] text-ink-300">
          Cycle: collect &amp; validate data → detect dataset updates → re-validate deployed strategies → generate hypotheses → event-driven backtests
          (train/validation/test + walk-forward) → risk analysis → critic with cumulative multiple-testing correction (deflated Sharpe) →
          compare survivors → portfolio proposal → persist → report → queue follow-ups.
        </p>
      </Panel>

      <Panel className="col-span-12 lg:col-span-4" title="Controls & schedule">
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <Field label="Hypotheses"><input type="number" min={1} max={40} value={n} onChange={(e) => setN(Number(e.target.value))} className="w-20" /></Field>
            <Button tone="primary" onClick={() => cycle.run()} disabled={cycle.pending || !!running}>▶ Run cycle now</Button>
          </div>
          <ErrorBox error={cycle.error || setAuto.error || cancel.error} />
          {cfg && (
            <div className="space-y-2 rounded border border-ink-600 bg-ink-850 p-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-white">Autonomous schedule</span>
                <Button small tone={cfg.enabled ? 'danger' : 'primary'} onClick={() => setAuto.run({ enabled: !cfg.enabled })}>{cfg.enabled ? 'disable' : 'enable'}</Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Research every (min)"><input type="number" min={5} defaultValue={cfg.research_interval_minutes} onBlur={(e) => setAuto.run({ research_interval_minutes: Number(e.target.value) })} /></Field>
                <Field label="Data refresh (min)"><input type="number" min={5} defaultValue={cfg.data_refresh_minutes} onBlur={(e) => setAuto.run({ data_refresh_minutes: Number(e.target.value) })} /></Field>
                <Field label="Max hypotheses/cycle"><input type="number" min={1} max={100} defaultValue={cfg.max_hypotheses_per_cycle} onBlur={(e) => setAuto.run({ max_hypotheses_per_cycle: Number(e.target.value) })} /></Field>
                <Field label="Max cycles/day"><input type="number" min={1} max={288} defaultValue={cfg.max_cycles_per_day} onBlur={(e) => setAuto.run({ max_cycles_per_day: Number(e.target.value) })} /></Field>
              </div>
              <label className="flex items-center gap-2 text-[11.5px] text-ink-100">
                <input type="checkbox" checked={cfg.auto_deploy_paper} onChange={(e) => setAuto.run({ auto_deploy_paper: e.target.checked })} />
                Auto-promote critic-approved strategies to the <b className="text-am">paper</b> portfolio
              </label>
              <div className="grid grid-cols-2 gap-1 font-mono text-[10.5px] text-ink-300">
                <span>cycles today</span><span className="text-right text-white">{auto.data?.cycles_today}</span>
                <span>last cycle</span><span className="text-right text-white">{ago(auto.data?.research_cycle.last)}</span>
                <span>next cycle in</span><span className="text-right text-white">{cfg.enabled ? duration(auto.data?.research_cycle.next_in_s) : '—'}</span>
                <span>last data refresh</span><span className="text-right text-white">{ago(auto.data?.data_refresh.last)}</span>
              </div>
              <p className="text-[10.5px] text-am">{auto.data?.note}</p>
            </div>
          )}
          <div>
            <div className="label mb-1">Experiment queue ({queue.data?.length ?? 0})</div>
            <div className="scroll-thin max-h-[160px] space-y-1 overflow-auto">
              {queue.data?.length ? queue.data.map((q, i) => (
                <div key={i} className="rounded border border-ink-700 px-2 py-1 text-[10.5px]" title={q.rationale}>
                  <span className="font-mono text-white">{strategyLabel(q.strategy)}</span> <span className="text-ink-300">{q.symbol}</span>
                  <div className="truncate text-ink-300">{q.rationale}</div>
                </div>
              )) : <div className="text-[11px] text-ink-300">empty — follow-ups are queued for near-miss and accepted candidates</div>}
            </div>
          </div>
        </div>
      </Panel>

      <Panel className="col-span-12 lg:col-span-8" title="Agent execution history"
        right={<select value={agentSel} onChange={(e) => setAgentSel(e.target.value)}>{agents.data?.map((a) => <option key={a.name} value={a.name}>{a.title}</option>)}</select>}>
        {byName[agentSel] && (
          <div className="mb-3 grid gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <p className="text-[12px] text-ink-100">{byName[agentSel].role}</p>
              <div className="mt-1 flex flex-wrap gap-1">{byName[agentSel].tools.map((t) => <Badge key={t}>{t}</Badge>)}</div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Stat label="runs" value={byName[agentSel].runs} />
              <Stat label="errors" value={byName[agentSel].errors} valueClass={byName[agentSel].errors ? 'text-dn' : ''} />
              <Stat label="avg" value={`${num(byName[agentSel].avg_ms, 0)}ms`} />
            </div>
          </div>
        )}
        <div className="scroll-thin max-h-[360px] overflow-auto">
          <table className="data">
            <thead><tr><th>run</th><th>job</th><th>started</th><th>status</th><th>ms</th><th>outputs / error</th></tr></thead>
            <tbody>
              {runs.data?.map((r) => (
                <tr key={r.id}>
                  <td className="text-ink-300">{r.id}</td><td className="text-ink-300">{r.job_id ?? '—'}</td><td>{ago(r.started_at)}</td>
                  <td className={r.status === 'ok' ? 'text-up' : r.status === 'error' ? 'text-dn' : 'text-cy'}>{r.status}</td>
                  <td>{num(r.duration_ms, 0)}</td>
                  <td className="max-w-[520px] truncate whitespace-nowrap text-ink-200" title={JSON.stringify(r.outputs ?? r.error)}>{r.error ?? JSON.stringify(r.outputs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!runs.data?.length && <Empty>No runs yet.</Empty>}
        </div>
      </Panel>

      <Panel className="col-span-12" title="Research reports" bodyClass="p-0">
        {reports.data?.length ? (
          <div className="divide-y divide-ink-700">
            {reports.data.map(({ id, report: r }) => (
              <details key={id} className="group px-3 py-2">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-mono text-[11px] text-cy">cycle {r.cycle_id}</span>
                  <span className="text-[12px] text-white">{r.accepted}/{r.evaluated} hypotheses survived</span>
                  <span className="font-mono text-[10.5px] text-ink-300">{r.duration_s}s · {r.started} · {ago(reports.data!.find((x) => x.id === id)?.created_at)}</span>
                  {r.promoted?.length > 0 && <Badge tone="am">{r.promoted.length} promoted to paper</Badge>}
                  <span className="ml-auto font-mono text-[10px] text-ink-300 group-open:hidden">expand ▾</span>
                </summary>
                <div className="mt-2 grid gap-3 lg:grid-cols-2">
                  <div>
                    <div className="label mb-1">decision log</div>
                    <ol className="space-y-0.5 font-mono text-[10.5px] text-ink-100">{r.decisions.map((d: string, i: number) => <li key={i}><span className="text-ink-400">{String(i + 1).padStart(2, '0')}</span> {d}</li>)}</ol>
                  </div>
                  <div>
                    <div className="label mb-1">leaderboard</div>
                    <table className="data"><thead><tr><th>#</th><th>strategy</th><th>symbol</th><th>verdict</th><th>OOS SR</th><th>OOS ret</th></tr></thead>
                      <tbody>{r.leaderboard.map((x: any) => (
                        <tr key={x.experiment_id}><td>{x.experiment_id}</td><td>{strategyLabel(x.strategy)}</td><td>{x.symbol}</td>
                          <td className={x.verdict === 'accepted' ? 'text-up' : 'text-dn'}>{x.verdict}</td><td className={tone(x.test_sharpe)}>{num(x.test_sharpe)}</td><td className={tone(x.test_return)}>{pct(x.test_return)}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
                <p className="mt-2 text-[10.5px] text-ink-300">{r.disclaimer}</p>
              </details>
            ))}
          </div>
        ) : <Empty>No reports yet.</Empty>}
      </Panel>
    </div>
  )
}

function PipeNode({ a, first }: { a?: AgentInfo; first?: boolean }) {
  if (!a) return null
  const on = a.status === 'running'
  return (
    <div className="flex items-center gap-2">
      {!first && <span className="hidden text-ink-400 sm:inline">→</span>}
      <div className={`min-w-[132px] rounded border px-2.5 py-2 transition-colors ${on ? 'border-cy/70 bg-cy/[0.07]' : 'border-ink-600 bg-ink-850'}`} title={a.role}>
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${on ? 'pulse-dot bg-cy' : a.last_run?.status === 'error' ? 'bg-dn' : a.runs ? 'bg-up' : 'bg-ink-400'}`} />
          <span className="text-[11.5px] text-white">{a.title.replace(' Agent', '')}</span>
        </div>
        <div className="mt-0.5 font-mono text-[9.5px] text-ink-300">{on ? 'RUNNING' : `${a.runs} runs · ${ago(a.last_run?.finished_at)}`}</div>
      </div>
    </div>
  )
}
