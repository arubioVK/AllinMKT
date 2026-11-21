import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Download, CalendarSync } from 'lucide-react'
import type { Platform, Post } from '@shared/types'
import { FORMAT_LABEL, PLATFORM_IDS, PLATFORMS } from '@shared/types'
import { api } from '../lib/api'
import { useData } from '../lib/hooks'
import { localIso, timeLabel } from '../lib/format'
import { Button, cx, Empty, PageHeader, PlatformDot, PlatformList, Segmented, StatusPill } from '../components/ui'
import { useToast } from '../components/toast'
import { useNav } from '../App'
import { locale, t } from '../lib/i18n'

// Lunes a domingo con el nombre corto del idioma activo (5 de enero de 2026 fue lunes).
const weekdays = (): string[] => Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 5 + i).toLocaleDateString(locale(), { weekday: 'short' }).replace('.', '').replace(/^./, (c) => c.toUpperCase()))

function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1, 12)
  const start = new Date(first)
  start.setDate(1 - ((first.getDay() + 6) % 7))
  const days: Date[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    days.push(d)
  }
  // Si la última semana es entera del mes siguiente, la quitamos.
  return days[35].getMonth() !== month ? days.slice(0, 35) : days
}

/** Cada estado tiene su propia marca para leerse de un vistazo. */
function chipClass(p: Post): string {
  switch (p.status) {
    case 'scheduled':
    case 'publishing':
      return 'bg-raised text-ink'
    case 'published':
      return 'bg-[#161616] text-faint'
    case 'partial':
    case 'failed':
      return 'bg-neg-bg text-neg-ink'
    case 'idea':
      return 'text-faint border border-dashed border-[#3a3a3a]'
    default:
      return 'text-muted border border-dashed border-[#555]'
  }
}

