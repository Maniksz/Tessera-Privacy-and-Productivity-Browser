import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_LOCALE, interpolate, type Locale, type MessageKey } from '@shared/i18n/locale.js'
import {
  NO_ANSWER,
  messageFor,
  withReference,
  type ResolvedCatalog
} from '@shared/i18n/load-catalog.js'
import { invoke, subscribe } from './bridge.js'

/**
 * Translation for the chrome UI (spec 7: no hard-coded strings).
 *
 * The catalogue is fetched from the core rather than bundled per locale, so a
 * language change takes effect immediately in open windows without a reload —
 * the same live-update rule that applies to every other setting (spec 5).
 *
 * ## No catalogue in this bundle, and no English frame first
 *
 * This provider used to start from the bundled English catalogue and swap in the core's answer once it
 * arrived. That cost every renderer both languages' worth of chunk for a value that was on screen for one
 * frame — and that frame was the wrong language for every German user: the answer lands in an effect, and
 * an effect runs after the first paint. So the entry now asks first and renders second (`main.tsx`): the
 * first render already has the core's messages, and nothing from `shared/i18n/catalog.*` is in the bundle.
 * The overlay cannot wait (`overlay.tsx` says why), so it hands over the request instead of the answer.
 */

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/**
 * The core's catalogue, or the reference catalogue when there is none to be had.
 *
 * Never rejects: a window whose language could not be asked for is a window in English, not a window that
 * never renders.
 */
export function requestCatalog(): Promise<ResolvedCatalog> {
  return invoke('i18n:getCatalog')
    .catch(() => NO_ANSWER)
    .then(withReference)
}

/**
 * The value a component gets with no provider above it.
 *
 * It interpolates, which the first version did not — it returned the raw catalogue entry, so a label
 * built from `{name}` rendered the braces. In the running application every surface sits inside the
 * provider, so nothing showed it; a component test rendering one part on its own did, immediately.
 * A fallback that behaves differently from the real thing is a fallback that hides defects — so this is
 * the provider's own rule over an answer with nothing in it.
 */
const I18nContext = createContext<{ locale: Locale; t: Translate }>({
  locale: DEFAULT_LOCALE,
  t: (key, params) => interpolate(messageFor(NO_ANSWER.messages, key), params)
})

/**
 * `initial` is what the entry has for the first render: the core's answer when it could wait for it, the
 * request still in flight when it could not. Without one the provider asks on mount, which is what a test
 * rendering it on its own gets.
 */
export function I18nProvider({
  initial,
  children
}: {
  initial?: ResolvedCatalog | Promise<ResolvedCatalog>
  children: ReactNode
}): ReactNode {
  const [catalog, setCatalog] = useState<ResolvedCatalog>(() =>
    initial === undefined || initial instanceof Promise ? NO_ANSWER : initial
  )

  useEffect(() => {
    let cancelled = false
    // Only the latest request may land: the overlay's first request and a language change right after it
    // can answer in either order, and the older answer is the wrong language.
    let latest = 0
    const settle = (request: Promise<ResolvedCatalog>): void => {
      const mine = ++latest
      void request.then((next) => {
        if (!cancelled && mine === latest) setCatalog(next)
      })
    }

    // An answer the entry already awaited is not asked for twice.
    if (initial === undefined) settle(requestCatalog())
    else if (initial instanceof Promise) settle(initial)

    const unsubscribe = subscribe('settings:changed', ({ changed }) => {
      if ('appearance.uiLanguage' in changed) settle(requestCatalog())
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
    // Once per mount: `initial` is the first render's, and a later one would not be an answer to anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = useMemo(() => {
    const t: Translate = (key, params) => {
      // The shared interpolator, so `{app}` and every other placeholder mean the same thing
      // here as in the core.
      return interpolate(messageFor(catalog.messages, key), params)
    }
    return { locale: catalog.locale, t }
  }, [catalog])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): { locale: Locale; t: Translate } {
  return useContext(I18nContext)
}
