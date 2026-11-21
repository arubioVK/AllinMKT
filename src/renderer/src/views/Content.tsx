import { useMemo, useState } from 'react'
import type { Script } from '@shared/types'
import { api } from '../lib/api'
import { useData } from '../lib/hooks'
import { ErrorNote, PageHeader, Segmented } from '../components/ui'
import { Generator, type GeneratorPreset } from './content/Generator'
import { Library } from './content/Library'
import { SeriesView } from './content/SeriesView'
import { Contexts } from './content/Contexts'
import { ScriptDrawer } from './content/ScriptDrawer'
import type { Lookup } from './content/common'
import { t } from '../lib/i18n'

type Tab = 'generate' | 'scripts' | 'series' | 'contexts'

export function Content() {
  const [tab, setTab] = useState<Tab>('generate')
  const [preset, setPreset] = useState<GeneratorPreset | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const contexts = useData(() => api.content.contexts())
  const series = useData(() => api.content.series())
  const scripts = useData(() => api.content.scripts())

  const lookup: Lookup = useMemo(
    () => ({ ctx: new Map((contexts.data ?? []).map((c) => [c.id, c])), series: new Map((series.data ?? []).map((s) => [s.id, s])) }),
    [contexts.data, series.data]
  )
  const open = (s: Script): void => setOpenId(s.id)
  const opened = openId ? scripts.data?.find((s) => s.id === openId) : undefined
  const error = contexts.error || series.error || scripts.error
  const ready = contexts.data && series.data && scripts.data

  return (
    <div className="anim-rise">
      <PageHeader
        title={t('Contenido')}
        subtitle={t('Guarda tus contextos una vez (marca, personajes, estilos, plantillas) y combínalos para generar guiones nuevos que no repiten lo ya hecho.')}
        actions={
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'generate', label: t('Generar') },
              { value: 'scripts', label: `${t('Guiones')}${scripts.data?.length ? ` ${scripts.data.length}` : ''}` },
              { value: 'series', label: t('Series') },
              { value: 'contexts', label: t('Contextos') }
            ]}
          />
        }
      />

      {error && <div className="mb-4"><ErrorNote>{/No handler registered/i.test(error) ? t('Reinicia la app (también desde el icono de la bandeja) para cargar este apartado.') : error}</ErrorNote></div>}

      {ready && (
        <>
          {tab === 'generate' && (
            <Generator
              contexts={contexts.data!}
              series={series.data!}
              scripts={scripts.data!}
              lookup={lookup}
              preset={preset}
              onOpen={open}
              onEditContexts={() => setTab('contexts')}
            />
          )}
          {tab === 'scripts' && <Library scripts={scripts.data!} contexts={contexts.data!} series={series.data!} lookup={lookup} onOpen={open} />}
          {tab === 'series' && (
            <SeriesView
              series={series.data!}
              scripts={scripts.data!}
              contexts={contexts.data!}
              lookup={lookup}
              onOpenScript={open}
              onGenerate={(seriesId) => {
                setPreset({ seriesId, nonce: Date.now() })
                setTab('generate')
              }}
            />
          )}
          {tab === 'contexts' && <Contexts contexts={contexts.data!} />}
        </>
      )}

      {opened && <ScriptDrawer script={opened} lookup={lookup} onClose={() => setOpenId(null)} />}
    </div>
  )
}
