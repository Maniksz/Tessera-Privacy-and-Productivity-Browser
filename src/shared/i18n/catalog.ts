/**
 * Message catalogue (spec 7: no hard-coded strings, German and English at
 * minimum).
 *
 * The messages live one file per locale — `catalog.en.ts`, `catalog.de.ts`. What is left
 * here is `catalogs`, which names both of them, and the lookup over it. Holding both literals
 * made this by a wide margin the longest file in the repository, so the twenty lines of logic
 * sat behind eleven hundred lines of prose that no change to the logic ever touched.
 *
 * **This module is for the core and the tests, not for a renderer.** `catalogs` imports every
 * locale eagerly, which is what the core wants — one bundle, parsed once, rendering in whatever
 * language the setting says. A renderer only ever shows one language, so it imports the
 * machinery from `locale.ts` and gets its messages either from the core (`i18n:getCatalog`) or,
 * on the two pages that have no bridge, from `load-catalog.ts`, which loads one locale's chunk
 * and nothing else. `tests/architecture.test.ts` fails if a renderer reaches this file again.
 *
 * `en` is the reference catalogue; every other locale is checked against its keys
 * by the compiler, so a translation can never silently miss an entry or carry a
 * stale one.
 *
 * Deliberately dependency-free: a validation library here would reach every caller.
 * `localeSchema` lives in `schema.ts` for that reason.
 */

import { de } from './catalog.de.js'
import { en, type Catalog, type MessageKey } from './catalog.en.js'
import { interpolate, type Locale } from './locale.js'

// Re-exported so the core and the tests keep importing one module; the machinery itself lives in
// `locale.ts`, where a renderer can reach it without reaching the catalogues.
export {
  DEFAULT_LOCALE,
  LOCALES,
  interpolate,
  isLocale,
  resolveLocale,
  type Locale
} from './locale.js'

// Re-exported because the key union is what thirty callers import; which file the literal it
// is derived from happens to live in is not their business, and moving it must not become
// thirty edits.
export type { MessageKey }

export const catalogs: Readonly<Record<Locale, Catalog>> = { de, en }

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
