import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LayoutMenuSurface } from '@renderer/surfaces/LayoutMenuSurface.js'
import { LAYOUT_IDS } from '@shared/split/layout.js'
import { LAYOUT_SHORTCUTS } from '@shared/split/labels.js'
import type { LayoutMenuPresentation } from '@shared/overlay/surface.js'

/**
 * The keys the split-layout menu shows.
 *
 * This menu is the *only* place four working shortcuts are visible. `splitLayout1`–`4` are registered in
 * the application menu through a loop over `LAYOUT_IDS`, so no menu the user opens spells them out, and
 * the toolbar button that opens this menu deliberately shows none — it opens a menu rather than applying
 * a layout. So if these entries do not show the key, nothing does, and a user has no way to discover that
 * `⇧⌘2` splits the window.
 *
 * What breaks if this is wrong, in both directions: an arrangement with no key showing one it does not
 * have, and the platform being spelled the other platform's way — `⌘⇧2` on a Mac is what a Windows
 * program prints, and reads as a typo to anyone who has used one.
 */

function installBridge(): void {
  const bridge = {
    invoke: (): Promise<unknown> => Promise.resolve({ ok: true }),
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
}

const presentation: LayoutMenuPresentation = {
  kind: 'layout-menu',
  anchor: { x: 10, y: 10, width: 40, height: 30 },
  current: '1x1'
}

function renderMenu(
  platform: 'darwin' | 'win32' | null,
  overrides: Readonly<Record<string, string>> = {}
): void {
  installBridge()
  render(
    <LayoutMenuSurface presentation={presentation} platform={platform} overrides={overrides} />
  )
}

afterEach(cleanup)

describe('the split-layout menu', () => {
  it('shows the macOS key in Apple’s own spelling', () => {
    renderMenu('darwin')
    // Symbols, no separator, and `⇧` before `⌘` — the fixed order every Mac menu uses.
    expect(screen.getByText('⇧⌘2')).toBeTruthy()
  })

  it('shows the same shortcut as words on Windows', () => {
    renderMenu('win32')
    expect(screen.getByText('Ctrl+Shift+2')).toBeTruthy()
  })

  it('shows a key for exactly the arrangements that have one', () => {
    /*
      Derived from `LAYOUT_SHORTCUTS` rather than hard-coded to four: an arrangement gaining a key must
      not need this test edited, and one *losing* its key must fail here rather than keep printing it.
    */
    renderMenu('win32')
    const withKey = LAYOUT_IDS.filter((layout) => LAYOUT_SHORTCUTS[layout] !== undefined)
    const cells = [...document.querySelectorAll('.menu__key')]

    expect(cells).toHaveLength(LAYOUT_IDS.length)
    expect(cells.filter((cell) => cell.textContent !== '')).toHaveLength(withKey.length)
  })

  it('honours a rebound key rather than the default', () => {
    // A tooltip or a menu showing the default while the user has rebound the key is worse than showing
    // nothing: it is a confident wrong answer.
    renderMenu('win32', { splitLayout2: 'Alt+K' })
    expect(screen.getByText('Alt+K')).toBeTruthy()
    expect(screen.queryByText('Ctrl+Shift+2')).toBeNull()
  })

  it('draws every entry before the platform is known', () => {
    /*
      The window state arrives asynchronously, so this is the first frame every time the menu opens —
      not an edge case. Every arrangement has to be there and choosable; only the key column is empty.
    */
    renderMenu(null)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(LAYOUT_IDS.length)
    expect([...document.querySelectorAll('.menu__key')].every((cell) => cell.textContent === '')).toBe(
      true
    )
  })
})
