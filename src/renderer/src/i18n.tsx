import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_LOCALE, catalogs, interpolate, type Locale, type MessageKey } from '@shared/i18n/catalog.js'
import { invoke, subscribe } from './bridge.js'

/**
 * Translation for the chrome UI (spec 7: no hard-coded strings).
 *
 * The catalogue is fetched from the core rather than bundled per locale, so a
 * language change takes effect immediately in open windows without a reload —
 * the same live-update rule that applies to every other setting (spec 5).
 */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/**
 * The value a component gets with no provider above it.
 *
 * It interpolates, which the first version did not — it returned the raw catalogue entry, so a label
 * built from `{name}` rendered the braces. In the running application every surface sits inside the
 * provider, so nothing showed it; a component test rendering one part on its own did, immediately.
 * A fallback that behaves differently from the real thing is a fallback that hides defects.
 */
const I18nContext = createContext<{ locale: Locale; t: Translate }>({
  locale: DEFAULT_LOCALE,
  t: (key, params) => interpolate(catalogs[DEFAULT_LOCALE][key] ?? key, params)
})

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE)
  const [messages, setMessages] = useState<Record<string, string>>(() => ({
    ...catalogs[DEFAULT_LOCALE]
  }))

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      const catalog = await invoke('i18n:getCatalog')
      if (cancelled) return
      setLocale(catalog.locale)
      setMessages(catalog.messages)
    }

    void load()

    const unsubscribe = subscribe('settings:changed', ({ changed }) => {
      if ('appearance.uiLanguage' in changed) void load()
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const value = useMemo(() => {
    const t: Translate = (key, params) => {
      // The shared interpolator, so `{app}` and every other placeholder mean the same thing
      // here as in the core.
      return interpolate(messages[key] ?? catalogs[DEFAULT_LOCALE][key] ?? key, params)
    }
    return { locale, t }
  }, [locale, messages])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): { locale: Locale; t: Translate } {
  return useContext(I18nContext)
}
