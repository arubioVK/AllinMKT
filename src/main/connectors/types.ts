import type { MetricSnapshot, Platform, Post, PostTarget, Settings } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { tr } from '../i18n'

export interface PublishResult {
  remoteId: string
  remoteUrl: string | null
}

export interface Connector {
  platform: Platform
  /** Inicia el flujo de conexión (OAuth o comprobación de credenciales). Devuelve el nombre de la cuenta. */
  connect(): Promise<string>
  disconnect(): Promise<void>
  isConnected(): boolean
  publish(post: Post, target: PostTarget, settings: Settings): Promise<PublishResult>
  /** Métricas acumuladas actuales de las publicaciones indicadas. */
  fetchMetrics?(targets: PostTarget[], settings: Settings): Promise<Omit<MetricSnapshot, 'date'>[]>
}

/** Enlace a la web con parámetros UTM, para atribuir las visitas a cada publicación. */
export function trackedLink(post: Post, platform: Platform, settings: Settings): string {
  if (!settings.website) return ''
  const base = settings.website.replace(/\/+$/, '')
  const path = post.linkPath ? (post.linkPath.startsWith('/') ? post.linkPath : `/${post.linkPath}`) : '/'
  const url = new URL(base + path)
  url.searchParams.set('utm_source', platform)
  url.searchParams.set('utm_medium', 'social')
  url.searchParams.set('utm_campaign', post.utmCampaign)
  return url.toString()
}

/** Texto final para una plataforma: texto propio o cuerpo + llamada a la acción + enlace. */
export function composeCaption(post: Post, target: PostTarget, settings: Settings): string {
  const meta = PLATFORMS[target.platform]
  let text = (target.caption || post.body).trim()
  const link = trackedLink(post, target.platform, settings)
  if (!target.caption && post.cta && !text.includes(post.cta)) text += `\n\n${post.cta}`
  if (link && meta.linkClickable && !text.includes('utm_campaign')) text += `\n\n${link}`
  return text
}

export function requireMedia(post: Post, what = 'un archivo de vídeo'): string {
  if (!post.mediaPath) throw new Error(tr('Esta publicación necesita {what}. Añádelo en el editor.', { what: tr(what) }))
  return post.mediaPath
}
