import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, useApi } from './lib/api'
import { EventProvider, useEvents, useEventTrigger } from './lib/events'
import { duration, money, pct, tone } from './lib/format'
import type { Overview } from './lib/types'
import { CommandView } from './views/Command'
import { ExperimentsView } from './views/Experiments'
import { ForecastView } from './views/Forecast'
import { MarketsView } from './views/Markets'
import { PortfolioView } from './views/Portfolio'
import { ResearchView } from './views/Research'
import { RiskView } from './views/Risk'
import { StrategyView } from './views/Strategy'
import { TelemetryView } from './views/Telemetry'

export type ViewKey = 'command' | 'markets' | 'research' | 'strategy' | 'forecast' | 'portfolio' | 'risk' | 'experiments' | 'telemetry'

const NAV: { key: ViewKey; label: string; code: string; icon: ReactNode; hint: string }[] = [
  { key: 'command', label: 'Command', code: '01', hint: 'Computation graph, telemetry, research outputs', icon: <path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" /> },
  { key: 'markets', label: 'Markets', code: '02', hint: 'Datasets, charts, regimes, features, correlation', icon: <path d="M4 19V9m5 10V5m5 14v-7m5 7V8" /> },
  { key: 'research', label: 'Research Lab', code: '03', hint: 'Agents, autonomous loop, reports', icon: <path d="M9 3h6M10 3v6L5 18a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3M7.5 14h9" /> },
  { key: 'strategy', label: 'Strategy Lab', code: '04', hint: 'Backtest & robustness evaluation', icon: <path d="M3 17l5-5 4 4 8-8M14 8h6v6" /> },
  { key: 'forecast', label: 'Forecast Lab', code: '05', hint: 'Baseline models, intervals, calibration', icon: <path d="M3 12h7m0 0 4-5m-4 5 4 5m0-10h7m-7 10h7" /> },
  { key: 'portfolio', label: 'Paper Portfolio', code: '06', hint: 'Simulated execution & positions', icon: <path d="M3 7h18v12H3zM8 7V5h8v2M3 12h18" /> },
  { key: 'risk', label: 'Risk Centre', code: '07', hint: 'Limits, exposure, audit log, kill switch', icon: <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Zm0 6v4m0 3h.01" /> },
  { key: 'experiments', label: 'Experiments', code: '08', hint: 'Experiment registry & reproducibility', icon: <path d="M4 5h16M4 12h16M4 19h10" /> },
  { key: 'telemetry', label: 'Telemetry', code: '09', hint: 'Jobs, event log, system health', icon: <path d="M3 12h4l3-8 4 16 3-8h4" /> },
]

function Shell() {
  const [view, setView] = useState<ViewKey>(() => (location.hash.slice(1) as ViewKey) || 'command')
  const [palette, setPalette] = useState(false)
  const ov = useApi<Overview>('/system/overview', { poll: 15000 })
  const { connected, rate } = useEvents()
  useEventTrigger((e) => ['paper', 'risk', 'job'].includes(e.category), ov.reload, 1200)

  useEffect(() => { location.hash = view }, [view])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) }
      if (e.key === 'Escape') setPalette(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const o = ov.data
  const Body = { command: CommandView, markets: MarketsView, research: ResearchView, strategy: StrategyView, forecast: ForecastView,
    portfolio: PortfolioView, risk: RiskView, experiments: ExperimentsView, telemetry: TelemetryView }[view]

  return (
    <div className="flex h-full min-h-0">
      {/* navigation rail */}
      <nav className="hidden w-[208px] shrink-0 flex-col border-r border-ink-600/70 bg-ink-900/70 md:flex">
        <div className="flex items-center gap-2.5 border-b border-ink-600/70 px-4 py-3.5">
          <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
            <circle cx="16" cy="16" r="13" fill="none" stroke="#22d3ee" strokeOpacity=".5" />
            <circle cx="16" cy="16" r="7" fill="none" stroke="#22d3ee" />
            <circle cx="16" cy="16" r="2.4" fill="#22d3ee" />
            <path d="M16 3v6M16 23v6M3 16h6M23 16h6" stroke="#22d3ee" strokeOpacity=".6" />
          </svg>
          <div>
            <div className="font-mono text-[15px] font-semibold tracking-[0.3em] text-white">ATLAS</div>
            <div className="font-mono text-[9px] tracking-[0.18em] text-ink-300">INTELLIGENCE OS</div>
          </div>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto py-2">
          {NAV.map((n) => (
            <button key={n.key} onClick={() => setView(n.key)} title={n.hint}
              className={`group flex w-full items-center gap-3 border-l-2 px-4 py-2 text-left transition-colors ${view === n.key ? 'border-cy bg-cy/[0.06] text-white' : 'border-transparent text-ink-200 hover:bg-ink-800 hover:text-white'}`}>
              <svg viewBox="0 0 24 24" className={`h-4 w-4 shrink-0 ${view === n.key ? 'text-cy' : 'text-ink-300 group-hover:text-ink-100'}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{n.icon}</svg>
              <span className="flex-1 truncate text-[12.5px]">{n.label}</span>
              <span className="font-mono text-[9px] text-ink-400">{n.code}</span>
            </button>
          ))}
        </div>
        <div className="space-y-1.5 border-t border-ink-600/70 px-4 py-3 font-mono text-[10px] text-ink-300">
          <div className="flex justify-between"><span>build</span><span className="text-ink-200">{o?.code_version ?? '—'}</span></div>
          <div className="flex justify-between"><span>uptime</span><span className="text-ink-200">{duration(o?.uptime_s)}</span></div>
          <div className="flex justify-between"><span>events/min</span><span className="text-ink-200">{rate}</span></div>
          <button onClick={() => setPalette(true)} className="mt-1 w-full rounded border border-ink-600 py-1 text-ink-200 hover:border-cy/50 hover:text-white">⌘K command</button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* status bar */}
        <header className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-ink-600/70 bg-ink-900/60 px-4 py-2 backdrop-blur">
          <select className="md:hidden" value={view} onChange={(e) => setView(e.target.value as ViewKey)}>
            {NAV.map((n) => <option key={n.key} value={n.key}>{n.label}</option>)}
          </select>
          <div className="hidden items-baseline gap-2 md:flex">
            <span className="label text-cy">{NAV.find((n) => n.key === view)?.code}</span>
            <span className="text-[13px] font-semibold text-white">{NAV.find((n) => n.key === view)?.label}</span>
            <span className="text-[11px] text-ink-300">{NAV.find((n) => n.key === view)?.hint}</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <StatusPill ok tone="am" label="PAPER ONLY" sub="no live broker" />
            <StatusPill ok={!o?.kill_switch} tone={o?.kill_switch ? 'dn' : 'up'} label={o?.kill_switch ? 'KILL SWITCH ON' : 'RISK ARMED'} />
            <StatusPill ok={connected} tone={connected ? 'cy' : 'dn'} label={connected ? 'LIVE LINK' : 'RECONNECTING'} pulse={connected} />
            <StatusPill ok tone={o?.autonomy.config.enabled ? 'cy' : 'mute'} label={o?.autonomy.config.enabled ? 'AUTONOMY ON' : 'AUTONOMY OFF'} />
            {o && (
              <div className="hidden items-baseline gap-2 lg:flex">
                <span className="label">paper equity</span>
                <span className="num text-[13px] text-white">{money(o.paper.equity)}</span>
                <span className={`num text-[11px] ${tone(o.paper.total_return)}`}>{pct(o.paper.total_return)}</span>
              </div>
            )}
          </div>
        </header>
        {ov.error && <div className="border-b border-dn/40 bg-dn/10 px-4 py-1.5 font-mono text-[11px] text-dn">Backend unreachable: {ov.error}. Start it with <code>make backend</code> (see README).</div>}
        <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
          <div key={view} className="fade-in">
            <Body go={setView} overview={o} reloadOverview={ov.reload} />
          </div>
        </main>
      </div>
      {palette && <Palette onClose={() => setPalette(false)} go={(v) => { setView(v); setPalette(false) }} reload={ov.reload} />}
    </div>
  )
}

function StatusPill({ label, sub, tone: t, pulse, ok }: { label: string; sub?: string; tone: 'am' | 'up' | 'dn' | 'cy' | 'mute'; pulse?: boolean; ok?: boolean }) {
  const c = { am: 'text-am', up: 'text-up', dn: 'text-dn', cy: 'text-cy', mute: 'text-ink-300' }[t]
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wider ${c}`} title={sub} aria-label={`${label}${ok ? '' : ' (attention)'}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${pulse ? 'pulse-dot' : ''}`} />
      {label}
    </span>
  )
}

function Palette({ onClose, go, reload }: { onClose: () => void; go: (v: ViewKey) => void; reload: () => void }) {
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const actions = useMemo(() => [
    ...NAV.map((n) => ({ id: `go-${n.key}`, label: `Go to ${n.label}`, hint: n.hint, run: () => go(n.key) })),
    { id: 'cycle', label: 'Run research cycle', hint: 'Orchestrator: discovery → backtest → critic → portfolio', run: async () => { const r = await api.post<{ job_id: number }>('/jobs/research-cycle', { max_hypotheses: 8 }); setMsg(`Queued job #${r.job_id}`); reload() } },
    { id: 'refresh', label: 'Refresh market data', hint: 'Fetch latest bars from providers', run: async () => { const r = await api.post<{ job_id: number }>('/markets/refresh', {}); setMsg(`Queued job #${r.job_id}`) } },
    { id: 'tick', label: 'Run paper engine tick', hint: 'Evaluate deployed strategies now', run: async () => { await api.post('/paper/tick'); setMsg('Paper tick executed'); reload() } },
    { id: 'estop', label: 'EMERGENCY STOP (paper)', hint: 'Halt engine, cancel orders, flatten positions', run: async () => { await api.post('/paper/control', { action: 'emergency_stop' }); setMsg('Emergency stop engaged'); reload() } },
  ], [go, reload])
  const list = actions.filter((a) => (a.label + a.hint).toLowerCase().includes(q.toLowerCase()))
  const [sel, setSel] = useState(0)
  const exec = async (i: number) => {
    try { await list[i]?.run() } catch (e) { setMsg((e as Error).message) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-[560px] overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setSel(0) }} placeholder="Type a command or view…"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setSel((s) => Math.min(list.length - 1, s + 1))
            if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1))
            if (e.key === 'Enter') exec(sel)
          }}
          className="w-full rounded-none border-0 border-b border-ink-600 bg-transparent px-4 py-3 text-[14px]" />
        <div className="scroll-thin max-h-[50vh] overflow-y-auto py-1">
          {list.map((a, i) => (
            <button key={a.id} onMouseEnter={() => setSel(i)} onClick={() => exec(i)}
              className={`flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left ${i === sel ? 'bg-cy/10' : ''}`}>
              <span className={`text-[13px] ${a.id === 'estop' ? 'text-dn' : 'text-white'}`}>{a.label}</span>
              <span className="truncate text-[11px] text-ink-300">{a.hint}</span>
            </button>
          ))}
        </div>
        {msg && <div className="border-t border-ink-600 px-4 py-2 font-mono text-[11px] text-cy">{msg}</div>}
      </div>
    </div>
  )
}

export interface ViewProps {
  go: (v: ViewKey) => void
  overview: Overview | null
  reloadOverview: () => void
}

export default function App() {
  return (
    <EventProvider>
      <Shell />
    </EventProvider>
  )
}
