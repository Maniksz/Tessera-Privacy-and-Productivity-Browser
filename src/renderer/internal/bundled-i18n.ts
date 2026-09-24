import {
  interpolate,
  isLocale,
  resolveLocale,
  type Locale,
  type MessageKey
} from '@shared/i18n/locale.js'
import { loadCatalog, loadedCatalog, messageFor } from '@shared/i18n/load-catalog.js'

/**
 * Translation for an internal page served *without* a bridge: `tessera://about`, and the HTTPS-only
 * interstitial after it.
 *
 * `useInternalI18n` asks the core for the catalogue it resolved from the language setting. A page
 * outside `INTERNAL_PAGES` has no bridge to ask, and giving it one would make it privileged — which for
 * the interstitial would switch HTTPS-only off, since the navigation policy refuses a redirect to a
 * privileged page. So these pages pick between the bundled catalogues themselves.
 *
 * The `lang` parameter of their own address comes first: the core puts the resolved interface language
 * there whenever it opens one of them (the pipeline's redirect, Help › About). `navigator.language` is
 * only the fallback, and a poor one — on a page outside `INTERNAL_PAGES` the content preload's locale
 * masking applies as it does to any site, so with `fingerprint.normalizeAcceptLanguage` on the page
 * reads the uniform `en-US` whatever the setting says. Only a language with a catalogue is taken from
 * the address; anything else there is ignored rather than trusted, since a redirect from any site can
 * reach these pages with a parameter of its own.
 *
 * ## One language's chunk, loaded before the first render
 *
 * The catalogues are one chunk per locale (`load-catalog.ts`), and these two pages are the only renderers
 * that load one. The entry calls `prepareBundledI18n` and renders when it has settled, so `bundledI18n` —
 * which the page calls while rendering, and which cannot wait — finds the chosen language already there.
 * Loading the reference as well is not needed: the chosen catalogue is total over the keys.
 *
 * Kept apart from `useInternalI18n.ts` so the page's bundle carries no bridge code at all.
 */

export interface BundledI18n {
  locale: Locale
  t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string
}

/** The language the page's address asks for, else the browser's, else the default. */
export function bundledLocale(
  search: string = location.search,
  language: string | undefined = navigator.language
): Locale {
  const requested = new URLSearchParams(search).get('lang')
  return isLocale(requested) ? requested : resolveLocale(language)
}

/** Loads the chunk `bundledI18n` is about to need; the entry awaits it before the first render. */
export async function prepareBundledI18n(
  search: string = location.search,
  language: string | undefined = navigator.language
): Promise<void> {
  await loadCatalog(bundledLocale(search, language))
}

export function bundledI18n(
  search: string = location.search,
  language: string | undefined = navigator.language
): BundledI18n {
  const locale = bundledLocale(search, language)
  // The chosen catalogue, else the reference, else the key: `messageFor`'s rule, over whatever arrived.
  const messages = loadedCatalog(locale) ?? {}
  return { locale, t: (key, params) => interpolate(messageFor(messages, key), params) }
}
