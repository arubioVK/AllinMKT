import { useEffect, useState } from 'react'
import { Plus, ImagePlus, Copy, X, Layers } from 'lucide-react'
import type { ContentContext, ContentContextInput, ContextKind, Format, VisualPart } from '@shared/types'
import { CONTEXT_KINDS, CONTEXT_KIND_META, FORMATS, FORMAT_LABEL } from '@shared/types'
import { api } from '../../lib/api'
import { Button, Drawer, Empty, ErrorNote, Label, Pill, Segmented, Toggle, cx } from '../../components/ui'
import { useToast } from '../../components/toast'
import { RefImage } from './common'
import { t } from '../../lib/i18n'

const DEFAULTABLE: ContextKind[] = ['brand', 'audience', 'rule']

/** Metadatos del tipo de contexto en el idioma de la interfaz. */
function kindMeta(kind: ContextKind): (typeof CONTEXT_KIND_META)[ContextKind] {
  const m = CONTEXT_KIND_META[kind]
  return { label: t(m.label), singular: t(m.singular), help: t(m.help), placeholder: t(m.placeholder) }
}

export function Contexts({ contexts }: { contexts: ContentContext[] }) {
  const [kind, setKind] = useState<ContextKind>('character')
  const [editing, setEditing] = useState<{ id: string | null; form: ContentContextInput } | null>(null)
  const meta = kindMeta(kind)
  const list = contexts.filter((c) => c.kind === kind)

  return (
    <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-[14px] items-start">
      <nav className="flex flex-col gap-0.5" aria-label={t('Tipos de contexto')}>
        {CONTEXT_KINDS.map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            aria-current={k === kind ? 'true' : undefined}
            className={cx('h-9 px-3 rounded-lg flex items-center justify-between text-[14px]', k === kind ? 'bg-surface text-ink' : 'text-muted hover:text-ink')}
          >
            {t(CONTEXT_KIND_META[k].label)}
            <span className="text-[12px] text-faint tnum">{contexts.filter((c) => c.kind === k).length}</span>
          </button>
        ))}
      </nav>

      <div className="flex flex-col gap-[14px] min-w-0">
        <div className="flex items-start justify-between gap-4">
          <p className="text-[14px] text-muted max-w-[70ch]">{meta.help}</p>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing({ id: null, form: { kind, name: '', content: '', format: kind === 'template' ? 'short' : null, durationSec: kind === 'template' ? 30 : 0 } })}>
            {t('Nuevo {kind}', { kind: meta.singular })}
          </Button>
        </div>
        {list.length ? (
          <div className="grid grid-cols-2 gap-[14px] max-[1180px]:grid-cols-1">
            {list.map((c) => (
              <button key={c.id} onClick={() => setEditing({ id: c.id, form: { ...c } })} className="text-left bg-surface hover:bg-hover rounded-[20px] p-[18px] transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-[15px] font-semibold">{c.name}</h3>
                  {c.isDefault && <Pill>{t('Por defecto')}</Pill>}
                </div>
                {c.kind === 'template' && (
                  <p className="text-[12px] text-faint mt-1">{t(FORMAT_LABEL[c.format ?? 'short'])}{c.durationSec ? ` · ${c.durationSec} s` : ''}</p>
                )}
                {c.kind === 'character' && (
                  <p className={cx('text-[12px] mt-1', c.images.length ? 'text-faint' : 'text-warning')}>
                    {c.images.length === 1 ? t('Hoja de personaje: 1 imagen') : c.images.length ? t('Hoja de personaje: {n} imágenes', { n: c.images.length }) : t('Sin hoja de personaje')}
                    {' · '}
                    <span className={c.parts.length ? 'text-faint' : undefined}>
                      {c.parts.length === 1 ? t('1 pieza para animar') : c.parts.length ? t('{n} piezas para animar', { n: c.parts.length }) : t('sin piezas: Opus lo dibuja')}
                    </span>
                  </p>
                )}
                {c.kind === 'scenery' && (
                  <p className={cx('text-[12px] mt-1', c.parts.length ? 'text-faint' : 'text-warning')}>
                    {c.parts.length === 1 ? t('1 fondo') : c.parts.length ? t('{n} fondos', { n: c.parts.length }) : t('Sin fondos')}
                  </p>
                )}
                <div className="flex gap-3 mt-2">
                  {(c.images[0] ?? c.parts[0]?.file) && <RefImage file={c.images[0] ?? c.parts[0].file} className="w-[96px] h-[96px] shrink-0" />}
                  <p className="text-[13px] text-muted line-clamp-4 whitespace-pre-line min-w-0">{c.content || t('Sin contenido.')}</p>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="bg-surface rounded-[20px] px-[22px]">
            <Empty title={t('No hay ningún {kind}', { kind: meta.singular })}>{meta.placeholder}</Empty>
          </div>
        )}
      </div>

      {editing && (
        <ContextDrawer
          id={editing.id}
          initial={editing.form}
          live={contexts.find((c) => c.id === editing.id) ?? null}
          styles={contexts.filter((c) => c.kind === 'style')}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function ContextDrawer({
  id, initial, live, styles, onClose
}: {
  id: string | null
  initial: ContentContextInput
  live: ContentContext | null
  styles: ContentContext[]
  onClose: () => void
}) {
  const toast = useToast()
  const [f, setF] = useState<ContentContextInput>(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const kind = f.kind ?? 'brand'
  const meta = kindMeta(kind)
  // Personajes y escenarios llevan imágenes: van a dos columnas (texto | imágenes) cuando hay sitio.
  const visual = kind === 'character' || kind === 'scenery'
  const set = <K extends keyof ContentContextInput>(k: K, v: ContentContextInput[K]): void => setF((x) => ({ ...x, [k]: v }))

  async function save(asCopy = false): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const { name, content, format, durationSec, isDefault } = f
      await api.content.saveContext(asCopy ? null : id, { kind, name: asCopy ? `${name} (${t('copia')})` : name, content, format, durationSec, isDefault })
      toast(asCopy ? t('Copia creada') : t('Guardado'), 'success')
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function archive(): Promise<void> {
    if (!id || !window.confirm(t('¿Archivar este {kind}? Los guiones que ya lo usan no cambian.', { kind: meta.singular }))) return
    await api.content.archiveContext(id)
    onClose()
  }

  return (
    <Drawer
      open
      onClose={onClose}
      width={visual ? 1180 : 820}
      title={id ? f.name || meta.singular : t('Nuevo {kind}', { kind: meta.singular })}
      footer={
        <>
          <Button variant="primary" loading={busy} onClick={() => void save()}>{t('Guardar')}</Button>
          {id && <Button onClick={() => void save(true)}>{t('Duplicar')}</Button>}
          <div className="flex-1" />
          {id && <Button variant="ghost" onClick={archive}>{t('Archivar')}</Button>}
        </>
      }
    >
      <div className={cx('grid gap-6 items-start', visual && '@4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]')}>
      <div className="flex flex-col gap-5 min-w-0">
        <p className="text-[13px] text-faint">{meta.help}</p>
        <label>
          <Label>{t('Nombre')}</Label>
          <input className="field" value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus={!id} />
        </label>
        {kind === 'template' && (
          <div className="grid grid-cols-2 gap-3">
            <label>
              <Label>{t('Formato')}</Label>
              <select className="field" value={f.format ?? 'short'} onChange={(e) => set('format', e.target.value as Format)}>
                {FORMATS.map((x) => <option key={x} value={x}>{t(FORMAT_LABEL[x])}</option>)}
              </select>
            </label>
            <label>
              <Label hint={t('0 si no aplica')}>{t('Duración (segundos)')}</Label>
              <input type="number" min={0} className="field tnum" value={f.durationSec ?? 0} onChange={(e) => set('durationSec', Math.max(0, Number(e.target.value) || 0))} />
            </label>
          </div>
        )}
        <label>
          <Label hint={kind === 'character' ? t('Sé muy concreto con el aspecto: se copia tal cual en el prompt visual de cada vídeo.') : undefined}>
            {kind === 'template' ? t('Estructura e instrucciones') : t('Descripción')}
          </Label>
          <textarea className="field" style={{ minHeight: 320 }} value={f.content} onChange={(e) => set('content', e.target.value)} placeholder={meta.placeholder} />
        </label>
        {DEFAULTABLE.includes(kind) && (
          <div className="flex items-center justify-between gap-4">
            <Label hint={t('Se marca sola al abrir el generador.')}>{t('Usar por defecto')}</Label>
            <Toggle checked={!!f.isDefault} onChange={(v) => set('isDefault', v)} label={t('Usar por defecto')} />
          </div>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
      {visual && (
        <div className="flex flex-col gap-5 min-w-0">
          {kind === 'character' && <CharacterSheet id={id} live={live} styles={styles} />}
          <PartsEditor id={id} live={live} kind={kind as 'character' | 'scenery'} styles={styles} />
        </div>
      )}
      </div>
    </Drawer>
  )
}

function CharacterSheet({ id, live, styles }: { id: string | null; live: ContentContext | null; styles: ContentContext[] }) {
  const toast = useToast()
  const [styleId, setStyleId] = useState<string>(styles.find((s) => /2D|animaci/i.test(s.name))?.id ?? '')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')

  if (!id || !live) {
    return <p className="text-[13px] text-faint">{t('Guarda el personaje para añadir su hoja de personaje.')}</p>
  }

  async function add(): Promise<void> {
    setError('')
    try {
      await api.content.addImages(id!)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function makePrompt(): Promise<void> {
    setError('')
    try {
      setPrompt(await api.content.sheetPrompt(id!, styleId || null))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section className="bg-ground rounded-2xl p-4 flex flex-col gap-4">
      <div>
        <h3 className="text-[15px] font-semibold">{t('Hoja de personaje')}</h3>
        <p className="text-[13px] text-faint mt-1">
          {t('Una imagen limpia con el personaje de frente, de tres cuartos, de perfil y de espaldas, con sus expresiones y su paleta. Si el personaje no tiene piezas, el generador de vídeo se la enseña a Opus para que lo dibuje copiándola; manda sobre la descripción.')}
        </p>
      </div>

      {live.images.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {live.images.map((f) => (
            <div key={f} className="relative group">
              <RefImage file={f} className="w-full aspect-square" onClick={() => void api.app.showItem(f)} />
              <button
                onClick={() => void api.content.removeImage(id, f)}
                className="absolute top-1.5 right-1.5 p-1 rounded-full bg-black/70 text-muted hover:text-ink opacity-0 group-hover:opacity-100 focus:opacity-100"
                aria-label={t('Quitar imagen')}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button icon={<ImagePlus size={14} />} onClick={add}>
          {live.images.length ? t('Añadir más') : t('Subir hoja de personaje')}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <Label hint={t('Si aún no la tienes: genera el prompt y pégalo en tu generador de imágenes (Midjourney, GPT Image, Higgsfield...).')}>{t('Crear la hoja con IA')}</Label>
        <div className="flex gap-2">
          <select className="field" value={styleId} onChange={(e) => setStyleId(e.target.value)} aria-label={t('Estilo de la hoja')}>
            <option value="">{t('Estilo neutro')}</option>
            {styles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <Button onClick={makePrompt}>{t('Generar prompt')}</Button>
        </div>
        {prompt && (
          <>
            <textarea className="field font-mono text-[12.5px]" rows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <div>
              <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void navigator.clipboard.writeText(prompt).then(() => toast(t('Prompt copiado'), 'success'))}>
                {t('Copiar prompt')}
              </Button>
            </div>
          </>
        )}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  )
}

/** Piezas del muñeco de un personaje o fondos de un escenario: el vídeo las usa tal cual. */
function PartsEditor({ id, live, kind, styles }: { id: string | null; live: ContentContext | null; kind: 'character' | 'scenery'; styles: ContentContext[] }) {
  const [error, setError] = useState('')
  const isSet = kind === 'scenery'

  if (!id || !live) {
    return <p className="text-[13px] text-faint">{isSet ? t('Guarda el escenario para añadir sus fondos.') : t('Guarda el personaje para añadir sus piezas.')}</p>
  }

  async function add(): Promise<void> {
    setError('')
    try {
      await api.content.addParts(id!)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section className="bg-ground rounded-2xl p-4 flex flex-col gap-4">
      <div>
        <h3 className="text-[15px] font-semibold">{isSet ? t('Fondos') : t('Piezas para animar')}</h3>
        <p className="text-[13px] text-faint mt-1">
          {isSet
            ? t('Un fondo por plano (general, primer plano...), sin personajes y con el tamaño del vídeo: 1080×1920 en vertical o 1920×1080 en horizontal. El vídeo los usa como decorado.')
            : t('Con piezas, Opus no dibuja al personaje: lo monta como un muñeco por capas y lo anima (poses, expresiones, boca al hablar). Así se ve igual que tu dibujo en todos los vídeos.')}
        </p>
        {!isSet && (
          <p className="text-[13px] text-faint mt-2">
            {t('Exporta cada capa de tu dibujo (Krita, Photoshop, Affinity, Inkscape...) como PNG transparente o SVG, todas con el mismo tamaño de lienzo: así se montan solas. Incluye varias bocas (cerrada, abierta, «o»), ojos abiertos y cerrados, y los brazos separados del cuerpo. En la nota explica para qué sirve cada pieza.')}
          </p>
        )}
      </div>

      {live.parts.length > 0 && (
        <div className="flex flex-col gap-2">
          {live.parts.map((p) => <PartRow key={p.file} id={id} part={p} wide={isSet} onError={setError} />)}
        </div>
      )}

      <div>
        <Button icon={isSet ? <ImagePlus size={14} /> : <Layers size={14} />} onClick={add}>
          {isSet ? (live.parts.length ? t('Añadir más fondos') : t('Subir fondos')) : live.parts.length ? t('Añadir más piezas') : t('Subir piezas')}
        </Button>
      </div>

      {isSet && <SceneryPrompt id={id} styles={styles} onError={setError} />}
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  )
}

function PartRow({ id, part, wide, onError }: { id: string; part: VisualPart; wide: boolean; onError: (msg: string) => void }) {
  const [name, setName] = useState(part.name)
  const [note, setNote] = useState(part.note)
  useEffect(() => {
    setName(part.name)
    setNote(part.note)
  }, [part.name, part.note])

  // Se guarda al salir del campo: así no hay que acordarse de pulsar Guardar en cada pieza.
  async function save(patch: { name?: string; note?: string }): Promise<void> {
    onError('')
    try {
      await api.content.updatePart(id, part.file, patch)
    } catch (e) {
      setName(part.name)
      onError((e as Error).message)
    }
  }

  return (
    <div className="bg-surface rounded-xl p-2.5 flex gap-3 items-start">
      <RefImage file={part.file} className={cx('shrink-0', wide ? 'w-[120px] h-[90px]' : 'w-[72px] h-[72px]')} onClick={() => void api.app.showItem(part.file)} />
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <input
            className="field h-8 font-mono text-[12.5px]"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== part.name && void save({ name })}
            aria-label={t('Nombre de la pieza')}
          />
          <span className="text-[12px] text-faint tnum shrink-0">{part.width && part.height ? `${part.width}×${part.height}` : ''}</span>
          <button onClick={() => void api.content.removePart(id, part.file)} className="p-1 rounded-full text-faint hover:text-ink shrink-0" aria-label={t('Quitar pieza')}>
            <X size={14} />
          </button>
        </div>
        <input
          className="field h-8 text-[13px]"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== part.note && void save({ note })}
          placeholder={wide ? t('Qué plano es y dónde queda el suelo') : t('Para qué sirve: "boca abierta, al hablar", "brazo derecho, gira en el hombro"...')}
          aria-label={t('Nota de la pieza')}
        />
      </div>
    </div>
  )
}

function SceneryPrompt({ id, styles, onError }: { id: string; styles: ContentContext[]; onError: (msg: string) => void }) {
  const toast = useToast()
  const [styleId, setStyleId] = useState<string>(styles.find((s) => /2D|animaci/i.test(s.name))?.id ?? '')
  const [vertical, setVertical] = useState(true)
  const [prompt, setPrompt] = useState('')

  async function make(): Promise<void> {
    onError('')
    try {
      setPrompt(await api.content.sceneryPrompt(id, styleId || null, vertical))
    } catch (e) {
      onError((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Label hint={t('Genera el prompt y pégalo en tu generador de imágenes. Usa el mismo estilo que en las piezas de los personajes.')}>{t('Crear un fondo con IA')}</Label>
      <div className="flex gap-2 items-center flex-wrap">
        <select className="field flex-1 min-w-[160px]" value={styleId} onChange={(e) => setStyleId(e.target.value)} aria-label={t('Estilo del fondo')}>
          <option value="">{t('Estilo neutro')}</option>
          {styles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <Segmented value={vertical ? 'v' : 'h'} options={[{ value: 'v', label: t('Vertical') }, { value: 'h', label: t('Horizontal') }]} onChange={(v) => setVertical(v === 'v')} />
        <Button onClick={make}>{t('Generar prompt')}</Button>
      </div>
      {prompt && (
        <>
          <textarea className="field font-mono text-[12.5px]" rows={9} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div>
            <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void navigator.clipboard.writeText(prompt).then(() => toast(t('Prompt copiado'), 'success'))}>
              {t('Copiar prompt')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
