import { useEffect, useMemo, useRef, useState } from 'react'
import { useEvents } from '../lib/events'
import type { AtlasEvent, GraphData, GraphNode } from '../lib/types'

/**
 * Research network — the user's research operation rendered as an interactive sphere.
 *
 * FACT   Every node is a database entity (agents, datasets, features, strategy families, experiments, runs, jobs).
 *        Every crisp line is a recorded relationship from /api/graph.
 *        Specks around an experiment = its real number of out-of-sample trades.
 *        A light pulse travels a line ONLY when the backend emits an event naming that node.
 * STYLE  "Ambient strands" are a decorative haze drawn along those same relationships; they can be switched off.
 *        Rotation is camera motion, not activity.
 */

type Kind = GraphNode['kind']
const STYLE: Record<Kind, { color: string; r: number; shell: number; prio: number }> = {
  core: { color: '#f2f5f8', r: 6, shell: 0.12, prio: 10 },
  agent: { color: '#5eead4', r: 5, shell: 0.42, prio: 9 },
  risk: { color: '#ff6b6b', r: 5, shell: 0.42, prio: 8 },
  paper: { color: '#f5b553', r: 5, shell: 0.42, prio: 8 },
  forecast: { color: '#b4a7f5', r: 4.5, shell: 0.42, prio: 6 },
  data: { color: '#7cb4ff', r: 4.8, shell: 0.7, prio: 7 },
  strategy_type: { color: '#b4a7f5', r: 4.2, shell: 0.7, prio: 5 },
  deployed: { color: '#f5b553', r: 4.6, shell: 0.86, prio: 9 },
  feature: { color: '#8aa4bd', r: 1.8, shell: 0.84, prio: 0 },
  job: { color: '#aab4c0', r: 1.8, shell: 0.95, prio: 0 },
  run: { color: '#77c9d4', r: 1.15, shell: 1, prio: 0 },
  experiment: { color: '#aab4c0', r: 2.6, shell: 1, prio: 1 },
}
const VERDICT: Record<string, string> = { survived: '#6ee7a8', requires_confirmation: '#f5b553', insufficient_evidence: '#aab4c0', requires_revalidation: '#aab4c0', rejected: '#ff6b6b', accepted: '#6ee7a8', manual: '#dde3ea' }
const EDGE_RGB: Record<string, [number, number, number]> = {
  control: [222, 230, 238], flow: [94, 234, 212], derive: [124, 180, 255], judge: [255, 107, 107], eval: [150, 205, 255],
  sibling: [190, 205, 220], exec: [110, 205, 215], promote: [245, 181, 83],
}

type V3 = [number, number, number]
interface N3 extends GraphNode { p: V3; r: number; color: string; deg: number; prio: number; sx: number; sy: number; sz: number; sc: number; dust: V3[] }
interface Edge { a: number; b: number; c: V3; rgb: [number, number, number] }
interface Strand { e: number; c: V3; alpha: number }
interface Pulse { e: number; dir: 1 | -1; t: number; speed: number; color: string }

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967295
}
const fib = (i: number, n: number, off = 0): V3 => {
  const y = n > 1 ? 1 - (2 * (i + 0.5)) / n : 0
  const rad = Math.sqrt(Math.max(0, 1 - y * y))
  const th = i * Math.PI * (3 - Math.sqrt(5)) + off
  return [Math.cos(th) * rad, y, Math.sin(th) * rad]
}
const len = (v: V3) => Math.hypot(v[0], v[1], v[2])

