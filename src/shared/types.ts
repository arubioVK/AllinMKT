// Tipos y metadatos compartidos entre el proceso principal y la interfaz.
import type { Lang } from './i18n'

export const PLATFORM_IDS = ['tiktok', 'instagram', 'youtube', 'linkedin', 'x', 'blog'] as const
export type Platform = (typeof PLATFORM_IDS)[number]

export const FORMATS = ['video', 'short', 'image', 'carousel', 'text', 'thread', 'article'] as const
export type Format = (typeof FORMATS)[number]

export const FORMAT_LABEL: Record<Format, string> = {
  video: 'Vídeo',
  short: 'Vídeo corto',
  image: 'Imagen',
  carousel: 'Carrusel',
  text: 'Texto',
  thread: 'Hilo',
  article: 'Artículo'
}

export interface PlatformMeta {
  id: Platform
  name: string
  /** Color de identidad (pálido en la interfaz, nunca en gráficas de datos). */
  color: string
  formats: Format[]
  /** ¿Los enlaces del texto son clicables? Si no, se usa "enlace en la bio". */
  linkClickable: boolean
  maxChars: number
  /** Qué puede hacer la integración hoy. */
  canPublish: boolean
  canFetchMetrics: boolean
}

export const PLATFORMS: Record<Platform, PlatformMeta> = {
  tiktok: { id: 'tiktok', name: 'TikTok', color: '#2ee6d6', formats: ['short', 'video'], linkClickable: false, maxChars: 2200, canPublish: true, canFetchMetrics: true },
  instagram: { id: 'instagram', name: 'Instagram', color: '#ff5ca8', formats: ['short', 'image', 'video'], linkClickable: false, maxChars: 2200, canPublish: true, canFetchMetrics: true },
  youtube: { id: 'youtube', name: 'YouTube', color: '#ff5a4f', formats: ['video', 'short'], linkClickable: true, maxChars: 5000, canPublish: true, canFetchMetrics: true },
  linkedin: { id: 'linkedin', name: 'LinkedIn', color: '#5b8cff', formats: ['text', 'image', 'article'], linkClickable: true, maxChars: 3000, canPublish: true, canFetchMetrics: false },
  x: { id: 'x', name: 'X', color: '#d9d9d9', formats: ['text', 'thread', 'image'], linkClickable: true, maxChars: 280, canPublish: true, canFetchMetrics: true },
  blog: { id: 'blog', name: 'Blog', color: '#c6f24e', formats: ['article'], linkClickable: true, maxChars: 100000, canPublish: true, canFetchMetrics: true }
}

export type PostStatus = 'idea' | 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed'
export type TargetStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'skipped'

export const POST_STATUS_LABEL: Record<PostStatus, string> = {
  idea: 'Idea',
  draft: 'Borrador',
  scheduled: 'Programada',
  publishing: 'Publicando',
  published: 'Publicada',
  partial: 'Publicada en parte',
  failed: 'Falló'
}

export interface PostTarget {
  id: string
  postId: string
  platform: Platform
  /** Texto específico para esta plataforma (si está vacío se usa el cuerpo del post). */
  caption: string
  /** Título específico (YouTube, blog). */
  title: string
  status: TargetStatus
  remoteId: string | null
  remoteUrl: string | null
  error: string | null
  publishedAt: string | null
}

export interface Post {
  id: string
  title: string
  body: string
  format: Format
  pillar: string
  hook: string
  cta: string
  /** Ruta de la web a la que lleva el post, p. ej. /blog/mi-articulo */
  linkPath: string
  utmCampaign: string
  mediaPath: string
  mediaPublicUrl: string
  /** Fecha y hora local en ISO (con zona horaria). */
  scheduledAt: string
  status: PostStatus
  source: 'ai' | 'manual' | 'demo'
  rationale: string
  notes: string
  createdAt: string
  updatedAt: string
  targets: PostTarget[]
}

export type PostInput = Partial<Omit<Post, 'id' | 'targets' | 'createdAt' | 'updatedAt'>> & {
  platforms?: Platform[]
  targetOverrides?: Partial<Record<Platform, { caption?: string; title?: string }>>
}

export interface MetricSnapshot {
  targetId: string
  date: string
  views: number
  likes: number
  comments: number
  shares: number
  saves: number
}

/** Canal de tráfico normalizado (de dónde llegan las visitas a la web). */
export type Channel = Platform | 'google' | 'direct' | 'other'
export const CHANNEL_LABEL: Record<Channel, string> = {
  tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', linkedin: 'LinkedIn', x: 'X', blog: 'Blog',
  google: 'Buscadores', direct: 'Directo', other: 'Otros'
}

