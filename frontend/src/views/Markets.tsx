import { useEffect, useMemo, useState } from 'react'
import type { ViewProps } from '../App'
import { Heatmap, SignedBars } from '../components/charts/Svg'
import { TimeChart, type TSeries } from '../components/charts/TimeChart'
import { Badge, Button, Disclosure, EmptyState, ErrorBox, InfoTip, KeyValue, Legend, Loading, Notice, Panel, SERIES, Segmented, Sparkline, StatusDot, UP, DN } from '../components/ui'
import { api, slug, useAction, useApi } from '../lib/api'
import { useEventTrigger } from '../lib/events'
import { REGIME_PLAIN, shortDate } from '../lib/explain'
import { num, pct, price, tone } from '../lib/format'
import { paramToSym, symToParam, useParam } from '../lib/route'
import { useToast } from '../lib/toast'
import type { Bar, CrossSource, Market } from '../lib/types'

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

const RANGES = [{ value: '90', label: '3M' }, { value: '252', label: '1Y' }, { value: '756', label: '3Y' }, { value: '5000', label: 'All' }]
const REGIME_COLOR: Record<string, string> = { trend_up: '#6ee7a8', trend_down: '#ff6b6b', range: '#7f8a97' }
const FUTURE = ['Stocks', 'ETFs', 'Options', 'Futures']
type TF = '1d' | '1w' | '6h' | '1h'
const QUALITY: Record<string, { tone: 'up' | 'am' | 'dn'; label: string }> = { ok: { tone: 'up', label: 'Checks passed' }, warn: { tone: 'am', label: 'Usable with caveats' }, fail: { tone: 'dn', label: 'Failed checks' } }
const SOURCE: Record<string, string> = { frankfurter: 'European Central Bank via Frankfurter', coinbase: 'Coinbase Exchange', kraken: 'Kraken' }

function crossText(c: CrossSource | null | undefined) {
  if (!c) return 'Not available for this market'
  if (c.status === 'unavailable') return `${SOURCE[c.secondary] ?? c.secondary} could not be reached for comparison`
  if (c.status === 'no_overlap') return 'No overlapping days to compare'
  const base = `Median gap ${num(c.median_abs_bps, 1)} bps vs ${SOURCE[c.secondary] ?? c.secondary} over ${c.overlap} days`
  return c.status === 'ok' ? `${base}; agrees` : `${base}; ${c.days_over_tolerance} day(s) differ by more than ${c.tolerance_bps} bps`
}

