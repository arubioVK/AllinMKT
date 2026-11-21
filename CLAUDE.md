# CLAUDE.md

Contexto para Claude Code sobre AllinMKT. Responde y escribe en **español**: la interfaz, los mensajes de error, los logs y los comentarios del código están en español.

## Qué es

App de escritorio **local** (Linux y Windows) para un solo usuario. Su objetivo es **aumentar el tráfico a la web del usuario**:

1. **Planificar**: la IA (Claude) lee la web, hace un diagnóstico SEO y propone un calendario de contenidos. Cada semana gira alrededor de un artículo del blog, y las piezas para redes enlazan a él.
2. **Publicar**: publica en TikTok, Instagram, YouTube, LinkedIn, X y el blog desde una cola programada.
3. **Crear contenido** (apartado Contenido): guiones a partir de contextos reutilizables, series con el mismo personaje y control para no repetir.
4. **Medir**: descarga métricas de cada red y el tráfico de GA4 por canal y campaña UTM, y atribuye las visitas a cada publicación.

No hay backend propio. Todo corre en el equipo y los datos viven en SQLite dentro del directorio de usuario.

## Stack

| Capa | Tecnología |
|---|---|
| Shell | Electron 45 (proceso principal, preload y renderer) |
| Build | electron-vite 4 + Vite 6, electron-builder 26 (AppImage/.deb y NSIS .exe) |
| UI | React 19 + Tailwind 4 (`@tailwindcss/vite`) + ECharts 6 + lucide-react + date-fns |
| Datos | better-sqlite3 (WAL, claves foráneas activadas) |
| IA | `@anthropic-ai/sdk` + Zod 4 (salidas estructuradas), o la CLI de Claude Code |
| Otros | `@aws-sdk/client-s3` (subir media a S3/R2), `marked` (Markdown), `ffmpeg-static` (codificar los vídeos generados) |
| Lenguaje | TypeScript 7, módulos ES |

**Requisito: Node ≥ 22.12.** Con Node 20 falla el instalador de Electron 45. Si `npm install` o el build fallan, mira primero `node -v`.

## Comandos

```bash
npm install          # postinstall recompila better-sqlite3 para Electron (electron-builder install-app-deps)
npm run dev          # desarrollo con recarga (electron-vite dev --watch)
npm run typecheck    # tsc sobre tsconfig.node.json y tsconfig.web.json. Ejecútalo después de cada cambio
npm run build        # compila a out/
npm run dist:linux   # AppImage + .deb en dist/
npm run dist:win     # instalador .exe (ejecútalo en Windows)
```

No hay tests ni linter configurados. La verificación es `npm run typecheck` y probar la app. Cómo arrancarla y apagarla: `ARRANQUE.md`.

## Estructura