export interface Account {
  platform: Platform | 'ga4' | 'gcal' | 'anthropic' | 'storage'
  connected: boolean
  displayName: string
  connectedAt: string | null
  detail: string
}

export interface PlannerBrief {
  businessName: string
  website: string
  offer: string
  audience: string
  goal: string
  tone: string
  language: string
  pillars: string
  startDate: string
  weeks: number
  frequency: Partial<Record<Platform, number>>
  extra: string
  /** Diagnóstico SEO de la web hecho por la IA al autorrellenar (palabras clave, contenido existente, huecos). */
  siteNotes?: string
  /** URLs que ya existen en la web (del sitemap), para no repetir temas ni canibalizar palabras clave. */
  existingUrls?: string[]
}

export interface CadenceOption {
  name: string
  description: string
  hoursPerWeek: number
  frequency: Record<Platform, number>
}

export interface KeywordIdea {
  keyword: string
  intent: string
  articleIdea: string
}

export interface SiteAnalysis {
  brief: Pick<PlannerBrief, 'businessName' | 'website' | 'offer' | 'audience' | 'goal' | 'tone' | 'language' | 'pillars' | 'siteNotes' | 'existingUrls'>
  keywordIdeas: KeywordIdea[]
  cadences: CadenceOption[]
  pagesRead: number
}

export interface BestTime {
  platform: Platform
  times: string
  reason: string
}

export interface PlannedPost {
  date: string
  time: string
  platforms: Platform[]
  format: Format
  pillar: string
  title: string
  hook: string
  body: string
  cta: string
  linkPath: string
  rationale: string
  /** Palabra clave principal (artículos, vídeos de YouTube y SEO social). */
  keyword: string
}

export interface Plan {
  id: string
  createdAt: string
  brief: PlannerBrief
  strategy: string
  pillars: { name: string; description: string }[]
  bestTimes: BestTime[]
  posts: PlannedPost[]
}

export interface Variant {
  platform: Platform
  title: string
  caption: string
}

export interface Settings {
  website: string
  /** Idioma de la interfaz. */
  language: Lang
  /** 'claude-code': usa tu suscripción a través de la CLI de Claude Code. 'api': API key de Anthropic. */
  aiProvider: 'claude-code' | 'api'
  claudePath: string
  anthropicModel: string
  timezone: string
  autostart: boolean
  closeToTray: boolean
  syncHours: number
  oauthPort: number
  overdueGraceHours: number
  tiktokPrivacy: string
  youtubePrivacy: 'public' | 'unlisted' | 'private'
  igApiVersion: string
  linkedinVersion: string
  blogMode: 'wordpress' | 'markdown'
  wordpressUrl: string
  wordpressUser: string
  markdownFolder: string
  ga4PropertyId: string
  storageEndpoint: string
  storageRegion: string
  storageBucket: string
  storagePublicBaseUrl: string
  plannerBrief: PlannerBrief | null
  plannerAnalysis: SiteAnalysis | null
}

/** Campos de credenciales que se guardan cifrados con el llavero del sistema. */
export const SECRET_FIELDS = [
  'anthropicApiKey',
  'tiktokClientKey', 'tiktokClientSecret',
  'instagramAccessToken',
  'youtubeClientId', 'youtubeClientSecret',
  'linkedinClientId', 'linkedinClientSecret',
  'xClientId', 'xClientSecret',
  'wordpressAppPassword',
  'ga4ServiceAccountJson',
  'storageAccessKeyId', 'storageSecretAccessKey'
] as const
export type SecretField = (typeof SECRET_FIELDS)[number]

export interface LogEntry {
  id: number
  ts: string
  level: 'info' | 'warn' | 'error'
  scope: string
  message: string
}

export interface DashboardData {
  range: { from: string; to: string; prevFrom: string; prevTo: string }
  daily: { date: string; sessions: number; socialSessions: number; views: number; published: { postId: string; title: string; platforms: Platform[] }[] }[]
  totals: { sessions: number; socialSessions: number; views: number; published: number }
  prevTotals: { sessions: number; socialSessions: number; views: number; published: number }
  byPlatform: { platform: Platform; posts: number; views: number; engagement: number; sessions: number }[]
  byChannel: { channel: Channel; sessions: number }[]
  upcoming: Post[]
  hasTraffic: boolean
  hasMetrics: boolean
}

