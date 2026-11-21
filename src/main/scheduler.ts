import { Notification } from 'electron'
import type { Platform } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { connectors, ga4 } from './connectors'
import { dueTargets, getPost, getSettings, log, publishedTargets, refreshPostStatus, updateTarget, upsertSnapshot } from './db'
import { localDate } from './stats'
import { tr } from './i18n'

// Cola de publicación: cada minuto publica los destinos vencidos de las publicaciones programadas.
// Si la app estuvo cerrada, publica al arrancar lo vencido dentro del margen configurado;
// lo que lleve más tiempo vencido se marca como fallido para que lo reprogrames tú.

let tickTimer: NodeJS.Timeout | null = null
let syncTimer: NodeJS.Timeout | null = null
let running = false
let onChange: () => void = () => {}

export function startScheduler(notify: () => void): void {
  onChange = notify
  tickTimer = setInterval(() => void tick(), 60_000)
  void tick()
  const hours = Math.max(1, getSettings().syncHours)
  syncTimer = setInterval(() => void syncMetrics(), hours * 3600_000)
  setTimeout(() => void syncMetrics(), 30_000)
}

export function stopScheduler(): void {
  if (tickTimer) clearInterval(tickTimer)
  if (syncTimer) clearInterval(syncTimer)
}

export async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    const settings = getSettings()
    const due = dueTargets(new Date().toISOString())
    for (const { post, target } of due) {
      const lateH = (Date.now() - new Date(post.scheduledAt).getTime()) / 3600_000
      if (lateH > settings.overdueGraceHours) {
        updateTarget(target.id, { status: 'failed', error: tr('Vencida hace {h} h mientras la app estaba cerrada. Reprográmala.', { h: Math.round(lateH) }) })
        refreshPostStatus(post.id)
        continue
      }
      await publishTarget(post.id, target.id)
    }
  } finally {
    running = false
  }
}

export async function publishTarget(postId: string, targetId: string): Promise<void> {
  const post = getPost(postId)
  const target = post?.targets.find((t) => t.id === targetId)
  if (!post || !target) return
  const connector = connectors[target.platform]
  const name = PLATFORMS[target.platform].name
  if (!connector.isConnected()) {
    updateTarget(target.id, { status: 'failed', error: tr('{name} no está conectado', { name }) })
    refreshPostStatus(post.id)
    onChange()
    return
  }
  updateTarget(target.id, { status: 'publishing', error: null })
  refreshPostStatus(post.id)
  onChange()
  try {
    const res = await connector.publish(post, target, getSettings())
    updateTarget(target.id, { status: 'published', remoteId: res.remoteId, remoteUrl: res.remoteUrl, publishedAt: new Date().toISOString() })
    log('info', target.platform, `Publicado "${post.title}"`)
    new Notification({ title: tr('Publicado en {name}', { name }), body: post.title }).show()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    updateTarget(target.id, { status: 'failed', error: msg })
    log('error', target.platform, `No se pudo publicar "${post.title}": ${msg}`)
    new Notification({ title: tr('Error al publicar en {name}', { name }), body: msg.slice(0, 180) }).show()
  }
  refreshPostStatus(post.id)
  onChange()
}

export async function publishNow(postId: string): Promise<void> {
  const post = getPost(postId)
  if (!post) return
  for (const t of post.targets.filter((x) => x.status !== 'published')) await publishTarget(post.id, t.id)
}

export interface SyncReport { platform: Platform | 'ga4'; ok: boolean; message: string }

let syncing = false

export async function syncMetrics(): Promise<SyncReport[]> {
  if (syncing) return []
  syncing = true
  const reports: SyncReport[] = []
  try {
    const since = new Date(Date.now() - 90 * 86400_000).toISOString()
    const today = localDate(new Date())
    for (const c of Object.values(connectors)) {
      if (!c.fetchMetrics || !c.isConnected()) continue
      const targets = publishedTargets(c.platform, since)
      if (!targets.length) continue
      try {
        const metrics = await c.fetchMetrics(targets, getSettings())
        for (const m of metrics) upsertSnapshot({ ...m, date: today })
        reports.push({ platform: c.platform, ok: true, message: tr('{n} publicaciones actualizadas', { n: metrics.length }) })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log('warn', c.platform, `Métricas: ${msg}`)
        reports.push({ platform: c.platform, ok: false, message: msg })
      }
    }
    if (ga4.isConnected()) {
      try {
        const n = await ga4.sync()
        reports.push({ platform: 'ga4', ok: true, message: tr('{n} filas de tráfico', { n }) })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log('warn', 'ga4', msg)
        reports.push({ platform: 'ga4', ok: false, message: msg })
      }
    }
    log('info', 'sync', reports.map((r) => `${r.platform}: ${r.message}`).join(' · ') || 'Nada que sincronizar')
  } finally {
    syncing = false
    onChange()
  }
  return reports
}
