import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/* ─────────────────────────────────────────────────────────────────────────────
   SIGNAL component library. One design language for every workspace.
   ───────────────────────────────────────────────────────────────────────────── */

// Categorical series palette — validated (dataviz validate_palette.js, dark mode): lightness band, chroma,
// CVD ΔE ≥ 16.7, normal-vision ΔE ≥ 21, contrast ≥ 3:1. Fixed order; never cycled.
export const SERIES = ['#0f9cb4', '#c87d0e', '#9575ee', '#e2557a'] as const
export const NEUTRAL = 'var(--text-2)' // benchmarks / reference lines
export const UP = 'var(--positive)' // follows the price-colour preference
export const DN = 'var(--negative)'
export const ACCENT = 'var(--brand)'

/* ── layout ──────────────────────────────────────────────────────────────── */

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-[13px] font-medium text-cy">{eyebrow}</div>}
        <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.025em] text-white">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-[760px] text-[14px] leading-relaxed text-ink-200">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Panel({ title, kicker, right, children, className = '', bodyClass = '', tag, subtitle }: {
  title?: ReactNode
  kicker?: string
  right?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  tag?: ReactNode
  subtitle?: ReactNode
}) {
  return (
    <section className={`panel flex min-w-0 flex-col ${className}`}>
      {(title || right) && (
        <header className="flex min-h-[52px] flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-5 pt-4 pb-2">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {kicker && <span className="text-[12px] font-medium text-cy">{kicker}</span>}
              <h2 className="truncate text-[15px] font-semibold tracking-[-0.012em] text-white">{title}</h2>
              {tag}
            </div>
            {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-300">{subtitle}</p>}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">{right}</div>
        </header>
      )}
      <div className={`min-h-0 flex-1 px-5 pt-2 pb-5 ${bodyClass}`}>{children}</div>
    </section>
  )
}
export const Card = Panel

export function Stat({ label, value, sub, valueClass = '', help }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string; help?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1"><span className="label truncate">{label}</span>{help && <InfoTip text={help} />}</div>
      <div className={`num mt-1 truncate text-[22px] leading-tight text-white ${valueClass}`}>{value}</div>
      {sub !== undefined && <div className="mt-0.5 truncate text-[12px] text-ink-300">{sub}</div>}
    </div>
  )
}

/** Large hero metric. */
export function Metric({ label, value, delta, deltaTone, sub }: { label: string; value: ReactNode; delta?: ReactNode; deltaTone?: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="num text-[30px] leading-none tracking-[-0.03em] text-white">{value}</span>
        {delta !== undefined && <span className={`num text-[14px] ${deltaTone ?? 'text-ink-200'}`}>{delta}</span>}
      </div>
      {sub && <div className="mt-1.5 text-[12.5px] text-ink-300">{sub}</div>}
    </div>
  )
}

/* ── status ──────────────────────────────────────────────────────────────── */

export type Tone = 'cy' | 'am' | 'vi' | 'up' | 'dn' | 'mute' | 'bl'
const toneCls: Record<Tone, string> = {
  cy: 'text-cy bg-cy/[0.12]',
  am: 'text-am bg-am/[0.13]',
  vi: 'text-vi bg-vi/[0.14]',
  up: 'text-up bg-up/[0.12]',
  dn: 'text-dn bg-dn/[0.14]',
  bl: 'text-bl bg-bl/[0.12]',
  mute: 'text-ink-200 bg-white/[0.07]',
}
export const toneText: Record<Tone, string> = { cy: 'text-cy', am: 'text-am', vi: 'text-vi', up: 'text-up', dn: 'text-dn', bl: 'text-bl', mute: 'text-ink-300' }

