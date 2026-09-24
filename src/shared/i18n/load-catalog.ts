/**
 * The bundled catalogues, one chunk per locale, for a renderer that needs one.
 *
 * ## Why this exists
 *
 * The renderer catalogue used to be one chunk holding both languages, fetched by every renderer before
 * its first paint — for a renderer that only ever shows one of them. It stood at 47.18 of the 48 kB its
 * budget allows (`tests/architecture.test.ts`), with Phase D's text still to come, and KTD20 rules out
 * raising the number. One `import()` per locale below is what makes the bundler emit `catalog.en-….js`
 * and `catalog.de-….js` as separate chunks, and each renderer loads at most the one it shows.
 *
 * ## Who loads what
 *
 * - **The chrome UI, the overlay and every privileged internal page load no catalogue chunk at all.**
 *   The core resolves the language and sends the messages over `i18n:getCatalog`, as it always did; the
 *   bundled English that sat under them was only ever the initial value and a fallback for a key the core
 *   did not send — and the core's answer is total by construction (`{ ...catalogs[locale] }` over a
 *   compiler-checked record). The initial value is now the core's answer itself, awaited before the first
 *   render, which also ends the frame of English a German user used to see (see `i18n.tsx`).
 * - **`tessera://about` and the HTTPS-only interstitial load exactly their language.** They have no bridge
 *   to ask (`bundled-i18n.ts` says why), so the entry loads the chunk its `lang=` names before it renders.
 * - **The reference catalogue is loaded when there is no answer to stand on:** a call that failed, a page
 *   without a bridge, a core that answered with no messages. `withReference` does that, before the first
 *   render, so the fallback reads English rather than message keys — the choice the renderers always made.
 *
 * Deliberately free of bridge code and of zod, like the rest of `shared/i18n` a renderer reaches.
 */

import type { Catalog, MessageKey } from './catalog.en.js'
import { DEFAULT_LOCALE, type Locale } from './locale.js'

/**
 * One literal `import()` per locale, and it has to be literal: a template like `./catalog.${locale}.js`
 * would make the bundler guess at a glob, and a `Record` keyed by `Locale` makes a new locale without a
 * loader a compile error.
 */
const importers: Readonly<Record<Locale, () => Promise<Catalog>>> = {
  de: async () => (await import('./catalog.de.js')).de,
  en: async () => (await import('./catalog.en.js')).en
}

const requested = new Map<Locale, Promise<Catalog>>()
const loaded = new Map<Locale, Catalog>()

/** Loads one locale's chunk, once; every later call answers the same promise. */
export function loadCatalog(locale: Locale): Promise<Catalog> {
  const known = requested.get(locale)
  if (known !== undefined) return known
  const loading = importers[locale]().then((catalog) => {
    loaded.set(locale, catalog)
    return catalog
  })
  requested.set(locale, loading)
  return loading
}

/** A locale's catalogue if its chunk has arrived, without waiting for it. */
export function loadedCatalog(locale: Locale): Catalog | undefined {
  return loaded.get(locale)
}

/** What `i18n:getCatalog` answers: the language the core resolved, and its messages. */
export interface ResolvedCatalog {
  readonly locale: Locale
  readonly messages: Readonly<Record<string, string>>
}

/** Standing in for an answer that never came: the default locale, and nothing of the core's. */
export const NO_ANSWER: ResolvedCatalog = { locale: DEFAULT_LOCALE, messages: {} }

/**
 * The one fallback rule for a key: the core's message, then the reference catalogue if it is loaded, then
 * the key itself.
 *
 * The reference rather than the key, because an untranslated string is the wrong language for a moment and
 * a visible key is a bug report — the choice `useInternalI18n` and `I18nProvider` always made. The key is
 * the last resort for a reference nobody loaded, which `withReference` makes a state no renderer starts in.
 */
export function messageFor(messages: Readonly<Record<string, string>>, key: MessageKey): string {
  return messages[key] ?? loadedCatalog(DEFAULT_LOCALE)?.[key] ?? key
}

/**
 * The core's answer, with the reference catalogue loaded behind it when the answer has nothing to show.
 *
 * Only an empty answer triggers it. The real core never sends one; `NO_ANSWER` is empty, and so is every
 * test double that answers `{}`, and for those the fallback is the whole catalogue.
 */
export async function withReference(answer: ResolvedCatalog): Promise<ResolvedCatalog> {
  if (Object.keys(answer.messages).length === 0) await loadCatalog(DEFAULT_LOCALE)
  return answer
}
