import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Check, Wand2, CalendarPlus } from 'lucide-react'
import type { AiProgress, CadenceOption, Plan, PlannerBrief, Platform, SiteAnalysis } from '@shared/types'
import { DEFAULT_CADENCES, FORMAT_LABEL, PLATFORM_IDS, PLATFORMS } from '@shared/types'
import { api } from '../lib/api'
import { useData } from '../lib/hooks'
import { localIso } from '../lib/format'
import { Button, Card, cx, ErrorNote, Label, PageHeader, PlatformDot, PlatformList, Segmented } from '../components/ui'
import { useToast } from '../components/toast'
import { useNav } from '../App'
import { locale, t } from '../lib/i18n'

function nextMonday(): string {
  const d = new Date()
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7))
  return localIso(d)
}

// Función y no constante: los valores por defecto siguen el idioma de la interfaz.
const defaultBrief = (): PlannerBrief => ({
  businessName: '',
  website: '',
  offer: '',
  audience: '',
  goal: t('Aumentar el tráfico orgánico cualificado a la web y las conversiones desde el blog'),
  tone: t('Cercano, claro y experto, sin jerga'),
  language: t('español de España'),
  pillars: '',
  startDate: nextMonday(),
  weeks: 4,
  frequency: { ...DEFAULT_CADENCES[1].frequency },
  extra: ''
})

const sameFreq = (a: Partial<Record<Platform, number>>, b: Partial<Record<Platform, number>>): boolean =>
  PLATFORM_IDS.every((p) => (a[p] ?? 0) === (b[p] ?? 0))

const total = (f: Partial<Record<Platform, number>>): number => PLATFORM_IDS.reduce((s, p) => s + (f[p] ?? 0), 0)

/** Piezas reales que hay que producir: un short va a TikTok e Instagram a la vez y cuenta una vez. */
const pieces = (f: Partial<Record<Platform, number>>): number =>
  total(f) - Math.min(f.tiktok ?? 0, f.instagram ?? 0)

