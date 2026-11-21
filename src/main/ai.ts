import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { AiProgress, Plan, PlannerBrief, Platform, SiteAnalysis, Variant } from '@shared/types'
import { FORMATS, PLATFORM_IDS, PLATFORMS } from '@shared/types'
import { getSecret } from './secrets'
import { getPost, getSettings, savePlan, upsertPost, log } from './db'
import { performanceSummary } from './stats'
import { runClaudeCode } from './claudecode'
import { readSite, snapshotToPrompt } from './site'
import { tr } from './i18n'

// Generación con Claude: plan de contenidos, textos por plataforma y artículos del blog.
// Usamos salidas estructuradas (esquemas Zod) para que la respuesta se pueda guardar tal cual,
// streaming para no chocar con timeouts en respuestas largas, y el fallback del servidor
// para que una negativa del modelo principal se reintente con otro modelo automáticamente.

type Progress = (p: AiProgress) => void

function client(): Anthropic {
  const apiKey = getSecret('anthropicApiKey') || process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error(tr('Añade tu API key de Anthropic en Conexiones para usar la IA'))
  return new Anthropic({ apiKey })
}

function friendly(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) return new Error(tr('La API key de Anthropic no es válida'))
  if (err instanceof Anthropic.PermissionDeniedError) return new Error(tr('La API key no tiene permiso para este modelo'))
  if (err instanceof Anthropic.RateLimitError) return new Error(tr('Límite de uso de la API alcanzado. Espera un minuto y vuelve a intentarlo'))
  if (err instanceof Anthropic.BadRequestError) return new Error(`Petición rechazada por la API: ${err.message}`)
  if (err instanceof Anthropic.APIConnectionError) return new Error(tr('No hay conexión con la API de Anthropic'))
  if (err instanceof Anthropic.APIError) return new Error(`Error de la API (${err.status}): ${err.message}`)
  return err instanceof Error ? err : new Error(String(err))
}

/** Imagen que acompaña al prompt (p. ej. la hoja de un personaje), con una etiqueta que la presenta. */
export interface AiImage {
  label: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  /** Base64 sin el prefijo data:. */
  data: string
}

/** Contenido del mensaje: cada imagen precedida de su etiqueta y, al final, el prompt. */
export function userContent(prompt: string, images: AiImage[] = []) {
  return [
    ...images.flatMap((i) => [
      { type: 'text' as const, text: i.label },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } }
    ]),
    { type: 'text' as const, text: prompt }
  ]
}

export async function structured<T extends z.ZodType>(opts: {
  kind: AiProgress['kind']
  schema: T
  system: string
  prompt: string
  images?: AiImage[]
  effort: 'low' | 'medium' | 'high'
  onProgress?: Progress
  /** Solo con Claude Code: límite de la petición (15 min por defecto). */
  timeoutMs?: number
}): Promise<z.infer<T>> {
  const settings = getSettings()
  if (settings.aiProvider === 'claude-code') return viaClaudeCode(opts)
  try {
    const stream = client().beta.messages.stream({
      model: settings.anthropicModel || 'claude-opus-5-5',
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: opts.effort, format: betaZodOutputFormat(opts.schema) },
      system: opts.system,
      messages: [{ role: 'user', content: opts.images?.length ? userContent(opts.prompt, opts.images) : opts.prompt }]
    })
    let chars = 0
    let buffer = ''
    stream.on('text', (delta: string) => {
      chars += delta.length
      buffer += delta
      opts.onProgress?.({ kind: opts.kind, chars, posts: (buffer.match(/"rationale"/g) ?? []).length })
    })
    const msg = await stream.finalMessage()
    opts.onProgress?.({ kind: opts.kind, chars, done: true })
    if (msg.stop_reason === 'refusal') throw new Error(tr('El modelo no ha querido generar este contenido. Reformula el briefing.'))
    if (msg.stop_reason === 'max_tokens') throw new Error(tr('La respuesta se cortó por largo. Reduce el número de semanas o de publicaciones.'))
    const parsed = msg.parsed_output as z.infer<T> | null
    if (!parsed) throw new Error(tr('La respuesta de la IA no tenía el formato esperado'))
    log('info', 'ia', `${opts.kind}: ${msg.usage.input_tokens} tokens de entrada, ${msg.usage.output_tokens} de salida (${msg.model})`)
    return parsed
  } catch (e) {
    throw friendly(e)
  }
}

