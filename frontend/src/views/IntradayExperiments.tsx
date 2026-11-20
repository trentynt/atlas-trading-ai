import { useMemo, useState } from 'react'
import { TimeChart, type TSeries } from '../components/charts/TimeChart'
import { Badge, Button, Dialog, EmptyState, ErrorBox, Field, KeyValue, Loading, Notice, Panel, StatusDot } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { num } from '../lib/format'

const money = (v: number | null | undefined) => (v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`)
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

interface Spec {
  or_minutes: number; entry: 'or_breakout' | 'first_bar_direction'; direction: 'long' | 'short' | 'both'
  stop: { kind: 'or_opposite' | 'ticks' | 'atr'; value: number | null }
  exit: { kind: 'session_close' | 'target_r' | 'clock'; value: number | string | null }
  filters: { weekdays: number[] | null; gap_min_bps: number | null; gap_max_bps: number | null; prior_range_min_bps: number | null; prior_range_max_bps: number | null }
  contracts: 1; commission_per_side: number; slippage_ticks: number
}
interface Gates { min_net_expectancy: number; max_bootstrap_p: number; drop_best_days: number; slippage_multiple: number }
interface Exp { id: number; name: string; rationale: string; status: 'draft' | 'registered'; spec: Spec; gates: Gates; registered_at: string | null; spec_hash: string | null; runs: { id: number; ran_at: string; trades: number; net_pnl: number; passed: number }[] }
interface Run {
  run_id: number; passed: boolean; data: { from: string; to: string; sessions: number; proxy: string; holdout: string }
  checks: { gate: string; value: number | null; threshold: string; passed: boolean }[]
  summary: { trades: number; net_pnl: number; expectancy: number | null; win_rate: number | null; avg_r: number | null; commission: number; slippage: number; net_without_best_days: number; best_days_removed: string[]; net_at_slippage_multiple: number }
  deflated_sharpe: { market: number | null; global: number | null; stricter: number | null; trials_market: number; trials_global: number }
  equity: { t: string; v: number }[]; equity_without_best_days: { t: string; v: number }[]
  trades: { session: string; side: string; entry_ts: string; entry: number; stop: number; exit_ts: string; exit: number; exit_reason: string; r: number; commission: number; net: number }[]
}

const BLANK_SPEC: Spec = {
  or_minutes: 15, entry: 'or_breakout', direction: 'both', stop: { kind: 'or_opposite', value: null }, exit: { kind: 'session_close', value: null },
  filters: { weekdays: null, gap_min_bps: null, gap_max_bps: null, prior_range_min_bps: null, prior_range_max_bps: null },
  contracts: 1, commission_per_side: 0.62, slippage_ticks: 1,
}
const DEFAULT_GATES: Gates = { min_net_expectancy: 0, max_bootstrap_p: 0.05, drop_best_days: 5, slippage_multiple: 2 }

export function describeSpec(s: Spec) {
  const entry = s.entry === 'or_breakout' ? `close beyond the ${s.or_minutes}-min opening range` : `first bar's direction, after the ${s.or_minutes}-min opening range`
  const stop = s.stop.kind === 'or_opposite' ? 'opposite end of the opening range' : s.stop.kind === 'ticks' ? `${s.stop.value} ticks` : `${s.stop.value} × ATR(14 days)`
  const exit = s.exit.kind === 'session_close' ? 'session close' : s.exit.kind === 'target_r' ? `${s.exit.value}R target, else session close` : `${s.exit.value} New York, else session close`
  const f = s.filters
  const filters = [f.weekdays && `days: ${f.weekdays.map((d) => WD[d]).join(', ')}`, (f.gap_min_bps != null || f.gap_max_bps != null) && `gap ${f.gap_min_bps ?? 0}–${f.gap_max_bps ?? '∞'} bps`,
    (f.prior_range_min_bps != null || f.prior_range_max_bps != null) && `prior range ${f.prior_range_min_bps ?? 0}–${f.prior_range_max_bps ?? '∞'} bps`].filter(Boolean)
  return [['Entry', `${entry} (${s.direction === 'both' ? 'long or short' : `${s.direction} only`}), filled at the next bar's open`],
    ['Stop', stop], ['Exit', exit], ['Filters', filters.length ? filters.join(' · ') : 'none'],
    ['Size & costs', `1 MNQ · $${s.commission_per_side.toFixed(2)}/side commission · ${s.slippage_ticks} tick(s)/side slippage`]] as [string, string][]
}