```
src/shared/types.ts      Tipos y metadatos compartidos: PLATFORMS, FORMATS, Post, Settings, SECRET_FIELDS...
src/main/                Proceso principal (Node)
  index.ts               Ventana, bandeja, bloqueo de instancia única, arranque con --hidden
  ipc.ts                 TODOS los canales IPC (handle('ns:accion', fn) → {ok, data|error}) y broadcast('changed')
  db.ts                  Esquema SQLite, ajustes por defecto, CRUD de posts/destinos, métricas, cuentas, logs
  scheduler.ts           Cola de publicación (cada 60 s) y sincronización de métricas (cada syncHours)
  ai.ts                  Prompts y esquemas Zod: analyzeSite, generatePlan, generateVariants, generateArticle
  claudecode.ts          Ejecuta `claude -p --json-schema ... --output-format stream-json` (suscripción)
  site.ts                Rastrea la web (sitemap + páginas) para que la IA la analice
  content.ts             Apartado Contenido: contextos, series, guiones, prompt, anti-repetición y guion → publicación
  video.ts               Vídeo de un guion: Opus diseña escenas HTML/CSS/SVG, se graban fotograma a fotograma y ffmpeg crea el MP4
  jobs.ts                Tareas en segundo plano (guiones, vídeos): startJob() devuelve al momento y avisa con broadcast('jobs')
  stats.ts               Agregados para Resumen y Analítica; performanceSummary() alimenta al planificador
  connectors/            Un módulo por plataforma más ga4.ts; interfaz en types.ts
  oauth.ts               OAuth de escritorio: servidor local de un solo uso en 127.0.0.1:<oauthPort>/callback + PKCE
  secrets.ts             Credenciales y tokens cifrados con safeStorage (tabla secrets)
  media.ts               Sube archivos locales a S3/R2 cuando la red exige una URL pública (Instagram)
  gcal.ts                Exportar .ics y sincronizar con Google Calendar (mismo cliente OAuth que YouTube)
  demo.ts                Datos de ejemplo (source='demo' / demo=1, se borran con clearDemo)
  autostart.ts           Abrir al iniciar sesión (con --hidden)
  http.ts                Envoltorio de fetch con HttpError
src/preload/index.ts     Expone window.allin = { invoke, on('changed' | 'ai-progress' | 'jobs') }
src/renderer/src/
  App.tsx                Navegación lateral, barra superior, contexto useNav() (go / edit)
  lib/api.ts             Cliente tipado de los canales IPC (espejo de ipc.ts)
  lib/hooks.ts           useData(): carga y se recarga sola con el evento 'changed'
  lib/jobs.tsx           JobsProvider/useJobs(): refleja las tareas en segundo plano y lanza el toast al terminar
  views/                 Dashboard (Resumen), Calendar, Planner, Content, Analytics, Connections, Settings
  views/content/         Pestañas de Contenido: Generator, Library (Guiones), SeriesView, Contexts, ScriptDrawer, common
  components/            PostEditor, Chart (ECharts), ui.tsx (primitivas), toast.tsx
  styles.css             Tokens del tema en @theme de Tailwind
```

Alias: `@shared` → `src/shared` (main, preload y renderer) y `@` → `src/renderer/src` (solo renderer).

## Modelo de datos (SQLite, `allinmkt.db`)

- **posts**: la pieza de contenido (título, cuerpo, formato, pilar, gancho, CTA, `link_path`, `utm_campaign`, media, `scheduled_at`, estado, `source` = ai/manual/demo, `rationale`).
- **post_targets**: un destino por plataforma y post (`UNIQUE(post_id, platform)`), con caption/título propios, estado, `remote_id`/`remote_url`, error e intentos.
- **metric_snapshots**: métricas acumuladas por destino y día (`manual=1` si se meten a mano, p. ej. LinkedIn).
- **web_traffic**: sesiones diarias de GA4 por canal y campaña UTM (`demo=1` para los datos de ejemplo).
- **plans**: planes generados por la IA (JSON). **settings**: clave/valor JSON. **secrets**: valores cifrados. **accounts**: cuentas conectadas. **logs**: se guardan las últimas ~500 entradas. **gcal_events**: relación post → evento (se crea en `gcal.ensureTable`).

- **content_contexts**: piezas reutilizables del prompt (`kind` = brand, audience, character, scenery, style, template, rule). Las plantillas llevan `format` y `duration_sec`. Con `is_default` se preseleccionan en el generador. Los personajes guardan su hoja de personaje en `images` (JSON con rutas copiadas a `userData/references/<id>/`; columna añadida con `ALTER TABLE` en `ensureContentTables`). La interfaz las lee como data URL con `content:image`, y `characterSheetPrompt()` genera el prompt para crear la hoja. La columna `parts` (JSON de `VisualPart`, en `userData/references/<id>/parts/`) guarda las piezas para animar de un personaje (cabeza, bocas, ojos, brazos) o los fondos de un escenario (`scenery`), con su nombre, su nota, el tamaño del lienzo y el rectángulo con dibujo (`measure()`). `sceneryPrompt()` genera el prompt para crear un fondo. Se archivan (`archived=1`) en vez de borrarse. Al crear la tabla se siembran plantillas, estilos y una regla, y la marca y el público si hay `plannerBrief`.
- **content_series**: serie con premisa, personajes, estilo y plantilla habituales, y redes (en JSON).
- **scripts**: guiones. Columnas `series_id`, `episode`, `status` (draft/approved/used/discarded) y `post_id`; el resto (escenas, prompt visual, textos por red, `similarTo`, `video`...) va en `data` JSON. Los MP4 generados se guardan en `userData/videos/` junto al HTML de la composición. Las tres tablas se crean en `ensureContentTables()`.

