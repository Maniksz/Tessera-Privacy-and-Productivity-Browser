import type { Locale } from '@shared/i18n/catalog.js'
import { en, type SettingText, type SettingTextTable } from './settings-text.en.js'
import { de } from './settings-text.de.js'

/**
 * The settings screen's own prose, kept in the core and sent out with the descriptors.
 *
 * ## Why this is not in `shared/i18n/catalog.*`
 *
 * That is the obvious place and it is the wrong one, for two reasons that both bite before
 * anything is rendered.
 *
 * **The catalogue has no room.** It is one chunk holding *both* locales, and it is measured:
 * `tests/architecture.test.ts` budgets `catalog-*.js` at 46 kB and the built chunk is
 * 45 810 bytes. That is about a hundred and ninety bytes of headroom for seventy-six labels,
 * their descriptions and their enum member names, in two languages. Not close.
 *
 * **And the wrong screens would pay for it.** Every internal page — start, history,
 * bookmarks, downloads, passwords, reader — fetches the catalogue before first paint. Settings
 * prose in there is downloaded, parsed and held in memory by six screens that will never show
 * a single sentence of it, on every launch. The start page is the one the user sees first and
 * the one that must be quickest; it would carry the largest single block of text in the
 * application for nothing.
 *
 * Here, none of that happens. The strings live in the main process, which is not bundled for
 * the renderer at all, and exactly one screen ever asks for them: `settings:describe` resolves
 * them for the requested locale and they travel with the descriptors that screen was already
 * fetching. Zero bytes for every other page, one round trip for this one — and it is a round
 * trip that was already being made.
 *
 * The cost of the arrangement, stated so nobody has to discover it: these strings are not
 * reachable from `translate()`, they are not in the `Catalog` type, and the checks the
 * catalogue gets from `tests/ipc-contract.test.ts` do not see them. That is why the
 * equivalents — same keys in both locales, no empty strings, matching placeholders — are
 * written out again in `tests/settings-describe.test.ts`, together with the one the catalogue
 * cannot have: every setting in `settingDefinitions` has a label.
 *
 * ## Why the table is nested instead of keyed by the setting key
 *
 * `{ appearance: { theme: … } }` rather than a flat table of full keys, and this is not a
 * matter of taste either.
 *
 * `tests/architecture.test.ts` has a fitness function that asks whether anything actually
 * *reads* each setting, and its evidence is the key written as a quoted literal anywhere in
 * `src/`. A flat table would write all seventy-six of them — so every setting in the browser
 * would look implemented, including the fifteen the same test lists as declared-but-not-honoured.
 * The test would not fail quietly; it would fail loudly on its own staleness check and then be
 * "fixed" by deleting the debt list, and the browser would lose the only guard it has against a
 * switch that flips and does nothing. Nesting keeps a label from counting as an implementation,
 * which is exactly right: a label is not a reader.
 *
 * So the full key never appears as a literal in these three files. `settingTextFor` joins the
 * two halves at runtime instead. Anyone flattening this table for tidiness should expect the
 * settings fitness function to stop meaning anything.
 */

export type { SettingText, SettingTextTable }

/** The structural view the lookup needs; the per-locale files carry the exact shape. */
type AnyTable = Readonly<Record<string, Readonly<Record<string, SettingText>>>>

const tables: Readonly<Record<Locale, AnyTable>> = { de, en }

/** Splits a settings key into its group and its leaf, which is how the tables are nested. */
function partsOf(key: string): { group: string; leaf: string } | null {
  const dot = key.indexOf('.')
  // A key with no dot has no group, which is not a shape the table can hold. Answering `null`
  // rather than guessing is what lets the caller fall back visibly instead of silently.
  if (dot <= 0 || dot === key.length - 1) return null
  return { group: key.slice(0, dot), leaf: key.slice(dot + 1) }
}

/**
 * The text for one setting, or `undefined` when the table does not have it.
 *
 * `undefined` rather than a fabricated label, because the two are different situations and only
 * the caller can tell them apart: `describeSetting` wants a readable fallback so an unlabelled
 * setting still renders, while the fitness test wants the absence reported.
 */
export function settingTextFor(locale: Locale, key: string): SettingText | undefined {
  const parts = partsOf(key)
  if (parts === null) return undefined
  // `Object.hasOwn` before the read: these tables are plain object literals, so a key of
  // `constructor` or `toString` would otherwise resolve to something off the prototype and be
  // returned as if it were text.
  const group = tables[locale][parts.group]
  if (group === undefined || !Object.hasOwn(group, parts.leaf)) return undefined
  return group[parts.leaf]
}

/**
 * Every key one locale's table describes, as `group.leaf`.
 *
 * Built rather than listed, for the reason in the docblock. Exported for the tests that hold
 * the two locales to the same key set and hold the table to the definitions.
 */
export function settingTextKeys(locale: Locale): string[] {
  const table = tables[locale]
  return Object.keys(table).flatMap((group) =>
    Object.keys(table[group] ?? {}).map((leaf) => `${group}.${leaf}`)
  )
}

/**
 * A last-resort name derived from the key itself: `Block third party cookies`.
 *
 * This used to be how *every* label was produced, in the renderer, which is how the settings
 * screen came to be seventy-six English strings in a browser that ships in two languages. It
 * survives only as the answer for a key the table has not caught up with — a setting added
 * without text should be visible and editable rather than nameless, and the fitness test is
 * what makes sure that state does not reach a release.
 */
export function fallbackLabel(key: string): string {
  const parts = partsOf(key)
  const leaf = parts === null ? key : parts.leaf
  const spaced = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
