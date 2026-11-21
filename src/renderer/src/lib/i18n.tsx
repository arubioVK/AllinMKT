import { useEffect, useState, type ReactNode } from 'react'
import { LOCALE, translate, type Lang, type Vars } from '@shared/i18n'
import { api } from './api'

// El idioma vive en una variable del módulo para que t() funcione también fuera de los
// componentes (formatos de fecha, etiquetas). Al cambiarlo se vuelve a montar toda la interfaz.
let current: Lang = 'es'

export const t = (text: string, vars?: Vars): string => translate(current, text, vars)
export const lang = (): Lang => current
export const locale = (): string => LOCALE[current]

export function I18nProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<Lang | null>(null)
  useEffect(() => {
    const load = (): void => {
      void api.settings.get().then((s) => {
        current = s.language ?? 'es'
        document.documentElement.lang = current
        setValue(current)
      })
    }
    load()
    return api.onChanged(load)
  }, [])
  if (!value) return null
  return <div key={value} className="contents">{children}</div>
}
