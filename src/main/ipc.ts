import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import type { Plan, PlannerBrief, Platform, PostInput, Settings, SecretField, Account } from '@shared/types'
import { PLATFORM_IDS, SECRET_FIELDS } from '@shared/types'
import * as db from './db'
import { getSecret, hasSecret, setSecret, encryptionBackend } from './secrets'
import { connectors, ga4 } from './connectors'
import { generateArticle, generatePlan, generateVariants } from './ai'
import { dashboard, analytics } from './stats'
import { publishNow, syncMetrics, tick } from './scheduler'
import { redirectUri } from './oauth'
import { clearDemo, hasDemo, loadDemo } from './demo'
import { storageConfigured } from './media'
import { applyAutostart } from './autostart'
import { claudeCodeStatus } from './claudecode'
import { analyzeSite } from './ai'
import { exportIcs, gcal, scheduleGcalSync } from './gcal'
import * as content from './content'
import { dismissJob, listJobs, onJobsChange, startJob } from './jobs'
import { generateVideo, regenerateScene, removeSceneFiles } from './video'
import type { ContentContextInput, ContentSeriesInput, Script, ScriptRequest } from '@shared/types'
import { tr } from './i18n'

export function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

const changed = (): void => broadcast('changed')

function handle<A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(name, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...(args as A)) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

function accounts(): Account[] {
  const list: Account[] = PLATFORM_IDS.map((p) => {
    const a = db.getAccount(p)
    return { platform: p, connected: connectors[p].isConnected(), displayName: a?.displayName ?? '', connectedAt: a?.connectedAt ?? null, detail: '' }
  })
  const g = db.getAccount('ga4')
  list.push({ platform: 'ga4', connected: ga4.isConnected(), displayName: g?.displayName ?? '', connectedAt: g?.connectedAt ?? null, detail: '' })
  const gc = db.getAccount('gcal')
  list.push({ platform: 'gcal', connected: gcal.isConnected(), displayName: gc?.displayName ?? '', connectedAt: gc?.connectedAt ?? null, detail: '' })
  const aiOn = db.getSettings().aiProvider === 'claude-code' || hasSecret('anthropicApiKey')
  list.push({ platform: 'anthropic', connected: aiOn, displayName: '', connectedAt: null, detail: '' })
  list.push({ platform: 'storage', connected: storageConfigured(), displayName: db.getSettings().storageBucket, connectedAt: null, detail: '' })
  return list
}

// La bandeja se reconstruye al cambiar de idioma (la registra index.ts).
let onLanguageChange: (() => void) | null = null
export const setLanguageListener = (fn: () => void): void => {
  onLanguageChange = fn
}

