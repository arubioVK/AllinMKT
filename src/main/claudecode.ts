import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettings } from './db'
import { tr, locale } from './i18n'
import { userContent, type AiImage } from './ai'

// Motor de IA a través de Claude Code (la CLI `claude`), que usa la sesión con la que hayas
// iniciado sesión en este equipo: tu suscripción de Claude (Pro o Max), sin API key.
// Lo ejecutamos en modo no interactivo (-p), sin herramientas, sin MCP y sin ajustes de
// proyecto, con un esquema JSON para que la respuesta llegue ya validada.

const isWin = process.platform === 'win32'

/** Busca el ejecutable: ajuste manual, rutas de instalación habituales y, por último, el PATH. */
export function findClaude(): string {
  const custom = getSettings().claudePath
  if (custom) return custom
  const home = homedir()
  const candidates = isWin
    ? [
        join(home, '.local', 'bin', 'claude.exe'),
        join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'claude', 'claude.exe')
      ]
    : [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/usr/bin/claude']
  return candidates.find((c) => existsSync(c)) ?? 'claude'
}

/** Entorno sin API key, para que la CLI use la sesión de la suscripción y no cobre por API. */
function env(): NodeJS.ProcessEnv {
  const e = { ...process.env }
  delete e.ANTHROPIC_API_KEY
  delete e.ANTHROPIC_AUTH_TOKEN
  return e
}

function workDir(): string {
  // Carpeta vacía para que no se cargue el CLAUDE.md ni la configuración de ningún proyecto.
  const dir = join(tmpdir(), 'allinmkt-ai')
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface ClaudeCodeStatus {
  ok: boolean
  path: string
  version: string
  loggedIn: boolean
  plan: string
  error: string
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: env(), timeout: timeoutMs, shell: isWin && file.endsWith('.cmd'), windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

export async function claudeCodeStatus(): Promise<ClaudeCodeStatus> {
  const path = findClaude()
  const out: ClaudeCodeStatus = { ok: false, path, version: '', loggedIn: false, plan: '', error: '' }
  try {
    out.version = (await run(path, ['--version'], 15_000)).trim()
  } catch {
    out.error = tr('No se encuentra Claude Code en este equipo. Instálalo o indica la ruta del ejecutable.')
    return out
  }
  try {
    const st = JSON.parse(await run(path, ['auth', 'status'], 15_000)) as { loggedIn?: boolean; subscriptionType?: string; authMethod?: string }
    out.loggedIn = !!st.loggedIn
    out.plan = st.subscriptionType ?? st.authMethod ?? ''
    if (!out.loggedIn) out.error = tr('Claude Code no tiene sesión iniciada. Ejecuta "claude" en una terminal y entra con tu cuenta.')
  } catch {
    // Versiones antiguas sin "auth status": asumimos sesión y ya fallará la petición si no la hay.
    out.loggedIn = true
  }
  out.ok = out.loggedIn
  return out
}

export interface ClaudeCodeRequest {
  system: string
  prompt: string
  schema: Record<string, unknown>
  /** Imágenes para el modelo: se envían como mensaje stream-json (el texto plano no admite imágenes). */
  images?: AiImage[]
  model: string
  effort: 'low' | 'medium' | 'high'
  timeoutMs?: number
  /** Recibe el número de caracteres del JSON generado hasta ahora y el texto acumulado. */
  onDelta?: (chars: number, buffer: string) => void
}

interface ResultEvent {
  type: 'result'
  is_error?: boolean
  subtype?: string
  result?: string
  structured_output?: unknown
  total_cost_usd?: number
  api_error_status?: number | null
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
}

const fmt = (n: number): string => n.toLocaleString(locale())

/**
 * Claude Code usa caché de prompt: input_tokens solo cuenta lo que no estaba en caché, así que
 * la entrada real es la suma de los tres campos. La salida incluye el razonamiento (thinking).
 * total_cost_usd es lo que costaría por API; con la suscripción no se cobra aparte.
 */
function usageText(r: ResultEvent): string {
  const u = r.usage ?? {}
  const fresh = u.input_tokens ?? 0
  const written = u.cache_creation_input_tokens ?? 0
  const read = u.cache_read_input_tokens ?? 0
  const input = fresh + written + read
  const cost = r.total_cost_usd ? ` · equivale a ${r.total_cost_usd.toFixed(2)} $ por API` : ''
  return `${fmt(input)} tokens de entrada (${fmt(read)} de caché), ${fmt(u.output_tokens ?? 0)} de salida (suscripción${cost})`
}

export function runClaudeCode(req: ClaudeCodeRequest): Promise<{ output: unknown; usage: string }> {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--json-schema', JSON.stringify(req.schema),
    '--system-prompt', req.system,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
    '--model', req.model,
    '--effort', req.effort,
    ...(req.images?.length ? ['--input-format', 'stream-json'] : [])
  ]
  const file = findClaude()
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: workDir(), env: env(), shell: isWin && file.endsWith('.cmd'), windowsHide: true })
    let stdoutBuf = ''
    let stderr = ''
    let json = ''
    let result: ResultEvent | null = null
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(tr('Claude Code tardó demasiado en responder')))
    }, req.timeoutMs ?? 15 * 60_000)

    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`No se pudo ejecutar Claude Code (${file}): ${e.message}`))
    })
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.stdout.on('data', (d: Buffer) => {
      stdoutBuf += d.toString()
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        let ev: { type?: string; event?: { type?: string; delta?: { type?: string; partial_json?: string; text?: string } } }
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
          const piece = ev.event.delta?.partial_json ?? ev.event.delta?.text ?? ''
          json += piece
          req.onDelta?.(json.length, json)
        } else if (ev.type === 'result') {
          result = ev as unknown as ResultEvent
        }
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!result) {
        reject(new Error(`${tr('Claude Code terminó sin respuesta (código {code}).', { code: String(code) })} ${stderr.trim().slice(0, 300)}`))
        return
      }
      if (result.is_error || result.structured_output === undefined) {
        const msg = result.result || result.subtype || 'error desconocido'
        if (/limit|usage/i.test(msg)) reject(new Error(`${tr('Has alcanzado el límite de uso de tu suscripción:')} ${msg}`))
        else if (/login|auth|credential/i.test(msg)) reject(new Error(`${tr('Claude Code no tiene sesión iniciada:')} ${msg}`))
        else reject(new Error(`${tr('Claude Code devolvió un error:')} ${msg}`))
        return
      }
      resolve({ output: result.structured_output, usage: usageText(result) })
    })
    // El prompt va por la entrada estándar: así no hay límites de longitud de la línea de comandos.
    // Con imágenes, como un mensaje de usuario en stream-json con bloques de imagen y de texto.
    child.stdin.end(
      req.images?.length
        ? JSON.stringify({ type: 'user', message: { role: 'user', content: userContent(req.prompt, req.images) } }) + '\n'
        : req.prompt
    )
  })
}