export function ExperimentsTab() {
  const list = useApi<{ experiments: Exp[]; trials: { global: number; mnq: number } }>('/intraday/experiments')
  const [sel, setSel] = useState<number | 'new' | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const exps = list.data?.experiments ?? []
  const cur = typeof sel === 'number' ? exps.find((e) => e.id === sel) : null
  const openRun = useAction(async (rid: number) => setRun(await api.get<Run>(`/intraday/runs/${rid}`)))

  return (
    <div className="space-y-5">
      {list.data && (
        <Notice tone="am" title={`You have tested ${list.data.trials.global} ideas. Results get stricter as N grows.`}>
          {list.data.trials.mnq} of them on MNQ (intraday). Every run is recorded and raises the bar a result must clear to be more than luck (deflated Sharpe, per market and across all markets).
        </Notice>
      )}
      <ErrorBox error={list.error || openRun.error} onRetry={list.reload} />
      <div className="grid grid-cols-12 gap-5">
        <Panel className="col-span-12 lg:col-span-4" title="Experiments" right={<Button small tone="primary" onClick={() => { setSel('new'); setRun(null) }}>New</Button>}>
          {!list.data ? <Loading /> : exps.length === 0 ? <EmptyState title="No experiments yet" /> : (
            <ul className="-mx-1 space-y-1">
              {exps.map((e) => (
                <li key={e.id}>
                  <button onClick={() => { setSel(e.id); setRun(null) }} aria-current={sel === e.id}
                    className={`flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left ${sel === e.id ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}>
                    <span className="flex-1 truncate text-[13.5px] font-medium text-white">{e.name}</span>
                    {e.runs[0] && <StatusDot tone={e.runs[0].passed ? 'up' : 'dn'} label={e.runs[0].passed ? 'passed' : 'failed'} />}
                    <Badge tone={e.status === 'registered' ? 'cy' : 'mute'}>{e.status === 'registered' ? (e.runs.length ? `${e.runs.length} run${e.runs.length > 1 ? 's' : ''}` : 'Registered') : 'Draft'}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div className="col-span-12 space-y-5 lg:col-span-8">
          {sel === 'new' && <Builder onSaved={(id) => { list.reload(); setSel(id) }} />}
          {cur && cur.status === 'draft' && <Builder key={cur.id} draft={cur} onSaved={(id) => { list.reload(); setSel(id) }} />}
          {cur && cur.status === 'registered' && <Registered e={cur} onRan={(r) => { setRun(r); list.reload() }} onOpenRun={(rid) => openRun.run(rid)} />}
          {!sel && <Panel><EmptyState title="Pick an experiment or create a new one">Draft → Register (locks it) → Run. Runs use only the open data; the sealed holdout is never read here.</EmptyState></Panel>}
        </div>
      </div>
      {run && <Results r={run} />}
    </div>
  )
}

function numOrNull(v: string) { return v === '' ? null : +v }

function Builder({ draft, onSaved }: { draft?: Exp; onSaved: (id: number) => void }) {
  const [name, setName] = useState(draft?.name ?? '')
  const [why, setWhy] = useState(draft?.rationale ?? '')
  const [s, setS] = useState<Spec>(draft?.spec ?? BLANK_SPEC)
  const [g, setG] = useState<Gates>(draft?.gates ?? DEFAULT_GATES)
  const [confirm, setConfirm] = useState(false)
  const save = useAction(async () => {
    const body = { name, rationale: why, spec: s, gates: g }
    const e = draft ? await api.put<Exp>(`/intraday/experiments/${draft.id}`, body) : await api.post<Exp>('/intraday/experiments', body)
    onSaved(e.id)
    return e
  })
  const register = useAction(async () => {
    const e = await save.run()
    if (!e) return
    await api.post(`/intraday/experiments/${e.id}/register`)
    setConfirm(false)
    onSaved(e.id)
  })
  const del = useAction(async () => { await api.del(`/intraday/experiments/${draft!.id}`); location.reload() })
  const f = s.filters
  const setF = (p: Partial<Spec['filters']>) => setS({ ...s, filters: { ...f, ...p } })
  return (
    <Panel title={draft ? `Draft: ${draft.name}` : 'New experiment'} subtitle="Built from fixed blocks. Nothing runs until you register it, and registering locks it for good.">
      <ErrorBox error={save.error || register.error || del.error} />
      <div className="space-y-5">
        <div className="grid gap-3 md:grid-cols-[200px_1fr]">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ORB-2" /></Field>
          <Field label="Why this should work (one sentence)"><input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="The economic reason, written before you see any result" /></Field>
        </div>
        <fieldset className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <legend className="mb-2 text-[13px] font-medium text-ink-200">Opening range and entry</legend>
          <Field label="Opening range (min)"><input type="number" min={1} max={60} value={s.or_minutes} onChange={(e) => setS({ ...s, or_minutes: Math.min(60, Math.max(1, Math.round(+e.target.value))) })} /></Field>
          <Field label="Entry"><select value={s.entry} onChange={(e) => setS({ ...s, entry: e.target.value as Spec['entry'] })}><option value="or_breakout">Breakout of OR high/low</option><option value="first_bar_direction">First bar's direction</option></select></Field>
          <Field label="Direction"><select value={s.direction} onChange={(e) => setS({ ...s, direction: e.target.value as Spec['direction'] })}><option value="both">Long and short</option><option value="long">Long only</option><option value="short">Short only</option></select></Field>
        </fieldset>
        <fieldset className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <legend className="mb-2 text-[13px] font-medium text-ink-200">Stop and exit</legend>
          <Field label="Stop"><select value={s.stop.kind} onChange={(e) => setS({ ...s, stop: { kind: e.target.value as Spec['stop']['kind'], value: e.target.value === 'or_opposite' ? null : s.stop.value ?? (e.target.value === 'ticks' ? 40 : 1) } })}><option value="or_opposite">Opposite end of OR</option><option value="ticks">N ticks</option><option value="atr">N × ATR</option></select></Field>
          {s.stop.kind !== 'or_opposite' && <Field label={s.stop.kind === 'ticks' ? 'Ticks' : 'ATR multiple'}><input inputMode="decimal" value={s.stop.value ?? ''} onChange={(e) => setS({ ...s, stop: { ...s.stop, value: numOrNull(e.target.value) } })} /></Field>}
          <Field label="Exit"><select value={s.exit.kind} onChange={(e) => setS({ ...s, exit: { kind: e.target.value as Spec['exit']['kind'], value: e.target.value === 'target_r' ? 2 : e.target.value === 'clock' ? '11:00' : null } })}><option value="session_close">Session close</option><option value="target_r">Target in R</option><option value="clock">Clock time</option></select></Field>
          {s.exit.kind === 'target_r' && <Field label="Target (R)"><input inputMode="decimal" value={s.exit.value ?? ''} onChange={(e) => setS({ ...s, exit: { ...s.exit, value: numOrNull(e.target.value) } })} /></Field>}
          {s.exit.kind === 'clock' && <Field label="Exit at (New York)"><input type="time" value={String(s.exit.value ?? '')} onChange={(e) => setS({ ...s, exit: { ...s.exit, value: e.target.value } })} /></Field>}
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-ink-200">Filters (optional)</legend>
          <div className="mb-3 flex flex-wrap gap-3 text-[13px]">
            {WD.map((d, i) => (
              <label key={d} className="flex items-center gap-1.5 text-ink-100">
                <input type="checkbox" checked={!f.weekdays || f.weekdays.includes(i)} onChange={(e) => {
                  const cur = f.weekdays ?? [0, 1, 2, 3, 4]
                  const next = e.target.checked ? [...cur, i].sort() : cur.filter((x) => x !== i)
                  setF({ weekdays: next.length === 5 ? null : next })
                }} />{d}
              </label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="Gap min (bps)"><input inputMode="decimal" value={f.gap_min_bps ?? ''} onChange={(e) => setF({ gap_min_bps: numOrNull(e.target.value) })} /></Field>
            <Field label="Gap max (bps)"><input inputMode="decimal" value={f.gap_max_bps ?? ''} onChange={(e) => setF({ gap_max_bps: numOrNull(e.target.value) })} /></Field>
            <Field label="Prior-day range min (bps)"><input inputMode="decimal" value={f.prior_range_min_bps ?? ''} onChange={(e) => setF({ prior_range_min_bps: numOrNull(e.target.value) })} /></Field>
            <Field label="Prior-day range max (bps)"><input inputMode="decimal" value={f.prior_range_max_bps ?? ''} onChange={(e) => setF({ prior_range_max_bps: numOrNull(e.target.value) })} /></Field>
          </div>
        </fieldset>
        <fieldset className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <legend className="mb-2 text-[13px] font-medium text-ink-200">Costs (1 MNQ)</legend>
          <Field label="Commission $/side"><input inputMode="decimal" value={s.commission_per_side} onChange={(e) => setS({ ...s, commission_per_side: +e.target.value || 0 })} /></Field>
          <Field label="Slippage ticks/side"><input inputMode="decimal" value={s.slippage_ticks} onChange={(e) => setS({ ...s, slippage_ticks: +e.target.value || 0 })} /></Field>
        </fieldset>
        <fieldset className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <legend className="mb-2 text-[13px] font-medium text-ink-200">Pass/fail gates (fixed at registration)</legend>
          <Field label="Net expectancy > $"><input inputMode="decimal" value={g.min_net_expectancy} onChange={(e) => setG({ ...g, min_net_expectancy: +e.target.value || 0 })} /></Field>
          <Field label="Bootstrap p <"><input inputMode="decimal" value={g.max_bootstrap_p} onChange={(e) => setG({ ...g, max_bootstrap_p: +e.target.value })} /></Field>
          <Field label="Positive without N best days"><input type="number" min={0} value={g.drop_best_days} onChange={(e) => setG({ ...g, drop_best_days: Math.max(0, Math.round(+e.target.value)) })} /></Field>
          <Field label="Positive at × slippage"><input inputMode="decimal" value={g.slippage_multiple} onChange={(e) => setG({ ...g, slippage_multiple: +e.target.value || 1 })} /></Field>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => save.run()} disabled={save.pending}>Save draft</Button>
          <Button tone="primary" onClick={() => setConfirm(true)} disabled={!name || why.length < 10}>Register…</Button>
          {draft && <Button tone="ghost" onClick={() => del.run()}>Delete draft</Button>}
        </div>
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Register ${name}?`}
        actions={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button tone="primary" onClick={() => register.run()} disabled={register.pending}>Register and lock</Button></>}>
        The spec and gates are locked permanently. Any change after this means a new experiment, and each run counts as another tested idea.
      </Dialog>
    </Panel>
  )
}

function Registered({ e, onRan, onOpenRun }: { e: Exp; onRan: (r: Run) => void; onOpenRun: (rid: number) => void }) {
  const [confirm, setConfirm] = useState(false)
  const run = useAction(async () => { const r = await api.post<Run>(`/intraday/experiments/${e.id}/run`); setConfirm(false); onRan(r) })
  const g = e.gates
  return (
    <Panel title={e.name} tag={<Badge tone="cy">Registered · locked</Badge>} subtitle={`“${e.rationale}”`}
      right={<Button tone="primary" onClick={() => setConfirm(true)} disabled={run.pending}>{run.pending ? 'Running…' : 'Run (in-sample)'}</Button>}>
      <ErrorBox error={run.error} />
      <KeyValue rows={[...describeSpec(e.spec),
        ['Gates', `expectancy > ${money(g.min_net_expectancy)} · bootstrap p < ${g.max_bootstrap_p} · positive without ${g.drop_best_days} best days · positive at ${g.slippage_multiple}× slippage`],
        ['Registered', `${e.registered_at?.slice(0, 16).replace('T', ' ')} UTC · ${e.spec_hash?.slice(0, 12)}`]]} />
      {e.runs.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] font-medium text-ink-200">Runs</div>
          <ul className="space-y-1 text-[13px]">
            {e.runs.map((r) => (
              <li key={r.id}><button className="flex w-full items-center gap-3 rounded-[8px] px-2 py-1.5 text-left hover:bg-white/[0.04]" onClick={() => onOpenRun(r.id)}>
                <StatusDot tone={r.passed ? 'up' : 'dn'} /><span className="text-ink-100">{r.ran_at.slice(0, 16).replace('T', ' ')} UTC</span>
                <span className="text-ink-300">{r.trades} trades · {money(r.net_pnl)} · {r.passed ? 'passed all gates' : 'failed'}</span><span className="ml-auto text-cy">Open →</span>
              </button></li>
            ))}
          </ul>
        </div>
      )}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Run ${e.name}?`}
        actions={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button tone="primary" onClick={() => run.run()} disabled={run.pending}>Run</Button></>}>
        Uses only the open data (the sealed holdout stays sealed). This run is recorded as a tested idea and raises the bar for every future result.
      </Dialog>
    </Panel>
  )
}

function Results({ r }: { r: Run }) {
  const series = useMemo<TSeries[]>(() => [
    { kind: 'line', id: 'eq', label: 'Equity (paper, $50,000 start)', color: 'var(--brand)', data: r.equity.map((x) => ({ time: x.t, value: x.v })), width: 2 },
    { kind: 'line', id: 'eq5', label: `Without the ${r.summary.best_days_removed.length} best days`, color: 'var(--text-3)', data: r.equity_without_best_days.map((x) => ({ time: x.t, value: x.v })), width: 1, dashed: true },
  ], [r])
  const fmt = useMemo(() => (v: number) => `$${v.toFixed(0)}`, [])
  const s = r.summary, d = r.deflated_sharpe
  return (
    <div className="space-y-5">
      <Panel title={`Result: ${r.passed ? 'passed every gate' : 'did not pass'}`} tag={<Badge tone={r.passed ? 'up' : 'dn'}>{r.passed ? 'Passed' : 'Failed'}</Badge>}
        subtitle={`In-sample, ${r.data.from} to ${r.data.to}, ${r.data.sessions} sessions · ${r.data.proxy} · holdout ${r.data.holdout}. Historical simulation, not a prediction.`}>
        <table className="data">
          <thead><tr><th>Gate</th><th className="text-right">Result</th><th>Needs</th><th>Outcome</th></tr></thead>
          <tbody>{r.checks.map((c) => (
            <tr key={c.gate}><td>{c.gate}</td><td className="num text-right">{c.value == null ? '—' : c.gate.startsWith('Bootstrap') ? num(c.value, 4) : money(c.value)}</td><td>{c.threshold}</td>
              <td><span className="inline-flex items-center gap-1.5"><StatusDot tone={c.passed ? 'up' : 'dn'} />{c.passed ? 'Pass' : 'Fail'}</span></td></tr>
          ))}</tbody>
        </table>
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-300">
          Deflated Sharpe (probability the result beats the best of the tested ideas by luck): {d.stricter == null ? 'not enough data' : num(d.stricter, 3)} (stricter of per-market {d.market == null ? '—' : num(d.market, 3)} over {d.trials_market} MNQ trials and global {d.global == null ? '—' : num(d.global, 3)} over {d.trials_global}).
        </p>
      </Panel>
      <Panel title="Equity curve" subtitle="Daily net P&L after commission and slippage, starting from $50,000 (paper).">
        <TimeChart series={series} height={300} format={fmt} />
      </Panel>
      <div className="grid grid-cols-12 gap-5">
        <Panel className="col-span-12 lg:col-span-4" title="Summary">
          <KeyValue rows={[['Trades', s.trades], ['Net P&L', money(s.net_pnl)], ['Expectancy / trade', money(s.expectancy)], ['Win rate', s.win_rate == null ? '—' : `${(s.win_rate * 100).toFixed(1)}%`],
            ['Average R', s.avg_r == null ? '—' : num(s.avg_r, 2)], ['Commission paid', money(s.commission)], ['Slippage paid', money(s.slippage)],
            [`Without ${s.best_days_removed.length} best days`, money(s.net_without_best_days)], ['At higher slippage', money(s.net_at_slippage_multiple)]]} />
          <p className="mt-2 text-[12px] text-ink-300">Best days removed: {s.best_days_removed.join(', ') || '—'}</p>
        </Panel>
        <Panel className="col-span-12 lg:col-span-8" title={`Trades (${r.trades.length})`}>
          <div className="scroll-thin max-h-[420px] overflow-auto">
            <table className="data min-w-[680px]">
              <thead><tr><th>Day</th><th>Side</th><th>Entry</th><th>Stop</th><th>Exit</th><th>Why</th><th className="text-right">R</th><th className="text-right">Net</th></tr></thead>
              <tbody>{r.trades.map((t, i) => (
                <tr key={i}><td>{t.session}</td><td>{t.side}</td><td>{t.entry_ts.slice(11, 16)} @ {num(t.entry, 2)}</td><td>{num(t.stop, 2)}</td>
                  <td>{t.exit_ts.slice(11, 16)} @ {num(t.exit, 2)}</td><td>{t.exit_reason.replace('_', ' ')}</td><td className="num text-right">{num(t.r, 2)}</td>
                  <td className={`num text-right ${t.net > 0 ? 'text-up' : t.net < 0 ? 'text-dn' : ''}`}>{t.net > 0 ? '+' : ''}{money(t.net)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  )
}
