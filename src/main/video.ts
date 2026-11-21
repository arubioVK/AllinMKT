import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve, sep } from 'node:path'
import { app, BrowserWindow, nativeImage } from 'electron'
import { z } from 'zod'
import type { ContentContext, Script, ScriptScene, ScriptVideo, VideoClip, VisualPart } from '@shared/types'
import { getDb, getSettings, log } from './db'
import { structured, type AiImage } from './ai'
import { getContext, getScript, imageDataUrl, listContexts, partSlug, updateScript } from './content'
import type { JobContext, JobResult } from './jobs'
import { tr } from './i18n'

// Vídeo hecho por Opus con código: el modelo no genera imágenes, pero sí diseña cada escena
// en HTML + CSS con animaciones (@keyframes) e ilustraciones SVG. Nosotros cargamos esa
// composición en una ventana invisible, la congelamos en cada instante con la Web Animations
// API (así el resultado es exacto aunque el equipo vaya lento), capturamos los fotogramas
// y ffmpeg los codifica en un MP4 H.264 listo para TikTok, Reels y Shorts.

const FPS = 30
const MAX_SECONDS = 15 * 60

// Si los personajes tienen piezas (cabeza, bocas, ojos, brazos... dibujadas por una persona o
// por un generador de imágenes) y los escenarios tienen fondos, Opus no dibuja: monta cada
// personaje como un muñeco por capas y hace de director de animación (poses, expresiones,
// bocas al hablar, planos y cámara). El aspecto lo dan las imágenes, y es el mismo en todos
// los vídeos porque son siempre los mismos archivos.

// Se hace en dos fases para que no tarde: una petición corta fija el estilo común (paleta,
// tipografía, animaciones base y el personaje como <symbol> SVG) y después cada escena se
// anima en su propia petición, varias a la vez, reutilizando ese estilo.

const DesignSchema = z.object({
  background: z.string().describe('Color o degradado CSS del fondo de todo el vídeo'),
  css: z.string().describe('CSS común: variables de color en :root, clases de tipografía y de composición reutilizables y @keyframes genéricas con prefijo "k-" (k-pop, k-slide-up, k-float...)'),
  defs: z.string().describe('SVG con <defs> y <symbol id="..."> reutilizables: cada personaje SIN piezas (id "char-<nombre>"), logotipo e iconos. Cadena vacía si no hace falta'),
  rigs: z.string().describe('HTML de montaje de cada personaje CON piezas (un <div class="rig rig-<grupo>"> por personaje, con el <grupo> que aparece en la lista de piezas, con sus piezas en capas como <img src="asset:...">). Cadena vacía si ningún personaje tiene piezas'),
  guide: z.string().describe('Guía breve (máx. 150 palabras) para animar las escenas: qué clases y keyframes usar, ids de los símbolos, cómo poner cada muñeco en pose, cambiar su expresión y su boca, y cómo encuadrarlo')
})

const SceneSchema = z.object({
  css: z.string().describe('CSS propio de esta escena: todas las clases empiezan por .s{N}- y las @keyframes por s{N}-'),
  html: z.string().describe('HTML de la escena (sin <html>, <head> ni <body>), con SVG en línea y <svg><use href="#id"/></svg> para los símbolos')
})

type Design = z.infer<typeof DesignSchema>

// ---------- Piezas y fondos ----------

interface AssetGroup { ctx: ContentContext; slug: string; parts: VisualPart[] }
/** Personaje sin piezas pero con hoja de personaje: Opus la ve y dibuja copiándola. */
interface SheetRef { ctx: ContentContext; images: AiImage[] }
interface Assets {
  characters: AssetGroup[]
  sets: AssetGroup[]
  sheets: SheetRef[]
  /** "asset:<grupo>/<pieza>" → archivo. */
  files: Map<string, string>
}

const MAX_SETS = 12
const MAX_SHEETS_PER_CHARACTER = 2
// Por encima de ~1568 px el modelo reduce la imagen de todas formas: la mandamos ya reducida.
const MAX_EDGE = 1568
const MAX_IMAGE_BYTES = 4_500_000

/** Prepara una imagen para el modelo: reducida y en PNG (o JPEG si aun así pesa demasiado). */
function aiImage(file: string, label: string): AiImage | null {
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) {
    // nativeImage no lee WebP en todos los sistemas: la mandamos tal cual si no pesa demasiado.
    if (!/\.webp$/i.test(file) || statSync(file).size > MAX_IMAGE_BYTES) return null
    return { label, mediaType: 'image/webp', data: readFileSync(file).toString('base64') }
  }
  const { width, height } = img.getSize()
  const k = Math.min(1, MAX_EDGE / Math.max(width, height))
  const out = k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' }) : img
  const png = out.toPNG()
  if (png.length <= MAX_IMAGE_BYTES) return { label, mediaType: 'image/png', data: png.toString('base64') }
  return { label, mediaType: 'image/jpeg', data: out.toJPEG(90).toString('base64') }
}

