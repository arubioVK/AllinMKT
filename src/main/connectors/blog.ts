import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { marked } from 'marked'
import type { Connector } from './types'
import { getSecret } from '../secrets'
import { getSettings, removeAccount, setAccount, getAccount, slugify } from '../db'
import { http } from '../http'
import type { Post, PostTarget, Settings } from '@shared/types'
import { tr } from '../i18n'

// Blog: WordPress (API REST + contraseña de aplicación) o archivos Markdown en una carpeta
// (Astro, Hugo, Next, Jekyll...). Las visitas de cada artículo se leen de GA4 por su ruta.

export function blogSlug(post: Post): string {
  const fromPath = post.linkPath.split('/').filter(Boolean).pop()
  return fromPath || slugify(post.title)
}

function article(post: Post, target: PostTarget): { title: string; markdown: string } {
  return { title: target.title || post.title, markdown: (target.caption || post.body).trim() }
}

const wpAuth = (s: Settings): string => 'Basic ' + Buffer.from(`${s.wordpressUser}:${getSecret('wordpressAppPassword')}`).toString('base64')

const yaml = (v: string): string => JSON.stringify(v)

export const blog: Connector = {
  platform: 'blog',

  isConnected: () => !!getAccount('blog'),

  async connect() {
    const s = getSettings()
    if (s.blogMode === 'markdown') {
      if (!s.markdownFolder) throw new Error(tr('Elige la carpeta donde se guardan los artículos'))
      if (!existsSync(s.markdownFolder)) throw new Error(tr('La carpeta no existe'))
      setAccount('blog', s.markdownFolder, { mode: 'markdown' })
      return s.markdownFolder
    }
    if (!s.wordpressUrl || !s.wordpressUser || !getSecret('wordpressAppPassword')) throw new Error(tr('Completa la URL, el usuario y la contraseña de aplicación de WordPress'))
    const { data } = await http<{ name: string }>(`${s.wordpressUrl.replace(/\/+$/, '')}/wp-json/wp/v2/users/me`, { headers: { Authorization: wpAuth(s) } })
    setAccount('blog', `${data.name} · ${new URL(s.wordpressUrl).host}`, { mode: 'wordpress' })
    return data.name
  },

  async disconnect() {
    removeAccount('blog')
  },

  async publish(post, target, settings) {
    const { title, markdown } = article(post, target)
    if (!markdown) throw new Error(tr('El artículo está vacío. Escríbelo o genéralo con la IA en el editor.'))
    const slug = blogSlug(post)
    const excerpt = post.hook || markdown.replace(/[#*_>`\[\]]/g, '').slice(0, 160)

    if (settings.blogMode === 'markdown') {
      mkdirSync(settings.markdownFolder, { recursive: true })
      const file = join(settings.markdownFolder, `${slug}.md`)
      const fm = ['---', `title: ${yaml(title)}`, `description: ${yaml(excerpt)}`, `pubDate: ${new Date().toISOString()}`, post.pillar ? `tags: [${yaml(post.pillar)}]` : '', '---', ''].filter((l) => l !== '').join('\n')
      writeFileSync(file, `${fm}\n\n${markdown}\n`, 'utf8')
      const url = settings.website ? `${settings.website.replace(/\/+$/, '')}${post.linkPath || `/blog/${slug}`}` : null
      return { remoteId: file, remoteUrl: url }
    }

    const res = await http<{ id: number; link: string }>(`${settings.wordpressUrl.replace(/\/+$/, '')}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { Authorization: wpAuth(settings) },
      json: { title, content: await marked.parse(markdown), excerpt, slug, status: 'publish' }
    })
    return { remoteId: String(res.data.id), remoteUrl: res.data.link }
  }
}