export interface PostPerformance {
  postId: string
  targetId: string
  title: string
  platform: Platform
  publishedAt: string
  remoteUrl: string | null
  views: number
  likes: number
  comments: number
  shares: number
  saves: number
  sessions: number
}

export interface AnalyticsData {
  daily: { date: string; views: Record<Platform, number>; sessions: Record<Channel, number> }[]
  posts: PostPerformance[]
}

export type JobKind = 'script' | 'video'

/** Tarea en segundo plano (guiones, vídeos). Vive en el proceso principal mientras la app está abierta. */
export interface Job {
  id: string
  kind: JobKind
  label: string
  status: 'running' | 'done' | 'error'
  /** Fase actual en texto corto, p. ej. "Revisando lo ya hecho". */
  stage: string
  chars: number
  startedAt: string
  finishedAt: string | null
  error: string
  resultIds: string[]
  summary: string
  /** Elemento al que se refiere la tarea (p. ej. el guion del que se genera el vídeo). */
  refId: string | null
}

export type AiProgress = { kind: 'plan' | 'variants' | 'article' | 'site' | 'script' | 'video'; chars: number; posts?: number; done?: boolean; stage?: string }

export const DEFAULT_CADENCES: CadenceOption[] = [
  { name: 'Esencial', description: 'Lo mínimo para mantener presencia y publicar un artículo SEO a la semana.', hoursPerWeek: 4, frequency: { blog: 1, tiktok: 2, instagram: 2, youtube: 0, linkedin: 1, x: 0 } },
  { name: 'Crecimiento', description: 'Dos artículos por semana y cada uno repartido en vídeo corto, LinkedIn y X.', hoursPerWeek: 8, frequency: { blog: 2, tiktok: 3, instagram: 3, youtube: 1, linkedin: 2, x: 3 } },
  { name: 'Máximo impacto', description: 'Ritmo de crecimiento agresivo: clúster SEO completo y vídeo casi diario.', hoursPerWeek: 15, frequency: { blog: 3, tiktok: 5, instagram: 5, youtube: 2, linkedin: 3, x: 5 } }
]


// ---------- Generación de contenido: contextos, series y guiones ----------

/** Piezas reutilizables con las que se compone el prompt de un guion. */
export const CONTEXT_KINDS = ['brand', 'audience', 'character', 'scenery', 'style', 'template', 'rule'] as const
export type ContextKind = (typeof CONTEXT_KINDS)[number]

export const CONTEXT_KIND_META: Record<ContextKind, { label: string; singular: string; help: string; placeholder: string }> = {
  brand: {
    label: 'Marca', singular: 'marca',
    help: 'Quién eres, qué vendes y cómo hablas. Se incluye en todos los guiones que la seleccionen.',
    placeholder: 'Negocio, qué ofrece, qué le diferencia, tono de voz, palabras que usa y que nunca usa...'
  },
  audience: {
    label: 'Público', singular: 'público',
    help: 'A quién le hablas: su situación, sus problemas, cómo busca y qué le frena.',
    placeholder: 'Quién es, qué problema tiene, qué busca en TikTok o Google, objeciones habituales...'
  },
  character: {
    label: 'Personajes', singular: 'personaje',
    help: 'Personajes que aparecen en los vídeos. Su descripción se copia tal cual en cada guion para que no cambien de un día a otro.',
    placeholder: 'Nombre, edad aparente, aspecto físico, ropa habitual, personalidad, forma de hablar, muletillas, lo que nunca haría...'
  },
  scenery: {
    label: 'Escenarios', singular: 'escenario',
    help: 'Lugares donde pasan los vídeos. Sube sus fondos ya dibujados (sin personajes) y la IA los usa como decorado de cada escena.',
    placeholder: 'Qué lugar es, qué se ve, dónde queda el suelo y qué zona queda libre para colocar a los personajes...'
  },
  style: {
    label: 'Estilos', singular: 'estilo',
    help: 'Cómo se cuenta y cómo se ve: ritmo, planos, música, edición. Elige uno distinto en cada guion para variar.',
    placeholder: 'Formato narrativo, tipo de planos, ritmo de cortes, textos en pantalla, música, referencias...'
  },
  template: {
    label: 'Plantillas', singular: 'plantilla',
    help: 'El encargo: qué tipo de pieza se genera, su duración y su estructura.',
    placeholder: 'Estructura que debe seguir el guion: gancho en los primeros 2 s, desarrollo, giro, llamada a la acción...'
  },
  rule: {
    label: 'Reglas', singular: 'regla',
    help: 'Instrucciones que se aplican siempre que estén activas: lo que hay que hacer o evitar.',
    placeholder: 'Por ejemplo: no mencionar precios, citar siempre la fuente, no usar anglicismos...'
  }
}