export function registerIpc(): void {
  onJobsChange((list) => broadcast('jobs', list))

  // Publicaciones
  handle('posts:list', (from?: string, to?: string) => db.listPosts(from, to))
  handle('posts:get', (id: string) => db.getPost(id))
  handle('posts:save', (id: string | null, input: PostInput) => {
    const p = db.upsertPost(id, input)
    changed()
    void tick()
    scheduleGcalSync()
    return p
  })
  handle('posts:delete', (id: string) => {
    db.deletePost(id)
    changed()
    scheduleGcalSync()
  })
  handle('posts:publishNow', async (id: string) => {
    await publishNow(id)
    return db.getPost(id)
  })

  // IA
  handle('ai:plan', (brief: PlannerBrief) => {
    db.saveSettings({ plannerBrief: brief, website: db.getSettings().website || brief.website })
    return generatePlan(brief, (p) => broadcast('ai-progress', p))
  })
  handle('ai:plans', () => db.listPlans<Plan>())
  handle('ai:claudeCodeStatus', () => claudeCodeStatus())
  handle('ai:analyzeSite', async (url: string) => {
    const a = await analyzeSite(url, (p) => broadcast('ai-progress', p))
    const s = db.getSettings()
    db.saveSettings({ plannerAnalysis: a, website: s.website || a.brief.website })
    return a
  })

  // Google Calendar
  handle('calendar:exportIcs', async () => {
    const r = await dialog.showSaveDialog({ defaultPath: 'calendario-contenido.ics', filters: [{ name: 'iCalendar', extensions: ['ics'] }] })
    if (r.canceled || !r.filePath) return null
    const n = exportIcs(r.filePath)
    return { file: r.filePath, count: n }
  })
  handle('calendar:gcalSync', () => gcal.sync())
  handle('ai:acceptPlan', (plan: Plan, indexes: number[], status: 'draft' | 'scheduled') => {
    const created = []
    for (const i of indexes) {
      const p = plan.posts[i]
      if (!p) continue
      const when = new Date(`${p.date}T${p.time || '10:00'}:00`)
      created.push(
        db.upsertPost(null, {
          title: p.title, body: p.body, format: p.format, pillar: p.pillar, hook: p.hook, cta: p.cta, linkPath: p.linkPath,
          rationale: p.rationale, scheduledAt: when.toISOString(), status, source: 'ai', platforms: p.platforms,
          notes: p.keyword ? `Palabra clave: ${p.keyword}` : ''
        })
      )
    }
    changed()
    scheduleGcalSync()
    return created.length
  })
  handle('ai:variants', async (postId: string, platforms: Platform[]) => {
    const v = await generateVariants(postId, platforms, (p) => broadcast('ai-progress', p))
    changed()
    return v
  })
  handle('ai:article', async (postId: string) => {
    const a = await generateArticle(postId, (p) => broadcast('ai-progress', p))
    changed()
    return a
  })

  // Generación de contenido
  handle('content:contexts', () => content.listContexts())
  handle('content:saveContext', (id: string | null, input: ContentContextInput) => {
    const c = content.saveContext(id, input)
    changed()
    return c
  })
  handle('content:archiveContext', (id: string) => {
    content.archiveContext(id)
    changed()
  })
  handle('content:addImages', async (id: string) => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Imagen', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
    if (r.canceled || !r.filePaths.length) return content.getContext(id)
    const c = content.addContextImages(id, r.filePaths)
    changed()
    return c
  })
  handle('content:removeImage', (id: string, file: string) => {
    const c = content.removeContextImage(id, file)
    changed()
    return c
  })
  handle('content:addParts', async (id: string) => {
    const c = content.getContext(id)
    if (!c) throw new Error(tr('No encontrado'))
    // Las piezas necesitan transparencia (PNG o SVG); los fondos pueden ser cualquier imagen.
    const extensions = c.kind === 'scenery' ? ['png', 'jpg', 'jpeg', 'webp'] : ['png', 'svg']
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: tr('Imagen'), extensions }] })
    if (r.canceled || !r.filePaths.length) return c
    const next = content.addContextParts(id, r.filePaths)
    changed()
    return next
  })
  handle('content:updatePart', (id: string, file: string, patch: { name?: string; note?: string }) => {
    const c = content.updateContextPart(id, file, patch)
    changed()
    return c
  })
  handle('content:removePart', (id: string, file: string) => {
    const c = content.removeContextPart(id, file)
    changed()
    return c
  })
  handle('content:sceneryPrompt', (id: string, styleId: string | null, vertical: boolean) => content.sceneryPrompt(id, styleId, vertical))
  handle('content:image', (file: string) => content.imageDataUrl(file))
  handle('content:sheetPrompt', (id: string, styleId: string | null) => content.characterSheetPrompt(id, styleId))
  handle('content:series', () => content.listSeries())
  handle('content:saveSeries', (id: string | null, input: ContentSeriesInput) => {
    const s = content.saveSeries(id, input)
    changed()
    return s
  })
  handle('content:archiveSeries', (id: string) => {
    content.archiveSeries(id)
    changed()
  })
  handle('content:scripts', () => content.listScripts())
  handle('content:previewPrompt', (req: ScriptRequest) => {
    const { system, prompt } = content.buildScriptPrompt(req)
    return { system, prompt }
  })
  // Devuelve la tarea al momento: la generación sigue aunque cambies de vista o cierres la ventana.
  handle('content:generate', (req: ScriptRequest) => {
    const label = req.count > 1 ? tr('Generando {n} guiones', { n: req.count }) : tr('Generando guion')
    return startJob('script', label, async (job) => {
      job.progress({ stage: tr('Preparando el encargo') })
      const scripts = await content.generateScripts(req, (p) => {
        broadcast('ai-progress', p)
        job.progress({ stage: p.chars ? tr('Escribiendo') : tr('Pensando'), chars: p.chars })
      })
      changed()
      return { resultIds: scripts.map((s) => s.id), summary: scripts.map((s) => s.title).join(' · ') }
    })
  })
  handle('content:generateVideo', (id: string) => {
    if (listJobs().some((j) => j.kind === 'video' && j.refId === id && j.status === 'running')) throw new Error(tr('El vídeo de este guion ya se está generando'))
    return startJob('video', tr('Generando vídeo'), async (job) => {
      const r = await generateVideo(id, job)
      changed()
      scheduleGcalSync()
      return r
    }, id)
  })
  handle('content:regenerateScene', (id: string, index: number, note: string) => {
    if (listJobs().some((j) => j.kind === 'video' && j.refId === id && j.status === 'running')) throw new Error(tr('El vídeo de este guion ya se está generando'))
    return startJob('video', tr('Rehaciendo la escena {n}', { n: index + 1 }), async (job) => {
      const r = await regenerateScene(id, index, note ?? '', job)
      changed()
      scheduleGcalSync()
      return r
    }, id)
  })
  handle('jobs:list', () => listJobs())
  handle('jobs:dismiss', (id: string) => dismissJob(id))
  handle('content:updateScript', (id: string, patch: Partial<Script>) => {
    const s = content.updateScript(id, patch)
    changed()
    return s
  })
  handle('content:deleteScript', (id: string) => {
    content.deleteScript(id)
    removeSceneFiles(id)
    changed()
  })
  handle('content:scriptText', (id: string) => {
    const s = content.getScript(id)
    return s ? content.scriptToText(s) : ''
  })
  handle('content:toPost', (id: string, scheduledAt: string, status: 'draft' | 'scheduled') => {
    const p = content.scriptToPost(id, scheduledAt, status)
    changed()
    void tick()
    scheduleGcalSync()
    return p
  })

  // Analítica
  handle('stats:dashboard', (days?: number) => dashboard(days))
  handle('stats:analytics', (days?: number) => analytics(days))
  handle('metrics:sync', () => syncMetrics())
  handle('metrics:manual', (targetId: string, m: { views: number; likes: number; comments: number; shares: number; saves: number }) => {
    const today = new Date()
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    db.upsertSnapshot({ targetId, date, ...m }, true)
    changed()
  })

  // Ajustes y credenciales
  handle('settings:get', () => db.getSettings())
  handle('settings:save', (patch: Partial<Settings>) => {
    const s = db.saveSettings(patch)
    if ('autostart' in patch) applyAutostart(s.autostart)
    if ('language' in patch) onLanguageChange?.()
    changed()
    return s
  })
  handle('secrets:status', () => Object.fromEntries(SECRET_FIELDS.map((f) => [f, hasSecret(f)])) as Record<SecretField, boolean>)
  handle('secrets:set', (field: SecretField, value: string) => {
    if (!SECRET_FIELDS.includes(field)) throw new Error(tr('Campo no permitido'))
    setSecret(field, value.trim())
    changed()
  })
  handle('secrets:peek', (field: SecretField) => {
    // Solo devolvemos los últimos 4 caracteres, para que el usuario reconozca qué clave hay guardada.
    const v = getSecret(field)
    return v ? `••••${v.slice(-4)}` : ''
  })

  // Cuentas
  handle('accounts:list', () => accounts())
  handle('accounts:connect', async (platform: Platform | 'ga4' | 'gcal') => {
    const name = platform === 'ga4' ? await ga4.connect() : platform === 'gcal' ? await gcal.connect() : await connectors[platform].connect()
    db.log('info', platform, `Conectado: ${name}`)
    changed()
    if (platform === 'ga4') void syncMetrics()
    if (platform === 'gcal') void gcal.sync().catch(() => {})
    return name
  })
  handle('accounts:disconnect', async (platform: Platform | 'ga4' | 'gcal') => {
    if (platform === 'ga4') await ga4.disconnect()
    else if (platform === 'gcal') await gcal.disconnect()
    else await connectors[platform].disconnect()
    changed()
  })

  // Sistema
  handle('app:info', () => ({
    version: app.getVersion(),
    dataPath: app.getPath('userData'),
    encryption: encryptionBackend(),
    redirectUri: redirectUri(),
    platform: process.platform
  }))
  handle('app:logs', () => db.listLogs(150))
  handle('app:openExternal', (url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error(tr('URL no válida'))
    return shell.openExternal(url)
  })
  handle('app:showItem', (path: string) => shell.showItemInFolder(path))
  handle('app:pickFile', async (kind: 'media' | 'json') => {
    const filters =
      kind === 'media'
        ? [{ name: tr('Vídeo o imagen'), extensions: ['mp4', 'mov', 'jpg', 'jpeg', 'png', 'webp', 'gif'] }]
        : [{ name: 'JSON', extensions: ['json'] }]
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('app:readJson', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled) return null
    const { readFileSync } = await import('node:fs')
    return readFileSync(r.filePaths[0], 'utf8')
  })
  handle('app:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('demo:load', () => {
    loadDemo()
    changed()
  })
  handle('demo:clear', () => {
    clearDemo()
    changed()
  })
  handle('demo:has', () => hasDemo())
}

export { changed }
