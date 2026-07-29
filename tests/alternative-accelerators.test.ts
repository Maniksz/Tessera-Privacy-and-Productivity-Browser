import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { withAlternativeAccelerators } from '@main/menu/alternative-accelerators.js'
import { DEFAULT_BINDINGS, SHORTCUT_ACTIONS } from '@shared/shortcuts/bindings.js'
import { platformSchema } from '@shared/model.js'

/**
 * The second key of a shortcut (spec 9).
 *
 * `bindings.ts` lists alternatives for a dozen actions and calls them equivalent; they were not
 * registered anywhere, because a `MenuItem` carries one accelerator and every caller read element
 * zero. So the settings screen listed `Alt+D`, `F6`, `F3`, `Control+PageDown` and the keypad zoom
 * keys as working shortcuts, and pressing any of them did nothing.
 *
 * These tests work on the plain template rather than a built `Menu`, which is the only way to check
 * this at all without an Electron process — and is also where the mistake was, so it is the right
 * place regardless.
 */

/** Every accelerator declared anywhere in a template, hidden items included. */
function acceleratorsIn(items: readonly MenuItemConstructorOptions[]): string[] {
  const found: string[] = []
  for (const item of items) {
    if (typeof item.accelerator === 'string') found.push(item.accelerator)
    if (Array.isArray(item.submenu)) found.push(...acceleratorsIn(item.submenu))
  }
  return found
}

function labelled(
  items: readonly MenuItemConstructorOptions[],
  accelerator: string
): MenuItemConstructorOptions {
  const found = flatten(items).find((item) => item.accelerator === accelerator)
  if (found === undefined) {
    throw new Error(
      `nothing declares ${accelerator}; declared: ${acceleratorsIn(items).join(', ')}`
    )
  }
  return found
}

function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])
  ])
}

describe('withAlternativeAccelerators', () => {
  it('adds the second key of an action next to the item carrying the first', () => {
    // `reload` is ['F5', 'Control+R'] on Windows.
    const template: MenuItemConstructorOptions[] = [
      { label: 'View', submenu: [{ label: 'Reload', accelerator: 'F5', click: () => {} }] }
    ]

    const expanded = withAlternativeAccelerators(template, 'win32')
    expect(acceleratorsIn(expanded)).toEqual(['F5', 'Control+R'])
  })

  it('gives the clone the same handler, which is the whole point', () => {
    // Identity rather than a call: a copy that behaved the same today and was rebuilt from the
    // template tomorrow would pass a call-based assertion and still be a second handler to keep in
    // step. There is one handler, and this says so.
    const click = vi.fn()
    const template: MenuItemConstructorOptions[] = [{ label: 'Reload', accelerator: 'F5', click }]

    const clone = labelled(withAlternativeAccelerators(template, 'win32'), 'Control+R')
    expect(clone.click).toBe(click)
  })

  it('hides the clone, and keeps its accelerator alive on macOS while hidden', () => {
    const template: MenuItemConstructorOptions[] = [
      { label: 'Fullscreen', accelerator: 'Control+Command+F', click: () => {} }
    ]

    const clone = labelled(withAlternativeAccelerators(template, 'darwin'), 'F11')
    expect(clone.visible).toBe(false)
    // Without this, macOS drops a hidden item's accelerator and the key is dead again.
    expect(clone.acceleratorWorksWhenHidden).toBe(true)
  })

  it('leaves an item whose key has no alternative exactly as it was', () => {
    const template: MenuItemConstructorOptions[] = [
      { label: 'New Tab', accelerator: 'Control+T', click: () => {} }
    ]

    const expanded = withAlternativeAccelerators(template, 'win32')
    expect(expanded).toHaveLength(1)
    expect(acceleratorsIn(expanded)).toEqual(['Control+T'])
  })

  it('leaves role items and separators alone', () => {
    const template: MenuItemConstructorOptions[] = [
      { role: 'copy' },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' }
    ]

    expect(withAlternativeAccelerators(template, 'darwin')).toEqual(template)
  })

  it('does not clone a checkbox item, whose handler reads its own checked state', () => {
    /*
      A hidden clone has its own `checked`, so a clone of "show the bookmarks bar" would be a key
      that always writes the same value rather than toggling. No action with a checkbox item has a
      second key today; the fitness test in `architecture.test.ts` is what keeps that true.
    */
    const template: MenuItemConstructorOptions[] = [
      { label: 'Reload', type: 'checkbox', accelerator: 'F5', click: () => {} }
    ]

    expect(acceleratorsIn(withAlternativeAccelerators(template, 'win32'))).toEqual(['F5'])
  })

  it('drops the alternatives of an action the user has rebound', () => {
    /*
      Someone who chose `Alt+K` for reload has replaced the binding, not added to it. Keeping
      `Control+R` alive as well would make a rebind that quietly does not remove the old key.
    */
    const template: MenuItemConstructorOptions[] = [
      { label: 'Reload', accelerator: 'Alt+K', click: () => {} }
    ]

    const expanded = withAlternativeAccelerators(template, 'win32', { reload: 'Alt+K' })
    expect(acceleratorsIn(expanded)).toEqual(['Alt+K'])
  })

  it('recurses through nested submenus', () => {
    const template: MenuItemConstructorOptions[] = [
      {
        label: 'View',
        submenu: [
          { label: 'Zoom', submenu: [{ label: 'In', accelerator: 'Control+Plus', click: () => {} }] }
        ]
      }
    ]

    // All three of `zoomIn`'s bindings, so the nested item is shown to have been reached and to have
    // received the whole set rather than the first alternative only.
    expect(acceleratorsIn(withAlternativeAccelerators(template, 'win32'))).toEqual([
      'Control+Plus',
      'Control+=',
      'Control+numadd'
    ])
  })

  it('produces no duplicate accelerator for any platform, from every primary at once', () => {
    /*
      The failure this guards against is a clone colliding with another action's primary key — which
      would leave two menu items claiming one accelerator and Electron picking one. Built from every
      action's primary key at once, because a collision by construction cannot be seen one item at a
      time.
    */
    for (const platform of platformSchema.options) {
      const template: MenuItemConstructorOptions[] = SHORTCUT_ACTIONS.map((action) => {
        const [primary] = DEFAULT_BINDINGS[platform][action].slice(0, 1)
        return { label: action, accelerator: primary ?? '', click: () => {} }
      })

      const declared = acceleratorsIn(withAlternativeAccelerators(template, platform))
      // `Escape` is shared between `stop` and `escape` on purpose; see `findBindingConflicts`.
      const contested = declared.filter((accelerator) => accelerator !== 'Escape')
      expect(new Set(contested).size, `${platform} declares a key twice`).toBe(contested.length)
    }
  })
})
