import { createContext, useCallback, useContext, useState } from 'react'
import { LayoutDashboard, CalendarDays, Clapperboard, Sparkles, LineChart, Plug, Settings2, RefreshCw, Plus, Loader2 } from 'lucide-react'
import { ToastProvider, useToast } from './components/toast'
import { Button, cx, PlatformList } from './components/ui'
import { PostEditor, type EditorTarget } from './components/PostEditor'
import { Dashboard } from './views/Dashboard'
import { CalendarView } from './views/Calendar'
import { Planner } from './views/Planner'
import { Content } from './views/Content'
import { Analytics } from './views/Analytics'
import { Connections } from './views/Connections'
import { SettingsView } from './views/Settings'
import { api } from './lib/api'
import { useData } from './lib/hooks'
import { relativeDay } from './lib/format'
import { JobsProvider, jobProgress, useJobs, useTick } from './lib/jobs'
import { I18nProvider } from './lib/i18n'
import { t } from './lib/i18n'

export type View = 'dashboard' | 'calendar' | 'planner' | 'content' | 'analytics' | 'connections' | 'settings'

interface Nav {
  go: (v: View) => void
  edit: (t: EditorTarget) => void
}
const NavCtx = createContext<Nav>({ go: () => {}, edit: () => {} })
export const useNav = (): Nav => useContext(NavCtx)

// Las etiquetas se traducen al pintarlas: a nivel de módulo el idioma aún no está cargado.
const NAV: { id: View; label: string; icon: typeof LayoutDashboard; group?: string }[] = [
  { id: 'dashboard', label: 'Resumen', icon: LayoutDashboard },
  { id: 'calendar', label: 'Calendario', icon: CalendarDays },
  { id: 'planner', label: 'Planificador IA', icon: Sparkles },
  { id: 'content', label: 'Contenido', icon: Clapperboard },
  { id: 'analytics', label: 'Analítica', icon: LineChart },
  { id: 'connections', label: 'Conexiones', icon: Plug, group: 'Configuración' },
  { id: 'settings', label: 'Ajustes', icon: Settings2 }
]

function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 512 512" aria-hidden>
      <rect width="512" height="512" rx="112" fill="#c6f24e" />
      <rect x="112" y="276" width="72" height="124" rx="10" fill="#000" />
      <rect x="220" y="196" width="72" height="204" rx="10" fill="#000" />
      <rect x="328" y="112" width="72" height="288" rx="10" fill="#000" />
    </svg>
  )
}

/** Aviso de lo que se está generando en segundo plano; al pulsarlo lleva a Contenido. */
function JobsIndicator() {
  const nav = useNav()
  const running = useJobs().filter((j) => j.status === 'running')
  const now = useTick(running.length > 0)
  if (!running.length) return null
  const j = running[running.length - 1]
  return (
    <button
      onClick={() => nav.go('content')}
      className="shrink-0 h-8 flex items-center gap-2 px-3 rounded-full bg-surface text-[13px] text-ink hover:bg-raised transition-colors tnum"
      title={t('Sigue en marcha aunque cambies de vista o cierres la ventana a la bandeja')}
    >
      <Loader2 size={14} className="text-accent animate-[spin_0.8s_linear_infinite]" />
      <span>{j.label}{running.length > 1 ? ` (+${running.length - 1})` : ''}</span>
      <span className="text-faint">{jobProgress(j, now)}</span>
    </button>
  )
}

