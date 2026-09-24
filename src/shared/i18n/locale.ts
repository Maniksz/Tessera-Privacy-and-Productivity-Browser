/**
 * The machinery over the message catalogue, without a single message in it.
 *
 * Split out of `catalog.ts` so a renderer can name a locale, interpolate a sentence and resolve an OS
 * language without importing both catalogues to do it. `catalog.ts` holds `catalogs`, which names every
 * locale eagerly — right for the core, which renders in whatever language the setting says and has one
 * bundle anyway, and wrong for a renderer, which only ever shows one language and gets it from the core
 * or from `load-catalog.ts`, one chunk per locale. A value import of `catalog.ts` from anything a renderer
 * reaches would put every language back into every renderer; `tests/architecture.test.ts` checks it does
 * not happen.
 *
 * `catalog.ts` re-exports everything here, so the core and the tests keep importing one module.
 *
 * Deliberately dependency-free for the same reason `catalog.ts` always was: every renderer imports this,
 * so a validation library here would end up in the UI bundle. `localeSchema` lives in `schema.ts`.
 */

import { PRODUCT_NAME } from '../product.js'

// Type-only, so erased: the key union is read off the English literal, and naming it costs no bytes.
export type { Catalog, MessageKey } from './catalog.en.js'

export const LOCALES = ['de', 'en'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * Fills `{placeholders}` in a message.
 *
 * `{app}` is always available, without any caller passing it. The product name appears inside
 * a dozen translated sentences, and a literal in each of them would mean the rename had to
 * touch prose in two languages — where a search-and-replace also hits the word in sentences
 * that were never about the product. See `shared/product.ts`.
 *
 * Exported because the renderers interpolate catalogues they received over IPC rather than the
 * bundled ones, and there must be exactly one set of rules for what a placeholder means.
 */
export function interpolate(
  template: string,
  params?: Readonly<Record<string, string | number>>
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (name === 'app') return PRODUCT_NAME
    const value = params?.[name]
    return value === undefined ? match : String(value)
  })
}

/** Picks the closest supported locale for an OS locale string like `de-AT`. */
export function resolveLocale(candidate: string | undefined): Locale {
  if (!candidate) return DEFAULT_LOCALE
  const lower = candidate.toLowerCase()
  for (const locale of LOCALES) {
    if (lower === locale || lower.startsWith(`${locale}-`)) return locale
  }
  return DEFAULT_LOCALE
}
