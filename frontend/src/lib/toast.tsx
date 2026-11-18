import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

type ToastTone = 'info' | 'success' | 'warning' | 'error'
interface Toast { id: number; title: string; body?: string; tone: ToastTone }

const Ctx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {})

/** App-wide notifications. Stacks bottom-right, auto-dismiss after 5 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([])
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random()
    setList((l) => [...l.slice(-3), { ...t, id }])
    window.setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 5000)
  }, [])
  const color = { info: 'bg-cy', success: 'bg-up', warning: 'bg-am', error: 'bg-dn' }
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2">
        {list.map((t) => (
          <div key={t.id} className="toast-in pointer-events-auto flex gap-3 rounded-[14px] border border-white/[0.09] bg-[rgba(24,29,36,0.96)] px-4 py-3 shadow-[0_18px_48px_-12px_rgba(0,0,0,0.8)] backdrop-blur-xl">
            <span className={`mt-[6px] h-2 w-2 shrink-0 rounded-full ${color[t.tone]}`} />
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-white">{t.title}</div>
              {t.body && <div className="mt-0.5 text-[12.5px] leading-snug text-ink-200">{t.body}</div>}
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