function TopBar({ onNew }: { onNew: () => void }) {
  const toast = useToast()
  const nav = useNav()
  const [syncing, setSyncing] = useState(false)
  const settings = useData(() => api.settings.get())
  const next = useData(async () => {
    const now = new Date().toISOString()
    const posts = await api.posts.list()
    return posts.find((p) => p.scheduledAt >= now && p.status === 'scheduled') ?? null
  })
  const sync = async (): Promise<void> => {
    setSyncing(true)
    try {
      const r = await api.metrics.sync()
      const failed = r.filter((x) => !x.ok)
      if (!r.length) toast(t('No hay cuentas conectadas con publicaciones que sincronizar'))
      else if (failed.length) toast(failed.map((f) => `${f.platform}: ${f.message}`).join(' · '), 'error')
      else toast(t('Métricas actualizadas'), 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSyncing(false)
    }
  }
  const domain = settings.data?.website ? settings.data.website.replace(/^https?:\/\//, '').replace(/\/$/, '') : t('Sin web configurada')
  return (
    <header className="h-16 shrink-0 flex items-center gap-4 pl-[29px] border-b border-rule">
      <div className="flex-1 min-w-0 flex items-center gap-3 text-[13px]">
        {next.data ? (
          <>
            <span className="text-faint shrink-0">{t('Próxima publicación')}</span>
            <button onClick={() => next.data && nav.edit({ id: next.data.id })} className="truncate text-ink hover:underline underline-offset-4">
              {relativeDay(next.data.scheduledAt)} · {next.data.title}
            </button>
            <PlatformList platforms={next.data.targets.map((tg) => tg.platform)} names={false} />
          </>
        ) : (
          <span className="text-faint">{t('No hay publicaciones programadas')}</span>
        )}
      </div>
      <JobsIndicator />
      <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} loading={syncing} onClick={sync}>
        {t('Sincronizar')}
      </Button>
      <Button variant="primary" size="sm" icon={<Plus size={15} />} onClick={onNew}>
        {t('Nueva publicación')}
      </Button>
      <div className="h-16 flex items-center pl-4 pr-[29px] border-l border-rule text-[13px] text-muted max-w-[260px] truncate" title={t('Web a la que se dirige el tráfico')}>
        {domain}
      </div>
    </header>
  )
}

// Vista abierta, fuera del componente para conservarla cuando el cambio de idioma remonta la interfaz.
let lastView: View = 'dashboard'

function Shell() {
  const [view, setViewState] = useState<View>(() => lastView)
  const setView = useCallback((v: View) => {
    lastView = v
    setViewState(v)
  }, [])
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const edit = useCallback((tg: EditorTarget) => setEditor(tg), [])

  return (
    <NavCtx.Provider value={{ go: setView, edit }}>
      <div className="h-full flex">
        <aside className="w-[220px] shrink-0 flex flex-col border-r border-rule">
          <div className="h-16 flex items-center gap-2.5 px-5 border-b border-rule">
            <Mark />
            <span className="text-[15px] font-semibold tracking-[-0.01em]">AllinMKT</span>
          </div>
          <nav className="flex-1 px-3 py-4 flex flex-col gap-0.5" aria-label={t('Principal')}>
            {NAV.map((n) => (
              <div key={n.id}>
                {n.group && <p className="px-3 mt-6 mb-2 text-[12px] text-faint">{t(n.group)}</p>}
                <button
                  onClick={() => setView(n.id)}
                  aria-current={view === n.id ? 'page' : undefined}
                  className={cx(
                    'w-full h-8 flex items-center gap-2.5 px-3 rounded-lg text-[14px] transition-colors',
                    view === n.id ? 'text-ink' : 'text-[#bbb] hover:text-ink'
                  )}
                >
                  <n.icon size={16} strokeWidth={1.6} className={view === n.id ? 'text-ink' : 'text-faint'} />
                  {t(n.label)}
                </button>
              </div>
            ))}
          </nav>
          <p className="px-6 pb-5 text-[12px] text-faint leading-snug">{t('Local · tus datos se guardan en este equipo')}</p>
        </aside>
        <div className="flex-1 min-w-0 flex flex-col">
          <TopBar onNew={() => setEditor({ date: null })} />
          <main className="flex-1 overflow-y-auto">
            <div className="px-[29px] pt-7 pb-12 max-w-[1500px]">
              {view === 'dashboard' && <Dashboard />}
              {view === 'calendar' && <CalendarView />}
              {view === 'planner' && <Planner />}
              {view === 'content' && <Content />}
              {view === 'analytics' && <Analytics />}
              {view === 'connections' && <Connections />}
              {view === 'settings' && <SettingsView />}
            </div>
          </main>
        </div>
      </div>
      {editor && <PostEditor target={editor} onClose={() => setEditor(null)} />}
    </NavCtx.Provider>
  )
}

export function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <JobsProvider>
          <Shell />
        </JobsProvider>
      </ToastProvider>
    </I18nProvider>
  )
}
