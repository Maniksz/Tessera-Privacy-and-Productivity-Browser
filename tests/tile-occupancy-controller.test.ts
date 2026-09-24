import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { SplitController } from '@main/browser/SplitController.js'
import {
  TileOccupancyController,
  type LayoutChangeOptions,
  type TileOccupancyHost
} from '@main/browser/TileOccupancyController.js'
import { dropZonesFor } from '@shared/split/dropzones.js'
import { TILE_COUNT, type LayoutId, type Rect } from '@shared/split/layout.js'
import { HOME_URL } from '@shared/url/omnibox.js'
import { CloseContract } from '@main/browser/unload-guard.js'

/**
 * Keeping tiles and tabs matched.
 *
 * These rules interact, which is the reason to test them apart from a window: shrinking a layout
 * can close a tab, closing a tab can shrink a layout, and getting that wrong is either an endless
 * loop or a pane that refuses to go away. The exception to spec 2 — that an untouched filler may
 * be closed — also has to stay exactly as narrow as it is written.
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1200, height: 800 }

interface Harness {
  occupancy: TileOccupancyController
  split: SplitController
  order: string[]
  ephemeral: Set<string>
  closed: string[]
  unassigned: string[]
  fillers: number[]
  activated: number[]
  adapt: boolean
  /** Tabs whose group is folded away. The controller must leave these off the grid. */
  collapsed: Set<string>
  /**
   * Tabs that belong to a tiled view, put away or on screen (KTD4). Nothing automatic may seat one
   * of these in a pane; the controller only asks, and `window-seams.ts` answers from the book.
   */
  members: Set<string>
  /** How often the controller asked for the first tiled view in strip order to come back (KTD10). */
  restoredFirst: number
  /**
   * The tiling as it stood each time this controller said "put it away now", newest last.
   *
   * `putAway()` carries no arguments — `ArrangementController.putAway` reads the layout and the
   * seating off the same split controller — so the snapshot is taken here, at the moment of the
   * call. That is exactly what these tests are about: what this controller owes is the *timing*, and
   * a report taken one line later would describe the single view that replaced the arrangement.
   * Whether the recording is worth keeping belongs to `@shared/arrangements/model.ts`.
   */
  kept: Array<{ id: LayoutId; tiles: Array<string | null> }>
  /** The same snapshot for `endTiling()`, taken at the call for the same reason. */
  ended: Array<{ id: LayoutId; tiles: Array<string | null> }>
  /**
   * What `closeTab` does to the window once a tab has gone, and where a test may route it through first.
   * Unset, `closeTab` is `forget` directly, which is what every test here assumed before the close contract.
   */
  forget: (tabId: string) => void
  routeClose: ((tabId: string) => void) | null
  /** Tabs showing the start page and nothing on its way in (`isStartPageTile`, KTD8). */
  startPages: Set<string>
  /** Every layout change this controller asked the window for, with the options it gave. */
  layoutChanges: Array<{ layout: LayoutId; options: LayoutChangeOptions }>
}

function harness(layout: LayoutId, tabs: string[] = []): Harness {
  const split = new SplitController({ layout })
  const state: Partial<Harness> = {
    split,
    order: [...tabs],
    ephemeral: new Set<string>(),
    closed: [],
    unassigned: [],
    fillers: [],
    activated: [],
    adapt: true,
    collapsed: new Set<string>(),
    members: new Set<string>(),
    restoredFirst: 0,
    kept: [],
    ended: [],
    routeClose: null,
    startPages: new Set<string>(),
    layoutChanges: []
  }
  state.forget = (tabId) => {
    state.closed!.push(tabId)
    state.order = state.order!.filter((id) => id !== tabId)
    state.ephemeral!.delete(tabId)
    split.forgetTab(tabId)
  }

  let fillerSequence = 0

  const host: TileOccupancyHost = {
    split,
    adaptEnabled: () => state.adapt!,
    tabOrder: () => state.order!,
    setTabOrder: (order) => {
      state.order = [...order]
    },
    isEphemeral: (tabId) => state.ephemeral!.has(tabId),
    isStartPage: (tabId) => state.startPages!.has(tabId),
    isHiddenByCollapse: (tabId) => state.collapsed!.has(tabId),
    isArrangementMember: (tabId) => state.members!.has(tabId),
    restoreFirstArrangement: () => {
      state.restoredFirst! += 1
    },
    unassign: (tabId) => {
      state.unassigned!.push(tabId)
    },
    assignTabToTile: (tabId, tileIndex) => {
      split.assignTab(tabId, tileIndex)
    },
    closeTab: (tabId) => (state.routeClose ?? state.forget!)(tabId),
    setActiveTile: (tileIndex) => {
      state.activated!.push(tileIndex)
      split.setActiveTile(tileIndex)
    },
    openFiller: (tileIndex) => {
      fillerSequence += 1
      const id = `filler-${fillerSequence}`
      state.fillers!.push(tileIndex)
      state.order!.push(id)
      state.ephemeral!.add(id)
      split.assignTab(id, tileIndex)
    },
    // The window re-enters through the same door, so the controller's own rules apply again.
    applyLayout: (next, options) => {
      state.layoutChanges!.push({ layout: next, options })
      state.occupancy!.afterLayoutChange(split.setLayout(next), options)
    },
    /*
      What `window-seams.ts` does behind `ArrangementController.putAway`, so the tests below see the
      window a new tab arrives in: every pane emptied first — which is why nothing is orphaned and no
      filler closes (R8) — and then the single layout, with its one tile free for the new tab.
    */
    putAway: () => {
      state.kept!.push({ id: split.layout, tiles: split.toState().tileTabIds })
      for (const tabId of split.toState().tileTabIds) {
        if (tabId === null) continue
        state.unassigned!.push(tabId)
        split.assignTab(tabId, null)
      }
      state.occupancy!.afterLayoutChange(split.setLayout('1x1'), {
        fill: false,
        closeStartPages: false
      })
    },
    endTiling: () => {
      state.ended!.push({ id: split.layout, tiles: split.toState().tileTabIds })
    }
  }

  state.occupancy = new TileOccupancyController(host)
  return state as Harness
}

/** Puts each tab into the tile of the same index. */
function seed(h: Harness, tabs: string[]): void {
  tabs.forEach((tabId, index) => h.split.assignTab(tabId, index))
}

describe('filling a layout the user chose', () => {
  it('opens a tab for every empty tile', () => {
    const h = harness('2x2', ['tab-1'])
    seed(h, ['tab-1'])
    h.occupancy.fillEmptyTiles()
    expect(h.fillers).toEqual([1, 2, 3])
  })

  it('fills nothing when every tile is taken', () => {
    const h = harness('1x2', ['tab-1', 'tab-2'])
    seed(h, ['tab-1', 'tab-2'])
    h.occupancy.fillEmptyTiles()
    expect(h.fillers).toEqual([])
  })

  it('fills nothing when the user turned adaptation off', () => {
    const h = harness('2x2', ['tab-1'])
    seed(h, ['tab-1'])
    h.adapt = false
    h.occupancy.fillEmptyTiles()
    expect(h.fillers).toEqual([])
  })
})

