import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { app, nativeImage } from 'electron'
import { z } from 'zod'
import type {
  AiProgress, ContentContext, ContentContextInput, ContentSeries, ContentSeriesInput, ContextKind, Format, Platform, Post,
  PromptPreview, Script, ScriptRequest, ScriptStatus, VisualPart
} from '@shared/types'
import { FORMAT_LABEL, PLATFORM_IDS, PLATFORMS } from '@shared/types'
import { getDb, getSettings, listPosts, log, upsertPost } from './db'
import { STRATEGIST, structured } from './ai'
import { tr } from './i18n'

// Generación de contenido: biblioteca de contextos (marca, público, personajes, estilos,
// plantillas y reglas), series con el mismo personaje y guiones que no se repiten.
// Un guion lleva un texto distinto por red, pero es un solo vídeo: al convertirlo en
// publicación se crea UN post con un destino por red, y cada destino guarda sus métricas.

const now = (): string => new Date().toISOString()

export function ensureContentTables(): void {
  getDb().exec(`
CREATE TABLE IF NOT EXISTS content_contexts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  format TEXT,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS content_series (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Los campos que se filtran van en columnas; el resto del guion, en JSON.
CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  series_id TEXT,
  episode INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  post_id TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scripts_series ON scripts(series_id, episode);
`)
  // Columnas añadidas después de crear la tabla.
  const cols = (getDb().prepare('PRAGMA table_info(content_contexts)').all() as { name: string }[]).map((c) => c.name)
  if (!cols.includes('images')) getDb().exec("ALTER TABLE content_contexts ADD COLUMN images TEXT NOT NULL DEFAULT '[]'")
  if (!cols.includes('parts')) getDb().exec("ALTER TABLE content_contexts ADD COLUMN parts TEXT NOT NULL DEFAULT '[]'")
  seedContexts()
}

// ---------- Contextos ----------

interface ContextRow {
  id: string; kind: string; name: string; content: string; format: string | null; duration_sec: number
  is_default: number; images: string; parts: string; created_at: string; updated_at: string
}

const toContext = (r: ContextRow): ContentContext => ({
  id: r.id, kind: r.kind as ContextKind, name: r.name, content: r.content, format: (r.format as Format) || null,
  durationSec: r.duration_sec, isDefault: !!r.is_default,
  images: (JSON.parse(r.images || '[]') as string[]).filter((f) => existsSync(f)),
  parts: (JSON.parse(r.parts || '[]') as VisualPart[]).filter((p) => existsSync(p.file)),
  createdAt: r.created_at, updatedAt: r.updated_at
})

export function listContexts(): ContentContext[] {
  return (getDb().prepare('SELECT * FROM content_contexts WHERE archived = 0 ORDER BY kind, name COLLATE NOCASE').all() as ContextRow[]).map(toContext)
}

export function getContext(id: string): ContentContext | null {
  const r = getDb().prepare('SELECT * FROM content_contexts WHERE id = ?').get(id) as ContextRow | undefined
  return r ? toContext(r) : null
}

