import { useState } from 'react'
import { Plus, Sparkles, Pencil } from 'lucide-react'
import type { ContentContext, ContentSeries, ContentSeriesInput, Platform, Script } from '@shared/types'
import { PLATFORM_IDS, PLATFORMS } from '@shared/types'
import { api } from '../../lib/api'
import { Button, Card, Drawer, Empty, ErrorNote, Label, PlatformDot, PlatformList } from '../../components/ui'
import { useToast } from '../../components/toast'
import { Chip, ChipGroup, toggle, type Lookup } from './common'
import { t } from '../../lib/i18n'

const blank: ContentSeriesInput = { name: '', premise: '', characterIds: [], styleId: null, templateId: null, contextIds: [], platforms: ['tiktok', 'instagram'], notes: '' }

export function SeriesView({
  series, scripts, contexts, lookup, onGenerate, onOpenScript
}: {
  series: ContentSeries[]
  scripts: Script[]
  contexts: ContentContext[]
  lookup: Lookup
  onGenerate: (seriesId: string) => void
  onOpenScript: (s: Script) => void
}) {
  const [editing, setEditing] = useState<{ id: string | null; form: ContentSeriesInput } | null>(null)

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[14px] text-muted max-w-[70ch]">
          {t('Una serie es una historia por episodios con los mismos personajes. Cada episodio nuevo sabe lo que pasó en los anteriores y continúa el arco sin repetir situaciones.')}
        </p>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing({ id: null, form: { ...blank, contextIds: contexts.filter((c) => c.isDefault).map((c) => c.id) } })}>
          {t('Nueva serie')}
        </Button>
      </div>

      {series.length ? (
        <div className="grid grid-cols-2 gap-[14px] max-[1180px]:grid-cols-1">
          {series.map((s) => {
            const eps = scripts.filter((x) => x.seriesId === s.id && x.status !== 'discarded').sort((a, b) => (b.episode ?? 0) - (a.episode ?? 0))
            return (
              <Card
                key={s.id}
                title={s.name}
                subtitle={[
                  s.characterIds.map((id) => lookup.ctx.get(id)?.name).filter(Boolean).join(', ') || t('Sin personajes'),
                  s.styleId ? lookup.ctx.get(s.styleId)?.name : t('Estilo libre'),
                  s.episodes === 1 ? t('1 episodio') : t('{n} episodios', { n: s.episodes })
                ].join(' · ')}
                action={
                  <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing({ id: s.id, form: { ...s } })}>
                    {t('Editar')}
                  </Button>
                }
              >
                <p className="text-[13px] text-muted line-clamp-3">{s.premise || t('Sin premisa.')}</p>
                {eps.length > 0 && (
                  <ol className="mt-4 flex flex-col gap-1">
                    {eps.slice(0, 5).map((e) => (
                      <li key={e.id}>
                        <button onClick={() => onOpenScript(e)} className="w-full text-left flex gap-3 text-[13px] py-1 hover:text-ink text-muted">
                          <span className="text-faint tnum w-6 shrink-0">{e.episode}.</span>
                          <span className="truncate">{e.title}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="flex items-center justify-between gap-3 mt-4">
                  <PlatformList platforms={s.platforms} names={false} />
                  <Button size="sm" variant="primary" icon={<Sparkles size={14} />} onClick={() => onGenerate(s.id)}>
                    {t('Episodio {n}', { n: s.episodes + 1 })}
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      ) : (
        <Card>
          <Empty title={t('Todavía no hay series')}>
            {t('Crea primero un personaje en Contextos y después una serie con su premisa: por ejemplo, «Lucía, autónoma, descubre cada semana un truco para ahorrar tiempo».')}
          </Empty>
        </Card>
      )}

      {editing && <SeriesDrawer id={editing.id} initial={editing.form} contexts={contexts} onClose={() => setEditing(null)} />}
    </div>
  )
}

function SeriesDrawer({ id, initial, contexts, onClose }: { id: string | null; initial: ContentSeriesInput; contexts: ContentContext[]; onClose: () => void }) {
  const toast = useToast()
  const [f, setF] = useState<ContentSeriesInput>(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof ContentSeriesInput>(k: K, v: ContentSeriesInput[K]): void => setF((x) => ({ ...x, [k]: v }))
  const of = (kind: ContentContext['kind']): ContentContext[] => contexts.filter((c) => c.kind === kind)

  async function save(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const { name, premise, characterIds, styleId, templateId, contextIds, platforms, notes } = f
      await api.content.saveSeries(id, { name, premise, characterIds, styleId, templateId, contextIds, platforms, notes })
      toast(t('Serie guardada'), 'success')
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function archive(): Promise<void> {
    if (!id || !window.confirm(t('¿Archivar esta serie? Sus guiones se conservan.'))) return
    await api.content.archiveSeries(id)
    onClose()
  }

  return (
    <Drawer
      open
      onClose={onClose}
      width={1040}
      title={id ? t('Editar serie') : t('Nueva serie')}
      footer={
        <>
          <Button variant="primary" loading={busy} onClick={save}>{t('Guardar')}</Button>
          <div className="flex-1" />
          {id && <Button variant="ghost" onClick={archive}>{t('Archivar')}</Button>}
        </>
      }
    >
      {/* Con sitio, dos columnas: la historia a la izquierda y la configuración a la derecha. */}
      <div className="grid gap-6 items-start @4xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-5 min-w-0">
        <label>
          <Label>{t('Nombre')}</Label>
          <input className="field" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={t('Las semanas de Lucía')} />
        </label>
        <label>
          <Label hint={t('De qué va la historia y hacia dónde evoluciona. La IA la usa para avanzar el arco en cada episodio.')}>{t('Premisa y arco')}</Label>
          <textarea className="field" style={{ minHeight: 200 }} value={f.premise} onChange={(e) => set('premise', e.target.value)} />
        </label>
        <label>
          <Label hint={t('Lugares recurrentes, personajes secundarios, cosas que no deben pasar...')}>{t('Notas para la IA')}</Label>
          <textarea className="field" style={{ minHeight: 120 }} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
      </div>
      <div className="flex flex-col gap-5 min-w-0">
        <div>
          <Label>{t('Personajes')}</Label>
          <ChipGroup empty={t('Crea antes un personaje en Contextos.')}>
            {of('character').map((c) => (
              <Chip key={c.id} active={!!f.characterIds?.includes(c.id)} onClick={() => set('characterIds', toggle(f.characterIds ?? [], c.id))} title={c.content}>{c.name}</Chip>
            ))}
          </ChipGroup>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label>
            <Label hint={t('Puedes cambiarlo en cada episodio.')}>{t('Estilo habitual')}</Label>
            <select className="field" value={f.styleId ?? ''} onChange={(e) => set('styleId', e.target.value || null)}>
              <option value="">{t('Que elija la IA')}</option>
              {of('style').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>
            <Label hint={t('Formato de los episodios.')}>{t('Plantilla')}</Label>
            <select className="field" value={f.templateId ?? ''} onChange={(e) => set('templateId', e.target.value || null)}>
              <option value="">{t('La que elijas al generar')}</option>
              {of('template').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
        <div>
          <Label>{t('Contexto')}</Label>
          <ChipGroup>
            {contexts.filter((c) => ['brand', 'audience', 'rule'].includes(c.kind)).map((c) => (
              <Chip key={c.id} active={!!f.contextIds?.includes(c.id)} onClick={() => set('contextIds', toggle(f.contextIds ?? [], c.id))}>{c.name}</Chip>
            ))}
          </ChipGroup>
        </div>
        <div>
          <Label>{t('Redes')}</Label>
          <ChipGroup>
            {PLATFORM_IDS.filter((p) => p !== 'blog').map((p) => (
              <Chip key={p} active={!!f.platforms?.includes(p)} onClick={() => set('platforms', toggle(f.platforms ?? [], p) as Platform[])}>
                <PlatformDot platform={p} />
                {PLATFORMS[p].name}
              </Chip>
            ))}
          </ChipGroup>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
      </div>
    </Drawer>
  )
}
