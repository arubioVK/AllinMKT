// Utilidades HTTP pequeñas sobre fetch (Node 22+ en Electron).

export class HttpError extends Error {
  constructor(public status: number, public body: string, url: string) {
    super(`HTTP ${status} en ${new URL(url).host}${new URL(url).pathname}: ${body.slice(0, 400)}`)
  }
}

export async function http<T = unknown>(url: string, init: RequestInit & { json?: unknown; form?: Record<string, string> } = {}): Promise<{ data: T; headers: Headers; status: number }> {
  const headers = new Headers(init.headers)
  let body = init.body
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json; charset=UTF-8')
    body = JSON.stringify(init.json)
  } else if (init.form) {
    headers.set('Content-Type', 'application/x-www-form-urlencoded')
    body = new URLSearchParams(init.form).toString()
  }
  const res = await fetch(url, { ...init, headers, body })
  const text = await res.text()
  if (!res.ok) throw new HttpError(res.status, text, url)
  let data: unknown = text
  if (text && (res.headers.get('content-type') ?? '').includes('json')) data = JSON.parse(text)
  return { data: data as T, headers: res.headers, status: res.status }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
