import { writeFileSync } from 'node:fs'
import type { Post } from '@shared/types'
import { FORMAT_LABEL, PLATFORMS } from '@shared/types'
import { getDb, getSettings, listPosts, log, removeAccount, setAccount, getAccount } from './db'
import { getSecret, getTokens, setTokens } from './secrets'
import { authorize, newState, pkce, redirectUri } from './oauth'
import { http, HttpError } from './http'
import { googleRefresh } from './connectors/youtube'
import { tr } from './i18n'

// Volcado del calendario de contenidos a Google Calendar.
// - Exportar .ics: sin configuración, se importa en Google Calendar (o Outlook, Apple...).
// - Sincronización directa: usa el mismo cliente OAuth de Google que YouTube, con el permiso
//   calendar.events, y crea o actualiza un evento por publicación con aviso 30 min antes.

const SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

export function ensureTable(): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS gcal_events (post_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, synced_at TEXT NOT NULL)')
}

function eventText(p: Post): { summary: string; description: string } {
  const platforms = p.targets.map((t) => PLATFORMS[t.platform].name).join(' + ') || 'Sin plataforma'
  const s = getSettings()
  const link = s.website && p.linkPath ? `${s.website.replace(/\/+$/, '')}${p.linkPath}` : ''
  const lines = [
    `${FORMAT_LABEL[p.format]} · ${platforms}`,
    p.notes,
    p.hook && `Gancho: ${p.hook}`,
    p.cta && `Llamada a la acción: ${p.cta}`,
    link && `Lleva a: ${link}`,
    p.rationale && `Por qué: ${p.rationale}`,
    '',
    p.body.slice(0, 1500),
    '',
    'Creado con AllinMKT'
  ].map((l) => l || '')
  return { summary: `[${platforms}] ${p.title}`, description: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

const exportable = (p: Post): boolean => p.status !== 'idea'

// ---------- .ics ----------

const icsDate = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const icsEscape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
/** Las líneas de iCalendar no deben pasar de 75 octetos: se pliegan con un espacio. */
function fold(line: string): string {
  const out: string[] = []
  let cur = ''
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) {
      out.push(cur)
      cur = ' ' + ch
    } else cur += ch
  }
  out.push(cur)
  return out.join('\r\n')
}

export function exportIcs(file: string, fromIso?: string): number {
  const posts = listPosts().filter((p) => exportable(p) && (!fromIso || p.scheduledAt >= fromIso))
  const now = icsDate(new Date())
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AllinMKT//Calendario de contenido//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Contenido AllinMKT']
  for (const p of posts) {
    const start = new Date(p.scheduledAt)
    const end = new Date(start.getTime() + 30 * 60_000)
    const { summary, description } = eventText(p)
    lines.push(
      'BEGIN:VEVENT',
      `UID:${p.id}@allinmkt`,
      `DTSTAMP:${now}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      fold(`SUMMARY:${icsEscape(summary)}`),
      fold(`DESCRIPTION:${icsEscape(description)}`),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Publicación en 30 minutos',
      'TRIGGER:-PT30M',
      'END:VALARM',
      'END:VEVENT'
    )
  }
  lines.push('END:VCALENDAR')
  writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8')
  return posts.length
}

// ---------- API de Google Calendar ----------

const token = (): Promise<string> => googleRefresh('gcal', getSecret('youtubeClientId'), getSecret('youtubeClientSecret'))

export const gcal = {
  isConnected: (): boolean => !!getTokens('gcal'),

  async connect(): Promise<string> {
    const clientId = getSecret('youtubeClientId')
    if (!clientId || !getSecret('youtubeClientSecret')) throw new Error(tr('Añade primero el Client ID y el secreto de Google (sección YouTube): se usa el mismo cliente OAuth.'))
    const { verifier, challenge } = pkce()
    const state = newState()
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri(), response_type: 'code', scope: `${SCOPE} openid email`,
      access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256'
    }).toString()
    const params = await authorize(url.toString(), state)
    const { data } = await http<{ access_token: string; refresh_token?: string; expires_in: number; id_token?: string }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      form: { client_id: clientId, client_secret: getSecret('youtubeClientSecret'), code: params.get('code') ?? '', grant_type: 'authorization_code', redirect_uri: redirectUri(), code_verifier: verifier }
    })
    setTokens('gcal', { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 })
    let email = 'Google Calendar'
    if (data.id_token) {
      try {
        email = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString()).email ?? email
      } catch {
        /* sin email */
      }
    }
    setAccount('gcal', email, {})
    return email
  },

  async disconnect(): Promise<void> {
    setTokens('gcal', null)
    removeAccount('gcal')
  },

  /** Crea o actualiza un evento por publicación desde hace 7 días; borra los de publicaciones eliminadas. */
  async sync(): Promise<{ created: number; updated: number; deleted: number }> {
    if (!getAccount('gcal')) throw new Error(tr('Google Calendar no está conectado'))
    ensureTable()
    const db = getDb()
    const since = new Date(Date.now() - 7 * 86400_000).toISOString()
    const posts = listPosts().filter((p) => exportable(p) && p.scheduledAt >= since)
    const map = new Map((db.prepare('SELECT post_id, event_id FROM gcal_events').all() as { post_id: string; event_id: string }[]).map((r) => [r.post_id, r.event_id]))
    const tz = getSettings().timezone
    let created = 0
    let updated = 0
    let deleted = 0
    const auth = async (): Promise<Record<string, string>> => ({ Authorization: `Bearer ${await token()}` })

    for (const p of posts) {
      const start = new Date(p.scheduledAt)
      const { summary, description } = eventText(p)
      const body = {
        summary,
        description,
        start: { dateTime: start.toISOString(), timeZone: tz },
        end: { dateTime: new Date(start.getTime() + 30 * 60_000).toISOString(), timeZone: tz },
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
        colorId: p.status === 'published' ? '8' : p.status === 'scheduled' ? '10' : '5',
        extendedProperties: { private: { allinmktPostId: p.id } }
      }
      const existing = map.get(p.id)
      if (existing) {
        try {
          await http(`${API}/${existing}`, { method: 'PUT', headers: await auth(), json: body })
          updated++
          continue
        } catch (e) {
          if (!(e instanceof HttpError && (e.status === 404 || e.status === 410))) throw e
        }
      }
      const res = await http<{ id: string }>(API, { method: 'POST', headers: await auth(), json: body })
      db.prepare('INSERT OR REPLACE INTO gcal_events (post_id, event_id, synced_at) VALUES (?,?,?)').run(p.id, res.data.id, new Date().toISOString())
      created++
    }

    const alive = new Set(listPosts().filter(exportable).map((p) => p.id))
    for (const [postId, eventId] of map) {
      if (alive.has(postId)) continue
      try {
        await http(`${API}/${eventId}`, { method: 'DELETE', headers: await auth() })
      } catch (e) {
        if (!(e instanceof HttpError && (e.status === 404 || e.status === 410))) throw e
      }
      db.prepare('DELETE FROM gcal_events WHERE post_id = ?').run(postId)
      deleted++
    }
    log('info', 'gcal', `Google Calendar: ${created} creados, ${updated} actualizados, ${deleted} borrados`)
    return { created, updated, deleted }
  }
}

let timer: NodeJS.Timeout | null = null
/** Sincroniza unos segundos después del último cambio, si está conectado. */
export function scheduleGcalSync(): void {
  if (!gcal.isConnected()) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    gcal.sync().catch((e) => log('warn', 'gcal', e instanceof Error ? e.message : String(e)))
  }, 8000)
}
