import { contextBridge, ipcRenderer } from 'electron'

// Puente mínimo y tipado: la interfaz solo puede invocar canales con nombre y escuchar eventos.
const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<{ ok: boolean; data?: unknown; error?: string }> =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: 'changed' | 'ai-progress' | 'jobs', fn: (payload: unknown) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('allin', api)
export type AllinApi = typeof api
