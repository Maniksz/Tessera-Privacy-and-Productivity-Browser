import { describe, expect, it } from 'vitest'
import {
  emptyTiles,
  isStartPageTile,
  layoutFitting,
  orderWithRunAtEntry,
  planShrink,
  shrunkLayout,
  tabsToCloseOnShrink
} from '@shared/split/tile-fill.js'
import { LAYOUT_IDS, TILE_COUNT, type LayoutId } from '@shared/split/layout.js'
import { HOME_URL } from '@shared/url/omnibox.js'

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

describe('isStartPageTile (KTD8)', () => {
  const settled = { loading: false, pendingInput: null }

  it('counts a settled start page', () => {
    expect(isStartPageTile({ committedUrl: HOME_URL, ...settled })).toBe(true)
    expect(isStartPageTile({ committedUrl: 'tessera://start/', ...settled })).toBe(true)
  })

  it('counts about:blank that is not loading', () => {
    expect(isStartPageTile({ committedUrl: 'about:blank', ...settled })).toBe(true)
  })

  it('does not count an empty address whose first navigation is still running', () => {
    // A tile the user has just sent somewhere shows nothing yet, and closing it would lose the page
    // on its way in.
    expect(isStartPageTile({ committedUrl: '', loading: true, pendingInput: null })).toBe(false)
  })

  it('does not count a start page with an address waiting to be loaded', () => {
    expect(
      isStartPageTile({ committedUrl: HOME_URL, loading: false, pendingInput: 'https://a.example' })
    ).toBe(false)
  })

  it('does not count a web page, or another internal page', () => {
    expect(isStartPageTile({ committedUrl: 'https://youtube.com/', ...settled })).toBe(false)
    expect(isStartPageTile({ committedUrl: 'tessera://history', ...settled })).toBe(false)
  })
})

describe('layoutFitting', () => {
  it('walks down the shrink chain to the fewest panes that still hold every page', () => {
    expect(layoutFitting('2x2', 2)).toBe('1x2')
    expect(layoutFitting('1x4', 3)).toBe('1x3')
    expect(layoutFitting('1x3', 2)).toBe('1x2')
  })

  it('never grows and stays put when the pages fill it', () => {
    expect(layoutFitting('1x2', 3)).toBe('1x2')
    expect(layoutFitting('2x2', 4)).toBe('2x2')
  })

  it('stops at a single pane, even for none', () => {
    expect(layoutFitting('2x2', 1)).toBe('1x1')
    expect(layoutFitting('1x3', 0)).toBe('1x1')
  })
})

describe('planShrink (R8, KTD8)', () => {
  const startPages = (...ids: string[]) => {
    const set = new Set(ids)
    return (tabId: string): boolean => set.has(tabId)
  }

  it('closes both start pages of a 2x2 and seats the two pages side by side (AE2)', () => {
    const plan = planShrink(['s1', 'youtube', 's2', 'twitch'], startPages('s1', 's2'), '1x2')
    expect(plan).toEqual({
      close: ['s1', 's2'],
      remaining: ['youtube', 'twitch'],
      seats: ['youtube', 'twitch'],
      freed: [],
      layout: '1x2',
      active: 'youtube'
    })
  })

  it('makes the page that finds no pane an ordinary tab, in tile order', () => {
    const plan = planShrink(['a', 'b', 'c'], startPages(), '1x2', 'b')
    expect(plan.close).toEqual([])
    expect(plan.seats).toEqual(['a', 'b'])
    expect(plan.freed).toEqual(['c'])
    expect(plan.remaining).toEqual(['a', 'b', 'c'])
    expect(plan.layout).toBe('1x2')
    expect(plan.active).toBe('b')
  })

  it('moves pages up past empty panes rather than dropping one off the end', () => {
    const plan = planShrink(['a', null, 'c'], startPages(), '1x2')
    expect(plan.seats).toEqual(['a', 'c'])
    expect(plan.freed).toEqual([])
  })

  it('settles on the smallest layout that fits what is left of the one chosen', () => {
    const plan = planShrink(['youtube', 's1', 's2', 'twitch'], startPages('s1', 's2'), '1+2')
    expect(plan.layout).toBe('1x2')
    expect(plan.seats).toEqual(['youtube', 'twitch'])
  })

  it('dissolves into one pane when fewer than two pages are left', () => {
    const plan = planShrink(['s1', 'youtube', 's2'], startPages('s1', 's2'), '1x2')
    expect(plan.layout).toBe('1x1')
    expect(plan.seats).toEqual(['youtube'])
    expect(plan.freed).toEqual([])
    expect(plan.active).toBe('youtube')
  })

  it('ends with the active page in the single pane and the rest freed in tile order (AE3)', () => {
    const plan = planShrink(['youtube', 'start', 'twitch'], startPages('start'), '1x1', 'twitch')
    expect(plan).toEqual({
      close: ['start'],
      remaining: ['youtube', 'twitch'],
      seats: ['twitch'],
      freed: ['youtube'],
      layout: '1x1',
      active: 'twitch'
    })
  })

  it('makes the first remaining page active when the active tile held a start page', () => {
    const plan = planShrink(['youtube', 'start', 'twitch'], startPages('start'), '1x1', 'start')
    expect(plan.seats).toEqual(['youtube'])
    expect(plan.active).toBe('youtube')
    const shrunk = planShrink(['s', 'a', 'b', 'c'], startPages('s'), '1x2', 's')
    expect(shrunk.active).toBe('a')
  })

  it('leaves nothing to seat when every tile is a start page', () => {
    const plan = planShrink(['s1', 's2', null], startPages('s1', 's2'), '1x1')
    expect(plan).toEqual({
      close: ['s1', 's2'],
      remaining: [],
      seats: [],
      freed: [],
      layout: '1x1',
      active: null
    })
  })
})

describe('orderWithRunAtEntry', () => {
  it('stands the run where the first member stood, in the order given', () => {
    const order = ['mail', 'twitch', 'news', 'start', 'youtube', 'docs']
    expect(
      orderWithRunAtEntry(order, ['youtube', 'start', 'twitch'], ['youtube', 'twitch'])
    ).toEqual(['mail', 'youtube', 'twitch', 'news', 'start', 'docs'])
  })

  it('keeps the place of the entry when its first member is a start page about to close', () => {
    const order = ['mail', 'start', 'news', 'a', 'b']
    expect(orderWithRunAtEntry(order, ['start', 'a', 'b'], ['b', 'a'])).toEqual([
      'mail',
      'b',
      'a',
      'start',
      'news'
    ])
  })

  it('leaves the order alone when no member is in it', () => {
    expect(orderWithRunAtEntry(['a', 'b'], ['x'], ['x'])).toEqual(['a', 'b'])
  })

  it('never adds a tab the strip does not hold', () => {
    expect(orderWithRunAtEntry(['a', 'b'], ['b', 'gone'], ['gone', 'b'])).toEqual(['a', 'b'])
  })
})