Estados: el post pasa por `idea → draft → scheduled → publishing → published | partial | failed`, y cada destino por `pending → publishing → published | failed | skipped`. `refreshPostStatus()` recalcula el estado del post a partir de sus destinos. Al guardar un post con `status: 'scheduled'`, los destinos fallidos vuelven a `pending`.

No hay migraciones: el esquema usa `CREATE TABLE IF NOT EXISTS`. Para añadir columnas a una tabla existente hace falta un `ALTER TABLE` protegido, porque las bases de datos ya creadas no reciben la columna nueva.

## Flujos clave

- **Publicación** (`scheduler.ts`): `tick()` cada minuto toma los destinos `pending` cuyo post está programado y vencido. Si el retraso supera `overdueGraceHours` (12 h por defecto), lo marca como fallido; si no, llama a `connector.publish()` y muestra una notificación del sistema. `publishNow()` publica al momento.
- **Texto final** (`connectors/types.ts`): `composeCaption()` usa la caption del destino o, si está vacía, el cuerpo + CTA + el enlace con UTM (solo en redes con `linkClickable`). `trackedLink()` construye `utm_source=<red>&utm_medium=social&utm_campaign=<post.utmCampaign>`. Por defecto, `utmCampaign = <fecha>-<slug del título>`.
- **Métricas**: `syncMetrics()` recorre los conectores con `fetchMetrics` (publicaciones de los últimos 90 días) y después `ga4.sync()`.
- **IA** (`ai.ts`): `structured()` con un esquema Zod. Si `aiProvider === 'claude-code'` (el valor por defecto) llama a la CLI `claude` con la suscripción del usuario. Si no, usa el SDK con streaming, `thinking: adaptive`, `output_config.effort` y la beta de fallback del servidor. El progreso llega al renderer con `broadcast('ai-progress')`. El prompt base `STRATEGIST` fija la estrategia: SEO primero, clústeres, embudo, un artículo repartido en piezas para redes, el mismo short en TikTok + Reels + Shorts, horarios de referencia y no inventar datos. Modelo por defecto: `claude-opus-5-5`.
- **Planificador**: `analyzeSite` rellena el briefing, las palabras clave y 3 cadencias. `generatePlan` crea el plan. `ai:acceptPlan` convierte las piezas elegidas en posts (borrador o programados).

- **Contenido** (`content.ts`): `buildScriptPrompt()` junta la marca, el público, los personajes, la plantilla, el estilo, las reglas y la serie (con el resumen de los episodios anteriores) y añade `<ya_hecho>` con los últimos 80 guiones (también los descartados) y 60 publicaciones, para que la IA no repita. Después de generar, `mostSimilar()` compara cada guion con lo anterior (Jaccard sobre palabras de título, gancho, resumen, ángulo y palabra clave; umbral 0,34) y guarda `similarTo` para avisar. El campo `summary` es la memoria de la IA. La descripción de los personajes se copia en `visualPrompt` para que salgan iguales en todos los vídeos. `scriptToPost()` crea **un solo post** con un destino por red y su caption propia: es el mismo vídeo, pero cada red tiene su texto y sus métricas en `post_targets` y `metric_snapshots`. El botón "Ver prompt" llama a `content:previewPrompt`.

