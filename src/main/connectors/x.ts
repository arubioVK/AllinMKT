import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Connector } from './types'
import { trackedLink } from './types'
import { getSecret, getTokens, setTokens, type TokenSet } from '../secrets'
import { authorize, newState, pkce, redirectUri } from '../oauth'
import { http } from '../http'
import { getAccount, removeAccount, setAccount } from '../db'
import { mimeOf } from '../media'
import type { Post, PostTarget, Settings } from '@shared/types'
import { tr } from '../i18n'

// X API v2 con OAuth 2.0 + PKCE. Publicar funciona en el plan gratuito con límites bajos;
// leer métricas de tus posts requiere un plan de pago (Basic o superior).

const API = 'https://api.x.com/2'
const SCOPES = 'tweet.read tweet.write users.read offline.access media.write'
/** X acorta todos los enlaces a 23 caracteres. */
const LINK_LEN = 23

interface XToken { access_token: string; refresh_token?: string; expires_in: number }

function basicAuth(): Record<string, string> {
  const secret = getSecret('xClientSecret')
  return secret ? { Authorization: 'Basic ' + Buffer.from(`${getSecret('xClientId')}:${secret}`).toString('base64') } : {}
}

async function token(): Promise<string> {
  const t = getTokens('x')
  if (!t) throw new Error(tr('X no está conectado'))
  if (t.expiresAt && t.expiresAt - Date.now() > 60_000) return t.accessToken
  if (!t.refreshToken) throw new Error(tr('La sesión de X caducó. Vuelve a conectar la cuenta.'))
  const { data } = await http<XToken>(`${API}/oauth2/token`, {
    method: 'POST',
    headers: basicAuth(),
    form: { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: getSecret('xClientId') }
  })
  const next: TokenSet = { accessToken: data.access_token, refreshToken: data.refresh_token ?? t.refreshToken, expiresAt: Date.now() + data.expires_in * 1000 }
  setTokens('x', next)
  return next.accessToken
}

/** Divide el texto en posts de 280 caracteres. Un hilo se separa con líneas "---". */
export function splitForX(post: Post, target: PostTarget, settings: Settings): string[] {
  const text = (target.caption || post.body).trim()
  const parts = post.format === 'thread' ? text.split(/\n-{3,}\n/).map((p) => p.trim()).filter(Boolean) : [text]
  const link = trackedLink(post, 'x', settings)
  const out = parts.map((p, i) => {
    const isLast = i === parts.length - 1
    const room = 280 - (isLast && link ? LINK_LEN + 2 : 0)
    const clipped = p.length > room ? p.slice(0, room - 1).trimEnd() + '…' : p
    return isLast && link ? `${clipped}\n\n${link}` : clipped
  })
  return out
}

export const x: Connector = {
  platform: 'x',

  isConnected: () => !!getTokens('x'),

  async connect() {
    const clientId = getSecret('xClientId')
    if (!clientId) throw new Error(tr('Añade el Client ID de OAuth 2.0 de tu app de X'))
    const { verifier, challenge } = pkce()
    const state = newState()
    const url = new URL('https://x.com/i/oauth2/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri(),
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()
    const params = await authorize(url.toString(), state)
    const { data } = await http<XToken>(`${API}/oauth2/token`, {
      method: 'POST',
      headers: basicAuth(),
      form: { code: params.get('code') ?? '', grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri(), code_verifier: verifier }
    })
    setTokens('x', { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 })
    const me = await http<{ data: { id: string; username: string } }>(`${API}/users/me`, { headers: { Authorization: `Bearer ${data.access_token}` } })
    setAccount('x', `@${me.data.data.username}`, { userId: me.data.data.id, username: me.data.data.username })
    return `@${me.data.data.username}`
  },

  async disconnect() {
    setTokens('x', null)
    removeAccount('x')
  },

  async publish(post, target, settings) {
    const parts = splitForX(post, target, settings)
    let mediaIds: string[] | undefined
    if (post.mediaPath && /\.(jpe?g|png|gif|webp)$/i.test(post.mediaPath)) {
      const form = new FormData()
      form.append('media', new Blob([readFileSync(post.mediaPath)], { type: mimeOf(post.mediaPath) }), basename(post.mediaPath))
      form.append('media_category', 'tweet_image')
      const up = await http<{ data: { id: string } }>(`${API}/media/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}` },
        body: form
      })
      mediaIds = [up.data.data.id]
    }
    let firstId = ''
    let prev = ''
    for (let i = 0; i < parts.length; i++) {
      const body: Record<string, unknown> = { text: parts[i] }
      if (i === 0 && mediaIds) body.media = { media_ids: mediaIds }
      if (prev) body.reply = { in_reply_to_tweet_id: prev }
      const res = await http<{ data: { id: string } }>(`${API}/tweets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}` },
        json: body
      })
      prev = res.data.data.id
      if (!firstId) firstId = prev
    }
    const username = String(getAccount('x')?.meta.username ?? 'i')
    return { remoteId: firstId, remoteUrl: `https://x.com/${username}/status/${firstId}` }
  },

  async fetchMetrics(targets) {
    const out = []
    for (let i = 0; i < targets.length; i += 100) {
      const batch = targets.slice(i, i + 100)
      const { data } = await http<{ data?: { id: string; public_metrics: { impression_count?: number; like_count: number; reply_count: number; retweet_count: number; quote_count: number; bookmark_count?: number } }[] }>(
        `${API}/tweets?ids=${batch.map((t) => t.remoteId).join(',')}&tweet.fields=public_metrics`,
        { headers: { Authorization: `Bearer ${await token()}` } }
      )
      for (const tw of data.data ?? []) {
        const t = batch.find((b) => b.remoteId === tw.id)
        const m = tw.public_metrics
        if (t) out.push({ targetId: t.id, views: m.impression_count ?? 0, likes: m.like_count, comments: m.reply_count, shares: m.retweet_count + m.quote_count, saves: m.bookmark_count ?? 0 })
      }
    }
    return out
  }
}
