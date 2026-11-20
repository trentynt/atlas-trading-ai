import { useEffect, useMemo, useRef, useState } from 'react'
import { useEvents } from '../lib/events'
import { reducedMotion, resolve, setPrefs, usePrefs } from '../lib/prefs'
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
// Colours are design tokens (index.css), resolved to concrete values when the network is built.
const STYLE: Record<Kind, { color: string; r: number; shell: number; prio: number }> = {
  core: { color: 'var(--text)', r: 6, shell: 0.12, prio: 10 },
  agent: { color: 'var(--brand)', r: 5, shell: 0.42, prio: 9 },
  risk: { color: 'var(--negative)', r: 5, shell: 0.42, prio: 8 },
  paper: { color: 'var(--warning)', r: 5, shell: 0.42, prio: 8 },
  forecast: { color: 'var(--family)', r: 4.5, shell: 0.42, prio: 6 },
  data: { color: 'var(--markets)', r: 4.8, shell: 0.7, prio: 7 },
  strategy_type: { color: 'var(--family)', r: 4.2, shell: 0.7, prio: 5 },
  deployed: { color: 'var(--warning)', r: 4.6, shell: 0.86, prio: 9 },
  feature: { color: 'var(--text-3)', r: 1.8, shell: 0.84, prio: 0 },
  job: { color: 'var(--text-2)', r: 1.8, shell: 0.95, prio: 0 },
  run: { color: 'var(--text-3)', r: 1.15, shell: 1, prio: 0 },
  experiment: { color: 'var(--text-2)', r: 2.6, shell: 1, prio: 1 },
}
const VERDICT: Record<string, string> = { survived: 'var(--positive)', requires_confirmation: 'var(--warning)', insufficient_evidence: 'var(--text-2)', requires_revalidation: 'var(--text-2)', rejected: 'var(--negative)', accepted: 'var(--positive)', manual: 'var(--text)' }
const EDGE_TOKEN: Record<string, string> = {
  control: 'var(--text)', flow: 'var(--brand)', derive: 'var(--markets)', judge: 'var(--negative)', eval: 'var(--markets)',
  sibling: 'var(--text-2)', exec: 'var(--brand)', promote: 'var(--warning)',
}
const rgbOf = (c: string): [number, number, number] => {
  const h = resolve(c).replace('#', '')
  return /^[0-9a-f]{6}$/i.test(h) ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] : [200, 210, 220]
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
      let color = resolve(st.color)
      if (n.kind === 'experiment') color = resolve(VERDICT[String(n.verdict)] ?? st.color)
      if (n.kind === 'data' && n.stale) color = resolve('var(--warning)')
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
    edges.push({ a, b, c: [(mid[0] / ml) * lift, (mid[1] / ml) * lift, (mid[2] / ml) * lift], rgb: rgbOf(EDGE_TOKEN[e.kind] ?? EDGE_TOKEN.derive) })
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