/**
 * Prioridad del aspecto de cada personaje: 1) sus piezas (se usa el dibujo tal cual),
 * 2) su hoja de personaje (Opus la ve y la copia), 3) solo la descripción escrita.
 */
type Source = 'parts' | 'sheet' | 'text'
function sourceOf(c: ContentContext, a: Assets): Source {
  if (a.characters.some((g) => g.ctx.id === c.id)) return 'parts'
  if (a.sheets.some((r) => r.ctx.id === c.id)) return 'sheet'
  return 'text'
}

/** Piezas de los personajes del guion y fondos de los escenarios, con la referencia que usa la IA. */
function assetsFor(s: Script): Assets {
  const taken = new Set<string>()
  const files = new Map<string, string>()
  const group = (ctx: ContentContext): AssetGroup => {
    const root = partSlug(ctx.name) || ctx.kind
    let slug = root
    for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`
    taken.add(slug)
    for (const p of ctx.parts) files.set(`asset:${slug}/${p.name}`, p.file)
    return { ctx, slug, parts: ctx.parts }
  }
  const characters = s.characterIds.map(getContext).filter((c): c is ContentContext => !!c && c.parts.length > 0).map(group)
  const sets = listContexts().filter((c) => c.kind === 'scenery' && c.parts.length > 0).slice(0, MAX_SETS).map(group)
  const sheets = s.characterIds
    .map(getContext)
    .filter((c): c is ContentContext => !!c && !c.parts.length && c.images.length > 0)
    .map((c) => ({
      ctx: c,
      images: c.images.slice(0, MAX_SHEETS_PER_CHARACTER)
        .map((f, i, all) => aiImage(f, `Hoja de personaje de ${c.name}${all.length > 1 ? ` (${i + 1} de ${all.length})` : ''}. Es su aspecto exacto:`))
        .filter((x): x is AiImage => !!x)
    }))
    .filter((r) => r.images.length > 0)
  return { characters, sets, sheets, files }
}

function partLine(g: AssetGroup, p: VisualPart): string {
  const size = p.width && p.height ? ` · lienzo ${p.width}×${p.height}` : ''
  const box = p.box ? ` · dibujo en x ${p.box[0]}-${p.box[0] + p.box[2]}, y ${p.box[1]}-${p.box[1] + p.box[3]}` : ''
  return `- asset:${g.slug}/${p.name}${size}${box}${p.note.trim() ? ` · ${p.note.trim()}` : ''}`
}

/** Si todas las piezas comparten lienzo, apiladas en el mismo sitio ya quedan montadas. */
function sharedCanvas(parts: VisualPart[]): string {
  const [a] = parts
  const same = a.width > 0 && parts.every((p) => p.width === a.width && p.height === a.height)
  return same
    ? `todas las piezas comparten un lienzo de ${a.width}×${a.height}: apiladas con position:absolute; inset:0; width:100%; height:100% en un contenedor con esa proporción quedan montadas en su sitio`
    : 'las piezas tienen lienzos distintos: colócalas tú según su tamaño y dónde está el dibujo'
}

function assetsBlock(a: Assets): string {
  const chars = a.characters.map((g) => `## ${g.ctx.name} (rig-${g.slug})\nMontaje: ${sharedCanvas(g.parts)}.\n${g.parts.map((p) => partLine(g, p)).join('\n')}`)
  const sets = a.sets.map((g) => `## ${g.ctx.name}: ${g.ctx.content.trim().split('\n')[0] || '—'}\n${g.parts.map((p) => partLine(g, p)).join('\n')}`)
  return [
    chars.length ? `<piezas_de_personajes>\nEstos personajes NO se dibujan: se animan como muñecos con sus piezas.\n\n${chars.join('\n\n')}\n</piezas_de_personajes>` : '',
    sets.length ? `<fondos>\nDecorados ya dibujados (sin personajes). Úsalos como fondo de las escenas que pasen en ese lugar.\n\n${sets.join('\n\n')}\n</fondos>` : ''
  ].filter(Boolean).join('\n\n')
}

const hasAssets = (a: Assets): boolean => a.characters.length > 0 || a.sets.length > 0

// Píxel transparente para las referencias que ya no existen: mejor un hueco que el icono de imagen rota.
const EMPTY_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** Cambia cada "asset:<grupo>/<pieza>" por la imagen en data URL (la página no puede leer archivos). */
function inlineAssets(html: string, a: Assets): string {
  const cache = new Map<string, string>()
  return html.replace(/asset:[a-z0-9-]+\/[a-z0-9-]+/g, (ref) => {
    if (!cache.has(ref)) {
      const file = a.files.get(ref)
      const url = file ? imageDataUrl(file) : ''
      if (!url) log('warn', 'video', `Pieza no encontrada en el vídeo: ${ref}`)
      cache.set(ref, url || EMPTY_IMG)
    }
    return cache.get(ref)!
  })
}
interface SpecScene { durationSec: number; html: string }
/** Diseño completo del vídeo. Se guarda en spec.json para poder rehacer una escena con el mismo estilo. */
interface VideoSpec extends Design {
  scenes: SpecScene[]
}

function dims(s: Script): { w: number; h: number } {
  // Los vídeos largos van a YouTube en horizontal; todo lo demás, vertical 9:16.
  return s.format === 'video' ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 }
}