/** Misma petición, pero a través de Claude Code con la sesión de tu suscripción. */
async function viaClaudeCode<T extends z.ZodType>(opts: {
  kind: AiProgress['kind']
  schema: T
  system: string
  prompt: string
  images?: AiImage[]
  effort: 'low' | 'medium' | 'high'
  onProgress?: Progress
  /** Solo con Claude Code: límite de la petición (15 min por defecto). */
  timeoutMs?: number
}): Promise<z.infer<T>> {
  const settings = getSettings()
  // Claude Code no resuelve la referencia "$schema" (draft 2020-12) que añade Zod.
  const { $schema: _ignored, ...schema } = z.toJSONSchema(opts.schema) as Record<string, unknown>
  const { output, usage } = await runClaudeCode({
    system: opts.system,
    prompt: opts.prompt,
    images: opts.images,
    schema,
    model: settings.anthropicModel || 'claude-opus-5-5',
    effort: opts.effort,
    timeoutMs: opts.timeoutMs,
    onDelta: (chars, buffer) => opts.onProgress?.({ kind: opts.kind, chars, posts: (buffer.match(/"rationale"/g) ?? []).length })
  })
  opts.onProgress?.({ kind: opts.kind, chars: 0, done: true })
  const parsed = opts.schema.safeParse(output)
  if (!parsed.success) throw new Error(tr('La respuesta de la IA no tenía el formato esperado'))
  log('info', 'ia', `${opts.kind}: ${usage}`)
  return parsed.data as z.infer<T>
}

// ---------- Estratega: principios comunes ----------

export const STRATEGIST = `Eres la mejor estratega de marketing de contenidos y SEO del mercado hispanohablante. Tu único objetivo medible es aumentar el tráfico orgánico y cualificado a la web del cliente, y que ese tráfico convierta. Las redes sociales son canales de distribución y de señal de marca para que la web crezca; no son un fin en sí mismas.

Principios con los que trabajas:
1. SEO primero. Cada artículo del blog ataca UNA palabra clave principal de cola larga con una intención de búsqueda clara (informativa, comercial o transaccional) que el negocio pueda ganar de verdad. Elige palabras que su público busca con sus propias palabras. Evita canibalizar: no repitas temas ni palabras clave que ya cubre una URL existente; si un tema ya existe, propón un artículo complementario que la enlace.
2. Clústeres temáticos. Organiza los artículos en 2-4 pilares; cada pilar tiene una página o artículo pilar y artículos satélite que lo enlazan. Indica en el índice de cada artículo a qué páginas existentes debe enlazar (enlazado interno) y qué página de servicio o producto es su conversión.
3. Embudo. Mezcla contenido de descubrimiento (TOFU, para captar búsquedas amplias y alcance en redes), de consideración (MOFU: comparativas, guías, casos) y de decisión (BOFU: precios, por qué elegirnos, objeciones). Al menos una de cada cuatro piezas tiene que acercar a la compra.
4. Una idea, muchas piezas. Cada artículo se reparte en redes durante su semana: un vídeo vertical corto, un post de LinkedIn y un post o hilo en X que cuentan una parte y mandan al artículo. Las piezas de redes salen DESPUÉS del artículo, nunca antes.
5. Vídeo vertical a la vez en todas sus redes. Un vídeo corto (formato short) se publica en una sola entrada con TikTok + Instagram (Reels) a la vez, y también YouTube (Shorts) si YouTube tiene frecuencia. Mismo día y misma hora: así se graba una vez y se aprovecha el pico de cada red. Nunca crees un short solo para TikTok y otro distinto solo para Instagram.
6. SEO social. TikTok, Instagram y YouTube funcionan como buscadores: el gancho y el texto incluyen la palabra clave de la pieza tal y como la buscaría el público. Los títulos de YouTube empiezan por la palabra clave.
7. Horas de máximo impacto. Elige la hora de cada pieza según cuándo está activo ese público en esa red y en su zona horaria (por defecto, España). Como referencia de partida: TikTok y Reels por la tarde-noche entre semana (18:00-21:30) y a media mañana el fin de semana; LinkedIn de martes a jueves entre 08:00 y 10:00 o a las 12:30; X a mediodía (12:00-14:00) y a primera hora; YouTube jueves a sábado a partir de las 17:00; artículos del blog lunes o martes temprano (08:00-09:00), para que acumulen visitas toda la semana y den contenido a las redes. Si hay datos de rendimiento reales, mandan los datos sobre estas referencias.
8. Ganchos que paran el scroll. Cada pieza abre con un gancho concreto (un problema, una cifra del propio negocio, un error común, una promesa específica), nunca con un saludo.
9. Honestidad. No inventes datos, cifras, estudios, clientes ni testimonios. Si una pieza necesita un dato real del cliente, déjalo entre corchetes, p. ej. [nº de clientes].`

