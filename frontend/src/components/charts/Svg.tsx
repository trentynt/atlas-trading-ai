import { useMemo, useRef, useState, type ReactNode } from 'react'

/** Responsive SVG frame that reports its width. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  const ro = useRef<ResizeObserver | null>(null)
  const setRef = (el: HTMLDivElement | null) => {
    ro.current?.disconnect()
    ;(ref as { current: HTMLDivElement | null }).current = el
    if (el) {
      ro.current = new ResizeObserver(([e]) => setW(Math.max(120, e.contentRect.width)))
      ro.current.observe(el)
    }
  }
  return { setRef, w }
}

function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-[9px] border border-white/10 bg-[rgba(10,18,27,0.86)] px-2.5 py-1.5 text-[11px] whitespace-nowrap text-ink-100 shadow-[0_8px_24px_-6px_rgba(0,0,0,0.7)] backdrop-blur-xl"
      style={{ left: x, top: y - 8 }}>
      {children}
    </div>
  )
}

const lin = (d0: number, d1: number, r0: number, r1: number) => (v: number) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0))

function ticks(lo: number, hi: number, n = 5) {
  const span = hi - lo || 1
  const step = 10 ** Math.floor(Math.log10(span / n))
  const err = (n * step) / span
  const m = err <= 0.15 ? 10 : err <= 0.35 ? 5 : err <= 0.75 ? 2 : 1
  const s = step * m
  const out = []
  for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-12; v += s) out.push(+v.toFixed(10))
  return out
}

// ---------------- Diverging heatmap (correlation) ----------------
// Diverging = two hues + neutral midpoint. Negative → blue, 0 → slate, positive → amber.
function heatmapSummary(labels: string[], m: (number | null)[][]) {
  let best: [number, string, string] | null = null
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const v = m[i]?.[j]
    if (v !== null && v !== undefined && (!best || Math.abs(v) > Math.abs(best[0]))) best = [v, labels[i], labels[j]]
  }
  return `Correlation matrix of ${labels.join(', ')}.` + (best ? ` Strongest pair: ${best[1]} and ${best[2]} at ${best[0].toFixed(2)}.` : '')
}

function histSummary(values: number[], label: string | undefined, f: (v: number) => string) {
  if (!values.length) return `Histogram of ${label ?? 'values'}: no data.`
  const s = [...values].sort((a, b) => a - b)
  return `Histogram of ${values.length} values of ${label ?? 'the measure'}: from ${f(s[0])} to ${f(s[s.length - 1])}, median ${f(s[Math.floor(s.length / 2)])}.`
}

export function divergingColor(v: number | null) {
  if (v === null || !Number.isFinite(v)) return 'var(--bg)'
  const t = Math.max(-1, Math.min(1, v))
  const mid = [44, 44, 47]
  const pos = [255, 159, 10]
  const neg = [10, 132, 255]
  const end = t >= 0 ? pos : neg
  const a = Math.abs(t)
  const c = mid.map((m, i) => Math.round(m + (end[i] - m) * a))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

export function Heatmap({ labels, matrix, size = 44 }: { labels: string[]; matrix: (number | null)[][]; size?: number }) {
  const [hover, setHover] = useState<{ x: number; y: number; i: number; j: number } | null>(null)
  if (!labels.length) return null
  const pad = 62
  const W = pad + labels.length * size
  return (
    <div className="relative overflow-x-auto">
      <svg width={W} height={pad + labels.length * size} className="block" onMouseLeave={() => setHover(null)} role="img" aria-label={heatmapSummary(labels, matrix)}>
        {labels.map((l, i) => (
          <g key={l}>
            <text x={pad - 6} y={pad + i * size + size / 2 + 3} textAnchor="end" className="fill-ink-200 tnum text-[10px]">{l}</text>
            <text x={pad + i * size + size / 2} y={pad - 8} textAnchor="middle" className="fill-ink-200 tnum text-[10px]">{l.replace('/USD', '').replace('USD/', '')}</text>
          </g>
        ))}
        {matrix.map((row, i) => row.map((v, j) => (
          <g key={`${i}-${j}`} onMouseEnter={() => setHover({ x: pad + j * size + size / 2, y: pad + i * size, i, j })}>
            <rect x={pad + j * size + 1} y={pad + i * size + 1} width={size - 2} height={size - 2} rx={7} fill={divergingColor(v)}
              stroke={hover?.i === i && hover?.j === j ? 'var(--text)' : 'none'} />
            <text x={pad + j * size + size / 2} y={pad + i * size + size / 2 + 3} textAnchor="middle" className="pointer-events-none fill-white tnum text-[10px]">
              {v === null ? '—' : v.toFixed(2)}
            </text>
          </g>
        )))}
      </svg>
      {hover && (
        <Tip x={hover.x} y={hover.y}>{labels[hover.i]} × {labels[hover.j]}: <b>{matrix[hover.i][hover.j]?.toFixed(3) ?? '—'}</b></Tip>
      )}
      <div className="mt-2 flex items-center gap-2 tnum text-[10px] text-ink-300">
        <span>−1</span>
        <span className="h-1.5 w-32 rounded" style={{ background: `linear-gradient(90deg, ${divergingColor(-1)}, ${divergingColor(0)}, ${divergingColor(1)})` }} />
        <span>+1</span>
        <span className="ml-2">correlation of daily log returns</span>
      </div>
    </div>
  )
}

// ---------------- Scatter ----------------
export interface ScatterPoint { id: string | number; x: number; y: number; color: string; group: string; label: string }

export function Scatter({ points, xLabel, yLabel, height = 280, onPick, diagonal = false, refX, refY }: {
  points: ScatterPoint[]; xLabel: string; yLabel: string; height?: number; onPick?: (id: string | number) => void
  diagonal?: boolean; refX?: number; refY?: number
}) {
  const { setRef, w } = useWidth()
  const [hover, setHover] = useState<ScatterPoint | null>(null)
  const m = { l: 44, r: 12, t: 10, b: 32 }
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const lo = Math.min(-0.5, ...xs, ...ys)
  const hi = Math.max(0.5, ...xs, ...ys)
  const x = lin(lo, hi, m.l, w - m.r)
  const y = lin(lo, hi, height - m.b, m.t)
  const tk = ticks(lo, hi)
  return (
    <div ref={setRef} className="relative w-full">
      <svg width={w} height={height} className="block" role="img" aria-label={`Scatter plot of ${points.length} points: ${xLabel} against ${yLabel}.`}>
        {tk.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeOpacity={t === 0 ? 0.9 : 0.35} />
            <line y1={m.t} y2={height - m.b} x1={x(t)} x2={x(t)} stroke="var(--grid)" strokeOpacity={t === 0 ? 0.9 : 0.35} />
            <text x={m.l - 6} y={y(t) + 3} textAnchor="end" className="fill-ink-300 tnum text-[9.5px]">{t}</text>
            <text x={x(t)} y={height - m.b + 13} textAnchor="middle" className="fill-ink-300 tnum text-[9.5px]">{t}</text>
          </g>
        ))}
        {diagonal && <line x1={x(lo)} y1={y(lo)} x2={x(hi)} y2={y(hi)} stroke="var(--text-3)" strokeDasharray="4 4" />}
        {refY !== undefined && <line x1={m.l} x2={w - m.r} y1={y(refY)} y2={y(refY)} stroke="#c87d0e" strokeDasharray="3 3" strokeOpacity={0.7} />}
        {refX !== undefined && <line y1={m.t} y2={height - m.b} x1={x(refX)} x2={x(refX)} stroke="#c87d0e" strokeDasharray="3 3" strokeOpacity={0.7} />}
        {points.map((p) => (
          <g key={p.id} onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.(p.id)} className={onPick ? 'cursor-pointer' : ''}>
            <circle cx={x(p.x)} cy={y(p.y)} r={10} fill="transparent" />
            <circle cx={x(p.x)} cy={y(p.y)} r={hover?.id === p.id ? 5.5 : 4} fill={p.color} fillOpacity={0.85} stroke="var(--bg)" strokeWidth={1.5} />
          </g>
        ))}
        <text x={(m.l + w - m.r) / 2} y={height - 4} textAnchor="middle" className="fill-ink-300 tnum text-[10px]">{xLabel}</text>
        <text transform={`translate(11 ${(m.t + height - m.b) / 2}) rotate(-90)`} textAnchor="middle" className="fill-ink-300 tnum text-[10px]">{yLabel}</text>
      </svg>
      {hover && <Tip x={x(hover.x)} y={y(hover.y)}>{hover.label}<br />{xLabel} {hover.x.toFixed(2)} · {yLabel} {hover.y.toFixed(2)}</Tip>}
    </div>
  )
}

// ---------------- Histogram ----------------
export function Histogram({ values, bins = 24, color, height = 160, xLabel, refLine, format = (v: number) => v.toFixed(2) }: {
  values: number[]; bins?: number; color: string; height?: number; xLabel: string; refLine?: number; format?: (v: number) => string
}) {
  const { setRef, w } = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const data = useMemo(() => {
    if (!values.length) return null
    const lo = Math.min(...values), hi = Math.max(...values)
    const step = (hi - lo || 1) / bins
    const counts = Array.from({ length: bins }, (_, i) => ({ lo: lo + i * step, hi: lo + (i + 1) * step, n: 0 }))
    values.forEach((v) => { counts[Math.min(bins - 1, Math.floor((v - lo) / step))].n++ })
    return { lo, hi, counts, max: Math.max(...counts.map((c) => c.n)) }
  }, [values, bins])
  const m = { l: 30, r: 8, t: 8, b: 28 }
  if (!data) return <div ref={setRef} />
  const x = lin(data.lo, data.hi, m.l, w - m.r)
  const y = lin(0, data.max, height - m.b, m.t)
  const bw = Math.max(1, (w - m.l - m.r) / bins - 2)
  return (
    <div ref={setRef} className="relative w-full">
      <svg width={w} height={height} className="block" role="img" aria-label={histSummary(values, xLabel, format)}>
        <line x1={m.l} x2={w - m.r} y1={height - m.b} y2={height - m.b} stroke="var(--grid)" />
        {data.counts.map((c, i) => c.n > 0 && (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect x={x(c.lo) + 1} y={m.t} width={bw + 2} height={height - m.b - m.t} fill="transparent" />
            <path d={roundTop(x(c.lo) + 1, y(c.n), bw, height - m.b - y(c.n), 2)} fill={color} fillOpacity={hover === i ? 1 : 0.8} />
          </g>
        ))}
        {refLine !== undefined && refLine >= data.lo && refLine <= data.hi && (
          <line x1={x(refLine)} x2={x(refLine)} y1={m.t} y2={height - m.b} stroke="var(--text)" strokeDasharray="3 3" strokeOpacity={0.6} />
        )}
        {ticks(data.lo, data.hi, 6).map((t) => (
          <text key={t} x={x(t)} y={height - m.b + 13} textAnchor="middle" className="fill-ink-300 tnum text-[9.5px]">{format(t)}</text>
        ))}
        <text x={m.l - 4} y={m.t + 8} textAnchor="end" className="fill-ink-300 tnum text-[9.5px]">{data.max}</text>
        <text x={(m.l + w) / 2} y={height - 3} textAnchor="middle" className="fill-ink-300 tnum text-[10px]">{xLabel}</text>
      </svg>
      {hover !== null && (
        <Tip x={x((data.counts[hover].lo + data.counts[hover].hi) / 2)} y={y(data.counts[hover].n)}>
          {format(data.counts[hover].lo)} … {format(data.counts[hover].hi)}: <b>{data.counts[hover].n}</b>
        </Tip>
      )}
    </div>
  )
}

function roundTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return ''
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`
}

// ---------------- Horizontal bars (signed) ----------------
export function SignedBars({ rows, height = 18, format = (v: number) => v.toFixed(3), posColor, negColor }: {
  rows: { label: string; value: number; sub?: string }[]; height?: number; format?: (v: number) => string; posColor: string; negColor: string
}) {
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value)))
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[minmax(90px,140px)_1fr_64px] items-center gap-2" title={r.sub}>
          <span className="truncate tnum text-[10.5px] text-ink-200">{r.label}</span>
          <div className="relative" style={{ height }}>
            <div className="absolute top-0 bottom-0 left-1/2 w-px bg-ink-500" />
            <div className="absolute top-[3px] bottom-[3px] rounded-[2px]"
              style={{
                left: r.value >= 0 ? '50%' : `${50 - (Math.abs(r.value) / max) * 50}%`,
                width: `${(Math.abs(r.value) / max) * 50}%`,
                background: r.value >= 0 ? posColor : negColor,
              }} />
          </div>
          <span className="num text-right text-[10.5px] text-ink-100">{format(r.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------- Forecast fan chart ----------------
export interface FanPoint { t: string; mean: number; lo50: number; hi50: number; lo80: number; hi80: number; lo95: number; hi95: number }

export function FanChart({ history, path, color, height = 320, decimals = 4 }: {
  history: { t: string; c: number }[]; path: FanPoint[]; color: string; height?: number; decimals?: number
}) {
  const { setRef, w } = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const hist = history.slice(-160)
  const n = hist.length + path.length
  const m = { l: 8, r: 64, t: 12, b: 26 }
  const all = [...hist.map((h) => h.c), ...path.flatMap((p) => [p.lo95, p.hi95])]
  const lo = Math.min(...all), hi = Math.max(...all)
  const padY = (hi - lo) * 0.06
  const x = lin(0, n - 1, m.l, w - m.r)
  const y = lin(lo - padY, hi + padY, height - m.b, m.t)
  const i0 = hist.length - 1
  const origin = { i: i0, v: hist[i0]?.c ?? 0 }
  const band = (k: 'lo50' | 'lo80' | 'lo95', kh: 'hi50' | 'hi80' | 'hi95') => {
    const up = [`${x(origin.i)},${y(origin.v)}`, ...path.map((p, j) => `${x(i0 + 1 + j)},${y(p[kh])}`)]
    const dn = path.map((p, j) => `${x(i0 + 1 + j)},${y(p[k])}`).reverse()
    return `M${[...up, ...dn].join(' L')} Z`
  }
  const histPath = `M${hist.map((h, i) => `${x(i)},${y(h.c)}`).join(' L')}`
  const meanPath = `M${x(origin.i)},${y(origin.v)} L${path.map((p, j) => `${x(i0 + 1 + j)},${y(p.mean)}`).join(' L')}`
  const tk = ticks(lo, hi, 5)
  const fmt = (v: number) => v.toFixed(decimals)
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const idx = Math.round(((e.clientX - r.left - m.l) / (w - m.l - m.r)) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, idx)))
  }
  const hv = hover === null ? null : hover <= i0 ? { kind: 'obs' as const, t: hist[hover].t, v: hist[hover].c } : { kind: 'fc' as const, ...path[hover - i0 - 1] }
  return (
    <div ref={setRef} className="relative w-full">
      <svg width={w} height={height} className="block" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Forecast: observed history, the central estimate, and shaded uncertainty bands that widen with the horizon.">
        {tk.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeOpacity={0.35} />
            <text x={w - m.r + 6} y={y(t) + 3} className="fill-ink-300 tnum text-[9.5px]">{fmt(t)}</text>
          </g>
        ))}
        <rect x={x(i0)} y={m.t} width={w - m.r - x(i0)} height={height - m.b - m.t} fill="url(#fc-hatch)" opacity={0.6} />
        <defs>
          <pattern id="fc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--grid)" strokeWidth="1" />
          </pattern>
        </defs>
        <path d={band('lo95', 'hi95')} fill={color} fillOpacity={0.12} />
        <path d={band('lo80', 'hi80')} fill={color} fillOpacity={0.18} />
        <path d={band('lo50', 'hi50')} fill={color} fillOpacity={0.28} />
        <path d={histPath} fill="none" stroke="var(--text)" strokeWidth={1.6} />
        <path d={meanPath} fill="none" stroke={color} strokeWidth={2} strokeDasharray="5 4" />
        <line x1={x(i0)} x2={x(i0)} y1={m.t} y2={height - m.b} stroke="var(--text-3)" strokeDasharray="2 3" />
        <text x={x(i0) - 6} y={m.t + 10} textAnchor="end" className="fill-ink-200 tnum text-[10px]">{w > 560 ? `OBSERVED · ${hist[i0]?.t}` : 'OBSERVED'}</text>
        <text x={x(i0) + 6} y={m.t + 10} className="tnum text-[10px]" fill={color}>{w > 560 ? `FORECAST → ${path.at(-1)?.t}` : 'FORECAST'}</text>
        <text x={m.l} y={height - 8} className="fill-ink-300 tnum text-[9.5px]">{hist[0]?.t}</text>
        <text x={x(i0)} y={height - 8} textAnchor="end" className="fill-ink-300 tnum text-[9.5px]">{w > 560 ? `origin ${hist[i0]?.t}` : ''}</text>
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={height - m.b} stroke="var(--text-3)" />}
      </svg>
      {hv && (
        <div className="pointer-events-none absolute top-2 left-3 rounded-[9px] border border-white/10 bg-[rgba(10,18,27,0.86)] px-2.5 py-1.5 text-[11px] backdrop-blur-xl">
          {hv.kind === 'obs' ? (
            <><span className="text-ink-300">{hv.t} · observed</span><br /><span className="text-white">{fmt(hv.v)}</span></>
          ) : (
            <>
              <span className="text-ink-300">{hv.t} · forecast mean</span> <span className="text-white">{fmt(hv.mean)}</span><br />
              <span className="text-ink-300">50%</span> {fmt(hv.lo50)}–{fmt(hv.hi50)} · <span className="text-ink-300">95%</span> {fmt(hv.lo95)}–{fmt(hv.hi95)}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------- Calibration (nominal vs empirical coverage) ----------------
export function Calibration({ rows, height = 200 }: { rows: { label: string; color: string; coverage: Record<string, number> }[]; height?: number }) {
  const { setRef, w } = useWidth()
  const m = { l: 36, r: 10, t: 10, b: 28 }
  const x = lin(0.4, 1, m.l, w - m.r)
  const y = lin(0.4, 1, height - m.b, m.t)
  const levels = ['50', '80', '95']
  return (
    <div ref={setRef} className="w-full">
      <svg width={w} height={height} className="block" role="img" aria-label={`Calibration: how often each model's forecast bands contained the outcome. ${rows.map((r) => r.label).join(', ')}.`}>
        {[0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => (
          <g key={t}>
            <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeOpacity={0.35} />
            <text x={m.l - 5} y={y(t) + 3} textAnchor="end" className="fill-ink-300 tnum text-[9.5px]">{Math.round(t * 100)}</text>
            <text x={x(t)} y={height - m.b + 13} textAnchor="middle" className="fill-ink-300 tnum text-[9.5px]">{Math.round(t * 100)}</text>
          </g>
        ))}
        <line x1={x(0.4)} y1={y(0.4)} x2={x(1)} y2={y(1)} stroke="var(--text-2)" strokeDasharray="4 4" />
        {rows.map((r) => (
          <g key={r.label}>
            <polyline fill="none" stroke={r.color} strokeWidth={2} points={levels.map((l) => `${x(+l / 100)},${y(r.coverage[l] ?? 0)}`).join(' ')} />
            {levels.map((l) => (
              <circle key={l} cx={x(+l / 100)} cy={y(r.coverage[l] ?? 0)} r={4} fill={r.color} stroke="var(--bg)" strokeWidth={1.5}>
                <title>{`${r.label}: nominal ${l}% → empirical ${((r.coverage[l] ?? 0) * 100).toFixed(1)}%`}</title>
              </circle>
            ))}
          </g>
        ))}
        <text x={(m.l + w) / 2} y={height - 3} textAnchor="middle" className="fill-ink-300 tnum text-[10px]">nominal interval coverage %</text>
      </svg>
    </div>
  )
}
