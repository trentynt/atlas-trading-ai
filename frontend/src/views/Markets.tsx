import { useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { TimeChart, type TSeries } from '../components/charts/TimeChart'
import { Heatmap, SignedBars } from '../components/charts/Svg'
import { Badge, Button, Empty, ErrorBox, LiveTag, Panel, SERIES, Segmented, Stat } from '../components/ui'
import { api, slug, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { num, pct, price, tone } from '../lib/format'
import type { Bar, Market } from '../lib/types'

const smaLine = (bars: Bar[], n: number) => {
  const out: { time: string; value: number }[] = []
  let s = 0
  bars.forEach((b, i) => {
    s += b.c
    if (i >= n) s -= bars[i - n].c
    if (i >= n - 1) out.push({ time: b.t, value: s / n })
  })
  return out
}

const REGIME_COLOR: Record<string, string> = { trend_up: '#34d399', trend_down: '#f87171', range: '#5f7491' }

export function MarketsView(_: ViewProps) {
  const markets = useApi<Market[]>('/markets', { poll: 60000 })
  const [sym, setSym] = useState('EUR/USD')
  const [tf, setTf] = useState<'1d' | '1w'>('1d')
  const bars = useApi<{ bars: Bar[]; dataset: any }>(`/markets/${slug(sym)}/bars?timeframe=${tf}&limit=1500`, { deps: [sym, tf] })
  const quality = useApi<any>(`/markets/${slug(sym)}/quality`, { deps: [sym] })
  const regime = useApi<any>(`/markets/${slug(sym)}/regime`, { deps: [sym] })
  const feats = useApi<any>(`/markets/${slug(sym)}/features?horizon=5`, { deps: [sym] })
  const corr = useApi<{ symbols: string[]; matrix: (number | null)[][] }>('/markets/correlations?window=90')
  const refresh = useAction(async () => { await api.post('/markets/refresh', { symbols: [sym] }) })
  useEventTrigger((e) => e.category === 'data' && /bars/.test(e.message), () => { markets.reload(); bars.reload(); quality.reload() }, 1500)

  const m = markets.data?.find((x) => x.symbol === sym)
  const series = useMemo<TSeries[]>(() => {
    const b = bars.data?.bars ?? []
    if (!b.length) return []
    const ohlc = b.every((x) => x.o !== null)
    const s: TSeries[] = ohlc
      ? [{ kind: 'candle', id: 'px', label: sym, data: b.map((x) => ({ time: x.t, open: x.o!, high: x.h!, low: x.l!, close: x.c })) }]
      : [{ kind: 'line', id: 'px', label: `${sym} (reference fix)`, color: '#e6edf7', data: b.map((x) => ({ time: x.t, value: x.c })), width: 1 }]
    s.push({ kind: 'line', id: 'ma50', label: 'SMA 50', color: SERIES[0], data: smaLine(b, 50), width: 1 })
    s.push({ kind: 'line', id: 'ma200', label: 'SMA 200', color: SERIES[1], data: smaLine(b, 200), width: 1 })
    if (b.every((x) => x.v !== null)) s.push({ kind: 'histogram', id: 'vol', label: 'Volume', color: 'rgba(95,116,145,0.45)', data: b.map((x) => ({ time: x.t, value: x.v! })) })
    return s
  }, [bars.data, sym])
  const dec = m?.price_decimals ?? 4
  const fmt = useMemo(() => (v: number) => v.toFixed(dec), [dec])
  const q = quality.data?.quality

  return (
    <div className="grid grid-cols-12 gap-3">
      <div className="col-span-12 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {markets.data?.map((x) => (
          <button key={x.symbol} onClick={() => setSym(x.symbol)}
            className={`panel px-3 py-2.5 text-left transition-colors ${sym === x.symbol ? 'border-cy/60 bg-cy/[0.04]' : 'hover:border-ink-400'}`}>
            <div className="flex items-center justify-between"><span className="font-mono text-[12px] text-white">{x.symbol}</span><Badge tone={x.asset_class === 'fx' ? 'bl' : 'vi'}>{x.asset_class}</Badge></div>
            <div className="num mt-1 text-[17px] text-white">{price(x.last_close, x.price_decimals)}</div>
            <div className="flex justify-between font-mono text-[10px]"><span className={tone(x.change_1d)}>{pct(x.change_1d)}</span><span className="text-ink-300">{x.rows} bars</span></div>
          </button>
        ))}
      </div>

      <Panel className="col-span-12 xl:col-span-8" kicker={sym} title="Price history" tag={<LiveTag what={`REAL · ${m?.provider ?? ''}`} />}
        right={<><Segmented value={tf} onChange={setTf} options={[{ value: '1d', label: 'Daily' }, { value: '1w', label: 'Weekly' }]} /><Button small onClick={() => refresh.run()} disabled={refresh.pending}>↻ refresh</Button></>}>
        <ErrorBox error={bars.error || refresh.error} />
        {series.length ? <TimeChart series={series} height={420} format={fmt} /> : <Empty>No bars yet — data ingestion may still be running.</Empty>}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-300">
          <span>{m?.attribution}</span>
          <span className="font-mono">{m?.provider_notes}</span>
        </div>
      </Panel>

      <div className="col-span-12 flex flex-col gap-3 xl:col-span-4">
        <Panel title="Dataset integrity" tag={<Badge>{quality.data?.version ?? '—'}</Badge>}>
          {q ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="rows" value={q.rows} sub={`${q.start} → ${q.end}`} />
                <Stat label="completeness" value={pct(q.completeness, 1, false)} sub={`${q.missing_periods} missing`} />
                <Stat label="staleness" value={`${num(q.stale_days, 1)}d`} sub={m?.is_stale ? 'STALE' : 'fresh'} valueClass={m?.is_stale ? 'text-am' : ''} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone={q.has_ohlc ? 'up' : 'am'}>{q.has_ohlc ? 'OHLC' : 'close only'}</Badge>
                <Badge tone={q.has_volume ? 'up' : 'am'}>{q.has_volume ? 'volume' : 'no volume'}</Badge>
                <Badge>{q.gap_count} gaps</Badge><Badge>{q.outliers?.length ?? 0} outliers (|z|&gt;10)</Badge>
                <Badge>dupes dropped {q.normalization?.duplicates_dropped ?? 0}</Badge>
              </div>
              <p className="text-[11px] text-ink-300">{q.calendar_note}</p>
              <div className="scroll-thin max-h-[120px] overflow-auto">
                <table className="data"><thead><tr><th>version</th><th>provider</th><th>rows</th><th>end</th></tr></thead>
                  <tbody>{quality.data.versions.map((v: any) => <tr key={v.version + v.created_at}><td>{v.version}</td><td>{v.provider}</td><td>{v.rows}</td><td>{v.end_ts}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          ) : <Empty>{quality.error ?? 'loading…'}</Empty>}
        </Panel>
        <Panel title="Regime" tag={<Badge tone="cy">causal classifier</Badge>}>
          {regime.data?.current ? (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="trend" value={regime.data.current.trend.replace('_', ' ')} valueClass="text-[14px]" sub={`since ${regime.data.current.since}`} />
                <Stat label="volatility" value={regime.data.current.vol.replace('_', ' ')} valueClass="text-[14px]" sub={`ann. ${pct(regime.data.current.ann_vol, 1, false)}`} />
                <Stat label="efficiency" value={num(regime.data.current.efficiency)} sub="Kaufman ER(30)" />
              </div>
              <div className="label pt-1">regime timeline (recent segments)</div>
              <div className="flex h-4 w-full overflow-hidden rounded">
                {regime.data.segments.slice(-60).map((s: any, i: number) => (
                  <div key={i} title={`${s.start} → ${s.end}: ${s.trend} / ${s.vol} (${s.bars} bars)`} style={{ flexGrow: s.bars, background: REGIME_COLOR[s.trend], opacity: s.vol === 'high_vol' ? 1 : s.vol === 'low_vol' ? 0.45 : 0.7 }} className="border-r border-ink-950" />
                ))}
              </div>
              <div className="flex gap-3 font-mono text-[10px] text-ink-300">
                {Object.entries(REGIME_COLOR).map(([k, c]) => <span key={k} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: c }} />{k.replace('_', ' ')}</span>)}
                <span>opacity = vol level</span>
              </div>
            </div>
          ) : <Empty>{regime.error ?? 'loading…'}</Empty>}
        </Panel>
      </div>

      <Panel className="col-span-12 lg:col-span-7" title="Feature importance" tag={<Badge tone="vi">rank IC vs 5-bar forward return</Badge>}>
        {feats.data?.features?.length ? (
          <>
            <SignedBars posColor={SERIES[0]} negColor={SERIES[3]}
              rows={feats.data.features.map((f: any) => ({ label: f.feature, value: f.ic_train ?? 0, sub: `${feats.data.docs?.[f.feature] ?? ''} · test IC ${num(f.ic_test, 3)} · t ${num(f.t_stat_adj)} · ${f.sign_stable ? 'sign stable' : 'SIGN FLIPS out-of-sample'}` }))} />
            <p className="mt-2 text-[10.5px] text-ink-300">{feats.data.method} Train {feats.data.train_rows} / test {feats.data.test_rows} rows. |IC| &lt; 0.05 is typically noise; hover rows to see out-of-sample stability.</p>
          </>
        ) : <Empty>{feats.error ?? 'loading…'}</Empty>}
      </Panel>
      <Panel className="col-span-12 lg:col-span-5" title="Cross-asset correlation" tag={<Badge>90 days</Badge>}>
        {corr.data?.symbols.length ? <Heatmap labels={corr.data.symbols} matrix={corr.data.matrix} /> : <Empty>{corr.error ?? 'loading…'}</Empty>}
      </Panel>
    </div>
  )
}
