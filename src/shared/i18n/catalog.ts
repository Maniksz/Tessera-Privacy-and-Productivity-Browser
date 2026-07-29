/**
 * Message catalogue (spec 7: no hard-coded strings, German and English at
 * minimum).
 *
 * The messages live one file per locale — `catalog.en.ts`, `catalog.de.ts`. What is left
 * here is the machinery over them: the locale union, the lookup, the placeholder rules.
 * Holding both literals made this by a wide margin the longest file in the repository, so
 * the twenty lines of logic below sat behind eleven hundred lines of prose that no change to
 * the logic ever touched.
 *
 * Split by locale rather than by namespace because a renderer only ever renders one language,
 * so per-locale modules are the shape a per-locale chunk needs. They are not that chunk yet:
 * `catalogs` names both modules eagerly and the bundler still emits them together. Making
 * the second locale load lazily is a separate change with real risk — the catalogue is
 * fetched before first paint — and separating the sources is the half of it that costs
 * nothing.
 *
 * `en` is the reference catalogue; every other locale is checked against its keys
 * by the compiler, so a translation can never silently miss an entry or carry a
 * stale one.
 *
 * Deliberately dependency-free: every renderer imports this to render text, so a
 * validation library here would end up in the UI bundle. `localeSchema` lives in
 * `schema.ts` for that reason.
 */

import { PRODUCT_NAME } from '../product.js'
import { de } from './catalog.de.js'
import { en, type Catalog, type MessageKey } from './catalog.en.js'

// Re-exported because the key union is what thirty callers import; which file the literal it
// is derived from happens to live in is not their business, and moving it must not become
// thirty edits.
export type { MessageKey }

export const LOCALES = ['de', 'en'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

export const catalogs: Readonly<Record<Locale, Catalog>> = { de, en }

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

export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>
): string {
  // No fallback chain: `Catalog` is a total record over `MessageKey`, and the
  // compiler enforces that every locale covers every key. A `??` here would be
  // dead code pretending to be a safety net.
  return interpolate(catalogs[locale][key], params)
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
