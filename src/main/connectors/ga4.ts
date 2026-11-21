import { createSign } from 'node:crypto'
import type { Channel } from '@shared/types'
import { getSecret } from '../secrets'
import { getSettings, setAccount, removeAccount, getAccount, replaceTraffic, getDb, upsertSnapshot } from '../db'
import { http } from '../http'
import { tr } from '../i18n'

// Google Analytics 4 Data API con una cuenta de servicio (sin OAuth): crea la cuenta de servicio
// en Google Cloud, activa "Google Analytics Data API" y añade su email como Lector en la propiedad.

interface ServiceAccount { client_email: string; private_key: string }

let cached: { token: string; exp: number } | null = null

async function accessToken(): Promise<string> {
  if (cached && cached.exp - Date.now() > 60_000) return cached.token
  const raw = getSecret('ga4ServiceAccountJson')
  if (!raw) throw new Error(tr('Falta el JSON de la cuenta de servicio de Google'))
  const sa = JSON.parse(raw) as ServiceAccount
  const iat = Math.floor(Date.now() / 1000)
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600
  })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')
  const { data } = await http<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
    method: 'POST',
    form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }
  })
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 }
  return data.access_token
}

interface ReportRow { dimensionValues: { value: string }[]; metricValues: { value: string }[] }

async function runReport(body: unknown): Promise<ReportRow[]> {
  const id = getSettings().ga4PropertyId.replace(/^properties\//, '')
  if (!id) throw new Error(tr('Falta el ID de propiedad de GA4'))
  const { data } = await http<{ rows?: ReportRow[] }>(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}` },
    json: body
  })
  return data.rows ?? []
}

/** Clasifica la fuente de GA4 en un canal. */
export function channelOf(source: string, medium: string): Channel {
  const s = source.toLowerCase()
  if (s.includes('tiktok')) return 'tiktok'
  if (s.includes('instagram') || s === 'ig') return 'instagram'
  if (s.includes('youtube') || s === 'yt') return 'youtube'
  if (s.includes('linkedin') || s === 'lnkd.in') return 'linkedin'
  if (s === 'x' || s === 't.co' || s.includes('twitter') || s === 'x.com') return 'x'
  if (s === '(direct)') return 'direct'
  if (medium === 'organic' || /google|bing|duckduckgo|yahoo|ecosia/.test(s)) return 'google'
  return 'other'
}

const isoDate = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`

export const ga4 = {
  isConnected: (): boolean => !!getAccount('ga4'),

  async connect(): Promise<string> {
    cached = null
    const rows = await runReport({ dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }] })
    const sessions = rows[0]?.metricValues[0]?.value ?? '0'
    const name = `Propiedad ${getSettings().ga4PropertyId}`
    setAccount('ga4', name, {})
    return tr('{name} · {n} sesiones en 7 días', { name, n: sessions })
  },

  async disconnect(): Promise<void> {
    cached = null
    removeAccount('ga4')
  },

  /** Descarga sesiones por día, canal y campaña UTM, y las visitas de cada artículo del blog. */
  async sync(days = 120): Promise<number> {
    const rows = await runReport({
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: 'date' }, { name: 'sessionSource' }, { name: 'sessionMedium' }, { name: 'sessionCampaignName' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      limit: 100000
    })
    const parsed = rows.map((r) => {
      const [date, source, medium, campaign] = r.dimensionValues.map((d) => d.value)
      return {
        date: isoDate(date),
        channel: channelOf(source, medium),
        campaign: campaign === '(not set)' || campaign === '(direct)' || campaign === '(organic)' || campaign === '(referral)' ? '' : campaign,
        sessions: Number(r.metricValues[0].value),
        users: Number(r.metricValues[1].value)
      }
    })
    const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
    replaceTraffic(parsed, from)

    // Visitas acumuladas de cada artículo publicado, por ruta.
    const blogTargets = getDb()
      .prepare("SELECT id, remote_url FROM post_targets WHERE platform = 'blog' AND status = 'published' AND remote_url IS NOT NULL")
      .all() as { id: string; remote_url: string }[]
    if (blogTargets.length) {
      const pages = await runReport({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        limit: 100000
      })
      const byPath = new Map(pages.map((p) => [p.dimensionValues[0].value.replace(/\/+$/, ''), Number(p.metricValues[0].value)]))
      const today = new Date().toISOString().slice(0, 10)
      for (const t of blogTargets) {
        let path = ''
        try {
          path = new URL(t.remote_url).pathname.replace(/\/+$/, '')
        } catch {
          continue
        }
        const views = byPath.get(path)
        if (views !== undefined) upsertSnapshot({ targetId: t.id, date: today, views, likes: 0, comments: 0, shares: 0, saves: 0 })
      }
    }
    return parsed.length
  }
}
