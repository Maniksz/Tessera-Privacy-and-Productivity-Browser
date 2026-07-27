import type { MenuItemConstructorOptions } from 'electron'
import type { Platform } from '@shared/model.js'
import { SHORTCUT_ACTIONS, allAcceleratorsFor } from '@shared/shortcuts/bindings.js'

/**
 * Makes the *second* accelerator of an action fire.
 *
 * ## The bug this exists for
 *
 * `bindings.ts` gives several actions more than one key, and its own header says so: "the first
 * accelerator of an action is the primary binding shown in menus; the rest are equivalent
 * alternatives." They were not equivalent. They were not anything — a `MenuItem` carries exactly one
 * accelerator, `acceleratorFor` returns element zero, and nothing anywhere read the rest. So
 * `Control+PageDown`, `Alt+D`, `F6`, `F3`, `Control+F5`, `Control+Shift+I` and the numeric-keypad zoom
 * keys were listed in the settings screen, drawn in the shortcut list, and dead.
 *
 * This is the same failure as the one that made `Ctrl+L` do nothing, one level further in: there, the
 * action had no menu item; here, the item exists and declares one key out of two. The fitness test
 * that caught the first case only checked that `accel('action')` appeared somewhere, which an action
 * with two keys passes while half of them do nothing.
 *
 * ## Why hidden items rather than a key handler
 *
 * A hidden `MenuItem` still registers its accelerator, so the alternative goes through exactly the
 * same path as the primary — same handler, same enablement, same conflict with the system menu. The
 * other route would be `before-input-event` on every page's `webContents`, which means the browser
 * inspecting every keystroke a website receives, and a second, subtly different set of rules about
 * when a shortcut applies. One mechanism, not two.
 *
 * ## What it deliberately will not clone
 *
 * A checkbox item's handler reads `item.checked`, and a hidden clone's `checked` is its own, not the
 * visible item's — so cloning one would produce a key that always writes the same value. No action
 * with a checkbox item currently has a second key; the fitness test asserts every listed accelerator
 * is declared, so if one ever gains one, that test fails rather than the key silently misbehaving.
 */
export function withAlternativeAccelerators(
  template: readonly MenuItemConstructorOptions[],
  platform: Platform,
  overrides: Readonly<Record<string, string>> = {}
): MenuItemConstructorOptions[] {
  return expand(template, alternativesByPrimary(platform, overrides))
}

/**
 * Alternatives keyed by the accelerator a menu item would carry.
 *
 * Keyed by the primary rather than by action name because that is what a menu item exposes: the
 * template is plain data by the time it gets here, and matching on the string it already holds needs
 * no second table saying which item belongs to which action.
 *
 * A user override collapses an action to one key — `allAcceleratorsFor` returns just the override —
 * which is correct: someone who has chosen `Alt+K` for an action has not asked to keep the two
 * defaults as well.
 */
function alternativesByPrimary(
  platform: Platform,
  overrides: Readonly<Record<string, string>>
): ReadonlyMap<string, readonly string[]> {
  const byPrimary = new Map<string, readonly string[]>()
  for (const action of SHORTCUT_ACTIONS) {
    const all = allAcceleratorsFor(platform, action, overrides)
    const [primary] = all.slice(0, 1)
    if (primary === undefined || primary === '') continue
    const rest = all.slice(1)
    if (rest.length === 0) continue
    byPrimary.set(primary, rest)
  }
  return byPrimary
}

function expand(
  items: readonly MenuItemConstructorOptions[],
  byPrimary: ReadonlyMap<string, readonly string[]>
): MenuItemConstructorOptions[] {
  const expanded: MenuItemConstructorOptions[] = []
  for (const item of items) {
    expanded.push(withExpandedSubmenu(item, byPrimary))
    for (const alternative of clonesFor(item, byPrimary)) expanded.push(alternative)
  }
  return expanded
}

/** A submenu built from a template is an array; one built from a `Menu` is already registered. */
function withExpandedSubmenu(
  item: MenuItemConstructorOptions,
  byPrimary: ReadonlyMap<string, readonly string[]>
): MenuItemConstructorOptions {
  if (!Array.isArray(item.submenu)) return item
  return { ...item, submenu: expand(item.submenu, byPrimary) }
}

function clonesFor(
  item: MenuItemConstructorOptions,
  byPrimary: ReadonlyMap<string, readonly string[]>
): MenuItemConstructorOptions[] {
  const { accelerator, click, type } = item
  if (accelerator === undefined || click === undefined) return []
  // See the note above: a clone's `checked` is not the visible item's.
  if (type === 'checkbox' || type === 'radio') return []
  const alternatives = byPrimary.get(accelerator)
  if (alternatives === undefined) return []

  return alternatives.map((alternative) => ({
    // The label is never drawn. It is here so the item is a real menu entry rather than a separator,
    // and so anything printing the menu for a bug report says which key this is.
    label: `${item.label ?? ''} (${alternative})`,
    accelerator: alternative,
    visible: false,
    /*
      macOS drops a hidden item's accelerator unless this is set. Windows and Linux keep it either
      way; stating it removes the platform question from the reader's head.
    */
    acceleratorWorksWhenHidden: true,
    click
  }))
}
