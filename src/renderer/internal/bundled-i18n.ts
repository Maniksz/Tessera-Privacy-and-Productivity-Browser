import {
  isLocale,
  resolveLocale,
  translate,
  type Locale,
  type MessageKey
} from '@shared/i18n/catalog.js'

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
 * Kept apart from `useInternalI18n.ts` so the page's bundle carries no bridge code at all.
 */

export interface BundledI18n {
  locale: Locale
  t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string
}

export function bundledI18n(
  search: string = location.search,
  language: string | undefined = navigator.language
): BundledI18n {
  const requested = new URLSearchParams(search).get('lang')
  const locale = isLocale(requested) ? requested : resolveLocale(language)
  return { locale, t: (key, params) => translate(locale, key, params) }
}