describe('a layout the user chose', () => {
  it('fills its new tiles with start pages and pulls no loaded tab in (KTD10)', () => {
    /*
      It used to seat the two loaded pages first and give only the tile left over a start page. With
      a tiled view as an entry in the strip, every loaded page is either an ordinary tab or a member of
      another view, and moving either into these panes is a tab leaving its place in the strip
      unasked (R16). Start pages are the one thing a new tile can be given without taking anything.
    */
    const h = harness('1x1', ['a', 'b', 'c'])
    seed(h, ['a'])

    h.occupancy.chooseLayout('2x2')

    expect(h.split.toState().tileTabIds).toEqual(['a', 'filler-1', 'filler-2', 'filler-3'])
    expect(h.fillers).toEqual([1, 2, 3])
    expect(h.split.tileOfTab('b')).toBeNull()
    expect(h.split.tileOfTab('c')).toBeNull()
  })

  it('grows 1x2 into 2x2 with two start pages and no loose tab (KTD10)', () => {
    const h = harness('1x2', ['a', 'b', 'loose'])
    seed(h, ['a', 'b'])

    h.occupancy.chooseLayout('2x2')

    expect(h.split.toState().tileTabIds).toEqual(['a', 'b', 'filler-1', 'filler-2'])
    expect(h.split.tileOfTab('loose')).toBeNull()
  })

  it('leaves the new tiles empty with adaptation off, and still pulls nothing in', () => {
    const h = harness('1x2', ['a', 'b', 'loose'])
    seed(h, ['a', 'b'])
    h.adapt = false

    h.occupancy.chooseLayout('2x2')

    expect(h.split.toState().tileTabIds).toEqual(['a', 'b', null, null])
  })

  it('ends the tiling on screen before it goes, when the choice is a single page', () => {
    /*
      Before, and with the seating that was there: read after the change the split names one tab, and
      the recording that tied the others to it would survive — the next click on one of them would put
      the split straight back.
    */
    const h = harness('1x2', ['a', 'b'])
    seed(h, ['a', 'b'])

    h.occupancy.chooseLayout('1x1')

    expect(h.ended).toEqual([{ id: '1x2', tiles: ['a', 'b'] }])
    expect(h.split.layout).toBe('1x1')
    // Ended is not closed: the page that lost its pane stays in the strip (spec 2).
    expect(h.closed).toEqual([])
    expect(h.order).toEqual(['a', 'b'])
  })

  it('ends nothing when the choice is another split', () => {
    // The settle after it writes the smaller tiling into the same entry, under its id (KTD2).
    const h = harness('2x2', ['a', 'b', 'c', 'd'])
    seed(h, ['a', 'b', 'c', 'd'])

    h.occupancy.chooseLayout('1x2')

    expect(h.ended).toEqual([])
    expect(h.split.layout).toBe('1x2')
  })
})

/**
 * What `BrowserWindowController.#finishClose` does once a tab has gone, as far as this controller
 * sees it: the tile it leaves is settled, and a window left with no tab at all gets a fresh start
 * page through the new-tab path (`keepOneTab`).
 */
function closeLikeTheWindow(h: Harness): void {
  h.routeClose = (tabId) => {
    const vacated = h.split.tileOfTab(tabId)
    h.forget(tabId)
    h.occupancy.afterTabClosed(vacated)
    if (h.order.length === 0) {
      h.order.push('fresh')
      h.split.assignTab('fresh', h.occupancy.claimTileForNewTab())
    }
  }
}

describe('changing a tiled view to fewer tiles (U4, R8)', () => {
  it('closes both start pages of a 2x2 and seats the two pages side by side (AE2)', () => {
    const h = harness('2x2', ['start-1', 'youtube', 'start-2', 'twitch'])
    seed(h, ['start-1', 'youtube', 'start-2', 'twitch'])
    h.startPages.add('start-1').add('start-2')

    h.occupancy.chooseLayout('1x2')

    expect(h.split.layout).toBe('1x2')
    expect(h.split.toState().tileTabIds).toEqual(['youtube', 'twitch'])
    expect([...h.closed].sort()).toEqual(['start-1', 'start-2'])
    // Nothing became an ordinary tab: both pages are still seated, and the view was not ended.
    expect(h.unassigned).not.toContain('youtube')
    expect(h.unassigned).not.toContain('twitch')
    expect(h.ended).toEqual([])
    expect(h.layoutChanges).toEqual([
      { layout: '1x2', options: { fill: true, closeStartPages: true } }
    ])
  })

  it('makes a page that finds no tile an ordinary tab right behind the entry', () => {
    const h = harness('1x3', ['a', 'mail', 'b', 'c', 'news'])
    seed(h, ['a', 'b', 'c'])
    h.split.setActiveTile(1)

    h.occupancy.chooseLayout('1x2')

    expect(h.split.toState().tileTabIds).toEqual(['a', 'b'])
    expect(h.split.tileOfTab('c')).toBeNull()
    expect(h.closed).toEqual([])
    expect(h.order).toEqual(['a', 'b', 'c', 'mail', 'news'])
    expect(h.split.activeTabId()).toBe('b')
  })

  it('moves a page up past an empty pane instead of dropping it off the end', () => {
    const h = harness('1x3', ['a', 'c'])
    h.split.assignTab('a', 0)
    h.split.assignTab('c', 2)

    h.occupancy.chooseLayout('1x2')

    expect(h.split.toState().tileTabIds).toEqual(['a', 'c'])
  })

  it('takes the smallest layout that fits once the start pages are gone', () => {
    const h = harness('2x2', ['youtube', 'start-1', 'start-2', 'twitch'])
    seed(h, ['youtube', 'start-1', 'start-2', 'twitch'])
    h.startPages.add('start-1').add('start-2')

    h.occupancy.chooseLayout('1+2')

    expect(h.split.layout).toBe('1x2')
    expect(h.split.toState().tileTabIds).toEqual(['youtube', 'twitch'])
    // No start page is opened into the pane a start page has just left.
    expect(h.fillers).toEqual([])
  })

  it('keeps the active page active in its new tile, and the first one when it was a start page', () => {
    const h = harness('2x2', ['start', 'a', 'b', 'c'])
    seed(h, ['start', 'a', 'b', 'c'])
    h.startPages.add('start')
    h.split.setActiveTile(3)

    h.occupancy.chooseLayout('1+2')

    expect(h.split.toState().tileTabIds).toEqual(['a', 'b', 'c'])
    expect(h.split.activeTabId()).toBe('c')

    const other = harness('2x2', ['start', 'a', 'b', 'c'])
    seed(other, ['start', 'a', 'b', 'c'])
    other.startPages.add('start')
    other.occupancy.chooseLayout('1+2')
    expect(other.split.activeTabId()).toBe('a')
  })

  it('dissolves into a single page when fewer than two pages are left', () => {
    const h = harness('1x3', ['start-1', 'youtube', 'start-2'])
    seed(h, ['start-1', 'youtube', 'start-2'])
    h.startPages.add('start-1').add('start-2')

    h.occupancy.chooseLayout('1x2')

    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['youtube'])
    expect(h.ended).toEqual([{ id: '1x3', tiles: ['start-1', 'youtube', 'start-2'] }])
    expect([...h.closed].sort()).toEqual(['start-1', 'start-2'])
  })

  it('closes no start page when the choice has as many tiles or more', () => {
    const grown = harness('1x2', ['start', 'a'])
    seed(grown, ['start', 'a'])
    grown.startPages.add('start')
    grown.occupancy.chooseLayout('2x2')
    expect(grown.closed).toEqual([])
    expect(grown.split.toState().tileTabIds.slice(0, 2)).toEqual(['start', 'a'])

    const reshaped = harness('1x4', ['a', 'start', 'b', 'c'])
    seed(reshaped, ['a', 'start', 'b', 'c'])
    reshaped.startPages.add('start')
    reshaped.occupancy.chooseLayout('2x2')
    expect(reshaped.closed).toEqual([])
    expect(reshaped.split.toState().tileTabIds).toEqual(['a', 'start', 'b', 'c'])
  })
})

