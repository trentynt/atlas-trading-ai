import {
  AreaSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart,
  type IChartApi, type ISeriesApi, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'
import { alpha, resolve, usePrefs } from '../../lib/prefs'

const toUtc = (t: string) => (Math.floor(Date.parse(t) / 1000) as UTCTimestamp)

export type TSeries =
  | { kind: 'line'; id: string; label: string; color: string; data: { time: string; value: number }[]; dashed?: boolean; width?: number }
  | { kind: 'area'; id: string; label: string; color: string; data: { time: string; value: number }[] }
  | { kind: 'histogram'; id: string; label: string; color: string; data: { time: string; value: number; color?: string }[]; scale?: string }
  | { kind: 'candle'; id: string; label: string; data: { time: string; open: number; high: number; low: number; close: number }[] }

/** lightweight-charts wrapper: dark theme, recessive grid, crosshair legend showing hovered values. */
function summary(series: TSeries[], format: (v: number) => string, percent?: boolean) {
  const fmt = (v: number) => (percent ? `${(v * 100).toFixed(1)}%` : format(v))
  const parts = series.filter((x) => x.kind !== 'histogram' && x.data.length).map((x) => {
    const d = x.data as { time: string; value?: number; close?: number }[]
    const last = d[d.length - 1], first = d[0]
    const v = (p: typeof last) => p.value ?? p.close ?? 0
    return `${x.label}: ${fmt(v(first))} on ${first.time.slice(0, 10)} to ${fmt(v(last))} on ${last.time.slice(0, 10)}`
  })
  return parts.length ? `Time chart. ${parts.join('. ')}.` : 'Time chart with no data.'
}

export function TimeChart({ series, height = 300, format = (v: number) => v.toFixed(4), percent = false }: {
  series: TSeries[]
  height?: number
  format?: (v: number) => string
  percent?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const prefs = usePrefs()
  const [hover, setHover] = useState<{ time: string; vals: { label: string; color: string; v: string }[] } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = createChart(el, {
      height,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: resolve('var(--text-2)'), fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: alpha('var(--grid)', 0.6) }, horzLines: { color: alpha('var(--grid)', 0.6) } },
      rightPriceScale: { borderColor: resolve('var(--border)') },
      timeScale: { borderColor: resolve('var(--border)') },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: resolve('var(--muted)'), labelBackgroundColor: resolve('var(--raised)') }, horzLine: { color: resolve('var(--muted)'), labelBackgroundColor: resolve('var(--raised)') } },
      localization: { priceFormatter: (v: number) => (percent ? `${(v * 100).toFixed(1)}%` : format(v)) },
    })
    chartRef.current = chart
    const apis: { s: TSeries; api: ISeriesApi<SeriesType> }[] = []
    const intraday = series.some((x) => x.data.some((d) => d.time.includes('T')))
    if (intraday) chart.applyOptions({ timeScale: { timeVisible: true, secondsVisible: false } })
    for (const s of series) {
      let api: ISeriesApi<SeriesType>
      if (s.kind === 'line') {
        api = chart.addSeries(LineSeries, { color: resolve(s.color), lineWidth: (s.width ?? 2) as 1 | 2 | 3, lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid, priceLineVisible: false, lastValueVisible: true, title: '' })
      } else if (s.kind === 'area') {
        api = chart.addSeries(AreaSeries, { lineColor: resolve(s.color), topColor: alpha(s.color, 0.33), bottomColor: alpha(s.color, 0.02), lineWidth: 2, priceLineVisible: false })
      } else if (s.kind === 'histogram') {
        api = chart.addSeries(HistogramSeries, { color: resolve(s.color), priceScaleId: s.scale ?? 'vol', priceLineVisible: false, lastValueVisible: false })
        chart.priceScale(s.scale ?? 'vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
      } else {
        api = chart.addSeries(CandlestickSeries, { upColor: resolve('var(--positive)'), downColor: resolve('var(--negative)'), borderVisible: false, wickUpColor: alpha('var(--positive)', 0.6), wickDownColor: alpha('var(--negative)', 0.6), priceLineVisible: false })
      }
      api.setData((intraday ? s.data.map((d) => ({ ...d, time: toUtc(d.time) })) : s.data) as never)
      apis.push({ s, api })
    }
    chart.timeScale().fitContent()
    chart.subscribeCrosshairMove((p) => {
      if (!p.time || !p.point) {
        setHover(null)
        return
      }
      const vals = apis.flatMap(({ s, api }) => {
        const d = p.seriesData.get(api) as { value?: number; close?: number } | undefined
        if (!d) return []
        const v = d.value ?? d.close
        if (v === undefined) return []
        const color = s.kind === 'candle' ? 'var(--text)' : s.color
        return [{ label: s.label, color, v: percent ? `${(v * 100).toFixed(2)}%` : format(v) }]
      })
      setHover({ time: typeof p.time === 'number' ? `${new Date(p.time * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : String(p.time as Time), vals })
    })
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [series, height, format, percent, prefs.updown])

  return (
    <div className="relative w-full" style={{ height }} role="img" aria-label={summary(series, format, percent)}>
      <div ref={ref} className="absolute inset-0" aria-hidden />
      {hover && (
        <div className="pointer-events-none absolute left-2 top-1 z-10 rounded-[9px] border border-white/10 bg-[rgba(10,18,27,0.86)] px-2.5 py-1.5 text-[11px] backdrop-blur-xl">
          <div className="text-ink-300">{hover.time}</div>
          {hover.vals.map((v) => (
            <div key={v.label} className="flex items-center gap-2">
              <span className="inline-block h-[2px] w-3" style={{ background: v.color }} />
              <span className="text-ink-200">{v.label}</span>
              <span className="ml-auto pl-3 text-white">{v.v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const toLine = (pts: { t: string; v: number | null }[]) =>
  pts.filter((p) => p.v !== null && Number.isFinite(p.v)).map((p) => ({ time: p.t, value: p.v as number }))