export function Badge({ children, tone = 'mute', dot = false, title }: { children: ReactNode; tone?: Tone; dot?: boolean; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11.5px] leading-[1.3] font-medium whitespace-nowrap ${toneCls[tone]}`}>
      {dot && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

export function StatusDot({ tone = 'mute', pulse = false, label }: { tone?: Tone; pulse?: boolean; label?: string }) {
  return <span role={label ? 'img' : undefined} aria-label={label} className={`inline-block h-2 w-2 shrink-0 rounded-full bg-current ${toneText[tone]} ${pulse ? 'pulse-dot' : ''}`} />
}

/** Provenance labels — every visual states what kind of data it shows. */
export const LiveTag = ({ what = 'Live data' }: { what?: string }) => <Badge tone="cy">{what}</Badge>
export const SimTag = () => <Badge tone="am">Paper trading · simulated</Badge>
export const HistTag = () => <Badge tone="vi">Historical simulation</Badge>

/* ── controls ────────────────────────────────────────────────────────────── */

export function Button({ children, onClick, tone = 'default', disabled, small, type = 'button', title, icon, className = '' }: {
  children?: ReactNode
  onClick?: () => void
  tone?: 'default' | 'primary' | 'danger' | 'ghost' | 'plain'
  disabled?: boolean
  small?: boolean
  type?: 'button' | 'submit'
  title?: string
  icon?: ReactNode
  className?: string
}) {
  const t = {
    default: 'bg-white/[0.07] text-ink-100 ring-1 ring-inset ring-white/[0.08] hover:bg-white/[0.11] hover:text-white',
    primary: 'bg-cy text-bg font-semibold hover:brightness-110',
    danger: 'bg-dn/[0.13] text-dn ring-1 ring-inset ring-dn/25 hover:bg-dn/[0.2]',
    ghost: 'bg-transparent text-cy hover:bg-cy/[0.08]',
    plain: 'bg-transparent text-ink-200 hover:bg-white/[0.06] hover:text-white',
  }[tone]
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-[background-color,color,transform,box-shadow] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 ${small ? 'h-[28px] rounded-[8px] px-2.5 text-[12.5px]' : 'h-[36px] rounded-[11px] px-4 text-[13.5px]'} ${t} ${className}`}>
      {icon}
      {children}
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  return (
    <div role="tablist" className="inline-flex flex-wrap rounded-[10px] bg-white/[0.06] p-[3px]">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={`rounded-[8px] font-medium transition-all duration-200 ease-out ${size === 'sm' ? 'px-2.5 py-[3px] text-[12px]' : 'px-3 py-[5px] text-[12.5px]'} ${value === o.value ? 'bg-white/[0.13] text-white shadow-[0_1px_2px_rgba(0,0,0,0.35)]' : 'text-ink-300 hover:text-white'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-5 border-b border-white/[0.07]">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2.5 text-[13.5px] font-medium transition-colors ${value === o.value ? 'border-cy text-white' : 'border-transparent text-ink-300 hover:text-ink-100'}`}>
          {o.label}
          {o.count !== undefined && <span className="rounded-full bg-white/[0.08] px-1.5 text-[11px] text-ink-200">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-1"><span className="label">{label.replace(/_/g, ' ')}</span>{hint && <InfoTip text={hint} />}</span>
      {children}
    </label>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-100 select-none">
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 ${checked ? 'bg-cy' : 'bg-white/[0.14]'}`}>
        <span className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-[left] duration-200 ease-out ${checked ? 'left-[18px]' : 'left-[2px]'}`} />
      </button>
      {label}
    </label>
  )
}

/* ── feedback & states ──────────────────────────────────────────────────── */

export function ErrorBox({ error, onRetry }: { error: string | null | undefined; onRetry?: () => void }) {
  if (!error) return null
  return (
    <div role="alert" className="flex items-start gap-3 rounded-[12px] bg-dn/[0.1] px-4 py-3 text-[13px] leading-snug text-dn ring-1 ring-inset ring-dn/20">
      <svg viewBox="0 0 20 20" className="mt-[1px] h-4 w-4 shrink-0" fill="currentColor" aria-hidden><path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-.75 4h1.5v5h-1.5V6Zm0 6.5h1.5V14h-1.5v-1.5Z" /></svg>
      <span className="flex-1">{error}</span>
      {onRetry && <button onClick={onRetry} className="font-medium underline-offset-2 hover:underline">Try again</button>}
    </div>
  )
}