describe('ending a tiled view (U4, R8)', () => {
  it('closes the start page and stands the pages where the entry stood, the active one active (AE3)', () => {
    const h = harness('1x3', ['mail', 'youtube', 'start', 'twitch', 'news'])
    seed(h, ['youtube', 'start', 'twitch'])
    h.startPages.add('start')
    h.split.setActiveTile(2)

    h.occupancy.chooseLayout('1x1')

    expect(h.ended).toEqual([{ id: '1x3', tiles: ['youtube', 'start', 'twitch'] }])
    expect(h.closed).toEqual(['start'])
    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['twitch'])
    expect(h.split.tileOfTab('youtube')).toBeNull()
    expect(h.order).toEqual(['mail', 'youtube', 'twitch', 'news'])
  })

  it('shows the first remaining page when the active tile held a start page', () => {
    const h = harness('1x3', ['youtube', 'start', 'twitch'])
    seed(h, ['youtube', 'start', 'twitch'])
    h.startPages.add('start')
    h.split.setActiveTile(1)

    h.occupancy.chooseLayout('1x1')

    expect(h.split.toState().tileTabIds).toEqual(['youtube'])
    expect(h.split.activeTabId()).toBe('youtube')
  })

  it('leaves a fresh start tab when every tile was a start page and the window had nothing else', () => {
    const h = harness('1x2', ['start-1', 'start-2'])
    seed(h, ['start-1', 'start-2'])
    h.startPages.add('start-1').add('start-2')
    closeLikeTheWindow(h)

    h.occupancy.chooseLayout('1x1')

    expect([...h.closed].sort()).toEqual(['start-1', 'start-2'])
    expect(h.order).toEqual(['fresh'])
    expect(h.split.toState().tileTabIds).toEqual(['fresh'])
  })

  it('shows the next ordinary tab when every tile was a start page', () => {
    const h = harness('1x2', ['mail', 'start-1', 'start-2'])
    seed(h, ['start-1', 'start-2'])
    h.startPages.add('start-1').add('start-2')
    closeLikeTheWindow(h)

    h.occupancy.chooseLayout('1x1')

    expect(h.order).toEqual(['mail'])
    expect(h.split.toState().tileTabIds).toEqual(['mail'])
  })

  it('closes nothing when a single page is chosen again', () => {
    const h = harness('1x1', ['start'])
    seed(h, ['start'])
    h.startPages.add('start')

    h.occupancy.chooseLayout('1x1')

    expect(h.closed).toEqual([])
    expect(h.split.toState().tileTabIds).toEqual(['start'])
  })
})

describe('ending a tiled view that is put away (KTD12)', () => {
  it('closes its start pages and stands the rest in tile order where its entry stood', () => {
    const h = harness('1x1', ['mail', 'twitch', 'start', 'youtube', 'news'])
    seed(h, ['mail'])
    h.startPages.add('start')

    h.occupancy.dissolveOffScreen(['youtube', 'start', null, 'twitch'])

    expect(h.closed).toEqual(['start'])
    expect(h.order).toEqual(['mail', 'youtube', 'twitch', 'news'])
    // The screen and its active tab are not touched.
    expect(h.split.toState().tileTabIds).toEqual(['mail'])
    expect(h.layoutChanges).toEqual([])
    expect(h.activated).toEqual([])
  })
})

describe('what never closes a start page (R8)', () => {
  it('closes ranks after a single tab closes without asking for start pages to close', () => {
    const h = harness('1x3', ['a', 'start', 'c'])
    h.split.assignTab('start', 1)
    h.split.assignTab('c', 2)
    h.startPages.add('start')

    h.occupancy.afterTabClosed(0)

    expect(h.closed).toEqual([])
    expect(h.split.toState().tileTabIds).toEqual(['start', 'c'])
    expect(h.layoutChanges.every((change) => !change.options.closeStartPages)).toBe(true)
  })

  it('closes an orphaned start page only for a change that asks for it', () => {
    const kept = harness('2x2', ['a', 'start'])
    kept.startPages.add('start')
    kept.occupancy.afterLayoutChange(['start'], { fill: false, closeStartPages: false })
    expect(kept.closed).toEqual([])

    const closed = harness('2x2', ['a', 'start'])
    closed.startPages.add('start')
    closed.occupancy.afterLayoutChange(['start'], { fill: false, closeStartPages: true })
    expect(closed.closed).toEqual(['start'])
  })
})