export function CalendarView() {
  const nav = useNav()
  const toast = useToast()
  const today = new Date()
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() })
  const [mode, setMode] = useState<'month' | 'agenda'>('month')
  const [filter, setFilter] = useState<Platform[]>([])
  const [dragOver, setDragOver] = useState<string | null>(null)

  const days = useMemo(() => monthGrid(cursor.y, cursor.m), [cursor])
  const from = new Date(days[0])
  from.setHours(0, 0, 0, 0)
  const to = new Date(days[days.length - 1])
  to.setHours(23, 59, 59, 999)
  const { data: posts } = useData(() => api.posts.list(from.toISOString(), to.toISOString()), [cursor.y, cursor.m])

  const visible = (posts ?? []).filter((p) => filter.length === 0 || p.targets.some((tg) => filter.includes(tg.platform)))
  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>()
    for (const p of visible) {
      const k = localIso(new Date(p.scheduledAt))
      m.set(k, [...(m.get(k) ?? []), p])
    }
    return m
  }, [visible])

  const rawMonth = new Date(cursor.y, cursor.m, 1).toLocaleDateString(locale(), { month: 'long', year: 'numeric' })
  const monthLabel = rawMonth.charAt(0).toUpperCase() + rawMonth.slice(1)
  const move = (n: number): void => setCursor((c) => {
    const d = new Date(c.y, c.m + n, 1)
    return { y: d.getFullYear(), m: d.getMonth() }
  })

  const inMonth = visible.filter((p) => new Date(p.scheduledAt).getMonth() === cursor.m)
  const counts = {
    scheduled: inMonth.filter((p) => p.status === 'scheduled').length,
    drafts: inMonth.filter((p) => p.status === 'draft' || p.status === 'idea').length,
    published: inMonth.filter((p) => p.status === 'published' || p.status === 'partial').length
  }

  async function drop(day: string, id: string): Promise<void> {
    setDragOver(null)
    const p = posts?.find((x) => x.id === id)
    if (!p) return
    const old = new Date(p.scheduledAt)
    const next = new Date(`${day}T${String(old.getHours()).padStart(2, '0')}:${String(old.getMinutes()).padStart(2, '0')}`)
    if (localIso(old) === day) return
    try {
      await api.posts.save(id, { scheduledAt: next.toISOString() })
      toast(`${t('Movida al')} ${next.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' })}`)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="anim-rise">
      <PageHeader
        title={t('Calendario')}
        subtitle={t('{scheduled} programadas, {drafts} borradores e ideas y {published} publicadas en {month}.', { scheduled: counts.scheduled, drafts: counts.drafts, published: counts.published, month: new Date(cursor.y, cursor.m, 1).toLocaleDateString(locale(), { month: 'long' }) })}
        actions={
          <>
            <GoogleCalendarButtons />
            <Segmented value={mode} onChange={setMode} options={[{ value: 'month', label: t('Mes') }, { value: 'agenda', label: t('Agenda') }]} />
          </>
        }
      />

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => move(-1)} aria-label={t('Mes anterior')}><ChevronLeft size={16} /></Button>
          <Button size="sm" variant="ghost" onClick={() => move(1)} aria-label={t('Mes siguiente')}><ChevronRight size={16} /></Button>
        </div>
        <h2 className="text-[18px] font-semibold min-w-[170px]">{monthLabel}</h2>
        <Button size="sm" onClick={() => setCursor({ y: today.getFullYear(), m: today.getMonth() })}>{t('Hoy')}</Button>
        <div className="flex-1" />
        <div className="flex gap-1.5 flex-wrap">
          {PLATFORM_IDS.map((p) => {
            const on = filter.includes(p)
            return (
              <button key={p} onClick={() => setFilter(on ? filter.filter((x) => x !== p) : [...filter, p])} aria-pressed={on}
                className={cx('h-[30px] px-3 rounded-full inline-flex items-center gap-1.5 text-[13px] transition-colors', on ? 'bg-ink text-black' : 'bg-surface text-muted hover:text-ink')}>
                <PlatformDot platform={p} />
                {PLATFORMS[p].name}
              </button>
            )
          })}
        </div>
      </div>

      {mode === 'month' ? (
        <div className="bg-surface rounded-[20px] overflow-hidden">
          <div className="grid grid-cols-7">
            {weekdays().map((w, i) => (
              <div key={w} className={cx('px-3 h-9 flex items-center text-[12px] text-faint', i >= 5 && 'bg-[#0c0c0c]')}>{w}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((d, i) => {
              const key = localIso(d)
              const list = (byDay.get(key) ?? []).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
              const out = d.getMonth() !== cursor.m
              const isToday = key === localIso(today)
              const weekend = i % 7 >= 5
              return (
                <div
                  key={key}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOver(key)
                  }}
                  onDragLeave={() => setDragOver((k) => (k === key ? null : k))}
                  onDrop={(e) => void drop(key, e.dataTransfer.getData('text/post'))}
                  onDoubleClick={() => nav.edit({ date: key, platforms: filter.length ? filter : undefined })}
                  className={cx(
                    'group relative min-h-[128px] p-2 border-t border-rule [&:not(:nth-child(7n+1))]:border-l transition-colors',
                    weekend && 'bg-[#0c0c0c]',
                    dragOver === key && 'bg-[#1d2410]'
                  )}
                >
                  <div className="flex items-center justify-between mb-1.5 px-1">
                    <span className={cx('text-[13px] tnum', isToday ? 'h-6 min-w-6 px-1.5 rounded-full bg-accent text-black font-semibold grid place-items-center' : out ? 'text-[#555]' : 'text-muted')}>
                      {d.getDate()}
                    </span>
                    <button onClick={() => nav.edit({ date: key, platforms: filter.length ? filter : undefined })}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded-md text-faint hover:text-ink hover:bg-hover transition-opacity" aria-label={t('Nueva publicación el {date}', { date: key })}>
                      <Plus size={14} />
                    </button>
                  </div>
                  <div className="flex flex-col gap-1">
                    {list.slice(0, 4).map((p) => (
                      <button
                        key={p.id}
                        draggable={!['published', 'partial', 'publishing'].includes(p.status)}
                        onDragStart={(e) => e.dataTransfer.setData('text/post', p.id)}
                        onClick={() => nav.edit({ id: p.id })}
                        title={`${timeLabel(p.scheduledAt)} · ${p.title}`}
                        className={cx('w-full text-left rounded-md px-2 py-1 text-[12px] leading-tight hover:brightness-125 transition', chipClass(p))}
                      >
                        <span className="flex items-center gap-1 mb-0.5">
                          <span className="tnum opacity-80">{timeLabel(p.scheduledAt)}</span>
                          <span className="flex gap-[3px] ml-auto">
                            {p.targets.map((tg) => <PlatformDot key={tg.id} platform={tg.platform} size={6} />)}
                          </span>
                        </span>
                        <span className="block truncate">{p.title}</span>
                      </button>
                    ))}
                    {list.length > 4 && (
                      <button onClick={() => setMode('agenda')} className="text-left px-2 text-[12px] text-faint hover:text-ink">+{list.length - 4}{' '}{t('más')}</button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex items-center gap-5 px-4 h-11 border-t border-rule text-[12px] text-faint">
            <span className="inline-flex items-center gap-1.5"><span className="w-4 h-3 rounded-sm bg-raised" />{t('Programada')}</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-4 h-3 rounded-sm border border-dashed border-[#555]" />{t('Borrador')}</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-4 h-3 rounded-sm bg-[#161616]" />{t('Publicada')}</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-4 h-3 rounded-sm bg-neg-bg" />{t('Con errores')}</span>
            <span className="ml-auto">{t('Arrastra para cambiar de día · doble clic para crear')}</span>
          </div>
        </div>
      ) : (
        <Agenda posts={inMonth} />
      )}
    </div>
  )
}

function GoogleCalendarButtons() {
  const toast = useToast()
  const nav = useNav()
  const accounts = useData(() => api.accounts.list())
  const [busy, setBusy] = useState<'' | 'ics' | 'sync'>('')
  const connected = accounts.data?.find((a) => a.platform === 'gcal')?.connected
  return (
    <>
      <Button size="sm" variant="ghost" icon={<Download size={14} />} loading={busy === 'ics'} onClick={async () => {
        setBusy('ics')
        try {
          const r = await api.calendar.exportIcs()
          if (r) {
            toast(t('{n} publicaciones exportadas. Impórtalas en Google Calendar › Configuración › Importar.', { n: r.count }), 'success')
            void api.app.openExternal('https://calendar.google.com/calendar/u/0/r/settings/export')
          }
        } catch (e) {
          toast((e as Error).message, 'error')
        } finally {
          setBusy('')
        }
      }}>{t('Exportar .ics')}</Button>
      <Button size="sm" icon={<CalendarSync size={14} />} loading={busy === 'sync'} onClick={async () => {
        if (!connected) {
          nav.go('connections')
          toast(t('Conecta Google Calendar para sincronizar automáticamente'))
          return
        }
        setBusy('sync')
        try {
          const r = await api.calendar.gcalSync()
          toast(t('Google Calendar al día: {created} nuevos, {updated} actualizados', { created: r.created, updated: r.updated }) + (r.deleted ? t(', {n} borrados', { n: r.deleted }) : ''), 'success')
        } catch (e) {
          toast((e as Error).message, 'error')
        } finally {
          setBusy('')
        }
      }}>{connected ? t('Sincronizar con Google Calendar') : t('Conectar Google Calendar')}</Button>
    </>
  )
}

function Agenda({ posts }: { posts: Post[] }) {
  const nav = useNav()
  if (posts.length === 0) {
    return (
      <div className="bg-surface rounded-[20px] p-[22px]">
        <Empty title={t('No hay publicaciones este mes')} action={<Button onClick={() => nav.go('planner')}>{t('Generar un plan con IA')}</Button>} />
      </div>
    )
  }
  const groups = new Map<string, Post[]>()
  for (const p of [...posts].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
    const k = localIso(new Date(p.scheduledAt))
    groups.set(k, [...(groups.get(k) ?? []), p])
  }
  return (
    <div className="bg-surface rounded-[20px] px-[22px] py-2">
      {[...groups.entries()].map(([day, list]) => (
        <div key={day} className="grid grid-cols-[160px_1fr] gap-4 py-3 border-b border-rule last:border-0">
          <p className="text-[14px] capitalize pt-2.5">{new Date(`${day}T12:00`).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'short' })}</p>
          <ul>
            {list.map((p) => (
              <li key={p.id}>
                <button onClick={() => nav.edit({ id: p.id })} className="w-full grid grid-cols-[56px_1fr_auto] items-center gap-4 px-3 py-2.5 rounded-xl hover:bg-hover text-left transition-colors">
                  <span className="text-[13px] text-muted tnum">{timeLabel(p.scheduledAt)}</span>
                  <span className="min-w-0">
                    <span className="block text-[14px] truncate">{p.title}</span>
                    <span className="flex items-center gap-3 mt-0.5">
                      <span className="text-[12px] text-faint">{t(FORMAT_LABEL[p.format])}</span>
                      <PlatformList platforms={p.targets.map((tg) => tg.platform)} />
                    </span>
                  </span>
                  <StatusPill status={p.status} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
