import { useEffect, useMemo, useRef, useState } from 'react'
import { useEvents } from '../lib/events'
import type { AtlasEvent, GraphData, GraphNode } from '../lib/types'

/**
 * Computation graph of the real system.
 *  - Topology: every node/edge comes from /api/graph (database entities + real dependencies).
 *  - Motion: a pulse travels an edge ONLY when the backend emits an event naming that node.
 *    There is no ambient/decorative activity; an idle system is a still graph.
 */

const KIND_STYLE: Record<GraphNode['kind'], { color: string; r: number; ring: number }> = {
  core: { color: '#e6edf7', r: 7, ring: 0 },
  agent: { color: '#22d3ee', r: 5.5, ring: 1 },
  risk: { color: '#f87171', r: 5.5, ring: 1 },
  paper: { color: '#f5a524', r: 5.5, ring: 1 },
  forecast: { color: '#a78bfa', r: 5, ring: 1 },
  data: { color: '#3b82f6', r: 5, ring: 2 },
  strategy_type: { color: '#a78bfa', r: 4.5, ring: 2 },
  feature: { color: '#5f7491', r: 2.6, ring: 3 },
  experiment: { color: '#5f7491', r: 2.2, ring: 4 },
  deployed: { color: '#f5a524', r: 4.5, ring: 3 },
  job: { color: '#8ea2bd', r: 2.4, ring: 3 },
}

const VERDICT_COLOR: Record<string, string> = { accepted: '#34d399', rejected: '#f87171', manual: '#8ea2bd' }

interface LNode extends GraphNode { x: number; y: number; r: number; color: string; deg: number }
interface Particle { a: LNode; b: LNode; t: number; speed: number; color: string }