describe('after the layout changed', () => {
  it('unassigns the tabs that lost their tile rather than closing them', () => {
    const h = harness('2x2', ['tab-1', 'tab-2', 'tab-3', 'tab-4'])
    seed(h, ['tab-1', 'tab-2', 'tab-3', 'tab-4'])
    h.occupancy.afterLayoutChange(['tab-3', 'tab-4'], { fill: false, closeStartPages: false })
    expect(h.unassigned).toEqual(['tab-3', 'tab-4'])
    expect(h.closed).toEqual([])
  })

  it('closes an untouched filler that lost its tile', () => {
    const h = harness('2x2', ['tab-1', 'filler-x'])
    h.ephemeral.add('filler-x')
    h.occupancy.afterLayoutChange(['filler-x'], { fill: false, closeStartPages: false })
    expect(h.closed).toEqual(['filler-x'])
  })

  it('keeps a filler the user navigated, because it left the set', () => {
    const h = harness('2x2', ['tab-1', 'was-a-filler'])
    h.occupancy.afterLayoutChange(['was-a-filler'], { fill: false, closeStartPages: false })
    expect(h.closed).toEqual([])
    expect(h.unassigned).toEqual(['was-a-filler'])
  })

  it('moves no loaded tab into a tile that has nothing in it (KTD10)', () => {
    const h = harness('1x2', ['tab-1', 'tab-hidden'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: false, closeStartPages: false })
    expect(h.split.tabIdAt(1)).toBeNull()
  })

  it('opens a new tab rather than unfolding a collapsed one into the empty tile', () => {
    /*
      The same conflation as in "after a tab closed", from the other direction, and here it
      compounds: once a folded-away tab sits in a pane beside a loose one, the next settle sees one
      named group among the seated tabs and pulls the loose tab into it — so a second page leaves
      the strip while staying on screen. A fresh start page is the honest answer; the collapsed
      group stays folded until the user unfolds it.
    */
    const h = harness('1x2', ['tab-1', 'tab-folded'])
    h.split.assignTab('tab-1', 0)
    h.collapsed.add('tab-folded')
    h.occupancy.afterLayoutChange([], { fill: true, closeStartPages: false })
    expect(h.split.tileOfTab('tab-folded')).toBeNull()
    expect(h.fillers).toEqual([1])
  })

  it('opens a start page rather than reusing a loaded tab (KTD10)', () => {
    /*
      Reusing what was loaded saved a renderer process, and that was the whole argument for it. It
      does not survive the strip showing tiled views as entries: the loaded tab is somebody's — an
      ordinary tab where the user left it, or a member of another view — and a start page is nobody's.
    */
    const h = harness('1x2', ['tab-1', 'tab-hidden'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: true, closeStartPages: false })
    expect(h.fillers).toEqual([1])
    expect(h.split.tileOfTab('tab-hidden')).toBeNull()
  })

  it('fills every empty tile with a start page', () => {
    const h = harness('2x2', ['tab-1', 'tab-hidden'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: true, closeStartPages: false })
    expect(h.fillers).toEqual([1, 2, 3])
  })

  it('leaves tiles empty when asked not to fill', () => {
    const h = harness('2x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: false, closeStartPages: false })
    expect(h.fillers).toEqual([])
    expect(h.split.tabIdAt(1)).toBeNull()
  })

  it('moves no hidden tab in when the user turned adaptation off', () => {
    /*
      The gap this closes. `fillEmptyTiles` consulted the switch and rehoming did not, so choosing a
      four-tile layout with adaptation off opened no start pages — and then seated three loaded tabs
      anyway. "Off" meant "off, unless something happens to be loaded", which is not a rule a user can
      hold in their head, and the two acts are indistinguishable once the pane is on screen.
    */
    const h = harness('2x2', ['tab-1', 'tab-hidden'])
    h.split.assignTab('tab-1', 0)
    h.adapt = false

    h.occupancy.afterLayoutChange([], { fill: true, closeStartPages: false })

    expect(h.split.toState().tileTabIds).toEqual(['tab-1', null, null, null])
    expect(h.fillers).toEqual([])
  })

  it('still takes away the tile of a tab that lost it when adaptation is off', () => {
    // The guard is on filling panes, not on the bookkeeping. A tab whose tile no longer exists is
    // unassigned either way — leaving it pointing at a tile the layout does not have is a broken
    // window, not a preference.
    const h = harness('2x2', ['tab-1', 'tab-2'])
    seed(h, ['tab-1', 'tab-2'])
    h.adapt = false

    h.occupancy.afterLayoutChange(['tab-2'], { fill: true, closeStartPages: false })

    expect(h.unassigned).toEqual(['tab-2'])
  })
})

describe('after a tab closed', () => {
  it('closes ranks rather than moving a loaded tab into the pane that opened up (KTD10, AE7)', () => {
    /*
      The pull-in is gone. It kept the layout the user chose by seating the first loaded tab that had
      no pane — which, once a tiled view is an entry in the strip, is a member of another view or an
      ordinary tab leaving its place unasked (R16). The view closes ranks instead: the pages after
      the gap move up one tile each and the layout loses the pane that is left over.
    */
    const h = harness('1x3', ['a', 'c', 'loose'])
    h.split.assignTab('c', 2)
    h.split.assignTab('a', 0)
    h.occupancy.afterTabClosed(1)
    expect(h.split.layout).toBe('1x2')
    expect(h.split.toState().tileTabIds).toEqual(['a', 'c'])
    expect(h.split.tileOfTab('loose')).toBeNull()
  })

  it('takes the pane away and keeps the page beside it on screen', () => {
    // A shrink alone kept tile 0 and dropped tile 1 — the gap stayed and the page left the screen.
    const h = harness('1x2', ['tab-2'])
    h.split.assignTab('tab-2', 1)
    h.occupancy.afterTabClosed(0)
    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['tab-2'])
  })

  it('keeps the page that was active the active one after closing ranks', () => {
    const h = harness('1x3', ['a', 'c'])
    h.split.assignTab('a', 0)
    h.split.assignTab('c', 2)
    h.split.setActiveTile(2)
    h.occupancy.afterTabClosed(1)
    expect(h.split.activeTabId()).toBe('c')
  })

  it('closes no start page on the way, because nothing is left off the end (R8)', () => {
    const h = harness('2x2', ['a', 'b', 'filler'])
    h.ephemeral.add('filler')
    seed(h, ['a', 'b'])
    h.split.assignTab('filler', 3)
    h.occupancy.afterTabClosed(2)
    expect(h.closed).toEqual([])
    expect(h.split.toState().tileTabIds).toEqual(['a', 'b', 'filler'])
  })

  it('leaves a folded-away tab folded away rather than seating it in the freed pane', () => {
    /*
      Two senses of "hidden" met in `#firstHiddenTab` and the wrong one won.

      A collapsed group's members have no tile — `setCollapsed` unassigns them on purpose, because a
      collapsed tab that kept its pane would be a page on screen with nothing in the strip to close
      it, mute it or switch away from it. "Has no tile" was also the whole test for "may be pulled
      into a free pane", so closing a neighbour re-seated exactly the tab that had just been folded
      away, and undid the collapse one pane at a time.

      It shrinks instead, which is what happens when there is genuinely nothing to show.
    */
    const h = harness('1x2', ['tab-2', 'tab-folded'])
    h.split.assignTab('tab-2', 1)
    h.collapsed.add('tab-folded')
    h.occupancy.afterTabClosed(0)
    expect(h.split.tileOfTab('tab-folded')).toBeNull()
    expect(h.split.layout).toBe('1x1')
  })

  it('does not open a replacement for the tab that was just closed', () => {
    // The trap: shrinking runs the fill rules again, and filling here would conjure a tab into
    // the very pane the user asked to be rid of, forever.
    const h = harness('1x2', ['tab-2'])
    h.split.assignTab('tab-2', 1)
    h.occupancy.afterTabClosed(0)
    expect(h.fillers).toEqual([])
  })

  it('steps down one arrangement for one closed tab', () => {
    const h = harness('2x2', ['a', 'b', 'c'])
    seed(h, ['a', 'b', 'c'])
    h.occupancy.afterTabClosed(3)
    expect(h.split.layout).toBe('1+2')
  })

  it('steps down as far as the pages left need, not leaving empty panes standing', () => {
    /*
      One step used to be enough because the pull-in filled any gap a closed tab left. Without it, a
      pane that was empty before the close — a seat whose tab closed while the view was put away —
      would stand empty for good. The shrink goes down the same chain, as far as the pages left need.
    */
    const h = harness('2x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterTabClosed(3)
    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['tab-1'])
  })

  it('keeps a row a row while it shrinks', () => {
    const h = harness('1x4', ['a', 'b'])
    seed(h, ['a', 'b'])
    h.occupancy.afterTabClosed(3)
    expect(h.split.layout).toBe('1x2')
  })

  it('leaves the layout alone at a single view', () => {
    const h = harness('1x1', ['tab-1'])
    h.occupancy.afterTabClosed(0)
    expect(h.split.layout).toBe('1x1')
  })

  it('has nothing smaller to go to when a single view empties', () => {
    // The window's own last tab, with nothing loaded to take its place. There is no arrangement
    // below one tile, and the window opens a fresh start page instead — which is its business, not
    // this one's.
    const h = harness('1x1', [])
    h.occupancy.afterTabClosed(0)
    expect(h.split.layout).toBe('1x1')
    expect(h.fillers).toEqual([])
  })

  it('leaves the layout alone when the user turned adaptation off', () => {
    const h = harness('1x2', ['tab-2'])
    h.split.assignTab('tab-2', 1)
    h.adapt = false
    h.occupancy.afterTabClosed(0)
    expect(h.split.layout).toBe('1x2')
  })

  it('leaves the pane empty rather than sliding a hidden tab in when adaptation is off', () => {
    /*
      The third path, and the one that made "off means off" unreachable by guarding the layout change
      alone. The shrink already stopped for this switch; the pull-in did not, so the browser kept the
      pane *and* chose what appeared in it — a page the user had not asked for, in the pane they had
      just cleared, with no way to predict either from the setting.

      The cost is the hole in the layout, and it is the intended state: the pages stay loaded and in
      the strip, and putting one back is a drag into the pane.
    */
    const h = harness('1x2', ['tab-2', 'tab-hidden'])
    h.split.assignTab('tab-2', 1)
    h.adapt = false

    h.occupancy.afterTabClosed(0)

    expect(h.split.tabIdAt(0)).toBeNull()
    expect(h.split.layout).toBe('1x2')
    expect(h.order).toContain('tab-hidden')
  })

  it('pulls no tab in from outside when adaptation is on and the gap cannot be closed', () => {
    // The last of the pull-in: nothing is seated from off the grid, however many loaded tabs wait.
    const h = harness('1x2', ['a', 'b', 'loose'])
    seed(h, ['a', 'b'])
    h.split.forgetTab('a')
    h.order = h.order.filter((tabId) => tabId !== 'a')
    h.occupancy.afterTabClosed(0)
    expect(h.split.toState().tileTabIds).toEqual(['b'])
    expect(h.split.tileOfTab('loose')).toBeNull()
  })

  it('does nothing for a tab that was not in a tile', () => {
    const h = harness('1x2', ['tab-1', 'tab-2'])
    seed(h, ['tab-1', 'tab-2'])
    h.occupancy.afterTabClosed(null)
    expect(h.split.layout).toBe('1x2')
    expect(h.closed).toEqual([])
  })
})

