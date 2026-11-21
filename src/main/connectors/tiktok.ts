import { statSync, openSync, readSync, closeSync } from 'node:fs'
import type { Connector } from './types'
import { composeCaption, requireMedia } from './types'
import { getSecret, getTokens, setTokens, type TokenSet } from '../secrets'
import { authorize, newState, pkce, redirectUri } from '../oauth'
import { http, sleep } from '../http'
import { removeAccount, setAccount } from '../db'
import { tr } from '../i18n'

// TikTok Content Posting API (Direct Post) + Display API para métricas.
// Mientras TikTok no audite tu app, solo se puede publicar con privacidad SELF_ONLY (privado).
const API = 'https://open.tiktokapis.com'

interface TokenResponse { access_token: string; refresh_token: string; expires_in: number; open_id: string }

async function token(): Promise<string> {
  const t = getTokens('tiktok')
  if (!t) throw new Error(tr('TikTok no está conectado'))
  if (t.expiresAt && t.expiresAt - Date.now() > 60_000) return t.accessToken
  if (!t.refreshToken) throw new Error(tr('La sesión de TikTok caducó. Vuelve a conectar la cuenta.'))
  const { data } = await http<TokenResponse>(`${API}/v2/oauth/token/`, {
    method: 'POST',
    form: {
      client_key: getSecret('tiktokClientKey'),
      client_secret: getSecret('tiktokClientSecret'),
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken
    }
  })
  const next: TokenSet = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 }
  setTokens('tiktok', next)
  return next.accessToken
}

const auth = async (): Promise<Record<string, string>> => ({ Authorization: `Bearer ${await token()}` })

export const tiktok: Connector = {
  platform: 'tiktok',

  isConnected: () => !!getTokens('tiktok'),

  async connect() {
    const clientKey = getSecret('tiktokClientKey')
    if (!clientKey || !getSecret('tiktokClientSecret')) throw new Error(tr('Añade el Client key y el Client secret de tu app de TikTok'))
    // Las apps de escritorio de TikTok usan el reto PKCE en hexadecimal.
    const { verifier, challenge } = pkce('hex')
    const state = newState()
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/')
    url.search = new URLSearchParams({
      client_key: clientKey,
      response_type: 'code',
      scope: 'user.info.basic,video.publish,video.list',
      redirect_uri: redirectUri(),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()
    const params = await authorize(url.toString(), state)
    const { data } = await http<TokenResponse>(`${API}/v2/oauth/token/`, {
      method: 'POST',
      form: {
        client_key: clientKey,
        client_secret: getSecret('tiktokClientSecret'),
        code: params.get('code') ?? '',
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(),
        code_verifier: verifier
      }
    })
    setTokens('tiktok', { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 })
    const me = await http<{ data: { user: { display_name: string } } }>(`${API}/v2/user/info/?fields=open_id,display_name`, { headers: await auth() })
    const name = me.data.data.user.display_name
    setAccount('tiktok', name, { openId: data.open_id })
    return name
  },

  async disconnect() {
    setTokens('tiktok', null)
    removeAccount('tiktok')
  },

  async publish(post, target, settings) {
    const file = requireMedia(post)
    const size = statSync(file).size
    const headers = await auth()

    const creator = await http<{ data: { privacy_level_options: string[] } }>(`${API}/v2/post/publish/creator_info/query/`, {
      method: 'POST', headers, json: {}
    })
    const options = creator.data.data.privacy_level_options ?? []
    const privacy = options.includes(settings.tiktokPrivacy) ? settings.tiktokPrivacy : options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0]

    // Archivos de hasta 64 MB van en un solo trozo; si no, trozos de 10 MB (el último absorbe el resto).
    const MB = 1024 * 1024
    const chunkSize = size <= 64 * MB ? size : 10 * MB
    const chunks = size <= 64 * MB ? 1 : Math.floor(size / chunkSize)

    const init = await http<{ data: { publish_id: string; upload_url: string } }>(`${API}/v2/post/publish/video/init/`, {
      method: 'POST',
      headers,
      json: {
        post_info: { title: composeCaption(post, target, settings).slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
        source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: chunks }
      }
    })
    const { publish_id, upload_url } = init.data.data

    const fd = openSync(file, 'r')
    try {
      for (let i = 0; i < chunks; i++) {
        const start = i * chunkSize
        const end = i === chunks - 1 ? size - 1 : start + chunkSize - 1
        const buf = Buffer.alloc(end - start + 1)
        readSync(fd, buf, 0, buf.length, start)
        await http(upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
          body: buf
        })
      }
    } finally {
      closeSync(fd)
    }

    // TikTok procesa el vídeo de forma asíncrona: esperamos hasta ~3 minutos.
    for (let i = 0; i < 36; i++) {
      await sleep(5000)
      const st = await http<{ data: { status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] } }>(
        `${API}/v2/post/publish/status/fetch/`, { method: 'POST', headers: await auth(), json: { publish_id } }
      )
      const d = st.data.data
      if (d.status === 'FAILED') throw new Error(tr('TikTok rechazó el vídeo: {reason}', { reason: d.fail_reason ?? tr('sin motivo') }))
      if (d.status === 'PUBLISH_COMPLETE') {
        const id = d.publicaly_available_post_id?.[0]
        return { remoteId: id ? String(id) : publish_id, remoteUrl: id ? `https://www.tiktok.com/video/${id}` : null }
      }
    }
    return { remoteId: publish_id, remoteUrl: null }
  },

  async fetchMetrics(targets) {
    const ids = targets.map((t) => t.remoteId!).filter((id) => /^\d+$/.test(id))
    const out = []
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20)
      const { data } = await http<{ data: { videos: { id: string; view_count: number; like_count: number; comment_count: number; share_count: number }[] } }>(
        `${API}/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count`,
        { method: 'POST', headers: await auth(), json: { filters: { video_ids: batch } } }
      )
      for (const v of data.data.videos ?? []) {
        const t = targets.find((x) => x.remoteId === String(v.id))
        if (t) out.push({ targetId: t.id, views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count, saves: 0 })
      }
    }
    return out
  }
}