function layout(g: GraphData, w: number, h: number): { nodes: LNode[]; byId: Map<string, LNode> } {
  const cx = w / 2, cy = h / 2
  const R = Math.min(w, h) / 2 - 18
  const deg = new Map<string, number>()
  g.edges.forEach((e) => { deg.set(e.s, (deg.get(e.s) ?? 0) + 1); deg.set(e.t, (deg.get(e.t) ?? 0) + 1) })
  const groups: Record<string, GraphNode[]> = {}
  g.nodes.forEach((n) => { (groups[n.kind] ??= []).push(n) })
  const out: LNode[] = []
  const place = (n: GraphNode, x: number, y: number) => {
    const s = KIND_STYLE[n.kind]
    let color = s.color
    if (n.kind === 'experiment') color = VERDICT_COLOR[String(n.verdict)] ?? s.color
    if (n.kind === 'data' && n.stale) color = '#f5a524'
    out.push({ ...n, x, y, r: s.r, color, deg: deg.get(n.id) ?? 0 })
  }
  const arc = (nodes: GraphNode[], radius: number, a0: number, a1: number) => {
    nodes.forEach((n, i) => {
      const a = a0 + ((i + 0.5) / nodes.length) * (a1 - a0)
      place(n, cx + Math.cos(a) * radius, cy + Math.sin(a) * radius)
    })
  }
  const core = groups.core ?? []
  core.forEach((n, i) => place(n, cx + (i === 0 ? 0 : 0), cy + (i === 0 ? 0 : R * 0.09)))
  const ring1 = [...(groups.agent ?? []), ...(groups.risk ?? []), ...(groups.paper ?? []), ...(groups.forecast ?? [])]
  arc(ring1, R * 0.24, -Math.PI / 2, Math.PI * 1.5)
  arc(groups.data ?? [], R * 0.44, Math.PI * 0.62, Math.PI * 1.38)
  arc(groups.strategy_type ?? [], R * 0.44, -Math.PI * 0.38, Math.PI * 0.38)
  arc(groups.feature ?? [], R * 0.6, Math.PI * 0.56, Math.PI * 1.44)
  arc(groups.deployed ?? [], R * 0.6, Math.PI * 0.12, Math.PI * 0.36)
  arc(groups.job ?? [], R * 0.6, -Math.PI * 0.36, -Math.PI * 0.12)
  // experiments: dense golden-angle cloud in the outer annulus
  const ex = groups.experiment ?? []
  const golden = Math.PI * (3 - Math.sqrt(5))
  ex.forEach((n, i) => {
    const frac = ex.length > 1 ? i / (ex.length - 1) : 0.5
    const rr = R * (0.72 + 0.26 * Math.sqrt(frac))
    const a = i * golden
    place(n, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
  })
  return { nodes: out, byId: new Map(out.map((n) => [n.id, n])) }
}

export function NeuralGraph({ data, onSelect, selected, height = 560 }: {
  data: GraphData | null
  onSelect?: (n: GraphNode | null) => void
  selected?: string | null
  height?: number
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const base = useRef<HTMLCanvasElement>(null)
  const fx = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 800, h: height })
  const [hover, setHover] = useState<LNode | null>(null)
  const particles = useRef<Particle[]>([])
  const flashes = useRef(new Map<string, number>())
  const { subscribe } = useEvents()
  const [activity, setActivity] = useState(0)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(280, e.contentRect.width), h: height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [height])

  const L = useMemo(() => (data ? layout(data, size.w, size.h) : null), [data, size])
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>()
    data?.edges.forEach((e) => {
      if (!m.has(e.s)) m.set(e.s, new Set())
      if (!m.has(e.t)) m.set(e.t, new Set())
      m.get(e.s)!.add(e.t)
      m.get(e.t)!.add(e.s)
    })
    return m
  }, [data])

  // static layer: edges + nodes (redrawn on data/hover/selection change only)
  useEffect(() => {
    const c = base.current
    if (!c || !L || !data) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = size.w * dpr
    c.height = size.h * dpr
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    const focus = selected ?? hover?.id ?? null
    const neigh = focus ? adj.get(focus) ?? new Set() : null
    const cx = size.w / 2, cy = size.h / 2
    // guide rings
    ctx.strokeStyle = 'rgba(58,77,104,0.18)'
    ctx.lineWidth = 1
    const R = Math.min(size.w, size.h) / 2 - 18
    for (const f of [0.24, 0.44, 0.6, 0.72, 0.98]) {
      ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke()
    }
    for (const e of data.edges) {
      const a = L.byId.get(e.s), b = L.byId.get(e.t)
      if (!a || !b) continue
      const on = focus && (e.s === focus || e.t === focus)
      ctx.strokeStyle = on ? 'rgba(34,211,238,0.75)' : e.kind === 'judge' ? 'rgba(248,113,113,0.05)' : e.kind === 'derive' ? 'rgba(95,116,145,0.09)' : 'rgba(95,116,145,0.22)'
      if (focus && !on) ctx.strokeStyle = 'rgba(95,116,145,0.035)'
      ctx.lineWidth = on ? 1.2 : 0.6
      // curve gently toward the centre — reads as flow into the core
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      const qx = mx + (cx - mx) * 0.18, qy = my + (cy - my) * 0.18
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(qx, qy, b.x, b.y); ctx.stroke()
    }
    for (const n of L.nodes) {
      const dim = focus && n.id !== focus && !neigh?.has(n.id)
      ctx.globalAlpha = dim ? 0.25 : 1
      if (n.r >= 4.5) {
        ctx.fillStyle = `${n.color}22`
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2); ctx.fill()
      }
      ctx.fillStyle = n.color
      ctx.beginPath(); ctx.arc(n.x, n.y, n.id === focus ? n.r + 2 : n.r, 0, Math.PI * 2); ctx.fill()
      if (n.kind === 'agent' && n.status === 'running') {
        ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2); ctx.stroke()
      }
      if (['core', 'agent', 'risk', 'paper', 'forecast', 'data', 'strategy_type', 'deployed'].includes(n.kind)) {
        ctx.fillStyle = dim ? '#5f7491' : '#c4d1e3'
        ctx.font = '500 10px JetBrains Mono, monospace'
        ctx.textAlign = n.x < cx - 4 ? 'right' : n.x > cx + 4 ? 'left' : 'center'
        const dx = n.x < cx - 4 ? -9 : n.x > cx + 4 ? 9 : 0
        ctx.fillText(n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label, n.x + dx, n.y + (dx === 0 ? -11 : 3.5))
      }
    }
    ctx.globalAlpha = 1
  }, [L, data, size, hover, selected, adj])

  // live events → pulses along real edges
  useEffect(() => {
    return subscribe((ev: AtlasEvent) => {
      if (!L || !data) return
      const ids = new Set<string>()
      const node = ev.data?.node as string | undefined
      if (node) ids.add(node)
      if (ev.source && L.byId.has(`agent:${ev.source}`)) ids.add(`agent:${ev.source}`)
      if (typeof ev.data?.symbol === 'string') ids.add(`data:${ev.data.symbol}`)
      let spawned = 0
      const color = ev.level === 'error' ? '#f87171' : ev.level === 'warn' ? '#f5a524' : ev.category === 'risk' ? '#f87171' : ev.category === 'paper' ? '#f5a524' : '#22d3ee'
      for (const id of ids) {
        const n = L.byId.get(id)
        if (!n) continue
        flashes.current.set(id, performance.now())
        const nb = [...(adj.get(id) ?? [])].slice(0, 14)
        for (const o of nb) {
          const m = L.byId.get(o)
          if (!m) continue
          particles.current.push({ a: n, b: m, t: 0, speed: 0.012 + Math.random() * 0.01, color })
          spawned++
        }
      }
      if (particles.current.length > 600) particles.current.splice(0, particles.current.length - 600)
      if (spawned) setActivity((a) => a + 1)
    })
  }, [subscribe, L, data, adj])

  // animation loop: runs only while particles/flashes exist
  useEffect(() => {
    const c = fx.current
    if (!c) return
    let raf = 0
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = size.w * dpr
    c.height = size.h * dpr
    const ctx = c.getContext('2d')!
    const cx = size.w / 2, cy = size.h / 2
    const frame = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.w, size.h)
      const now = performance.now()
      for (const [id, t0] of flashes.current) {
        const age = (now - t0) / 900
        const n = L?.byId.get(id)
        if (age > 1 || !n) { flashes.current.delete(id); continue }
        ctx.strokeStyle = `rgba(34,211,238,${1 - age})`
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 + age * 14, 0, Math.PI * 2); ctx.stroke()
      }
      particles.current = particles.current.filter((p) => p.t <= 1)
      for (const p of particles.current) {
        p.t += p.speed
        const mx = (p.a.x + p.b.x) / 2, my = (p.a.y + p.b.y) / 2
        const qx = mx + (cx - mx) * 0.18, qy = my + (cy - my) * 0.18
        const t = p.t, u = 1 - t
        const x = u * u * p.a.x + 2 * u * t * qx + t * t * p.b.x
        const y = u * u * p.a.y + 2 * u * t * qy + t * t * p.b.y
        ctx.fillStyle = p.color
        ctx.globalAlpha = Math.sin(Math.PI * t)
        ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill()
      }
      ctx.globalAlpha = 1
      if (particles.current.length || flashes.current.size) raf = requestAnimationFrame(frame)
      else raf = 0
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [activity, size, L])

  const pick = (e: React.MouseEvent) => {
    if (!L) return null
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = e.clientX - r.left, y = e.clientY - r.top
    let best: LNode | null = null, bd = 144
    for (const n of L.nodes) {
      const d = (n.x - x) ** 2 + (n.y - y) ** 2
      if (d < bd) { bd = d; best = n }
    }
    return best
  }

  return (
    <div ref={wrap} className="relative w-full select-none" style={{ height }}>
      <canvas ref={base} className="absolute inset-0" style={{ width: size.w, height: size.h }} />
      <canvas ref={fx} className="absolute inset-0 cursor-crosshair" style={{ width: size.w, height: size.h }}
        onMouseMove={(e) => setHover(pick(e))} onMouseLeave={() => setHover(null)}
        onClick={(e) => { const n = pick(e); onSelect?.(n && n.id !== selected ? n : null) }} />
      {hover && (
        <div className="pointer-events-none absolute z-10 max-w-[260px] rounded border border-ink-500 bg-ink-900/95 px-2 py-1.5 font-mono text-[10.5px] shadow-xl"
          style={{ left: Math.min(hover.x + 12, size.w - 270), top: Math.max(4, hover.y - 10) }}>
          <div className="text-[9.5px] uppercase tracking-wider text-ink-300">{hover.kind.replace('_', ' ')}</div>
          <div className="text-white">{hover.label}</div>
          <div className="text-ink-300">{hover.deg} connection{hover.deg === 1 ? '' : 's'}</div>
          {Object.entries(hover).filter(([k, v]) => ['verdict', 'sharpe', 'rows', 'version', 'status', 'family', 'allocation'].includes(k) && v !== null && v !== undefined).map(([k, v]) => (
            <div key={k} className="text-ink-200">{k}: <span className="text-white">{typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : String(v)}</span></div>
          ))}
        </div>
      )}
    </div>
  )
}
