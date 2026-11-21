import type { Connector } from './types'
import { composeCaption } from './types'
import { getSecret, setSecret } from '../secrets'
import { getAccount, removeAccount, setAccount, getSettings } from '../db'
import { http, sleep } from '../http'
import { ensurePublicUrl } from '../media'
import { tr } from '../i18n'

// Instagram API con inicio de sesión de Instagram (cuentas Business o Creator).
// Meta exige redirecciones https, así que en una app de escritorio usamos el token de larga
// duración que genera el panel de la app de Meta (Instagram > configuración de la API).
// Instagram descarga el vídeo o la imagen desde una URL pública: ver media.ts.

const base = (): string => `https://graph.instagram.com/${getSettings().igApiVersion}`

function token(): string {
  const t = getSecret('instagramAccessToken')
  if (!t) throw new Error(tr('Instagram no está conectado'))
  return t
}

async function refreshIfOld(): Promise<void> {
  const acc = getAccount('instagram')
  const last = Number(acc?.meta.refreshedAt ?? 0)
  // Los tokens de larga duración duran 60 días; los renovamos cada 20.
  if (acc && Date.now() - last > 20 * 86400_000) {
    const { data } = await http<{ access_token: string }>(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token())}`
    )
    setSecret('instagramAccessToken', data.access_token)
    setAccount('instagram', acc.displayName, { ...acc.meta, refreshedAt: Date.now() })
  }
}

function userId(): string {
  const id = getAccount('instagram')?.meta.userId
  if (!id) throw new Error(tr('Instagram no está conectado'))
  return String(id)
}

export const instagram: Connector = {
  platform: 'instagram',

  isConnected: () => !!getAccount('instagram'),

  async connect() {
    const { data } = await http<{ user_id: string; username: string }>(`${base()}/me?fields=user_id,username&access_token=${encodeURIComponent(token())}`)
    setAccount('instagram', `@${data.username}`, { userId: data.user_id, refreshedAt: Date.now() })
    return `@${data.username}`
  },

  async disconnect() {
    setSecret('instagramAccessToken', '')
    removeAccount('instagram')
  },

  async publish(post, target, settings) {
    await refreshIfOld()
    const isImage = post.format === 'image'
    const mediaUrl = await ensurePublicUrl(post, isImage ? 'una imagen' : 'un vídeo')
    const caption = composeCaption(post, target, settings)
    const params = new URLSearchParams({ caption, access_token: token() })
    if (isImage) params.set('image_url', mediaUrl)
    else {
      params.set('media_type', 'REELS')
      params.set('video_url', mediaUrl)
    }
    const container = await http<{ id: string }>(`${base()}/${userId()}/media`, { method: 'POST', body: params })
    const creationId = container.data.id

    // Esperamos a que Instagram procese el contenedor (vídeos: hasta ~5 minutos).
    for (let i = 0; i < 60; i++) {
      const st = await http<{ status_code: string; status?: string }>(`${base()}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(token())}`)
      if (st.data.status_code === 'FINISHED') break
      if (st.data.status_code === 'ERROR' || st.data.status_code === 'EXPIRED') throw new Error(tr('Instagram no pudo procesar el archivo: {status}', { status: st.data.status ?? st.data.status_code }))
      await sleep(5000)
    }
    const pub = await http<{ id: string }>(`${base()}/${userId()}/media_publish`, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: creationId, access_token: token() })
    })
    const link = await http<{ permalink?: string }>(`${base()}/${pub.data.id}?fields=permalink&access_token=${encodeURIComponent(token())}`)
    return { remoteId: pub.data.id, remoteUrl: link.data.permalink ?? null }
  },

  async fetchMetrics(targets) {
    await refreshIfOld()
    const out = []
    for (const t of targets) {
      const { data } = await http<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
        `${base()}/${t.remoteId}/insights?metric=views,likes,comments,shares,saved&access_token=${encodeURIComponent(token())}`
      )
      const v = (name: string): number => {
        const m = data.data.find((x) => x.name === name)
        return m?.total_value?.value ?? m?.values?.[0]?.value ?? 0
      }
      out.push({ targetId: t.id, views: v('views'), likes: v('likes'), comments: v('comments'), shares: v('shares'), saves: v('saved') })
    }
    return out
  }
}
