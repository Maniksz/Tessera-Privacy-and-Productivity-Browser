import { useCallback, useEffect, useState } from 'react'
import { interpolate, type Locale, type MessageKey } from '@shared/i18n/locale.js'
import {
  NO_ANSWER,
  messageFor,
  withReference,
  type ResolvedCatalog
} from '@shared/i18n/load-catalog.js'
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
 * ## The first render already speaks the page's language
 *
 * The bundled English catalogue used to be the initial value, on the argument that a page rendering its
 * own message keys for one frame looks broken and the wrong language for a moment does not. It was that
 * moment for every German user on every internal page — and it cost each page both languages' chunk for
 * it. Each page's entry now calls `primeInternalI18n` and renders once it has settled, so the hook starts
 * from the core's answer. Without a prime — a component test rendering a page on its own — the hook starts
 * from no answer and asks on mount, as it always did.
 */

export interface InternalI18n {
  locale: Locale
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  /** False until the core has answered, for pages that want to hold rendering back. */
  ready: boolean
}

function requestCatalog(): Promise<ResolvedCatalog> {
  const answer = bridgeAvailable()
    ? invoke('i18n:getCatalog').catch(() => NO_ANSWER)
    : Promise.resolve(NO_ANSWER)
  return answer.then(withReference)
}

/** What the entry learned before the first render; every hook on the page starts from it. */
let primed: ResolvedCatalog | undefined

/**
 * Asks the core for the page's language before anything renders. Never rejects: a page that could not
 * ask renders in the default locale rather than not at all.
 */
export async function primeInternalI18n(): Promise<void> {
  primed = await requestCatalog()
}

export function useInternalI18n(): InternalI18n {
  const [catalog, setCatalog] = useState<ResolvedCatalog>(() => primed ?? NO_ANSWER)
  const [ready, setReady] = useState(primed !== undefined)

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
        .then(withReference)
        .then((next) => {
          // Kept current, so a hook that mounts after a language change starts in the new language
          // rather than in the one the page loaded with.
          if (primed !== undefined) primed = next
          if (!cancelled) setCatalog(next)
        })
        .finally(() => {
          if (!cancelled) setReady(true)
        })
    }

    // The entry's answer is this page's answer; it is not asked for again per hook.
    if (primed === undefined) load()

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
      interpolate(messageFor(catalog.messages, key), params),
    [catalog]
  )

  return { locale: catalog.locale, t, ready }
}