export function Planner() {
  const toast = useToast()
  const nav = useNav()
  const settings = useData(() => api.settings.get())
  const history = useData(() => api.ai.plans())
  const [brief, setBrief] = useState<PlannerBrief>(defaultBrief)
  const [analysis, setAnalysis] = useState<SiteAnalysis | null>(null)
  const [keywords, setKeywords] = useState<Set<string>>(new Set())
  const [custom, setCustom] = useState(false)
  const [url, setUrl] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState<'' | 'site' | 'plan'>('')
  const [progress, setProgress] = useState<AiProgress | null>(null)
  const [error, setError] = useState('')
  const [siteError, setSiteError] = useState('')
  const [asStatus, setAsStatus] = useState<'draft' | 'scheduled'>('draft')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const s = settings.data
    if (!s || loaded) return
    setLoaded(true)
    if (s.plannerBrief) setBrief({ ...defaultBrief(), ...s.plannerBrief, startDate: s.plannerBrief.startDate < localIso(new Date()) ? nextMonday() : s.plannerBrief.startDate })
    if (s.plannerAnalysis) setAnalysis(s.plannerAnalysis)
    setUrl(s.plannerBrief?.website || s.website || '')
  }, [settings.data, loaded])

  useEffect(() => api.onAiProgress((p) => (p.kind === 'plan' || p.kind === 'site') && setProgress(p)), [])

  const cadences: CadenceOption[] = analysis?.cadences?.length === 3 ? analysis.cadences : DEFAULT_CADENCES
  const activeCadence = custom ? -1 : cadences.findIndex((c) => sameFreq(c.frequency, brief.frequency))

  const set = <K extends keyof PlannerBrief>(k: K, v: PlannerBrief[K]): void => setBrief((b) => ({ ...b, [k]: v }))
  const setFreq = (p: Platform, n: number): void => setBrief((b) => ({ ...b, frequency: { ...b.frequency, [p]: Math.max(0, Math.min(7, n)) } }))

  const perWeek = total(brief.frequency)
  const missing = !brief.businessName.trim() || !brief.offer.trim() || !brief.audience.trim() || !brief.website.trim()

  async function autofill(): Promise<void> {
    if (!url.trim()) return
    setSiteError('')
    setBusy('site')
    setProgress(null)
    try {
      const a = await api.ai.analyzeSite(url)
      setAnalysis(a)
      setBrief((b) => ({ ...b, ...a.brief, frequency: { ...a.cadences[1]?.frequency ?? b.frequency } }))
      setUrl(a.brief.website)
      setCustom(false)
      setKeywords(new Set())
      toast(t('Web analizada: {pages} páginas y {urls} URLs del sitemap', { pages: a.pagesRead, urls: a.brief.existingUrls?.length ?? 0 }), 'success')
    } catch (e) {
      const msg = (e as Error).message
      setSiteError(/No handler registered/i.test(msg) ? t('La app necesita reiniciarse para cargar esta función. Ciérrala del todo (también desde el icono de la bandeja) y vuelve a abrirla.') : msg)
    } finally {
      setBusy('')
    }
  }

  async function generate(): Promise<void> {
    setError('')
    setBusy('plan')
    setProgress(null)
    const kw = [...keywords]
    const extra = [brief.extra, kw.length ? `Prioriza estas palabras clave (un artículo cada una): ${kw.join('; ')}` : ''].filter(Boolean).join('\n')
    try {
      const p = await api.ai.plan({ ...brief, extra })
      setPlan(p)
      setSelected(new Set(p.posts.map((_, i) => i)))
      history.reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function accept(): Promise<void> {
    if (!plan) return
    try {
      const n = await api.ai.acceptPlan(plan, [...selected], asStatus)
      toast(asStatus === 'scheduled' ? t('{n} publicaciones añadidas al calendario y programadas', { n }) : t('{n} publicaciones añadidas al calendario como borradores', { n }), 'success')
      nav.go('calendar')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const weeks = useMemo(() => {
    if (!plan) return []
    const start = new Date(`${plan.brief.startDate}T12:00`).getTime()
    const out: { label: string; items: { i: number; p: Plan['posts'][number] }[] }[] = []
    plan.posts.forEach((p, i) => {
      const w = Math.max(0, Math.floor((new Date(`${p.date}T12:00`).getTime() - start) / (7 * 86400_000)))
      out[w] ??= { label: t('Semana {n}', { n: w + 1 }), items: [] }
      out[w].items.push({ i, p })
    })
    return out.filter(Boolean)
  }, [plan])

  const siteStage = busy === 'site' ? progress?.stage ?? t('Leyendo tu web') : ''

  return (
    <div className="anim-rise">
      <PageHeader
        title={t('Planificador IA')}
        subtitle={t('Pega la URL de tu web: la IA la lee, detecta oportunidades SEO y propone un calendario en el que cada pieza lleva tráfico a una página concreta.')}
      />

      <div className="grid grid-cols-[440px_minmax(0,1fr)] gap-[14px] items-start max-[1180px]:grid-cols-1">
        <div className="flex flex-col gap-[14px]">
          <Card title={t('Tu web')}>
            <div className="flex gap-2">
              <input className="field" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void autofill()} placeholder="https://tuweb.com" />
              <Button variant="primary" icon={<Wand2 size={15} />} loading={busy === 'site'} disabled={!url.trim() || !!busy} onClick={autofill}>
                {t('Autorrellenar')}
              </Button>
            </div>
            <p className="text-[12px] text-faint mt-2 tnum">
              {siteError ? '' : siteStage ? `${siteStage}…${progress?.chars ? ` ${t('{n} caracteres', { n: progress.chars.toLocaleString(locale()) })}` : ''}` : t('Lee la portada, las páginas clave y el sitemap. Tarda alrededor de un minuto.')}
            </p>
            {siteError && <div className="mt-3"><ErrorNote>{siteError}</ErrorNote></div>}
          </Card>

          <Card title={t('Briefing')}>
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <Label>{t('Negocio')}</Label>
                  <input className="field" value={brief.businessName} onChange={(e) => set('businessName', e.target.value)} placeholder={t('Nombre')} />
                </label>
                <label>
                  <Label>{t('Web')}</Label>
                  <input className="field" value={brief.website} onChange={(e) => set('website', e.target.value)} placeholder="https://tuweb.com" />
                </label>
              </div>
              <label>
                <Label>{t('Qué ofreces')}</Label>
                <textarea className="field" rows={3} value={brief.offer} onChange={(e) => set('offer', e.target.value)} placeholder={t('Productos o servicios, precio aproximado, qué te diferencia')} />
              </label>
              <label>
                <Label>{t('Para quién')}</Label>
                <textarea className="field" rows={3} value={brief.audience} onChange={(e) => set('audience', e.target.value)} placeholder={t('Tu cliente ideal: quién es, qué problema tiene, qué busca')} />
              </label>
              <label>
                <Label>{t('Objetivo')}</Label>
                <textarea className="field" rows={2} value={brief.goal} onChange={(e) => set('goal', e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <Label>{t('Tono')}</Label>
                  <input className="field" value={brief.tone} onChange={(e) => set('tone', e.target.value)} />
                </label>
                <label>
                  <Label>{t('Idioma')}</Label>
                  <input className="field" value={brief.language} onChange={(e) => set('language', e.target.value)} />
                </label>
              </div>
              <label>
                <Label hint={t('Opcional. Si lo dejas vacío, la IA los propone.')}>{t('Pilares temáticos')}</Label>
                <input className="field" value={brief.pillars} onChange={(e) => set('pillars', e.target.value)} placeholder={t('Tutoriales, casos de uso, comparativas…')} />
              </label>
            </div>
          </Card>

          <Card title={t('Cuánto publicar')} subtitle={analysis ? t('Recomendaciones para tu negocio según tu web.') : t('Autorrellena con tu web para recibir recomendaciones a medida.')}>
            <div className="flex flex-col gap-2">
              {cadences.map((c, i) => {
                const on = activeCadence === i
                return (
                  <button key={c.name} onClick={() => {
                    setCustom(false)
                    set('frequency', { ...c.frequency })
                  }} aria-pressed={on}
                    className={cx('text-left rounded-2xl p-4 transition-colors', on ? 'bg-raised' : 'bg-[#0a0a0a] hover:bg-hover')}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[15px] font-medium">{t(c.name)}</span>
                      <span className="text-[12px] text-faint tnum shrink-0">{t('{n} piezas/sem', { n: pieces(c.frequency) })} · ~{c.hoursPerWeek} h</span>
                    </div>
                    <p className="text-[13px] text-muted mt-1">{t(c.description)}</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2.5">
                      {PLATFORM_IDS.filter((p) => c.frequency[p] > 0).map((p) => (
                        <span key={p} className="inline-flex items-center gap-1.5 text-[12px] text-muted tnum">
                          <PlatformDot platform={p} size={6} />
                          {PLATFORMS[p].name} {c.frequency[p]}
                        </span>
                      ))}
                    </div>
                  </button>
                )
              })}
              <button onClick={() => setCustom(true)} aria-pressed={activeCadence === -1}
                className={cx('text-left rounded-2xl p-4 transition-colors', activeCadence === -1 ? 'bg-raised' : 'bg-[#0a0a0a] hover:bg-hover')}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[15px] font-medium">{t('Personalizada')}</span>
                  {activeCadence === -1 && <span className="text-[12px] text-faint tnum">{t('{n} piezas/sem', { n: pieces(brief.frequency) })}</span>}
                </div>
                <p className="text-[13px] text-muted mt-1">{t('Elige tú cuántas veces por semana en cada red.')}</p>
              </button>
              {activeCadence === -1 && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-1 pt-2">
                  {PLATFORM_IDS.map((p) => (
                    <div key={p} className="flex items-center gap-2 h-9">
                      <PlatformDot platform={p} />
                      <span className="text-[14px] flex-1">{PLATFORMS[p].name}</span>
                      <div className="flex items-center bg-raised rounded-full">
                        <button className="w-7 h-7 text-muted hover:text-ink" onClick={() => setFreq(p, (brief.frequency[p] ?? 0) - 1)} aria-label={t('Menos en {platform}', { platform: PLATFORMS[p].name })}>−</button>
                        <span className="w-5 text-center tnum text-[14px]">{brief.frequency[p] ?? 0}</span>
                        <button className="w-7 h-7 text-muted hover:text-ink" onClick={() => setFreq(p, (brief.frequency[p] ?? 0) + 1)} aria-label={t('Más en {platform}', { platform: PLATFORMS[p].name })}>+</button>
                      </div>
                    </div>
                  ))}
                  <p className="col-span-2 text-[12px] text-faint mt-1">{t('Consejo: pon la misma cifra en TikTok e Instagram; cada vídeo vertical se publica en las dos a la vez.')}</p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 mt-5">
              <label>
                <Label>{t('Empieza el')}</Label>
                <input type="date" className="field tnum" value={brief.startDate} onChange={(e) => set('startDate', e.target.value)} />
              </label>
              <label>
                <Label>{t('Duración')}</Label>
                <select className="field" value={brief.weeks} onChange={(e) => set('weeks', Number(e.target.value))}>
                  {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'semana' : 'semanas'}</option>)}
                </select>
              </label>
            </div>
            <label className="block mt-4">
              <Label hint={t('Lanzamientos, fechas clave, ofertas, cosas que evitar…')}>{t('Notas')}</Label>
              <textarea className="field" rows={2} value={brief.extra} onChange={(e) => set('extra', e.target.value)} />
            </label>

            {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
            <Button variant="primary" className="w-full mt-4" icon={<Sparkles size={15} />} loading={busy === 'plan'} disabled={missing || perWeek === 0 || !!busy} onClick={generate}>
              {busy === 'plan' ? t('Generando…') : plan ? t('Generar otro plan') : brief.weeks === 1 ? t('Generar calendario de 1 semana') : t('Generar calendario de {n} semanas', { n: brief.weeks })}
            </Button>
            {missing && <p className="text-[12px] text-faint mt-2">{t('Autorrellena con tu web o completa negocio, web, qué ofreces y para quién.')}</p>}
          </Card>
        </div>

        <div className="flex flex-col gap-[14px] min-w-0">
          {busy === 'plan' && (
            <Card>
              <p className="text-[16px] font-medium">{t('Preparando {n} piezas…', { n: brief.weeks * pieces(brief.frequency) })}</p>
              <p className="text-[13px] text-muted mt-1 tnum">
                {progress && progress.chars > 0
                  ? t('{done} de ~{total} piezas escritas · {chars} caracteres', { done: progress.posts ?? 0, total: brief.weeks * pieces(brief.frequency), chars: progress.chars.toLocaleString(locale()) })
                  : t('Eligiendo palabras clave, clústeres y horas de máximo impacto')}
              </p>
              <div className="h-1.5 rounded-full bg-raised overflow-hidden mt-4">
                <div className="h-full bg-accent rounded-full transition-[width] duration-500" style={{ width: `${Math.min(96, (((progress?.posts ?? 0) + 0.5) / Math.max(1, brief.weeks * pieces(brief.frequency))) * 100)}%` }} />
              </div>
            </Card>
          )}

          {analysis && !plan && busy !== 'plan' && (
            <>
              <Card title={t('Diagnóstico SEO de tu web')} subtitle={t('{pages} páginas leídas · {urls} URLs en el sitemap', { pages: analysis.pagesRead, urls: analysis.brief.existingUrls?.length ?? 0 })}>
                <p className="text-[15px] leading-relaxed max-w-[80ch] whitespace-pre-line">{analysis.brief.siteNotes}</p>
              </Card>
              <Card title={t('Palabras clave que aún no trabajas')} subtitle={t('Marca las que quieras priorizar: el plan dedicará un artículo a cada una.')}>
                <ul className="-mx-2">
                  {analysis.keywordIdeas.map((k) => {
                    const on = keywords.has(k.keyword)
                    return (
                      <li key={k.keyword}>
                        <label className="grid grid-cols-[24px_1fr_auto] gap-3 px-2 py-2.5 rounded-xl hover:bg-hover cursor-pointer border-b border-rule last:border-0">
                          <span className={cx('mt-0.5 w-[18px] h-[18px] rounded-md grid place-items-center transition-colors', on ? 'bg-ink text-black' : 'bg-raised')}>
                            {on && <Check size={13} strokeWidth={3} />}
                            <input type="checkbox" className="sr-only" checked={on} onChange={() => {
                              const s = new Set(keywords)
                              if (on) s.delete(k.keyword)
                              else s.add(k.keyword)
                              setKeywords(s)
                            }} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[14px] font-medium">{k.keyword}</span>
                            <span className="block text-[13px] text-muted mt-0.5">{k.articleIdea}</span>
                          </span>
                          <span className="text-[12px] text-faint pt-0.5">{k.intent}</span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </Card>
            </>
          )}

          {plan && busy !== 'plan' && (
            <>
              <Card title={t('Estrategia')} action={<span className="text-[12px] text-faint tnum">{t('{n} entradas · {weeks} semanas', { n: plan.posts.length, weeks: plan.brief.weeks })}</span>}>
                <p className="text-[15px] leading-relaxed max-w-[80ch]">{plan.strategy}</p>
                {plan.pillars.length > 0 && (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 mt-5 max-[900px]:grid-cols-1">
                    {plan.pillars.map((p) => (
                      <div key={p.name}>
                        <dt className="text-[14px] font-medium">{p.name}</dt>
                        <dd className="text-[13px] text-muted mt-0.5">{p.description}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </Card>

              {plan.bestTimes?.length > 0 && (
                <Card title={t('Mejores horas para publicar')} subtitle={t('Para tu público, en tu zona horaria. El plan ya coloca cada pieza en su franja.')}>
                  <ul className="grid grid-cols-2 gap-x-8 max-[900px]:grid-cols-1">
                    {plan.bestTimes.map((b) => (
                      <li key={b.platform} className="py-3 border-b border-rule">
                        <div className="flex items-center gap-2">
                          <PlatformDot platform={b.platform} />
                          <span className="text-[14px] font-medium">{PLATFORMS[b.platform].name}</span>
                          <span className="ml-auto text-[14px] tnum text-accent">{b.times}</span>
                        </div>
                        <p className="text-[13px] text-muted mt-1">{b.reason}</p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {weeks.map((w) => (
                <Card key={w.label} title={w.label}>
                  <ul className="-mx-2">
                    {w.items.map(({ i, p }) => {
                      const on = selected.has(i)
                      return (
                        <li key={i} className="border-b border-rule last:border-0">
                          <label className="grid grid-cols-[24px_132px_1fr] gap-3 px-2 py-3 rounded-xl hover:bg-hover cursor-pointer">
                            <span className={cx('mt-0.5 w-[18px] h-[18px] rounded-md grid place-items-center transition-colors', on ? 'bg-ink text-black' : 'bg-raised')}>
                              {on && <Check size={13} strokeWidth={3} />}
                              <input type="checkbox" className="sr-only" checked={on} onChange={() => {
                                const s = new Set(selected)
                                if (on) s.delete(i)
                                else s.add(i)
                                setSelected(s)
                              }} />
                            </span>
                            <span className="text-[13px] text-muted tnum capitalize">
                              {new Date(`${p.date}T12:00`).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })}
                              <span className="block text-ink text-[14px]">{p.time}</span>
                              <span className="block text-faint normal-case">{t(FORMAT_LABEL[p.format])}</span>
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[14px] font-medium">{p.title}</span>
                              <span className="block text-[13px] text-muted mt-0.5">{p.hook}</span>
                              <span className="flex items-center gap-3 mt-1.5 flex-wrap">
                                <PlatformList platforms={p.platforms} />
                                {p.keyword && <span className="text-[12px] text-faint">{t('Palabra clave:')}{' '}<span className="text-muted">{p.keyword}</span></span>}
                                {p.linkPath && <span className="text-[12px] text-faint">→ {p.linkPath}</span>}
                              </span>
                              <span className="block text-[12px] text-faint mt-1.5">{p.rationale}</span>
                            </span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </Card>
              ))}

              <div className="sticky bottom-0 bg-ground/95 py-3 flex items-center gap-3 flex-wrap">
                <span className="text-[13px] text-muted tnum">{t('{n} de {total} seleccionadas', { n: selected.size, total: plan.posts.length })}</span>
                <div className="flex-1" />
                <Segmented value={asStatus} onChange={setAsStatus} options={[{ value: 'draft', label: t('Como borradores') }, { value: 'scheduled', label: t('Programadas') }]} />
                <Button variant="primary" icon={<CalendarPlus size={15} />} disabled={selected.size === 0} onClick={accept}>{t('Añadir al calendario')}</Button>
              </div>
            </>
          )}

          {!plan && !analysis && busy !== 'plan' && (
            <Card title={history.data && history.data.length > 0 ? t('Planes anteriores') : t('Cómo funciona')}>
              {history.data && history.data.length > 0 ? (
                <ul className="-mx-2">
                  {history.data.map((h) => (
                    <li key={h.id}>
                      <button onClick={() => {
                        setPlan({ ...h, bestTimes: h.bestTimes ?? [] })
                        setSelected(new Set(h.posts.map((_, i) => i)))
                      }} className="w-full text-left px-2 py-3 rounded-xl hover:bg-hover border-b border-rule last:border-0 transition-colors">
                        <span className="block text-[14px]">{h.brief.businessName} · {t('{n} piezas desde el {date}', { n: h.posts.length, date: new Date(`${h.brief.startDate}T12:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'long' }) })}</span>
                        <span className="block text-[13px] text-faint truncate mt-0.5">{h.strategy}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="flex flex-col gap-2.5 text-[14px] text-muted leading-relaxed max-w-[68ch]">
                  <li><span className="text-ink">{t('Autorrellena con tu web.')}</span>{' '}{t('La IA lee tu web y tu sitemap, rellena el briefing, hace un diagnóstico SEO y te propone tres ritmos de publicación.')}</li>
                  <li><span className="text-ink">{t('SEO primero.')}</span>{' '}{t('Cada semana gira alrededor de un artículo con una palabra clave que aún no trabajas. Las piezas para redes derivan de él y enlazan a él con UTM.')}</li>
                  <li><span className="text-ink">{t('Un vídeo, tres redes.')}</span>{' '}{t('Cada vídeo vertical se publica a la vez en TikTok, Reels y Shorts, a la hora de más actividad de tu público.')}</li>
                  <li><span className="text-ink">{t('Tú decides.')}</span>{' '}{t('Revisas la propuesta, la añades al calendario y la vuelcas a Google Calendar.')}</li>
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
