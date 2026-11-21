import { useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import type { Channel, DashboardData } from '@shared/types'

const SOCIAL: Channel[] = ['tiktok', 'instagram', 'youtube', 'linkedin', 'x']
import { CHANNEL_LABEL, PLATFORMS } from '@shared/types'
import { api } from '../lib/api'
import { useData } from '../lib/hooks'
import { compact, delta, num, relativeDay, shortDate } from '../lib/format'
import { Button, Card, cx, Empty, PageHeader, PlatformDot, PlatformList, StatusPill } from '../components/ui'
import { Chart, axisX, axisY } from '../components/Chart'
import { useNav } from '../App'
import { locale, t } from '../lib/i18n'

function finding(d: DashboardData): string {
  const ds = delta(d.totals.socialSessions, d.prevTotals.socialSessions)
  const best = d.byPlatform
    .filter((p) => p.platform !== 'blog' && p.views > 0 && p.sessions > 0)
    .map((p) => ({ ...p, rate: (p.sessions / p.views) * 1000 }))
    .sort((a, b) => b.rate - a.rate)[0]
  const parts: string[] = []
  if (d.totals.socialSessions > 0) {
    parts.push(
      ds.tone === 'flat'
        ? t('{n} visitas llegaron desde redes en 28 días', { n: num(d.totals.socialSessions) })
        : t(ds.tone === 'pos' ? 'Las visitas desde redes subieron {pct} frente a los 28 días anteriores' : 'Las visitas desde redes bajaron {pct} frente a los 28 días anteriores', { pct: ds.text.replace(/^[+−]/, '') })
    )
  }
  if (best) parts.push(t('{platform} es la que más visitas trae por cada 1.000 visualizaciones ({rate})', { platform: PLATFORMS[best.platform].name, rate: best.rate.toLocaleString(locale(), { maximumFractionDigits: 1 }) }))
  return parts.join('. ') + (parts.length ? '.' : '')
}

function Kpi({ label, value, prev, caption }: { label: string; value: number; prev: number; caption: string }) {
  const d = delta(value, prev)
  return (
    <div className="px-[22px] py-[18px] min-w-0">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="text-[26px] font-medium tnum mt-1 leading-tight">{num(value)}</p>
      <p className="text-[12px] text-faint mt-1 tnum">
        <span className={cx(d.tone === 'pos' && 'text-positive', d.tone === 'neg' && 'text-neg-ink')}>{d.text}</span> {caption}
      </p>
    </div>
  )
}

export function Dashboard() {
  const nav = useNav()
  const { data, loading } = useData(() => api.stats.dashboard(28))
  const demo = useData(() => api.demo.has())

  const option = useMemo(() => {
    if (!data) return {}
    const dates = data.daily.map((d) => shortDate(d.date))
    const maxS = Math.max(1, ...data.daily.map((d) => d.sessions))
    return {
      grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
      xAxis: axisX(dates),
      yAxis: axisY(),
      tooltip: {
        ...{ trigger: 'axis', backgroundColor: '#2a2a2a', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 } },
        formatter: (ps: { dataIndex: number }[]) => {
          const d = data.daily[ps[0].dataIndex]
          const pubs = d.published.map((p) => `<div style="color:#b4b4b4;max-width:280px;white-space:normal">· ${p.title} <span style="color:#949494">(${p.platforms.map((x) => PLATFORMS[x].name).join(', ')})</span></div>`).join('')
          return `<div style="font-weight:500;margin-bottom:4px">${shortDate(d.date)}</div>
            <div>${t('Visitas totales')} <b style="float:right;margin-left:16px">${num(d.sessions)}</b></div>
            <div style="color:#c6f24e">${t('Desde redes')} <b style="float:right;margin-left:16px">${num(d.socialSessions)}</b></div>
            ${pubs ? `<div style="margin-top:6px">${t('Publicado:')}</div>${pubs}` : ''}`
        }
      },
      series: [
        { name: t('Visitas totales'), type: 'line', data: data.daily.map((d) => d.sessions), showSymbol: false, lineStyle: { width: 1.5, color: '#6b6b6b' }, itemStyle: { color: '#6b6b6b' } },
        { name: t('Desde redes'), type: 'bar', data: data.daily.map((d) => d.socialSessions), barMaxWidth: 14, itemStyle: { color: '#c6f24e', borderRadius: [3, 3, 0, 0] } },
        {
          name: t('Publicaciones'),
          type: 'scatter',
          data: data.daily.map((d, i) => (d.published.length ? [i, maxS * 1.06] : null)).filter(Boolean),
          symbol: 'rect',
          symbolSize: [10, 3],
          itemStyle: { color: '#e6e6e6' },
          tooltip: { show: false },
          z: 3
        }
      ]
    }
  }, [data])

  if (loading && !data) return <PageHeader title={t('Resumen')} />
  if (!data) return null

  const empty = !data.hasTraffic && !data.hasMetrics
  const totalChannel = data.byChannel.reduce((s, c) => s + c.sessions, 0)
  const maxChannel = Math.max(1, ...data.byChannel.map((c) => c.sessions))

  return (
    <div className="anim-rise">
      <PageHeader
        title={t('Resumen')}
        subtitle={empty ? t('Conecta tus cuentas y Google Analytics para ver cómo tu contenido mueve tráfico a la web.') : finding(data) || t('Últimos 28 días, del {from} al {to}.', { from: shortDate(data.range.from), to: shortDate(data.range.to) })}
        actions={<Button icon={<Sparkles size={14} />} onClick={() => nav.go('planner')}>{t('Planificar con IA')}</Button>}
      />

      {empty && (
        <Card className="mb-[14px]">
          <Empty
            title={t('Todavía no hay datos')}
            action={
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => nav.go('connections')}>{t('Conectar cuentas')}</Button>
                {!demo.data && <Button onClick={() => api.demo.load()}>{t('Cargar datos de ejemplo')}</Button>}
              </div>
            }
          >
            {t('Las visitas salen de Google Analytics 4 y las visualizaciones de cada red. Mientras tanto puedes cargar datos de ejemplo para ver la app llena; se borran con un clic desde Ajustes.')}
          </Empty>
        </Card>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-[14px] items-start max-[1180px]:grid-cols-1">
        <div className="flex flex-col gap-[14px] min-w-0">
          <section className="bg-surface rounded-[20px] grid grid-cols-4 divide-x divide-rule">
            <Kpi label={t('Visitas a la web')} value={data.totals.sessions} prev={data.prevTotals.sessions} caption={t('vs 28 días anteriores')} />
            <Kpi label={t('Visitas desde redes')} value={data.totals.socialSessions} prev={data.prevTotals.socialSessions} caption={t('vs 28 días anteriores')} />
            <Kpi label={t('Visualizaciones')} value={data.totals.views} prev={data.prevTotals.views} caption={t('de lo publicado en el periodo')} />
            <Kpi label={t('Publicaciones')} value={data.totals.published} prev={data.prevTotals.published} caption={t('vs 28 días anteriores')} />
          </section>

          <Card
            title={t('Visitas a la web y publicaciones')}
            subtitle={t('Cada marca sobre el gráfico es un día con publicación. Pasa el ratón para ver qué se publicó.')}
            action={
              <div className="flex items-center gap-4 text-[12px] text-muted shrink-0">
                <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-accent" />{t('Desde redes')}</span>
                <span className="inline-flex items-center gap-1.5"><span className="w-3 h-[2px] bg-[#6b6b6b]" />{t('Visitas totales')}</span>
                <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-[3px] bg-[#e6e6e6]" />{t('Publicación')}</span>
              </div>
            }
          >
            <Chart option={option} height={280} />
          </Card>

          <Card title={t('Comparativa por plataforma')} subtitle={t('Lo publicado en los últimos 28 días y las visitas que trajo cada red a la web.')}>
            <table className="w-full text-[14px] tnum">
              <thead>
                <tr className="text-[12px] text-faint">
                  <th className="text-left font-normal pb-2">{t('Plataforma')}</th>
                  <th className="text-right font-normal pb-2">{t('Publicaciones')}</th>
                  <th className="text-right font-normal pb-2">{t('Visualizaciones')}</th>
                  <th className="text-right font-normal pb-2">{t('Interacciones')}</th>
                  <th className="text-right font-normal pb-2">{t('Visitas a la web')}</th>
                  <th className="text-right font-normal pb-2">{t('Visitas / 1.000 vis.')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byPlatform.map((p) => {
                  const rate = p.views > 0 && p.platform !== 'blog' ? (p.sessions / p.views) * 1000 : null
                  return (
                    <tr key={p.platform} className="border-t border-rule">
                      <td className="py-2.5">
                        <span className="inline-flex items-center gap-2"><PlatformDot platform={p.platform} />{PLATFORMS[p.platform].name}</span>
                      </td>
                      <td className="text-right text-muted">{num(p.posts)}</td>
                      <td className="text-right">{p.posts ? num(p.views) : <span className="text-faint">—</span>}</td>
                      <td className="text-right text-muted">{p.posts && p.platform !== 'blog' ? num(p.engagement) : <span className="text-faint">—</span>}</td>
                      <td className="text-right">{p.platform === 'blog' ? <span className="text-faint" title={t('El blog es la web: sus lecturas están en visualizaciones')}>—</span> : num(p.sessions)}</td>
                      <td className="text-right">{rate === null ? <span className="text-faint">—</span> : rate.toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        </div>

        <div className="flex flex-col gap-[14px]">
          <Card title={t('Próximas publicaciones')} action={<Button size="sm" variant="ghost" onClick={() => nav.go('calendar')}>{t('Calendario')}</Button>}>
            {data.upcoming.length === 0 ? (
              <Empty title={t('Nada programado')} action={<Button size="sm" onClick={() => nav.go('planner')}>{t('Generar un plan')}</Button>}>
                {t('Genera un calendario con la IA o crea una publicación.')}
              </Empty>
            ) : (
              <ul className="-my-1">
                {data.upcoming.map((p) => (
                  <li key={p.id}>
                    <button onClick={() => nav.edit({ id: p.id })} className="w-full text-left py-2.5 border-b border-rule last:border-0 hover:bg-hover -mx-2 px-2 rounded-lg transition-colors">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] text-faint tnum">{relativeDay(p.scheduledAt)}</span>
                        <StatusPill status={p.status} />
                      </div>
                      <p className="text-[14px] mt-1 truncate">{p.title}</p>
                      <div className="mt-1"><PlatformList platforms={p.targets.map((tg) => tg.platform)} /></div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t('De dónde llegan las visitas')} subtitle={t('{n} visitas en 28 días', { n: num(totalChannel) })}>
            {data.byChannel.length === 0 ? (
              <p className="text-[13px] text-faint">{t('Conecta Google Analytics 4 para ver los canales.')}</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {data.byChannel.map((c) => (
                  <li key={c.channel}>
                    <div className="flex justify-between text-[13px] mb-1 tnum">
                      <span>{t(CHANNEL_LABEL[c.channel])}</span>
                      <span className="text-muted">{compact(c.sessions)} <span className="text-faint">· {((c.sessions / totalChannel) * 100).toLocaleString(locale(), { maximumFractionDigits: 0 })} %</span></span>
                    </div>
                    <div className="h-1.5 rounded-full bg-raised overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(c.sessions / maxChannel) * 100}%`, background: SOCIAL.includes(c.channel) ? '#c6f24e' : '#6b6b6b' }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
