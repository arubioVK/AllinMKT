import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { cx } from './ui'

type Tone = 'info' | 'error' | 'success'
interface Toast { id: number; text: string; tone: Tone }

const Ctx = createContext<(text: string, tone?: Tone) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x, { id, text, tone }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'error' ? 8000 : 4000)
  }, [])
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed bottom-5 right-5 z-[60] flex flex-col gap-2 items-end pointer-events-none" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              'anim-rise pointer-events-auto max-w-[420px] rounded-2xl px-4 py-3 text-[13px] shadow-[0_8px_30px_rgba(0,0,0,0.6)]',
              t.tone === 'error' ? 'bg-neg-bg text-neg-ink' : t.tone === 'success' ? 'bg-pos-bg text-positive' : 'bg-raised text-ink'
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = (): ((text: string, tone?: Tone) => void) => useContext(Ctx)