export function Notice({ tone = 'mute', title, children }: { tone?: Tone; title?: ReactNode; children: ReactNode }) {
  const ring = { cy: 'ring-cy/20 bg-cy/[0.06]', am: 'ring-am/25 bg-am/[0.07]', vi: 'ring-vi/20 bg-vi/[0.06]', up: 'ring-up/20 bg-up/[0.06]', dn: 'ring-dn/25 bg-dn/[0.08]', bl: 'ring-bl/20 bg-bl/[0.06]', mute: 'ring-white/[0.07] bg-white/[0.03]' }[tone]
  return (
    <div className={`rounded-[12px] px-4 py-3 text-[13px] leading-relaxed text-ink-200 ring-1 ring-inset ${ring}`}>
      {title && <div className={`mb-0.5 font-semibold ${toneText[tone] === 'text-ink-300' ? 'text-white' : toneText[tone]}`}>{title}</div>}
      {children}
    </div>
  )
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[140px] flex-col items-center justify-center px-6 py-8 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.05] text-ink-300">
        {icon ?? <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><circle cx="12" cy="12" r="8" /><path d="M8.5 12h7" strokeLinecap="round" /></svg>}
      </div>
      <div className="text-[14px] font-medium text-white">{title}</div>
      {children && <div className="mt-1 max-w-[420px] text-[13px] leading-relaxed text-ink-300">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** Backwards-compatible lightweight empty message. */
export function Empty({ children }: { children: ReactNode }) {
  if (typeof children === 'string' && /^loading/i.test(children)) return <Loading />
  return <div className="flex h-full min-h-[90px] items-center justify-center px-4 text-center text-[13px] leading-relaxed text-ink-300">{children}</div>
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} className="spin text-cy" fill="none" role="img" aria-label="Working"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="2.5" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 py-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className={`h-3.5 ${['w-full', 'w-4/5', 'w-3/5', 'w-2/3'][i % 4]}`} />)}
    </div>
  )
}

export function Meter({ value, limit, invert = false }: { value: number; limit: number; invert?: boolean }) {
  // utilisation of a limit; status colour is always paired with a numeric label (never colour alone)
  const u = Math.min(1.2, Math.abs(value) / Math.abs(limit || 1))
  const status = u >= 1 ? 'bg-dn' : u >= 0.75 ? 'bg-am' : 'bg-cy'
  return (
    <div className="h-[6px] w-full overflow-hidden rounded-full bg-white/[0.07]" aria-hidden>
      <div className={`h-full rounded-full transition-[width] duration-700 ease-out ${status} ${invert ? 'ml-auto' : ''}`} style={{ width: `${Math.max(u > 0 ? 2 : 0, Math.min(100, u * 100))}%` }} />
    </div>
  )
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-[12px] text-ink-200">
          <span className="inline-block h-[3px] w-4 rounded-full" style={{ background: i.dashed ? `repeating-linear-gradient(90deg, ${i.color} 0 4px, transparent 4px 7px)` : i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

/* ── tooltips & disclosure ──────────────────────────────────────────────── */

export function Tooltip({ text, children }: { text: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      <span aria-describedby={open ? id : undefined}>{children}</span>
      {open && (
        <span id={id} role="tooltip" className="dialog-in pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-50 w-max max-w-[280px] -translate-x-1/2 rounded-[10px] bg-[#232a33] px-3 py-2 text-[12px] leading-snug font-normal text-ink-100 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7)] ring-1 ring-white/[0.08]">
          {text}
        </span>
      )}
    </span>
  )
}

export function InfoTip({ text }: { text: ReactNode }) {
  return (
    <Tooltip text={text}>
      <span tabIndex={0} aria-label="More information" className="inline-flex h-[15px] w-[15px] cursor-help items-center justify-center rounded-full bg-white/[0.08] text-[10px] font-semibold text-ink-300 hover:text-white">i</span>
    </Tooltip>
  )
}

export function Disclosure({ title, children, defaultOpen = false, meta }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; meta?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-[12px] ring-1 ring-inset ring-white/[0.06]">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-medium text-ink-100 hover:text-white">
        <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 text-ink-300 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} fill="currentColor" aria-hidden><path d="M6 3.5 10.5 8 6 12.5V3.5Z" /></svg>
        <span className="flex-1">{title}</span>
        {meta && <span className="text-[12px] font-normal text-ink-300">{meta}</span>}
      </button>
      {open && <div className="fade-in px-4 pb-4">{children}</div>}
    </div>
  )
}

/* ── overlays ───────────────────────────────────────────────────────────── */

function useEscape(onClose: () => void) {
  const ref = useRef(onClose)
  useEffect(() => { ref.current = onClose })
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
}

/** Move focus into an open overlay, keep Tab inside it, and return focus where it was on close. */
export function useFocusTrap<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    const items = () => (ref.current ? [...ref.current.querySelectorAll<HTMLElement>(sel)] : [])
    const t = window.setTimeout(() => (items()[0] ?? ref.current)?.focus(), 0)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current) return
      const f = items()
      if (!f.length) return
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus() }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { window.clearTimeout(t); document.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [open])
  return ref
}