// ---------- Autorrelleno desde la web ----------

const frequencySchema = z.object(Object.fromEntries(PLATFORM_IDS.map((p) => [p, z.number().int()])) as Record<Platform, z.ZodNumber>)

const SiteSchema = z.object({
  businessName: z.string(),
  offer: z.string().describe('Qué vende o qué servicios ofrece, con lo que le diferencia, en 1-3 frases'),
  audience: z.string().describe('Cliente ideal: quién es, qué problema tiene y qué busca, en 1-3 frases'),
  goal: z.string().describe('Objetivo de contenido recomendado, orientado a tráfico y conversión'),
  tone: z.string().describe('Tono de marca que se deduce de la web'),
  language: z.string().describe('Idioma y variante, p. ej. español de España'),
  pillars: z.string().describe('2-4 pilares temáticos separados por comas'),
  siteNotes: z.string().describe('Diagnóstico SEO en 5-8 frases: palabras clave por las que ya parece posicionar, contenido existente, huecos de contenido, páginas de conversión a las que llevar tráfico y problemas evidentes (títulos o meta descripciones flojas, poco contenido)'),
  keywordIdeas: z.array(z.object({ keyword: z.string(), intent: z.string().describe('informativa, comercial o transaccional'), articleIdea: z.string() })).describe('8-12 palabras clave de cola larga que no cubre ya la web'),
  cadences: z
    .array(z.object({ name: z.string(), description: z.string().describe('Para quién es y qué se consigue, 1-2 frases'), hoursPerWeek: z.number().int().describe('Horas semanales estimadas de producción'), frequency: frequencySchema }))
    .describe('Exactamente 3 cadencias de menos a más ambiciosa. TikTok e Instagram con la misma frecuencia (el mismo vídeo va a las dos). Pon 0 en las redes que no encajen con este negocio.')
})

const SITE_SYSTEM = `${STRATEGIST}

Ahora te toca hacer el diagnóstico inicial de un cliente a partir del contenido de su web. Rellena su briefing, detecta oportunidades SEO y recomienda tres cadencias de publicación realistas para un negocio de su tamaño. Decide qué redes tienen sentido para su público (por ejemplo, LinkedIn para B2B, TikTok e Instagram para consumidor final) y pon 0 en las que no.`

export async function analyzeSite(url: string, onProgress?: Progress): Promise<SiteAnalysis> {
  const snap = await readSite(url, (stage) => onProgress?.({ kind: 'site', chars: 0, stage }))
  onProgress?.({ kind: 'site', chars: 0, stage: tr('Analizando con IA') })
  const prompt = `Analiza esta web y prepara el briefing.\n\n<web origen="${snap.origin}">\n${snapshotToPrompt(snap)}\n</web>\n\n<rendimiento_reciente>\n${performanceSummary()}\n</rendimiento_reciente>`
  const out = await structured({ kind: 'site', schema: SiteSchema, system: SITE_SYSTEM, prompt, effort: 'medium', onProgress })
  const paths = snap.sitemapUrls.map((u) => {
    try {
      return new URL(u).pathname
    } catch {
      return u
    }
  })
  return {
    brief: {
      businessName: out.businessName, website: snap.origin, offer: out.offer, audience: out.audience, goal: out.goal, tone: out.tone,
      language: out.language, pillars: out.pillars, siteNotes: out.siteNotes, existingUrls: paths.slice(0, 300)
    },
    keywordIdeas: out.keywordIdeas,
    cadences: out.cadences.slice(0, 3).map((c) => ({
      ...c,
      // El mismo vídeo vertical va a TikTok e Instagram: igualamos sus frecuencias.
      frequency: { ...c.frequency, instagram: Math.max(c.frequency.tiktok, c.frequency.instagram), tiktok: Math.max(c.frequency.tiktok, c.frequency.instagram) }
    })),
    pagesRead: snap.pages.length
  }
}

