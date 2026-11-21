import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { shell } from 'electron'
import { getSettings } from './db'
import { tr } from './i18n'

// Flujo OAuth para apps de escritorio: abrimos el navegador del sistema y recibimos el
// código en un servidor local de un solo uso (http://127.0.0.1:<puerto>/callback).

export function redirectUri(): string {
  return `http://127.0.0.1:${getSettings().oauthPort}/callback`
}

export function pkce(encoding: 'base64url' | 'hex' = 'base64url'): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest(encoding)
  return { verifier, challenge }
}

const page = (title: string, msg: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;background:#000;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><div><h1 style="font-size:20px;font-weight:600">${title}</h1><p style="color:#b4b4b4">${msg}</p></div></body>`

let active: Server | null = null

/** Abre la URL de autorización y espera el código. Devuelve los parámetros de la redirección. */
export function authorize(authUrl: string, state: string, timeoutMs = 5 * 60_000): Promise<URLSearchParams> {
  if (active) active.close()
  const port = getSettings().oauthPort
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const params = url.searchParams
      const err = params.get('error_description') || params.get('error')
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(tr('No se pudo conectar'), err))
        finish(() => reject(new Error(err)))
        return
      }
      if (params.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(tr('Estado no válido'), tr('Vuelve a intentarlo desde AllinMKT.')))
        finish(() => reject(new Error(tr('El parámetro state no coincide'))))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(tr('Cuenta conectada'), tr('Ya puedes cerrar esta pestaña y volver a AllinMKT.')))
      finish(() => resolve(params))
    })
    const timer = setTimeout(() => finish(() => reject(new Error(tr('Tiempo de espera agotado')))), timeoutMs)
    function finish(fn: () => void): void {
      clearTimeout(timer)
      server.close()
      if (active === server) active = null
      fn()
    }
    server.on('error', (e) => finish(() => reject(new Error(`No se pudo abrir el puerto ${port}: ${e.message}`))))
    server.listen(port, '127.0.0.1', () => {
      active = server
      void shell.openExternal(authUrl)
    })
  })
}

export const newState = (): string => randomBytes(16).toString('hex')
