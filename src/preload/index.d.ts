declare global {
  interface Window {
    allin: {
      invoke: (channel: string, ...args: unknown[]) => Promise<{ ok: boolean; data?: unknown; error?: string }>
      on: (channel: 'changed' | 'ai-progress' | 'jobs', fn: (payload: unknown) => void) => () => void
    }
  }
}
export {}