// ---------- Plan de contenidos ----------

const PlanSchema = z.object({
  strategy: z.string().describe('Estrategia del periodo en 4-6 frases: clúster SEO, palabras clave objetivo y cómo cada pieza empuja tráfico a la web.'),
  pillars: z.array(z.object({ name: z.string(), description: z.string() })),
  bestTimes: z
    .array(z.object({ platform: z.enum(PLATFORM_IDS), times: z.string().describe('Días y horas recomendados, p. ej. "Mar-Jue 08:00-09:30"'), reason: z.string().describe('Por qué, en una frase') }))
    .describe('Una entrada por cada plataforma con frecuencia mayor que cero'),
  posts: z.array(
    z.object({
      date: z.string().describe('AAAA-MM-DD, una de las fechas disponibles'),
      time: z.string().describe('HH:MM en hora local, dentro de la franja de máximo impacto de sus plataformas'),
      platforms: z.array(z.enum(PLATFORM_IDS)).describe('Un short va siempre a TikTok e Instagram juntos (y YouTube si tiene frecuencia)'),
      format: z.enum(FORMATS),
      pillar: z.string(),
      keyword: z.string().describe('Palabra clave principal de la pieza'),
      title: z.string().describe('Para artículos: título SEO con la palabra clave. Para el resto: título interno corto'),
      hook: z.string().describe('La primera frase o los primeros 2 segundos'),
      body: z.string().describe('Borrador listo para trabajar: guion por escenas, post completo, hilo o índice del artículo con enlaces internos'),
      cta: z.string().describe('Llamada a la acción hacia la web'),
      linkPath: z.string().describe('Ruta de la web a la que lleva, p. ej. /blog/slug'),
      rationale: z.string().describe('Por qué esta pieza, esta palabra clave, este día y esta hora, en 1-2 frases')
    })
  )
})

const PLAN_SYSTEM = `${STRATEGIST}

Formato de la respuesta:
- Respeta exactamente la frecuencia semanal pedida para cada plataforma. Una entrada con varias plataformas cuenta para la frecuencia de cada una. Si TikTok e Instagram tienen frecuencias distintas, los shorts comunes van a las dos y los que sobren van solo a la que tiene más.
- Formatos que admite cada plataforma: TikTok (short, video), Instagram (short, image, video), YouTube (video, short), LinkedIn (text, image, article), X (text, thread, image), Blog (article).
- Reparte la carga en la semana y no pongas dos piezas en la misma plataforma el mismo día.
- El campo body es un borrador útil, no un resumen: para vídeo, gancho y guion por escenas con lo que se dice y lo que se ve; para LinkedIn, el post completo; para X, el post o el hilo con los posts separados por una línea con ---; para artículos, palabra clave, intención de búsqueda, meta descripción propuesta e índice H2/H3 con los puntos clave y los enlaces internos que debe llevar.
- No incluyas URLs en body: la app añade el enlace con UTM automáticamente. En TikTok e Instagram la llamada a la acción usa "enlace en la bio".
- Escribe en el idioma y el tono pedidos.`

function availableDates(start: string, weeks: number): string[] {
  const out: string[] = []
  const d = new Date(`${start}T12:00:00`)
  for (let i = 0; i < weeks * 7; i++) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push(`${iso} (${d.toLocaleDateString('es-ES', { weekday: 'long' })})`)
    d.setDate(d.getDate() + 1)
  }
  return out
}

