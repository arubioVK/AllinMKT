import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Job } from '@shared/types'
import { api } from './api'
import { useToast } from '../components/toast'
import { locale, t } from './i18n'

// Las tareas viven en el proceso principal. Aquí solo las reflejamos y avisamos con un toast
// cuando una termina, estés en la vista que estés.

const Ctx = createContext<Job[]>([])
export const useJobs = (): Job[] => useContext(Ctx)

export function JobsProvider({ children }: { children: ReactNode }) {
  const toast = useToast()
  const [jobs, setJobs] = useState<Job[]>([])
  const prev = useRef(new Map<string, Job['status']>())

  useEffect(() => {
    const apply = (list: Job[]): void => {
      for (const j of list) {
        const before = prev.current.get(j.id)
        if (before === 'running' && j.status === 'done') toast(`${t('{label}: listo', { label: j.label })} · ${j.summary}`, 'success')
        if (before === 'running' && j.status === 'error') toast(`${j.label}: ${j.error}`, 'error')
      }
      prev.current = new Map(list.map((j) => [j.id, j.status]))
      setJobs(list)
    }
    api.jobs.list().then(apply).catch(() => {})
    return api.onJobs(apply)
  }, [toast])

  return <Ctx.Provider value={jobs}>{children}</Ctx.Provider>
}

/** Texto de progreso: "Escribiendo… 1.234 caracteres · 0:42". */
export function jobProgress(j: Job, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - new Date(j.startedAt).getTime()) / 1000))
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  const chars = j.chars ? ` ${t('{n} caracteres', { n: j.chars.toLocaleString(locale()) })}` : ''
  return `${j.stage || t('En cola')}…${chars} · ${time}`
}

/** Re-renderiza cada segundo mientras haya algo en marcha, para que avance el cronómetro. */
export function useTick(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}
