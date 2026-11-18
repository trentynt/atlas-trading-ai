import { useEffect, useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { api, useAction, useApi } from '../lib/api'
import { DISPOSITION, JOB_STATUS, TRIGGER, dispositionOf, localTime, scheduleText, strategyName } from '../lib/explain'
import { ago, num } from '../lib/format'
import { useToast } from '../lib/toast'
import type { AutonomyStatus, AwayReport, CycleHistory } from '../lib/types'
import { Badge, Button, Disclosure, EmptyState, ErrorBox, Field, KeyValue, Loading, Meter, Notice, Panel, Segmented, StatusDot, Toggle } from './ui'

const STATE: Record<AutonomyStatus['state'], { label: string; tone: 'up' | 'am' | 'mute' }> = {
  on: { label: 'On', tone: 'up' }, paused: { label: 'Paused', tone: 'am' }, off: { label: 'Off', tone: 'mute' },
}

const hours = (s: number) => (s >= 3600 ? `${num(s / 3600, s >= 36000 ? 0 : 1)} h` : s >= 60 ? `${num(s / 60, 0)} min` : `${num(s, 1)} s`)

function zones(current: string) {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  return [...new Set([current, local, 'UTC', 'America/Toronto', 'America/Vancouver', 'America/New_York', 'Europe/London', 'Asia/Tokyo'])]
}

export function AutonomyPanel({ onChanged }: { onChanged?: () => void }) {
  const auto = useApi<AutonomyStatus>('/autonomy', { poll: 15000 })
  const toast = useToast()
  const act = useAction(async (action: 'enable' | 'disable' | 'pause' | 'resume' | 'run-now') => {
    const r = await api.post<AutonomyStatus & { job_id?: number }>(`/autonomy/${action}`)
    auto.setData(r)
    const msg: Record<string, string> = {
      enable: 'Autonomous research is on', disable: 'Autonomous research is off', pause: 'Paused. Scheduled runs are skipped until you resume.',
      resume: 'Resumed', 'run-now': `Research cycle queued (job #${r.job_id})`,
    }
    toast({ tone: action === 'disable' || action === 'pause' ? 'warning' : 'success', title: msg[action] })
    onChanged?.()
  })
  const save = useAction(async (patch: Record<string, unknown>) => {
    auto.setData(await api.put<AutonomyStatus>('/autonomy', patch))
    toast({ tone: 'success', title: 'Saved' })
    onChanged?.()
  })
  const st = auto.data
  const cfg = st?.config
  const caps = st?.caps ?? {}
  const opts = (xs: number[], cap?: number) => xs.filter((x) => cap === undefined || x <= cap)
  const tz = useMemo(() => zones(cfg?.timezone ?? 'UTC'), [cfg?.timezone])
  if (!st || !cfg) return <Panel title="Autonomous research">{auto.error ? <ErrorBox error={auto.error} onRetry={auto.reload} /> : <Loading rows={5} />}</Panel>
  const s = STATE[st.state]
  const cpuUsed = st.usage_month.cpu_s

  return (
    <Panel title="Autonomous research" tag={<Badge tone={s.tone} dot>{s.label}</Badge>}
      subtitle="Off until you turn it on. Your team then researches on the schedule below, inside the limits you set.">
      <ErrorBox error={act.error || save.error} />
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {st.state === 'off' && <Button tone="primary" onClick={() => act.run('enable')} disabled={act.pending}>Turn on</Button>}
          {st.state === 'on' && <Button onClick={() => act.run('pause')} disabled={act.pending}>Pause</Button>}
          {st.state === 'paused' && <Button tone="primary" onClick={() => act.run('resume')} disabled={act.pending}>Resume</Button>}
          <Button onClick={() => act.run('run-now')} disabled={act.pending || st.active.some((j) => j.type === 'research_cycle')}>Run now</Button>
          {st.state !== 'off' && <Button tone="ghost" onClick={() => act.run('disable')} disabled={act.pending}>Turn off</Button>}
        </div>

        <KeyValue rows={[
          ['Schedule', scheduleText(cfg)],
          ['Next run', st.state === 'on' && st.next_run_at ? localTime(st.next_run_at) : st.state === 'paused' ? 'Paused' : 'Not scheduled'],
          ['Last cycle', st.last_cycle ? `${ago(st.last_cycle.created_at)} · ${TRIGGER[st.last_cycle.trigger] ?? st.last_cycle.trigger} · ${JOB_STATUS[st.last_cycle.status]?.[0] ?? st.last_cycle.status}` : 'None yet'],
          ['Cycles today', `${st.cycles_today} of ${cfg.max_cycles_per_day}`],
        ]} />

        <div>
          <div className="mb-2 text-[13px] font-medium text-ink-200">When to run</div>
          <Segmented size="sm" value={cfg.schedule} onChange={(v) => save.run({ schedule: v })}
            options={[{ value: 'daily', label: 'Daily' }, { value: 'interval', label: 'Every few hours' }, { value: 'manual', label: 'Only when I start it' }]} />
          <div className="mt-3 grid grid-cols-2 gap-3">
            {cfg.schedule === 'daily' && <>
              <Field label="Time"><input type="time" defaultValue={cfg.daily_time} onBlur={(e) => e.target.value && e.target.value !== cfg.daily_time && save.run({ daily_time: e.target.value })} /></Field>
              <Field label="Time zone"><select value={cfg.timezone} onChange={(e) => save.run({ timezone: e.target.value })}>{tz.map((z) => <option key={z}>{z}</option>)}</select></Field>
            </>}
            {cfg.schedule === 'interval' && (
              <Field label="Every"><select value={cfg.interval_hours} onChange={(e) => save.run({ interval_hours: +e.target.value })}>{[1, 2, 4, 6, 8, 12, 24].map((x) => <option key={x} value={x}>{x} hour{x === 1 ? '' : 's'}</option>)}</select></Field>
            )}
          </div>
        </div>

        <div>
          <div className="mb-2 text-[13px] font-medium text-ink-200">Limits</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ideas per cycle"><select value={cfg.max_hypotheses_per_cycle} onChange={(e) => save.run({ max_hypotheses_per_cycle: +e.target.value })}>{opts([2, 4, 8, 12, 20, 40], caps.max_hypotheses_per_cycle).map((x) => <option key={x}>{x}</option>)}</select></Field>
            <Field label="Cycles per day"><select value={cfg.max_cycles_per_day} onChange={(e) => save.run({ max_cycles_per_day: +e.target.value })}>{opts([1, 2, 4, 8, 12, 24], caps.max_cycles_per_day).map((x) => <option key={x}>{x}</option>)}</select></Field>
            <Field label="Longest a cycle may run"><select value={cfg.max_job_runtime_s} onChange={(e) => save.run({ max_job_runtime_s: +e.target.value })}>{opts([300, 600, 900, 1800, 3600], caps.max_job_runtime_s).map((x) => <option key={x} value={x}>{x / 60} minutes</option>)}</select></Field>
            <Field label="Monthly compute budget"><select value={cfg.monthly_cpu_budget_s} onChange={(e) => save.run({ monthly_cpu_budget_s: +e.target.value })}>{opts([3600, 18000, 36000, 72000, 180000, 360000], caps.monthly_cpu_budget_s).map((x) => <option key={x} value={x}>{hours(x)} CPU</option>)}</select></Field>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex justify-between text-[13px]"><span className="text-ink-200">Compute used this month</span><span className="num text-white">{hours(cpuUsed)} of {hours(st.budget.cpu_s)}</span></div>
          <Meter value={cpuUsed} limit={st.budget.cpu_s} />
          <p className="mt-2 text-[12px] leading-snug text-ink-300">
            Measured CPU time of research jobs. {num(st.usage_month.data_requests, 0)} market-data requests{cfg.monthly_llm_token_budget ? `, ${num(st.usage_month.llm_tokens, 0)} narration tokens of ${num(cfg.monthly_llm_token_budget, 0)}` : ''}. A cycle that would exceed the budget is skipped, not cut short silently.
          </p>
        </div>

        <Toggle checked={cfg.auto_deploy_paper} onChange={(v) => save.run({ auto_deploy_paper: v })} label="Add strategies that survive validation to paper trading automatically" />
        <Notice tone="am">{st.note}</Notice>
      </div>
    </Panel>
  )
}

export function CycleHistoryPanel({ go }: { go: ViewProps['go'] }) {
  const hist = useApi<CycleHistory[]>('/autonomy/history?limit=20', { poll: 15000 })
  return (
    <Panel title="Run history" subtitle="Every research cycle, what started it, and its estimated versus measured cost.">
      {!hist.data ? (hist.error ? <ErrorBox error={hist.error} onRetry={hist.reload} /> : <Loading rows={4} />) : hist.data.length === 0 ? (
        <EmptyState title="No cycles yet">Cycles you start, run now, or schedule appear here.</EmptyState>
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <table className="data min-w-[640px]">
            <thead><tr><th>Started</th><th>How</th><th>Outcome</th><th className="text-right">Ideas</th><th className="text-right">CPU est. → used</th><th className="text-right">Data requests</th></tr></thead>
            <tbody>
              {hist.data.map((h) => {
                const [label, t] = JOB_STATUS[h.status] ?? [h.status, 'mute']
                return (
                  <tr key={h.job_id} title={h.error ?? undefined}>
                    <td className="whitespace-nowrap">{localTime(h.started_at ?? h.created_at)}</td>
                    <td>{TRIGGER[h.trigger] ?? h.trigger}{h.attempts > 1 ? ` · attempt ${h.attempts}` : ''}</td>
                    <td><span className="inline-flex items-center gap-1.5"><StatusDot tone={t} />{label}</span>{h.error && <div className="max-w-[260px] truncate text-[12px] text-ink-400">{h.error}</div>}</td>
                    <td className="num text-right" title={h.result?.legacy ? 'Run under the superseded v1 method. Its findings were re-evaluated; see Discoveries.' : undefined}>{h.result ? <button className="hover:text-cy" onClick={() => go('experiments')}>{h.result.evaluated}{h.result.legacy ? ' · earlier method' : h.result.accepted ? ` · ${h.result.accepted} survived` : ''}</button> : '—'}</td>
                    <td className="num text-right whitespace-nowrap">{h.estimate?.cpu_s !== undefined ? `${num(h.estimate.cpu_s, 0)}s` : '—'} → {h.usage ? `${num(h.usage.cpu_s, 1)}s` : '—'}</td>
                    <td className="num text-right">{h.usage ? h.usage.data_requests : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {hist.data[0]?.estimate?.basis && <p className="mt-3 text-[12px] text-ink-400">Estimates: {hist.data[0].estimate.basis}.</p>}
        </div>
      )}
    </Panel>
  )
}

export function AwayCard({ go }: { go: ViewProps['go'] }) {
  const [seen, setSeen] = useState(false)
  // Record this visit first, so the report covers the time since the previous visit.
  useEffect(() => { api.post('/me/seen').catch(() => {}).finally(() => setSeen(true)) }, [])
  const rep = useApi<AwayReport>(seen ? '/reports/away' : null, { deps: [seen] })
  const r = rep.data
  if (!r) return rep.error ? <Panel title="While you were away"><ErrorBox error={rep.error} onRetry={rep.reload} /></Panel> : null
  const nothing = r.research.cycles === 0 && r.paper.orders === 0 && r.problems.length === 0
  return (
    <Panel title="While you were away" subtitle={`${r.basis[0].toUpperCase()}${r.basis.slice(1)} · ${localTime(r.since)} to now`}>
      <p className="text-[15px] leading-relaxed text-ink-100">{r.headline}</p>
      {!nothing && (
        <div className="mt-4 space-y-3">
          {r.research.notable.length > 0 && (
            <ul className="divide-y divide-white/[0.05]">
              {r.research.notable.map((n) => {
                const d = DISPOSITION[dispositionOf(n) ?? 'rejected']
                return (
                  <li key={n.experiment_id}>
                    <button onClick={() => go('experiments', { id: n.experiment_id })} className="flex w-full items-center gap-3 py-2 text-left hover:opacity-90">
                      <StatusDot tone={d.tone} /><span className="flex-1 truncate text-[13.5px] text-white">{strategyName(n.strategy)} <span className="text-ink-300">on</span> {n.symbol}</span>
                      <span className="text-[12px] text-ink-300">{d.short}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {r.problems.length > 0 && (
            <Disclosure title="Needs attention" meta={`${r.problems.length}`}>
              <ul className="space-y-1.5 text-[13px] text-ink-200">{r.problems.map((p) => <li key={p.job_id} className="flex gap-2"><StatusDot tone={JOB_STATUS[p.status]?.[1] ?? 'am'} /><span>Job #{p.job_id} ({p.type.replace('_', ' ')}) {JOB_STATUS[p.status]?.[0].toLowerCase() ?? p.status}: {p.error}</span></li>)}</ul>
            </Disclosure>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-ink-300">
            <span>{r.research.trials_registered} trials recorded</span>
            {r.research.holdout_looks > 0 && <span>{r.research.holdout_looks} sealed-data look{r.research.holdout_looks === 1 ? '' : 's'}</span>}
            <span>{num(r.usage.cpu_s, 1)} CPU-seconds</span>
            {r.paper.risk_blocks > 0 && <button className="text-cy hover:underline" onClick={() => go('risk')}>{r.paper.risk_blocks} risk block{r.paper.risk_blocks === 1 ? '' : 's'}</button>}
          </div>
        </div>
      )}
      <p className="mt-3 text-[11.5px] text-ink-400">{r.provenance}</p>
    </Panel>
  )
}