/**
 * The one tab of a single view closing (KTD10).
 *
 * The one place a page is still chosen for a pane, because the alternative is a window showing
 * nothing while its strip is full of tabs. What may be chosen is the narrow part: an ordinary tab
 * the strip is drawing — never a folded one and never a member of a tiled view, which would stand
 * alone on screen while its entry claims it. Only when nothing else is left does a whole view come
 * back, and then as the view it is.
 */
describe('the only tab of a single view closing', () => {
  it('shows the first ordinary tab, passing over the members of a tiled view', () => {
    const h = harness('1x1', ['member-1', 'member-2', 'folded', 'ordinary'])
    h.members.add('member-1')
    h.members.add('member-2')
    h.collapsed.add('folded')
    h.occupancy.afterTabClosed(0)
    expect(h.split.toState().tileTabIds).toEqual(['ordinary'])
    expect(h.restoredFirst).toBe(0)
  })

  it('brings back the first tiled view when only members are left', () => {
    const h = harness('1x1', ['member-1', 'member-2', 'folded'])
    h.members.add('member-1')
    h.members.add('member-2')
    h.collapsed.add('folded')
    h.occupancy.afterTabClosed(0)
    expect(h.restoredFirst).toBe(1)
    expect(h.split.toState().tileTabIds).toEqual([null])
  })

  it('does so with adaptation off too, because no layout changes', () => {
    /*
      The switch governs the browser reshaping the panes: filling new ones, closing ranks. Here there
      is one pane before and one after, and leaving it blank would leave a toolbar acting on nothing
      — the state the window's own "a window always keeps a tab" rule exists to prevent (KTD9).
    */
    const h = harness('1x1', ['ordinary'])
    h.adapt = false
    h.occupancy.afterTabClosed(0)
    expect(h.split.toState().tileTabIds).toEqual(['ordinary'])
  })

  it('applies after a split closed its ranks down to one empty pane', () => {
    const h = harness('1x2', ['member', 'ordinary'])
    h.members.add('member')
    h.occupancy.afterTabClosed(0)
    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['ordinary'])
  })

  it('opens nothing itself when the window has no other tab', () => {
    // The host finds no view to bring back, and the window's own "always keep a tab" rule opens a
    // start page — a filler from here would be a second one.
    const h = harness('1x1', [])
    h.occupancy.afterTabClosed(0)
    expect(h.split.toState().tileTabIds).toEqual([null])
    expect(h.fillers).toEqual([])
  })
})

describe('releasing a tab from the tiled view on screen (U10, R9)', () => {
  it('closes the ranks of a 1x3 and puts the tab right behind the entry', () => {
    // `x` before the view and `y` after it: the released page lands between the entry and `y`.
    const h = harness('1x3', ['x', 'a', 'b', 'c', 'y'])
    seed(h, ['a', 'b', 'c'])
    h.split.setActiveTile(0)

    h.occupancy.releaseTab('b')

    expect(h.split.layout).toBe('1x2')
    expect(h.split.toState().tileTabIds).toEqual(['a', 'c'])
    expect(h.split.tileOfTab('b')).toBeNull()
    expect(h.order).toEqual(['x', 'a', 'c', 'b', 'y'])
    expect(h.split.activeTabId()).toBe('a')
    expect(h.closed).toEqual([])
  })

  it('keeps a tile of the view active when the released tab was the active one', () => {
    const h = harness('1x3', ['a', 'b', 'c'])
    seed(h, ['a', 'b', 'c'])
    h.split.setActiveTile(2)

    h.occupancy.releaseTab('c')

    expect(h.split.toState().tileTabIds).toEqual(['a', 'b'])
    expect(h.split.activeTabId()).toBe('b')
    // Through the window's own method, so the focus and the audio move with it.
    expect(h.activated.at(-1)).toBe(1)
  })

  it('follows the active page when it moves up into the gap', () => {
    const h = harness('1x3', ['a', 'b', 'c'])
    seed(h, ['a', 'b', 'c'])
    h.split.setActiveTile(2)

    h.occupancy.releaseTab('a')

    expect(h.split.toState().tileTabIds).toEqual(['b', 'c'])
    expect(h.split.activeTabId()).toBe('c')
  })

  it('ends a 1x2: the page left shows the window and both are ordinary tabs', () => {
    const h = harness('1x2', ['a', 'b', 'z'])
    seed(h, ['a', 'b'])
    h.split.setActiveTile(1)

    h.occupancy.releaseTab('b')

    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['a'])
    expect(h.split.activeTabId()).toBe('a')
    expect(h.order).toEqual(['a', 'b', 'z'])
    expect(h.closed).toEqual([])
  })

  it('closes ranks with adaptation off too, because the user asked for this one', () => {
    // The switch governs the browser reshaping the panes on its own; a release is the user's act.
    const h = harness('1x3', ['a', 'b', 'c'])
    seed(h, ['a', 'b', 'c'])
    h.adapt = false

    h.occupancy.releaseTab('a')

    expect(h.split.layout).toBe('1x2')
    expect(h.split.toState().tileTabIds).toEqual(['b', 'c'])
  })

  it('closes no start page, not even one in another tile (R8)', () => {
    const h = harness('2x2', ['a', 'home-1', 'b', 'home-2'])
    seed(h, ['a', 'home-1', 'b', 'home-2'])
    h.startPages.add('home-1')
    h.startPages.add('home-2')
    h.ephemeral.add('home-2')

    h.occupancy.releaseTab('a')

    expect(h.closed).toEqual([])
    expect(h.split.toState().tileTabIds).toEqual(['home-1', 'b', 'home-2'])
    expect(h.layoutChanges.every(({ options }) => !options.closeStartPages && !options.fill)).toBe(
      true
    )
  })

  it('does nothing for a tab that has no tile, or in a window showing one page', () => {
    const tiled = harness('1x2', ['a', 'b', 'loose'])
    seed(tiled, ['a', 'b'])
    tiled.occupancy.releaseTab('loose')
    expect(tiled.split.toState().tileTabIds).toEqual(['a', 'b'])
    expect(tiled.order).toEqual(['a', 'b', 'loose'])

    const single = harness('1x1', ['a', 'b'])
    seed(single, ['a'])
    single.occupancy.releaseTab('a')
    expect(single.split.toState().tileTabIds).toEqual(['a'])
  })
})

