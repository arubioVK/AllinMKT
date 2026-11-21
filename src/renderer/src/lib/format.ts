import { locale, t } from './i18n'

export const num = (n: number): string => new Intl.NumberFormat(locale()).format(Math.round(n))
export const compact = (n: number): string =>
  n >= 10000 ? new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n) : num(n)
export const pct = (n: number, digits = 1): string => `${(n * 100).toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`

export function delta(cur: number, prev: number): { text: string; tone: 'pos' | 'neg' | 'flat' } {
  if (prev === 0 && cur === 0) return { text: '—', tone: 'flat' }
  if (prev === 0) return { text: `+${num(cur)} (${t('nuevo')})`, tone: 'flat' }
  const d = (cur - prev) / prev
  if (Math.abs(d) < 0.005) return { text: `${(0).toLocaleString(locale(), { minimumFractionDigits: 1 })} %`, tone: 'flat' }
  const sign = d > 0 ? '+' : '−'
  return { text: `${sign}${Math.abs(d * 100).toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })} %`, tone: d > 0 ? 'pos' : 'neg' }
}

export const localIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const dayLabel = (iso: string): string =>
  new Date(iso).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' })

export const timeLabel = (iso: string): string => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })

export function relativeDay(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const diff = Math.round((new Date(localIso(d) + 'T12:00').getTime() - new Date(localIso(today) + 'T12:00').getTime()) / 86400_000)
  if (diff === 0) return t('Hoy, {time}', { time: timeLabel(iso) })
  if (diff === 1) return t('Mañana, {time}', { time: timeLabel(iso) })
  if (diff === -1) return t('Ayer, {time}', { time: timeLabel(iso) })
  return `${dayLabel(iso)}, ${timeLabel(iso)}`
}

export const shortDate = (iso: string): string => new Date(`${iso}T12:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })
