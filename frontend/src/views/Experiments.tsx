import { useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { Histogram, Scatter } from '../components/charts/Svg'
import { TimeChart, toLine } from '../components/charts/TimeChart'
import { Badge, Button, DN, Empty, ErrorBox, HistTag, Legend, NEUTRAL, Panel, SERIES, Segmented, Stat, UP } from '../components/ui'
import { api, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { ago, num, pct, strategyLabel, tone } from '../lib/format'
import type { CriticCheck, Experiment } from '../lib/types'

export function ExperimentsView(_: ViewProps) {
  const [kind, setKind] = useState<'hypothesis_test' | 'manual_backtest'>('hypothesis_test')
  const [verdict, setVerdict] = useState<'all' | 'accepted' | 'rejected'>('all')
  const list = useApi<Experiment[]>(`/experiments?kind=${kind}${verdict !== 'all' && kind === 'hypothesis_test' ? `&verdict=${verdict}` : ''}&limit=1000`, { deps: [kind, verdict] })
  const dist = useApi<{ points: any[]; critic_rules: Record<string, number> }>('/experiments-stats/distribution')
  const [sel, setSel] = useState<number | null>(null)
  useEventTrigger((e) => e.category === 'research', () => { list.reload(); dist.reload() }, 1500)

  const pts = useMemo(() => (dist.data?.points ?? []).filter((p) => p.is_sharpe !== null && p.oos_sharpe !== null).map((p) => ({
    id: p.id, x: p.is_sharpe, y: p.oos_sharpe, group: p.verdict, color: p.verdict === 'accepted' ? UP : DN,
    label: `#${p.id} ${strategyLabel(p.strategy)} ${p.symbol} · ${p.verdict}`,
  })), [dist.data])
  const oos = (dist.data?.points ?? []).map((p) => p.oos_sharpe).filter((x): x is number => x !== null)
  const acc = (dist.data?.points ?? []).filter((p) => p.verdict === 'accepted').length

  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12 lg:col-span-7" title="In-sample vs out-of-sample Sharpe" tag={<Badge>{pts.length} experiments</Badge>}
        right={<Legend items={[{ label: `accepted (${acc})`, color: UP }, { label: `rejected (${pts.length - acc})`, color: DN }, { label: 'IS = OOS', color: NEUTRAL, dashed: true }]} />}>
        {pts.length ? <Scatter points={pts} xLabel="in-sample Sharpe (train+validation)" yLabel="out-of-sample Sharpe (test)" diagonal refY={dist.data?.critic_rules.min_test_sharpe} onPick={(id) => setSel(Number(id))} height={300} /> : <Empty>No hypothesis tests yet.</Empty>}
        <p className="mt-1 text-[10.5px] text-ink-300">Points far below the diagonal decayed out-of-sample (overfitting). Amber line = critic's minimum OOS Sharpe. Click a point to inspect.</p>
      </Panel>
      <Panel className="col-span-12 lg:col-span-5" title="Distribution of out-of-sample Sharpe" tag={<HistTag />}>
        {oos.length ? <Histogram values={oos} color={SERIES[0]} xLabel="test-period Sharpe ratio" refLine={0} height={250} /> : <Empty>—</Empty>}
        <p className="mt-1 text-[10.5px] text-ink-300">With many trials, the best result is expected to look good by chance alone — which is why acceptance uses the deflated Sharpe ratio with the cumulative trial count.</p>
      </Panel>

      <Panel className="col-span-12 xl:col-span-6" title="Experiment registry" bodyClass="p-0"
        right={<div className="flex gap-2">
          <Segmented value={kind} onChange={(v) => { setKind(v); setSel(null) }} options={[{ value: 'hypothesis_test', label: 'agent' }, { value: 'manual_backtest', label: 'manual' }]} />
          {kind === 'hypothesis_test' && <Segmented value={verdict} onChange={setVerdict} options={[{ value: 'all', label: 'all' }, { value: 'accepted', label: 'accepted' }, { value: 'rejected', label: 'rejected' }]} />}
        </div>}>
        <div className="scroll-thin max-h-[620px] overflow-auto">
          <table className="data">
            <thead><tr><th>#</th><th>when</th><th>strategy</th><th>symbol</th><th>verdict</th><th>OOS SR</th><th>OOS ret</th><th>DSR</th><th>data ver.</th></tr></thead>
            <tbody>{list.data?.map((e) => (
              <tr key={e.id} onClick={() => setSel(e.id)} className={`cursor-pointer ${sel === e.id ? 'bg-cy/10' : ''}`}>
                <td className="text-ink-300">{e.id}</td><td>{ago(e.created_at)}</td><td>{strategyLabel(e.strategy)}</td><td>{e.symbol}</td>
                <td className={e.verdict === 'accepted' ? 'text-up' : e.verdict === 'rejected' ? 'text-dn' : 'text-ink-300'}>{e.verdict ?? 'manual'}</td>
                <td className={tone(e.metrics?.test?.sharpe)}>{num(e.metrics?.test?.sharpe)}</td>
                <td className={tone(e.metrics?.test?.total_return)}>{pct(e.metrics?.test?.total_return)}</td>
                <td>{num(e.metrics?.dsr_test)}</td><td className="text-ink-300">{e.dataset_version}</td>
              </tr>
            ))}</tbody>
          </table>
          {!list.data?.length && <Empty>No experiments of this kind yet.</Empty>}
        </div>
      </Panel>
      <div className="col-span-12 xl:col-span-6">
        {sel ? <Detail id={sel} /> : <Panel title="Experiment detail"><Empty>Select an experiment to see its hypothesis, critic checks, risk analysis, equity curve and reproducibility record.</Empty></Panel>}
      </div>
    </div>
  )
}

function Detail({ id }: { id: number }) {
  const e = useApi<Experiment>(`/experiments/${id}`, { deps: [id] })
  const [repro, setRepro] = useState<any>(null)
  const [deployMsg, setDeployMsg] = useState<string | null>(null)
  const reproduce = useAction(async () => setRepro(await api.post(`/experiments/${id}/reproduce`)))
  const deploy = useAction(async () => {
    const r = await api.post<{ id: number }>('/paper/strategies', { experiment_id: id, allocation: 0.1 })
    setDeployMsg(`Deployed to PAPER portfolio as strategy #${r.id} (10% allocation).`)
  })
  const x = e.data
  const bt = x?.artifacts?.test_backtest
  const series = useMemo(() => bt ? [
    { kind: 'line' as const, id: 'eq', label: 'Strategy (test window)', color: SERIES[0], data: toLine(bt.series.equity) },
    { kind: 'line' as const, id: 'bm', label: 'Buy & hold', color: NEUTRAL, data: toLine(bt.series.benchmark), dashed: true, width: 1 },
  ] : [], [bt])
  const fmtMoney = useMemo(() => (v: number) => `$${Math.round(v).toLocaleString()}`, [])
  if (!x) return <Panel title={`Experiment #${id}`}><Empty>{e.error ?? 'loading…'}</Empty></Panel>
  const m = x.metrics ?? {}
  const checks: CriticCheck[] = x.artifacts?.critic?.checks ?? []
  const risk = x.artifacts?.risk
  return (
    <Panel title={`Experiment #${id} · ${strategyLabel(x.strategy)} · ${x.symbol}`} tag={x.verdict ? <Badge tone={x.verdict === 'accepted' ? 'up' : 'dn'}>{x.verdict}</Badge> : <Badge>manual</Badge>}
      right={<div className="flex gap-1.5"><Button small onClick={() => reproduce.run()} disabled={reproduce.pending}>↺ reproduce</Button><Button small tone="primary" onClick={() => deploy.run()} disabled={deploy.pending}>deploy to paper</Button></div>}>
      <div className="space-y-3">
        <ErrorBox error={reproduce.error || deploy.error} />
        {deployMsg && <div className="font-mono text-[11px] text-am">{deployMsg}</div>}
        {repro && (
          <div className={`rounded border px-3 py-2 font-mono text-[11px] ${repro.match ? 'border-up/40 text-up' : 'border-am/40 text-am'}`}>
            {repro.match ? '✓ Reproduced exactly' : '⚠ Mismatch'} from dataset snapshot {repro.dataset_version} · code then {repro.code_version_then} / now {repro.code_version_now}
            {repro.note && <div className="text-ink-300">{repro.note}</div>}
          </div>
        )}
        {x.hypothesis && <p className="border-l-2 border-vi/50 pl-2 text-[12px] text-ink-100">{x.hypothesis.rationale} <span className="text-ink-300">({x.hypothesis.origin})</span></p>}
        <div className="flex flex-wrap gap-1">{Object.entries(x.params ?? {}).map(([k, v]) => <Badge key={k}>{k}={String(v)}</Badge>)}</div>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          <Stat label="train SR" value={num(m.train?.sharpe)} />
          <Stat label="valid. SR" value={num(m.validation?.sharpe ?? null)} />
          <Stat label="test SR" value={num(m.test?.sharpe)} valueClass={tone(m.test?.sharpe)} />
          <Stat label="test return" value={pct(m.test?.total_return)} valueClass={tone(m.test?.total_return)} sub={`B&H ${pct(m.benchmark_test?.total_return)}`} />
          <Stat label="DSR" value={num(m.dsr_test)} sub={m.n_trials ? `${m.n_trials} trials` : ''} />
          <Stat label="max DD" value={pct(m.test?.max_drawdown)} valueClass="text-dn" />
        </div>
        {bt && <><Legend items={[{ label: 'Strategy (test window)', color: SERIES[0] }, { label: 'Buy & hold', color: NEUTRAL, dashed: true }]} /><TimeChart series={series} height={200} format={fmtMoney} /></>}
        {checks.length > 0 && (
          <div>
            <div className="label mb-1">research critic</div>
            <div className="grid gap-1 sm:grid-cols-2">
              {checks.map((c) => (
                <div key={c.name} className="rounded border border-ink-700 px-2 py-1" title={c.explanation}>
                  <div className="flex items-center justify-between font-mono text-[10.5px]">
                    <span><span className={c.passed ? 'text-up' : c.blocking ? 'text-dn' : 'text-am'}>{c.passed ? '✓' : '✕'}</span> <span className="text-white">{c.name.replace(/_/g, ' ')}</span>{!c.blocking && <span className="text-ink-300"> (advisory)</span>}</span>
                    <span className="text-ink-200">{typeof c.value === 'number' ? num(c.value, 3) : String(c.value ?? '—')}</span>
                  </div>
                  <div className="font-mono text-[9.5px] text-ink-300">{c.threshold}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {risk?.failure_scenarios?.length > 0 && (
          <div>
            <div className="label mb-1">failure scenarios (risk analyst)</div>
            <ul className="space-y-0.5 text-[11.5px] text-ink-100">{risk.failure_scenarios.map((s: string) => <li key={s}>⚠ {s}</li>)}</ul>
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-4 font-mono text-[10.5px] text-ink-300">
          <span>dataset version</span><span className="text-ink-100">{x.dataset_version}</span>
          <span>code version</span><span className="text-ink-100">{x.code_version}</span>
          <span>cycle / job</span><span className="text-ink-100">{x.cycle_id ?? '—'} / {x.job_id ?? '—'}</span>
          <span>splits</span><span className="text-ink-100">{x.config?.splits ? Object.entries(x.config.splits as Record<string, string[]>).map(([k, v]) => `${k} ${v[0]}→${v[1]}`).join(' · ') : '—'}</span>
        </div>
      </div>
    </Panel>
  )
}
