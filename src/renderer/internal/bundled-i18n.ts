import { resolveLocale, translate, type Locale, type MessageKey } from '@shared/i18n/catalog.js'

/**
 * Translation for an internal page served *without* a bridge: `tessera://about`, and the HTTPS-only
 * interstitial after it.
 *
 * `useInternalI18n` asks the core for the catalogue it resolved from the language setting. A page
 * outside `INTERNAL_PAGES` has no bridge to ask, and giving it one would make it privileged — which for
 * the interstitial would switch HTTPS-only off, since the navigation policy refuses a redirect to a
 * privileged page. So these pages pick between the bundled catalogues by `navigator.language`, and
 * fall back to the default locale for anything without a catalogue.
 *
 * That is the browser's language, not the language setting, and on a page outside `INTERNAL_PAGES` the
 * content preload's locale masking applies to it as it does to any site — with
 * `fingerprint.normalizeAcceptLanguage` on, the page reads the uniform `en-US`.
 *
 * Kept apart from `useInternalI18n.ts` so the page's bundle carries no bridge code at all.
 */

export interface BundledI18n {
  locale: Locale
  t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string
}

export function bundledI18n(language: string | undefined = navigator.language): BundledI18n {
  const locale = resolveLocale(language)
  return { locale, t: (key, params) => translate(locale, key, params) }
}
