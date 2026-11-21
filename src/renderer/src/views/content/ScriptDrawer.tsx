import { useEffect, useState } from 'react'
import { Copy, Plus, Trash2, CalendarPlus, ExternalLink, Clapperboard, FolderOpen, Loader2, RotateCw } from 'lucide-react'
import type { Platform, Script, ScriptScene, ScriptStatus, VideoClip } from '@shared/types'
import { FORMAT_LABEL, PLATFORMS, SCRIPT_STATUS_LABEL } from '@shared/types'
import { api } from '../../lib/api'
import { Button, Drawer, ErrorNote, Label, PlatformDot, Segmented, cx } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useNav } from '../../App'
import { RefImage, SimilarNote, scriptMeta, type Lookup } from './common'
import { jobProgress, useJobs, useTick } from '../../lib/jobs'
import { locale, t } from '../../lib/i18n'

/** URL del protocolo allin-media para un archivo de la carpeta de vídeos (depth 2 = clip de escena). */
function mediaSrc(path: string, depth = 1): string {
  return `allin-media://video/${path.split(/[\\/]/).slice(-depth).map(encodeURIComponent).join('/')}`
}

/** Clip de una escena: se reproduce al pasar el ratón y se puede rehacer suelta. */
function SceneClip({ s, i, clip, vertical, canRedo, busy, onRedo }: {
  s: Script; i: number; clip: VideoClip; vertical: boolean; canRedo: boolean; busy: boolean; onRedo: (i: number, note: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const sc = s.scenes[i]

  async function redo(): Promise<void> {
    setSending(true)
    const ok = await onRedo(i, note)
    setSending(false)
    if (ok) {
      setOpen(false)
      setNote('')
    }
  }

  return (
    <div className="bg-surface rounded-xl p-3 flex gap-3 items-start">
      <video
        src={mediaSrc(clip.path, 2)}
        muted
        loop
        playsInline
        preload="metadata"
        title={t('Pasa el ratón para verla')}
        onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
        onMouseLeave={(e) => e.currentTarget.pause()}
        className={cx('rounded-lg bg-black shrink-0', vertical ? 'w-[72px] aspect-[9/16]' : 'w-[160px] aspect-video')}
      />
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium tnum">
              {t('Escena {n}', { n: i + 1 })} <span className="text-faint font-normal">· {Math.round(clip.durationSec * 10) / 10} s</span>
            </p>
            {sc && <p className="text-[12px] text-muted line-clamp-2 mt-0.5">{sc.onScreenText || sc.voiceover || sc.visual}</p>}
          </div>
          {canRedo && !open && (
            <Button size="sm" variant="ghost" icon={<RotateCw size={14} />} disabled={busy} onClick={() => setOpen(true)}>
              {t('Rehacer')}
            </Button>
          )}
        </div>
        {open && (
          <>
            <textarea
              className="field"
              rows={2}
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('Qué cambiar (opcional). Ej.: el personaje más grande y el texto arriba')}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" loading={sending} disabled={busy} onClick={() => void redo()}>{t('Rehacer escena')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t('Cancelar')}</Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Vídeo animado que Opus diseña a partir del guion, con su progreso en segundo plano. */
function VideoSection({ s, dirty, save }: { s: Script; dirty: boolean; save: () => Promise<Script | null> }) {
  const toast = useToast()
  const jobs = useJobs().filter((j) => j.kind === 'video' && j.refId === s.id)
  const running = jobs.find((j) => j.status === 'running')
  const failed = !running ? jobs.find((j) => j.status === 'error') : undefined
  const now = useTick(!!running)
  const [starting, setStarting] = useState(false)
  const vertical = s.format !== 'video'

  async function generate(): Promise<void> {
    // El vídeo se hace con el guion guardado: guardamos antes los cambios pendientes.
    if (dirty && !(await save())) return
    setStarting(true)
    try {
      await api.content.generateVideo(s.id)
      toast(t('Generando el vídeo en segundo plano. Puedes seguir trabajando; te avisaremos al terminar.'))
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setStarting(false)
    }
  }

  async function redo(i: number, note: string): Promise<boolean> {
    // Se rehace con el texto guardado de la escena: guardamos antes los cambios pendientes.
    if (dirty && !(await save())) return false
    try {
      await api.content.regenerateScene(s.id, i, note)
      toast(t('Rehaciendo la escena {n} en segundo plano. Te avisaremos al terminar.', { n: i + 1 }))
      return true
    } catch (e) {
      toast((e as Error).message, 'error')
      return false
    }
  }

  const src = s.video ? mediaSrc(s.video.path) : ''
  const clips = s.video?.clips ?? []
  const sameScenes = clips.length === s.scenes.length
  return (
    <section className="bg-ground rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">{t('Vídeo')}</h3>
          <p className="text-[13px] text-faint mt-0.5">
            {vertical ? t('Opus diseña la animación de cada escena (texto en movimiento, ilustraciones y tus personajes, con sus piezas si las tienen o dibujados en SVG) y la app la graba en MP4 vertical 9:16. Sin voz.') : t('Opus diseña la animación de cada escena (texto en movimiento, ilustraciones y tus personajes, con sus piezas si las tienen o dibujados en SVG) y la app la graba en MP4 horizontal 16:9. Sin voz.')}
          </p>
        </div>
        {!running && (
          <Button variant={s.video ? 'secondary' : 'primary'} size="sm" icon={s.video ? <RotateCw size={14} /> : <Clapperboard size={14} />} loading={starting} onClick={() => void generate()}>
            {s.video ? t('Volver a generar') : t('Generar vídeo')}
          </Button>
        )}
      </div>

      {running && (
        <div className="flex items-center gap-3 mt-4 tnum">
          <Loader2 size={18} className="text-accent shrink-0 animate-[spin_0.8s_linear_infinite]" />
          <div className="min-w-0">
            <p className="text-[14px] text-ink">{running.label}</p>
            <p className="text-[12px] text-faint">{jobProgress(running, now)} · {t('puedes cerrar este panel')}</p>
          </div>
        </div>
      )}
      {failed && <div className="mt-3"><ErrorNote>{t('No se pudo generar el vídeo:')}{' '}{failed.error}</ErrorNote></div>}

      {s.video && (
        <div className="flex gap-4 mt-4 items-start">
          <video
            key={src}
            src={src}
            controls
            className={cx('rounded-xl bg-black shrink-0', vertical ? 'w-[220px] aspect-[9/16]' : 'w-[440px] aspect-video')}
          />
          <div className="flex flex-col gap-2 text-[13px] text-muted tnum">
            <p>{s.video.durationSec} s · {t('{n} escenas', { n: s.video.scenes })} · {s.video.width}×{s.video.height}</p>
            <p>{(s.video.sizeBytes / 1_048_576).toLocaleString(locale(), { maximumFractionDigits: 1 })} MB · {new Date(s.video.createdAt).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' })}</p>
            <p className="text-faint">{s.postId ? t('Ya está adjunto a su publicación.') : t('Se adjuntará solo al llevar el guion al calendario.')}</p>
            <Button size="sm" variant="ghost" icon={<FolderOpen size={14} />} onClick={() => void api.app.showItem(s.video!.path)}>
              {t('Mostrar en la carpeta')}
            </Button>
          </div>
        </div>
      )}

      {s.video && (clips.length ? (
        <div className="mt-5 flex flex-col gap-2">
          <Label hint={sameScenes ? t('Rehaz solo la que no te guste: se vuelve a animar con el mismo estilo y se une al resto.') : undefined}>{t('Escenas')}</Label>
          {!sameScenes && (
            <p className="text-[12px] text-warning">{t('Has cambiado el número de escenas del guion: vuelve a generar el vídeo entero para poder rehacerlas sueltas.')}</p>
          )}
          {clips.map((c, i) => (
            <SceneClip key={c.path} s={s} i={i} clip={c} vertical={vertical} canRedo={sameScenes} busy={!!running} onRedo={redo} />
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-faint mt-4">{t('Este vídeo se hizo antes de guardar cada escena por separado. Vuelve a generarlo una vez para poder rehacer escenas sueltas.')}</p>
      ))}
    </section>
  )
}

const blankScene: ScriptScene = { time: '', visual: '', voiceover: '', onScreenText: '' }

function defaultWhen(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(19, 0, 0, 0)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ScriptDrawer({ script, lookup, onClose }: { script: Script; lookup: Lookup; onClose: () => void }) {
  const toast = useToast()
  const nav = useNav()
  const [s, setS] = useState<Script>(script)
  const [tab, setTab] = useState<Platform>(script.platforms[0] ?? 'tiktok')
  const [when, setWhen] = useState(defaultWhen)
  const [busy, setBusy] = useState<'' | 'save' | 'post' | 'delete'>('')
  const [error, setError] = useState('')
  const dirty = JSON.stringify(s) !== JSON.stringify(script)

  useEffect(() => setS(script), [script])

  const set = <K extends keyof Script>(k: K, v: Script[K]): void => setS((x) => ({ ...x, [k]: v }))
  const setScene = (i: number, patch: Partial<ScriptScene>): void => set('scenes', s.scenes.map((sc, j) => (j === i ? { ...sc, ...patch } : sc)))
  const setCaption = (p: Platform, patch: Partial<{ title: string; caption: string }>): void =>
    set('captions', { ...s.captions, [p]: { title: '', caption: '', ...s.captions[p], ...patch } })

  async function save(patch: Partial<Script> = {}): Promise<Script | null> {
    setError('')
    setBusy('save')
    try {
      const { id, createdAt, updatedAt, ...rest } = { ...s, ...patch }
      const saved = await api.content.updateScript(id, rest)
      setS(saved)
      return saved
    } catch (e) {
      setError((e as Error).message)
      return null
    } finally {
      setBusy('')
    }
  }

  async function setStatus(status: ScriptStatus): Promise<void> {
    if (await save({ status })) toast(t('Guion marcado como {status}', { status: t(SCRIPT_STATUS_LABEL[status]).toLowerCase() }), 'success')
  }

  async function copy(text: string, what: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    toast(t('{what} copiado', { what: t(what) }), 'success')
  }

  async function toPost(status: 'draft' | 'scheduled'): Promise<void> {
    if (dirty && !(await save())) return
    setBusy('post')
    try {
      const p = await api.content.toPost(s.id, new Date(when).toISOString(), status)
      toast(status === 'scheduled' ? t('Publicación programada') : t('Publicación creada como borrador'), 'success')
      onClose()
      nav.edit({ id: p.id })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(t('¿Borrar este guion? Si solo no te gusta, mejor márcalo como descartado: así la IA sabrá que no debe repetirlo.'))) return
    setBusy('delete')
    try {
      await api.content.deleteScript(s.id)
      onClose()
    } finally {
      setBusy('')
    }
  }

  const chars = s.characterIds.map((id) => lookup.ctx.get(id)).filter((c) => !!c)
  const refs = chars.flatMap((c) => c.images.map((file) => ({ name: c.name, file })))
  const missingSheet = chars.filter((c) => !c.images.length).map((c) => c.name)
  const caption = s.captions[tab] ?? { title: '', caption: '' }
  const max = PLATFORMS[tab].maxChars

  return (
    <Drawer
      open
      onClose={onClose}
      width={1240}
      title={s.title || t('Guion')}
      footer={
        <>
          <Button variant="primary" loading={busy === 'save'} disabled={!dirty} onClick={() => void save().then((x) => x && toast(t('Guion guardado'), 'success'))}>
            {t('Guardar')}
          </Button>
          <Button icon={<Copy size={14} />} onClick={() => void api.content.scriptText(s.id).then((tg) => copy(tg, 'Guion'))}>
            {t('Copiar guion')}
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" icon={<Trash2 size={14} />} loading={busy === 'delete'} onClick={remove}>
            {t('Borrar')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <div>
          <p className="text-[13px] text-faint">{scriptMeta(s, lookup)} · {t(FORMAT_LABEL[s.format])}{s.durationSec ? ` · ${s.durationSec} s` : ''}</p>
          {s.similarTo && <div className="mt-2"><SimilarNote s={s} /></div>}
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            <Segmented<ScriptStatus>
              value={s.status}
              onChange={(v) => void setStatus(v)}
              options={(['draft', 'approved', 'discarded'] as ScriptStatus[]).concat(s.status === 'used' ? ['used'] : []).map((v) => ({ value: v, label: t(SCRIPT_STATUS_LABEL[v]) }))}
            />
            <span className="text-[12px] text-faint">{t('Los descartados también cuentan para no repetir.')}</span>
          </div>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {/* Con sitio, dos columnas: lo que se escribe (texto y escenas) y lo que se produce y publica. */}
        <div className="grid gap-6 items-start @5xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6 min-w-0">
        <section className="flex flex-col gap-3">
          <label>
            <Label>{t('Título')}</Label>
            <input className="field" value={s.title} onChange={(e) => set('title', e.target.value)} />
          </label>
          <label>
            <Label>{t('Gancho')}</Label>
            <input className="field" value={s.hook} onChange={(e) => set('hook', e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <Label>{t('Ángulo')}</Label>
              <input className="field" value={s.angle} onChange={(e) => set('angle', e.target.value)} />
            </label>
            <label>
              <Label>{t('Palabra clave')}</Label>
              <input className="field" value={s.keyword} onChange={(e) => set('keyword', e.target.value)} />
            </label>
          </div>
          <label>
            <Label hint={t('Es la memoria de la IA: se usa para no repetir y para continuar la serie.')}>{t('Resumen')}</Label>
            <textarea className="field" rows={2} value={s.summary} onChange={(e) => set('summary', e.target.value)} />
          </label>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[15px] font-semibold">{t('Escenas')}</h3>
            <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => set('scenes', [...s.scenes, { ...blankScene }])}>
              {t('Añadir escena')}
            </Button>
          </div>
          <div className="flex flex-col gap-3">
            {s.scenes.map((sc, i) => (
              <div key={i} className="bg-ground rounded-2xl p-4 grid grid-cols-[110px_minmax(0,1fr)] gap-3">
                <div className="flex flex-col gap-2">
                  <input className="field tnum" value={sc.time} onChange={(e) => setScene(i, { time: e.target.value })} placeholder="0-3 s" aria-label={t('Tiempo')} />
                  <button className="text-[12px] text-faint hover:text-neg-ink text-left" onClick={() => set('scenes', s.scenes.filter((_, j) => j !== i))}>
                    {t('Quitar')}
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  <textarea className="field" rows={2} value={sc.visual} onChange={(e) => setScene(i, { visual: e.target.value })} placeholder={t('Lo que se ve')} aria-label={t('Lo que se ve')} />
                  <textarea className="field" rows={2} value={sc.voiceover} onChange={(e) => setScene(i, { voiceover: e.target.value })} placeholder={t('Lo que se dice')} aria-label={t('Lo que se dice')} />
                  <input className="field" value={sc.onScreenText} onChange={(e) => setScene(i, { onScreenText: e.target.value })} placeholder={t('Texto en pantalla')} aria-label={t('Texto en pantalla')} />
                </div>
              </div>
            ))}
          </div>
          <label className="block mt-3">
            <Label>{t('Llamada a la acción')}</Label>
            <input className="field" value={s.cta} onChange={(e) => set('cta', e.target.value)} />
          </label>
        </section>
        </div>

        <div className="flex flex-col gap-6 min-w-0">
        {/* Solo los formatos de vídeo; un post de LinkedIn o un hilo no llevan vídeo. */}
        {(s.format === 'short' || s.format === 'video') && <VideoSection s={s} dirty={dirty} save={save} />}

        <section>
          <div className="flex items-center justify-between mb-2">
            <Label hint={t('Para generar el vídeo o las imágenes con IA. Lleva la descripción fija del personaje.')}>{t('Prompt visual')}</Label>
            <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void copy(s.visualPrompt, 'Prompt')}>
              {t('Copiar')}
            </Button>
          </div>
          <textarea className="field font-mono text-[12.5px]" rows={5} value={s.visualPrompt} onChange={(e) => set('visualPrompt', e.target.value)} />
          {refs.length > 0 && (
            <div className="mt-3">
              <p className="text-[12px] text-faint mb-2">{t('Adjunta estas hojas de personaje como referencia al generar el vídeo (clic para abrir la carpeta):')}</p>
              <div className="flex gap-3 flex-wrap">
                {refs.map(({ name, file }) => (
                  <div key={file} className="w-[110px]">
                    <RefImage file={file} className="w-[110px] h-[110px]" onClick={() => void api.app.showItem(file)} />
                    <p className="text-[12px] text-muted mt-1 truncate">{name}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {missingSheet.length > 0 && (
            <p className="text-[12px] text-warning mt-2">{t('Sin hoja de personaje: {names}. Añádela en Contextos › Personajes para que salgan siempre iguales.', { names: missingSheet.join(', ') })}</p>
          )}
        </section>

        <section>
          <h3 className="text-[15px] font-semibold">{t('Texto para cada red')}</h3>
          <p className="text-[13px] text-faint mt-1 mb-3">{t('Es el mismo vídeo con distinta descripción. Al publicarlo, cada red guarda sus propias estadísticas.')}</p>
          <div className="flex gap-2 flex-wrap mb-3">
            {s.platforms.map((p) => (
              <button
                key={p}
                onClick={() => setTab(p)}
                className={cx('inline-flex items-center gap-2 h-[30px] px-3 rounded-full text-[13px]', tab === p ? 'bg-raised text-ink' : 'text-muted hover:text-ink')}
              >
                <PlatformDot platform={p} />
                {PLATFORMS[p].name}
              </button>
            ))}
          </div>
          {(tab === 'youtube' || tab === 'blog') && (
            <label className="block mb-3">
              <Label>{t('Título')}</Label>
              <input className="field" value={caption.title} onChange={(e) => setCaption(tab, { title: e.target.value })} />
            </label>
          )}
          <textarea className="field" rows={7} value={caption.caption} onChange={(e) => setCaption(tab, { caption: e.target.value })} />
          <div className="flex justify-between mt-1.5">
            <span className={cx('text-[12px] tnum', caption.caption.length > max ? 'text-neg-ink' : 'text-faint')}>
              {caption.caption.length.toLocaleString(locale())} / {max.toLocaleString(locale())}
            </span>
            <button className="text-[12px] text-muted hover:text-ink" onClick={() => void copy(caption.caption, 'Texto')}>
              {t('Copiar texto')}
            </button>
          </div>
        </section>

        <section>
          <label>
            <Label>{t('Notas')}</Label>
            <textarea className="field" rows={2} value={s.notes} onChange={(e) => set('notes', e.target.value)} placeholder={t('Dónde grabar, material que falta...')} />
          </label>
        </section>

        <section className="bg-ground rounded-2xl p-4">
          <h3 className="text-[15px] font-semibold">{t('Llevar al calendario')}</h3>
          {s.postId ? (
            <div className="flex items-center gap-3 mt-3">
              <p className="text-[13px] text-muted flex-1">{t('Este guion ya tiene su publicación.')}</p>
              <Button size="sm" icon={<ExternalLink size={14} />} onClick={() => { onClose(); nav.edit({ id: s.postId! }) }}>
                {t('Abrir publicación')}
              </Button>
            </div>
          ) : (
            <>
              <p className="text-[13px] text-faint mt-1">{t('Crea una sola publicación con un destino por red y el texto de cada una.')}{' '}{s.video ? t('El vídeo generado se adjunta solo.') : t('Después adjuntas el vídeo en el editor.')}</p>
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <input type="datetime-local" className="field w-[220px]" value={when} onChange={(e) => setWhen(e.target.value)} />
                <Button icon={<CalendarPlus size={14} />} loading={busy === 'post'} onClick={() => void toPost('draft')}>
                  {t('Crear borrador')}
                </Button>
                <Button variant="primary" loading={busy === 'post'} onClick={() => void toPost('scheduled')}>
                  {t('Programar')}
                </Button>
              </div>
            </>
          )}
        </section>
        </div>
        </div>
      </div>
    </Drawer>
  )
}
