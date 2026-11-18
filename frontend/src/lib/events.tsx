import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import type { AtlasEvent } from './types'

type Listener = (e: AtlasEvent) => void

interface EventCtx {
  events: AtlasEvent[]
  connected: boolean
  subscribe: (l: Listener) => () => void
  rate: number // events per minute (rolling)
}

const Ctx = createContext<EventCtx>({ events: [], connected: false, subscribe: () => () => {}, rate: 0 })

/** Single WebSocket to /api/ws shared by the whole app. Seeds with recent persisted events. */
export function EventProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<AtlasEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [rate, setRate] = useState(0)
  const listeners = useRef(new Set<Listener>())
  const stamps = useRef<number[]>([])

  useEffect(() => {
    api.get<AtlasEvent[]>('/events?limit=150').then((rows) => setEvents(rows)).catch(() => {})
    let ws: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/ws`)
      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (!closed) retry = window.setTimeout(connect, 2500)
      }
      ws.onerror = () => ws?.close()
      ws.onmessage = (m) => {
        const ev = JSON.parse(m.data) as AtlasEvent
        if (ev.category === 'heartbeat') return
        stamps.current.push(Date.now())
        setEvents((prev) => [ev, ...prev].slice(0, 400))
        listeners.current.forEach((l) => l(ev))
      }
    }
    connect()
    const t = window.setInterval(() => {
      const cutoff = Date.now() - 60_000
      stamps.current = stamps.current.filter((s) => s > cutoff)
      setRate(stamps.current.length)
    }, 2000)
    return () => {
      closed = true
      window.clearTimeout(retry)
      window.clearInterval(t)
      ws?.close()
    }
  }, [])

  const subscribe = (l: Listener) => {
    listeners.current.add(l)
    return () => { listeners.current.delete(l) }
  }
  return <Ctx.Provider value={{ events, connected, subscribe, rate }}>{children}</Ctx.Provider>
}

export const useEvents = () => useContext(Ctx)

/** Invoke `fn` whenever an event matching `filter` arrives (used to refresh views on real changes). */
export function useEventTrigger(filter: (e: AtlasEvent) => boolean, fn: () => void, debounceMs = 600) {
  const { subscribe } = useEvents()
  const fnRef = useRef(fn)
  const filterRef = useRef(filter)
  useEffect(() => {
    fnRef.current = fn
    filterRef.current = filter
  })
  useEffect(() => {
    let t: number | undefined
    const un = subscribe((e) => {
      if (!filterRef.current(e) || t !== undefined) return
      t = window.setTimeout(() => { t = undefined; fnRef.current() }, debounceMs)
    })
    return () => {
      un()
      window.clearTimeout(t)
    }
  }, [subscribe, debounceMs])
}