- **Tareas en segundo plano** (`jobs.ts`): `content:generate` y `content:generateVideo` no esperan al resultado; devuelven un `Job` y el progreso llega con el evento `jobs`. La barra superior muestra lo que está en marcha, el Generador y el panel del guion muestran su tarea, y al terminar sale un toast (y una notificación del sistema si la ventana no está a la vista). Las tareas viven en memoria: se pierden al salir de la app, pero lo que producen ya está guardado.
- **Vídeo** (`video.ts`): Claude no genera imágenes, así que Opus escribe la animación (`VideoSchema`: CSS común con las `@keyframes`, `<symbol>` SVG reutilizables para el personaje y el HTML de cada escena). Se carga en una ventana offscreen con CSP sin JavaScript ni red, se congela cada instante con la Web Animations API (`__seek`, inyectado con `executeJavaScript`), se captura con `capturePage()` y se pasa en BGRA a ffmpeg (H.264, 30 fps). **Cada escena se graba en su propio clip** (`userData/videos/<guion>/scene-N-<ts>.mp4`, sin audio y con los mismos parámetros) y `joinClips()` los une con el demuxer concat sin recodificar, añadiendo la pista de audio en silencio. El diseño (estilo común + HTML de cada escena) se guarda en `videos/<guion>/spec.json`: así `content:regenerateScene` rehace una sola escena con el mismo estilo (con indicaciones opcionales y la versión anterior en el prompt), graba solo su clip y vuelve a unir el vídeo. `ScriptVideo.clips` guarda los clips en orden; si el guion cambia de número de escenas hay que generar el vídeo entero. **Piezas**: si los personajes del guion tienen `parts` o hay escenarios con fondos, `assetsFor()` los lista con la referencia `asset:<grupo>/<pieza>`; la fase de diseño monta cada personaje como un muñeco por capas (`rigs`, guardado en `spec.json`) y cada escena lo pone en pose, cambia bocas y ojos y mueve la cámara, en vez de dibujarlo en SVG. Al grabar, `inlineAssets()` cambia cada referencia por la imagen en data URL (la CSP solo admite `data:`). **Aspecto de cada personaje, por prioridad** (`sourceOf()`): 1) sus piezas; 2) si no tiene, su hoja de personaje, que se envía como imagen a la fase de diseño (`structured({ images })`; con Claude Code va como mensaje `--input-format stream-json`) con la orden de copiarla y de que mande sobre el texto; 3) si tampoco, la descripción. 1080×1920 para short y 1920×1080 para `video`. La ventana se redimensiona con `setContentSize` después de crearla porque en Linux nace recortada al alto de la pantalla. La interfaz reproduce el MP4 con el protocolo `allin-media://video/<archivo>` (registrado en `index.ts`, solo sirve la carpeta de vídeos y sus subcarpetas de clips). `scriptToPost()` adjunta el vídeo como `mediaPath`, y si el guion ya tenía publicación se actualiza su `media_path`.

## Conectores

Cada conector implementa `Connector` (`connect`, `disconnect`, `isConnected`, `publish` y, opcionalmente, `fetchMetrics`) y se registra en `connectors/index.ts`. Sus capacidades declaradas están en `PLATFORMS` (`shared/types.ts`).

| Red | Autenticación | Limitaciones |
|---|---|---|
| TikTok | OAuth (Content Posting + Display API) | Hasta que TikTok audite la app, solo publica en privado (`SELF_ONLY`) |
| Instagram | Token de larga duración del panel de Meta (Meta exige redirección https) | Cuenta Business o Creator; el archivo tiene que estar en una URL pública (`media.ts`) |
| YouTube | OAuth con un cliente "App de escritorio" de Google | Si el proyecto no está verificado, los vídeos se suben como privados |
| LinkedIn | OAuth OpenID + Share on LinkedIn (`w_member_social`) | Sin métricas por API: se meten a mano en Analítica |
| X | OAuth 2.0 + PKCE | Leer métricas requiere un plan de pago |
| Blog | WordPress (contraseña de aplicación) o Markdown en una carpeta | Las visitas se leen de GA4 por la ruta del artículo |
| GA4 | JSON de una cuenta de servicio (sin OAuth) | La cuenta de servicio tiene que tener rol de Lector en la propiedad |

