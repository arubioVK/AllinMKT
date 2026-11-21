// Idioma de la interfaz. Las claves son el propio texto en español: así el código se sigue
// leyendo en español y, si falta una traducción, se muestra el original en vez de una clave rota.
import { EN } from './i18n.en'

export const LANGS = ['es', 'en'] as const
export type Lang = (typeof LANGS)[number]

export const LANG_LABEL: Record<Lang, string> = { es: 'Español', en: 'English' }
export const LOCALE: Record<Lang, string> = { es: 'es-ES', en: 'en-US' }

export type Vars = Record<string, string | number>

/** Traduce un texto en español al idioma pedido y sustituye los {marcadores}. */
export function translate(lang: Lang, text: string, vars?: Vars): string {
  const s = lang === 'en' ? (EN[text] ?? text) : text
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
