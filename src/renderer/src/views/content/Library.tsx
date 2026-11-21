import { useMemo, useState } from 'react'
import type { ContentContext, ContentSeries, Script, ScriptStatus } from '@shared/types'
import { SCRIPT_STATUS_LABEL } from '@shared/types'
import { Card, Empty, Segmented } from '../../components/ui'
import { ScriptCard, type Lookup } from './common'
import { t } from '../../lib/i18n'

type StatusFilter = 'all' | ScriptStatus

export function Library({ scripts, contexts, series, lookup, onOpen }: { scripts: Script[]; contexts: ContentContext[]; series: ContentSeries[]; lookup: Lookup; onOpen: (s: Script) => void }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [seriesId, setSeriesId] = useState('')
  const [styleId, setStyleId] = useState('')
  const [characterId, setCharacterId] = useState('')

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return scripts.filter(
      (s) =>
        (status === 'all' ? s.status !== 'discarded' : s.status === status) &&
        (!seriesId || (seriesId === '-' ? !s.seriesId : s.seriesId === seriesId)) &&
        (!styleId || s.styleId === styleId) &&
        (!characterId || s.characterIds.includes(characterId)) &&
        (!needle || [s.title, s.hook, s.summary, s.keyword].join(' ').toLowerCase().includes(needle))
    )
  }, [scripts, q, status, seriesId, styleId, characterId])

  const count = (st: StatusFilter): number => (st === 'all' ? scripts.filter((s) => s.status !== 'discarded').length : scripts.filter((s) => s.status === st).length)

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center gap-2 flex-wrap">
        <Segmented<StatusFilter>
          value={status}
          onChange={setStatus}
          options={(['all', 'draft', 'approved', 'used', 'discarded'] as StatusFilter[]).map((v) => ({ value: v, label: `${v === 'all' ? t('Todos') : t(SCRIPT_STATUS_LABEL[v])} ${count(v)}` }))}
        />
        <input className="field w-[220px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Buscar')} aria-label={t('Buscar guiones')} />
        <select className="field w-[190px]" value={seriesId} onChange={(e) => setSeriesId(e.target.value)} aria-label={t('Serie')}>
          <option value="">{t('Todas las series')}</option>
          <option value="-">{t('Piezas sueltas')}</option>
          {series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="field w-[190px]" value={styleId} onChange={(e) => setStyleId(e.target.value)} aria-label={t('Estilo')}>
          <option value="">{t('Todos los estilos')}</option>
          {contexts.filter((c) => c.kind === 'style').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="field w-[190px]" value={characterId} onChange={(e) => setCharacterId(e.target.value)} aria-label={t('Personaje')}>
          <option value="">{t('Todos los personajes')}</option>
          {contexts.filter((c) => c.kind === 'character').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {list.length ? (
        <div className="grid grid-cols-2 gap-[14px] max-[1180px]:grid-cols-1">
          {list.map((s) => <ScriptCard key={s.id} s={s} lookup={lookup} onOpen={() => onOpen(s)} />)}
        </div>
      ) : (
        <Card>
          <Empty title={scripts.length ? t('Ningún guion coincide con los filtros') : t('Todavía no hay guiones')}>
            {scripts.length ? t('Prueba a quitar algún filtro.') : t('Genera el primero en la pestaña Generar.')}
          </Empty>
        </Card>
      )}
    </div>
  )
}
