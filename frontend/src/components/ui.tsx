import type { ReactNode } from 'react'

// Categorical series palette — validated (dataviz validate_palette.js, dark mode vs #070b12):
// lightness band, chroma, CVD ΔE ≥ 16.7, normal-vision ΔE ≥ 21, contrast ≥ 3:1. Fixed order; never cycled.
export const SERIES = ['#0f9cb4', '#c87d0e', '#9575ee', '#e2557a'] as const
export const NEUTRAL = '#8ea2bd' // benchmarks / reference lines
export const UP = '#34d399'
export const DN = '#f87171'

export function Panel({ title, kicker, right, children, className = '', bodyClass = '', tag }: {
  title?: ReactNode
  kicker?: string
  right?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  tag?: ReactNode
}) {
  return (
    <section className={`panel flex min-w-0 flex-col ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-3 border-b border-ink-600/70 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {kicker && <span className="label text-cy/80">{kicker}</span>}
            <h2 className="truncate text-[12px] font-semibold tracking-wide text-ink-100">{title}</h2>
            {tag}
          </div>
          <div className="flex shrink-0 items-center gap-2">{right}</div>
        </header>
      )}
      <div className={`min-h-0 flex-1 p-3 ${bodyClass}`}>{children}</div>
    </section>
  )
}

export function Stat({ label, value, sub, valueClass = '' }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <div className="label truncate">{label}</div>
      <div className={`num mt-1 truncate text-[17px] font-medium text-white ${valueClass}`}>{value}</div>
      {sub !== undefined && <div className="mt-0.5 truncate text-[11px] text-ink-300">{sub}</div>}
    </div>
  )
}

type Tone = 'cy' | 'am' | 'vi' | 'up' | 'dn' | 'mute' | 'bl'
const toneCls: Record<Tone, string> = {
  cy: 'border-cy/40 text-cy bg-cy/5',
  am: 'border-am/40 text-am bg-am/5',
  vi: 'border-vi/40 text-vi bg-vi/5',
  up: 'border-up/40 text-up bg-up/5',
  dn: 'border-dn/40 text-dn bg-dn/5',
  bl: 'border-bl/40 text-bl bg-bl/5',
  mute: 'border-ink-500 text-ink-200 bg-ink-800',
}

export function Badge({ children, tone = 'mute', dot = false, title }: { children: ReactNode; tone?: Tone; dot?: boolean; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-[1px] font-mono text-[10px] uppercase tracking-wider ${toneCls[tone]}`}>
      {dot && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

/** Explicit provenance labels — every visual states whether it is backend data or illustrative. */
export const LiveTag = ({ what = 'BACKEND DATA' }: { what?: string }) => <Badge tone="cy">{what}</Badge>
export const SimTag = () => <Badge tone="am">SIMULATED · PAPER</Badge>
export const HistTag = () => <Badge tone="vi">HISTORICAL SIMULATION</Badge>

export function Button({ children, onClick, tone = 'default', disabled, small, type = 'button', title }: {
  children: ReactNode
  onClick?: () => void
  tone?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  small?: boolean
  type?: 'button' | 'submit'
  title?: string
}) {
  const t = {
    default: 'border-ink-500 bg-ink-700 text-ink-100 hover:border-cy/60 hover:text-white',
    primary: 'border-cy/60 bg-cy/10 text-cy hover:bg-cy/20',
    danger: 'border-dn/60 bg-dn/10 text-dn hover:bg-dn/20',
    ghost: 'border-transparent bg-transparent text-ink-200 hover:text-white',
  }[tone]
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 rounded-[4px] border font-mono uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${small ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1.5 text-[11px]'} ${t}`}>
      {children}
    </button>
  )
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  if (!error) return null
  return <div className="rounded border border-dn/40 bg-dn/5 px-3 py-2 font-mono text-[11px] text-dn">{error}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-[80px] items-center justify-center px-4 text-center text-[12px] text-ink-300">{children}</div>
}

export function Loading() {
  return <Empty><span className="pulse-dot font-mono text-[11px] uppercase tracking-widest">loading…</span></Empty>
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1" title={hint}>
      <span className="label">{label}</span>
      {children}
    </label>
  )
}

export function Meter({ value, limit, invert = false }: { value: number; limit: number; invert?: boolean }) {
  // utilisation of a limit, 0..1+ ; colour by status (with numeric label alongside — never colour alone)
  const u = Math.min(1.2, Math.abs(value) / Math.abs(limit || 1))
  const status = u >= 1 ? 'bg-dn' : u >= 0.75 ? 'bg-am' : 'bg-cy'
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700" aria-hidden>
      <div className={`h-full rounded-full ${status} ${invert ? 'ml-auto' : ''}`} style={{ width: `${Math.min(100, u * 100)}%` }} />
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-[4px] border border-ink-500 bg-ink-800 p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`rounded-[3px] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${value === o.value ? 'bg-cy/15 text-cy' : 'text-ink-200 hover:text-white'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-[11px] text-ink-200">
          <span className="inline-block h-[2px] w-3.5" style={{ background: i.dashed ? `repeating-linear-gradient(90deg, ${i.color} 0 3px, transparent 3px 5px)` : i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}
