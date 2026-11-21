import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Eye, Loader2, X } from 'lucide-react'
import type { ContentContext, ContentSeries, Platform, Script, ScriptRequest } from '@shared/types'
import { FORMAT_LABEL, PLATFORM_IDS, PLATFORMS } from '@shared/types'
import { api } from '../../lib/api'
import { jobProgress, useJobs, useTick } from '../../lib/jobs'
import { Button, Card, Drawer, Empty, ErrorNote, Label, PlatformDot, Segmented } from '../../components/ui'
import { Chip, ChipGroup, ScriptCard, toggle, type Lookup } from './common'
import { t } from '../../lib/i18n'

export interface GeneratorPreset {
  seriesId: string | null
  /** Cambia en cada petición para que el formulario se vuelva a aplicar. */
  nonce: number
}

const emptyReq = (contexts: ContentContext[]): ScriptRequest => ({
  templateId: contexts.find((c) => c.kind === 'template')?.id ?? null,
  contextIds: contexts.filter((c) => c.isDefault && ['brand', 'audience', 'rule'].includes(c.kind)).map((c) => c.id),
  characterIds: [],
  styleId: null,
  seriesId: null,
  topic: '',
  platforms: ['tiktok', 'instagram'],
  count: 1
})

function applySeries(req: ScriptRequest, s: ContentSeries | undefined): ScriptRequest {
  if (!s) return { ...req, seriesId: null }
  return {
    ...req,
    seriesId: s.id,
    characterIds: s.characterIds,
    styleId: s.styleId,
    templateId: s.templateId ?? req.templateId,
    contextIds: s.contextIds.length ? s.contextIds : req.contextIds,
    platforms: s.platforms.length ? s.platforms : req.platforms
  }
}

