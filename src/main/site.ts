// Lectura de la web del usuario para el autorrelleno del planificador: portada, algunas páginas
// clave y el sitemap. Solo extraemos texto visible y metadatos SEO; no se ejecuta JavaScript.
import { tr } from './i18n'

const UA = 'Mozilla/5.0 (compatible; AllinMKT/0.1; +site-audit)'

export interface PageInfo {
  url: string
  title: string
  description: string
  headings: string[]
  text: string
}

export interface SiteSnapshot {
  origin: string
  pages: PageInfo[]
  sitemapUrls: string[]
}

async function get(url: string, timeoutMs = 15_000): Promise<{ text: string; type: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 5_000_000) return null
    return { text: new TextDecoder('utf-8').decode(buf), type, finalUrl: res.url }
  } catch {
    return null
  }
}

const decode = (s: string): string =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))

const strip = (html: string): string => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

function parsePage(url: string, html: string): PageInfo & { links: string[] } {
  const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  const description = decode(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] ??
      ''
  )
  const headings = [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => `H${m[1]}: ${strip(m[2])}`).filter((h) => h.length > 4).slice(0, 40)
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  const text = strip(body).slice(0, 6000)
  const links = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].map((m) => m[1])
  return { url, title, description, headings, text, links }
}

/** Prioriza páginas que dicen mucho del negocio: servicios, productos, sobre nosotros, blog. */
function score(path: string): number {
  const p = path.toLowerCase()
  if (/(servicio|service|producto|product|tienda|shop|precio|pricing|tarifa)/.test(p)) return 3
  if (/(sobre|about|nosotros|quienes|empresa)/.test(p)) return 2
  if (/(blog|articulo|noticias|news|guia|recursos)/.test(p)) return 2
  if (/(legal|privacidad|privacy|cookies|aviso|terminos|terms|login|cart|carrito|wp-)/.test(p)) return -5
  return 0
}

async function sitemapUrls(origin: string): Promise<string[]> {
  const robots = await get(`${origin}/robots.txt`, 8000)
  const fromRobots = [...(robots?.text.matchAll(/^sitemap:\s*(\S+)/gim) ?? [])].map((m) => m[1])
  const candidates = [...new Set([...fromRobots, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`])]
  const urls = new Set<string>()
  const seen = new Set<string>()
  const queue = [...candidates]
  while (queue.length && seen.size < 8 && urls.size < 500) {
    const sm = queue.shift()!
    if (seen.has(sm)) continue
    seen.add(sm)
    const res = await get(sm, 10_000)
    if (!res || !/<(urlset|sitemapindex)/i.test(res.text)) continue
    const locs = [...res.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]))
    if (/<sitemapindex/i.test(res.text)) queue.push(...locs)
    else locs.forEach((u) => urls.add(u))
  }
  return [...urls].slice(0, 500)
}

export async function readSite(input: string, onStage?: (s: string) => void): Promise<SiteSnapshot> {
  let url = input.trim()
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    throw new Error(tr('La URL no es válida'))
  }
  onStage?.(tr('Leyendo la portada'))
  const home = await get(url)
  if (!home || !home.type.includes('html')) throw new Error(tr('No se pudo leer la web. Comprueba la URL o que la web esté en línea.'))
  origin = new URL(home.finalUrl).origin
  const first = parsePage(home.finalUrl, home.text)

  onStage?.(tr('Buscando el sitemap'))
  const sitemap = await sitemapUrls(origin)

  // Páginas internas candidatas: enlaces de la portada y del sitemap, ordenadas por relevancia.
  const internal = new Set<string>()
  for (const href of [...first.links, ...sitemap.slice(0, 200)]) {
    try {
      const u = new URL(href, origin)
      if (u.origin === origin && u.pathname !== '/' && !/\.(jpg|jpeg|png|gif|webp|pdf|zip|xml|svg|mp4)$/i.test(u.pathname)) internal.add(u.origin + u.pathname)
    } catch {
      /* enlace no válido */
    }
  }
  const picks = [...internal].sort((a, b) => score(new URL(b).pathname) - score(new URL(a).pathname)).slice(0, 5)

  onStage?.(tr('Leyendo {n} páginas clave', { n: picks.length }))
  const pages: PageInfo[] = [first]
  const results = await Promise.all(picks.map((p) => get(p, 12_000)))
  results.forEach((r, i) => {
    if (r && r.type.includes('html')) {
      const p = parsePage(picks[i], r.text)
      pages.push({ ...p, text: p.text.slice(0, 3000) })
    }
  })
  return { origin, pages: pages.map(({ url: u, title, description, headings, text }) => ({ url: u, title, description, headings, text })), sitemapUrls: sitemap }
}

export function snapshotToPrompt(s: SiteSnapshot): string {
  const pages = s.pages
    .map((p) => `<pagina url="${p.url}">\nTítulo: ${p.title}\nMeta descripción: ${p.description || '(vacía)'}\n${p.headings.join('\n')}\nTexto: ${p.text}\n</pagina>`)
    .join('\n\n')
  const paths = s.sitemapUrls.map((u) => {
    try {
      return new URL(u).pathname
    } catch {
      return u
    }
  })
  return `${pages}\n\n<sitemap total="${s.sitemapUrls.length}">\n${paths.slice(0, 300).join('\n') || '(no se encontró sitemap)'}\n</sitemap>`
}