function build(g: GraphData) {
  const deg = new Map<string, number>()
  g.edges.forEach((e) => { deg.set(e.s, (deg.get(e.s) ?? 0) + 1); deg.set(e.t, (deg.get(e.t) ?? 0) + 1) })
  const groups = new Map<number, GraphNode[]>()
  g.nodes.forEach((n) => { const k = STYLE[n.kind]?.shell ?? 1; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(n) })
  const nodes: N3[] = []
  for (const [shell, list] of groups) {
    list.forEach((n, i) => {
      const st = STYLE[n.kind] ?? STYLE.experiment
      const u: V3 = n.kind === 'core' ? [0, i === 0 ? 0.55 : -0.55, 0] : fib(i, list.length, shell * 9)
      let color = st.color
      if (n.kind === 'experiment') color = VERDICT[String(n.verdict)] ?? st.color
      if (n.kind === 'data' && n.stale) color = '#f5b553'
      const dust: V3[] = []
      if (n.kind === 'experiment') {
        const k = Math.min(40, Number(n.trades) || 0)
        for (let j = 0; j < k; j++) dust.push([(hash(n.id + ':' + j) - 0.5) * 0.1, (hash(j + ':' + n.id) - 0.5) * 0.1, (hash(n.id + j + 'z') - 0.5) * 0.1])
      }
      const d = deg.get(n.id) ?? 0
      const r = st.prio >= 5 ? st.r * (1 + Math.min(0.5, d / 60)) : st.r
      nodes.push({ ...n, p: [u[0] * shell, u[1] * shell, u[2] * shell], r, color, deg: d, prio: st.prio, sx: 0, sy: 0, sz: 0, sc: 1, dust })
    })
  }
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const edges: Edge[] = []
  g.edges.forEach((e) => {
    const a = index.get(e.s), b = index.get(e.t)
    if (a === undefined || b === undefined) return
    const A = nodes[a].p, B = nodes[b].p
    const mid: V3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]
    const ml = len(mid) || 1
    const lift = Math.max(len(A), len(B)) * 1.02 // arcs follow the sphere surface instead of cutting through it
    edges.push({ a, b, c: [(mid[0] / ml) * lift, (mid[1] / ml) * lift, (mid[2] / ml) * lift], rgb: EDGE_RGB[e.kind] ?? EDGE_RGB.derive })
  })
  const per = Math.max(1, Math.min(6, Math.round(1800 / Math.max(1, edges.length))))
  const strands: Strand[] = []
  edges.forEach((e, ei) => {
    for (let k = 0; k < per; k++) {
      const h = hash(`${ei}:${k}`), h2 = hash(`${k}:${ei}:b`), h3 = hash(`c${ei}${k}`)
      const s = 0.55 + h * 0.9
      strands.push({ e: ei, c: [e.c[0] * s + (h2 - 0.5) * 0.18, e.c[1] * s + (h3 - 0.5) * 0.18, e.c[2] * s + (h - 0.5) * 0.18], alpha: 0.025 + h2 * 0.05 })
    }
  })
  const adj = new Map<number, number[]>()
  const push = (n: number, ei: number) => { if (!adj.has(n)) adj.set(n, []); adj.get(n)!.push(ei) }
  edges.forEach((e, ei) => { push(e.a, ei); push(e.b, ei) })
  return { nodes, edges, strands, per, index, adj }
}

