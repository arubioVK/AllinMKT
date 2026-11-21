import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Send, Trash2, FileText, Paperclip, ExternalLink, X as XIcon } from 'lucide-react'
import type { AiProgress, Format, Platform, Post, PostStatus } from '@shared/types'
import { FORMAT_LABEL, FORMATS, PLATFORM_IDS, PLATFORMS } from '@shared/types'
import { api } from '../lib/api'
import { useToast } from './toast'
import { Button, cx, Drawer, ErrorNote, Label, PlatformDot, StatusPill, Segmented } from './ui'
import { relativeDay } from '../lib/format'
import { locale, t } from '../lib/i18n'

export type EditorTarget = { id: string } | { date: string | null; platforms?: Platform[] }

interface Form {
  title: string
  body: string
  format: Format
  pillar: string
  hook: string
  cta: string
  linkPath: string
  mediaPath: string
  mediaPublicUrl: string
  when: string
  status: PostStatus
  platforms: Platform[]
  captions: Partial<Record<Platform, string>>
  titles: Partial<Record<Platform, string>>
}

const toLocalInput = (iso: string): string => {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function blank(date: string | null, platforms?: Platform[]): Form {
  const d = date ? new Date(`${date}T10:00`) : new Date(Date.now() + 86400_000)
  if (!date) d.setHours(10, 0, 0, 0)
  return {
    title: '', body: '', format: 'text', pillar: '', hook: '', cta: '', linkPath: '', mediaPath: '', mediaPublicUrl: '',
    when: toLocalInput(d.toISOString()), status: 'draft', platforms: platforms ?? [], captions: {}, titles: {}
  }
}

function fromPost(p: Post): Form {
  return {
    title: p.title, body: p.body, format: p.format, pillar: p.pillar, hook: p.hook, cta: p.cta, linkPath: p.linkPath,
    mediaPath: p.mediaPath, mediaPublicUrl: p.mediaPublicUrl, when: toLocalInput(p.scheduledAt), status: p.status,
    platforms: p.targets.map((tg) => tg.platform),
    captions: Object.fromEntries(p.targets.map((tg) => [tg.platform, tg.caption])),
    titles: Object.fromEntries(p.targets.map((tg) => [tg.platform, tg.title]))
  }
}

export function PostEditor({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  const toast = useToast()
  const [post, setPost] = useState<Post | null>(null)
  const [form, setForm] = useState<Form>(() => ('id' in target ? blank(null) : blank(target.date, target.platforms)))
  const [tab, setTab] = useState<'base' | Platform>('base')
  const [busy, setBusy] = useState<'' | 'save' | 'variants' | 'article' | 'publish' | 'delete'>('')
  const [progress, setProgress] = useState<AiProgress | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if ('id' in target) {
      void api.posts.get(target.id).then((p) => {
        if (p) {
          setPost(p)
          setForm(fromPost(p))
        }
      })
    }
  }, [target])

  useEffect(() => api.onAiProgress(setProgress), [])

  const set = <K extends keyof Form>(k: K, v: Form[K]): void => setForm((f) => ({ ...f, [k]: v }))

  const allowed = useMemo(() => PLATFORM_IDS.filter((p) => PLATFORMS[p].formats.includes(form.format)), [form.format])
  const togglePlatform = (p: Platform): void =>
    set('platforms', form.platforms.includes(p) ? form.platforms.filter((x) => x !== p) : [...form.platforms, p])

  async function save(status?: PostStatus): Promise<Post | null> {
    setError('')
    if (!form.title.trim()) {
      setError(t('Ponle un título a la publicación'))
      return null
    }
    if ((status ?? form.status) === 'scheduled' && form.platforms.length === 0) {
      setError(t('Elige al menos una plataforma para programar'))
      return null
    }
    if (status === 'scheduled' && new Date(form.when).getTime() < Date.now() && !window.confirm(t('La fecha ya ha pasado: se publicará en cuanto la guardes. ¿Continuar?'))) {
      return null
    }
    setBusy('save')
    try {
      const p = await api.posts.save(post?.id ?? null, {
        title: form.title, body: form.body, format: form.format, pillar: form.pillar, hook: form.hook, cta: form.cta,
        linkPath: form.linkPath, mediaPath: form.mediaPath, mediaPublicUrl: form.mediaPublicUrl,
        scheduledAt: new Date(form.when).toISOString(), status: status ?? form.status, platforms: form.platforms,
        targetOverrides: Object.fromEntries(form.platforms.map((pl) => [pl, { caption: form.captions[pl] ?? '', title: form.titles[pl] ?? '' }]))
      })
      setPost(p)
      setForm(fromPost(p))
      return p
    } catch (e) {
      setError((e as Error).message)
      return null
    } finally {
      setBusy('')
    }
  }

  async function aiVariants(): Promise<void> {
    const p = await save()
    if (!p) return
    setBusy('variants')
    setProgress(null)
    try {
      const v = await api.ai.variants(p.id, form.platforms)
      const fresh = await api.posts.get(p.id)
      if (fresh) {
        setPost(fresh)
        setForm(fromPost(fresh))
      }
      toast(t('Textos adaptados para {n} plataforma(s)', { n: v.length }), 'success')
      if (v[0]) setTab(v[0].platform)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function aiArticle(): Promise<void> {
    const p = await save()
    if (!p) return
    setBusy('article')
    setProgress(null)
    try {
      await api.ai.article(p.id)
      const fresh = await api.posts.get(p.id)
      if (fresh) {
        setPost(fresh)
        setForm(fromPost(fresh))
      }
      setTab('blog')
      toast(t('Artículo escrito. Revísalo antes de publicarlo.'), 'success')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function publishNow(): Promise<void> {
    if (!window.confirm(t('Se publicará ahora en: {platforms}. ¿Continuar?', { platforms: form.platforms.map((p) => PLATFORMS[p].name).join(', ') }))) return
    const p = await save()
    if (!p) return
    setBusy('publish')
    try {
      const after = await api.posts.publishNow(p.id)
      setPost(after)
      setForm(fromPost(after))
      const failed = after.targets.filter((tg) => tg.status === 'failed')
      if (failed.length) toast(t('{n} destino(s) fallaron. Mira el detalle abajo.', { n: failed.length }), 'error')
      else toast(t('Publicado'), 'success')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function remove(): Promise<void> {
    if (!post || !window.confirm(t('¿Eliminar esta publicación? No se borra de las redes donde ya se publicó.'))) return
    setBusy('delete')
    await api.posts.remove(post.id)
    onClose()
  }

  async function pickMedia(): Promise<void> {
    const f = await api.app.pickFile('media')
    if (f) setForm((x) => ({ ...x, mediaPath: f, mediaPublicUrl: '' }))
  }

  const isArticle = form.platforms.includes('blog')
  const aiBusy = busy === 'variants' || busy === 'article'
  const progressText = aiBusy && progress ? `${t('Escribiendo…')} ${t('{n} caracteres', { n: progress.chars.toLocaleString(locale()) })}` : t('Escribiendo…')
  const tabs = [{ value: 'base' as const, label: t('Base') }, ...form.platforms.map((p) => ({ value: p, label: PLATFORMS[p].name }))]

  return (
    <Drawer open onClose={onClose} width={760} title={post ? t('Editar publicación') : t('Nueva publicación')} footer={<>
        {post && <StatusPill status={post.status} />}
        <div className="flex-1" />
        {post && (
          <Button variant="ghost" icon={<Trash2 size={14} />} onClick={remove} loading={busy === 'delete'}>
            {t('Eliminar')}
          </Button>
        )}
        <Button icon={<Send size={14} />} onClick={publishNow} loading={busy === 'publish'} disabled={form.platforms.length === 0 || !!busy}>
          {t('Publicar ahora')}
        </Button>
        {form.status !== 'scheduled' && !['published', 'partial'].includes(form.status) ? (
          <>
            <Button onClick={async () => (await save()) && onClose()} loading={busy === 'save'} disabled={!!busy && busy !== 'save'}>
              {t('Guardar')}
            </Button>
            <Button variant="primary" onClick={async () => (await save('scheduled')) && onClose()} disabled={!!busy}>
              {t('Programar')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={async () => (await save()) && onClose()} loading={busy === 'save'} disabled={!!busy && busy !== 'save'}>
            {t('Guardar')}
          </Button>
        )}
    </>}>
      <div className="flex flex-col gap-5">
        {post?.rationale && post.source === 'ai' && (
          <p className="text-[13px] text-muted bg-raised/50 rounded-xl px-3.5 py-2.5">
            <span className="text-ink font-medium">{t('Por qué la propuso la IA:')}{' '}</span>
            {post.rationale}
          </p>
        )}

        <label className="block">
          <Label>{t('Título')}</Label>
          <input className="field" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder={t('Qué vas a publicar')} autoFocus={!post} />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label>
            <Label>{t('Fecha y hora')}</Label>
            <input type="datetime-local" className="field tnum" value={form.when} onChange={(e) => set('when', e.target.value)} />
          </label>
          <label>
            <Label>{t('Formato')}</Label>
            <select className="field" value={form.format} onChange={(e) => {
              const f = e.target.value as Format
              setForm((x) => ({ ...x, format: f, platforms: x.platforms.filter((p) => PLATFORMS[p].formats.includes(f)) }))
            }}>
              {FORMATS.map((f) => (
                <option key={f} value={f}>{t(FORMAT_LABEL[f])}</option>
              ))}
            </select>
          </label>
          <label>
            <Label>{t('Estado')}</Label>
            <select className="field" value={form.status} onChange={(e) => set('status', e.target.value as PostStatus)}>
              <option value="idea">{t('Idea')}</option>
              <option value="draft">{t('Borrador')}</option>
              <option value="scheduled">{t('Programada (se publica sola)')}</option>
              {['published', 'partial', 'failed', 'publishing'].includes(form.status) && <option value={form.status}>{form.status === 'published' ? t('Publicada') : form.status === 'partial' ? t('Publicada en parte') : form.status === 'failed' ? t('Falló') : t('Publicando')}</option>}
            </select>
          </label>
        </div>

        <div>
          <Label hint={t('Solo aparecen las que admiten este formato')}>{t('Plataformas')}</Label>
          <div className="flex flex-wrap gap-2">
            {allowed.map((p) => {
              const on = form.platforms.includes(p)
              return (
                <button key={p} onClick={() => togglePlatform(p)} aria-pressed={on}
                  className={cx('h-8 px-3 rounded-full inline-flex items-center gap-2 text-[13px] transition-colors', on ? 'bg-ink text-black font-medium' : 'bg-raised text-muted hover:text-ink')}>
                  <PlatformDot platform={p} />
                  {PLATFORMS[p].name}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 mb-3">
            <Segmented value={tab} options={tabs} onChange={(v) => setTab(v)} />
            <div className="flex gap-2">
              {isArticle && (
                <Button size="sm" icon={<FileText size={14} />} onClick={aiArticle} loading={busy === 'article'} disabled={aiBusy}>
                  {t('Escribir artículo')}
                </Button>
              )}
              <Button size="sm" icon={<Sparkles size={14} />} onClick={aiVariants} loading={busy === 'variants'} disabled={aiBusy || form.platforms.filter((p) => p !== 'blog').length === 0}>
                {t('Adaptar a cada red')}
              </Button>
            </div>
          </div>
          {aiBusy && <p className="text-[12px] text-faint mb-2 tnum">{progressText}</p>}

          {tab === 'base' ? (
            <div className="flex flex-col gap-3">
              <label>
                <Label hint={t('Guion, post completo o índice del artículo. Es la base de los textos de cada red.')}>{t('Borrador')}</Label>
                <textarea className="field min-h-[220px]" value={form.body} onChange={(e) => set('body', e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <Label>{t('Gancho')}</Label>
                  <input className="field" value={form.hook} onChange={(e) => set('hook', e.target.value)} />
                </label>
                <label>
                  <Label>{t('Llamada a la acción')}</Label>
                  <input className="field" value={form.cta} onChange={(e) => set('cta', e.target.value)} />
                </label>
                <label>
                  <Label hint={t('La app añade utm_source, utm_medium y utm_campaign')}>{t('Lleva a la ruta de la web')}</Label>
                  <input className="field" value={form.linkPath} onChange={(e) => set('linkPath', e.target.value)} placeholder="/blog/mi-articulo" />
                </label>
                <label>
                  <Label>{t('Pilar')}</Label>
                  <input className="field" value={form.pillar} onChange={(e) => set('pillar', e.target.value)} />
                </label>
              </div>
            </div>
          ) : (
            <PlatformText platform={tab} form={form} setForm={setForm} />
          )}
        </div>

        <div>
          <Label hint={t('Necesario para TikTok, YouTube y Reels de Instagram. Opcional en LinkedIn y X (imagen).')}>{t('Archivo')}</Label>
          <div className="flex items-center gap-2">
            <Button size="sm" icon={<Paperclip size={14} />} onClick={pickMedia}>
              {form.mediaPath ? t('Cambiar archivo') : t('Elegir vídeo o imagen')}
            </Button>
            {form.mediaPath && (
              <>
                <button className="text-[13px] text-muted truncate hover:text-ink" onClick={() => api.app.showItem(form.mediaPath)} title={form.mediaPath}>
                  {form.mediaPath.split(/[\\/]/).pop()}
                </button>
                <button className="p-1 text-faint hover:text-ink" onClick={() => setForm((x) => ({ ...x, mediaPath: '', mediaPublicUrl: '' }))} aria-label={t('Quitar archivo')}>
                  <XIcon size={14} />
                </button>
              </>
            )}
          </div>
          {form.platforms.includes('instagram') && (
            <input className="field mt-2" value={form.mediaPublicUrl} onChange={(e) => set('mediaPublicUrl', e.target.value)}
              placeholder={t('URL pública del archivo (si no, se sube al almacenamiento configurado)')} />
          )}
        </div>

        {post && post.targets.length > 0 && (
          <div>
            <Label>{t('Destinos')}</Label>
            <ul className="flex flex-col">
              {post.targets.map((tg) => (
                <li key={tg.id} className="flex items-start gap-3 py-2.5 border-b border-rule last:border-0">
                  <span className="pt-1.5"><PlatformDot platform={tg.platform} /></span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px]">{PLATFORMS[tg.platform].name}</p>
                    {tg.error && <p className="text-[12px] text-neg-ink mt-0.5 break-words">{tg.error}</p>}
                    {tg.publishedAt && <p className="text-[12px] text-faint mt-0.5">{t('Publicado {when}', { when: relativeDay(tg.publishedAt) })}</p>}
                  </div>
                  {tg.remoteUrl && (
                    <button className="text-[13px] text-muted hover:text-ink inline-flex items-center gap-1" onClick={() => api.app.openExternal(tg.remoteUrl!)}>
                      {t('Ver')}{' '}<ExternalLink size={12} />
                    </button>
                  )}
                  <span className="text-[12px] text-faint w-24 text-right">
                    {t({ pending: 'Pendiente', publishing: 'Publicando', published: 'Publicado', failed: 'Falló', skipped: 'Omitido' }[tg.status])}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Drawer>
  )
}

function PlatformText({ platform, form, setForm }: { platform: Platform; form: Form; setForm: React.Dispatch<React.SetStateAction<Form>> }) {
  const meta = PLATFORMS[platform]
  const caption = form.captions[platform] ?? ''
  const shown = caption || form.body
  const limit = platform === 'x' && form.format !== 'thread' ? 280 - 25 : meta.maxChars
  const over = platform !== 'blog' && shown.length > limit
  const needsTitle = platform === 'youtube' || platform === 'blog'
  return (
    <div className="flex flex-col gap-3">
      {needsTitle && (
        <label>
          <Label>{platform === 'blog' ? t('Título del artículo') : t('Título del vídeo')}</Label>
          <input className="field" value={form.titles[platform] ?? ''} placeholder={form.title}
            onChange={(e) => setForm((f) => ({ ...f, titles: { ...f.titles, [platform]: e.target.value } }))} />
        </label>
      )}
      <label>
        <Label hint={caption ? undefined : t('Vacío: se usa el borrador base. Usa "Adaptar a cada red" para generarlo.')}>
          {platform === 'blog' ? t('Artículo (Markdown)') : t('Texto para {platform}', { platform: meta.name })}
        </Label>
        <textarea className={cx('field', platform === 'blog' ? 'min-h-[360px]' : 'min-h-[200px]')} value={caption} placeholder={form.body}
          onChange={(e) => setForm((f) => ({ ...f, captions: { ...f.captions, [platform]: e.target.value } }))} />
      </label>
      <p className={cx('text-[12px] tnum', over ? 'text-neg-ink' : 'text-faint')}>
        {shown.length.toLocaleString(locale())}
        {platform !== 'blog' && ` / ${limit.toLocaleString(locale())}`} {t('caracteres')}
        {meta.linkClickable && platform !== 'blog' ? t(' · el enlace con UTM se añade al publicar') : platform !== 'blog' ? t(' · aquí los enlaces no son clicables: usa "enlace en la bio"') : ''}
        {platform === 'x' && form.format === 'thread' ? t(' · separa los posts del hilo con una línea ---') : ''}
      </p>
    </div>
  )
}