export function NeuralGraph({ data, onSelect, selected, height: maxHeight = 620, controls = true }: {
  data: GraphData | null
  onSelect?: (n: GraphNode | null) => void
  selected?: string | null
  height?: number
  controls?: boolean
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [w, setW] = useState(800)
  // On narrow screens the sphere is sized to the width, so it never forces a tall empty area.
  const height = w < 640 ? Math.min(maxHeight, Math.max(300, Math.round(w * 0.95))) : maxHeight
  const [hover, setHover] = useState<N3 | null>(null)
  const prefs = usePrefs()
  const ambient = prefs.sphereStrands // decorative haze is opt-in (saved preference)
  const spin = prefs.sphereSpin // camera rotation is opt-in; motion is reserved for real events
  const setAmbient = (v: boolean) => setPrefs({ sphereStrands: v })
  const setSpin = (v: boolean) => setPrefs({ sphereSpin: v })
  const [live, setLive] = useState('')
  const [kbd, setKbd] = useState(-1)
  const kbdRef = useRef(-1)
  const lastSaid = useRef(0)
  useEffect(() => { kbdRef.current = kbd; S.current.dirty = true }, [kbd])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const G = useMemo(() => (data ? build(data) : null), [data, prefs.updown])
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
    const color = resolve(ev.level === 'error' || ev.category === 'risk' ? 'var(--negative)' : ev.level === 'warn' || ev.category === 'paper' ? 'var(--warning)' : 'var(--brand)')
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
    if (n || ids.size) {
      st.dirty = true
      const t = performance.now()
      if (t - lastSaid.current > 10_000) { lastSaid.current = t; setLive(`Research activity: ${ev.message.slice(0, 140)}`) }
    }
  }), [subscribe, G])

  useEffect(() => {
    const c = canvas.current
    if (!c || !G) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = w * dpr
    c.height = height * dpr
    const ctx = c.getContext('2d')!
    const reduce = reducedMotion(prefs)
    const outline = resolve('var(--border)'), labelBg = resolve('var(--bg)'), labelFg = resolve('var(--text)'), accent = resolve('var(--brand)')
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

      // outline and equator/meridian guides: orientation only, no lighting effects
      ctx.strokeStyle = outline; ctx.lineWidth = 1; ctx.globalAlpha = 0.9
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.03, 0, Math.PI * 2); ctx.stroke()
      ctx.globalAlpha = 0.5
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

      ctx.globalAlpha = 1
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
        ctx.strokeStyle = on ? accent : `rgba(${e.rgb[0]},${e.rgb[1]},${e.rgb[2]},${al})`
        ctx.globalAlpha = on ? al : 1
        const q = proj(e.c, k)
        ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.quadraticCurveTo(q[0], q[1], B.sx, B.sy); ctx.stroke()
      }
      ctx.globalAlpha = 1
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
        // a solid dot travelling the real relationship (no glow)
        ctx.globalAlpha = Math.sin(Math.PI * t) * 0.95; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill()
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
        ctx.globalAlpha = base; ctx.fillStyle = n.color
        ctx.beginPath(); ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2); ctx.fill()
        if (i === kbdRef.current) { ctx.globalAlpha = 1; ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(n.sx, n.sy, r + 5, 0, Math.PI * 2); ctx.stroke() }
        const f0 = st.flash.get(i)
        if (f0 !== undefined) {
          const age = (now - f0) / 1200
          if (age > 1) st.flash.delete(i)
          else { ctx.globalAlpha = (1 - age) * 0.9; ctx.strokeStyle = accent; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(n.sx, n.sy, r + 3 + age * 18, 0, Math.PI * 2); ctx.stroke() }
        }
        if (n.kind === 'agent' && n.status === 'running') { ctx.globalAlpha = 0.9; ctx.strokeStyle = accent; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(n.sx, n.sy, r + 4, 0, Math.PI * 2); ctx.stroke() }
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
        ctx.fillStyle = labelBg; ctx.globalAlpha *= 0.85
        ctx.beginPath(); ctx.roundRect(box[0], box[1], box[2], box[3], 7); ctx.fill()
        ctx.globalAlpha = i === focus ? 1 : Math.min(1, 0.45 + (n.sz + 0.2) * 0.75)
        ctx.fillStyle = labelFg
        ctx.textAlign = 'left'
        ctx.fillText(txt, x0, n.sy + 4)
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [G, w, height, prefs])

  // Keyboard: arrows rotate, N / P step through the main entities, Enter inspects, Escape clears.
  const stepOrder = useMemo(() => (G ? [...G.nodes.keys()].filter((i) => G.nodes[i].prio >= 5).sort((a, b) => G.nodes[b].prio - G.nodes[a].prio) : []), [G])
  const onKey = (e: React.KeyboardEvent) => {
    const st = S.current
    const nudge: Record<string, [number, number]> = { ArrowLeft: [-0.06, 0], ArrowRight: [0.06, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }
    if (nudge[e.key]) {
      e.preventDefault(); st.yaw += nudge[e.key][0]; st.pitch = Math.max(-1.1, Math.min(1.1, st.pitch + nudge[e.key][1])); st.dirty = true
    } else if ((e.key === 'n' || e.key === 'p') && stepOrder.length && G) {
      e.preventDefault()
      const pos = stepOrder.indexOf(kbd)
      const next = stepOrder[(pos + (e.key === 'n' ? 1 : stepOrder.length - 1) + (pos < 0 && e.key === 'p' ? 1 : 0)) % stepOrder.length]
      setKbd(next)
      const n = G.nodes[next]
      setLive(`${n.label}, ${n.kind.replace('_', ' ')}, ${n.deg} recorded relationship${n.deg === 1 ? '' : 's'}. Press Enter to inspect.`)
    } else if (e.key === 'Enter' && kbd >= 0 && G) {
      e.preventDefault(); onSelect?.(G.nodes[kbd])
    } else if (e.key === 'Escape') {
      setKbd(-1); onSelect?.(null)
    }
  }

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
    <div ref={wrap} className="relative w-full select-none" style={{ height }}>
      <canvas ref={canvas} role="application" tabIndex={0} onKeyDown={onKey} onBlur={() => setKbd(-1)}
        aria-roledescription="interactive network"
        aria-label={G ? `Research network: ${G.nodes.length} entities and ${G.edges.length} recorded relationships. Arrow keys rotate, N and P step through the main entities, Enter inspects, Escape clears.` : 'Research network loading'}
        className="absolute inset-0 cursor-grab rounded-[14px] active:cursor-grabbing" style={{ width: w, height, touchAction: 'pan-y' }}
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
      <span className="sr-only" aria-live="polite">{live}</span>
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
