# AllinMKT

**Planifica, publica y mide tu contenido desde una sola app de escritorio, con Claude como estratega.**

AllinMKT es una aplicación local para Linux y Windows pensada para una cosa: **llevar más tráfico a tu web**. La IA lee tu sitio, hace un diagnóstico SEO y te propone un calendario en el que cada semana gira alrededor de un artículo del blog; las piezas para TikTok, Instagram, YouTube, LinkedIn y X enlazan a él. Después publica desde una cola programada y te dice qué publicación trajo cada visita.

> *English:* AllinMKT is a local desktop app (Electron) that uses Claude to plan an SEO‑first content calendar, publishes to TikTok, Instagram, YouTube, LinkedIn, X and your blog, and attributes GA4 traffic to each post via UTM tags. The UI is available in Spanish and English.

## Por qué

- **Sin servidor ni suscripciones extra.** Todo corre en tu equipo; los datos viven en una base SQLite en tu directorio de usuario.
- **La web en el centro.** Las redes no son el fin: cada pieza lleva a un artículo o una página, con enlaces etiquetados con UTM.
- **Métricas que cierran el círculo.** Visualizaciones de cada red + sesiones de GA4 por campaña, y el planificador usa esos datos para la siguiente ronda.

## Funciones

| | |
|---|---|
| **Planificador IA** | Analiza tu web (sitemap y páginas), rellena el briefing y las palabras clave, propone cadencias y genera el plan. Eliges qué piezas aceptar y se convierten en borradores o publicaciones programadas. |
| **Editor** | Adapta el texto a cada red, escribe el artículo en Markdown, adjunta vídeo o imagen, y programa o publica al momento. |
| **Calendario** | Vista mensual con arrastrar y soltar, vista de agenda, exportación `.ics` y sincronización con Google Calendar. |
| **Contenido** | Guiones a partir de contextos reutilizables (marca, público, personajes, estilos, plantillas, reglas), series con los mismos personajes y control anti‑repetición. |
| **Vídeo** | Convierte un guion en un MP4 vertical u horizontal: Claude diseña cada escena en HTML/CSS/SVG, se graba fotograma a fotograma y ffmpeg lo codifica. Puedes rehacer una sola escena. |
| **Cola de publicación** | Cada minuto publica lo vencido. Si el equipo estaba apagado, publica al arrancar dentro de un margen (12 h por defecto). |
| **Analítica** | Métricas de cada red cada 6 h y tráfico de GA4 por canal y campaña UTM, atribuido a cada publicación. |

## Requisitos

- **Node.js ≥ 22.12** (con Node 20 falla el instalador de Electron).
- Linux (AppImage o .deb) o Windows 10/11.
- Para la IA, una de estas dos:
  - **Claude Code** instalado y con sesión iniciada (`claude --version`, `claude auth status`). Usa tu suscripción Pro o Max, sin API key. Es la opción por defecto.
  - Una **API key de Anthropic** (pago por uso), que se configura en **Conexiones › IA**.

## Instalación

```bash
git clone https://github.com/arubioVK/AllinMKT.git
cd AllinMKT
npm install          # recompila better-sqlite3 para Electron
npm run dev          # abre la app en modo desarrollo
```

Para generar un instalador:

```bash
npm run dist:linux   # AppImage y .deb en dist/
npm run dist:win     # instalador .exe (ejecútalo en Windows)
```

Cómo arrancarla, apagarla y dejarla en segundo plano: [ARRANQUE.md](ARRANQUE.md).

## Primeros pasos

1. **Ajustes › Datos de ejemplo** llena la app con 10 semanas inventadas para ver cómo queda. Se borran con un clic y nunca se publican.
2. En **Conexiones**, configura la IA y las redes que quieras usar. Cada sección explica dónde conseguir las credenciales.
3. En **Planificador**, pega la URL de tu web y deja que la IA haga el diagnóstico y el plan.
4. Activa **Ajustes › Abrir al iniciar sesión** para que la app arranque en la bandeja y publique a su hora. Cerrar la ventana no la apaga: se sale desde la bandeja.

## Conexiones

Cada red necesita tu propia app de desarrollador. En las que usan OAuth, registra esta URL de redirección:

```
http://127.0.0.1:8765/callback
```

| Red | Qué necesitas | Limitaciones |
|---|---|---|
| TikTok | App con Content Posting API y Display API | Hasta que TikTok audite la app, solo publica en privado |
| Instagram | Cuenta Business o Creator y token de larga duración de Meta | El archivo tiene que estar en una URL pública: configura un almacenamiento S3/R2 o pega la URL |
| YouTube | Cliente OAuth de tipo "App de escritorio" en Google Cloud | Si el proyecto no está verificado, los vídeos se suben como privados |
| LinkedIn | App con OpenID y Share on LinkedIn | Publica en tu perfil; las métricas se meten a mano en Analítica |
| X | App con OAuth 2.0 (lectura y escritura) | Leer métricas requiere un plan de pago |
| Blog | WordPress (contraseña de aplicación) o una carpeta de Markdown | Las visitas se leen de GA4 por la ruta del artículo |
| GA4 | JSON de una cuenta de servicio con rol de Lector en la propiedad | — |

## Privacidad

- No hay backend: AllinMKT no envía tus datos a ningún servidor propio. Solo habla con las APIs que tú conectas (Anthropic, redes, Google).
- Los datos están en `~/.config/AllinMKT` (Linux) o `%APPDATA%\AllinMKT` (Windows).
- Las credenciales y tokens se cifran con el llavero del sistema (libsecret/kwallet en Linux, DPAPI en Windows).

## Desarrollo

Electron 45 · electron‑vite · React 19 · Tailwind 4 · ECharts · better‑sqlite3 · Zod · TypeScript.

```bash
npm run dev          # desarrollo con recarga
npm run typecheck    # comprobación de tipos (no hay tests todavía)
npm run build        # compila a out/
```

```
src/main/          proceso principal (Node): SQLite, cola, OAuth, IA, vídeo, conectores
  connectors/      tiktok, instagram, youtube, linkedin, x, blog, ga4
  ai.ts            prompts y salidas estructuradas con Claude
  content.ts       guiones, series y anti‑repetición
  video.ts         guion → escenas HTML → MP4
src/preload/       puente seguro entre la interfaz y el proceso principal
src/renderer/      interfaz React + Tailwind + ECharts
src/shared/        tipos y traducciones compartidos
```

La guía detallada de arquitectura y convenciones está en [CLAUDE.md](CLAUDE.md). Para añadir una red nueva, implementa la interfaz `Connector` de `src/main/connectors/types.ts` y regístrala en `connectors/index.ts`.

## Contribuir

Las incidencias y pull requests son bienvenidos. Antes de abrir un PR, ejecuta `npm run typecheck` y prueba el cambio en la app. Los textos de la interfaz van en español con su traducción en `src/shared/i18n.en.ts`.

## Estado

Proyecto en desarrollo activo (v0.1). Úsalo con cuidado al publicar en cuentas reales: empieza con los datos de ejemplo y publicaciones en privado.

AllinMKT no está afiliado a TikTok, Meta, Google, LinkedIn, X ni Anthropic. Sus nombres y marcas pertenecen a sus propietarios.

## Licencia

Copyright (C) 2026 Alvaro Rubio

AllinMKT es software libre: puedes redistribuirlo y modificarlo según los términos de la [Licencia Pública General de GNU](LICENSE) publicada por la Free Software Foundation, versión 3 o (a tu elección) cualquier versión posterior. Se distribuye sin ninguna garantía.