export function videosDir(): string {
  const dir = join(app.getPath('userData'), 'videos')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Ruta segura dentro de la carpeta de vídeos (para el protocolo allin-media): "<archivo>" o "<guion>/<clip>". */
export function videoFile(name: string): string | null {
  const dir = videosDir()
  const file = resolve(dir, name.replace(/^[\\/]+/, ''))
  return file.startsWith(dir + sep) && existsSync(file) && statSync(file).isFile() ? file : null
}

const resource = (name: string): string =>
  app.isPackaged ? join(process.resourcesPath, 'resources', name) : join(app.getAppPath(), 'resources', name)

// ---------- Prompts ----------

function canvas(s: Script) {
  const { w, h } = dims(s)
  const vertical = h > w
  return {
    w, h, vertical,
    head: vertical ? 96 : 84,
    body: vertical ? 56 : 44,
    safe: vertical
      ? 'deja libres de texto importante los 220 px superiores, los 420 px inferiores y 90 px a cada lado (ahí van los botones de TikTok, Reels y Shorts)'
      : 'deja un margen de 100 px en los bordes'
  }
}

const TECH = (s: Script, assets: boolean): string => {
  const c = canvas(s)
  return `Reglas técnicas (si no se cumplen, el vídeo sale mal):
- Lienzo fijo de ${c.w}×${c.h} px. Tu HTML se inserta dentro de un contenedor de ${c.w}×${c.h} px ya creado (clase .scene, position: absolute, overflow: hidden): no lo vuelvas a crear ni uses la clase .scene en tus elementos.
- Solo HTML, CSS y SVG en línea. Nada de JavaScript, <script>, atributos on*, <iframe>, <video>, <audio>, emojis ni recursos externos (todo lo externo se bloquea).${assets ? `
- Las únicas imágenes permitidas son las piezas y fondos de la lista, siempre con <img src="asset:<grupo>/<pieza>" alt=""> y la referencia copiada tal cual. No inventes referencias ni uses background-image.` : ''}
- Animación solo con @keyframes y animation, con animation-fill-mode: both. Nada de transition. El instante 0 es el inicio de la escena: encadena con animation-delay.
- Las animaciones dentro de un <symbol> no se pueden controlar: anima el <svg> o el elemento que envuelve al <use>, nunca el interior del símbolo.
- Tipografía: font-family: 'Inter', sans-serif (pesos 100-900). Titulares de ${c.head} px como mínimo y texto de ${c.body} px como mínimo.
- Zona segura: ${c.safe}.
- No hay voz: el texto en pantalla cuenta el mensaje, por frases cortas (máximo unas 12 palabras a la vez).
- Código compacto: sin comentarios ni CSS que no se use.`
}

const DESIGN_SYSTEM = (s: Script, a: Assets): string => `Eres directora de arte y motion designer. Defines el sistema visual de un vídeo ${canvas(s).vertical ? 'vertical 9:16' : 'horizontal 16:9'} para redes que se hará con HTML, CSS y SVG y se grabará fotograma a fotograma. Otra persona animará cada escena usando lo que definas, así que sé claro y reutilizable.

${TECH(s, hasAssets(a))}

Qué entregas:
- Paleta como variables CSS en :root (usa los colores de la marca si vienen en el contexto; si no, una paleta con mucho contraste) y el fondo general.
- Clases de tipografía (titular, texto, subtítulo, etiqueta, CTA) y de composición (centrado, tarjeta, banda de subtítulo...).
- 6-10 @keyframes genéricas con prefijo k- para entradas, énfasis y bucles sutiles.
- Cada personaje del guion SIN piezas como <symbol id="char-<nombre>"> en SVG plano, fiel a su hoja de personaje si se adjunta o, si no, a su descripción (pelo, ropa, colores, rasgos), con un viewBox adecuado. Si no hay personajes, iconos o un motivo gráfico propio.${a.sheets.length ? `
${SHEET_RULES}` : ''}${a.characters.length ? `
${RIG_RULES}` : ''}${a.sets.length ? `
- Los fondos ya están dibujados: define una clase .bg que los ajuste al lienzo (position:absolute; inset:0; width:100%; height:100%; object-fit:cover) y elige la paleta y la tipografía para que casen con ellos.` : ''}
- Una guía breve para quien anime las escenas.`

// La hoja es el aspecto exacto: el texto solo completa lo que la imagen no enseña.
const SHEET_RULES = `- Los personajes con hoja de personaje adjunta se dibujan COPIANDO la hoja, que es su aspecto exacto:
  · Mismas proporciones (tamaño de la cabeza respecto al cuerpo, altura, grosor de brazos y piernas) y misma silueta.
  · Mismos colores: tómalos de la imagen y escríbelos en hex como variables (--rick-pelo, --rick-bata...). No los cambies por los de la paleta.
  · Mismo peinado, ropa, accesorios y rasgos (forma de los ojos, nariz, boca, cejas), y mismo contorno (grosor y color de la línea).
  · Si la hoja muestra expresiones, crea sus variantes como símbolos aparte (bocas, ojos, cejas) para poder cambiarlas sin redibujar al personaje.
  · La descripción escrita solo completa lo que la hoja no enseña; si se contradicen, gana la hoja.`

// Cómo montar un muñeco por capas para que cada escena solo tenga que ponerlo en pose.
const RIG_RULES = `- Cada personaje CON piezas se monta en "rigs" como un muñeco por capas, sin dibujarlo:
  · Un <div class="rig rig-<grupo>"> con position:relative, la proporción de su lienzo (aspect-ratio) y un ancho por defecto; dentro, cada pieza es un <img src="asset:..." alt=""> con position:absolute.
  · Orden de capas de atrás hacia delante (brazo y pierna del fondo, cuerpo, cabeza, ojos, boca, brazo delantero) con z-index.
  · Cada parte que se mueve lleva su clase (.rig-<grupo>-cabeza, -brazo-d...) y su transform-origin en el punto de giro (cuello, hombro, codo), calculado con el rectángulo del dibujo y expresado en %.
  · Las piezas que se sustituyen (bocas, ojos, expresiones, manos) van todas montadas y solo una visible: las demás con opacity:0. Define clases para cambiarlas (.boca-on, .ojos-on...).
  · En el CSS común: @keyframes k-hablar (alternar bocas con steps), k-parpadear, k-respirar (scale 1 → 1.012 desde los pies) y k-balanceo (rotar unos grados la cabeza o el brazo).
  · El estilo gráfico lo dan las piezas: no las tapes, no les apliques filtros que cambien sus colores y no dibujes encima otra versión del personaje.`

const SCENE_SYSTEM = (s: Script, a: Assets): string => `Eres motion designer. Animas UNA escena de un vídeo para redes con HTML, CSS y SVG, usando el sistema visual que te dan (sus variables, clases, @keyframes k-* y símbolos SVG). No redefinas :root ni las clases comunes.

${TECH(s, hasAssets(a))}

Ritmo de vídeo corto: movimiento constante, entradas con escala, deslizamiento, máscara o rebote, jerarquía clara y una composición distinta en cada escena. Todo lo importante tiene que estar en pantalla antes de que acabe la escena.
Los personajes salen siempre con sus símbolos char-* (y sus variantes de expresión) o con su montaje de piezas: no los redibujes ni cambies sus colores, para que sean iguales en todas las escenas.${hasAssets(a) ? `
${DIRECTION}` : ''}`

// Con piezas y fondos, Opus no dibuja: dirige. Esto es lo que hace que parezca una serie animada.
const DIRECTION = `Dirección de animación (piezas y fondos):
- Si la escena pasa en un lugar con fondo, ponlo primero: <img class="bg" src="asset:..." alt="">. Mete fondo y personajes en un mismo contenedor de cámara y muévelo (zoom lento, paneo, acercamiento brusco en el remate): es lo que da sensación de plano.
- Copia el montaje del personaje desde "rigs" (mismas piezas y clases) y ponlo en pose: tamaño y posición en el plano, los pies sobre el suelo del fondo, y rotaciones de cabeza o brazos.
- Elige la expresión que pide el momento mostrando la pieza adecuada (ojos, boca, cejas) y cámbiala cuando cambie la emoción.
- Cuando un personaje dice su frase, su boca alterna entre las bocas cada 0,1-0,15 s (k-hablar o tus propias @keyframes con steps) solo mientras habla; el que escucha, reacciona. Su frase aparece como bocadillo o subtítulo.
- Siempre vivo: parpadeo cada 2-4 s, respiración sutil y algún gesto. Nada se queda congelado más de un segundo.
- Las piezas se escalan sin deformarlas (misma escala en X e Y) y nunca más allá de lo que aguantan sin pixelarse.`

const SOURCE_NOTE: Record<Source, string> = {
  parts: 'aspecto: sus piezas; se anima como muñeco y no se dibuja',
  sheet: 'aspecto: su hoja de personaje adjunta como imagen; manda sobre esta descripción',
  text: 'aspecto: solo esta descripción'
}

function contextBlock(s: Script, a: Assets): string {
  const ctx = [...s.contextIds, ...(s.styleId ? [s.styleId] : [])].map(getContext).filter((c) => !!c && ['brand', 'style'].includes(c.kind))
  const chars = s.characterIds.map(getContext).filter((c): c is ContentContext => !!c)
  return [
    ctx.length ? `<marca_y_estilo>\n${ctx.map((c) => `## ${c!.name}\n${c!.content.trim()}`).join('\n\n')}\n</marca_y_estilo>` : '',
    chars.length ? `<personajes>\n${chars.map((c) => `## ${c.name} (${SOURCE_NOTE[sourceOf(c, a)]})\n${c.content.trim()}`).join('\n\n')}\n</personajes>` : ''
  ].filter(Boolean).join('\n\n')
}

function sceneText(sc: ScriptScene, i: number): string {
  return `${i + 1}. [${sc.time}]\n   Se ve: ${sc.visual}\n   Voz: ${sc.voiceover}\n   Texto en pantalla: ${sc.onScreenText}`
}

/** Duración de cada escena a partir de sus tramos ("0-3 s"), ajustada a la duración total. */
function sceneDurations(s: Script): number[] {
  const total = Math.min(Math.max(s.durationSec || 30, 5), MAX_SECONDS)
  const raw = s.scenes.map((sc) => {
    const m = /(\d+(?:[.,]\d+)?)\s*[-–a]\s*(\d+(?:[.,]\d+)?)/.exec(sc.time)
    const d = m ? parseFloat(m[2].replace(',', '.')) - parseFloat(m[1].replace(',', '.')) : 0
    return d > 0 ? d : 0
  })
  const known = raw.reduce((a, b) => a + b, 0)
  if (!known) return s.scenes.map(() => total / s.scenes.length)
  const filled = raw.map((d) => d || known / raw.filter(Boolean).length)
  const sum = filled.reduce((a, b) => a + b, 0)
  return filled.map((d) => Math.max(1, Math.round((d * total) / sum * 10) / 10))
}

function designPrompt(s: Script, a: Assets): string {
  return `${contextBlock(s, a)}

${assetsBlock(a)}

<guion>
Título: ${s.title}
Gancho: ${s.hook}
Escenas:
${s.scenes.map(sceneText).join('\n')}
Llamada a la acción: ${s.cta}
Indicaciones visuales: ${s.visualPrompt}
</guion>

Define el sistema visual de este vídeo.`
}

function scenePrompt(s: Script, design: Design, a: Assets, i: number, dur: number): string {
  const n = i + 1
  const ids = [...design.defs.matchAll(/<symbol[^>]*id="([^"]+)"/g)].map((m) => m[1])
  const role = i === 0
    ? 'Es la PRIMERA escena: el gancho tiene que verse con fuerza desde el fotograma 0, sin fundido desde negro.'
    : i === s.scenes.length - 1
      ? `Es la ÚLTIMA escena: cierra con la llamada a la acción, grande y clara: "${s.cta}".`
      : ''
  return `<sistema_visual>
Guía: ${design.guide}
Símbolos disponibles: ${ids.join(', ') || 'ninguno'}
CSS común:
${design.css}${design.rigs ? `
Montaje de los personajes (rigs):
${design.rigs}` : ''}
</sistema_visual>

${assetsBlock(a)}

<video>
Título: ${s.title}
Todas las escenas (para que la tuya encaje con las demás):
${s.scenes.map((sc, j) => `${j + 1}. ${sc.onScreenText || sc.voiceover}`).join('\n')}
</video>

<tu_escena numero="${n}" duracion="${dur} s">
${sceneText(s.scenes[i], i)}
</tu_escena>

${role}
Anima la escena ${n}. Prefija tus clases con .s${n}- y tus @keyframes con s${n}-. Dura ${dur} s.`
}

/** Ejecuta las tareas con un máximo de peticiones a la vez. */
async function pool<T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await items[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Anima una escena. Con `redo` la rehace a partir de la versión anterior y de las indicaciones. */
async function animateScene(
  s: Script, design: Design, a: Assets, i: number, dur: number, onChars: (chars: number) => void, redo?: { prev: string; note: string }
): Promise<SpecScene> {
  const r = await structured({
    kind: 'video', schema: SceneSchema, system: SCENE_SYSTEM(s, a), prompt: scenePrompt(s, design, a, i, dur) + (redo ? redoBlock(redo.prev, redo.note) : ''),
    effort: 'medium', timeoutMs: 20 * 60_000, onProgress: (p) => onChars(p.chars ?? 0)
  })
  return { durationSec: dur, html: `<style>${r.css}</style>${r.html}` }
}

function redoBlock(prev: string, note: string): string {
  const ask = note.trim()
    ? `Rehaz la escena con estos cambios: ${note.trim()}\nMantén lo que no se pide cambiar.`
    : 'La versión anterior no convenció: haz una composición y una animación distintas, con más fuerza.'
  return `\n\n<version_anterior>\n${prev}\n</version_anterior>\n\n${ask}`
}

async function designVideo(s: Script, a: Assets, ctx: JobContext): Promise<VideoSpec> {
  const model = modelName()
  const first = a.characters.length
    ? tr('{model} monta los personajes con sus piezas', { model })
    : a.sheets.length
      ? tr('{model} dibuja los personajes a partir de su hoja', { model })
      : tr('{model} diseña el estilo y el personaje', { model })
  const think = (chars?: number, stage = first): void =>
    ctx.progress({ stage: chars ? stage : tr('{stage} (pensando)', { stage }), chars: chars ?? 0 })
  think()
  const design = await structured({
    kind: 'video', schema: DesignSchema, system: DESIGN_SYSTEM(s, a), prompt: designPrompt(s, a),
    images: a.sheets.flatMap((r) => r.images),
    // Copiar bien una hoja de personaje pide más razonamiento que dibujar a partir de un texto.
    effort: a.sheets.length ? 'high' : 'medium',
    timeoutMs: 20 * 60_000, onProgress: (p) => !p.done && think(p.chars)
  })

  const durations = sceneDurations(s)
  const chars = durations.map(() => 0)
  let done = 0
  const report = (): void => {
    const total = chars.reduce((a, b) => a + b, 0)
    ctx.progress({ stage: tr('{model} anima las escenas ({done} de {total} listas)', { model, done, total: durations.length }), chars: total })
  }
  report()
  const scenes = await pool(
    durations.map((dur, i) => async () => {
      const scene = await animateScene(s, design, a, i, dur, (c) => {
        if (c) chars[i] = c
        report()
      })
      done++
      report()
      return scene
    }),
    4
  )
  return { ...design, scenes }
}

// ---------- Composición ----------

function fontFace(): string {
  try {
    const b64 = readFileSync(resource('fonts/Inter.woff2')).toString('base64')
    return `@font-face{font-family:'Inter';src:url(data:font/woff2;base64,${b64}) format('woff2');font-weight:100 900;font-style:normal}`
  } catch {
    return ''
  }
}

/** Página de una sola escena, con su instante 0 al principio. */
function buildHtml(spec: VideoSpec, sc: SpecScene, a: Assets, w: number, h: number): { html: string; seconds: number } {
  const d = Math.min(Math.max(sc.durationSec || 3, 0.5), 60)
  // Sin JavaScript ni red: la página solo puede pintar. El control del tiempo lo inyectamos
  // desde el proceso principal con executeJavaScript, que no está sujeto a esta CSP.
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${fontFace()}
*{box-sizing:border-box}html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#000}
body{font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}
#stage{position:relative;width:${w}px;height:${h}px;overflow:hidden;background:${spec.background || '#000'}}
section.scene{position:absolute;inset:0;width:${w}px;height:${h}px;overflow:hidden}
img{display:block;max-width:none;user-select:none}
</style><style>${spec.css}</style></head><body>
<div style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">${spec.defs || ''}</div>
<div id="stage"><section class="scene">${sc.html}</section></div></body></html>`
  return { html: inlineAssets(html, a), seconds: d }
}

const SEEK_FN = `window.__seek = (t) => {
  for (const a of document.getAnimations()) {
    a.pause()
    a.currentTime = t * 1000
  }
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))
}
for (const a of document.getAnimations()) a.pause()
// Antes del primer fotograma tienen que estar listas la fuente y todas las piezas.
Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => true)`

// ---------- ffmpeg ----------

/** ffmpeg incluido con la app; si no está, el del sistema. */
function ffmpegPath(): string {
  try {
    const req = createRequire(__filename)
    const p = (req('ffmpeg-static') as string | null) ?? ''
    // Dentro del instalador el binario está desempaquetado fuera del .asar.
    const real = p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    if (real && existsSync(real)) return real
  } catch {
    // sin ffmpeg-static
  }
  return 'ffmpeg'
}

function spawnFfmpeg(args: string[]) {
  const child = spawn(ffmpegPath(), ['-y', '-loglevel', 'error', ...args], { windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  const done = new Promise<void>((res, rej) => {
    child.on('error', (e) => rej(new Error(tr('No se encuentra ffmpeg para codificar el vídeo ({msg}). Reinstala la app o instala ffmpeg.', { msg: e.message }))))
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`${tr('ffmpeg falló (código {code}):', { code: String(code) })} ${stderr.trim().slice(-300)}`))))
  })
  return { child, done, stderr: () => stderr }
}

/** Codifica los fotogramas de una escena. Los clips van sin audio: la pista se añade al unirlos. */
function startEncoder(out: string, srcW: number, srcH: number, w: number, h: number) {
  // Todos los clips salen con los mismos parámetros para poder unirlos sin recodificar.
  const { child, done, stderr } = spawnFfmpeg([
    '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${srcW}x${srcH}`, '-r', String(FPS), '-i', '-',
    '-vf', `scale=${w}:${h}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(FPS),
    '-movflags', '+faststart',
    out
  ])
  const write = (buf: Buffer): Promise<void> =>
    new Promise((res, rej) => {
      if (child.stdin.destroyed) return rej(new Error(`${tr('ffmpeg se cerró antes de tiempo:')} ${stderr().trim().slice(-300)}`))
      child.stdin.write(buf, (err) => (err ? rej(err) : res()))
    })
  return { write, end: () => child.stdin.end(), done, kill: () => child.kill() }
}

/** Une los clips (sin recodificar el vídeo) y añade una pista de audio en silencio. */
async function joinClips(dir: string, clips: VideoClip[], out: string): Promise<void> {
  const list = join(dir, 'clips.txt')
  // Rutas relativas a la lista: así no hay que escapar las rutas de Windows.
  writeFileSync(list, clips.map((c) => `file '${basename(c.path).replace(/'/g, "'\\''")}'`).join('\n'))
  await spawnFfmpeg([
    '-f', 'concat', '-safe', '0', '-i', list,
    // Pista de audio en silencio: algunas redes rechazan o tratan peor los vídeos sin audio.
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest',
    '-movflags', '+faststart',
    out
  ]).done
}

