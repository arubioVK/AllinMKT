import { readFileSync } from 'node:fs'
import type { Connector } from './types'
import { composeCaption } from './types'
import { getSecret, getTokens, setTokens } from '../secrets'
import { authorize, newState, redirectUri } from '../oauth'
import { http } from '../http'
import { getAccount, removeAccount, setAccount } from '../db'
import { mimeOf } from '../media'
import type { Settings } from '@shared/types'
import { tr } from '../i18n'

// LinkedIn: productos "Sign In with LinkedIn using OpenID Connect" y "Share on LinkedIn"
// (permiso w_member_social) para publicar en tu perfil personal.
// Las estadísticas de publicaciones requieren la Community Management API (con aprobación
// de LinkedIn), así que aquí se introducen a mano desde Analítica.

/** LinkedIn versiona su API por mes (AAAAMM) y retira versiones al cabo de un año. */
function apiVersion(s: Settings): string {
  if (s.linkedinVersion) return s.linkedinVersion
  const d = new Date()
  d.setMonth(d.getMonth() - 2)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
}

function token(): string {
  const t = getTokens('linkedin')
  if (!t) throw new Error(tr('LinkedIn no está conectado'))
  if (t.expiresAt && t.expiresAt < Date.now()) throw new Error(tr('La sesión de LinkedIn caducó (duran 60 días). Vuelve a conectar la cuenta.'))
  return t.accessToken
}

const headers = (s: Settings): Record<string, string> => ({
  Authorization: `Bearer ${token()}`,
  'LinkedIn-Version': apiVersion(s),
  'X-Restli-Protocol-Version': '2.0.0'
})

export const linkedin: Connector = {
  platform: 'linkedin',

  isConnected: () => !!getTokens('linkedin'),

  async connect() {
    const clientId = getSecret('linkedinClientId')
    if (!clientId || !getSecret('linkedinClientSecret')) throw new Error(tr('Añade el Client ID y el Client secret de tu app de LinkedIn'))
    const state = newState()
    const url = new URL('https://www.linkedin.com/oauth/v2/authorization')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri(),
      state,
      scope: 'openid profile w_member_social'
    }).toString()
    const params = await authorize(url.toString(), state)
    const { data } = await http<{ access_token: string; expires_in: number }>('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      form: {
        grant_type: 'authorization_code',
        code: params.get('code') ?? '',
        client_id: clientId,
        client_secret: getSecret('linkedinClientSecret'),
        redirect_uri: redirectUri()
      }
    })
    setTokens('linkedin', { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 })
    const me = await http<{ sub: string; name: string }>('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` }
    })
    setAccount('linkedin', me.data.name, { personUrn: `urn:li:person:${me.data.sub}` })
    return me.data.name
  },

  async disconnect() {
    setTokens('linkedin', null)
    removeAccount('linkedin')
  },

  async publish(post, target, settings) {
    const author = String(getAccount('linkedin')?.meta.personUrn ?? '')
    if (!author) throw new Error(tr('LinkedIn no está conectado'))
    const body: Record<string, unknown> = {
      author,
      commentary: composeCaption(post, target, settings).slice(0, 3000),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false
    }

    if (post.mediaPath && /\.(jpe?g|png|gif)$/i.test(post.mediaPath)) {
      const init = await http<{ value: { uploadUrl: string; image: string } }>('https://api.linkedin.com/rest/images?action=initializeUpload', {
        method: 'POST',
        headers: headers(settings),
        json: { initializeUploadRequest: { owner: author } }
      })
      await http(init.data.value.uploadUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': mimeOf(post.mediaPath) },
        body: readFileSync(post.mediaPath)
      })
      body.content = { media: { id: init.data.value.image, title: post.title } }
    }

    const res = await http('https://api.linkedin.com/rest/posts', { method: 'POST', headers: headers(settings), json: body })
    const urn = res.headers.get('x-restli-id') ?? ''
    return { remoteId: urn, remoteUrl: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null }
  }
}