export function NeuralGraph({ data, onSelect, selected, height = 620, controls = true }: {
  data: GraphData | null
  onSelect?: (n: GraphNode | null) => void
  selected?: string | null
  height?: number
  controls?: boolean
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [w, setW] = useState(800)
  const [hover, setHover] = useState<N3 | null>(null)
  const [ambient, setAmbient] = useState(false) // decorative haze is opt-in
  const [spin, setSpin] = useState(false) // camera rotation is opt-in; motion is reserved for real events
  const [live, setLive] = useState(0)
  const G = useMemo(() => (data ? build(data) : null), [data])
  const { subscribe } = useEvents()
  const S = useRef({ yaw: 0.7, pitch: 0.28, vy: 0, vp: 0, drag: null as null | { x: number; y: number; moved: boolean; t: number }, pulses: [] as Pulse[], flash: new Map<number, number>(), hoverIdx: -1, visible: true, selected: null as string | null, ambient: true, spin: true, dirty: true })

  useEffect(() => { S.current.selected = selected ?? null; S.current.dirty = true }, [selected])
  useEffect(() => { S.current.ambient = ambient; S.current.dirty = true }, [ambient])
  useEffect(() => { S.current.spin = spin; S.current.dirty = true }, [spin])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))))
    ro.observe(el)
    const io = new IntersectionObserver(([e]) => { S.current.visible = e.isIntersecting })
    io.observe(el)
    return () => { ro.disconnect(); io.disconnect() }
  }, [])

  // Real backend events → light travelling along the real relationships of the named node.
  useEffect(() => subscribe((ev: AtlasEvent) => {
    if (!G) return
    const ids = new Set<string>()
    if (typeof ev.data?.node === 'string') ids.add(ev.data.node)
    if (ev.source && G.index.has(`agent:${ev.source}`)) ids.add(`agent:${ev.source}`)
    if (typeof ev.data?.symbol === 'string') ids.add(`data:${ev.data.symbol}`)
    const color = ev.level === 'error' || ev.category === 'risk' ? '#ff6b6b' : ev.level === 'warn' || ev.category === 'paper' ? '#f5b553' : '#9ff6e8'
    const st = S.current
    let n = 0
    for (const id of ids) {
      const i = G.index.get(id)
      if (i === undefined) continue
      st.flash.set(i, performance.now())
      for (const ei of (G.adj.get(i) ?? []).slice(0, 16)) {
        st.pulses.push({ e: ei, dir: G.edges[ei].a === i ? 1 : -1, t: 0, speed: 0.016 + Math.random() * 0.012, color })
        n++
      }
    }
    if (st.pulses.length > 400) st.pulses.splice(0, st.pulses.length - 400)
    if (n || ids.size) { st.dirty = true; setLive((x) => x + 1) }
  }), [subscribe, G])

  useEffect(() => {
    const c = canvas.current
    if (!c || !G) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = w * dpr
    c.height = height * dpr
    const ctx = c.getContext('2d')!
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cx = w / 2, cy = height / 2
    const R = Math.max(80, Math.min(w, height) / 2 - (w < 560 ? 26 : 46))
    const st = S.current
    st.dirty = true
    let raf = 0, last = 0
    const proj = (p: V3, k: number[]): [number, number, number, number] => {
      const x = p[0] * k[0] + p[2] * k[1], z0 = -p[0] * k[1] + p[2] * k[0]
      const y = p[1] * k[2] - z0 * k[3], z = p[1] * k[3] + z0 * k[2]
      const sc = 3 / (3 - z)
      return [cx + x * R * sc, cy + y * R * sc, z, sc]
    }
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (!st.visible || document.hidden || now - last < 30) return
      const dt = Math.min(64, now - last) / 16.7
      last = now
      const focus = st.selected ? G.index.get(st.selected) ?? -1 : st.hoverIdx
      // camera: auto-rotate (paused while inspecting / reduced motion) + inertia after drag
      const moving = st.drag || Math.abs(st.vy) > 1e-4 || Math.abs(st.vp) > 1e-4 || (st.spin && !reduce && focus < 0) || st.pulses.length > 0 || st.flash.size > 0
      if (!moving && !st.dirty) return
      st.dirty = false
      if (!st.drag) {
        st.yaw += st.vy * dt; st.pitch = Math.max(-1.1, Math.min(1.1, st.pitch + st.vp * dt))
        st.vy *= 0.92; st.vp *= 0.92
        if (st.spin && !reduce && focus < 0) st.yaw += 0.0022 * dt
      }
      const k = [Math.cos(st.yaw), Math.sin(st.yaw), Math.cos(st.pitch), Math.sin(st.pitch)]
      for (const n of G.nodes) { const q = proj(n.p, k); n.sx = q[0]; n.sy = q[1]; n.sz = q[2]; n.sc = q[3] }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.clearRect(0, 0, w, height)

      // globe body: soft fill + rim light (pure lighting, carries no data)
      const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R * 1.08)
      body.addColorStop(0, 'rgba(160,200,215,0.04)'); body.addColorStop(0.55, 'rgba(70,110,150,0.03)'); body.addColorStop(1, 'rgba(7,9,12,0)')
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R * 1.08, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = 'rgba(190,225,235,0.07)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.03, 0, Math.PI * 2); ctx.stroke()
      // equator & meridian guides
      ctx.strokeStyle = 'rgba(190,225,235,0.04)'
      for (const tilt of [0, Math.PI / 2]) {
        ctx.beginPath()
        for (let a = 0; a <= 64; a++) {
          const t = (a / 64) * Math.PI * 2
          const p: V3 = tilt ? [0, Math.cos(t), Math.sin(t)] : [Math.cos(t), 0, Math.sin(t)]
          const q = proj(p, k)
          if (a) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1])
        }
        ctx.stroke()
      }

      ctx.globalCompositeOperation = 'lighter'
      const focusEdges = focus >= 0 ? new Set(G.adj.get(focus) ?? []) : null
      const neigh = new Set<number>()
      focusEdges?.forEach((ei) => { neigh.add(G.edges[ei].a); neigh.add(G.edges[ei].b) })
      // decorative haze (optional)
      if (st.ambient) {
        ctx.lineWidth = 0.6
        for (const s of G.strands) {
          const e = G.edges[s.e]
          const A = G.nodes[e.a], B = G.nodes[e.b]
          const q = proj(s.c, k)
          const depth = 0.35 + 0.65 * ((A.sz + B.sz) / 2 + 1) / 2
          const al = (focus >= 0 ? s.alpha * 0.3 : s.alpha) * depth
          ctx.strokeStyle = `rgba(${e.rgb[0]},${e.rgb[1]},${e.rgb[2]},${al})`
          ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.quadraticCurveTo(q[0], q[1], B.sx, B.sy); ctx.stroke()
        }
      }
      // factual relationships: crisp arcs
      for (let ei = 0; ei < G.edges.length; ei++) {
        const e = G.edges[ei]
        const A = G.nodes[e.a], B = G.nodes[e.b]
        const on = !!focusEdges?.has(ei)
        const depth = 0.25 + 0.75 * ((A.sz + B.sz) / 2 + 1) / 2
        const al = on ? 0.85 : focus >= 0 ? 0.035 : 0.16 * depth
        ctx.lineWidth = on ? 1.4 : 0.8
        ctx.strokeStyle = on ? 'rgba(158,246,232,' + al + ')' : `rgba(${e.rgb[0]},${e.rgb[1]},${e.rgb[2]},${al})`
        const q = proj(e.c, k)
        ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.quadraticCurveTo(q[0], q[1], B.sx, B.sy); ctx.stroke()
      }
      // trade specks
      for (let ni = 0; ni < G.nodes.length; ni++) {
        const n = G.nodes[ni]
        if (!n.dust.length || (focus >= 0 && ni !== focus && !neigh.has(ni))) continue
        ctx.fillStyle = n.color
        ctx.globalAlpha = 0.45 * (0.3 + 0.7 * (n.sz + 1) / 2)
        for (const d of n.dust) {
          const q = proj([n.p[0] + d[0], n.p[1] + d[1], n.p[2] + d[2]], k)
          ctx.fillRect(q[0] - 0.6, q[1] - 0.6, 1.2, 1.2)
        }
      }
      ctx.globalAlpha = 1
      // event pulses (real)
      st.pulses = st.pulses.filter((p) => p.t <= 1)
      for (const p of st.pulses) {
        p.t += reduce ? 1 : p.speed * dt
        if (reduce) continue
        const e = G.edges[p.e]
        const A = p.dir === 1 ? G.nodes[e.a] : G.nodes[e.b], B = p.dir === 1 ? G.nodes[e.b] : G.nodes[e.a]
        const q = proj(e.c, k)
        const t = p.t, u = 1 - t
        const x = u * u * A.sx + 2 * u * t * q[0] + t * t * B.sx, y = u * u * A.sy + 2 * u * t * q[1] + t * t * B.sy
        const a = Math.sin(Math.PI * t)
        const g = ctx.createRadialGradient(x, y, 0, x, y, 7)
        g.addColorStop(0, p.color); g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.globalAlpha = a * 0.9; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill()
      }
      ctx.globalAlpha = 1
      // nodes back-to-front
      const order = [...G.nodes.keys()].sort((a, b) => G.nodes[a].sz - G.nodes[b].sz)
      for (const i of order) {
        const n = G.nodes[i]
        const fog = 0.3 + 0.7 * (n.sz + 1) / 2
        const dim = focus >= 0 && i !== focus && !neigh.has(i)
        const base = (dim ? 0.16 : 1) * fog
        const r = n.r * n.sc * (i === focus ? 1.45 : 1)
        if (n.prio >= 5) {
          const g = ctx.createRadialGradient(n.sx, n.sy, 0, n.sx, n.sy, r * 3.2)
          g.addColorStop(0, n.color); g.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.globalAlpha = base * 0.12; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.sx, n.sy, r * 3.2, 0, Math.PI * 2); ctx.fill()
        }
        ctx.globalAlpha = base; ctx.fillStyle = n.color
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2); ctx.fill()
        if (n.prio >= 5) { ctx.globalAlpha = base * 0.9; ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(n.sx - r * 0.28, n.sy - r * 0.28, r * 0.32, 0, Math.PI * 2); ctx.fill() }
        const f0 = st.flash.get(i)
        if (f0 !== undefined) {
          const age = (now - f0) / 1200
          if (age > 1) st.flash.delete(i)
          else { ctx.globalAlpha = (1 - age) * 0.9; ctx.strokeStyle = '#9ff6e8'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(n.sx, n.sy, r + 3 + age * 18, 0, Math.PI * 2); ctx.stroke() }
        }
        if (n.kind === 'agent' && n.status === 'running') { ctx.globalAlpha = 0.9; ctx.strokeStyle = '#5eead4'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(n.sx, n.sy, r + 4, 0, Math.PI * 2); ctx.stroke() }
      }
      // labels: priority order, front-facing, greedy collision avoidance
      ctx.globalCompositeOperation = 'source-over'
      ctx.font = '500 11.5px Inter, system-ui, sans-serif'
      const placed: [number, number, number, number][] = []
      const cand = order.filter((i) => i === focus || (G.nodes[i].prio >= 5 && G.nodes[i].sz > -0.2 && (focus < 0 || neigh.has(i))))
        .sort((a, b) => (b === focus ? 99 : G.nodes[b].prio + G.nodes[b].sz) - (a === focus ? 99 : G.nodes[a].prio + G.nodes[a].sz))
      for (const i of cand.slice(0, w < 560 ? 8 : 16)) {
        const n = G.nodes[i]
        const right = n.sx >= cx
        const txt = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label
        const tw = ctx.measureText(txt).width
        const x0 = right ? n.sx + n.r * n.sc + 7 : n.sx - n.r * n.sc - 7 - tw
        const box: [number, number, number, number] = [x0 - 5, n.sy - 10, tw + 10, 20]
        if (x0 < 4 || x0 + tw > w - 4) continue
        if (i !== focus && placed.some((p) => box[0] < p[0] + p[2] && box[0] + box[2] > p[0] && box[1] < p[1] + p[3] && box[1] + box[3] > p[1])) continue
        placed.push(box)
        ctx.globalAlpha = i === focus ? 1 : Math.min(1, 0.45 + (n.sz + 0.2) * 0.75)
        ctx.fillStyle = 'rgba(10,13,17,0.72)'
        ctx.beginPath(); ctx.roundRect(box[0], box[1], box[2], box[3], 7); ctx.fill()
        ctx.fillStyle = i === focus ? '#ffffff' : '#dde3ea'
        ctx.textAlign = 'left'
        ctx.fillText(txt, x0, n.sy + 4)
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [G, w, height])

  const pick = (e: React.PointerEvent) => {
    if (!G) return -1
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = e.clientX - r.left, y = e.clientY - r.top
    let best = -1, bd = 220
    G.nodes.forEach((n, i) => {
      const d = (n.sx - x) ** 2 + (n.sy - y) ** 2 - n.sz * 40 - n.prio * 6
      if (d < bd) { bd = d; best = i }
    })
    return best
  }

  return (
    <div ref={wrap} className="relative w-full touch-none select-none" style={{ height }}>
      <canvas ref={canvas} role="img" aria-label={G ? `Research network: ${G.nodes.length} entities and ${G.edges.length} recorded relationships` : 'Research network loading'}
        className="absolute inset-0 cursor-grab active:cursor-grabbing" style={{ width: w, height }}
        onPointerDown={(e) => { S.current.drag = { x: e.clientX, y: e.clientY, moved: false, t: performance.now() }; (e.target as Element).setPointerCapture(e.pointerId) }}
        onPointerMove={(e) => {
          const st = S.current
          if (st.drag) {
            const dx = e.clientX - st.drag.x, dy = e.clientY - st.drag.y
            if (Math.abs(dx) + Math.abs(dy) > 3) st.drag.moved = true
            st.yaw += dx * 0.006; st.pitch = Math.max(-1.1, Math.min(1.1, st.pitch + dy * 0.006))
            st.vy = dx * 0.003; st.vp = dy * 0.003
            st.drag.x = e.clientX; st.drag.y = e.clientY; st.dirty = true
            return
          }
          const i = pick(e)
          if (i !== st.hoverIdx) { st.hoverIdx = i; st.dirty = true; setHover(i >= 0 && G ? G.nodes[i] : null) }
        }}
        onPointerUp={(e) => {
          const st = S.current
          const wasDrag = st.drag?.moved
          st.drag = null
          if (wasDrag || !G) return
          st.vy = 0; st.vp = 0
          const i = pick(e)
          const n = i >= 0 ? G.nodes[i] : null
          onSelect?.(n && n.id !== selected ? n : null)
        }}
        onPointerLeave={() => { S.current.hoverIdx = -1; S.current.dirty = true; setHover(null) }} />
      {!G && <div className="absolute inset-0 flex items-center justify-center"><div className="skeleton h-[60%] w-[60%] !rounded-full opacity-40" /></div>}
      {controls && G && (
        <div className="absolute right-3 bottom-3 flex items-center gap-1 rounded-[12px] bg-[rgba(14,18,23,0.78)] p-1 ring-1 ring-white/[0.07] backdrop-blur-xl">
          <IconBtn label={spin ? 'Pause rotation' : 'Resume rotation'} onClick={() => setSpin(!spin)}>
            {spin ? <path d="M6 4.5v11M14 4.5v11" /> : <path d="M6.5 4.5v11l9-5.5-9-5.5Z" />}
          </IconBtn>
          <IconBtn label={ambient ? 'Hide decorative strands' : 'Show decorative strands'} onClick={() => setAmbient(!ambient)} active={ambient}>
            <path d="M3 13c3-6 11-6 14 0M3 9c3 4 11 4 14 0" />
          </IconBtn>
          <IconBtn label="Reset view" onClick={() => { S.current.yaw = 0.7; S.current.pitch = 0.28; S.current.vy = 0; S.current.vp = 0; S.current.dirty = true; onSelect?.(null) }}>
            <path d="M4 10a6 6 0 1 0 2-4.5M4 4v3.5h3.5" />
          </IconBtn>
        </div>
      )}
      {hover && !selected && (
        <div className="pointer-events-none absolute z-10 max-w-[260px] rounded-[12px] bg-[rgba(22,27,34,0.95)] px-3 py-2 text-[12px] shadow-[0_14px_36px_-10px_rgba(0,0,0,0.8)] ring-1 ring-white/[0.08] backdrop-blur-xl"
          style={{ left: Math.max(6, Math.min(hover.sx + 14, w - 270)), top: Math.max(6, hover.sy - 14) }}>
          <div className="text-[11.5px] text-ink-300 capitalize">{hover.kind.replace('_', ' ')}</div>
          <div className="font-medium text-white">{hover.label}</div>
          <div className="mt-0.5 text-ink-300">{hover.deg} recorded relationship{hover.deg === 1 ? '' : 's'} · click to inspect</div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">{live ? 'Research activity received' : ''}</span>
    </div>
  )
}

function IconBtn({ children, label, onClick, active }: { children: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} aria-label={label} title={label}
      className={`flex h-8 w-8 items-center justify-center rounded-[9px] transition-colors ${active ? 'text-cy' : 'text-ink-200'} hover:bg-white/[0.08] hover:text-white`}>
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
    </button>
  )
}
