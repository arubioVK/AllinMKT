import type { AnalyticsData, Channel, DashboardData, Platform, PostPerformance } from '@shared/types'
import { PLATFORM_IDS } from '@shared/types'
import { getDb, listPosts, getPost } from './db'

// Consultas de analítica. Los volúmenes son pequeños (cientos de publicaciones), así que
// agregamos en JavaScript con fechas locales.

export const localDate = (d: Date): string => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + n)
  return localDate(d)
}

export const SOCIAL: Channel[] = ['tiktok', 'instagram', 'youtube', 'linkedin', 'x']

interface PublishedRow {
  target_id: string; post_id: string; platform: Platform; published_at: string; remote_url: string | null
  title: string; utm_campaign: string
}

function publishedRows(): (PublishedRow & { day: string })[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id AS target_id, t.post_id, t.platform, t.published_at, t.remote_url, p.title, p.utm_campaign
       FROM post_targets t JOIN posts p ON p.id = t.post_id WHERE t.status = 'published' AND t.published_at IS NOT NULL`
    )
    .all() as PublishedRow[]
  return rows.map((r) => ({ ...r, day: localDate(new Date(r.published_at)) }))
}

interface Snap { views: number; likes: number; comments: number; shares: number; saves: number }

function latestSnapshots(): Map<string, Snap> {
  const rows = getDb()
    .prepare(
      `SELECT s.target_id, s.views, s.likes, s.comments, s.shares, s.saves FROM metric_snapshots s
       WHERE s.date = (SELECT MAX(date) FROM metric_snapshots WHERE target_id = s.target_id)`
    )
    .all() as (Snap & { target_id: string })[]
  return new Map(rows.map((r) => [r.target_id, r]))
}

function traffic(from: string, to: string): { date: string; channel: Channel; campaign: string; sessions: number }[] {
  return getDb()
    .prepare('SELECT date, channel, campaign, sessions FROM web_traffic WHERE date >= ? AND date <= ?')
    .all(from, to) as { date: string; channel: Channel; campaign: string; sessions: number }[]
}

export function dashboard(days = 28): DashboardData {
  const to = localDate(new Date())
  const from = addDays(to, -(days - 1))
  const prevTo = addDays(from, -1)
  const prevFrom = addDays(prevTo, -(days - 1))

  const snaps = latestSnapshots()
  const pubs = publishedRows()
  const tr = traffic(prevFrom, to)

  const sumTotals = (a: string, b: string): DashboardData['totals'] => {
    const t = tr.filter((r) => r.date >= a && r.date <= b)
    const p = pubs.filter((r) => r.day >= a && r.day <= b)
    return {
      sessions: t.reduce((s, r) => s + r.sessions, 0),
      socialSessions: t.filter((r) => SOCIAL.includes(r.channel)).reduce((s, r) => s + r.sessions, 0),
      views: p.reduce((s, r) => s + (snaps.get(r.target_id)?.views ?? 0), 0),
      published: new Set(p.map((r) => r.post_id)).size
    }
  }

  const daily: DashboardData['daily'] = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const t = tr.filter((r) => r.date === d)
    const p = pubs.filter((r) => r.day === d)
    const byPost = new Map<string, { postId: string; title: string; platforms: Platform[] }>()
    for (const r of p) {
      const e = byPost.get(r.post_id) ?? { postId: r.post_id, title: r.title, platforms: [] }
      e.platforms.push(r.platform)
      byPost.set(r.post_id, e)
    }
    daily.push({
      date: d,
      sessions: t.reduce((s, r) => s + r.sessions, 0),
      socialSessions: t.filter((r) => SOCIAL.includes(r.channel)).reduce((s, r) => s + r.sessions, 0),
      views: p.reduce((s, r) => s + (snaps.get(r.target_id)?.views ?? 0), 0),
      published: [...byPost.values()]
    })
  }

  const inRange = pubs.filter((r) => r.day >= from && r.day <= to)
  const curTraffic = tr.filter((r) => r.date >= from && r.date <= to)
  const byPlatform = PLATFORM_IDS.map((platform) => {
    const p = inRange.filter((r) => r.platform === platform)
    return {
      platform,
      posts: p.length,
      views: p.reduce((s, r) => s + (snaps.get(r.target_id)?.views ?? 0), 0),
      engagement: p.reduce((s, r) => {
        const m = snaps.get(r.target_id)
        return s + (m ? m.likes + m.comments + m.shares + m.saves : 0)
      }, 0),
      sessions: curTraffic.filter((r) => r.channel === platform).reduce((s, r) => s + r.sessions, 0)
    }
  })

  const chMap = new Map<Channel, number>()
  for (const r of curTraffic) chMap.set(r.channel, (chMap.get(r.channel) ?? 0) + r.sessions)
  const byChannel = [...chMap.entries()].map(([channel, sessions]) => ({ channel, sessions })).sort((a, b) => b.sessions - a.sessions)

  const nowIso = new Date().toISOString()
  const upcoming = listPosts()
    .filter((p) => p.scheduledAt >= nowIso && !['published', 'partial'].includes(p.status))
    .slice(0, 6)

  return {
    range: { from, to, prevFrom, prevTo },
    daily,
    totals: sumTotals(from, to),
    prevTotals: sumTotals(prevFrom, prevTo),
    byPlatform,
    byChannel,
    upcoming,
    hasTraffic: tr.length > 0,
    hasMetrics: snaps.size > 0
  }
}

export function analytics(days = 90): AnalyticsData {
  const to = localDate(new Date())
  const from = addDays(to, -(days - 1))
  const snaps = latestSnapshots()
  const pubs = publishedRows().filter((r) => r.day >= from && r.day <= to)
  const tr = traffic(from, to)

  const zeroP = (): Record<Platform, number> => Object.fromEntries(PLATFORM_IDS.map((p) => [p, 0])) as Record<Platform, number>
  const zeroC = (): Record<Channel, number> =>
    Object.fromEntries([...PLATFORM_IDS, 'google', 'direct', 'other'].map((c) => [c, 0])) as Record<Channel, number>

  const daily: AnalyticsData['daily'] = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const views = zeroP()
    for (const r of pubs.filter((x) => x.day === d)) views[r.platform] += snaps.get(r.target_id)?.views ?? 0
    const sessions = zeroC()
    for (const r of tr.filter((x) => x.date === d)) sessions[r.channel] += r.sessions
    daily.push({ date: d, views, sessions })
  }

  // Visitas atribuidas a cada publicación por su campaña UTM y canal (todo el histórico).
  const campaign = getDb()
    .prepare(`SELECT channel, campaign, SUM(sessions) AS sessions FROM web_traffic WHERE campaign != '' GROUP BY channel, campaign`)
    .all() as { channel: string; campaign: string; sessions: number }[]
  const camp = new Map(campaign.map((c) => [`${c.channel}|${c.campaign}`, c.sessions]))

  const posts: PostPerformance[] = pubs
    .map((r) => {
      const m = snaps.get(r.target_id)
      return {
        postId: r.post_id,
        targetId: r.target_id,
        title: r.title,
        platform: r.platform,
        publishedAt: r.published_at,
        remoteUrl: r.remote_url,
        views: m?.views ?? 0,
        likes: m?.likes ?? 0,
        comments: m?.comments ?? 0,
        shares: m?.shares ?? 0,
        saves: m?.saves ?? 0,
        sessions: camp.get(`${r.platform}|${r.utm_campaign}`) ?? 0
      }
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))

  return { daily, posts }
}

/** Resumen compacto del rendimiento pasado, para que la IA planifique con datos reales. */
export function performanceSummary(): string {
  const a = analytics(90)
  if (a.posts.length === 0) return 'Todavía no hay publicaciones con datos de rendimiento.'
  const lines: string[] = []
  for (const platform of PLATFORM_IDS) {
    const ps = a.posts.filter((p) => p.platform === platform)
    if (!ps.length) continue
    const views = ps.reduce((s, p) => s + p.views, 0)
    const sessions = ps.reduce((s, p) => s + p.sessions, 0)
    lines.push(`- ${platform}: ${ps.length} publicaciones, ${views} visualizaciones, ${sessions} visitas a la web atribuidas por UTM.`)
  }
  const top = [...a.posts].sort((x, y) => y.sessions - x.sessions || y.views - x.views).slice(0, 8)
  lines.push('Publicaciones que más visitas llevaron a la web:')
  for (const p of top) {
    const post = getPost(p.postId)
    const day = new Date(p.publishedAt).toLocaleDateString('es-ES', { weekday: 'long', hour: '2-digit', minute: '2-digit' })
    lines.push(`- [${p.platform}, ${post?.format ?? ''}, ${day}] "${p.title}": ${p.views} visualizaciones, ${p.sessions} visitas`)
  }
  return lines.join('\n')
}
