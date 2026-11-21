import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import type { Post } from '@shared/types'
import { getSettings, upsertPost } from './db'
import { getSecret } from './secrets'
import { tr } from './i18n'

// Algunas plataformas (Instagram) descargan el archivo desde una URL pública.
// Si la publicación no tiene una, subimos el archivo local a un almacenamiento compatible con S3
// (Cloudflare R2, AWS S3, Backblaze B2, MinIO...) y usamos su URL pública.

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'
}

export function storageConfigured(): boolean {
  const s = getSettings()
  return !!(s.storageEndpoint && s.storageBucket && s.storagePublicBaseUrl && getSecret('storageAccessKeyId') && getSecret('storageSecretAccessKey'))
}

export async function uploadPublic(file: string, keyPrefix: string): Promise<string> {
  const s = getSettings()
  if (!storageConfigured()) {
    throw new Error(tr('Esta plataforma necesita el archivo en una URL pública. Configura el almacenamiento en Conexiones o pega una URL pública en el editor.'))
  }
  const client = new S3Client({
    endpoint: s.storageEndpoint,
    region: s.storageRegion || 'auto',
    credentials: { accessKeyId: getSecret('storageAccessKeyId'), secretAccessKey: getSecret('storageSecretAccessKey') },
    forcePathStyle: true
  })
  const key = `${keyPrefix}/${Date.now()}-${basename(file).replace(/[^a-zA-Z0-9._-]/g, '_')}`
  await client.send(
    new PutObjectCommand({
      Bucket: s.storageBucket,
      Key: key,
      Body: readFileSync(file),
      ContentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    })
  )
  return `${s.storagePublicBaseUrl.replace(/\/+$/, '')}/${key}`
}

export async function ensurePublicUrl(post: Post, what: string): Promise<string> {
  if (post.mediaPublicUrl) return post.mediaPublicUrl
  if (!post.mediaPath) throw new Error(tr('Esta publicación necesita {what}. Añádelo en el editor.', { what: tr(what) }))
  const url = await uploadPublic(post.mediaPath, 'allinmkt')
  upsertPost(post.id, { mediaPublicUrl: url })
  return url
}

export function mimeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}