export function saveContext(id: string | null, input: ContentContextInput): ContentContext {
  const prev = id ? getContext(id) : null
  const c = {
    kind: input.kind ?? prev?.kind ?? 'brand',
    name: (input.name ?? prev?.name ?? '').trim(),
    content: input.content ?? prev?.content ?? '',
    format: input.format !== undefined ? input.format : prev?.format ?? null,
    durationSec: input.durationSec ?? prev?.durationSec ?? 0,
    isDefault: input.isDefault ?? prev?.isDefault ?? false
  }
  if (!c.name) throw new Error(tr('Ponle un nombre'))
  const newId = prev?.id ?? randomUUID()
  if (prev) {
    getDb()
      .prepare('UPDATE content_contexts SET kind=?, name=?, content=?, format=?, duration_sec=?, is_default=?, updated_at=? WHERE id=?')
      .run(c.kind, c.name, c.content, c.format, c.durationSec, c.isDefault ? 1 : 0, now(), newId)
  } else {
    getDb()
      .prepare('INSERT INTO content_contexts (id, kind, name, content, format, duration_sec, is_default, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(newId, c.kind, c.name, c.content, c.format, c.durationSec, c.isDefault ? 1 : 0, now(), now())
  }
  return getContext(newId)!
}

/** Se archiva en lugar de borrarse: los guiones antiguos siguen sabiendo con qué se hicieron. */
export function archiveContext(id: string): void {
  getDb().prepare('UPDATE content_contexts SET archived = 1, updated_at = ? WHERE id = ?').run(now(), id)
}

// ---------- Hoja de personaje ----------

const refsDir = (): string => join(app.getPath('userData'), 'references')
const isRef = (file: string): boolean => resolve(file).startsWith(refsDir() + sep)

/** Copia las imágenes a la carpeta de la app: así no se pierden si mueves o borras el original. */
export function addContextImages(id: string, files: string[]): ContentContext {
  const c = getContext(id)
  if (!c) throw new Error(tr('No encontrado'))
  const dir = join(refsDir(), id)
  mkdirSync(dir, { recursive: true })
  const added = files.map((f) => {
    const dest = join(dir, `${Date.now()}-${basename(f).replace(/[^a-zA-Z0-9._-]/g, '_')}`)
    copyFileSync(f, dest)
    return dest
  })
  getDb().prepare('UPDATE content_contexts SET images = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...c.images, ...added]), now(), id)
  return getContext(id)!
}

export function removeContextImage(id: string, file: string): ContentContext {
  const c = getContext(id)
  if (!c) throw new Error(tr('No encontrado'))
  if (isRef(file)) rmSync(file, { force: true })
  getDb().prepare('UPDATE content_contexts SET images = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(c.images.filter((f) => f !== file)), now(), id)
  return getContext(id)!
}

const IMG_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml'
}

/** La interfaz no lee archivos locales: se los pasamos como data URL (solo de la carpeta de referencias). */
export function imageDataUrl(file: string): string {
  if (!isRef(file) || !existsSync(file)) return ''
  return `data:${IMG_MIME[extname(file).toLowerCase()] ?? 'image/png'};base64,${readFileSync(file).toString('base64')}`
}

// ---------- Piezas y fondos ----------

/** Nombre de pieza válido: minúsculas, números y guiones (la IA lo escribe en el HTML). */
export const partSlug = (v: string): string =>
  v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

/** Tamaño del lienzo de un SVG (width/height o, si no, el viewBox). */
function svgSize(file: string): { width: number; height: number } {
  const head = readFileSync(file, 'utf8').slice(0, 4000)
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? ''
  const num = (attr: string): number => parseFloat(new RegExp(`\\b${attr}="([\\d.]+)(px)?"`).exec(tag)?.[1] ?? '') || 0
  const vb = /viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(tag)
  return { width: Math.round(num('width') || Number(vb?.[1] ?? 0)), height: Math.round(num('height') || Number(vb?.[2] ?? 0)) }
}

/**
 * Mide la imagen: tamaño del lienzo y, si tiene transparencia, el rectángulo donde hay dibujo.
 * Con eso la IA sabe dónde está cada pieza dentro del lienzo y dónde poner el punto de giro.
 */
function measure(file: string): Pick<VisualPart, 'width' | 'height' | 'box'> {
  if (extname(file).toLowerCase() === '.svg') return { ...svgSize(file), box: null }
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return { width: 0, height: 0, box: null }
  const { width, height } = img.getSize()
  const px = img.toBitmap()
  let x0 = width, y0 = height, x1 = -1, y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] < 16) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  // Sin transparencia (un fondo, una foto) el rectángulo es la imagen entera y no aporta nada.
  const full = x0 === 0 && y0 === 0 && x1 === width - 1 && y1 === height - 1
  return { width, height, box: x1 < 0 || full ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1] }
}

