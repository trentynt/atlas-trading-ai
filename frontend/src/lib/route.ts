import { useEffect, useState } from 'react'

/** Hash routing: `#view?key=value`. View keys are the original stable route keys; friendly aliases map onto them. */
export type ViewKey = 'command' | 'markets' | 'research' | 'strategy' | 'forecast' | 'portfolio' | 'risk' | 'experiments' | 'telemetry' | 'intraday'

export const ALIASES: Record<string, ViewKey> = {
  overview: 'command', command: 'command', markets: 'markets', research: 'research', strategies: 'strategy', strategy: 'strategy',
  forecasts: 'forecast', forecast: 'forecast', portfolio: 'portfolio', risk: 'risk', discoveries: 'experiments',
  experiments: 'experiments', activity: 'telemetry', telemetry: 'telemetry', intraday: 'intraday',
}

export function parseHash(h = location.hash): { view: ViewKey; params: URLSearchParams } {
  const [path, query = ''] = h.replace(/^#/, '').split('?')
  return { view: ALIASES[path] ?? 'command', params: new URLSearchParams(query) }
}

export function navigate(view: ViewKey, params?: Record<string, string | number | undefined>) {
  const q = new URLSearchParams()
  Object.entries(params ?? {}).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, String(v)) })
  const next = `#${view}${q.toString() ? `?${q}` : ''}`
  if (location.hash !== next) location.hash = next
}

export function useRoute() {
  const [r, setR] = useState(() => parseHash())
  useEffect(() => {
    const on = () => setR(parseHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return r
}

/** A single route parameter, kept in the URL so views are deep-linkable and shareable. */
export function useParam(key: string, fallback: string): [string, (v: string) => void] {
  const { view, params } = useRoute()
  const value = params.get(key) ?? fallback
  const set = (v: string) => {
    const p = Object.fromEntries(parseHash().params)
    navigate(view, { ...p, [key]: v })
  }
  return [value, set]
}

export const symToParam = (s: string) => s.replace('/', '-')
export const paramToSym = (s: string) => s.replace('-', '/').toUpperCase()
