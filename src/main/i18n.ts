import { LOCALE, translate, type Vars } from '@shared/i18n'
import { getSettings } from './db'

// Textos del proceso principal que ve el usuario: bandeja, notificaciones y errores.
export const tr = (text: string, vars?: Vars): string => translate(getSettings().language ?? 'es', text, vars)
export const locale = (): string => LOCALE[getSettings().language ?? 'es']
