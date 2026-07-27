import type { MenuItemConstructorOptions } from 'electron'
import type { Platform } from '@shared/model.js'
import { TAB_BY_INDEX_ACCELERATORS } from '@shared/shortcuts/bindings.js'
import type { StripPosition } from '../browser/tab-strip-position.js'

/**
 * The nine keys that select a tab by its place in the strip: `Control+1` … `Control+8` and
 * `Control+9`, or `Command+…` on macOS (spec 9).
 *
 * ## The bug this exists for
 *
 * The same one as `alternative-accelerators.ts`, one door further along: an accelerator only fires
 * where a menu item declares it, and none of these nine had an item. `lastTab` appeared nowhere under
 * `src/main` at all, and `TAB_BY_INDEX_ACCELERATORS` was read by nothing in `src/` — a table that
 * existed, that one test checked the length of, and that hung on nothing. All nine were listed as
 * working shortcuts and all nine did nothing.
 *
 * ## Why hidden items
 *
 * A hidden `MenuItem` still registers its accelerator, so these go through exactly the same path as
 * every other shortcut — one mechanism, not two — and the alternative was `before-input-event` on every
 * page, which means the browser inspecting every keystroke a website receives for the sake of a key it
 * can register outright. `escape` and `stop` are on that other path because they genuinely have to be;
 * see `browser/page-keys.ts` for what it costs.
 *
 * Hidden rather than visible because "Tab 3" is not an entry a menu can meaningfully name: nine rows in
 * the Window menu, eight of which are numbers, and the ninth a synonym for one of them whenever nine
 * tabs are open. It is also what keeps this from needing nine new catalogue keys for labels nobody will
 * read — see the note on the labels below.
 *
 * ## What the eight cannot do, and why that is not an omission here
 *
 * `advanced.customShortcuts` cannot rebind them. Overrides are keyed by `ShortcutAction`, and the
 * positional keys are not actions — they are one behaviour with eight keys rather than eight
 * behaviours, so there is nothing for a settings row to name. The consequence worth knowing is the
 * other direction: `findBindingConflicts` cannot see these keys either, so a user who rebinds an action
 * to `Control+4` is told there is no conflict while two menu items claim one key.
 */

export interface TabPositionAcceleratorOptions {
  platform: Platform
  /**
   * `acceleratorFor(platform, 'lastTab', overrides)`, resolved by the caller.
   *
   * Passed in rather than looked up here so the literal `accel('lastTab')` stays in `appMenu.ts`,
   * where the fitness test in `architecture.test.ts` scans for it — the test that exists because an
   * action with a binding and no item is invisible everywhere else. It also means a user override of
   * `lastTab` applies, which it should: unlike the eight, `lastTab` is a real `ShortcutAction` with a
   * row in the settings list.
   */
  lastTabAccelerator: string
  select(position: StripPosition): void
}

export function tabPositionAccelerators(
  options: TabPositionAcceleratorOptions
): MenuItemConstructorOptions[] {
  const { platform, lastTabAccelerator, select } = options

  const byIndex = TAB_BY_INDEX_ACCELERATORS[platform].map((accelerator, index) => {
    // The nth key names the nth tab, one-based: the table's own order is the whole mapping, so there
    // is no second table to keep in step with it.
    const position = index + 1
    return hidden(`Tab ${position}`, accelerator, () => select(position))
  })

  /*
    The last *position*, not the last tab used.

    Nothing this browser shows promises otherwise — the settings list has one row per action and no
    description — and the position is what makes the key a sibling of the eight above it rather than a
    different feature wearing the ninth key. Most-recently-used would also need a history of activations
    that nothing here keeps, and it is the reading a user cannot check by looking at the strip.
  */
  return [...byIndex, hidden('Last Tab', lastTabAccelerator, () => select('last'))]
}

/**
 * One hidden item.
 *
 * The label is never drawn, exactly as in `alternative-accelerators.ts`, and for the same two reasons
 * it is there at all: an item needs one to be an item rather than a separator, and anything printing
 * the menu into a bug report should say which key this is. Untranslated for the same reason — a string
 * no user can see does not belong in the catalogue, where it would have to be maintained in both
 * languages forever.
 */
function hidden(
  label: string,
  accelerator: string,
  click: () => void
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    visible: false,
    // macOS drops a hidden item's accelerator without this; Windows and Linux keep it either way.
    acceleratorWorksWhenHidden: true,
    click
  }
}
