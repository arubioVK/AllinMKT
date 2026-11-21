import { Check, TriangleAlert, Clapperboard, Loader2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { ContentContext, ContentSeries, Script, ScriptStatus } from '@shared/types'
import { SCRIPT_STATUS_LABEL } from '@shared/types'
import { cx, PlatformList } from '../../components/ui'
import { shortDate } from '../../lib/format'
import { api } from '../../lib/api'
import { useJobs } from '../../lib/jobs'
import { t } from '../../lib/i18n'

/** Pastilla seleccionable para elegir contextos, personajes, redes... */
export function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full text-[13px] transition-colors',
        active ? 'bg-raised text-ink' : 'text-muted ring-1 ring-inset ring-[#2a2a2a] hover:text-ink'
      )}
    >
      {active && <Check size={13} />}
      {children}
    </button>
  )
}

export function ChipGroup({ children, empty }: { children: ReactNode[]; empty?: ReactNode }) {
  if (!children.length) return <p className="text-[13px] text-faint">{empty}</p>
  return <div className="flex flex-wrap gap-2">{children}</div>
}

export const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

const STATUS_TONE: Record<ScriptStatus, string> = {
  draft: 'bg-neutral-bg text-muted',
  approved: 'bg-pos-bg text-positive',
  used: 'bg-neutral-bg text-ink',
  discarded: 'bg-neg-bg text-neg-ink'
}

export function ScriptStatusPill({ status }: { status: ScriptStatus }) {
  return <span className={cx('inline-flex items-center h-[22px] px-2.5 rounded-full text-[12px] font-medium whitespace-nowrap', STATUS_TONE[status])}>{t(SCRIPT_STATUS_LABEL[status])}</span>
}

export function SimilarNote({ s }: { s: Script }) {
  if (!s.similarTo) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-warning" title={t('Parecido de palabras con una pieza anterior')}>
      <TriangleAlert size={13} />
      {t('Se parece a «{title}» ({pct} %)', { title: s.similarTo.title, pct: Math.round(s.similarTo.score * 100) })}
    </span>
  )
}

export interface Lookup {
  ctx: Map<string, ContentContext>
  series: Map<string, ContentSeries>
}

export function scriptMeta(s: Script, l: Lookup): string {
  const parts = [
    s.seriesId && `${l.series.get(s.seriesId)?.name ?? t('Serie')} · ${t('ep. {n}', { n: s.episode ?? '' })}`,
    s.templateId && l.ctx.get(s.templateId)?.name,
    s.styleId ? l.ctx.get(s.styleId)?.name : t('Estilo libre'),
    s.characterIds.map((id) => l.ctx.get(id)?.name).filter(Boolean).join(', ')
  ]
  return parts.filter(Boolean).join(' · ')
}

/** Estado del vídeo en la tarjeta: listo, generándose o la pista de dónde se genera. */
function VideoBadge({ s }: { s: Script }) {
  const running = useJobs().some((j) => j.kind === 'video' && j.refId === s.id && j.status === 'running')
  if (s.format !== 'short' && s.format !== 'video') return null
  if (running) {
    return (
      <p className="flex items-center gap-1.5 mt-3 text-[12px] text-accent">
        <Loader2 size={13} className="animate-[spin_0.8s_linear_infinite]" />{' '}{t('Generando vídeo…')}
      </p>
    )
  }
  if (s.video) {
    return (
      <p className="flex items-center gap-1.5 mt-3 text-[12px] text-positive tnum">
        <Clapperboard size={13} />{' '}{t('Vídeo listo · {n} s', { n: s.video.durationSec })}
      </p>
    )
  }
  return (
    <p className="flex items-center gap-1.5 mt-3 text-[12px] text-faint">
      <Clapperboard size={13} />{' '}{t('Ábrelo para generar el vídeo')}
    </p>
  )
}

export function ScriptCard({ s, lookup, onOpen }: { s: Script; lookup: Lookup; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="w-full text-left bg-surface hover:bg-hover rounded-[20px] p-[18px] transition-colors anim-rise">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[12px] text-faint truncate">{scriptMeta(s, lookup)}</p>
          <h3 className="text-[15px] font-semibold leading-snug mt-1">{s.title}</h3>
        </div>
        <ScriptStatusPill status={s.status} />
      </div>
      <p className="text-[14px] mt-2">“{s.hook}”</p>
      <p className="text-[13px] text-muted mt-1.5 line-clamp-2">{s.summary}</p>
      <div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
        <PlatformList platforms={s.platforms} />
        <span className="text-[12px] text-faint tnum">{shortDate(s.createdAt.slice(0, 10))}</span>
      </div>
      {s.similarTo && <div className="mt-2"><SimilarNote s={s} /></div>}
      <VideoBadge s={s} />
    </button>
  )
}

/** Miniatura de una imagen de referencia guardada en la app. */
export function RefImage({ file, className, onClick }: { file: string; className?: string; onClick?: () => void }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let alive = true
    void api.content.image(file).then((u) => alive && setSrc(u)).catch(() => {})
    return () => {
      alive = false
    }
  }, [file])
  const img = src && <img src={src} alt="" className="w-full h-full object-contain" />
  const cls = cx('block bg-ground rounded-xl overflow-hidden', className)
  // Sin onClick es un div: así puede ir dentro de otra tarjeta que ya es un botón.
  if (!onClick) return <div className={cls}>{img}</div>
  return (
    <button type="button" onClick={onClick} title={t('Mostrar en la carpeta')} className={cls}>
      {img}
    </button>
  )
}
