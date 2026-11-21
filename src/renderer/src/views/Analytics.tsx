import { useMemo, useState } from 'react'
import { ExternalLink, PencilLine } from 'lucide-react'
import type { Platform, PostPerformance } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { api, type ManualMetrics } from '../lib/api'
import { useData } from '../lib/hooks'
import { num, shortDate } from '../lib/format'
import { Button, Card, cx, Empty, PageHeader, PlatformDot, Segmented } from '../components/ui'
import { Chart, axisX, axisY } from '../components/Chart'
import { useToast } from '../components/toast'
import { useNav } from '../App'
import { locale, t } from '../lib/i18n'

type Scope = 'all' | Exclude<Platform, 'blog'>
const SOCIAL: Exclude<Platform, 'blog'>[] = ['tiktok', 'instagram', 'youtube', 'linkedin', 'x']
type SortKey = 'publishedAt' | 'views' | 'engagement' | 'sessions' | 'rate'

export function Analytics() {
  const nav = useNav()
  const [days, setDays] = useState(90)
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<SortKey>('publishedAt')
  const [editing, setEditing] = useState<PostPerformance | null>(null)
  const { data } = useData(() => api.stats.analytics(days), [days])

  // Agrupamos por semana a partir de 60 días para que las barras se lean.
  const series = useMemo(() => {
    if (!data) return null
    const weekly = days > 60
    const buckets: { label: string; views: number; sessions: number; from: string }[] = []
    data.daily.forEach((d, i) => {
      const views = scope === 'all' ? SOCIAL.reduce((s, p) => s + d.views[p], 0) : d.views[scope]
      const sessions = scope === 'all' ? SOCIAL.reduce((s, p) => s + d.sessions[p], 0) : d.sessions[scope]
      if (!weekly || i % 7 === 0) buckets.push({ label: shortDate(d.date), views: 0, sessions: 0, from: d.date })
      const b = buckets[buckets.length - 1]
      b.views += views
      b.sessions += sessions
    })
    return { buckets, weekly }
  }, [data, scope, days])

  const option = useMemo(() => {
    if (!series) return {}
    return {
      grid: { left: 8, right: 8, top: 36, bottom: 4, containLabel: true },
      xAxis: axisX(series.buckets.map((b) => b.label)),
      yAxis: [
        axisY({ name: t('Visualizaciones'), nameTextStyle: { color: '#949494', align: 'left', padding: [0, 0, 6, -8] } }),
        axisY({ name: t('Visitas a la web'), nameTextStyle: { color: '#c6f24e', align: 'right', padding: [0, -8, 6, 0] }, splitLine: { show: false } })
      ],
      series: [
        { name: t('Visualizaciones'), type: 'bar', data: series.buckets.map((b) => b.views), barMaxWidth: 18, itemStyle: { color: '#3d3d3d', borderRadius: [3, 3, 0, 0] } },
        { name: t('Visitas a la web'), type: 'line', yAxisIndex: 1, data: series.buckets.map((b) => b.sessions), showSymbol: false, lineStyle: { width: 2, color: '#c6f24e' }, itemStyle: { color: '#c6f24e' } }
      ]
    }
  }, [series])

  if (!data || !series) return <PageHeader title={t('Analítica')} />

  const posts = data.posts.filter((p) => p.platform !== 'blog' && (scope === 'all' || p.platform === scope))
  const blogPosts = data.posts.filter((p) => p.platform === 'blog')
  const engagement = (p: PostPerformance): number => p.likes + p.comments + p.shares + p.saves
  const rate = (p: PostPerformance): number => (p.views ? (p.sessions / p.views) * 1000 : 0)
  const sorted = [...posts].sort((a, b) =>
    sort === 'publishedAt' ? b.publishedAt.localeCompare(a.publishedAt)
      : sort === 'views' ? b.views - a.views
        : sort === 'engagement' ? engagement(b) - engagement(a)
          : sort === 'sessions' ? b.sessions - a.sessions
            : rate(b) - rate(a)
  )
  const totViews = posts.reduce((s, p) => s + p.views, 0)
  const totSessions = series.buckets.reduce((s, b) => s + b.sessions, 0)
  const scopeName = scope === 'all' ? t('tus redes') : PLATFORMS[scope].name

  const Th = ({ k, children, className }: { k: SortKey; children: string; className?: string }) => (
    <th className={cx('font-normal pb-2 text-right', className)}>
      <button onClick={() => setSort(k)} className={cx('hover:text-ink', sort === k ? 'text-ink' : '')}>
        {children}{sort === k ? ' ↓' : ''}
      </button>
    </th>
  )

  return (
    <div className="anim-rise">
      <PageHeader
        title={t('Analítica')}
        subtitle={totViews > 0 ? t('{views} visualizaciones en {scope} y {sessions} visitas a la web desde ahí en {days} días.', { views: num(totViews), scope: scopeName, sessions: num(totSessions), days }) : t('Sin datos de {scope} en los últimos {days} días.', { scope: scopeName, days })}
        actions={<Segmented value={days} onChange={setDays} options={[{ value: 30, label: t('30 días') }, { value: 90, label: t('90 días') }, { value: 180, label: t('180 días') }]} />}
      />

      <div className="mb-4 flex items-center gap-3">
        <Segmented<Scope>
          value={scope}
          onChange={setScope}
          options={[{ value: 'all', label: t('Todas las redes') }, ...SOCIAL.map((p) => ({ value: p, label: PLATFORMS[p].name }))]}
        />
      </div>

      <div className="flex flex-col gap-[14px]">
        <Card
          title={series.weekly ? t('Visualizaciones frente a visitas a la web, por semana') : t('Visualizaciones frente a visitas a la web')}
          subtitle={t('Las barras son las visualizaciones de lo publicado ese periodo; la línea, las sesiones que llegaron a la web desde esa red (Google Analytics).')}
        >
          <Chart option={option} height={300} />
        </Card>

        <Card
          title={t('Publicaciones')}
          subtitle={t('Las visitas se atribuyen a cada publicación por su campaña UTM. LinkedIn no da estadísticas por API sin aprobación: introdúcelas a mano con el lápiz.')}
        >
          {sorted.length === 0 ? (
            <Empty title={t('No hay publicaciones en este periodo')} action={<Button onClick={() => nav.go('calendar')}>{t('Ir al calendario')}</Button>} />
          ) : (
            <table className="w-full text-[14px] tnum">
              <thead>
                <tr className="text-[12px] text-faint">
                  <th className="text-left font-normal pb-2 w-[40%]">{t('Publicación')}</th>
                  <Th k="publishedAt">{t('Fecha')}</Th>
                  <Th k="views">{t('Visualizaciones')}</Th>
                  <Th k="engagement">{t('Interacciones')}</Th>
                  <Th k="sessions">{t('Visitas')}</Th>
                  <Th k="rate">{t('Visitas / 1.000')}</Th>
                  <th className="w-[72px]" />
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 60).map((p) => (
                  <tr key={p.targetId} className="border-t border-rule group">
                    <td className="py-2.5 pr-4">
                      <button onClick={() => nav.edit({ id: p.postId })} className="flex items-center gap-2 min-w-0 max-w-full text-left hover:underline underline-offset-4">
                        <PlatformDot platform={p.platform} />
                        <span className="truncate">{p.title}</span>
                      </button>
                    </td>
                    <td className="text-right text-muted">{shortDate(p.publishedAt.slice(0, 10))}</td>
                    <td className="text-right">{num(p.views)}</td>
                    <td className="text-right text-muted">{num(engagement(p))}</td>
                    <td className="text-right">{num(p.sessions)}</td>
                    <td className="text-right">{p.views ? rate(p).toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : <span className="text-faint">—</span>}</td>
                    <td className="text-right whitespace-nowrap">
                      <button onClick={() => setEditing(p)} className="p-1.5 rounded-md text-faint hover:text-ink hover:bg-hover" aria-label={t('Introducir métricas a mano')}><PencilLine size={14} /></button>
                      {p.remoteUrl && (
                        <button onClick={() => api.app.openExternal(p.remoteUrl!)} className="p-1.5 rounded-md text-faint hover:text-ink hover:bg-hover" aria-label={t('Abrir publicación')}><ExternalLink size={14} /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {blogPosts.length > 0 && (
          <Card title={t('Artículos del blog')} subtitle={t('Lecturas de cada artículo según Google Analytics (vistas de página).')}>
            <table className="w-full text-[14px] tnum">
              <thead>
                <tr className="text-[12px] text-faint">
                  <th className="text-left font-normal pb-2">{t('Artículo')}</th>
                  <th className="text-right font-normal pb-2">{t('Publicado')}</th>
                  <th className="text-right font-normal pb-2">{t('Lecturas')}</th>
                </tr>
              </thead>
              <tbody>
                {blogPosts.map((p) => (
                  <tr key={p.targetId} className="border-t border-rule">
                    <td className="py-2.5"><button onClick={() => nav.edit({ id: p.postId })} className="hover:underline underline-offset-4 text-left">{p.title}</button></td>
                    <td className="text-right text-muted">{shortDate(p.publishedAt.slice(0, 10))}</td>
                    <td className="text-right">{num(p.views)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      {editing && <ManualDialog perf={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function ManualDialog({ perf, onClose }: { perf: PostPerformance; onClose: () => void }) {
  const toast = useToast()
  const [m, setM] = useState<ManualMetrics>({ views: perf.views, likes: perf.likes, comments: perf.comments, shares: perf.shares, saves: perf.saves })
  const fields: { k: keyof ManualMetrics; label: string }[] = [
    { k: 'views', label: t('Visualizaciones / impresiones') },
    { k: 'likes', label: t('Me gusta') },
    { k: 'comments', label: t('Comentarios') },
    { k: 'shares', label: t('Compartidos') },
    { k: 'saves', label: t('Guardados') }
  ]
  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-surface rounded-[20px] p-6 w-[420px] anim-rise shadow-[0_20px_60px_rgba(0,0,0,0.7)]" role="dialog" aria-modal="true">
        <h2 className="text-[16px] font-semibold">{t('Métricas a mano')}</h2>
        <p className="text-[13px] text-muted mt-1 flex items-center gap-2"><PlatformDot platform={perf.platform} />{perf.title}</p>
        <div className="flex flex-col gap-3 mt-5">
          {fields.map((f) => (
            <label key={f.k} className="flex items-center gap-3">
              <span className="flex-1 text-[14px]">{f.label}</span>
              <input type="number" min={0} className="field w-32 text-right tnum" value={m[f.k]} onChange={(e) => setM({ ...m, [f.k]: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
          ))}
        </div>
        <p className="text-[12px] text-faint mt-3">{t('Se guardan como los totales de hoy. Si la plataforma se sincroniza por API, la próxima sincronización los sustituirá.')}</p>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={onClose}>{t('Cancelar')}</Button>
          <Button variant="primary" onClick={async () => {
            await api.metrics.manual(perf.targetId, m)
            toast(t('Métricas guardadas'), 'success')
            onClose()
          }}>{t('Guardar')}</Button>
        </div>
      </div>
    </div>
  )
}