export async function generatePlan(brief: PlannerBrief, onProgress?: Progress): Promise<Plan> {
  const freq = Object.entries(brief.frequency)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([p, n]) => `${PLATFORMS[p as Platform].name}: ${n} por semana`)
    .join('\n')
  if (!freq) throw new Error(tr('Elige al menos una plataforma con frecuencia mayor que cero'))

  const prompt = `Prepara el calendario de contenidos.

<cliente>
Negocio: ${brief.businessName}
Web: ${brief.website}
Qué ofrece: ${brief.offer}
Público: ${brief.audience}
Objetivo: ${brief.goal}
Tono: ${brief.tone}
Idioma: ${brief.language}
Zona horaria: ${getSettings().timezone}
Pilares o temas deseados: ${brief.pillars || 'propónlos tú'}
Notas: ${brief.extra || '—'}
</cliente>

<diagnostico_seo>
${brief.siteNotes || 'No hay diagnóstico de la web. Deduce las oportunidades del negocio y su público.'}
</diagnostico_seo>

<urls_existentes>
${brief.existingUrls?.length ? brief.existingUrls.slice(0, 300).join('\n') : '(desconocidas)'}
</urls_existentes>

<frecuencia>
${freq}
</frecuencia>

<fechas_disponibles>
${availableDates(brief.startDate, brief.weeks).join('\n')}
</fechas_disponibles>

<rendimiento_reciente>
${performanceSummary()}
</rendimiento_reciente>

Devuelve ${brief.weeks} semana(s) de publicaciones ordenadas por fecha.`

  const out = await structured({ kind: 'plan', schema: PlanSchema, system: PLAN_SYSTEM, prompt, effort: 'high', onProgress })
  const plan: Plan = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    brief,
    strategy: out.strategy,
    pillars: out.pillars,
    bestTimes: out.bestTimes.filter((b) => (brief.frequency[b.platform] ?? 0) > 0),
    // Filtramos combinaciones que la plataforma no admite.
    posts: out.posts
      .map((p) => ({ ...p, platforms: [...new Set(p.platforms)].filter((pl) => PLATFORMS[pl].formats.includes(p.format)) }))
      .filter((p) => p.platforms.length > 0)
      .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
  }
  savePlan(plan.id, plan.createdAt, plan)
  return plan
}

// ---------- Textos por plataforma ----------

const VariantsSchema = z.object({
  variants: z.array(
    z.object({
      platform: z.enum(PLATFORM_IDS),
      title: z.string().describe('Solo YouTube (máx. 100 caracteres); vacío en el resto'),
      caption: z.string()
    })
  )
})

const VARIANTS_SYSTEM = `${STRATEGIST}

Ahora haces de copywriter: adaptas una misma pieza a cada plataforma respetando sus códigos, sin perder la idea ni el objetivo de llevar tráfico a la web. Usa la palabra clave de la pieza en el texto tal y como la buscaría el público (las redes también son buscadores).

Reglas por plataforma:
- TikTok: 1-3 frases con gancho y la palabra clave, 3-5 hashtags relevantes al final (mezcla de nicho y amplios). Sin URL; la llamada a la acción dice "enlace en la bio".
- Instagram: primera línea con gancho y la palabra clave, cuerpo breve con saltos de línea, llamada a la acción a "enlace en la bio" o a guardar el post, 5-10 hashtags al final.
- YouTube: título de hasta 100 caracteres con la palabra clave al principio; descripción de 2-4 párrafos con la palabra clave y capítulos si es un vídeo largo.
- LinkedIn: gancho en la primera línea, párrafos cortos, una idea útil, pregunta o llamada a la acción final. Máximo 3 hashtags. Sin emojis en exceso.
- X: máximo 250 caracteres por post (la app añade el enlace). Si el formato es hilo, separa cada post con una línea que contenga solo ---.
- No incluyas URLs: la app añade el enlace con UTM donde la plataforma lo permite.
- No inventes datos ni testimonios.`