export function MarketsView({ go }: ViewProps) {
  const markets = useApi<Market[]>('/markets', { poll: 60000 })
  const [symP, setSymP] = useParam('sym', 'BTC-USD')
  const sym = paramToSym(symP)
  const [tfSel, setTf] = useState<TF>('1d')
  const [range, setRange] = useState('252')
  const symIsFx = markets.data?.find((x) => x.symbol === sym)?.asset_class === 'fx'
  const tf: TF = symIsFx && (tfSel === '1h' || tfSel === '6h') ? '1d' : tfSel
  const bars = useApi<{ bars: Bar[]; dataset: any }>(`/markets/${slug(sym)}/bars?timeframe=${tf}&limit=5000`, { deps: [sym, tf] })
  const quality = useApi<any>(`/markets/${slug(sym)}/quality`, { deps: [sym] })
  const regime = useApi<any>(`/markets/${slug(sym)}/regime`, { deps: [sym] })
  const feats = useApi<any>(`/markets/${slug(sym)}/features?horizon=5`, { deps: [sym] })
  const corr = useApi<{ symbols: string[]; matrix: (number | null)[][] }>('/markets/correlations?window=90')
  const [spark, setSpark] = useState<Record<string, number[]>>({})
  const toast = useToast()
  const refresh = useAction(async () => { await api.post('/markets/refresh', { symbols: [sym] }); toast({ tone: 'info', title: `Refreshing ${sym}`, body: 'Fetching the latest daily bars from the provider.' }) })
  useEventTrigger((e) => e.category === 'data' && /bars/.test(e.message), () => { markets.reload(); bars.reload(); quality.reload() }, 1500)

  useEffect(() => {
    markets.data?.forEach((m) => {
      if (spark[m.symbol]) return
      api.get<{ bars: Bar[] }>(`/markets/${slug(m.symbol)}/bars?limit=60`).then((r) => setSpark((s) => ({ ...s, [m.symbol]: r.bars.map((b) => b.c) }))).catch(() => {})
    })
  }, [markets.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const m = markets.data?.find((x) => x.symbol === sym)
  const isFx = m?.asset_class === 'fx'
  const intraday = tf === '1h' || tf === '6h'
  const all = bars.data?.bars ?? []
  const visible = useMemo(() => {
    if (intraday) return all
    const n = tf === '1w' ? Math.ceil(+range / 5) : +range
    return all.slice(-(n + 200)) // keep 200 extra bars so moving averages are defined at the left edge
  }, [all, range, tf, intraday])
  const series = useMemo<TSeries[]>(() => {
    const b = visible
    if (!b.length) return []
    const n = intraday ? Math.max(b.length - 200, 1) : tf === '1w' ? Math.ceil(+range / 5) : +range
    const cut = b.length > n ? b[b.length - n].t : b[0].t
    const keep = <T extends { time: string }>(xs: T[]) => xs.filter((x) => x.time >= cut)
    const ohlc = b.every((x) => x.o !== null)
    const s: TSeries[] = ohlc
      ? [{ kind: 'candle', id: 'px', label: sym, data: keep(b.map((x) => ({ time: x.t, open: x.o!, high: x.h!, low: x.l!, close: x.c }))) }]
      : [{ kind: 'line', id: 'px', label: `${sym} reference rate`, color: '#eef2f6', data: keep(b.map((x) => ({ time: x.t, value: x.c }))), width: 2 }]
    s.push({ kind: 'line', id: 'ma50', label: '50-period average', color: SERIES[0], data: keep(smaLine(b, 50)), width: 1 })
    s.push({ kind: 'line', id: 'ma200', label: '200-period average', color: SERIES[1], data: keep(smaLine(b, 200)), width: 1 })
    if (b.every((x) => x.v !== null)) s.push({ kind: 'histogram', id: 'vol', label: 'Volume', color: 'rgba(127,138,151,0.35)', data: keep(b.map((x) => ({ time: x.t, value: x.v! }))) })
    return s
  }, [visible, sym, range, tf, intraday])
  const dec = m?.price_decimals ?? 4
  const fmt = useMemo(() => (v: number) => v.toFixed(dec), [dec])
  const q = quality.data?.quality
  const closes = all.map((b) => b.c)
  const ret = (n: number) => (tf === '1d' && closes.length > n ? closes.at(-1)! / closes.at(-1 - n)! - 1 : null)
  const r = regime.data?.current

  return (
    <div className="grid grid-cols-12 gap-5">
      {/* watchlist */}
      <aside className="col-span-12 lg:col-span-3 2xl:col-span-2">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-[15px] font-semibold text-white">Watchlist</h2><span className="text-[12px] text-ink-300">Not live</span></div>
        <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
          {(['crypto', 'fx'] as const).map((cls) => (
            <div key={cls} className="contents lg:block">
              <div className="hidden px-1 pt-1 pb-1.5 text-[12px] font-medium text-ink-400 lg:block">{cls === 'fx' ? 'Forex · daily ECB reference rates' : 'Crypto · historical candles'}</div>
              {(markets.data ?? []).filter((x) => x.asset_class === cls).map((x) => {
                const on = x.symbol === sym
                return (
                  <button key={x.symbol} onClick={() => setSymP(symToParam(x.symbol))} aria-pressed={on}
                    className={`min-w-[170px] rounded-[14px] px-3.5 py-2.5 text-left transition-colors lg:mb-1 lg:w-full ${on ? 'bg-white/[0.08] ring-1 ring-inset ring-cy/30' : 'hover:bg-white/[0.04]'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[14px] font-medium text-white">{x.symbol}</span>
                      <span className={`num text-[12.5px] ${tone(x.change_1d)}`}>{pct(x.change_1d)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-3">
                      <span className="num text-[13px] text-ink-200">{price(x.last_close, x.price_decimals)}</span>
                      <div className="flex-1"><Sparkline values={spark[x.symbol] ?? []} color={(spark[x.symbol]?.at(-1) ?? 0) >= (spark[x.symbol]?.[0] ?? 0) ? UP : DN} height={22} fill={false} /></div>
                    </div>
                  </button>
                )
              })}
            </div>
          ))}
          {!markets.data && <Loading rows={5} />}
        </div>
        <div className="mt-4 hidden rounded-[14px] px-3.5 py-3 ring-1 ring-inset ring-white/[0.06] lg:block">
          <div className="text-[12.5px] font-medium text-ink-200">More asset classes</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">{FUTURE.map((f) => <span key={f} className="rounded-full bg-white/[0.04] px-2 py-0.5 text-[11.5px] text-ink-400">{f}</span>)}</div>
          <p className="mt-2 text-[12px] leading-snug text-ink-400">Not supported yet. SIGNAL only shows markets with verified data.</p>
        </div>
      </aside>

      {/* main */}
      <div className="col-span-12 space-y-5 lg:col-span-9 2xl:col-span-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-300">
              <span>{isFx ? 'Forex' : 'Crypto'}</span><span>·</span><span>{m?.attribution ?? '—'}</span>
            </div>
            <h1 className="mt-1 text-[30px] leading-tight font-semibold tracking-[-0.025em] text-white">{sym}</h1>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="num text-[34px] leading-none tracking-[-0.03em] text-white">{price(m?.last_close, dec)}</span>
              <span className={`num text-[16px] ${tone(m?.change_1d)}`}>{pct(m?.change_1d)}</span>
              <span className="text-[13px] text-ink-300">{isFx ? 'Reference fix' : 'Daily close'} on {shortDate(m?.last_ts)}{m?.is_stale && <span className="ml-1.5 text-am">· stale</span>}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button tone="primary" onClick={() => go('strategy', { sym: symToParam(sym) })}>Test a strategy</Button>
            <Button onClick={() => go('forecast', { sym: symToParam(sym) })}>Forecast</Button>
            <Button onClick={() => go('experiments', { sym: symToParam(sym) })}>Discoveries</Button>
          </div>
        </div>

        {isFx && (
          <Notice tone="am" title="Daily ECB reference rates — not live forex quotes.">
            The European Central Bank publishes one official {sym} rate per business day (around 16:00 CET). It is not an executable price, and there are no intraday highs, lows or volume. Backtests on it fill one full day late to stay honest.
          </Notice>
        )}

        {m && !m.licensed && (
          <Notice tone="am" title="Data source not licensed for this deployment">
            This beta only shows data from sources whose terms allow it. {sym} has no such source yet, so its prices are hidden rather than shown from an unverified source.
          </Notice>
        )}

        <Panel title="Price history" subtitle={m ? (intraday ? `Historical ${tf} candles (UTC), limited lookback. Not live: the open candle is excluded. Research uses daily data.` : m.label) : undefined} right={<>
          {!intraday && <Segmented size="sm" value={range} onChange={setRange} options={RANGES} />}
          <Segmented size="sm" value={tf} onChange={(v) => setTf(v as TF)} options={[...(isFx ? [] : [{ value: '1h', label: '1H' }, { value: '6h', label: '6H' }]), { value: '1d', label: 'Daily' }, { value: '1w', label: 'Weekly' }]} />
        </>}>
          <ErrorBox error={bars.error || refresh.error} onRetry={bars.reload} />
          <div className="mb-2"><Legend items={[{ label: isFx ? 'Reference rate' : intraday ? `${tf} candles` : tf === '1w' ? 'Weekly candles' : 'Daily candles', color: '#eef2f6' }, { label: '50-period average', color: SERIES[0] }, { label: '200-period average', color: SERIES[1] }]} /></div>
          {series.length ? <TimeChart series={series} height={400} format={fmt} /> : bars.loading ? <Loading rows={6} /> : (
            <EmptyState title="No price history yet" action={<Button small onClick={() => refresh.run()}>Fetch data</Button>}>Data for {sym} hasn't been downloaded. Fetching takes a few seconds.</EmptyState>
          )}
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[['1 month', ret(isFx ? 21 : 30)], ['3 months', ret(isFx ? 63 : 90)], ['1 year', ret(isFx ? 252 : 365)]].map(([l, v]) => (
              <div key={l as string}><div className="label">{l as string}</div><div className={`num text-[17px] ${tone(v as number | null)}`}>{pct(v as number | null, 1)}</div></div>
            ))}
            <div><div className="flex items-center gap-1"><span className="label">Volatility</span><InfoTip text="Annualised standard deviation of daily returns over the last 20 days." /></div><div className="num text-[17px] text-white">{pct(r?.ann_vol, 1, false)}</div></div>
          </div>
        </Panel>

        <div className="grid grid-cols-12 gap-5">
          <Panel className="col-span-12 xl:col-span-6" title="Market context" subtitle="How this market has been behaving, measured using only past data.">
            {!r ? (regime.error ? <ErrorBox error={regime.error} /> : <Loading />) : (
              <div className="space-y-4">
                <p className="text-[15px] leading-relaxed text-ink-100">
                  {sym} is <b className="font-semibold text-white">{REGIME_PLAIN[r.trend]?.toLowerCase()}</b> with <b className="font-semibold text-white">{REGIME_PLAIN[r.vol]}</b>, a state it has been in since {shortDate(r.since)}.
                  {r.trend === 'range' ? ' Trend-following ideas tend to struggle in range-bound markets.' : ' Trend-following ideas have the most favourable conditions in trending markets.'}
                </p>
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[12px] text-ink-300"><span>Recent regime history</span><span>{regime.data.segments.at(-60)?.start ? shortDate(regime.data.segments.slice(-60)[0].start) : ''} → today</span></div>
                  <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full">
                    {regime.data.segments.slice(-60).map((s: any, i: number) => (
                      <div key={i} title={`${s.start} → ${s.end}: ${REGIME_PLAIN[s.trend]}, ${REGIME_PLAIN[s.vol]}`} style={{ flexGrow: s.bars, background: REGIME_COLOR[s.trend], opacity: s.vol === 'high_vol' ? 1 : s.vol === 'low_vol' ? 0.4 : 0.7 }} />
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-300">
                    {Object.entries(REGIME_COLOR).map(([k, c]) => <span key={k} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{REGIME_PLAIN[k]}</span>)}
                    <span>Brighter = more volatile</span>
                  </div>
                </div>
              </div>
            )}
          </Panel>
          <Panel className="col-span-12 xl:col-span-6" title="Data quality & provenance" right={q && m?.quality_status && <Badge tone={QUALITY[m.quality_status].tone}>{QUALITY[m.quality_status].label}</Badge>}>
            {!q ? (quality.error ? <ErrorBox error={quality.error} /> : <Loading />) : (
              <>
                <KeyValue rows={[
                  ['Type', isFx ? 'Daily ECB reference rates — not live forex quotes.' : 'Historical completed daily candles (UTC), not live'],
                  ['Source', (m?.provider ? SOURCE[m.provider] ?? m.provider : '—') + (q.sources?.length > 1 ? ` (history also from ${q.sources.filter((x: string) => x !== m?.provider).map((x: string) => SOURCE[x] ?? x).join(', ')})` : '')],
                  ['History', `${shortDate(q.start)} ${q.start?.slice(0, 4)} – ${shortDate(q.end)} ${q.end?.slice(0, 4)} · ${q.rows.toLocaleString()} days`],
                  ['Completeness', <span className="inline-flex items-center gap-1.5">{pct(q.completeness, 1, false)}<InfoTip text={q.calendar_note} /></span>],
                  ['Fields', q.has_ohlc ? 'Open, high, low, close' + (q.has_volume ? ', volume' : '') : 'Close only (no high/low/volume)'],
                  ['Last bar', `${shortDate(q.end)} · ${num(q.stale_days, 1)} days ago${m?.is_stale ? ' (stale)' : ''}`],
                  ...(isFx ? [] : [['Cross-check', crossText(m?.cross_source)] as [string, string]]),
                  ['Excluded candles', <span className="inline-flex items-center gap-1.5">{q.normalization?.quarantined ?? 0}<InfoTip text="Candles that fail validation (bad timestamp, invalid prices, impossible high/low) are excluded and listed, never repaired." /></span>],
                  ['Dataset version', <span className="font-mono text-[12px]">{quality.data.version}</span>],
                ]} />
                {(m?.quality_issues?.length ?? 0) > 0 && (
                  <ul className="mt-3 space-y-1.5 text-[12.5px] leading-snug text-ink-200">
                    {m!.quality_issues.map((i) => <li key={i.code} className="flex gap-2"><StatusDot tone={i.level === 'fail' ? 'dn' : i.level === 'warn' ? 'am' : 'up'} /><span>{i.text}</span></li>)}
                  </ul>
                )}
                <div className="mt-3"><Button small onClick={() => refresh.run()} disabled={refresh.pending}>{refresh.pending ? 'Refreshing…' : 'Refresh now'}</Button></div>
              </>
            )}
          </Panel>
        </div>

        <div className="grid grid-cols-12 gap-5">
          <Panel className="col-span-12 xl:col-span-7" title="Which signals have mattered" subtitle="How strongly each measured feature lined up with the following week's return.">
            {feats.data?.features?.length ? (
              <>
                <SignedBars posColor={SERIES[0]} negColor={SERIES[3]} format={(v) => v.toFixed(3)}
                  rows={feats.data.features.slice(0, 10).map((f: any) => ({ label: feats.data.docs?.[f.feature] ?? f.feature, value: f.ic_train ?? 0, sub: `Held-out check ${num(f.ic_test, 3)} · ${f.sign_stable ? 'direction held on new data' : 'direction flipped on new data'}` }))} />
                <p className="mt-3 text-[12.5px] leading-relaxed text-ink-300">Values near zero mean no relationship. Anything below about ±0.05 is usually noise. Hover a row to see whether the relationship held on later data.</p>
              </>
            ) : feats.error ? <ErrorBox error={feats.error} /> : <Loading rows={6} />}
          </Panel>
          <Panel className="col-span-12 xl:col-span-5" title="How markets move together" subtitle="Correlation of daily returns over the last 90 days.">
            {corr.data?.symbols.length ? <Heatmap labels={corr.data.symbols} matrix={corr.data.matrix} size={46} /> : corr.error ? <ErrorBox error={corr.error} /> : <Loading />}
          </Panel>
        </div>

        {q && (
          <Disclosure title="Technical details" meta="Validation report">
            <div className="grid gap-4 sm:grid-cols-2">
              <KeyValue rows={[['Missing periods', q.missing_periods], ['Gaps', q.gap_count], ['Outliers (|z| > 10)', q.outliers?.length ?? 0], ['Duplicates dropped', q.normalization?.duplicates_dropped ?? 0], ['Out-of-order rows', q.normalization?.out_of_order_rows ?? 0], ['Excluded (latest refresh)', q.normalization?.quarantined ?? 0], ['Excluded (all time)', quality.data.quarantine?.length ?? 0]]} />
              <div className="scroll-thin max-h-[180px] overflow-auto rounded-[12px] ring-1 ring-white/[0.05]">
                <table className="data"><thead><tr><th>Version</th><th>Rows</th><th>Ends</th></tr></thead>
                  <tbody>{quality.data.versions.map((v: any) => <tr key={v.version + v.created_at}><td className="font-mono text-[12px]">{v.version}</td><td>{v.rows}</td><td>{v.end_ts}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          </Disclosure>
        )}
        <div className="flex items-center gap-2 text-[12px] text-ink-400"><StatusDot tone={m?.is_stale ? 'am' : 'up'} />{m?.provider_notes}</div>
      </div>
    </div>
  )
}