// ---------- Render ----------

/** Graba una escena en su propio MP4. Devuelve los segundos grabados. */
async function renderClip(spec: VideoSpec, a: Assets, i: number, s: Script, out: string, onFrame: (frame: number, frames: number) => void): Promise<number> {
  const { w, h } = dims(s)
  const { html, seconds } = buildHtml(spec, spec.scenes[i], a, w, h)
  // Guardamos la composición junto al clip: sirve para revisar qué diseñó Opus.
  const page = join(sceneDir(s.id), `scene-${i + 1}.html`)
  writeFileSync(page, html)

  const win = new BrowserWindow({
    show: false, width: w, height: h, useContentSize: true, frame: false, enableLargerThanScreen: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  // En Linux la ventana nace recortada al tamaño de la pantalla (1080 px de alto en un monitor
  // Full HD); redimensionarla después sí da el lienzo completo.
  win.setContentSize(w, h)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  let enc: ReturnType<typeof startEncoder> | null = null
  try {
    await win.loadFile(page)
    await win.webContents.executeJavaScript(SEEK_FN)
    const frames = Math.max(1, Math.round(seconds * FPS))
    for (let f = 0; f < frames; f++) {
      await win.webContents.executeJavaScript(`__seek(${(f / FPS).toFixed(4)})`)
      const img = await win.webContents.capturePage()
      const size = img.getSize()
      if (!enc) enc = startEncoder(out, size.width, size.height, w, h)
      await enc.write(img.toBitmap())
      if (f % 5 === 0) onFrame(f + 1, frames)
    }
    enc?.end()
    await enc?.done
    return frames / FPS
  } catch (e) {
    enc?.kill()
    throw e
  } finally {
    win.destroy()
  }
}

// ---------- Archivos de cada vídeo ----------

/** Carpeta con los clips de cada escena y el diseño (spec.json) de un guion. */
function sceneDir(id: string): string {
  const dir = join(videosDir(), basename(id))
  mkdirSync(dir, { recursive: true })
  return dir
}

const specFile = (id: string): string => join(sceneDir(id), 'spec.json')

function loadSpec(id: string): VideoSpec | null {
  try {
    return JSON.parse(readFileSync(specFile(id), 'utf8')) as VideoSpec
  } catch {
    return null
  }
}

/** Borra los clips y el diseño de un guion. El MP4 final se queda: puede estar en una publicación. */
export function removeSceneFiles(id: string): void {
  const dir = join(videosDir(), basename(id))
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/** Une los clips en el MP4 final, lo guarda en el guion y limpia lo que ya no se usa. */
async function finish(s: Script, spec: VideoSpec, clips: VideoClip[], ctx: JobContext): Promise<ScriptVideo> {
  ctx.progress({ stage: tr('Uniendo las escenas'), chars: 0 })
  const dir = sceneDir(s.id)
  const file = join(videosDir(), `${s.id}-${Date.now()}.mp4`)
  await joinClips(dir, clips, file)
  writeFileSync(specFile(s.id), JSON.stringify(spec))

  // Sustituimos el vídeo anterior de este guion y los clips que ya no forman parte de él.
  const prev = s.video?.path
  if (prev && prev !== file && videoFile(prev)) rmSync(prev, { force: true })
  const keep = new Set(clips.map((c) => basename(c.path)))
  for (const f of readdirSync(dir)) if (f.endsWith('.mp4') && !keep.has(f)) rmSync(join(dir, f), { force: true })

  const { w, h } = dims(s)
  const seconds = clips.reduce((a, c) => a + c.durationSec, 0)
  const video: ScriptVideo = {
    path: file, durationSec: Math.round(seconds), width: w, height: h, scenes: clips.length, clips,
    sizeBytes: statSync(file).size, createdAt: new Date().toISOString()
  }
  updateScript(s.id, { video })
  // Si ya tiene publicación, el vídeo nuevo pasa a ser su archivo.
  if (s.postId) getDb().prepare('UPDATE posts SET media_path = ?, media_public_url = \'\' WHERE id = ?').run(file, s.postId)
  return video
}

const clipName = (dir: string, i: number): string => join(dir, `scene-${i + 1}-${Date.now()}.mp4`)

// ---------- Tareas ----------

export async function generateVideo(scriptId: string, ctx: JobContext): Promise<JobResult> {
  const s = getScript(scriptId)
  if (!s) throw new Error(tr('Guion no encontrado'))
  if (!s.scenes.length) throw new Error(tr('El guion no tiene escenas. Añade al menos una antes de generar el vídeo.'))

  const assets = assetsFor(s)
  const spec = await designVideo(s, assets, ctx)
  const dir = sceneDir(s.id)
  const clips: VideoClip[] = []
  for (let i = 0; i < spec.scenes.length; i++) {
    const out = clipName(dir, i)
    const seconds = await renderClip(spec, assets, i, s, out, (f, n) =>
      ctx.progress({ stage: tr('Grabando la escena {i} de {n} (fotograma {f} de {frames})', { i: i + 1, n: spec.scenes.length, f, frames: n }), chars: 0 }))
    clips.push({ path: out, durationSec: seconds })
  }
  const video = await finish(s, spec, clips, ctx)
  const looks = s.characterIds.map(getContext).filter((c): c is ContentContext => !!c)
    .map((c) => `${c.name}: ${{ parts: 'piezas', sheet: 'hoja de personaje', text: 'descripción' }[sourceOf(c, assets)]}`)
  const pieces = assets.sets.length ? ` · ${assets.sets.length} escenarios con fondo` : ''
  log('info', 'video', `Vídeo de "${s.title}": ${clips.length} escenas, ${video.durationSec} s${looks.length ? ` · aspecto ${looks.join(', ')}` : ''}${pieces}`)
  return { resultIds: [s.id], summary: s.title }
}

/** Rehace una sola escena: Opus la vuelve a animar con el mismo estilo, se graba su clip y se une de nuevo. */
export async function regenerateScene(scriptId: string, index: number, note: string, ctx: JobContext): Promise<JobResult> {
  const s = getScript(scriptId)
  if (!s) throw new Error(tr('Guion no encontrado'))
  const spec = loadSpec(s.id)
  const clips = s.video?.clips ? [...s.video.clips] : []
  if (!spec || clips.length !== spec.scenes.length || clips.some((c) => !existsSync(c.path))) {
    throw new Error(tr('Este vídeo se hizo antes de poder rehacer escenas sueltas. Vuelve a generarlo entero una vez.'))
  }
  if (spec.scenes.length !== s.scenes.length) throw new Error(tr('El guion ya no tiene las mismas escenas que el vídeo. Vuelve a generar el vídeo entero.'))
  if (index < 0 || index >= spec.scenes.length) throw new Error(tr('Esa escena no existe'))

  const n = index + 1
  const stage = tr('{model} rehace la escena {n}', { model: modelName(), n })
  ctx.progress({ stage: tr('{stage} (pensando)', { stage }), chars: 0 })
  // Las piezas se leen de nuevo: si has cambiado una boca o un fondo, la escena rehecha ya la usa.
  const assets = assetsFor(s)
  const design = { ...spec, rigs: spec.rigs ?? '' }
  const scene = await animateScene(s, design, assets, index, sceneDurations(s)[index], (chars) => chars && ctx.progress({ stage, chars }), { prev: spec.scenes[index].html, note })
  const next: VideoSpec = { ...spec, scenes: spec.scenes.map((sc, j) => (j === index ? scene : sc)) }

  const out = clipName(sceneDir(s.id), index)
  const seconds = await renderClip(next, assets, index, s, out, (f, frames) =>
    ctx.progress({ stage: tr('Grabando la escena {n} (fotograma {f} de {frames})', { n, f, frames }), chars: 0 }))
  clips[index] = { path: out, durationSec: seconds }
  await finish(s, next, clips, ctx)
  log('info', 'video', `Vídeo de "${s.title}": escena ${n} rehecha`)
  return { resultIds: [s.id], summary: tr('{title} · escena {n}', { title: s.title, n }) }
}

function modelName(): string {
  const m = getSettings().anthropicModel || 'claude-opus-5-5'
  const match = /claude-(\w+)-(\d+)-(\d+)/.exec(m)
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}` : 'Claude'
}