export async function generateVariants(postId: string, platforms: Platform[], onProgress?: Progress): Promise<Variant[]> {
  const post = getPost(postId)
  if (!post) throw new Error(tr('Publicación no encontrada'))
  const social: Platform[] = platforms.filter((p) => p !== 'blog')
  if (!social.length) return []
  const s = getSettings()
  const prompt = `Adapta esta pieza a: ${social.map((p) => PLATFORMS[p].name).join(', ')}.

<pieza>
Título: ${post.title}
Formato: ${post.format}
Pilar: ${post.pillar}
Gancho: ${post.hook}
${post.notes ? post.notes + '\n' : ''}Llamada a la acción: ${post.cta}
Lleva a: ${s.website}${post.linkPath}
Borrador:
${post.body}
</pieza>

Idioma y tono: ${s.plannerBrief?.language || 'español'}, ${s.plannerBrief?.tone || 'cercano y experto'}.`
  const out = await structured({ kind: 'variants', schema: VariantsSchema, system: VARIANTS_SYSTEM, prompt, effort: 'medium', onProgress })
  const variants = out.variants.filter((v) => social.includes(v.platform))
  upsertPost(postId, {
    targetOverrides: Object.fromEntries(variants.map((v) => [v.platform, { caption: v.caption, title: v.platform === 'youtube' ? v.title : undefined }]))
  })
  return variants
}

// ---------- Artículo del blog ----------

const ArticleSchema = z.object({
  title: z.string().describe('Título SEO de 50-65 caracteres'),
  metaDescription: z.string().describe('Meta descripción de 140-160 caracteres'),
  markdown: z.string().describe('Artículo completo en Markdown, sin el título H1')
})

const ARTICLE_SYSTEM = `${STRATEGIST}

Ahora haces de redactora SEO. Escribes artículos útiles que posicionan y convierten: responden de verdad y pronto a la intención de búsqueda, con estructura clara (H2 y H3), párrafos cortos, ejemplos concretos y una llamada a la acción final hacia la oferta del cliente.
- Entre 1.000 y 1.600 palabras, según lo que necesite la intención de búsqueda.
- La palabra clave principal en el título, en las primeras 100 palabras, en al menos un H2 y de forma natural en el texto, con variantes y términos relacionados. Nada de relleno ni repetición forzada.
- Responde a la pregunta principal en el primer párrafo (para optar al fragmento destacado) y cierra con una sección de preguntas frecuentes (H2 "Preguntas frecuentes" con 3-5 H3 en forma de pregunta).
- Enlazado interno: incluye 2-4 enlaces Markdown a URLs existentes de la web que sean relevantes (usa rutas relativas de la lista que te doy) y un enlace a la página de servicio o producto que convierte.
- Demuestra experiencia: pasos concretos, errores comunes, criterios para decidir. Donde haga falta un dato o un caso real del cliente, déjalo entre corchetes.
- No inventes estadísticas, estudios, clientes ni citas. Donde haga falta un dato del cliente, déjalo entre corchetes.
- Sin H1 (el título va aparte). Markdown limpio.`

export async function generateArticle(postId: string, onProgress?: Progress): Promise<{ title: string; markdown: string }> {
  const post = getPost(postId)
  if (!post) throw new Error(tr('Publicación no encontrada'))
  const s = getSettings()
  const b = s.plannerBrief
  const prompt = `Escribe el artículo.

<cliente>
Negocio: ${b?.businessName ?? ''}
Web: ${s.website}
Qué ofrece: ${b?.offer ?? ''}
Público: ${b?.audience ?? ''}
Tono: ${b?.tone ?? 'cercano y experto'}
Idioma: ${b?.language ?? 'español'}
</cliente>

<urls_existentes>
${b?.existingUrls?.slice(0, 200).join('\n') || '(desconocidas)'}
</urls_existentes>

<encargo>
${post.notes}
Título de trabajo: ${post.title}
Gancho: ${post.hook}
Llamada a la acción: ${post.cta}
Índice y notas:
${post.body}
</encargo>`
  const out = await structured({ kind: 'article', schema: ArticleSchema, system: ARTICLE_SYSTEM, prompt, effort: 'medium', onProgress })
  upsertPost(postId, { platforms: [...new Set([...post.targets.map((t) => t.platform), 'blog' as Platform])], targetOverrides: { blog: { title: out.title, caption: out.markdown } }, hook: post.hook || out.metaDescription })
  return { title: out.title, markdown: out.markdown }
}
