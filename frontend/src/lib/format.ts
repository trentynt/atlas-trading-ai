import type { Num } from './types'

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

export const pct = (x: Num | undefined, d = 2, sign = true) =>
  isNum(x) ? `${sign && x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—'

export const num = (x: Num | undefined, d = 2) => (isNum(x) ? x.toFixed(d) : '—')

export const money = (x: Num | undefined, d = 0) =>
  isNum(x) ? x.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: d, minimumFractionDigits: d }) : '—'

export const compact = (x: Num | undefined) =>
  isNum(x) ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(x) : '—'

export const price = (x: Num | undefined, decimals = 4) => (isNum(x) ? x.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : '—')

export const tone = (x: Num | undefined) => (!isNum(x) ? 'text-ink-200' : x > 0 ? 'text-up' : x < 0 ? 'text-dn' : 'text-ink-100')

export function ago(iso: string | null | undefined) {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').getTime()) / 1000
  if (s < 60) return `${Math.max(0, Math.floor(s))}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const time = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

export function duration(sec: Num | undefined) {
  if (!isNum(sec)) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

export const strategyLabel = (k: string | null | undefined) => (k ?? '').replace(/_/g, ' ')
