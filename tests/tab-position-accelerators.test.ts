import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { tabPositionAccelerators } from '@main/menu/tab-position-accelerators.js'
import { withAlternativeAccelerators } from '@main/menu/alternative-accelerators.js'
import {
  SHORTCUT_ACTIONS,
  TAB_BY_INDEX_ACCELERATORS,
  acceleratorFor
} from '@shared/shortcuts/bindings.js'
import { platformSchema, type Platform } from '@shared/model.js'
import type { StripPosition } from '@main/browser/tab-strip-position.js'

/**
 * The nine positional tab keys (spec 9).
 *
 * What breaks in the product if these rules are wrong:
 *
 *   - **A visible item** puts nine rows into the Window menu, eight of them numbers, and needs nine
 *     catalogue keys in both languages for labels that name nothing a menu can usefully name.
 *   - **A missing `acceleratorWorksWhenHidden`** makes macOS drop a hidden item's accelerator, which
 *     puts all nine keys back exactly where they were: listed in the settings screen and dead.
 *   - **An item whose handler ignores its own position** is the failure the length of
 *     `TAB_BY_INDEX_ACCELERATORS` cannot see — eight keys that all select the same tab pass every
 *     assertion about *which items exist*, which is how two other `*-items` modules scored in the
 *     fifties on their first mutation run.
 */

/** Every item in a template, submenus flattened, as `alternative-accelerators.test.ts` does it. */
function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])
  ])
}

function build(
  platform: Platform,
  select: (position: StripPosition) => void
): MenuItemConstructorOptions[] {
  return tabPositionAccelerators({
    platform,
    lastTabAccelerator: acceleratorFor(platform, 'lastTab'),
    select
  })
}

/** The click signature carries a menu item, a window and an event; none is read by these items. */
function press(item: MenuItemConstructorOptions): void {
  item.click?.(undefined as never, undefined, undefined as never)
}

describe('tabPositionAccelerators', () => {
  it('declares all nine keys of the platform it is given', () => {
    for (const platform of platformSchema.options) {
      const declared = build(platform, () => {}).map((item) => item.accelerator)
      expect(declared, platform).toEqual([
        ...TAB_BY_INDEX_ACCELERATORS[platform],
        acceleratorFor(platform, 'lastTab')
      ])
    }
  })

  it('selects the position its own key names', () => {
    /*
      One assertion per key, because this is the mapping and nothing else states it. An off-by-one here
      — or eight handlers closing over the same variable, which is how this is usually written wrong —
      leaves every key firing and the wrong tab arriving.
    */
    const select = vi.fn<(position: StripPosition) => void>()
    const items = build('win32', select)

    for (const [index, item] of items.entries()) {
      select.mockClear()
      press(item)
      // The ninth item is `Ctrl+9`; the first eight are their own position.
      expect(select.mock.calls, item.accelerator).toEqual([[index === 8 ? 'last' : index + 1]])
    }
  })

  it('asks the ninth key for the last position, not the last tab used', () => {
    // Most-recently-used is the other reading of "last tab", and it is the one no user can check
    // against the strip. Nothing this browser shows promises it; see the module.
    const select = vi.fn<(position: StripPosition) => void>()
    const [last] = build('darwin', select).slice(-1)

    expect(last?.accelerator).toBe('Command+9')
    if (last !== undefined) press(last)
    expect(select).toHaveBeenCalledWith('last')
  })

  it('hides every item and keeps its accelerator alive while hidden', () => {
    for (const platform of platformSchema.options) {
      for (const item of build(platform, () => {})) {
        expect(item.visible, `${platform} ${String(item.accelerator)}`).toBe(false)
        // Without this macOS registers nothing for a hidden item.
        expect(item.acceleratorWorksWhenHidden, `${platform} ${String(item.accelerator)}`).toBe(true)
      }
    }
  })

  it('gives every item a label, so none of them is a separator', () => {
    // Never drawn, and still required: an item with no label is not an item. Asserted as "present"
    // rather than by wording, because the wording is the one thing about it nobody will ever read.
    for (const item of build('linux', () => {})) {
      expect(item.label).toBeTruthy()
    }
  })

  it('honours a user override of lastTab and cannot be given one for the eight', () => {
    /*
      The asymmetry is the point. `lastTab` is a real `ShortcutAction` with a row in the settings list,
      so rebinding it must move the key. The eight are one behaviour with eight keys and not actions at
      all, so there is nothing for an override to name — and this says so, rather than leaving a reader
      to conclude the override was forgotten.
    */
    const items = tabPositionAccelerators({
      platform: 'win32',
      lastTabAccelerator: acceleratorFor('win32', 'lastTab', { lastTab: 'Alt+0' }),
      select: () => {}
    })

    const declared = items.map((item) => item.accelerator)
    expect(declared).toEqual([...TAB_BY_INDEX_ACCELERATORS.win32, 'Alt+0'])
  })

  it('takes no key another action already has, on any platform', () => {
    /*
      Nine keys claimed by a second mechanism, checked against every key claimed by the first.

      `findBindingConflicts` cannot see these — they are not `ShortcutAction`s, so it does not iterate
      them — which means nothing else in this project would notice `Control+3` being taken twice.
      Electron would then pick one of the two items and the other key would silently do the wrong
      thing. Built from every action at once, with the alternatives expanded, because a collision by
      construction cannot be seen one item at a time; the same shape as the last test in
      `alternative-accelerators.test.ts`, for the same reason.
    */
    for (const platform of platformSchema.options) {
      const everyAction: MenuItemConstructorOptions[] = SHORTCUT_ACTIONS
        /*
          `lastTab` is left out, and the omission is the point rather than a convenience: the item this
          module builds *is* `lastTab`'s only item. Standing one in for it as well would have the test
          fail over a second `Control+9` that no menu contains — which is what it did when written the
          other way.
        */
        .filter((action) => action !== 'lastTab')
        .map((action) => ({
          label: action,
          accelerator: acceleratorFor(platform, action),
          click: () => {}
        }))

      const declared = flatten(
        withAlternativeAccelerators([...everyAction, ...build(platform, () => {})], platform)
      )
        .map((item) => item.accelerator)
        .filter((accelerator): accelerator is string => typeof accelerator === 'string')
        // `Escape` is shared between `stop` and `escape` on purpose; see `findBindingConflicts`.
        .filter((accelerator) => accelerator !== 'Escape')

      expect(new Set(declared).size, `${platform} declares a key twice`).toBe(declared.length)
    }
  })
})

describe('the menu item that makes lastTab fire', () => {
  it('is declared in appMenu.ts, which is where the fitness test looks', () => {
    /*
      `lastTab` was in the allowlist of `architecture.test.ts`'s "every shortcut action has a menu item"
      scan, because that scan matches the literal `accel('lastTab')` in `appMenu.ts` and there was none.
      The accelerator is resolved there and passed in for exactly that reason, so this asserts the thing
      that would otherwise be a coincidence of how it was written.
    */
    const menu = readFileSync(join(process.cwd(), 'src/main/menu/appMenu.ts'), 'utf8')
    expect(menu).toContain("accel('lastTab')")
    expect(menu).toContain('tabPositionAccelerators(')
  })
})
