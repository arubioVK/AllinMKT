import { randomUUID } from 'node:crypto'
import { BrowserWindow, Notification } from 'electron'
import { tr } from './i18n'
import type { Job, JobKind } from '@shared/types'
import { log } from './db'

// Tareas largas (generar guiones y, más adelante, vídeos) que siguen en marcha aunque cambies
// de vista o cierres la ventana a la bandeja. Viven en el proceso principal y se pierden al salir
// de la app; lo que producen ya queda guardado en la base de datos.

const jobs = new Map<string, Job>()
const KEEP = 20

let notify: (list: Job[]) => void = () => {}
/** El módulo IPC se registra aquí para avisar a la interfaz (evita una importación circular). */
export function onJobsChange(fn: (list: Job[]) => void): void {
  notify = fn
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function emit(): void {
  // Guardamos solo las últimas tareas terminadas; las que están en marcha nunca se descartan.
  const finished = listJobs().filter((j) => j.status !== 'running')
  for (const j of finished.slice(KEEP)) jobs.delete(j.id)
  notify(listJobs())
}

function update(id: string, patch: Partial<Job>): void {
  const j = jobs.get(id)
  if (!j) return
  jobs.set(id, { ...j, ...patch })
  emit()
}

export interface JobContext {
  /** Actualiza el progreso visible (texto corto y, si se conoce, caracteres generados). */
  progress: (p: { stage?: string; chars?: number }) => void
}

export interface JobResult {
  /** Ids de lo creado (guiones, vídeos...), para enlazarlo desde la interfaz. */
  resultIds: string[]
  /** Texto de la notificación al terminar. */
  summary: string
}

/** Lanza la tarea sin esperarla y devuelve su id al momento. */
export function startJob(kind: JobKind, label: string, run: (ctx: JobContext) => Promise<JobResult>, refId: string | null = null): Job {
  const job: Job = { id: randomUUID(), kind, label, refId, status: 'running', stage: '', chars: 0, startedAt: new Date().toISOString(), finishedAt: null, error: '', resultIds: [], summary: '' }
  jobs.set(job.id, job)
  emit()

  let last = 0
  const ctx: JobContext = {
    progress: (p) => {
      // Los deltas llegan muy seguidos: avisamos a la interfaz como mucho cada 300 ms.
      const t = Date.now()
      const j = jobs.get(job.id)
      if (!j) return
      jobs.set(job.id, { ...j, stage: p.stage ?? j.stage, chars: p.chars ?? j.chars })
      if (t - last > 300) {
        last = t
        emit()
      }
    }
  }

  run(ctx)
    .then((r) => {
      update(job.id, { status: 'done', finishedAt: new Date().toISOString(), resultIds: r.resultIds, summary: r.summary })
      notifyDesktop(tr('{label}: listo', { label }), r.summary)
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      log('error', kind === 'video' ? 'video' : 'contenido', `${label}: ${msg}`)
      update(job.id, { status: 'error', finishedAt: new Date().toISOString(), error: msg })
      notifyDesktop(tr('{label}: error', { label }), msg.slice(0, 180))
    })
  return job
}

export function dismissJob(id: string): void {
  if (jobs.get(id)?.status === 'running') return
  jobs.delete(id)
  emit()
}

/** Notificación del sistema solo si la ventana no está a la vista (p. ej. en la bandeja). */
function notifyDesktop(title: string, body: string): void {
  const visible = BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.isFocused())
  if (!visible && Notification.isSupported()) new Notification({ title, body }).show()
}
