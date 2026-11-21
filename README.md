# AllinMKT

Aplicación de escritorio local (Linux y Windows) para planificar contenido con IA, publicarlo en TikTok, Instagram, YouTube, LinkedIn, X y el blog, y comparar el rendimiento de cada red con el tráfico real de la web.

## Requisitos

- **Node.js 22 LTS o posterior** (el instalador de Electron 45 no funciona con Node 20.14).
  - Linux con `n`: `sudo n lts`
  - Windows: instala la versión LTS desde nodejs.org o con `winget install OpenJS.NodeJS.LTS`

## Puesta en marcha

```bash
rm -rf node_modules package-lock.json   # solo si instalaste con un Node antiguo
npm install
npm run dev          # desarrollo con recarga
npm run dist:linux   # AppImage y .deb en dist/
npm run dist:win     # instalador .exe (ejecútalo en Windows)
```

Al abrir la app por primera vez: **Ajustes › Datos de ejemplo** llena la app con 10 semanas inventadas para ver cómo queda. Se borran con un clic y nunca se publican.

## IA

Por defecto la IA usa **tu suscripción de Claude** (Pro o Max) a través de Claude Code instalado en el equipo: no hace falta API key. Debe estar instalado (`claude --version`) y con la sesión iniciada (`claude auth status`). En **Conexiones › IA** puedes cambiar a API key de pago por uso.

## Cómo funciona

| Pieza | Qué hace |
|---|---|
| **Planificador IA** | Con tu briefing y la frecuencia por red, Claude propone un calendario en el que cada semana gira alrededor de un artículo o una página de la web y las piezas para redes enlazan a ella. Si ya hay métricas, las usa para elegir formatos, días y horas. |
| **Editor** | Adapta el texto a cada red con IA, escribe el artículo del blog en Markdown, adjunta el vídeo o la imagen, programa o publica al momento. |
| **Calendario** | Vista mensual con arrastrar y soltar, y vista de agenda. |
| **Cola de publicación** | Cada minuto publica lo vencido. Si el equipo estaba apagado, publica al arrancar dentro del margen configurado (12 h por defecto); lo demás queda como fallido para reprogramarlo. |
| **Métricas** | Cada 6 h descarga visualizaciones de cada red y el tráfico de GA4 por canal y campaña UTM. |
| **Atribución** | Todos los enlaces llevan `utm_source=<red>&utm_medium=social&utm_campaign=<fecha-titulo>`, así que cada visita a la web se atribuye a la publicación que la trajo. |

Para que las publicaciones salgan a su hora, activa **Ajustes › Abrir al iniciar sesión**: la app arranca minimizada en la bandeja.

## Limitaciones de las plataformas

- **TikTok**: hasta que TikTok audite tu app, solo se publica en privado.
- **YouTube**: los proyectos de Google sin verificar suben los vídeos como privados.
- **Instagram**: cuenta Business o Creator; el archivo tiene que estar en una URL pública (configura un almacenamiento S3/R2 o pega la URL).
- **LinkedIn**: publica en tu perfil personal; las estadísticas por API requieren aprobación (Community Management API), así que se introducen a mano en Analítica.
- **X**: publicar funciona en el plan gratuito con límites; leer impresiones requiere un plan de pago.

## Estructura

```
src/main/          proceso principal (Node): SQLite, cola, OAuth, IA, conectores
  connectors/      tiktok, instagram, youtube, linkedin, x, blog, ga4
  ai.ts            generación con Claude (salidas estructuradas + streaming)
  stats.ts         agregados para el resumen y la analítica
src/preload/       puente seguro entre la interfaz y el proceso principal
src/renderer/      interfaz React + Tailwind + ECharts
src/shared/        tipos compartidos
```

Los datos están en el directorio de usuario de la app (`~/.config/AllinMKT` en Linux, `%APPDATA%\AllinMKT` en Windows). Las credenciales se cifran con el llavero del sistema (DPAPI en Windows, libsecret/kwallet en Linux).
