import {
  AreaSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart,
  type IChartApi, type ISeriesApi, type SeriesType, type Time,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'

export type TSeries =
  | { kind: 'line'; id: string; label: string; color: string; data: { time: string; value: number }[]; dashed?: boolean; width?: number }
  | { kind: 'area'; id: string; label: string; color: string; data: { time: string; value: number }[] }
  | { kind: 'histogram'; id: string; label: string; color: string; data: { time: string; value: number; color?: string }[]; scale?: string }
  | { kind: 'candle'; id: string; label: string; data: { time: string; open: number; high: number; low: number; close: number }[] }

/** lightweight-charts wrapper: dark theme, recessive grid, crosshair legend showing hovered values. */
export function TimeChart({ series, height = 300, format = (v: number) => v.toFixed(4), percent = false }: {
  series: TSeries[]
  height?: number
  format?: (v: number) => string
  percent?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [hover, setHover] = useState<{ time: string; vals: { label: string; color: string; v: string }[] } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = createChart(el, {
      height,
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8ea2bd', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(38,53,75,0.35)' }, horzLines: { color: 'rgba(38,53,75,0.35)' } },
      rightPriceScale: { borderColor: '#1b2738' },
      timeScale: { borderColor: '#1b2738' },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#3a4d68', labelBackgroundColor: '#131c2b' }, horzLine: { color: '#3a4d68', labelBackgroundColor: '#131c2b' } },
      localization: { priceFormatter: (v: number) => (percent ? `${(v * 100).toFixed(1)}%` : format(v)) },
    })
    chartRef.current = chart
    const apis: { s: TSeries; api: ISeriesApi<SeriesType> }[] = []
    for (const s of series) {
      let api: ISeriesApi<SeriesType>
      if (s.kind === 'line') {
        api = chart.addSeries(LineSeries, { color: s.color, lineWidth: (s.width ?? 2) as 1 | 2 | 3, lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid, priceLineVisible: false, lastValueVisible: true, title: '' })
      } else if (s.kind === 'area') {
        api = chart.addSeries(AreaSeries, { lineColor: s.color, topColor: `${s.color}55`, bottomColor: `${s.color}05`, lineWidth: 2, priceLineVisible: false })
      } else if (s.kind === 'histogram') {
        api = chart.addSeries(HistogramSeries, { color: s.color, priceScaleId: s.scale ?? 'vol', priceLineVisible: false, lastValueVisible: false })
        chart.priceScale(s.scale ?? 'vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
      } else {
        api = chart.addSeries(CandlestickSeries, { upColor: '#34d399', downColor: '#f87171', borderVisible: false, wickUpColor: '#34d39999', wickDownColor: '#f8717199', priceLineVisible: false })
      }
      api.setData(s.data as never)
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
        const color = s.kind === 'candle' ? '#c4d1e3' : s.color
        return [{ label: s.label, color, v: percent ? `${(v * 100).toFixed(2)}%` : format(v) }]
      })
      setHover({ time: String(p.time as Time), vals })
    })
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [series, height, format, percent])

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={ref} className="absolute inset-0" />
      {hover && (
        <div className="pointer-events-none absolute left-2 top-1 z-10 rounded border border-ink-600 bg-ink-900/90 px-2 py-1 font-mono text-[10.5px]">
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
