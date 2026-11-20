import { useSyncExternalStore } from 'react'

/** Display preferences. Stored per browser (a convenience, not account data); every read is guarded
 *  because storage can be unavailable (private windows, blocked site data). */
export interface Prefs {
  motion: 'system' | 'reduced' | 'full'
  updown: 'green-up' | 'red-up'
  sphereStrands: boolean // decorative haze: off by default
  sphereSpin: boolean // camera rotation: off by default
}

const KEY = 'signal.prefs.v1'
const DEFAULTS: Prefs = { motion: 'system', updown: 'green-up', sphereStrands: false, sphereSpin: false }
const listeners = new Set<() => void>()

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

let current: Prefs = read()

export function applyPrefs(p: Prefs = current) {
  const root = document.documentElement
  if (p.motion === 'system') delete root.dataset.motion
  else root.dataset.motion = p.motion
  if (p.updown === 'green-up') delete root.dataset.updown
  else root.dataset.updown = p.updown
}

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* storage unavailable: the preference still applies for this session */
  }
  applyPrefs(current)
  listeners.forEach((l) => l())
}

export function usePrefs(): Prefs {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => current, () => DEFAULTS)
}

/** True when non-essential motion should be suppressed (app setting, else the OS setting). */
export function reducedMotion(p: Prefs = current): boolean {
  if (p.motion === 'reduced') return true
  if (p.motion === 'full') return false
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Resolve `var(--token)` to its current value for canvas drawing (canvas cannot read CSS variables). */
export function resolve(color: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color.trim())
  if (!m || typeof document === 'undefined') return color
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || color
}

/** Hex colour with alpha, e.g. alpha('var(--positive)', 0.6) → '#3dd68c99'. */
export function alpha(color: string, a: number): string {
  const c = resolve(color)
  if (!/^#[0-9a-f]{6}$/i.test(c)) return c
  return c + Math.round(a * 255).toString(16).padStart(2, '0')
}