function writeParts(id: string, parts: VisualPart[]): ContentContext {
  getDb().prepare('UPDATE content_contexts SET parts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(parts), now(), id)
  return getContext(id)!
}

/** Nombre libre a partir del archivo: "Boca_abierta.png" → "boca-abierta" (o "boca-abierta-2" si ya existe). */
function uniqueName(base: string, taken: Set<string>): string {
  const root = partSlug(base) || 'pieza'
  let name = root
  for (let n = 2; taken.has(name); n++) name = `${root}-${n}`
  taken.add(name)
  return name
}

export function addContextParts(id: string, files: string[]): ContentContext {
  const c = getContext(id)
  if (!c) throw new Error(tr('No encontrado'))
  const dir = join(refsDir(), id, 'parts')
  mkdirSync(dir, { recursive: true })
  const taken = new Set(c.parts.map((p) => p.name))
  const added = files.map((f): VisualPart => {
    const dest = join(dir, `${Date.now()}-${basename(f).replace(/[^a-zA-Z0-9._-]/g, '_')}`)
    copyFileSync(f, dest)
    return { name: uniqueName(basename(f, extname(f)), taken), file: dest, note: '', ...measure(dest) }
  })
  return writeParts(id, [...c.parts, ...added])
}

export function updateContextPart(id: string, file: string, patch: { name?: string; note?: string }): ContentContext {
  const c = getContext(id)
  if (!c) throw new Error(tr('No encontrado'))
  const name = patch.name !== undefined ? partSlug(patch.name) : undefined
  if (name !== undefined && !name) throw new Error(tr('El nombre de la pieza no puede quedar vacío'))
  if (name && c.parts.some((p) => p.name === name && p.file !== file)) throw new Error(tr('Ya hay otra pieza que se llama "{name}"', { name }))
  return writeParts(id, c.parts.map((p) => (p.file === file ? { ...p, ...(name ? { name } : {}), ...(patch.note !== undefined ? { note: patch.note } : {}) } : p)))
}

export function removeContextPart(id: string, file: string): ContentContext {
  const c = getContext(id)
  if (!c) throw new Error(tr('No encontrado'))
  if (isRef(file)) rmSync(file, { force: true })
  return writeParts(id, c.parts.filter((p) => p.file !== file))
}

/** Línea de estilo de un contexto de estilo, para los prompts de imágenes (va en inglés). */
function styleLineOf(styleId: string | null, fallback: string): string {
  const style = styleId ? getContext(styleId) : null
  return style ? (style.content.match(/"([^"]{20,})"/)?.[1] ?? style.name) : fallback
}

/** Prompt para crear el fondo de un escenario en un generador de imágenes. */
export function sceneryPrompt(id: string, styleId: string | null, vertical: boolean): string {
  const c = getContext(id)
  if (!c) throw new Error(tr('No encontrado'))
  return `Background art for a 2D animated series: ${c.name}.
Style: ${styleLineOf(styleId, 'clean 2D cartoon background, bold outlines, flat colors')}.
${vertical ? 'Vertical 9:16 composition, 1080x1920' : 'Horizontal 16:9 composition, 1920x1080'}, eye-level camera, clear floor line in the lower third.
Empty set: NO characters, NO people, NO animals, NO text, NO logos. Leave the center open so animated characters can be placed in front.
Consistent lighting, slightly muted colors so characters stand out. Do not copy any existing show.

Location (follow exactly, it is written in Spanish):
${c.content.trim() || c.name}`
}

/** Solo la parte de aspecto físico de la ficha, si está separada; si no, la ficha entera. */
function appearanceOf(c: ContentContext): string {
  const m = c.content.match(/ASPECTO[^\n]*\n([\s\S]*?)(?:\n\s*\n[A-ZÁÉÍÓÚÑ ]{4,}:|$)/)
  return (m ? m[1] : c.content).trim()
}

/** Prompt para generar la hoja de personaje en cualquier generador de imágenes. */
export function characterSheetPrompt(id: string, styleId: string | null): string {
  const c = getContext(id)
  if (!c) throw new Error(tr('No encontrado'))
  const styleLine = styleLineOf(styleId, 'clean 2D illustration, flat colors')
  return `Character reference sheet (model sheet / turnaround) of a single original character named ${c.name}.
Style: ${styleLine}.
Plain pure white background, even lighting, no shadows, no scenery, no props, no text except small view labels.
- Top row: full body in a neutral standing pose, arms slightly away from the body, shown in FRONT view, THREE-QUARTER view, SIDE profile and BACK view, all at exactly the same scale and aligned on one horizontal line.
- Bottom row: 6 head close-ups with expressions: neutral, happy, angry, scared, surprised, sarcastic.
- Bottom right: color palette swatches for skin, hair, clothes and accessories.
Keep proportions, outfit, colors and every detail identical across all views. Do not resemble any existing copyrighted character.

Character appearance (follow exactly, it is written in Spanish):
${appearanceOf(c)}`
}

function seedContexts(): void {
  const n = (getDb().prepare('SELECT COUNT(*) AS n FROM content_contexts').get() as { n: number }).n
  if (n > 0) return
  const b = getSettings().plannerBrief
  const add = (kind: ContextKind, name: string, content: string, extra: Partial<ContentContext> = {}): void => {
    saveContext(null, { kind, name, content, ...extra })
  }
  if (b?.businessName) {
    add('brand', b.businessName, `Negocio: ${b.businessName}\nWeb: ${b.website}\nQué ofrece: ${b.offer}\nTono: ${b.tone}\nIdioma: ${b.language}\nPilares: ${b.pillars}`, { isDefault: true })
    if (b.audience) add('audience', 'Cliente ideal', b.audience, { isDefault: true })
  }
  add('rule', 'Honestidad', 'No inventes datos, cifras, estudios, clientes ni testimonios. Si hace falta un dato real, déjalo entre corchetes, p. ej. [nº de clientes].', { isDefault: true })

  add('template', 'Vídeo corto (TikTok, Reels, Shorts)', `Vídeo vertical 9:16.
- 0-2 s: gancho que para el scroll (problema, cifra, error común o promesa concreta), dicho y escrito en pantalla.
- Desarrollo: una sola idea útil en 2-3 pasos, cortes cada 2-3 s.
- Giro o prueba: ejemplo concreto, antes/después o demostración.
- Cierre: llamada a la acción a "enlace en la bio" o a guardar el vídeo.`, { format: 'short', durationSec: 30 })
  add('template', 'Mini-historia con personaje', `Vídeo vertical 9:16 con el personaje como protagonista.
- Arranca en mitad de una situación cotidiana con un conflicto que el público reconoce.
- El personaje se equivoca o se atasca; aparece la idea clave (o el producto) como salida natural, sin anuncio.
- Remate con humor o giro final y una frase que se pueda citar.
- Si es parte de una serie, termina con un pequeño gancho hacia el siguiente episodio.`, { format: 'short', durationSec: 45 })
  add('template', 'Vídeo de YouTube', `Vídeo horizontal de 6-10 minutos.
- Intro de 15-30 s: promesa concreta y por qué quedarse hasta el final.
- 3-5 capítulos con un título cada uno; cada escena es un bloque del vídeo.
- Ejemplos y pantallas concretas; nada de relleno.
- Cierre con resumen y llamada a la acción a la web.`, { format: 'video', durationSec: 480 })
  add('template', 'Carrusel de Instagram', `7-10 diapositivas. Cada escena es una diapositiva: "visual" describe el diseño y "onScreenText" el texto exacto.
- Portada con gancho grande y legible.
- Una idea por diapositiva, frases cortas.
- Última diapositiva: llamada a guardar y a visitar el enlace de la bio.`, { format: 'carousel', durationSec: 0 })
  add('template', 'Post de LinkedIn', `Post de texto. Cada escena es un párrafo (usa "voiceover" para el texto).
- Primera línea con gancho que obligue a pulsar "ver más".
- Historia o experiencia concreta, aprendizaje y pregunta final.`, { format: 'text', durationSec: 0 })
  add('template', 'Hilo de X', `Hilo de 5-8 posts. Cada escena es un post de menos de 250 caracteres (en "voiceover").
- El primero promete algo concreto; el último resume y manda a la web.`, { format: 'thread', durationSec: 0 })

  add('style', 'Selfie cercano (UGC)', 'Grabado con el móvil a cámara, como si se lo contaras a un amigo. Luz natural, un solo plano con zooms de corte, subtítulos grandes palabra a palabra. Sin música o con música muy baja.')
  add('style', 'Storytelling cinematográfico', 'Planos cuidados (detalle, general, contraplano), voz en off pausada, música emotiva que sube en el giro. Color cálido, ritmo más lento y silencios con intención.')
  add('style', 'Sketch de humor', 'Escena dramatizada con diálogo; la misma persona puede hacer varios papeles. Exageración, timing rápido, efectos de sonido y remate final. Subtítulos con el nombre de cada papel.')
  add('style', 'Tutorial en pantalla', 'Grabación de pantalla o de manos haciendo el proceso, con flechas, zooms y textos que marcan cada paso. Voz en off clara y directa.')
  add('style', 'Mito vs realidad', 'Dos bloques que se contraponen: "Lo que crees" frente a "Lo que pasa de verdad", con cambio de color o de plano entre ellos. Directo y con datos.')
  add('style', 'POV', 'Plano subjetivo: el espectador es el protagonista ("POV: eres... y ..."). Texto en pantalla que narra la situación, sonido en tendencia, reacciones exageradas.')
}

// ---------- Series ----------

interface SeriesRow { id: string; data: string; created_at: string; updated_at: string }

function episodeCount(seriesId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM scripts WHERE series_id = ? AND status != 'discarded'").get(seriesId) as { n: number }).n
}

const toSeries = (r: SeriesRow): ContentSeries => ({
  name: '', premise: '', characterIds: [], styleId: null, templateId: null, contextIds: [], platforms: [], notes: '',
  ...(JSON.parse(r.data) as Partial<ContentSeries>),
  id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, episodes: episodeCount(r.id)
})

export function listSeries(): ContentSeries[] {
  return (getDb().prepare('SELECT * FROM content_series WHERE archived = 0 ORDER BY updated_at DESC').all() as SeriesRow[]).map(toSeries)
}

function getSeries(id: string): ContentSeries | null {
  const r = getDb().prepare('SELECT * FROM content_series WHERE id = ?').get(id) as SeriesRow | undefined
  return r ? toSeries(r) : null
}

export function saveSeries(id: string | null, input: ContentSeriesInput): ContentSeries {
  const prev = id ? getSeries(id) : null
  const { id: _i, createdAt: _c, updatedAt: _u, episodes: _e, ...base } = prev ?? ({} as ContentSeries)
  const data = { ...base, ...input }
  if (!data.name?.trim()) throw new Error(tr('Ponle un nombre a la serie'))
  const newId = prev?.id ?? randomUUID()
  if (prev) getDb().prepare('UPDATE content_series SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), now(), newId)
  else getDb().prepare('INSERT INTO content_series (id, data, created_at, updated_at) VALUES (?,?,?,?)').run(newId, JSON.stringify(data), now(), now())
  return getSeries(newId)!
}

export function archiveSeries(id: string): void {
  getDb().prepare('UPDATE content_series SET archived = 1, updated_at = ? WHERE id = ?').run(now(), id)
}

// ---------- Guiones ----------

interface ScriptRow { id: string; series_id: string | null; episode: number | null; status: string; post_id: string | null; data: string; created_at: string; updated_at: string }

const toScript = (r: ScriptRow): Script => ({
  ...(JSON.parse(r.data) as Script),
  id: r.id, seriesId: r.series_id, episode: r.episode, status: r.status as ScriptStatus, postId: r.post_id,
  createdAt: r.created_at, updatedAt: r.updated_at
})

export function listScripts(): Script[] {
  return (getDb().prepare('SELECT * FROM scripts ORDER BY created_at DESC').all() as ScriptRow[]).map(toScript)
}

export function getScript(id: string): Script | null {
  const r = getDb().prepare('SELECT * FROM scripts WHERE id = ?').get(id) as ScriptRow | undefined
  return r ? toScript(r) : null
}

function writeScript(s: Script, insert: boolean): void {
  const { id, seriesId, episode, status, postId, createdAt, updatedAt, ...rest } = s
  const data = JSON.stringify({ ...rest, seriesId, episode })
  if (insert) {
    getDb().prepare('INSERT INTO scripts (id, series_id, episode, status, post_id, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, seriesId, episode, status, postId, data, createdAt, updatedAt)
  } else {
    getDb().prepare('UPDATE scripts SET series_id=?, episode=?, status=?, post_id=?, data=?, updated_at=? WHERE id=?')
      .run(seriesId, episode, status, postId, data, now(), id)
  }
}

export function updateScript(id: string, patch: Partial<Script>): Script {
  const prev = getScript(id)
  if (!prev) throw new Error(tr('Guion no encontrado'))
  writeScript({ ...prev, ...patch, id }, false)
  return getScript(id)!
}

export function deleteScript(id: string): void {
  getDb().prepare('DELETE FROM scripts WHERE id = ?').run(id)
}

// ---------- Parecido entre piezas ----------

const STOP = new Set('para como pero porque cuando donde desde hasta sobre entre este esta estos estas esto todo todos toda todas tienes tiene tener hacer puedes puede solo más menos muy cada otro otra otros otras sin con los las del una unos unas que por ese esa eso hay ser son está están tu tus su sus mi mis nos les qué cómo cuál vez veces'.split(' '))

function words(text: string): Set<string> {
  return new Set(
    text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9ñ]+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
      .map((w) => w.replace(/(es|s)$/, ''))
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

const fingerprint = (x: { title: string; hook?: string; summary?: string; angle?: string; keyword?: string }): Set<string> =>
  words([x.title, x.hook, x.summary, x.angle, x.keyword].filter(Boolean).join(' '))

/** Por encima de este parecido avisamos de que el guion repite algo ya hecho. */
const SIMILAR = 0.34

function mostSimilar(s: Pick<Script, 'title' | 'hook' | 'summary' | 'angle' | 'keyword'>, pool: { id: string; title: string; fp: Set<string> }[]): Script['similarTo'] {
  const fp = fingerprint(s)
  let best: Script['similarTo'] = null
  for (const p of pool) {
    const score = jaccard(fp, p.fp)
    if (score >= SIMILAR && (!best || score > best.score)) best = { id: p.id, title: p.title, score: Math.round(score * 100) / 100 }
  }
  return best
}

// ---------- Prompt ----------

const ScriptsSchema = z.object({
  scripts: z.array(
    z.object({
      title: z.string().describe('Título interno corto y descriptivo'),
      hook: z.string().describe('La primera frase o imagen, la que para el scroll'),
      summary: z.string().describe('Qué pasa y qué idea transmite, en 1-2 frases. Sirve de memoria para no repetir y para continuar la serie'),
      angle: z.string().describe('El enfoque que diferencia esta pieza de las anteriores, en pocas palabras'),
      keyword: z.string().describe('Palabra clave principal tal y como la buscaría el público'),
      scenes: z.array(
        z.object({
          time: z.string().describe('Tramo de tiempo ("0-2 s"); en carruseles "Diapositiva N"; en textos "Párrafo N" o "Post N"'),
          visual: z.string().describe('Lo que se ve: plano, acción, personaje, escenario'),
          voiceover: z.string().describe('Lo que se dice (voz o diálogo, con el nombre del personaje si habla); en textos, el texto completo'),
          onScreenText: z.string().describe('Texto sobreimpreso exacto; vacío si no lleva')
        })
      ),
      visualPrompt: z.string().describe('Prompt en inglés para generar el vídeo o las imágenes con IA: estilo, encuadre, luz y la descripción física completa de cada personaje, copiada tal cual'),
      cta: z.string(),
      captions: z.array(
        z.object({
          platform: z.enum(PLATFORM_IDS),
          title: z.string().describe('Solo YouTube (máx. 100 caracteres) y blog; vacío en el resto'),
          caption: z.string()
        })
      ).describe('Un texto propio para cada plataforma pedida')
    })
  )
})

const SCRIPT_SYSTEM = `${STRATEGIST}

Ahora eres guionista y copywriter. Escribes guiones listos para grabar o para generar con IA a partir de piezas de contexto (marca, público, personajes, estilo, plantilla y reglas) que te da el cliente.

Cómo trabajas:
1. Sigue la plantilla: su estructura, su formato y su duración. La suma de los tramos de tiempo encaja con la duración pedida.
2. Aplica el estilo elegido a todo: planos, ritmo, tono, música y textos en pantalla.
3. Personajes: son fijos. Mantén su nombre, aspecto, ropa, personalidad y forma de hablar exactamente como se describen; nunca les cambies nada de un guion a otro. En visualPrompt copia su descripción física completa cada vez, para que el personaje salga igual en todos los vídeos. Si un personaje tiene hoja de personaje, empieza visualPrompt con "Use the attached character reference sheet of <nombre> as strict reference for design, proportions and colors."
4. Nada repetido. En <ya_hecho> tienes lo que ya existe. Cada guion nuevo tiene un tema o un ángulo claramente distinto, un gancho con otra estructura (pregunta, cifra, error, confesión, POV, contraste...) y otro arranque visual. Si te piden varios guiones a la vez, también son distintos entre sí.
5. Series: si hay <serie>, el guion es el siguiente episodio. Respeta lo que ya ha pasado, avanza el arco de la premisa, no repitas situaciones y termina con un pequeño gancho hacia el próximo episodio.
6. Un vídeo, varios textos. El vídeo es el mismo en todas las redes, pero cada una tiene su propio texto:
   - TikTok: 1-3 frases con gancho y la palabra clave, 3-5 hashtags. "Enlace en la bio".
   - Instagram: primera línea con gancho, cuerpo breve con saltos de línea, llamada a guardar o a "enlace en la bio", 5-10 hashtags.
   - YouTube: título de hasta 100 caracteres que empieza por la palabra clave; descripción de 2-4 párrafos.
   - LinkedIn: gancho en la primera línea, párrafos cortos, pregunta final, máximo 3 hashtags.
   - X: máximo 250 caracteres; en hilos separa cada post con una línea que contenga solo ---.
   - Blog: título SEO en title y un resumen del artículo en caption.
7. No incluyas URLs: la app añade el enlace con UTM donde la red lo permite.
8. Escribe en el idioma y el tono de la marca (por defecto, español de España).`

function block(tag: string, items: ContentContext[]): string {
  if (!items.length) return ''
  return `<${tag}>\n${items.map((c) => `## ${c.name}\n${c.content.trim()}`).join('\n\n')}\n</${tag}>`
}

function previousWork(seriesId: string | null): string {
  const scripts = listScripts()
  const own = scripts.filter((s) => s.seriesId !== seriesId || !seriesId).slice(0, 80)
  const posts = listPosts().filter((p) => p.source !== 'demo').slice(-60)
  const lines = [
    ...own.map((s) => `- [${s.status === 'discarded' ? 'descartado' : 'guion'}] ${s.title} · gancho: ${s.hook} · ángulo: ${s.angle} · ${s.summary}`),
    ...posts.map((p) => `- [publicación ${p.scheduledAt.slice(0, 10)}] ${p.title}${p.hook ? ` · gancho: ${p.hook}` : ''}`)
  ]
  return lines.length ? lines.join('\n') : '(todavía no hay nada: tienes libertad total)'
}

/** Escenarios con fondo dibujado: el guion sitúa cada escena en uno de ellos para que el vídeo los use. */
function sceneryBlock(all: ContentContext[]): string {
  const sets = all.filter((c) => c.kind === 'scenery' && c.parts.length)
  if (!sets.length) return ''
  return `<escenarios>\nLugares con fondo ya dibujado. Si encajan, sitúa cada escena en uno de ellos y nómbralo en "visual":\n${sets.map((c) => `- ${c.name}: ${c.content.trim().split('\n')[0] || '—'}`).join('\n')}\n</escenarios>`
}

export function buildScriptPrompt(req: ScriptRequest): PromptPreview & { template: ContentContext | null; series: ContentSeries | null } {
  const byId = new Map(listContexts().map((c) => [c.id, c]))
  const pick = (ids: string[]): ContentContext[] => ids.map((i) => byId.get(i)).filter((c): c is ContentContext => !!c)
  const series = req.seriesId ? getSeries(req.seriesId) : null
  const template = req.templateId ? byId.get(req.templateId) ?? null : null
  const style = req.styleId ? byId.get(req.styleId) ?? null : null
  const ctx = pick(req.contextIds)
  const characters = pick(req.characterIds)
  const platforms = req.platforms.length ? req.platforms : (['tiktok', 'instagram'] as Platform[])
  const count = Math.max(1, Math.min(5, req.count || 1))

  let seriesBlock = ''
  if (series) {
    const eps = listScripts().filter((s) => s.seriesId === series.id && s.status !== 'discarded').sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0))
    const next = (eps.at(-1)?.episode ?? 0) + 1
    seriesBlock = `<serie>
Nombre: ${series.name}
Premisa y arco: ${series.premise || '—'}
${series.notes ? `Notas: ${series.notes}\n` : ''}Episodios anteriores:
${eps.length ? eps.map((e) => `${e.episode}. ${e.title}: ${e.summary}`).join('\n') : '(ninguno: este es el primer episodio, presenta al personaje y la premisa)'}
Escribe ${count > 1 ? `los episodios ${next} a ${next + count - 1}, en orden y encadenados` : `el episodio ${next}`}.
</serie>`
  }

  const prompt = [
    `Escribe ${count} guion${count > 1 ? 'es' : ''}.`,
    block('marca', ctx.filter((c) => c.kind === 'brand')),
    block('publico', ctx.filter((c) => c.kind === 'audience')),
    characters.length
      ? `<personajes>\n${characters.map((c) => `## ${c.name}${c.images.length ? ' (tiene hoja de personaje: se adjunta como imagen de referencia al generar el vídeo)' : ''}\n${c.content.trim()}`).join('\n\n')}\n</personajes>`
      : '',
    sceneryBlock([...byId.values()]),
    template
      ? `<plantilla>\n## ${template.name}\nFormato: ${FORMAT_LABEL[template.format ?? 'short']}${template.durationSec ? `\nDuración: ${template.durationSec} segundos` : ''}\n${template.content.trim()}\n</plantilla>`
      : '<plantilla>Vídeo corto vertical de unos 30 segundos.</plantilla>',
    style ? block('estilo', [style]) : '<estilo>Elige tú el estilo que mejor funcione, distinto al de los guiones anteriores.</estilo>',
    block('reglas', ctx.filter((c) => c.kind === 'rule')),
    seriesBlock,
    `<tema>\n${req.topic.trim() || 'Propón tú un tema nuevo que lleve tráfico a la web y que no esté en <ya_hecho>.'}\n</tema>`,
    `<plataformas>\nEl mismo contenido se publica en: ${platforms.map((p) => PLATFORMS[p].name).join(', ')}. Escribe un texto propio para cada una (platform: ${platforms.join(', ')}).\n</plataformas>`,
    `<ya_hecho>\n${previousWork(series?.id ?? null)}\n</ya_hecho>`
  ].filter(Boolean).join('\n\n')

  return { system: SCRIPT_SYSTEM, prompt, template, series }
}

export async function generateScripts(req: ScriptRequest, onProgress?: (p: AiProgress) => void): Promise<Script[]> {
  if (req.seriesId && !req.characterIds.length) {
    const s = getSeries(req.seriesId)
    if (s) req = { ...req, characterIds: s.characterIds }
  }
  const { system, prompt, template, series } = buildScriptPrompt(req)
  const out = await structured({ kind: 'script', schema: ScriptsSchema, system, prompt, effort: 'high', onProgress })

  const platforms = req.platforms.length ? req.platforms : (['tiktok', 'instagram'] as Platform[])
  const pool = [
    ...listScripts().filter((s) => s.status !== 'discarded').map((s) => ({ id: s.id, title: s.title, fp: fingerprint(s) })),
    ...listPosts().filter((p) => p.source !== 'demo').map((p) => ({ id: `post:${p.id}`, title: p.title, fp: fingerprint(p) }))
  ]
  let episode = series ? Math.max(0, ...listScripts().filter((s) => s.seriesId === series.id && s.status !== 'discarded').map((s) => s.episode ?? 0)) : 0

  const created: Script[] = []
  for (const g of out.scripts) {
    const ts = now()
    const s: Script = {
      id: randomUUID(),
      title: g.title, hook: g.hook, summary: g.summary, angle: g.angle, keyword: g.keyword,
      format: template?.format ?? 'short', durationSec: template?.durationSec ?? 30,
      scenes: g.scenes, visualPrompt: g.visualPrompt, cta: g.cta, platforms,
      captions: Object.fromEntries(g.captions.filter((c) => platforms.includes(c.platform)).map((c) => [c.platform, { title: c.title, caption: c.caption }])),
      templateId: req.templateId, contextIds: req.contextIds, characterIds: req.characterIds, styleId: req.styleId,
      seriesId: series?.id ?? null, episode: series ? ++episode : null, topic: req.topic,
      status: 'draft', postId: null, similarTo: null, notes: '', createdAt: ts, updatedAt: ts
    }
    s.similarTo = mostSimilar(s, pool)
    writeScript(s, true)
    pool.push({ id: s.id, title: s.title, fp: fingerprint(s) })
    created.push(s)
  }
  if (series) saveSeries(series.id, {})
  log('info', 'contenido', `${created.length} guion(es) generados${series ? ` para la serie "${series.name}"` : ''}`)
  return created
}

// ---------- De guion a publicación ----------

export function scriptToText(s: Script): string {
  const scenes = s.scenes
    .map((sc) => [`[${sc.time}]`, sc.visual && `Se ve: ${sc.visual}`, sc.voiceover && `Se dice: ${sc.voiceover}`, sc.onScreenText && `Texto: ${sc.onScreenText}`].filter(Boolean).join('\n'))
    .join('\n\n')
  const refs = s.characterIds.map((id) => getContext(id)).filter((c): c is ContentContext => !!c && c.images.length > 0)
  const refText = refs.length ? `\n\nHojas de personaje (adjúntalas como referencia):\n${refs.map((c) => `${c.name}: ${c.images.join(', ')}`).join('\n')}` : ''
  return `Gancho: ${s.hook}\n\n${scenes}\n\nLlamada a la acción: ${s.cta}${s.visualPrompt ? `\n\nPrompt visual:\n${s.visualPrompt}` : ''}${refText}`
}

export function scriptToPost(id: string, scheduledAt: string, status: 'draft' | 'scheduled'): Post {
  const s = getScript(id)
  if (!s) throw new Error(tr('Guion no encontrado'))
  const platforms = s.platforms.filter((p) => PLATFORMS[p].formats.includes(s.format))
  if (!platforms.length) throw new Error(tr('Ninguna de las redes elegidas admite el formato {format}', { format: tr(FORMAT_LABEL[s.format]) }))
  const series = s.seriesId ? getSeries(s.seriesId) : null
  const post = upsertPost(s.postId, {
    title: s.title, body: scriptToText(s), format: s.format, hook: s.hook, cta: s.cta, scheduledAt, status, source: 'ai',
    // El vídeo generado con la IA se adjunta directamente a la publicación.
    ...(s.video?.path ? { mediaPath: s.video.path } : {}),
    pillar: series?.name ?? '',
    notes: [s.keyword && `Palabra clave: ${s.keyword}`, series && `Serie: ${series.name} · episodio ${s.episode}`].filter(Boolean).join('\n'),
    platforms,
    targetOverrides: Object.fromEntries(platforms.map((p) => [p, { caption: s.captions[p]?.caption ?? '', title: s.captions[p]?.title ?? '' }]))
  })
  updateScript(id, { status: 'used', postId: post.id })
  return post
}

