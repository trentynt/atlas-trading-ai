import { useCallback, useEffect, useRef, useState } from 'react'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const d = data as { detail?: unknown }
    const msg = typeof d?.detail === 'string' ? d.detail : Array.isArray(d?.detail)
      ? (d.detail as { msg: string; loc: string[] }[]).map((x) => `${x.loc?.slice(1).join('.')}: ${x.msg}`).join('; ')
      : `HTTP ${res.status}`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
}

export const slug = (s: string) => s.replace('/', '-')

/** Fetch + optional polling. `deps` change triggers reload. */
export function useApi<T>(path: string | null, opts: { poll?: number; deps?: unknown[] } = {}) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const mounted = useRef(true)
  const load = useCallback(async () => {
    if (!path) return
    setLoading(true)
    try {
      const d = await api.get<T>(path)
      if (mounted.current) {
        setData(d)
        setError(null)
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [path])
  useEffect(() => {
    mounted.current = true
    load()
    if (!opts.poll) return () => { mounted.current = false }
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, opts.poll)
    return () => {
      mounted.current = false
      window.clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, opts.poll, ...(opts.deps ?? [])])
  return { data, error, loading, reload: load, setData }
}

/** Run a mutation with pending/error state. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    setPending(true)
    setError(null)
    try {
      return await fn(...a)
    } catch (e) {
      setError((e as Error).message)
      return undefined
    } finally {
      setPending(false)
    }
  }, [fn])
  return { run, pending, error, setError }
}