export function Drawer({ open, onClose, title, children, width = 520, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEscape(onClose)
  const trap = useFocusTrap<HTMLElement>(open)
  const titleId = useId()
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="scrim-in absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={onClose} />
      <aside ref={trap} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="drawer-in absolute top-0 right-0 flex h-full flex-col border-l border-border bg-raised shadow-[-30px_0_80px_-20px_rgba(0,0,0,0.8)]"
        style={{ width: `min(${width}px, 100vw)` }}>
        <header className="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
          <div id={titleId} className="min-w-0 text-[17px] font-semibold tracking-[-0.015em] text-white">{title}</div>
          <button onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-ink-200 hover:bg-white/[0.12] hover:text-white">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        {footer && <footer className="hairline-t flex flex-wrap items-center justify-end gap-2 px-6 py-4">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  )
}

export function Dialog({ open, onClose, title, children, actions }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  useEscape(onClose)
  const trap = useFocusTrap<HTMLDivElement>(open)
  const titleId = useId()
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="scrim-in absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />
      <div ref={trap} role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="dialog-in relative w-full max-w-[440px] rounded-[20px] border border-border bg-raised p-6 shadow-[0_40px_100px_-20px_rgba(0,0,0,0.85)]">
        <div id={titleId} className="text-[17px] font-semibold tracking-[-0.015em] text-white">{title}</div>
        <div className="mt-2 text-[13.5px] leading-relaxed text-ink-200">{children}</div>
        {actions && <div className="mt-6 flex flex-wrap justify-end gap-2">{actions}</div>}
      </div>
    </div>,
    document.body,
  )
}

/** Confirmation dialog hook — replaces window.confirm with a consistent dialog. */
export function useConfirm() {
  const [state, setState] = useState<null | { title: string; body: ReactNode; confirm: string; danger?: boolean; resolve: (v: boolean) => void }>(null)
  const ask = (title: string, body: ReactNode, confirm = 'Confirm', danger = false) =>
    new Promise<boolean>((resolve) => setState({ title, body, confirm, danger, resolve }))
  const close = (v: boolean) => { state?.resolve(v); setState(null) }
  const node = (
    <Dialog open={!!state} onClose={() => close(false)} title={state?.title}
      actions={<><Button onClick={() => close(false)}>Cancel</Button><Button tone={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirm}</Button></>}>
      {state?.body}
    </Dialog>
  )
  return { ask, node }
}

/* ── small helpers ──────────────────────────────────────────────────────── */

export function Sparkline({ values, color = ACCENT, height = 36, fill = true, minRange = 0 }: { values: number[]; color?: string; height?: number; fill?: boolean; minRange?: number }) {
  if (values.length < 2) return <div style={{ height }} />
  let lo = Math.min(...values), hi = Math.max(...values)
  if (hi - lo < minRange) { const mid = (hi + lo) / 2; lo = mid - minRange / 2; hi = mid + minRange / 2 } // honest scale for small moves
  const W = 100
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, hi === lo ? height / 2 : height - 2 - ((v - lo) / (hi - lo)) * (height - 4)])
  const d = `M${pts.map((p) => p.join(',')).join(' L')}`
  const gid = `sg${color.replace('#', '')}${height}`
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }} aria-hidden>
      <defs><linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".28" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {fill && <path d={`${d} L${W},${height} L0,${height} Z`} fill={`url(#${gid})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

export function KeyValue({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="divide-y divide-white/[0.05]">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 py-2 text-[13px]">
          <dt className="text-ink-300">{k}</dt><dd className="tnum min-w-0 truncate text-right text-ink-100">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
