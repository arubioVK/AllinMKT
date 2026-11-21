import { safeStorage } from 'electron'
import { getDb, log } from './db'
import { tr } from './i18n'

// Credenciales y tokens cifrados con el llavero del sistema operativo (DPAPI en Windows,
// libsecret/kwallet en Linux). Si no hay llavero disponible, se guardan solo codificados.
//
// Electron solo ofrece ya el cifrado asíncrono, pero el resto de la app lee secretos de forma
// síncrona (isConnected, storageConfigured...). Por eso se descifran todos una vez al arrancar
// (loadSecrets) y se sirven desde memoria; al guardar, la memoria se actualiza al momento y el
// valor cifrado se escribe en la base de datos en segundo plano, en orden.

const cache = new Map<string, string>()
let loaded = false
let encryptionAvailable = false
let writes: Promise<void> = Promise.resolve()

async function encrypt(value: string): Promise<string> {
  if (encryptionAvailable) return 'enc:' + (await safeStorage.encryptStringAsync(value)).toString('base64')
  return 'raw:' + Buffer.from(value, 'utf8').toString('base64')
}

/** Descifra un valor guardado. Indica si conviene volver a cifrarlo (clave rotada). */
async function decrypt(stored: string): Promise<{ value: string; reEncrypt: boolean }> {
  const [kind, data] = [stored.slice(0, 4), stored.slice(4)]
  const buf = Buffer.from(data, 'base64')
  if (kind !== 'enc:') return { value: buf.toString('utf8'), reEncrypt: false }
  const r = await safeStorage.decryptStringAsync(buf)
  return { value: r.result, reEncrypt: r.shouldReEncrypt }
}

function persist(key: string, value: string): void {
  writes = writes
    .then(async () => {
      // Si mientras tanto se borró o cambió, no escribimos un valor viejo.
      if (cache.get(key) !== value) return
      getDb()
        .prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, await encrypt(value))
    })
    .catch((e: unknown) => log('error', 'secretos', `No se pudo guardar "${key}": ${e instanceof Error ? e.message : e}`))
}

/** Carga y descifra todos los secretos. Llamar una vez al arrancar, antes de usarlos. */
export async function loadSecrets(): Promise<void> {
  encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable()
  const rows = getDb().prepare('SELECT key, value FROM secrets').all() as { key: string; value: string }[]
  for (const row of rows) {
    try {
      const { value, reEncrypt } = await decrypt(row.value)
      cache.set(row.key, value)
      if (reEncrypt) persist(row.key, value)
    } catch (e) {
      log('warn', 'secretos', `No se pudo descifrar "${row.key}" (¿cambió el llavero del sistema?). Vuelve a introducirlo en Conexiones. ${e instanceof Error ? e.message : ''}`)
    }
  }
  loaded = true
}

function ensureLoaded(): void {
  if (!loaded) throw new Error('Los secretos aún no están cargados: llama a loadSecrets() al arrancar')
}

export function getSecret(key: string): string {
  ensureLoaded()
  return cache.get(key) ?? ''
}

export function setSecret(key: string, value: string): void {
  ensureLoaded()
  if (!value) {
    cache.delete(key)
    getDb().prepare('DELETE FROM secrets WHERE key = ?').run(key)
    return
  }
  cache.set(key, value)
  persist(key, value)
}

export function hasSecret(key: string): boolean {
  ensureLoaded()
  return cache.has(key)
}

/** Espera a que se hayan escrito los secretos pendientes (p. ej. antes de salir). */
export function flushSecrets(): Promise<void> {
  return writes
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** Epoch ms */
  expiresAt?: number
}

export function getTokens(platform: string): TokenSet | null {
  const raw = getSecret(`tokens:${platform}`)
  return raw ? (JSON.parse(raw) as TokenSet) : null
}

export function setTokens(platform: string, t: TokenSet | null): void {
  setSecret(`tokens:${platform}`, t ? JSON.stringify(t) : '')
}

export function encryptionBackend(): string {
  if (!encryptionAvailable) return tr('sin llavero (cifrado básico)')
  if (process.platform === 'linux') {
    const b = safeStorage.getSelectedStorageBackend()
    return b && b !== 'unknown' ? `llavero del sistema (${b})` : 'llavero del sistema'
  }
  return 'llavero del sistema'
}
