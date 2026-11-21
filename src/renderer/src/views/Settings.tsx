import type { ReactNode } from 'react'
import type { Settings } from '@shared/types'
import { LANGS, LANG_LABEL, type Lang } from '@shared/i18n'
import { api } from '../lib/api'
import { useData } from '../lib/hooks'
import { Button, cx, Label, PageHeader, Toggle } from '../components/ui'
import { useToast } from '../components/toast'
import { locale, t } from '../lib/i18n'

function Row({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-6 py-4 border-b border-rule last:border-0">
      <div className="flex-1">
        <p className="text-[14px] font-medium">{title}</p>
        <p className="text-[13px] text-muted mt-0.5 max-w-[60ch]">{description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  )
}

export function SettingsView() {
  const toast = useToast()
  const settings = useData(() => api.settings.get())
  const info = useData(() => api.app.info())
  const logs = useData(() => api.app.logs())
  const demo = useData(() => api.demo.has())
  const s = settings.data
  if (!s) return <PageHeader title={t('Ajustes')} />

  const save = async (patch: Partial<Settings>): Promise<void> => {
    await api.settings.save(patch)
    settings.reload()
  }
  const NumberField = ({ k, min, max, suffix }: { k: 'syncHours' | 'overdueGraceHours' | 'oauthPort'; min: number; max: number; suffix?: string }) => (
    <span className="inline-flex items-center gap-2">
      <input type="number" className="field w-24 text-right tnum" defaultValue={s[k]} min={min} max={max}
        onBlur={(e) => {
          const v = Math.max(min, Math.min(max, Number(e.target.value) || s[k]))
          if (v !== s[k]) void save({ [k]: v })
        }} />
      {suffix && <span className="text-[13px] text-faint w-10">{suffix}</span>}
    </span>
  )

  return (
    <div className="anim-rise max-w-[960px]">
      <PageHeader title={t('Ajustes')} subtitle={`AllinMKT ${info.data?.version ?? ''} · ${t('tus datos están en {path}', { path: info.data?.dataPath ?? '' })}`} />

      <section className="bg-surface rounded-[20px] px-[22px] py-2 mb-[14px]">
        <Row title={t('Idioma')} description={t('Idioma de la interfaz, las notificaciones y los mensajes de error. El idioma del contenido que genera la IA se elige en el briefing del Planificador.')}>
          <select className="field w-40" value={s.language ?? 'es'} aria-label={t('Idioma')}
            onChange={(e) => void save({ language: e.target.value as Lang })}>
            {LANGS.map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
          </select>
        </Row>
        <Row title={t('Abrir al iniciar sesión')} description={t('Arranca minimizada en la bandeja para que las publicaciones programadas salgan a su hora aunque no abras la app.')}>
          <Toggle checked={s.autostart} onChange={(v) => save({ autostart: v })} label={t('Abrir al iniciar sesión')} />
        </Row>
        <Row title={t('Seguir en la bandeja al cerrar')} description={t('Cerrar la ventana no detiene la cola de publicación. Para salir del todo, usa «Salir» en el icono de la bandeja.')}>
          <Toggle checked={s.closeToTray} onChange={(v) => save({ closeToTray: v })} label={t('Seguir en la bandeja al cerrar')} />
        </Row>
        <Row title={t('Margen para publicaciones vencidas')} description={t('Si el equipo estaba apagado a la hora programada, se publica al arrancar solo si no han pasado más horas que estas. Si han pasado más, se marca como fallida para que la reprogrames.')}>
          <NumberField k="overdueGraceHours" min={0} max={72} suffix={t('horas')} />
        </Row>
        <Row title={t('Sincronizar métricas cada')} description={t('Descarga visualizaciones de cada red y el tráfico de Google Analytics. También puedes sincronizar a mano desde la barra superior.')}>
          <NumberField k="syncHours" min={1} max={48} suffix={t('horas')} />
        </Row>
        <Row title={t('Puerto para iniciar sesión')} description={t('Puerto local de la URL de redirección OAuth ({uri}). Si lo cambias, actualiza la URL en cada app de desarrollador.', { uri: info.data?.redirectUri ?? '' })}>
          <NumberField k="oauthPort" min={1024} max={65535} />
        </Row>
      </section>

      <section className="bg-surface rounded-[20px] px-[22px] py-2 mb-[14px]">
        <Row title={t('Datos de ejemplo')} description={t('Diez semanas de publicaciones, métricas y tráfico inventados para ver la app llena. No se publican nunca y se borran sin tocar tus datos reales.')}>
          {demo.data ? (
            <Button variant="danger" onClick={async () => {
              await api.demo.clear()
              demo.reload()
              toast(t('Datos de ejemplo borrados'), 'success')
            }}>{t('Borrar ejemplo')}</Button>
          ) : (
            <Button onClick={async () => {
              await api.demo.load()
              demo.reload()
              toast(t('Datos de ejemplo cargados'), 'success')
            }}>{t('Cargar ejemplo')}</Button>
          )}
        </Row>
      </section>

      <section className="bg-surface rounded-[20px] p-[22px]">
        <div className="flex items-center justify-between mb-3">
          <Label>{t('Actividad')}</Label>
          <Button size="sm" variant="ghost" onClick={logs.reload}>{t('Actualizar')}</Button>
        </div>
        {logs.data && logs.data.length > 0 ? (
          <ul className="text-[13px] max-h-[420px] overflow-y-auto">
            {logs.data.map((l) => (
              <li key={l.id} className="grid grid-cols-[150px_90px_1fr] gap-3 py-2 border-b border-rule last:border-0">
                <span className="text-faint tnum">{new Date(l.ts).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <span className="text-muted">{l.scope}</span>
                <span className={cx('break-words', l.level === 'error' && 'text-neg-ink', l.level === 'warn' && 'text-warning')}>{l.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-faint">{t('Sin actividad todavía.')}</p>
        )}
      </section>
    </div>
  )
}
