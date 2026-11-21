import { randomUUID } from 'node:crypto'
import type { Format, Platform } from '@shared/types'
import { getDb, slugify } from './db'
import { localDate } from './stats'

// Datos de ejemplo para ver la app llena antes de conectar cuentas.
// Todo lo que crea lleva source='demo' (o demo=1) y se borra con clearDemo().
// Las publicaciones futuras de ejemplo son borradores: nunca se publican solas.

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const IDEAS: { title: string; format: Format; platforms: Platform[]; dow: number; hour: number }[] = [
  { title: 'Cómo planificar un mes de contenido en una tarde', format: 'article', platforms: ['blog'], dow: 5, hour: 9 },
  { title: '3 errores al grabar vídeos cortos con el móvil', format: 'short', platforms: ['tiktok', 'instagram', 'youtube'], dow: 1, hour: 19 },
  { title: 'Lo que aprendimos publicando cada día durante 30 días', format: 'text', platforms: ['linkedin'], dow: 3, hour: 8 },
  { title: 'Hilo: 7 ganchos que funcionan en la primera frase', format: 'thread', platforms: ['x'], dow: 2, hour: 13 },
  { title: 'Guía de UTM para saber qué red trae visitas', format: 'article', platforms: ['blog'], dow: 5, hour: 9 },
  { title: 'Antes y después: rediseño de una ficha de producto', format: 'short', platforms: ['tiktok', 'instagram'], dow: 4, hour: 20 },
  { title: 'Por qué tu blog no recibe visitas (y cómo arreglarlo)', format: 'video', platforms: ['youtube'], dow: 6, hour: 11 },
  { title: 'Checklist antes de publicar cualquier post', format: 'image', platforms: ['instagram', 'linkedin'], dow: 3, hour: 12 }
]

const DAILY_CTR: Record<Platform, number> = { tiktok: 0.003, instagram: 0.004, youtube: 0.012, linkedin: 0.018, x: 0.009, blog: 0 }
const VIEW_BASE: Record<Platform, number> = { tiktok: 4200, instagram: 1900, youtube: 900, linkedin: 1300, x: 700, blog: 260 }

export function loadDemo(): void {
  clearDemo()
  const db = getDb()
  const r = rng(20261116)
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const start = new Date(today)
  start.setDate(start.getDate() - 56)
  // Lunes de la semana de inicio
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))

  const insPost = db.prepare(
    `INSERT INTO posts (id, title, body, format, pillar, hook, cta, link_path, utm_campaign, scheduled_at, status, source, rationale, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'demo',?,?,?)`
  )
  const insTarget = db.prepare(
    `INSERT INTO post_targets (id, post_id, platform, status, remote_id, remote_url, published_at) VALUES (?,?,?,?,?,?,?)`
  )
  const insSnap = db.prepare(`INSERT INTO metric_snapshots (target_id, date, views, likes, comments, shares, saves) VALUES (?,?,?,?,?,?,?)`)
  const traffic = new Map<string, number>()
  const addTraffic = (date: string, channel: string, campaign: string, n: number): void => {
    const k = `${date}|${channel}|${campaign}`
    traffic.set(k, (traffic.get(k) ?? 0) + n)
  }

  const tx = db.transaction(() => {
    for (let week = 0; week < 10; week++) {
      for (const idea of IDEAS.slice(0, 6 + (week % 3))) {
        const when = new Date(start)
        when.setDate(when.getDate() + week * 7 + (idea.dow - 1))
        when.setHours(idea.hour, 0, 0, 0)
        const isPast = when.getTime() < Date.now()
        const id = randomUUID()
        const title = week === 0 ? idea.title : `${idea.title} (${week + 1})`
        const campaign = `${localDate(when)}-${slugify(idea.title)}`.slice(0, 80)
        const linkPath = idea.format === 'article' ? `/blog/${slugify(idea.title)}` : '/blog/guia-utm'
        insPost.run(
          id, title, 'Contenido de ejemplo generado para la demo.', idea.format, 'Ejemplo', 'Gancho de ejemplo', 'Lee la guía completa en la web',
          linkPath, campaign, when.toISOString(), isPast ? 'published' : 'draft', 'Publicación de ejemplo.', when.toISOString(), when.toISOString()
        )
        for (const p of idea.platforms) {
          const tid = randomUUID()
          insTarget.run(tid, id, p, isPast ? 'published' : 'pending', isPast ? `demo-${tid.slice(0, 8)}` : null, null, isPast ? when.toISOString() : null)
          if (!isPast) continue
          const growth = 1 + week * 0.06
          const views = Math.round(VIEW_BASE[p] * growth * (0.4 + r() * 1.4))
          insSnap.run(tid, localDate(today), views, Math.round(views * (0.03 + r() * 0.05)), Math.round(views * 0.004 * r()), Math.round(views * 0.006 * r()), Math.round(views * 0.008 * r()))
          // Visitas atribuidas por UTM durante los 4 días siguientes, decreciendo.
          const total = p === 'blog' ? 0 : Math.round(views * DAILY_CTR[p] * (0.6 + r() * 0.8))
          const shares = [0.55, 0.25, 0.13, 0.07]
          shares.forEach((sh, i) => {
            const d = new Date(when)
            d.setDate(d.getDate() + i)
            if (d.getTime() <= today.getTime() + 12 * 3600_000) addTraffic(localDate(d), p, campaign, Math.round(total * sh))
          })
        }
      }
    }
    // Tráfico base: buscadores, directo y otros, con patrón semanal y crecimiento por los artículos.
    for (let d = new Date(start); d.getTime() <= today.getTime(); d.setDate(d.getDate() + 1)) {
      const day = localDate(d)
      const weekend = d.getDay() === 0 || d.getDay() === 6
      const age = (d.getTime() - start.getTime()) / 86400_000
      addTraffic(day, 'google', '', Math.round((90 + age * 1.1) * (weekend ? 0.7 : 1) * (0.85 + r() * 0.3)))
      addTraffic(day, 'direct', '', Math.round(38 * (weekend ? 0.6 : 1) * (0.8 + r() * 0.4)))
      addTraffic(day, 'other', '', Math.round(12 * (0.6 + r() * 0.8)))
    }
    const insT = db.prepare('INSERT INTO web_traffic (date, channel, campaign, sessions, users, demo) VALUES (?,?,?,?,?,1)')
    for (const [k, n] of traffic) {
      const [date, channel, campaign] = k.split('|')
      if (n > 0) insT.run(date, channel, campaign, n, Math.round(n * 0.86))
    }
  })
  tx()
}

export function clearDemo(): void {
  const db = getDb()
  db.prepare("DELETE FROM posts WHERE source = 'demo'").run()
  db.prepare('DELETE FROM web_traffic WHERE demo = 1').run()
}

export function hasDemo(): boolean {
  return !!getDb().prepare("SELECT 1 FROM posts WHERE source = 'demo' LIMIT 1").get()
}
