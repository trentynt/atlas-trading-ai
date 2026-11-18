import { useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { Badge, Button, Drawer, EmptyState, ErrorBox, KeyValue, Loading, Meter, Panel, PageHeader, Segmented, StatusDot, Toggle, type Tone } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { useEvents, useEventTrigger } from '../lib/events'
import { ago, compact, duration, num, time } from '../lib/format'
import { useToast } from '../lib/toast'
import { humanizeEvent } from '../lib/explain'
import type { AtlasEvent, Job, Market } from '../lib/types'

const CATS = [
  { value: 'all', label: 'Everything' }, { value: 'research', label: 'Research' }, { value: 'agent', label: 'Agents' }, { value: 'data', label: 'Market data' },
  { value: 'paper', label: 'Paper trading' }, { value: 'risk', label: 'Risk' }, { value: 'job', label: 'Jobs' }, { value: 'system', label: 'System' },
] as const
const CAT_TONE: Record<string, Tone> = { research: 'vi', agent: 'cy', data: 'bl', paper: 'am', risk: 'dn', job: 'mute', system: 'mute' }
const JOB_NAME: Record<string, string> = { research_cycle: 'Research cycle', data_refresh: 'Market data refresh' }
const JOB_STATUS: Record<string, [string, Tone]> = { completed: ['Completed', 'up'], failed: ['Failed', 'dn'], interrupted: ['Interrupted', 'dn'], running: ['Running', 'cy'], queued: ['Queued', 'mute'], cancelled: ['Cancelled', 'am'] }

export function TelemetryView({ overview: o }: ViewProps) {
  const { events, connected, rate } = useEvents()
  const jobs = useApi<Job[]>('/jobs?limit=60', { poll: 5000 })
  const markets = useApi<Market[]>('/markets', { poll: 60000 })
  const [cat, setCat] = useState<(typeof CATS)[number]['value']>('all')
  const [q, setQ] = useState('')
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [technical, setTechnical] = useState(false)
  const [jobSel, setJobSel] = useState<Job | null>(null)
  const toast = useToast()
  useEventTrigger((e) => e.category === 'job', jobs.reload, 400)
  const cancel = useAction(async (id: number) => { await api.post(`/jobs/${id}/cancel`); toast({ tone: 'warning', title: `Cancelling job #${id}` }); jobs.reload() })

  const shown = useMemo(() => events.filter((e) => (cat === 'all' || e.category === cat) && (!problemsOnly || e.level !== 'info') && (!q || (e.message + ' ' + humanizeEvent(e.message)).toLowerCase().includes(q.toLowerCase()))), [events, cat, q, problemsOnly])
  const day = Date.now() - 86400_000
  const recent = jobs.data?.filter((j) => new Date(j.created_at).getTime() > day) ?? []
  const failed = recent.filter((j) => ['failed', 'interrupted'].includes(j.status)).length
  const active = jobs.data?.filter((j) => ['queued', 'running'].includes(j.status)) ?? []
  const fresh = markets.data?.filter((m) => !m.is_stale).length ?? 0
  const warns = events.filter((e) => e.level !== 'info').length

  const health: { title: string; tone: Tone; value: string; sub: string }[] = [
    { title: 'Research engine', tone: connected ? 'up' : 'dn', value: connected ? 'Connected' : 'Reconnecting', sub: `Up ${duration(o?.uptime_s)} · ${rate} events/min` },
    { title: 'Market data', tone: fresh === (markets.data?.length ?? 0) ? 'up' : 'am', value: `${fresh} of ${markets.data?.length ?? '—'} fresh`, sub: 'Daily data from verified providers' },
    { title: 'Jobs (24 h)', tone: failed ? 'dn' : 'up', value: `${recent.length} run${recent.length === 1 ? '' : 's'}`, sub: failed ? `${failed} failed` : active.length ? `${active.length} running now` : 'No failures' },
    { title: 'Audit trail', tone: 'mute', value: `${compact(o?.counts.events)} events`, sub: `${num((o?.db_bytes ?? 0) / 1e6, 1)} MB stored locally` },
  ]

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Activity" title="System activity" subtitle="Everything SIGNAL has done — research, data updates, paper orders and risk decisions — recorded and streamed live." />

      <div className="panel grid grid-cols-1 divide-y divide-white/[0.06] sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-4 xl:divide-x">
        {health.map((h) => (
          <div key={h.title} className="px-5 py-4">
            <div className="flex items-center gap-2 text-[13px] text-ink-300"><StatusDot tone={h.tone} pulse={h.title === 'Research engine' && connected} />{h.title}</div>
            <div className="num mt-1 text-[20px] text-white">{h.value}</div>
            <div className="text-[12.5px] text-ink-300">{h.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-5">
        <Panel className="col-span-12 xl:col-span-8" title="Timeline" subtitle={`${shown.length} of ${events.length} recent events${warns ? ` · ${warns} warning${warns === 1 ? '' : 's'}` : ''}`}
          right={<input placeholder="Search events" value={q} onChange={(e) => setQ(e.target.value)} className="w-44 !py-1.5" aria-label="Search events" />}>
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segmented size="sm" value={cat} onChange={setCat} options={CATS.map((c) => ({ value: c.value, label: c.label }))} />
            <div className="ml-auto flex items-center gap-4">
              <Toggle checked={problemsOnly} onChange={setProblemsOnly} label="Problems only" />
              <Toggle checked={technical} onChange={setTechnical} label="Technical" />
            </div>
          </div>
          {shown.length === 0 ? <EmptyState title="Nothing to show">No events match these filters.</EmptyState> : (
            <ol className="scroll-thin relative max-h-[680px] overflow-y-auto pr-1">
              {shown.slice(0, 250).map((e, i) => <EventRow key={e.id ?? `${e.ts}${i}`} e={e} technical={technical} />)}
            </ol>
          )}
        </Panel>

        <Panel className="col-span-12 xl:col-span-4" title="Jobs" subtitle="Background work, newest first." right={active.length > 0 && <Badge tone="cy" dot>{active.length} active</Badge>}>
          <ErrorBox error={cancel.error} />
          {!jobs.data ? <Loading rows={6} /> : jobs.data.length === 0 ? <EmptyState title="No jobs yet" /> : (
            <ul className="scroll-thin max-h-[680px] space-y-2 overflow-y-auto pr-1">
              {jobs.data.map((j) => {
                const [label, t] = JOB_STATUS[j.status] ?? [j.status, 'mute' as Tone]
                const live = ['queued', 'running'].includes(j.status)
                return (
                  <li key={j.id}>
                    <button onClick={() => setJobSel(j)} className="w-full rounded-[12px] bg-white/[0.02] px-4 py-3 text-left ring-1 ring-inset ring-white/[0.05] transition-colors hover:bg-white/[0.045]">
                      <div className="flex items-center gap-2">
                        <StatusDot tone={t} pulse={live} />
                        <span className="flex-1 text-[13.5px] font-medium text-white">{JOB_NAME[j.type] ?? j.type}</span>
                        <span className="text-[12px] text-ink-300">#{j.id}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between pl-[16px] text-[12.5px] text-ink-300"><span>{label}</span><span>{ago(j.created_at)}</span></div>
                      {live && <div className="mt-2 pl-[16px]"><Meter value={j.progress} limit={1.25} /><div className="mt-1 truncate text-[12px] text-ink-300">{j.message}</div></div>}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </div>

      <Drawer open={!!jobSel} onClose={() => setJobSel(null)} width={560}
        title={jobSel ? <span><span className="block text-[12.5px] font-medium text-cy">Job #{jobSel.id}</span>{JOB_NAME[jobSel.type] ?? jobSel.type}</span> : ''}
        footer={jobSel && ['queued', 'running'].includes(jobSel.status) ? <Button tone="danger" onClick={() => { cancel.run(jobSel.id); setJobSel(null) }}>Cancel job</Button> : undefined}>
        {jobSel && (
          <div className="space-y-5">
            <KeyValue rows={[
              ['Status', JOB_STATUS[jobSel.status]?.[0] ?? jobSel.status],
              ['Created', new Date(jobSel.created_at).toLocaleString()],
              ['Started', jobSel.started_at ? new Date(jobSel.started_at).toLocaleString() : '—'],
              ['Finished', jobSel.finished_at ? new Date(jobSel.finished_at).toLocaleString() : '—'],
              ['Progress', `${Math.round(jobSel.progress * 100)}%`],
            ]} />
            {jobSel.result?.headline && <p className="text-[14px] text-ink-100">{jobSel.result.headline}</p>}
            {jobSel.error && <div><div className="label mb-1.5">Error</div><pre className="scroll-thin max-h-60 overflow-auto rounded-[12px] bg-dn/[0.07] p-3 font-mono text-[11.5px] whitespace-pre-wrap text-dn">{jobSel.error}</pre></div>}
            {jobSel.result && <div><div className="label mb-1.5">Result</div><pre className="scroll-thin max-h-72 overflow-auto rounded-[12px] bg-black/30 p-3 font-mono text-[11.5px] whitespace-pre-wrap text-ink-200">{JSON.stringify(jobSel.result, null, 2).slice(0, 4000)}</pre></div>}
          </div>
        )}
      </Drawer>
    </div>
  )
}

function EventRow({ e, technical }: { e: AtlasEvent; technical: boolean }) {
  const t: Tone = e.level === 'error' ? 'dn' : e.level === 'warn' ? 'am' : CAT_TONE[e.category] ?? 'mute'
  const label = CATS.find((c) => c.value === e.category)?.label ?? e.category
  return (
    <li className="relative flex gap-4 pb-3 pl-1">
      <div className="flex w-[58px] shrink-0 flex-col items-end pt-[1px]">
        <span className="tnum text-[12px] text-ink-300">{time(e.ts).slice(0, 5)}</span>
      </div>
      <div className="relative flex flex-col items-center">
        <span className={`mt-[5px] h-2 w-2 rounded-full ${({ dn: 'bg-dn', am: 'bg-am', vi: 'bg-vi', cy: 'bg-cy', bl: 'bg-bl', up: 'bg-up', mute: 'bg-ink-400' } as Record<Tone, string>)[t]}`} />
        <span className="mt-1 w-px flex-1 bg-white/[0.06]" />
      </div>
      <div className="min-w-0 flex-1 pb-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-ink-300">{label}</span>
          {e.level !== 'info' && <Badge tone={t}>{e.level === 'error' ? 'Error' : 'Warning'}</Badge>}
        </div>
        <div className="mt-0.5 text-[13.5px] leading-snug break-words text-ink-100">{technical ? e.message : humanizeEvent(e.message)}</div>
        {technical && <pre className="mt-1.5 overflow-x-auto rounded-[8px] bg-black/25 px-2.5 py-1.5 font-mono text-[11px] text-ink-300">{JSON.stringify({ id: e.id, ts: e.ts, source: e.source, ...e.data })}</pre>}
      </div>
    </li>
  )
}
