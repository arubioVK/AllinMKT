import { clsx } from 'clsx'
import { X, Loader2, Maximize2, Minimize2 } from 'lucide-react'
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Platform, PostStatus } from '@shared/types'
import { PLATFORMS, POST_STATUS_LABEL } from '@shared/types'
import { t } from '../lib/i18n'

export const cx = clsx

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-[background,color,transform] duration-100 active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none',
        size === 'md' ? 'h-9 px-4 text-[14px]' : 'h-[30px] px-3 text-[13px]',
        variant === 'primary' && 'bg-ink text-black hover:bg-[#e6e6e6]',
        variant === 'secondary' && 'bg-raised text-ink hover:bg-[#363636]',
        variant === 'ghost' && 'text-muted hover:text-ink hover:bg-hover',
        variant === 'danger' && 'bg-neg-bg text-neg-ink hover:bg-[#3a1f28]',
        className
      )}
    >
      {loading ? <Loader2 size={15} className="animate-[spin_0.8s_linear_infinite]" /> : icon}
      {children}
    </button>
  )
}

export function Card({ children, className, title, action, subtitle }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cx('bg-surface rounded-[20px] p-[22px]', className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 mb-4">
          <div>
            {title && <h2 className="text-[16px] font-semibold leading-tight">{title}</h2>}
            {subtitle && <p className="text-[13px] text-faint mt-1">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-6 mb-6">
      <div className="min-w-0">
        <h1 className="text-[24px] font-semibold tracking-[-0.01em] leading-tight">{title}</h1>
        {subtitle && <p className="text-[15px] text-muted mt-1.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

/** Marca de plataforma: punto con su color de identidad y el nombre. */
export function PlatformDot({ platform, size = 8 }: { platform: Platform; size?: number }) {
  return <span className="inline-block rounded-full shrink-0" style={{ width: size, height: size, background: PLATFORMS[platform].color }} title={PLATFORMS[platform].name} />
}

export function PlatformList({ platforms, names = true }: { platforms: Platform[]; names?: boolean }) {
  return (
    <span className="inline-flex items-center gap-x-3 gap-y-1 flex-wrap">
      {platforms.map((p) => (
        <span key={p} className="inline-flex items-center gap-1.5 text-[13px] text-muted">
          <PlatformDot platform={p} />
          {names && PLATFORMS[p].name}
        </span>
      ))}
    </span>
  )
}

const STATUS_TONE: Record<PostStatus, string> = {
  idea: 'bg-neutral-bg text-faint',
  draft: 'bg-neutral-bg text-muted',
  scheduled: 'bg-neutral-bg text-ink',
  publishing: 'bg-warn-bg text-warning',
  published: 'bg-pos-bg text-positive',
  partial: 'bg-warn-bg text-warning',
  failed: 'bg-neg-bg text-neg-ink'
}

export function StatusPill({ status }: { status: PostStatus }) {
  return <span className={cx('inline-flex items-center h-[22px] px-2.5 rounded-full text-[12px] font-medium whitespace-nowrap', STATUS_TONE[status])}>{t(POST_STATUS_LABEL[status])}</span>
}

export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'pos' | 'neg' | 'warn'; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center h-[22px] px-2.5 rounded-full text-[12px] font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-neutral-bg text-ink',
        tone === 'pos' && 'bg-pos-bg text-positive',
        tone === 'neg' && 'bg-neg-bg text-neg-ink',
        tone === 'warn' && 'bg-warn-bg text-warning'
      )}
    >
      {children}
    </span>
  )
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="block mb-2">
      <span className="text-[13px] font-medium">{children}</span>
      {hint && <span className="block text-[12px] text-faint mt-0.5">{hint}</span>}
    </span>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative w-[34px] h-5 rounded-full transition-colors shrink-0', checked ? 'bg-ink' : 'bg-control')}
    >
      <span className={cx('absolute top-[3px] w-[14px] h-[14px] rounded-full transition-[left]', checked ? 'left-[17px] bg-black' : 'left-[3px] bg-[#b4b4b4]')} />
    </button>
  )
}

export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex bg-surface rounded-full p-1 gap-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={cx('h-7 px-3 rounded-full text-[13px] transition-colors', o.value === value ? 'bg-raised text-ink font-medium' : 'text-muted hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Preferencia de cada usuario: si amplía un panel, los siguientes se abren ampliados.
const WIDE_KEY = 'drawer-wide'
function readWide(): boolean {
  try {
    return localStorage.getItem(WIDE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Panel lateral. Ocupa al menos el 60 % de la ventana (los paneles llevan mucho texto) y se
 * puede ampliar casi a pantalla completa. Es un contenedor @container: el contenido puede
 * pasar a dos columnas con las variantes @4xl:/@5xl: cuando hay sitio.
 */
export function Drawer({ open, onClose, children, width = 760, title, footer }: { open: boolean; onClose: () => void; children: ReactNode; width?: number; title: ReactNode; footer?: ReactNode }) {
  const [wide, setWide] = useState(readWide)
  const toggleWide = (): void => {
    setWide(!wide)
    try {
      localStorage.setItem(WIDE_KEY, wide ? '0' : '1')
    } catch {
      // sin almacenamiento: solo dura mientras el panel está abierto
    }
  }
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  if (!open) return null
  // Portal a <body>: si un antepasado tiene transform (las animaciones de entrada de las vistas),
  // un position:fixed queda encerrado en él y el panel sale recortado en vez de cubrir la ventana.
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside
        className="@container relative h-full bg-surface anim-slide flex flex-col"
        // Ampliado deja una franja a la izquierda para ver dónde estabas y poder cerrar con un clic.
        style={{ width: wide ? 'calc(100vw - 56px)' : `min(max(${width}px, 60vw), 1440px, 100vw)` }}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-center justify-between gap-3 h-16 px-7 shrink-0">
          <h2 className="text-[17px] font-semibold truncate">{title}</h2>
          <div className="flex items-center gap-1 -mr-2 shrink-0">
            <button onClick={toggleWide} className="p-2 rounded-full text-muted hover:text-ink hover:bg-hover" aria-label={wide ? t('Reducir panel') : t('Ampliar panel')} title={wide ? t('Reducir panel') : t('Ampliar panel')}>
              {wide ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button onClick={onClose} className="p-2 rounded-full text-muted hover:text-ink hover:bg-hover" aria-label={t('Cerrar')}>
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto px-7 pb-7">{children}</div>
        {footer && <footer className="shrink-0 flex items-center gap-2 px-7 h-[68px] border-t border-rule">{footer}</footer>}
      </aside>
    </div>,
    document.body
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="py-8 px-2">
      <p className="text-[14px] font-medium">{title}</p>
      {children && <p className="text-[13px] text-faint mt-1 max-w-[52ch]">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-neg-ink bg-neg-bg rounded-xl px-3 py-2">{children}</p>
}