export interface ContentContext {
  id: string
  kind: ContextKind
  name: string
  content: string
  /** Solo plantillas: formato de la pieza y duración objetivo en segundos (0 = sin duración). */
  format: Format | null
  durationSec: number
  /** Se preselecciona en el generador (marca, público y reglas). */
  isDefault: boolean
  /** Solo personajes: imágenes de referencia (hoja de personaje), rutas dentro de userData/references. */
  images: string[]
  /** Personajes: piezas para animar (cabeza, bocas, brazos...). Escenarios: fondos. */
  parts: VisualPart[]
  createdAt: string
  updatedAt: string
}

/**
 * Imagen que el vídeo usa tal cual: una pieza del muñeco de un personaje o un fondo.
 * La IA no la ve; trabaja con su nombre, su nota y dónde está dibujada dentro del lienzo.
 */
export interface VisualPart {
  /** Identificador corto (minúsculas, números y guiones): la IA lo usa para referirse a la pieza. */
  name: string
  /** Ruta dentro de userData/references/<contexto>/parts. */
  file: string
  /** Qué es y cómo se usa: "boca abierta, para cuando habla", "brazo derecho, pivota en el hombro"... */
  note: string
  /** Tamaño del lienzo de la imagen en píxeles (0 si no se pudo leer). */
  width: number
  height: number
  /** Zona con dibujo dentro del lienzo [x, y, ancho, alto] (solo PNG con transparencia). */
  box: [number, number, number, number] | null
}

export type ContentContextInput = Partial<Omit<ContentContext, 'id' | 'createdAt' | 'updatedAt' | 'images' | 'parts'>> & { kind?: ContextKind }

export interface ContentSeries {
  id: string
  name: string
  /** Premisa y arco de la historia: de qué va, hacia dónde evoluciona. */
  premise: string
  characterIds: string[]
  styleId: string | null
  templateId: string | null
  contextIds: string[]
  platforms: Platform[]
  notes: string
  createdAt: string
  updatedAt: string
  episodes: number
}

export type ContentSeriesInput = Partial<Omit<ContentSeries, 'id' | 'createdAt' | 'updatedAt' | 'episodes'>>

export interface ScriptScene {
  /** Tramo de tiempo, p. ej. "0-3 s". */
  time: string
  visual: string
  voiceover: string
  onScreenText: string
}

export type ScriptStatus = 'draft' | 'approved' | 'used' | 'discarded'
export const SCRIPT_STATUS_LABEL: Record<ScriptStatus, string> = {
  draft: 'Borrador',
  approved: 'Aprobado',
  used: 'Usado',
  discarded: 'Descartado'
}

export interface Script {
  id: string
  title: string
  hook: string
  /** Resumen de 1-2 frases: es la memoria que se usa para no repetir y para continuar una serie. */
  summary: string
  angle: string
  keyword: string
  format: Format
  durationSec: number
  scenes: ScriptScene[]
  /** Prompt para herramientas de vídeo o imagen con IA, con el personaje descrito tal cual. */
  visualPrompt: string
  cta: string
  platforms: Platform[]
  /** Descripción y título propios de cada red: el mismo vídeo, distinto texto. */
  captions: Partial<Record<Platform, { title: string; caption: string }>>
  templateId: string | null
  contextIds: string[]
  characterIds: string[]
  styleId: string | null
  seriesId: string | null
  episode: number | null
  topic: string
  status: ScriptStatus
  postId: string | null
  /** Guion anterior más parecido (si se parece demasiado). */
  similarTo: { id: string; title: string; score: number } | null
  notes: string
  /** Vídeo animado generado por la IA a partir del guion. */
  video?: ScriptVideo | null
  createdAt: string
  updatedAt: string
}

export interface ScriptVideo {
  /** Ruta local del MP4 (carpeta videos del directorio de datos). */
  path: string
  durationSec: number
  width: number
  height: number
  scenes: number
  /** Clip de cada escena (carpeta videos/<guion>/), en orden. Permite rehacer una escena suelta. */
  clips?: VideoClip[]
  sizeBytes: number
  createdAt: string
}

export interface VideoClip {
  path: string
  durationSec: number
}

export interface ScriptRequest {
  templateId: string | null
  contextIds: string[]
  characterIds: string[]
  styleId: string | null
  seriesId: string | null
  topic: string
  platforms: Platform[]
  count: number
}

export interface PromptPreview {
  system: string
  prompt: string
}
