import { interpolate, type Locale } from '@shared/i18n/catalog.js'
import { de } from './update-text.de.js'
import { en, type UpdateText, type UpdateTextKey } from './update-text.en.js'

/**
 * The update check's own prose, kept in the core beside the only code that shows it.
 *
 * ## Why this is not in `shared/i18n/catalog.*`
 *
 * These sentences are read by `UpdateService.ts` and by nothing else. Every one of them ends up in
 * a native message box, which the main process draws; no renderer has ever rendered one. In the
 * catalogue they were nevertheless downloaded and parsed by every internal page before first
 * paint, in both languages — about four kilobytes of text for a surface none of those pages can
 * draw — and they were what pushed the `catalog-*.js` chunk past the budget
 * `tests/architecture.test.ts` sets for it, which that test asks to be answered structurally rather
 * than by raising the number a third time. This is that answer, on the precedent
 * `main/settings/settings-text.ts` set and argues in full.
 *
 * `updates.checkNow` stays in the catalogue, because it is not only the core's: the settings
 * screen renders it as a button, as well as the Help menu.
 *
 * The cost, stated so nobody has to discover it: these strings are not reachable from
 * `translate()`, they are not in the `Catalog` type, and the checks the catalogue gets from
 * `tests/ipc-contract.test.ts` do not see them. `tests/update-text.test.ts` writes those checks out
 * again for this table — same keys in both locales, no empty strings, matching placeholders.
 *
 * `{app}` still works: `interpolate` is the catalogue's own, so there is one set of rules for what
 * a placeholder means, wherever the sentence lives.
 */

export type { UpdateText, UpdateTextKey }

/** Both locales' tables. Exported for the tests that hold them to one another. */
export const updateTexts: Readonly<Record<Locale, UpdateText>> = { de, en }

export function updateText(
  locale: Locale,
  key: UpdateTextKey,
  params?: Readonly<Record<string, string | number>>
): string {
  // No fallback, for the reason `translate` has none: `UpdateText` is a total record over the
  // keys, and the compiler holds every locale to it.
  return interpolate(updateTexts[locale][key], params)
}
