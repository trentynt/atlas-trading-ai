import { useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { TimeChart, type TSeries } from '../components/charts/TimeChart'
import { Badge, Button, EmptyState, ErrorBox, Field, KeyValue, Loading, Notice, PageHeader, Panel, StatusDot, Tabs } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { num } from '../lib/format'
import { ExperimentsTab } from './IntradayExperiments'

/** Dollars with cents: futures P&L is exact to the cent. */
const money = (v: number | null | undefined) => (v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`)

type Tab = 'experiments' | 'practice' | 'stats' | 'journal' | 'data'

interface Status {
  bars: number; first: string | null; last: string | null; proxy_scale: number; data_note: string
  gate: { passed: boolean; ran_at: string; checks: Record<string, { value: number; threshold: string; passed: boolean; detail: string }> } | null
  keys_present: Record<string, boolean>; apex_rules_verified: boolean; daily_reference_closes: number
}
interface Trade { side: string; contracts: number; entry_ts: string; entry_price: number; exit_ts: string; exit_price: number; exit_reason: string; net: number; commission: number }
interface PracticeView {
  id: number; session_date: string; status: string; cursor: number; total_bars: number; time: string; data_note: string
  bars: { t: string; o: number; h: number; l: number; c: number }[]
  state: { position: number; entry_price: number | null; stop: number | null; target: number | null; pending: { position: number } | null; open_pnl: number; loss_limit_hit: boolean } | null
  trades: Trade[]; net_pnl: number | null
}

const hhmm = (iso: string) => iso.slice(11, 16)

export function IntradayView(_: ViewProps) {
  const [tab, setTab] = useState<Tab>('experiments')
  const status = useApi<Status>('/intraday/status')
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Intraday · MNQ" title="Learn the session"
        subtitle="Replay past sessions bar by bar, practise with paper trades, study how the open behaves, and keep a journal. Paper only: nothing here can place a real order." />
      <Notice tone="am" title="Proxy data">{status.data?.data_note ?? 'Historical QQQ 1-minute bars used as a proxy for MNQ.'}</Notice>
      <Tabs value={tab} onChange={setTab} options={[{ value: 'experiments', label: 'Experiments' }, { value: 'practice', label: 'Replay & practice' }, { value: 'stats', label: 'Opening statistics' }, { value: 'journal', label: 'Journal' }, { value: 'data', label: 'Data & gate' }]} />
      {tab === 'experiments' && <ExperimentsTab />}
      {tab === 'practice' && <PracticeTab />}
      {tab === 'stats' && <StatsTab />}
      {tab === 'journal' && <JournalTab />}
      {tab === 'data' && <DataTab s={status.data} error={status.error} />}
    </div>
  )
}

function NoData() {
  return <EmptyState title="No minute data yet">Add the free Alpaca and Tiingo keys, then run the data gate with <code className="font-mono">--download</code> (see docs/LEARN.md).</EmptyState>
}

function PracticeTab() {
  const sessions = useApi<string[]>('/intraday/sessions')
  const [date, setDate] = useState('')
  const [form, setForm] = useState({ contracts: 1, stop_ticks: '', target_ticks: '', daily_loss_limit: '' })
  const [p, setP] = useState<PracticeView | null>(null)
  const start = useAction(async () => {
    const body = { session_date: date || sessions.data?.at(-1), contracts: form.contracts,
      stop_ticks: form.stop_ticks ? +form.stop_ticks : null, target_ticks: form.target_ticks ? +form.target_ticks : null,
      daily_loss_limit: form.daily_loss_limit ? +form.daily_loss_limit : null }
    setP(await api.post<PracticeView>('/intraday/practice', body))
  })
  const act = useAction(async (path: string) => setP(await api.post<PracticeView>(`/intraday/practice/${p!.id}/${path}`)))
  const series = useMemo<TSeries[]>(() => p ? [{ kind: 'candle', id: 'px', label: 'Price (index points)', data: p.bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })) }] : [], [p])
  const fmt = useMemo(() => (v: number) => v.toFixed(2), [])

  if (sessions.data && sessions.data.length === 0) return <NoData />
  if (!p) return (
    <Panel title="Start a practice session" subtitle="You see one bar at a time. Decisions fill at the next bar's open with the same costs and rules as the backtester.">
      <ErrorBox error={sessions.error || start.error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Field label="Session">
          <select value={date} onChange={(e) => setDate(e.target.value)}>
            <option value="">Latest</option>{[...(sessions.data ?? [])].reverse().map((d) => <option key={d}>{d}</option>)}
          </select>
        </Field>
        <Field label="Contracts"><input type="number" min={1} step={1} value={form.contracts} onChange={(e) => setForm({ ...form, contracts: Math.max(1, Math.round(+e.target.value)) })} /></Field>
        <Field label="Stop (ticks, optional)"><input inputMode="decimal" value={form.stop_ticks} onChange={(e) => setForm({ ...form, stop_ticks: e.target.value })} /></Field>
        <Field label="Target (ticks, optional)"><input inputMode="decimal" value={form.target_ticks} onChange={(e) => setForm({ ...form, target_ticks: e.target.value })} /></Field>
        <Field label="Daily loss limit $ (optional)"><input inputMode="decimal" value={form.daily_loss_limit} onChange={(e) => setForm({ ...form, daily_loss_limit: e.target.value })} /></Field>
      </div>
      <div className="mt-4"><Button tone="primary" onClick={() => start.run()} disabled={start.pending || !sessions.data}>Start replay</Button></div>
    </Panel>
  )

  const st = p.state
  const active = p.status === 'active'
  const pos = st?.position ?? 0
  return (
    <div className="space-y-5">
      <ErrorBox error={act.error} />
      <Panel title={`${p.session_date} · ${p.time} New York`} tag={<Badge tone={active ? 'cy' : 'mute'}>{active ? `Bar ${p.cursor + 1} of ${p.total_bars}` : 'Finished'}</Badge>}
        right={<Button small tone="ghost" onClick={() => setP(null)}>New session</Button>}>
        <TimeChart series={series} height={380} format={fmt} />
        {active && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={() => act.run('step?n=1')} disabled={act.pending}>Next bar</Button>
            <Button onClick={() => act.run('step?n=5')} disabled={act.pending}>+5</Button>
            <Button onClick={() => act.run('step?n=30')} disabled={act.pending}>+30</Button>
            <span className="mx-2 h-6 w-px bg-white/10" />
            <Button tone={pos > 0 ? 'primary' : 'default'} onClick={() => act.run('decide?direction=1')} disabled={act.pending || st?.loss_limit_hit}>Long</Button>
            <Button tone={pos < 0 ? 'primary' : 'default'} onClick={() => act.run('decide?direction=-1')} disabled={act.pending || st?.loss_limit_hit}>Short</Button>
            <Button onClick={() => act.run('decide?direction=0')} disabled={act.pending}>Flat</Button>
            <Button tone="ghost" onClick={() => act.run('finish')} disabled={act.pending}>Finish session</Button>
          </div>
        )}
      </Panel>
      <div className="grid grid-cols-12 gap-5">
        <Panel className="col-span-12 lg:col-span-4" title="Position (paper)">
          {st ? <KeyValue rows={[
            ['Position', pos === 0 ? 'Flat' : `${pos > 0 ? 'Long' : 'Short'} ${Math.abs(pos)} MNQ`],
            ['Pending', st.pending ? (st.pending.position === 0 ? 'Exit at next open' : `${st.pending.position > 0 ? 'Long' : 'Short'} at next open`) : 'None'],
            ['Entry', st.entry_price ? num(st.entry_price, 2) : '—'],
            ['Stop / target', `${st.stop ? num(st.stop, 2) : '—'} / ${st.target ? num(st.target, 2) : '—'}`],
            ['Open P&L', money(st.open_pnl)],
            ['Loss limit', st.loss_limit_hit ? 'Hit: flat for the rest of the day' : 'Not hit'],
          ]} /> : <KeyValue rows={[['Session net', money(p.net_pnl ?? 0)], ['Trades', p.trades.length]]} />}
        </Panel>
        <Panel className="col-span-12 lg:col-span-8" title="Trades" subtitle={`Net ${money(p.trades.reduce((a, t) => a + t.net, 0))} after commission and slippage (simulated).`}>
          {p.trades.length === 0 ? <div className="text-[13px] text-ink-300">No completed trades yet.</div> : <TradeTable trades={p.trades} />}
        </Panel>
      </div>
    </div>
  )
}

function TradeTable({ trades }: { trades: Trade[] }) {
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="data min-w-[620px]">
        <thead><tr><th>Side</th><th>Entry</th><th>Exit</th><th>Why it closed</th><th className="text-right">Commission</th><th className="text-right">Net</th></tr></thead>
        <tbody>{trades.map((t, i) => (
          <tr key={i}><td>{t.side} {t.contracts}</td><td>{hhmm(t.entry_ts)} @ {num(t.entry_price, 2)}</td><td>{hhmm(t.exit_ts)} @ {num(t.exit_price, 2)}</td>
            <td>{t.exit_reason.replace('_', ' ')}</td><td className="text-right">{money(t.commission)}</td>
            <td className={`text-right ${t.net > 0 ? 'text-up' : t.net < 0 ? 'text-dn' : ''}`}>{t.net > 0 ? '+' : ''}{money(t.net)}</td></tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function StatsTab() {
  const [orm, setOrm] = useState(15)
  const s = useApi<any>(`/intraday/stats?or_minutes=${orm}`, { deps: [orm] })
  if (s.error?.includes('No minute data')) return <NoData />
  if (!s.data) return s.error ? <ErrorBox error={s.error} onRetry={s.reload} /> : <Loading rows={6} />
  const o = s.data.opening_range, g = s.data.gaps
  return (
    <div className="space-y-5">
      <p className="text-[13.5px] text-ink-200">{s.data.note} {s.data.sessions} sessions. Sizes in basis points (1 bp = 0.01%). At a Nasdaq-100 level of 20,000, 10 bps ≈ 20 points ≈ $40 per MNQ.</p>
      <div className="grid grid-cols-12 gap-5">
        <Panel className="col-span-12 lg:col-span-6" title="Opening range" right={<select value={orm} onChange={(e) => setOrm(+e.target.value)} aria-label="Opening range length">{[5, 15, 30, 60].map((m) => <option key={m} value={m}>First {m} min</option>)}</select>}>
          <KeyValue rows={[
            ['Typical size', `${num(o.size_bps?.median, 1)} bps (middle half ${num(o.size_bps?.p25, 1)}–${num(o.size_bps?.p75, 1)})`],
            ['Broke above later', `${o.broke_up_pct}% of days`], ['Broke below later', `${o.broke_down_pct}% of days`],
            ['Broke both ways', `${o.broke_both_pct}%`], ['Never broke', `${o.never_broke_pct}%`],
            ['First break', `up ${o.first_break_up_pct}% · down ${o.first_break_down_pct}%`],
            ['Minutes to first break', `median ${num(o.minutes_to_first_break?.median, 0)}`],
          ]} />
        </Panel>
        <Panel className="col-span-12 lg:col-span-6" title="Overnight gaps" subtitle="Open vs the previous regular-hours close. 'Filled' = price traded back to that close during the session.">
          <KeyValue rows={[['Days', g.days], ['Filled the same day', `${g.fill_pct}%`], ['Typical gap size', `${num(g.abs_gap_bps?.median, 1)} bps`]]} />
          <table className="data mt-3"><thead><tr><th>Gap size</th><th className="text-right">Days</th><th className="text-right">Filled</th><th className="text-right">Median minutes</th></tr></thead>
            <tbody>{g.by_size?.map((b: any) => <tr key={b.bucket}><td>{b.bucket}</td><td className="text-right">{b.days}</td><td className="text-right">{b.fill_pct}%</td><td className="text-right">{b.median_minutes_to_fill ?? '—'}</td></tr>)}</tbody></table>
        </Panel>
      </div>
      <Panel title="Volatility by time of day" subtitle="Average size of a one-minute move in each 15-minute block.">
        <div className="space-y-1.5">
          {s.data.volatility_by_time.map((b: any) => {
            const max = Math.max(...s.data.volatility_by_time.map((x: any) => x.mean_abs_move_bps))
            return (
              <div key={b.from} className="grid grid-cols-[52px_1fr_70px] items-center gap-3 text-[12.5px]">
                <span className="num text-ink-300">{b.from}</span>
                <div className="h-2 rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-bl/70" style={{ width: `${(b.mean_abs_move_bps / max) * 100}%` }} /></div>
                <span className="num text-right text-ink-100">{num(b.mean_abs_move_bps, 2)} bps</span>
              </div>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}

const EMPTY = { trade_date: new Date().toISOString().slice(0, 10), side: 'long', contracts: '1', entry_time: '', entry_price: '', exit_time: '', exit_price: '', setup: '', notes: '', mistakes: '', lesson: '', rating: '' }

function JournalTab() {
  const list = useApi<any[]>('/intraday/journal')
  const [f, setF] = useState(EMPTY)
  const save = useAction(async () => {
    const n = (v: string) => (v === '' ? null : +v)
    await api.post('/intraday/journal', { ...f, contracts: n(f.contracts), entry_price: n(f.entry_price), exit_price: n(f.exit_price), rating: n(f.rating) })
    setF(EMPTY); list.reload()
  })
  const del = useAction(async (id: number) => { await api.del(`/intraday/journal/${id}`); list.reload() })
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="grid grid-cols-12 gap-5">
      <Panel className="col-span-12 xl:col-span-5" title="Log a paper trade" subtitle="Net P&L is computed for MNQ with the same commission and slippage as the backtester.">
        <ErrorBox error={save.error} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date"><input type="date" value={f.trade_date} onChange={set('trade_date')} /></Field>
          <Field label="Side"><select value={f.side} onChange={set('side')}><option value="long">Long</option><option value="short">Short</option></select></Field>
          <Field label="Contracts"><input type="number" min={1} step={1} value={f.contracts} onChange={set('contracts')} /></Field>
          <Field label="Rating (1–5)"><input type="number" min={1} max={5} value={f.rating} onChange={set('rating')} /></Field>
          <Field label="Entry time"><input type="time" value={f.entry_time} onChange={set('entry_time')} /></Field>
          <Field label="Entry price"><input inputMode="decimal" value={f.entry_price} onChange={set('entry_price')} /></Field>
          <Field label="Exit time"><input type="time" value={f.exit_time} onChange={set('exit_time')} /></Field>
          <Field label="Exit price"><input inputMode="decimal" value={f.exit_price} onChange={set('exit_price')} /></Field>
        </div>
        <div className="mt-3 space-y-3">
          <Field label="Setup (what you saw)"><input value={f.setup} onChange={set('setup')} /></Field>
          <Field label="Notes"><textarea rows={3} value={f.notes} onChange={set('notes')} /></Field>
          <Field label="Mistakes"><input value={f.mistakes} onChange={set('mistakes')} /></Field>
          <Field label="Lesson"><input value={f.lesson} onChange={set('lesson')} /></Field>
        </div>
        <div className="mt-4"><Button tone="primary" onClick={() => save.run()} disabled={save.pending}>Save entry</Button></div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-7" title="Journal" subtitle={list.data ? `${list.data.length} entries · net ${money(list.data.reduce((a, e) => a + (e.net ?? 0), 0))} (paper)` : undefined}>
        {!list.data ? <Loading /> : list.data.length === 0 ? <EmptyState title="No entries yet">Write down every practice trade: what you saw, what you did, and what you learned.</EmptyState> : (
          <ul className="divide-y divide-white/[0.05]">
            {list.data.map((e) => (
              <li key={e.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 text-[13.5px]">
                  <span className="font-medium text-white">{e.trade_date}</span>
                  <span className="text-ink-200">{e.side ? `${e.side} ${e.contracts ?? ''} ${e.contract}` : 'note'}</span>
                  {e.entry_price != null && <span className="text-ink-300">{e.entry_time} {e.entry_price} → {e.exit_time} {e.exit_price}</span>}
                  {e.net != null && <span className={`num ${e.net > 0 ? 'text-up' : e.net < 0 ? 'text-dn' : ''}`}>{e.net > 0 ? '+' : ''}{money(e.net)}</span>}
                  <button className="ml-auto text-[12px] text-ink-300 hover:text-dn" onClick={() => del.run(e.id)}>Delete</button>
                </div>
                {e.setup && <div className="mt-1 text-[13px] text-ink-200">Setup: {e.setup}</div>}
                {e.notes && <div className="mt-0.5 text-[13px] text-ink-200">{e.notes}</div>}
                {(e.mistakes || e.lesson) && <div className="mt-0.5 text-[12.5px] text-ink-300">{e.mistakes && `Mistakes: ${e.mistakes}. `}{e.lesson && `Lesson: ${e.lesson}`}</div>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

function DataTab({ s, error }: { s: Status | null; error: string | null }) {
  if (!s) return error ? <ErrorBox error={error} /> : <Loading />
  return (
    <div className="grid grid-cols-12 gap-5">
      <Panel className="col-span-12 lg:col-span-5" title="Stored data">
        <KeyValue rows={[['Minute bars (QQQ, regular hours)', s.bars.toLocaleString()], ['From', s.first?.slice(0, 10) ?? '—'], ['To', s.last?.slice(0, 10) ?? '—'],
          ['Independent daily closes (Tiingo)', s.daily_reference_closes], ['Proxy scale (index ÷ QQQ)', `${s.proxy_scale} (INFERENCE, set ATLAS_PROXY_SCALE)`],
          ...Object.entries(s.keys_present).map(([k, v]) => [k, v ? 'set' : 'missing'] as [string, string]),
          ['Apex rules', s.apex_rules_verified ? 'verified' : 'not filled in (VERIFY on apextraderfunding.com)']]} />
      </Panel>
      <Panel className="col-span-12 lg:col-span-7" title="Data-quality gate" tag={s.gate ? <Badge tone={s.gate.passed ? 'up' : 'dn'}>{s.gate.passed ? 'Passed' : 'Failed'}</Badge> : <Badge>Not run</Badge>}
        subtitle="Thresholds were fixed in code before any data was seen.">
        {!s.gate ? <div className="text-[13px] text-ink-300">Run <code className="font-mono">python -m atlas.futures.gate --download</code> from the backend folder after adding the keys.</div> : (
          <ul className="space-y-2.5">
            {Object.entries(s.gate.checks).map(([k, c]) => (
              <li key={k} className="flex gap-3 text-[13px]"><StatusDot tone={c.passed ? 'up' : 'dn'} />
                <span><b className="text-white">{k}</b> {c.passed ? 'passed' : 'failed'}: {String(c.value)} (needs {c.threshold}). <span className="text-ink-300">{c.detail}</span></span></li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
