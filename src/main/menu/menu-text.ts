import { interpolate, translate, type Locale, type MessageKey } from '@shared/i18n/catalog.js'
import { de } from './menu-text.de.js'
import { en, type MenuText, type MenuTextKey } from './menu-text.en.js'

/**
 * The native menus' own labels, kept in the core beside the only code that builds those menus.
 *
 * ## Why this is not in `shared/i18n/catalog.*`
 *
 * The application menu, the page context menu and the blocker menu behind the address-bar badge are
 * all built by the main process with `Menu.buildFromTemplate`; no renderer has ever drawn one. In
 * the catalogue their labels were nevertheless downloaded and parsed by every renderer before first
 * paint, in both languages, and after the autofill merge they were what held the `catalog-*.js` chunk
 * over the budget `tests/architecture.test.ts` sets for it — which that test asks to be answered
 * structurally rather than by raising the number a third time. This is that answer, on the
 * precedent `main/settings/settings-text.ts` set and `main/updates/update-text.ts` followed.
 *
 * ## What stayed in the catalogue, and why
 *
 * A `menu.*` key stays where a renderer or a shared module reads it too, because moving it would
 * take the label away from a surface that draws it:
 *
 *   - `menu.view.zoomIn`, `zoomOut`, `zoomReset` — the zoom buttons on the tile bar;
 *   - `menu.window` — the tab strip's accessible name;
 *   - `menu.tools.downloads` — the downloads panel's button to the full list;
 *   - `menu.split.layout*` — `LAYOUT_LABELS` in `shared/split/labels.ts`, which the layout button,
 *     its menu surface and the Split View menu all read.
 *
 * The menus reach those, and every other catalogue key they show (`page.*`, `reader.title`,
 * `updates.checkNow`), through `menuLabel`, which reads this table for a key it has and the
 * catalogue for any other. No key is in both, so which table answers is decided by the key alone;
 * `tests/menu-text.test.ts` holds the two to that, and `tests/architecture.test.ts` checks that no
 * renderer bundle carries a key from here.
 *
 * The cost, stated as `update-text.ts` states it: these labels are not reachable from `translate()`,
 * they are not in the `Catalog` type, and the catalogue's checks in `tests/ipc-contract.test.ts` do
 * not see them. `tests/menu-text.test.ts` writes those checks out again for this table.
 */

export type { MenuText, MenuTextKey }

/** Both locales' tables. Exported for the tests that hold them to one another. */
export const menuTexts: Readonly<Record<Locale, MenuText>> = { de, en }

/** A label the menus may show: one of their own, or one they share with a renderer. */
export type MenuLabelKey = MenuTextKey | MessageKey

export function isMenuTextKey(key: string): key is MenuTextKey {
  // `Object.hasOwn` rather than `in`: the table is a plain object literal, and `in` would answer
  // yes for `toString`.
  return Object.hasOwn(en, key)
}

export function menuLabel(
  locale: Locale,
  key: MenuLabelKey,
  params?: Readonly<Record<string, string | number>>
): string {
  // No fallback, for the reason `translate` has none: `MenuText` is a total record over its keys,
  // and the compiler holds every locale to it. `{app}` works because `interpolate` is the
  // catalogue's own — one set of rules for what a placeholder means, wherever the label lives.
  return isMenuTextKey(key)
    ? interpolate(menuTexts[locale][key], params)
    : translate(locale, key, params)
}