export function Generator({
  contexts, series, scripts, lookup, preset, onOpen, onEditContexts
}: {
  contexts: ContentContext[]
  scripts: Script[]
  series: ContentSeries[]
  lookup: Lookup
  preset: GeneratorPreset | null
  onOpen: (s: Script) => void
  onEditContexts: () => void
}) {
  const [req, setReq] = useState<ScriptRequest>(() => emptyReq(contexts))
  const [busy, setBusy] = useState<'' | 'gen' | 'preview'>('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ system: string; prompt: string } | null>(null)
  // Las tareas viven en el proceso principal: siguen aunque salgas de esta vista y vuelvas.
  const jobs = useJobs().filter((j) => j.kind === 'script')
  const running = jobs.filter((j) => j.status === 'running')
  const failed = jobs.filter((j) => j.status === 'error')
  const now = useTick(running.length > 0)
  useEffect(() => {
    if (preset) setReq((r) => applySeries(r, series.find((s) => s.id === preset.seriesId)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.nonce])

  const of = (kind: ContentContext['kind']): ContentContext[] => contexts.filter((c) => c.kind === kind)
  const set = <K extends keyof ScriptRequest>(k: K, v: ScriptRequest[K]): void => setReq((r) => ({ ...r, [k]: v }))
  const template = req.templateId ? lookup.ctx.get(req.templateId) : undefined
  const allowed = useMemo(() => PLATFORM_IDS.filter((p) => !template?.format || PLATFORMS[p].formats.includes(template.format)), [template])
  // Leemos los guiones de la lista común para que los cambios hechos en el editor se vean aquí.
  const results = jobs.flatMap((j) => j.resultIds).map((id) => scripts.find((x) => x.id === id)).filter((x): x is Script => !!x)
  const currentSeries = req.seriesId ? series.find((s) => s.id === req.seriesId) : undefined

  // Si la plantilla cambia de formato, quitamos las redes que no lo admiten.
  useEffect(() => {
    setReq((r) => ({ ...r, platforms: r.platforms.filter((p) => allowed.includes(p)) }))
  }, [allowed])

  async function generate(): Promise<void> {
    setError('')
    setBusy('gen')
    try {
      await api.content.generate(req)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function showPrompt(): Promise<void> {
    setBusy('preview')
    try {
      setPreview(await api.content.previewPrompt(req))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="grid grid-cols-[460px_minmax(0,1fr)] gap-[14px] items-start max-[1180px]:grid-cols-1">
      <div className="flex flex-col gap-[14px]">
        <Card title={t('Qué quieres crear')}>
          <div className="flex flex-col gap-5">
            <label>
              <Label hint={t('Para seguir una historia con el mismo personaje, elige una serie.')}>{t('Serie')}</Label>
              <select className="field" value={req.seriesId ?? ''} onChange={(e) => setReq((r) => applySeries(r, series.find((s) => s.id === e.target.value)))}>
                <option value="">{t('Pieza suelta')}</option>
                {series.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {t('siguiente: episodio {n}', { n: s.episodes + 1 })}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <Label>{t('Plantilla')}</Label>
              <ChipGroup empty={t('No hay plantillas. Crea una en Contextos.')}>
                {of('template').map((c) => (
                  <Chip key={c.id} active={req.templateId === c.id} onClick={() => set('templateId', c.id)} title={c.content}>
                    {c.name}
                  </Chip>
                ))}
              </ChipGroup>
              {template && (
                <p className="text-[12px] text-faint mt-2">
                  {t(FORMAT_LABEL[template.format ?? 'short'])}{template.durationSec ? ` · ${template.durationSec} s` : ''}
                </p>
              )}
            </div>

            <div>
              <Label hint={t('Se copian tal cual en cada guion para que no cambien de un día a otro.')}>{t('Personajes')}</Label>
              <ChipGroup empty={<>{t('Aún no tienes personajes.')}{' '}<button className="underline underline-offset-4" onClick={onEditContexts}>{t('Crea uno')}</button>.</>}>
                {of('character').map((c) => (
                  <Chip key={c.id} active={req.characterIds.includes(c.id)} onClick={() => set('characterIds', toggle(req.characterIds, c.id))} title={c.content}>
                    {c.name}
                  </Chip>
                ))}
              </ChipGroup>
            </div>

            <div>
              <Label>{t('Estilo')}</Label>
              <ChipGroup>
                {[
                  <Chip key="free" active={req.styleId === null} onClick={() => set('styleId', null)} title={t('La IA elige uno distinto al de los últimos guiones')}>
                    {t('Que elija la IA')}
                  </Chip>,
                  ...of('style').map((c) => (
                    <Chip key={c.id} active={req.styleId === c.id} onClick={() => set('styleId', c.id)} title={c.content}>
                      {c.name}
                    </Chip>
                  ))
                ]}
              </ChipGroup>
            </div>

            <div>
              <Label>{t('Contexto')}</Label>
              <ChipGroup empty={t('Sin marca, público ni reglas. Añádelos en Contextos.')}>
                {contexts.filter((c) => ['brand', 'audience', 'rule'].includes(c.kind)).map((c) => (
                  <Chip key={c.id} active={req.contextIds.includes(c.id)} onClick={() => set('contextIds', toggle(req.contextIds, c.id))} title={c.content}>
                    {c.name}
                  </Chip>
                ))}
              </ChipGroup>
            </div>

            <label>
              <Label hint={t('Déjalo vacío y la IA propondrá un tema que no hayas tocado.')}>{t('Tema o idea')}</Label>
              <textarea className="field" rows={3} value={req.topic} onChange={(e) => set('topic', e.target.value)} placeholder={currentSeries ? t('Qué debería pasar en este episodio (opcional)') : t('Por ejemplo: los 3 errores al elegir...')} />
            </label>

            <div>
              <Label hint={t('Es el mismo vídeo con un texto distinto en cada red.')}>{t('Redes')}</Label>
              <ChipGroup>
                {allowed.map((p) => (
                  <Chip key={p} active={req.platforms.includes(p)} onClick={() => set('platforms', toggle(req.platforms, p) as Platform[])}>
                    <PlatformDot platform={p} />
                    {PLATFORMS[p].name}
                  </Chip>
                ))}
              </ChipGroup>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label>{currentSeries ? t('Episodios a la vez') : t('Guiones a la vez')}</Label>
              <Segmented value={req.count} onChange={(v) => set('count', v)} options={[1, 2, 3, 5].map((n) => ({ value: n, label: String(n) }))} />
            </div>

            {error && <ErrorNote>{error}</ErrorNote>}

            <div className="flex items-center gap-2">
              <Button variant="primary" icon={<Sparkles size={15} />} loading={busy === 'gen'} disabled={busy === 'gen' || !req.platforms.length} onClick={generate}>
                {t('Generar')}
              </Button>
              <Button variant="ghost" icon={<Eye size={15} />} loading={busy === 'preview'} disabled={busy === 'preview'} onClick={showPrompt}>
                {t('Ver prompt')}
              </Button>
            </div>
            {running.length > 0 && (
              <p className="text-[12px] text-faint -mt-2">
                {t('Se genera en segundo plano: puedes cambiar de vista o cerrar la ventana a la bandeja, y te avisaremos al terminar.')}
              </p>
            )}
          </div>
        </Card>
      </div>

      <div className="flex flex-col gap-[14px]">
        {running.map((j) => (
          <Card key={j.id}>
            <div className="flex items-center gap-3 tnum">
              <Loader2 size={18} className="text-accent shrink-0 animate-[spin_0.8s_linear_infinite]" />
              <div className="min-w-0">
                <p className="text-[14px] text-ink">{t('{label} en segundo plano', { label: j.label })}</p>
                <p className="text-[12px] text-faint">{jobProgress(j, now)} · {t('revisa lo ya hecho para no repetir')}</p>
              </div>
            </div>
          </Card>
        ))}
        {failed.map((j) => (
          <div key={j.id} className="relative">
            <ErrorNote>{j.label}: {j.error}</ErrorNote>
            <button className="absolute top-2 right-2 text-faint hover:text-ink" aria-label={t('Cerrar')} onClick={() => api.jobs.dismiss(j.id)}>
              <X size={14} />
            </button>
          </div>
        ))}
        {results.length ? (
          results.map((s) => <ScriptCard key={s.id} s={s} lookup={lookup} onOpen={() => onOpen(s)} />)
        ) : running.length ? null : (
          <Card>
            <Empty title={t('Los guiones aparecerán aquí')}>
              {t('Cada guion lleva escenas, prompt visual y el texto de cada red. Se guardan solos en Guiones; desde allí puedes aprobarlos, descartarlos o llevarlos al calendario.')}
            </Empty>
          </Card>
        )}
      </div>

      {preview && (
        <Drawer open onClose={() => setPreview(null)} width={760} title={t('Prompt que se enviará')}>
          <p className="text-[13px] text-faint mb-2">{t('Instrucciones fijas')}</p>
          <pre className="whitespace-pre-wrap text-[12.5px] bg-ground rounded-2xl p-4 text-muted max-h-[260px] overflow-y-auto">{preview.system}</pre>
          <p className="text-[13px] text-faint mt-5 mb-2">{t('Encargo, con tus contextos y lo ya hecho')}</p>
          <pre className="whitespace-pre-wrap text-[12.5px] bg-ground rounded-2xl p-4">{preview.prompt}</pre>
        </Drawer>
      )}
    </div>
  )
}