describe('where a new tab goes', () => {
  it('takes the whole window rather than a pane', () => {
    /*
      The reversal, and the reason for it: a tab that lands in a quarter of the window is not what
      "new tab" means in a browser, and asking for one is not asking to keep the arrangement you were
      in. What the earlier fix bought survives it — see the two checks below.
    */
    const h = harness('2x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    expect(h.occupancy.claimTileForNewTab()).toBe(0)
    expect(h.split.layout).toBe('1x1')
  })

  it('leaves no pane behind that says "drag a tab here"', () => {
    // The failure the earlier fix removed, and the one this must not bring back. A tab arriving
    // cannot leave an empty pane, because it takes the panes away instead of moving into one.
    const h = harness('2x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.claimTileForNewTab()
    // One pane, free for the tab that is arriving — not three waiting for somebody to drag.
    expect(h.split.toState().tileTabIds).toEqual([null])
    expect(h.fillers).toEqual([])
  })

  it('costs the page in front of the user nothing but the split', () => {
    // The other half. Nothing is evicted from a pane: the panes go, and the pages in them stay
    // loaded and in the strip, so choosing a layout again brings them back.
    const h = harness('1x2', ['tab-1', 'tab-2'])
    seed(h, ['tab-1', 'tab-2'])
    h.occupancy.claimTileForNewTab()
    expect(h.closed).toEqual([])
    expect(h.unassigned).toEqual(['tab-1', 'tab-2'])
    expect(h.order).toEqual(['tab-1', 'tab-2'])
  })

  it('closes no start page that sat in the tiling it puts away (R8)', () => {
    // A filler the browser opened is still a member of the tiled view; putting that away is not
    // ending it, so the start page stays where the view will come back to it.
    const h = harness('1x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.fillEmptyTiles()
    h.occupancy.claimTileForNewTab()
    expect(h.closed).toEqual([])
    expect(h.order).toEqual(['tab-1', 'filler-1'])
  })

  it('leaves a fresh window in the layout it was opened in', () => {
    // No tile holds anything yet, so this is a window's first tab and `splitView.defaultLayout` is
    // the arrangement the user asked for. Collapsing it here would make that setting unreachable.
    const h = harness('2x2', [])
    expect(h.occupancy.claimTileForNewTab()).toBe(0)
    expect(h.split.layout).toBe('2x2')
  })

  it('takes the whole window with adaptation off as well, rather than an empty pane (KTD9)', () => {
    /*
      The switch used to keep the panes and give the new tab the first empty one. That made a tiled
      view the one thing a new tab could join without being asked — and with the view an entry in the
      strip, a tab slipping into it is a membership nobody chose (R3). The switch now governs only
      filling new panes and closing ranks; a new tab puts the view away either way.
    */
    const h = harness('1x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    h.split.setActiveTile(0)
    h.adapt = false
    expect(h.occupancy.claimTileForNewTab()).toBe(0)
    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual([null])
  })

  it('replaces no page in a full view with adaptation off (KTD9)', () => {
    // The old fallback was the active pane, which replaced the page in front of the user.
    const h = harness('1x2', ['tab-1', 'tab-2'])
    seed(h, ['tab-1', 'tab-2'])
    h.split.setActiveTile(1)
    h.adapt = false
    expect(h.occupancy.claimTileForNewTab()).toBe(0)
    expect(h.split.layout).toBe('1x1')
    expect(h.unassigned).toEqual(['tab-1', 'tab-2'])
    expect(h.closed).toEqual([])
  })

  it('leaves a fresh window in its layout with adaptation off, too', () => {
    const h = harness('2x2', [])
    h.adapt = false
    expect(h.occupancy.claimTileForNewTab()).toBe(0)
    expect(h.split.layout).toBe('2x2')
  })

  it('does nothing to a window already showing one tile', () => {
    const h = harness('1x1', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    expect(h.occupancy.claimTileForNewTab()).toBe(0)
    expect(h.split.layout).toBe('1x1')
  })
})

/**
 * The arrangement a new tab displaces.
 *
 * The window now records this on every settle, so by the time a new tab is asked for the book usually
 * holds it already. The call here is kept as the belt-and-braces one, and it is the reason these checks
 * stay: the settle is *scheduled*, one `setImmediate` per burst, so two messages arriving in the same
 * turn of the loop — split this window, then open a tab — reach the collapse before any round could
 * have written anything down. This is the last moment the arrangement exists.
 */
describe('the arrangement a new tab displaces', () => {
  it('is written down before the panes go, layout and seating together', () => {
    /*
      What was lost before this existed. "The pages stay loaded and choosing a layout again brings them
      back" was true and not enough: they came back in the strip's order, into whichever layout was
      chosen next, so *which* arrangement it had been and who sat where was gone and unrecoverable.

      Both halves are asserted. Without the layout id there is nothing to apply; without the seating the
      recording is only a set of tabs.
    */
    const h = harness('2x2', ['a', 'b', 'c', 'd'])
    seed(h, ['a', 'b', 'c', 'd'])

    h.occupancy.claimTileForNewTab()

    expect(h.kept).toEqual([{ id: '2x2', tiles: ['a', 'b', 'c', 'd'] }])
  })

  it('is the arrangement as it stood, not the one left after the collapse', () => {
    // Order matters, and getting it wrong is silent: read after `applyLayout` the split holds one tile
    // and the recording would be a single view — the arrangement would be "remembered" as the thing it
    // was replaced by.
    const h = harness('1x2', ['a', 'b'])
    seed(h, ['a', 'b'])

    h.occupancy.claimTileForNewTab()

    expect(h.kept[0]?.id).toBe('1x2')
    expect(h.split.layout).toBe('1x1')
  })

  it('records the empty tiles as empty rather than closing the gaps', () => {
    // Positional, because position is the information. A recording of `['a', 'c']` for a three-column
    // row would put `c` in the middle column on the way back, which is not where the user left it.
    const h = harness('1x3', ['a', 'c'])
    h.split.assignTab('a', 0)
    h.split.assignTab('c', 2)

    h.occupancy.claimTileForNewTab()

    expect(h.kept[0]?.tiles).toEqual(['a', null, 'c'])
  })

  it('is written down with adaptation off as well, because it is put away all the same (KTD9)', () => {
    const h = harness('1x2', ['a', 'b'])
    seed(h, ['a', 'b'])
    h.adapt = false
    h.occupancy.claimTileForNewTab()
    expect(h.kept).toEqual([{ id: '1x2', tiles: ['a', 'b'] }])
  })

  it('writes nothing down for a window whose panes are all empty', () => {
    const h = harness('2x2', [])
    h.occupancy.claimTileForNewTab()
    expect(h.kept).toEqual([])
  })

  it('writes nothing down for a single view', () => {
    const h = harness('1x1', ['a'])
    h.split.assignTab('a', 0)
    h.occupancy.claimTileForNewTab()
    expect(h.kept).toEqual([])
  })
})

describe('putting a recorded arrangement back', () => {
  /** The state a window is in after a new tab took the whole window from a `2x2`. */
  function displaced(): Harness {
    const h = harness('2x2', ['a', 'b', 'c', 'd'])
    seed(h, ['a', 'b', 'c', 'd'])
    h.occupancy.claimTileForNewTab()
    h.order.push('fresh')
    h.split.assignTab('fresh', 0)
    return h
  }

  it('brings back the layout and seats every tab where it was', () => {
    // The half without which the recording is a memory nobody can read.
    const h = displaced()
    const kept = h.kept[0]!

    h.occupancy.restoreArrangement(kept.id, kept.tiles, 'c')

    expect(h.split.layout).toBe('2x2')
    expect(h.split.toState().tileTabIds).toEqual(['a', 'b', 'c', 'd'])
  })

  it('makes the tab that was clicked the active one', () => {
    // The tab the user clicked has to be the one they end up in. Restoring the arrangement and leaving
    // the focus in tile 0 would answer a click on the third pane by focusing the first.
    const h = displaced()
    h.occupancy.restoreArrangement(h.kept[0]!.id, h.kept[0]!.tiles, 'c')
    expect(h.activated).toContain(2)
    expect(h.split.activeTile).toBe(2)
  })

  it('leaves a closed tab’s tile empty rather than shifting the others along', () => {
    /*
      Spelled out in the recording's own docblock and the reason `seats` is positional. Closing `b` and
      sliding `c` and `d` up would answer "put it back the way it was" by rearranging two pages that
      never moved.
    */
    const h = displaced()
    const kept = h.kept[0]!

    h.occupancy.restoreArrangement('2x2', withoutTab(kept.tiles, 'b'), 'a')

    expect(h.split.toState().tileTabIds).toEqual(['a', null, 'c', 'd'])
  })

  it('costs the tab that displaced it nothing but its tile', () => {
    // Spec 2 from the other direction, and the way back: the new tab is unassigned rather than closed,
    // stays in the strip, and one click on it takes the window again.
    const h = displaced()
    h.occupancy.restoreArrangement(h.kept[0]!.id, h.kept[0]!.tiles, 'a')

    expect(h.closed).toEqual([])
    expect(h.split.tileOfTab('fresh')).toBeNull()
    expect(h.order).toContain('fresh')
  })

  it('opens no filler for a tile the arrangement leaves empty', () => {
    /*
      `fill: false` on the layout change, and it is load-bearing rather than tidy. Filling would open a
      start page into the tile the arrangement is about to seat a real page in, and that page would then
      have to be evicted again — a pane holding something nobody asked for while a loaded page leaves the
      screen, which is the failure this whole controller exists to prevent.
    */
    const h = displaced()
    const kept = h.kept[0]!

    h.occupancy.restoreArrangement('2x2', withoutTab(kept.tiles, 'b'), 'a')

    expect(h.fillers).toEqual([])
  })

  it('seats the tabs without changing a layout that already matches', () => {
    // A window displaced without the layout changing — the two-pane recording is applied into a
    // two-pane window — so the recording is applied by seating alone. `applyLayout` is a no-op for the
    // same id, and depending on it would make the restore silently do nothing.
    const h = harness('1x2', ['a', 'b'])
    h.split.assignTab('b', 0)

    h.occupancy.restoreArrangement('1x2', ['a', 'b'], 'a')

    expect(h.split.toState().tileTabIds).toEqual(['a', 'b'])
    expect(h.split.activeTile).toBe(0)
  })

  it('applies nothing at all when one of the recording’s tabs is folded away (R14, KD8)', () => {
    /*
      Whole or nothing, and the protection that the rebuild took away.

      While a recording lived on a tab group it could not name a tab of a collapsed group and be
      applied by accident: it belonged to exactly one group, and `sanitisedLayout` dropped any tab
      that group did not have. A recording that belongs to no group has neither guarantee, so the
      refusal has to be written down.

      Partial application is the outcome being refused, not an approximation of it: `b` folded away
      would leave tile 1 empty, the window would never match the recording, and the next click would
      apply the very same one again.
    */
    const h = harness('1x1', ['a', 'b'])
    h.split.assignTab('a', 0)
    h.collapsed.add('b')

    h.occupancy.restoreArrangement('1x2', ['a', 'b'], 'a')

    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['a'])
    expect(h.activated).toEqual([])
  })

  it('applies a recording whose empty tiles sit beside a folded-away tab', () => {
    // The refusal is about the tabs the recording *seats*, not about every tab in the window. A
    // collapsed group elsewhere in the strip has nothing to do with this recording.
    const h = harness('1x1', ['a', 'b', 'folded'])
    h.split.assignTab('a', 0)
    h.collapsed.add('folded')

    h.occupancy.restoreArrangement('1x3', ['a', null, 'b'], 'b')

    expect(h.split.layout).toBe('1x3')
    expect(h.split.toState().tileTabIds).toEqual(['a', null, 'b'])
  })
})

/** A seating with one tab taken out of it, its tile left empty. */
function withoutTab(seats: Array<string | null>, tabId: string): Array<string | null> {
  return seats.map((id) => (id === tabId ? null : id))
}

describe('applying a drop', () => {
  it('switches layout and puts the tab in the promised tile', () => {
    const h = harness('1x1', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    const rightEdge = dropZonesFor('1x1', CONTENT).find((zone) => zone.id === '0-right')!

    h.occupancy.applyDrop('tab-1', rightEdge)

    expect(h.split.layout).toBe('1x2')
    expect(h.split.tabIdAt(1)).toBe('tab-1')
    expect(h.activated).toContain(1)
  })

  it('keeps the layout for a plain drop', () => {
    const h = harness('2x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    const thirdTile = dropZonesFor('2x2', CONTENT).find((zone) => zone.id === '2-centre')!

    h.occupancy.applyDrop('tab-1', thirdTile)

    expect(h.split.layout).toBe('2x2')
    expect(h.split.tabIdAt(2)).toBe('tab-1')
  })

  it('does not fill the other tiles a split just created', () => {
    // A drop is one deliberate action. Opening two more tabs alongside it is not what was asked.
    const h = harness('1x1', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    const topEdge = dropZonesFor('1x1', CONTENT).find((zone) => zone.id === '0-top')!

    h.occupancy.applyDrop('tab-1', topEdge)
    expect(h.fillers).toEqual([])
  })

  it('gives the split it creates the page it displaced, not an unrelated one', () => {
    /*
      The reported bug, at the point where it happened. The layout change used to rehome hidden tabs
      into the tile it had just created, so the tile went to whichever tab came first in the strip —
      and the page the drop displaced then had nowhere to go and left the screen. Dropping onto the
      middle of a three-column row therefore took the middle page away and produced a fourth column
      holding something the user had not asked for.
    */
    const h = harness('1x3', ['a', 'b', 'c', 'unrelated', 'dragged'])
    seed(h, ['a', 'b', 'c'])
    const middleEdge = dropZonesFor('1x3', CONTENT).find((zone) => zone.id === '1-right')!

    h.occupancy.applyDrop('dragged', middleEdge)

    expect(h.split.layout).toBe('1x4')
    expect(h.split.toState().tileTabIds).toEqual(['a', 'b', 'dragged', 'c'])
  })

  it('shifts the columns along when a row grows, rather than reordering them', () => {
    // A vertical edge inserts a column. The pages beyond it move along one and keep their order:
    // the alternative put the displaced one at the far end and left the row rearranged.
    const h = harness('1x3', ['a', 'b', 'c', 'dragged'])
    seed(h, ['a', 'b', 'c'])
    const firstColumnRight = dropZonesFor('1x3', CONTENT).find((zone) => zone.id === '0-right')!

    h.occupancy.applyDrop('dragged', firstColumnRight)

    expect(h.split.toState().tileTabIds).toEqual(['a', 'dragged', 'b', 'c'])
  })

  it('puts the dragged page at the head of a row and everything else after it', () => {
    const h = harness('1x3', ['a', 'b', 'c', 'dragged'])
    seed(h, ['a', 'b', 'c'])
    const head = dropZonesFor('1x3', CONTENT).find((zone) => zone.id === '0-left')!

    h.occupancy.applyDrop('dragged', head)

    expect(h.split.toState().tileTabIds).toEqual(['dragged', 'a', 'b', 'c'])
  })

  it('sends the halved tile’s page into the other half', () => {
    // A horizontal edge subdivides rather than inserts, so one page moves and the rest stay put.
    const h = harness('1x2', ['a', 'b', 'dragged'])
    seed(h, ['a', 'b'])
    const topOfLeft = dropZonesFor('1x2', CONTENT).find((zone) => zone.id === '0-top')!

    h.occupancy.applyDrop('dragged', topOfLeft)

    // `2x2` runs top-left, top-right, bottom-left, bottom-right: the left column is 0 and 2.
    expect(h.split.layout).toBe('2x2')
    expect(h.split.toState().tileTabIds).toEqual(['dragged', 'b', 'a', null])
  })

  it('swaps two panes when the page dropped came from one of them', () => {
    // Nothing is created, so the page that was there takes the tile the dragged one left. Evicting
    // it would empty a pane and take a page off the screen in one move.
    const h = harness('1x3', ['a', 'b', 'c'])
    seed(h, ['a', 'b', 'c'])
    const middle = dropZonesFor('1x3', CONTENT).find((zone) => zone.id === '1-centre')!

    h.occupancy.applyDrop('a', middle)

    expect(h.split.toState().tileTabIds).toEqual(['b', 'a', 'c'])
  })

  it('keeps the displaced page loaded when the grid has no room for it', () => {
    // Spec 2: a tab that loses its tile is unassigned, never closed. With four tabs and four tiles
    // there is nowhere for it to go, and that is the one case where a drop does hide a page.
    const h = harness('1x4', ['a', 'b', 'c', 'd', 'dragged'])
    seed(h, ['a', 'b', 'c', 'd'])
    const third = dropZonesFor('1x4', CONTENT).find((zone) => zone.id === '2-centre')!

    h.occupancy.applyDrop('dragged', third)

    expect(h.split.toState().tileTabIds).toEqual(['a', 'b', 'dragged', 'd'])
    expect(h.closed).toEqual([])
  })

  it('seats the page it displaced but no others when adaptation is off', () => {
    /*
      Where the line falls inside `applyDrop`, with both sides of it in one drop.

      `a` moves regardless of the switch: the user aimed at the tile it was in, so both pages are part
      of the gesture and the browser owes the displaced one somewhere to be. The two hidden tabs do
      not: tiles 2 and 3 are panes nobody aimed at, and seating a tab that had nothing to do with the
      drag is the adaptation that was turned off. With the switch on they would both be on screen.
    */
    const h = harness('2x2', ['a', 'hidden-1', 'hidden-2', 'dragged'])
    seed(h, ['a'])
    h.adapt = false
    const firstTile = dropZonesFor('2x2', CONTENT).find((zone) => zone.id === '0-centre')!

    h.occupancy.applyDrop('dragged', firstTile)

    expect(h.split.toState().tileTabIds).toEqual(['dragged', 'a', null, null])
  })

  it('seats no tab but the dragged one and the one it displaced, with adaptation on (KTD10)', () => {
    /*
      The same line as the test above, and the switch no longer moves it. With adaptation on the drop
      used to seat the two hidden tabs in the tiles nobody aimed at; each of them is somebody's —
      an ordinary tab or a member of another tiled view — and none of them was part of the gesture.
    */
    const h = harness('2x2', ['a', 'hidden-1', 'hidden-2', 'dragged'])
    seed(h, ['a'])
    const firstTile = dropZonesFor('2x2', CONTENT).find((zone) => zone.id === '0-centre')!

    h.occupancy.applyDrop('dragged', firstTile)

    expect(h.split.toState().tileTabIds).toEqual(['dragged', 'a', null, null])
  })

  it('survives a zone the layout has since outgrown', () => {
    /*
      The zones are computed once, at the start of the drag, and a layout change does not cancel it —
      a menu accelerator can arrive mid-gesture. So a zone naming the layout the window is already in
      is a real arrival, and the shift has nowhere to put the page it pushes out.
    */
    const h = harness('1x4', ['a', 'b', 'c', 'd', 'dragged'])
    seed(h, ['a', 'b', 'c', 'd'])
    const stale = dropZonesFor('1x3', CONTENT).find((zone) => zone.id === '2-right')!

    h.occupancy.applyDrop('dragged', stale)

    expect(h.split.layout).toBe('1x4')
    expect(h.split.toState().tileTabIds).toEqual(['a', 'b', 'c', 'dragged'])
    expect(h.closed).toEqual([])
  })
})

describe('every drag possibility, in every layout', () => {
  /*
    The property the reported bug broke, checked over all seven layouts and every zone in each rather
    than over the two the smoke test happened to exercise. Eighteen of the twenty-four split zones
    failed it, and both bands of the middle column of a three-column row were among them.

    Three parts, and the second is the one that was wrong: the page lands where the indicator
    promised, no page that was on screen leaves it while a tile stands empty, and the arrangement is
    the one the zone named.
  */
  const layouts: readonly LayoutId[] = ['1x1', '1x2', '2x1', '2x2', '1+2', '1x3', '1x4']

  for (const layout of layouts) {
    const seated = Array.from({ length: TILE_COUNT[layout] }, (_, index) => `t${index}`)

    for (const zone of dropZonesFor(layout, CONTENT)) {
      it(`${layout}: dropping on ${zone.id} keeps every page on screen`, () => {
        const h = harness(layout, [...seated, 'dragged'])
        seed(h, seated)

        h.occupancy.applyDrop('dragged', zone)

        const after = h.split.toState().tileTabIds
        expect(h.split.layout).toBe(zone.layout ?? layout)
        expect(after[zone.tileIndex]).toBe('dragged')

        // As many pages on screen as there are tiles to hold them, or as tabs to fill them. A
        // shortfall means a page was pushed out while a pane sat empty — which is both halves of
        // the bug in one number.
        const shown = after.filter((id) => id !== null)
        expect(shown.length).toBe(Math.min(seated.length + 1, after.length))
        expect(new Set(shown).size).toBe(shown.length)
      })
    }
  }
})

describe('fillers closing through the close contract', () => {
  /*
    `BrowserWindowController.closeTab` now asks a page before it finishes closing its tab, which makes the
    close asynchronous — except where nothing could object. A filler is that exception. The pass below
    used to seat a hidden tab straight after the close, which is what made the synchronous close
    load-bearing; that seating is gone (KTD10), and what is left is that a shrink sweeping up the
    browser's own filler asks its page nothing and leaves the tab that lost its tile off the grid.
  */
  it('closes the filler without asking it, and seats nobody in its place', () => {
    const h = harness('2x2', ['tab-1', 'filler-b', 'tab-2'])
    h.split.assignTab('tab-1', 1)
    h.split.assignTab('filler-b', 2)
    h.split.assignTab('tab-2', 3)
    h.ephemeral.add('filler-b')

    const pages = new Map<string, { closes: number }>()
    const tabFor = (tabId: string) => {
      if (!h.order.includes(tabId)) return undefined
      const page = pages.get(tabId) ?? { closes: 0 }
      pages.set(tabId, page)
      const contents = Object.assign(new EventEmitter(), {
        close: () => {
          page.closes += 1
        },
        isDestroyed: () => false,
        getURL: () => (h.ephemeral.has(tabId) ? HOME_URL : `https://example.com/${tabId}`)
      })
      return {
        ephemeral: h.ephemeral.has(tabId),
        view: { webContents: contents },
        toState: () => ({ url: contents.getURL(), unloaded: false })
      }
    }
    const contract = new CloseContract({
      on: () => undefined,
      tab: tabFor,
      groups: { displayOrder: () => h.order, groups: () => [], setCollapsed: () => undefined },
      activateTab: () => undefined,
      confirm: () => true,
      finish: (tabId) => h.forget(tabId),
      closeWindow: () => undefined,
      shutdown: { begun: false }
    })
    h.routeClose = (tabId) => contract.closeTab(tabId)

    h.occupancy.afterLayoutChange(h.split.setLayout('1x2'), { fill: false, closeStartPages: false })

    expect(h.closed).toEqual(['filler-b'])
    expect(pages.get('filler-b')?.closes ?? 0).toBe(0)
    expect(h.split.toState().tileTabIds).toEqual([null, 'tab-1'])
    expect(h.order).toContain('tab-2')
  })
})
