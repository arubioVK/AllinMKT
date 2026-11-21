import { statSync, readFileSync } from 'node:fs'
import type { Connector } from './types'
import { composeCaption, requireMedia } from './types'
import { getSecret, getTokens, setTokens } from '../secrets'
import { authorize, newState, pkce, redirectUri } from '../oauth'
import { http } from '../http'
import { removeAccount, setAccount } from '../db'
import { mimeOf } from '../media'
import { tr } from '../i18n'

// YouTube Data API v3. Crea un cliente OAuth de tipo "App de escritorio" en Google Cloud,
// que acepta redirecciones a 127.0.0.1 en cualquier puerto.
// Ojo: los proyectos sin verificar por Google suben los vídeos como privados.

const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly'

interface GoogleToken { access_token: string; refresh_token?: string; expires_in: number }

export async function googleRefresh(platform: string, clientId: string, clientSecret: string): Promise<string> {
  const t = getTokens(platform)
  if (!t) throw new Error(tr('La cuenta no está conectada'))
  if (t.expiresAt && t.expiresAt - Date.now() > 60_000) return t.accessToken
  if (!t.refreshToken) throw new Error(tr('La sesión caducó. Vuelve a conectar la cuenta.'))
  const { data } = await http<GoogleToken>('https://oauth2.googleapis.com/token', {
    method: 'POST',
    form: { client_id: clientId, client_secret: clientSecret, refresh_token: t.refreshToken, grant_type: 'refresh_token' }
  })
  setTokens(platform, { accessToken: data.access_token, refreshToken: t.refreshToken, expiresAt: Date.now() + data.expires_in * 1000 })
  return data.access_token
}

const token = (): Promise<string> => googleRefresh('youtube', getSecret('youtubeClientId'), getSecret('youtubeClientSecret'))

export const youtube: Connector = {
  platform: 'youtube',

  isConnected: () => !!getTokens('youtube'),

  async connect() {
    const clientId = getSecret('youtubeClientId')
    if (!clientId || !getSecret('youtubeClientSecret')) throw new Error(tr('Añade el Client ID y el Client secret de tu cliente OAuth de Google'))
    const { verifier, challenge } = pkce()
    const state = newState()
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()
    const params = await authorize(url.toString(), state)
    const { data } = await http<GoogleToken>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      form: {
        client_id: clientId,
        client_secret: getSecret('youtubeClientSecret'),
        code: params.get('code') ?? '',
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(),
        code_verifier: verifier
      }
    })
    setTokens('youtube', { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 })
    const ch = await http<{ items: { id: string; snippet: { title: string } }[] }>(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${data.access_token}` } }
    )
    const channel = ch.data.items?.[0]
    if (!channel) throw new Error(tr('Esta cuenta de Google no tiene canal de YouTube'))
    setAccount('youtube', channel.snippet.title, { channelId: channel.id })
    return channel.snippet.title
  },

  async disconnect() {
    setTokens('youtube', null)
    removeAccount('youtube')
  },

  async publish(post, target, settings) {
    const file = requireMedia(post)
    const title = (target.title || post.title).slice(0, 100)
    let description = composeCaption(post, target, settings).slice(0, 5000)
    if (post.format === 'short' && !/#shorts/i.test(description)) description += '\n\n#Shorts'
    const size = statSync(file).size

    // Subida reanudable: primero los metadatos, luego el archivo a la URL de sesión.
    const init = await http('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await token()}`,
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': mimeOf(file)
      },
      json: {
        snippet: { title, description, categoryId: '22' },
        status: { privacyStatus: settings.youtubePrivacy, selfDeclaredMadeForKids: false }
      }
    })
    const session = init.headers.get('location')
    if (!session) throw new Error(tr('YouTube no devolvió la URL de subida'))
    const up = await http<{ id: string }>(session, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': mimeOf(file), 'Content-Length': String(size) },
      body: readFileSync(file)
    })
    const id = up.data.id
    return { remoteId: id, remoteUrl: post.format === 'short' ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}` }
  },

  async fetchMetrics(targets) {
    const out = []
    for (let i = 0; i < targets.length; i += 50) {
      const batch = targets.slice(i, i + 50)
      const { data } = await http<{ items: { id: string; statistics: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }>(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch.map((t) => t.remoteId).join(',')}`,
        { headers: { Authorization: `Bearer ${await token()}` } }
      )
      for (const v of data.items ?? []) {
        const t = batch.find((x) => x.remoteId === v.id)
        if (t) out.push({ targetId: t.id, views: Number(v.statistics.viewCount ?? 0), likes: Number(v.statistics.likeCount ?? 0), comments: Number(v.statistics.commentCount ?? 0), shares: 0, saves: 0 })
      }
    }
    return out
  }
}
