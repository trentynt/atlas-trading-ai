import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { StatusDot } from './components/ui'
import { api, useApi } from './lib/api'
import { EventProvider, useEvents, useEventTrigger } from './lib/events'
import { money, pct, tone } from './lib/format'
import { strategyName } from './lib/explain'
import { navigate, symToParam, useRoute, type ViewKey } from './lib/route'
import { ToastProvider, useToast } from './lib/toast'
import type { Experiment, Market, Overview } from './lib/types'
import { CommandView } from './views/Command'
import { ExperimentsView } from './views/Experiments'
import { ForecastView } from './views/Forecast'
import { MarketsView } from './views/Markets'
import { PortfolioView } from './views/Portfolio'
import { ResearchView } from './views/Research'
import { RiskView } from './views/Risk'
import { StrategyView } from './views/Strategy'
import { TelemetryView } from './views/Telemetry'

export type { ViewKey }

const I = (d: ReactNode) => d
export const NAV: { key: ViewKey; label: string; hint: string; group: 'Home' | 'Research' | 'Trading' | 'System'; icon: ReactNode }[] = [
  { key: 'command', label: 'Overview', group: 'Home', hint: 'What your markets, research team and portfolio are doing', icon: I(<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-7.5Z" />) },
  { key: 'markets', label: 'Markets', group: 'Home', hint: 'Prices, regimes, data quality and correlations', icon: I(<path d="M4 19V10m5 9V5m5 14v-7m5 7V8" />) },
  { key: 'research', label: 'Research', group: 'Research', hint: 'Your research team and its findings', icon: I(<><circle cx="9" cy="9" r="3" /><circle cx="17" cy="15" r="3" /><path d="M11.5 10.8 14.6 13.3M4 20c.6-2.6 2.5-4 5-4M20 6.5c-.7-1.4-2-2.3-3.5-2.5" /></>) },
  { key: 'strategy', label: 'Strategies', group: 'Research', hint: 'Design and test trading strategies', icon: I(<path d="M3 17l5-5 4 4 8-8M14 8h6v6" />) },
  { key: 'forecast', label: 'Forecasts', group: 'Research', hint: 'Statistical forecasts with honest uncertainty', icon: I(<path d="M3 15c3 0 4-6 7-6s3 4 5 4 3-3 6-3M15 13v6m3-7v7m3-9v9" />) },
  { key: 'experiments', label: 'Discoveries', group: 'Research', hint: 'Every idea tested, the evidence, and the verdict', icon: I(<><path d="M9 3h6M10 3v6L5 18a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" /><path d="M7.5 14h9" /></>) },
  { key: 'portfolio', label: 'Portfolio', group: 'Trading', hint: 'Simulated paper portfolio — no real money', icon: I(<><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18" /></>) },
  { key: 'risk', label: 'Risk', group: 'Trading', hint: 'Limits, exposure, kill switch and risk events', icon: I(<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Zm0 5.5v4.5m0 3h.01" />) },
  { key: 'telemetry', label: 'Activity', group: 'System', hint: 'System health, jobs and the audit trail', icon: I(<path d="M3 12h4l3-8 4 16 3-8h4" />) },
]

function Logo({ size = 34 }: { size?: number }) {
  return (
    <div className="flex items-center justify-center rounded-[10px] bg-[linear-gradient(145deg,#1d2a2d,#0f1517)] ring-1 ring-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 24 24" style={{ width: size * 0.6, height: size * 0.6 }} fill="none" strokeLinecap="round">
        <path d="M3 13.5h3.2l2.3-6 3.2 11 2.6-8.2 1.6 3.2H21" stroke="#5eead4" strokeWidth="1.9" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

function Shell() {
  const { view } = useRoute()
  const [search, setSearch] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const ov = useApi<Overview>('/system/overview', { poll: 15000 })
  const searchMarkets = useApi<Market[]>('/markets', { poll: 120000 })
  const searchExps = useApi<Experiment[]>('/experiments?kind=hypothesis_test&limit=200', { poll: 60000 })
  const { connected } = useEvents()
  useEventTrigger((e) => ['paper', 'risk', 'job'].includes(e.category), ov.reload, 1200)
  const mainRef = useRef<HTMLElement>(null)

  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); setMobileNav(false) }, [view])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? '')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearch((p) => !p) }
      else if (!typing && e.key === '/') { e.preventDefault(); setSearch(true) }
      else if (!typing && e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); navigate(NAV[+e.key - 1].key) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const o = ov.data
  const Body = { command: CommandView, markets: MarketsView, research: ResearchView, strategy: StrategyView, forecast: ForecastView,
    portfolio: PortfolioView, risk: RiskView, experiments: ExperimentsView, telemetry: TelemetryView }[view]
  const go = (v: ViewKey, params?: Record<string, string | number | undefined>) => navigate(v, params)

  const sidebar = (
    <>
      <div className="flex items-center gap-3 px-5 pt-5 pb-5">
        <Logo />
        <div className="min-w-0">
          <div className="text-[16px] leading-tight font-semibold tracking-[0.12em] text-white">SIGNAL</div>
          <div className="text-[12px] text-ink-300">Research company</div>
        </div>
      </div>
      <button onClick={() => setSearch(true)} className="mx-3 mb-3 flex items-center gap-2 rounded-[10px] bg-white/[0.05] px-3 py-[7px] text-[13px] text-ink-300 ring-1 ring-inset ring-white/[0.05] transition-colors hover:bg-white/[0.08] hover:text-ink-100">
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="9" cy="9" r="5.5" /><path d="m13 13 4 4" strokeLinecap="round" /></svg>
        <span className="flex-1 text-left">Search</span><kbd>⌘K</kbd>
      </button>
      <div className="scroll-thin flex-1 overflow-y-auto px-3 pb-3">
        {(['Home', 'Research', 'Trading', 'System'] as const).map((g) => (
          <div key={g} className="mb-3">
            {g !== 'Home' && <div className="px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-ink-400">{g}</div>}
            {NAV.filter((n) => n.group === g).map((n) => {
              const on = view === n.key
              return (
                <button key={n.key} onClick={() => go(n.key)} title={n.hint} aria-current={on ? 'page' : undefined}
                  className={`group relative flex w-full items-center gap-3 rounded-[10px] px-2.5 py-[7px] text-left transition-colors duration-150 ${on ? 'bg-white/[0.08] text-white' : 'text-ink-200 hover:bg-white/[0.04] hover:text-white'}`}>
                  {on && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-cy" />}
                  <svg viewBox="0 0 24 24" className={`h-[18px] w-[18px] shrink-0 ${on ? 'text-cy' : 'text-ink-300 group-hover:text-ink-100'}`} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{n.icon}</svg>
                  <span className={`flex-1 truncate text-[14px] ${on ? 'font-medium' : ''}`}>{n.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="mx-3 mb-4 rounded-[12px] bg-am/[0.07] px-3.5 py-3 ring-1 ring-inset ring-am/15">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-am"><StatusDot tone="am" />Paper trading only</div>
        <p className="mt-1 text-[12px] leading-snug text-ink-300">Simulated execution. SIGNAL has no broker connection and cannot move real money.</p>
      </div>
    </>
  )

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Workspaces" className="material hidden w-[236px] shrink-0 flex-col border-r border-white/[0.06] md:flex">{sidebar}</nav>
      {mobileNav && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="scrim-in absolute inset-0 bg-black/50" onClick={() => setMobileNav(false)} />
          <nav className="drawer-in absolute top-0 left-0 flex h-full w-[264px] flex-col border-r border-white/[0.08] bg-[rgba(12,15,19,0.98)]">{sidebar}</nav>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="material z-10 flex h-[56px] shrink-0 items-center gap-3 border-b border-white/[0.06] px-4 md:px-6">
          <button className="flex h-9 w-9 items-center justify-center rounded-[10px] text-ink-200 hover:bg-white/[0.06] md:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation">
            <svg viewBox="0 0 20 20" className="h-5 w-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 6h14M3 10h14M3 14h14" /></svg>
          </button>
          <div className="flex min-w-0 items-center gap-2 md:hidden"><Logo size={26} /><span className="text-[14px] font-semibold tracking-[0.1em]">SIGNAL</span></div>
          <div className="hidden min-w-0 text-[13px] text-ink-300 md:block">{NAV.find((n) => n.key === view)?.hint}</div>
          <div className="ml-auto flex items-center gap-2">
            {!connected && <Chip tone="dn" label="Reconnecting…" title="The connection to the SIGNAL research engine dropped. Retrying automatically." />}
            {o?.kill_switch && <Chip tone="dn" label="Kill switch on" title="Only exposure-reducing paper orders are accepted" onClick={() => go('risk')} />}
            {o?.autonomy.config.enabled && <span className="hidden sm:contents"><Chip tone="cy" label="Autonomous research on" title="Research runs on a schedule" onClick={() => go('research')} /></span>}
            {o && (
              <button onClick={() => go('portfolio')} className="ml-1 hidden items-baseline gap-2 rounded-[10px] px-2.5 py-1 transition-colors hover:bg-white/[0.05] lg:flex" title="Simulated paper equity">
                <span className="text-[12px] text-ink-300">Paper</span>
                <span className="num text-[14px] text-white">{money(o.paper.equity)}</span>
                <span className={`num text-[12px] ${tone(o.paper.total_return)}`}>{pct(o.paper.total_return)}</span>
              </button>
            )}
          </div>
        </header>
        {ov.error && (
          <div role="alert" className="bg-dn/[0.12] px-6 py-2.5 text-[13px] text-dn">
            Can't reach the SIGNAL research engine ({ov.error}). Start it with <code className="font-mono">make backend</code>, then <button className="underline" onClick={ov.reload}>retry</button>.
          </div>
        )}
        <main ref={mainRef} className="scroll-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-5 md:px-8 md:py-7">
          <div key={view} className="fade-in mx-auto max-w-[1680px]">
            <Body go={go} overview={o} reloadOverview={ov.reload} />
          </div>
        </main>
      </div>
      {search && <SearchPalette onClose={() => setSearch(false)} reload={ov.reload} markets={searchMarkets.data ?? []} exps={searchExps.data ?? []} />}
    </div>
  )
}

function Chip({ label, tone: t, pulse, title, onClick, className = '' }: { label: string; tone: 'am' | 'up' | 'dn' | 'cy' | 'mute'; pulse?: boolean; title?: string; onClick?: () => void; className?: string }) {
  return (
    <button onClick={onClick} title={title} disabled={!onClick}
      className={`inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-[4px] text-[12.5px] font-medium whitespace-nowrap text-ink-100 ring-1 ring-inset ring-white/[0.05] transition-colors enabled:hover:bg-white/[0.09] ${className}`}>
      <StatusDot tone={t} pulse={pulse} />{label}
    </button>
  )
}

interface SearchItem { id: string; group: string; label: string; hint: string; run: () => void | Promise<void>; danger?: boolean }

function SearchPalette({ onClose, reload, markets, exps }: { onClose: () => void; reload: () => void; markets: Market[]; exps: Experiment[] }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const toast = useToast()
  const items = useMemo<SearchItem[]>(() => {
    const done = (f: () => void | Promise<void>) => async () => { await f(); onClose() }
    return [
      ...NAV.map((n) => ({ id: `nav-${n.key}`, group: 'Workspaces', label: n.label, hint: n.hint, run: done(() => navigate(n.key)) })),
      ...markets.map((m) => ({ id: `m-${m.symbol}`, group: 'Instruments', label: m.symbol, hint: `${m.asset_class === 'fx' ? 'Forex · ECB daily reference rate' : 'Crypto · daily candles'} · ${m.provider ?? ''}`, run: done(() => navigate('markets', { sym: symToParam(m.symbol) })) })),
      ...exps.map((e) => ({ id: `e-${e.id}`, group: 'Discoveries', label: `${strategyName(e.strategy)} · ${e.symbol}  #${e.id}`, hint: e.verdict === 'accepted' ? 'Passed every check' : 'Rejected', run: done(() => navigate('experiments', { id: e.id })) })),
      { id: 'a-cycle', group: 'Actions', label: 'Run a research cycle', hint: 'Your research team proposes, tests and reviews new ideas', run: done(async () => { const r = await api.post<{ job_id: number }>('/jobs/research-cycle', { max_hypotheses: 8 }); toast({ tone: 'info', title: 'Research cycle started', body: `Job #${r.job_id}. Follow it on the Research page.` }); reload() }) },
      { id: 'a-refresh', group: 'Actions', label: 'Refresh market data', hint: 'Fetch the latest daily bars from data providers', run: done(async () => { await api.post('/markets/refresh', {}); toast({ tone: 'info', title: 'Refreshing market data' }) }) },
      { id: 'a-tick', group: 'Actions', label: 'Run the paper engine now', hint: 'Evaluate deployed strategies against the latest data', run: done(async () => { await api.post('/paper/tick'); toast({ tone: 'success', title: 'Paper engine evaluated' }); reload() }) },
      { id: 'a-stop', group: 'Actions', label: 'Emergency stop (paper)', hint: 'Halt the paper engine, cancel orders and flatten positions', danger: true, run: done(() => navigate('portfolio', { confirm: 'stop' })) },
    ]
  }, [markets, exps, onClose, reload, toast])
  const list = items.filter((a) => (a.label + ' ' + a.hint + ' ' + a.group).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 40)
  const exec = async (i: number) => {
    try { await list[i]?.run() } catch (e) { toast({ tone: 'error', title: 'Action failed', body: (e as Error).message }) }
  }
  let lastGroup = ''
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="scrim-in absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-label="Search" className="dialog-in relative w-full max-w-[620px] overflow-hidden rounded-[20px] border border-white/[0.09] bg-[rgba(20,25,31,0.96)] shadow-[0_40px_100px_-20px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-5">
          <svg viewBox="0 0 20 20" className="h-5 w-5 text-ink-300" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="9" cy="9" r="5.5" /><path d="m13 13 4 4" strokeLinecap="round" /></svg>
          <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setSel(0) }} placeholder="Search workspaces, instruments, discoveries and actions"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(list.length - 1, s + 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
              if (e.key === 'Enter') exec(sel)
              if (e.key === 'Escape') onClose()
            }}
            className="h-[58px] flex-1 !rounded-none !border-0 !bg-transparent !px-0 !text-[16px] !shadow-none" />
          <kbd>esc</kbd>
        </div>
        <div className="scroll-thin max-h-[52vh] overflow-y-auto p-2">
          {list.length === 0 && <div className="px-4 py-8 text-center text-[13px] text-ink-300">No matches for “{q}”.</div>}
          {list.map((a, i) => {
            const head = a.group !== lastGroup ? a.group : null
            lastGroup = a.group
            return (
              <div key={a.id}>
                {head && <div className="px-3 pt-3 pb-1 text-[11.5px] font-medium text-ink-400">{head}</div>}
                <button onMouseEnter={() => setSel(i)} onClick={() => exec(i)}
                  className={`flex w-full items-baseline justify-between gap-4 rounded-[11px] px-3 py-2.5 text-left transition-colors ${i === sel ? (a.danger ? 'bg-dn/[0.16]' : 'bg-white/[0.08]') : ''}`}>
                  <span className={`text-[14px] font-medium ${a.danger ? 'text-dn' : 'text-white'}`}>{a.label}</span>
                  <span className="truncate text-[12.5px] text-ink-300">{a.hint}</span>
                </button>
              </div>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-white/[0.06] px-5 py-2.5 text-[12px] text-ink-400">
          <span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span><span><kbd>⌥</kbd> <kbd>1–9</kbd> jump to workspace</span>
        </div>
      </div>
    </div>
  )
}

export interface ViewProps {
  go: (v: ViewKey, params?: Record<string, string | number | undefined>) => void
  overview: Overview | null
  reloadOverview: () => void
}

export default function App() {
  return (
    <ToastProvider>
      <EventProvider>
        <Shell />
      </EventProvider>
    </ToastProvider>
  )
}
