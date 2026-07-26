import { describe, expect, it } from 'vitest'
import { emptyTiles, shrunkLayout, tabsToCloseOnShrink } from '@shared/split/tile-fill.js'
import { LAYOUT_IDS, TILE_COUNT, type LayoutId } from '@shared/split/layout.js'

/**
 * Filling a fresh layout, and cleaning up after it.
 *
 * The second rule is the delicate one: it is a deliberate exception to spec 2's requirement
 * that shrinking a layout must never close a tab. The exception is narrow by construction —
 * only tabs the browser opened itself and the user never navigated — and these tests exist to
 * keep it that narrow.
 */

describe('emptyTiles', () => {
  it('finds the tiles with nothing in them, in order', () => {
    expect(emptyTiles(['tab-1', null, null, 'tab-2'])).toEqual([1, 2])
  })

  it('finds nothing when every tile is occupied', () => {
    expect(emptyTiles(['tab-1', 'tab-2'])).toEqual([])
  })

  it('finds every tile when none is occupied', () => {
    expect(emptyTiles([null, null, null, null])).toEqual([0, 1, 2, 3])
  })

  it('handles a layout with no tiles at all', () => {
    expect(emptyTiles([])).toEqual([])
  })

  it('treats an empty string as an occupant, not as emptiness', () => {
    // Tab ids are opaque; only `null` means "no tab".
    expect(emptyTiles([''])).toEqual([])
  })
})

describe('tabsToCloseOnShrink', () => {
  it('closes an untouched filler the browser opened itself', () => {
    expect(tabsToCloseOnShrink(['tab-2'], new Set(['tab-2']))).toEqual(['tab-2'])
  })

  it('keeps a tab the user opened, which spec 2 protects', () => {
    expect(tabsToCloseOnShrink(['tab-1'], new Set(['tab-9']))).toEqual([])
  })

  it('keeps a filler the user navigated, because it stopped being disposable', () => {
    // The window clears the flag on the first navigation, so such a tab is simply absent from
    // the set — asserted here so the rule cannot quietly widen to "anything auto-opened".
    expect(tabsToCloseOnShrink(['tab-2'], new Set())).toEqual([])
  })

  it('closes only the fillers among several orphans', () => {
    const orphaned = ['user-a', 'filler-a', 'user-b', 'filler-b']
    expect(tabsToCloseOnShrink(orphaned, new Set(['filler-a', 'filler-b']))).toEqual([
      'filler-a',
      'filler-b'
    ])
  })

  it('preserves the order it was given', () => {
    const orphaned = ['filler-b', 'filler-a']
    expect(tabsToCloseOnShrink(orphaned, new Set(['filler-a', 'filler-b']))).toEqual([
      'filler-b',
      'filler-a'
    ])
  })

  it('closes nothing when no tab lost its tile', () => {
    expect(tabsToCloseOnShrink([], new Set(['filler-a']))).toEqual([])
  })

  it('never invents a tab that did not lose its tile', () => {
    // A filler still sitting in a tile must survive the shrink untouched.
    expect(tabsToCloseOnShrink(['orphan'], new Set(['orphan', 'still-shown']))).toEqual(['orphan'])
  })
})

describe('shrunkLayout', () => {
  it('steps a four-tile grid down to the three-tile arrangement', () => {
    // Rather than to two columns: this keeps the most of what was on screen.
    expect(shrunkLayout('2x2')).toBe('1+2')
  })

  it('steps the three-tile arrangement down to two columns', () => {
    expect(shrunkLayout('1+2')).toBe('1x2')
  })

  it('steps either two-tile layout down to a single view', () => {
    expect(shrunkLayout('1x2')).toBe('1x1')
    expect(shrunkLayout('2x1')).toBe('1x1')
  })

  it('keeps a row of columns a row all the way down', () => {
    // `1x4` has the same tile count as `2x2` and `1x3` the same as `1+2`, so
    // arithmetic alone would happily reshape a row of views into a grid. Somebody
    // who put four views side by side wanted them side by side.
    expect(shrunkLayout('1x4')).toBe('1x3')
    expect(shrunkLayout('1x3')).toBe('1x2')
    expect(shrunkLayout('1x2')).toBe('1x1')
  })

  it('walks a four-column row down to a single view one column at a time', () => {
    const path = ['1x4'] as LayoutId[]
    for (let next = shrunkLayout('1x4'); next !== null; next = shrunkLayout(next)) path.push(next)
    expect(path).toEqual(['1x4', '1x3', '1x2', '1x1'])
  })

  it('has nowhere to go from a single view', () => {
    expect(shrunkLayout('1x1')).toBeNull()
  })

  it('always removes exactly one tile', () => {
    // The property that matters: closing one tab must not collapse two panes at once.
    for (const layout of LAYOUT_IDS) {
      const smaller = shrunkLayout(layout)
      if (smaller === null) {
        expect(TILE_COUNT[layout], layout).toBe(1)
        continue
      }
      expect(TILE_COUNT[smaller], layout).toBe(TILE_COUNT[layout] - 1)
    }
  })

  it('never returns the layout it was given', () => {
    for (const layout of LAYOUT_IDS) {
      expect(shrunkLayout(layout), layout).not.toBe(layout)
    }
  })
})