Las credenciales van en `SECRET_FIELDS` y los tokens OAuth en `tokens:<plataforma>` (`getTokens`/`setTokens`). Para añadir una credencial nueva, añádela a `SECRET_FIELDS`: el canal IPC `secrets:set` rechaza cualquier otra.

## Convenciones

- **Para añadir un canal IPC hay que tocar tres sitios**: el `handle()` en `main/ipc.ts`, el método en `renderer/src/lib/api.ts` y los tipos en `shared/types.ts` si hacen falta. Si el canal modifica datos, llama a `changed()` para que las vistas se recarguen con `useData`. Si modifica posts, llama también a `scheduleGcalSync()`.
- El renderer nunca accede a Node ni a la base de datos: solo usa `window.allin` a través de `api`.
- **Idioma de la interfaz** (Ajustes › Idioma, `settings.language` = `es` | `en`): todo texto visible va envuelto en `t('texto en español')` en el renderer (`lib/i18n.tsx`) y en `tr('...')` en el proceso principal (`main/i18n.ts`). La clave es el propio texto en español, con `{marcadores}` para las variables (`t('{n} visitas', { n })`), nunca frases partidas ni plantillas con texto. Cada texto nuevo necesita su traducción en `src/shared/i18n.en.ts`; si falta, se muestra en español. Las etiquetas de `shared/types.ts` (`FORMAT_LABEL`, etc.) se guardan en español y se traducen al pintarlas (`t(FORMAT_LABEL[f])`). No se traducen los prompts de la IA, los datos de ejemplo ni los contextos sembrados: son contenido. Fechas y números con `locale()`, nunca `'es-ES'` fijo. Al cambiar de idioma se vuelve a montar la interfaz y la bandeja se reconstruye.
- Los errores para el usuario son mensajes claros en español que dicen qué hacer. Usa `log(level, scope, msg)` para el registro que se ve en Ajustes.
- Fechas: `scheduledAt` se guarda en ISO (UTC). Los agregados por día usan la fecha local (`localDate` en `stats.ts`).
- Los datos de ejemplo siempre se marcan (`source='demo'`, `remote_id` que empieza por `demo-`, `demo=1`) para no publicarlos ni mezclarlos con los reales.
- **Diseño "true-black flat"**: fondo #000 y elevación solo por luminosidad (#111 → #2a2a2a), sin bordes ni sombras en las tarjetas. El acento lima `#c6f24e` se usa solo en los datos y en los estados. Los colores de cada plataforma se usan pálidos en la interfaz y nunca en gráficas de datos. Usa los tokens de `styles.css` (`bg-surface`, `text-muted`, etc.) y las primitivas de `components/ui.tsx`.
- Estilo de código: sin punto y coma, comillas simples, 2 espacios y funciones pequeñas. Los comentarios en español explican el porqué.

## Comportamiento en ejecución

- Instancia única: lanzarla otra vez solo enfoca la ventana existente.
- Con `closeToTray` (activado por defecto), cerrar la ventana deja la app en la bandeja. Se apaga del todo con bandeja › Salir.
- Datos: `~/.config/AllinMKT` en Linux y `%APPDATA%\AllinMKT` en Windows.
- Puerto OAuth: 8765 por defecto (`redirectUri()` → `http://127.0.0.1:8765/callback`). Esa URL hay que registrarla en cada app de desarrollador.
- Repositorio **público** en GitHub (`git@github.com:arubioVK/AllinMKT.git`), rama principal `main`. No subas nada privado: credenciales, `.env`, bases de datos ni datos del usuario (el `.gitignore` ya los excluye).
