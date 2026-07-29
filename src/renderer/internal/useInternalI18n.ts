import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_LOCALE,
  catalogs,
  interpolate,
  type Locale,
  type MessageKey
} from '@shared/i18n/catalog.js'
import { bridgeAvailable, invoke, subscribe } from './bridge.js'

/**
 * Translation for an internal page.
 *
 * Separate from the chrome UI's `I18nProvider` because these pages are content: they reach the
 * core through the narrow per-page bridge, not the full one, and they render in their own
 * renderer. Sharing the provider would mean sharing its imports.
 *
 * Extracted from the start page, which grew its own copy first. A second copy on the history page
 * would have been the point where the two started answering differently — and the first of them
 * already had a subtlety worth keeping in one place: `t` changes identity when the catalogue
 * arrives, so an effect that depends on it re-runs on every language change.
 *
 * The bundled catalogue is the initial value rather than a loading state. A page that renders its
 * own message keys for one frame looks broken; the default locale's text is at worst the wrong
 * language for a moment.
 */

export interface InternalI18n {
  locale: Locale
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  /** False until the core has answered, for pages that want to hold rendering back. */
  ready: boolean
}

export function useInternalI18n(): InternalI18n {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE)
  const [messages, setMessages] = useState<Record<string, string>>(() => ({
    ...catalogs[DEFAULT_LOCALE]
  }))
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!bridgeAvailable()) {
      // Reported through the same asynchronous path as everything else, so this effect has no
      // synchronous state write in it.
      queueMicrotask(() => {
        if (!cancelled) setReady(true)
      })
      return () => {
        cancelled = true
      }
    }

    const load = (): void => {
      void invoke('i18n:getCatalog')
        .then((catalog) => {
          if (cancelled) return
          setLocale(catalog.locale)
          setMessages(catalog.messages)
        })
        .finally(() => {
          if (!cancelled) setReady(true)
        })
    }

    load()

    /*
      Re-read when the language changes, which the chrome UI's `I18nProvider` has always done and
      these pages never did — so changing the language switched every window's chrome immediately and
      left every open internal tab in the old language until it was reloaded.

      `locale:changed` rather than `settings:changed`, and every internal page is granted it: the
      event carries the resolved locale alone, so a page can follow the language without being handed
      the user's configuration. The core decides when it moved, which is why this reloads
      unconditionally instead of comparing against the locale it already holds.
    */
    const unsubscribe = subscribe('locale:changed', () => {
      load()
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>): string =>
      // The shared interpolator, so `{app}` and every other placeholder mean the same thing here
      // as in the core.
      interpolate(messages[key] ?? catalogs[DEFAULT_LOCALE][key] ?? key, params),
    [messages]
  )

  return { locale, t, ready }
}
