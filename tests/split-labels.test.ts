import { describe, expect, it } from 'vitest'
import { LAYOUT_LABELS, LAYOUT_SHORTCUTS } from '@shared/split/labels.js'
import { LAYOUT_IDS } from '@shared/split/layout.js'
import { SHORTCUT_ACTIONS } from '@shared/shortcuts/bindings.js'
import { catalogs } from '@shared/i18n/catalog.js'

/**
 * What each split arrangement is called, and which shortcut reaches it.
 *
 * A table this small would not normally earn a test file. It earns one because of what happened
 * without it: the application menu spelled its five entries out by hand, two column layouts were
 * added, and they became reachable from the toolbar and by dragging but not from the menu — a
 * feature that existed and could not be found. Both surfaces now walk `LAYOUT_IDS`, and these
 * assertions are what keep the walk from finding a hole.
 */

describe('layout labels', () => {
  it('names every arrangement', () => {
    // `Record<LayoutId, MessageKey>` already forces this at build time. Asserted at runtime too,
    // because the two surfaces that read it would otherwise render `undefined` as a menu item.
    for (const layout of LAYOUT_IDS) {
      expect(LAYOUT_LABELS[layout], layout).toBeDefined()
    }
  })

  it('points at messages both catalogues actually have', () => {
    // A key that exists in the table but not in the catalogue renders as the key itself — visible
    // to the user as `menu.split.layout3Columns` in a menu.
    for (const layout of LAYOUT_IDS) {
      const key = LAYOUT_LABELS[layout]
      expect(catalogs.en[key], `en: ${key}`).toBeDefined()
      expect(catalogs.de[key], `de: ${key}`).toBeDefined()
    }
  })

  it('gives no two arrangements the same name', () => {
    // Two menu items reading "Two Columns" would be a choice the user cannot make.
    const keys = LAYOUT_IDS.map((layout) => LAYOUT_LABELS[layout])
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('layout shortcuts', () => {
  it('names only real shortcut actions', () => {
    for (const [layout, action] of Object.entries(LAYOUT_SHORTCUTS)) {
      expect(SHORTCUT_ACTIONS as readonly string[], `${layout} -> ${action}`).toContain(action)
    }
  })

  it('names only real layouts', () => {
    for (const layout of Object.keys(LAYOUT_SHORTCUTS)) {
      expect(LAYOUT_IDS as readonly string[], layout).toContain(layout)
    }
  })

  it('gives no two arrangements the same chord', () => {
    const actions = Object.values(LAYOUT_SHORTCUTS)
    expect(new Set(actions).size).toBe(actions.length)
  })

  it('is deliberately partial', () => {
    /*
      The table is `Partial` on purpose: not every arrangement earns a chord, and inventing one per
      layout would crowd out shortcuts users want for something else. This asserts the gap is real
      rather than an oversight — if it ever became total, the `Partial` and the reasoning beside it
      would be stale.
    */
    const withChord = Object.keys(LAYOUT_SHORTCUTS).length
    expect(withChord).toBeGreaterThan(0)
    expect(withChord).toBeLessThan(LAYOUT_IDS.length)
  })
})
