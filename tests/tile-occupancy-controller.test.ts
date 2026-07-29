import { describe, expect, it } from 'vitest'
import { SplitController } from '@main/browser/SplitController.js'
import {
  TileOccupancyController,
  type TileOccupancyHost
} from '@main/browser/TileOccupancyController.js'
import { dropZonesFor } from '@shared/split/dropzones.js'
import { TILE_COUNT, type LayoutId, type Rect } from '@shared/split/layout.js'
import type { TabGroupLayout } from '@shared/tabgroups/model.js'

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
   * Arrangements handed over on the way out, newest last.
   *
   * Recorded rather than acted on, because what this controller owes is the *report*: which layout it
   * was and who sat where, taken before the panes went. Whether a group keeps it belongs to
   * `groupToHoldArrangement` and is tested there.
   */
  kept: TabGroupLayout[]
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
    kept: []
  }

  let fillerSequence = 0

  const host: TileOccupancyHost = {
    split,
    adaptEnabled: () => state.adapt!,
    tabOrder: () => state.order!,
    isEphemeral: (tabId) => state.ephemeral!.has(tabId),
    isHiddenByCollapse: (tabId) => state.collapsed!.has(tabId),
    unassign: (tabId) => {
      state.unassigned!.push(tabId)
    },
    assignTabToTile: (tabId, tileIndex) => {
      split.assignTab(tabId, tileIndex)
    },
    closeTab: (tabId) => {
      state.closed!.push(tabId)
      state.order = state.order!.filter((id) => id !== tabId)
      state.ephemeral!.delete(tabId)
      split.forgetTab(tabId)
    },
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
      state.occupancy!.afterLayoutChange(split.setLayout(next), options)
    },
    keepArrangement: (layout) => {
      state.kept!.push(layout)
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

describe('after the layout changed', () => {
  it('unassigns the tabs that lost their tile rather than closing them', () => {
    const h = harness('2x2', ['tab-1', 'tab-2', 'tab-3', 'tab-4'])
    seed(h, ['tab-1', 'tab-2', 'tab-3', 'tab-4'])
    h.occupancy.afterLayoutChange(['tab-3', 'tab-4'], { fill: false, rehome: true })
    expect(h.unassigned).toEqual(['tab-3', 'tab-4'])
    expect(h.closed).toEqual([])
  })

  it('closes an untouched filler that lost its tile', () => {
    const h = harness('2x2', ['tab-1', 'filler-x'])
    h.ephemeral.add('filler-x')
    h.occupancy.afterLayoutChange(['filler-x'], { fill: false, rehome: true })
    expect(h.closed).toEqual(['filler-x'])
  })

  it('keeps a filler the user navigated, because it left the set', () => {
    const h = harness('2x2', ['tab-1', 'was-a-filler'])
    h.occupancy.afterLayoutChange(['was-a-filler'], { fill: false, rehome: true })
    expect(h.closed).toEqual([])
    expect(h.unassigned).toEqual(['was-a-filler'])
  })

  it('moves a hidden tab into a tile that has nothing in it', () => {
    const h = harness('1x2', ['tab-1', 'tab-hidden'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: false, rehome: true })
    expect(h.split.tabIdAt(1)).toBe('tab-hidden')
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
    h.occupancy.afterLayoutChange([], { fill: true, rehome: true })
    expect(h.split.tileOfTab('tab-folded')).toBeNull()
    expect(h.fillers).toEqual([1])
  })

  it('prefers a hidden tab over opening a new one', () => {
    // Reusing what is already loaded costs nothing; a new tab costs a renderer process.
    const h = harness('1x2', ['tab-1', 'tab-hidden'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: true, rehome: true })
    expect(h.fillers).toEqual([])
    expect(h.split.tabIdAt(1)).toBe('tab-hidden')
  })

  it('fills what is still empty after the hidden tabs run out', () => {
    const h = harness('2x2', ['tab-1', 'tab-hidden'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: true, rehome: true })
    expect(h.split.tabIdAt(1)).toBe('tab-hidden')
    expect(h.fillers).toEqual([2, 3])
  })

  it('leaves tiles empty when asked not to fill', () => {
    const h = harness('2x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: false, rehome: true })
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

    h.occupancy.afterLayoutChange([], { fill: true, rehome: true })

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

    h.occupancy.afterLayoutChange(['tab-2'], { fill: true, rehome: true })

    expect(h.unassigned).toEqual(['tab-2'])
  })
})

describe('after a tab closed', () => {
  it('moves a hidden tab into the pane that opened up', () => {
    // The hidden one moves in; the tab already on screen stays where it is rather than being
    // shuffled across the window because a neighbour closed.
    const h = harness('1x2', ['tab-2', 'tab-hidden'])
    h.split.assignTab('tab-2', 1)
    h.occupancy.afterTabClosed(0)
    expect(h.split.tabIdAt(0)).toBe('tab-hidden')
    expect(h.split.tabIdAt(1)).toBe('tab-2')
  })

  it('takes the pane away when there is nothing left to show there', () => {
    const h = harness('1x2', ['tab-2'])
    h.split.assignTab('tab-2', 1)
    h.occupancy.afterTabClosed(0)
    expect(h.split.layout).toBe('1x1')
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

  it('steps down one arrangement at a time', () => {
    const h = harness('2x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterTabClosed(3)
    expect(h.split.layout).toBe('1+2')
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

  it('does nothing for a tab that was not in a tile', () => {
    const h = harness('1x2', ['tab-1', 'tab-2'])
    seed(h, ['tab-1', 'tab-2'])
    h.occupancy.afterTabClosed(null)
    expect(h.split.layout).toBe('1x2')
    expect(h.closed).toEqual([])
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
    expect(h.split.toState().tileTabIds).toEqual(['tab-1'])
    expect(h.fillers).toEqual([])
  })

  it('costs the page in front of the user nothing but the split', () => {
    // The other half. Nothing is evicted from a pane: the panes go, and the pages in them stay
    // loaded and in the strip, so choosing a layout again brings them back.
    const h = harness('1x2', ['tab-1', 'tab-2'])
    seed(h, ['tab-1', 'tab-2'])
    h.occupancy.claimTileForNewTab()
    expect(h.closed).toEqual([])
    expect(h.unassigned).toEqual(['tab-2'])
    expect(h.split.tabIdAt(0)).toBe('tab-1')
  })

  it('leaves a fresh window in the layout it was opened in', () => {
    // No tile holds anything yet, so this is a window's first tab and `splitView.defaultLayout` is
    // the arrangement the user asked for. Collapsing it here would make that setting unreachable.
    const h = harness('2x2', [])
    expect(h.occupancy.claimTileForNewTab()).toBe(0)
    expect(h.split.layout).toBe('2x2')
  })

  it('takes an empty pane rather than an occupied one when adaptation is off', () => {
    // With the layout the user's own business, the earlier rule stands unchanged: a new tab must
    // not replace the page in front of them while an empty pane sits beside it.
    const h = harness('1x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    h.split.setActiveTile(0)
    h.adapt = false
    expect(h.occupancy.claimTileForNewTab()).toBe(1)
    expect(h.split.layout).toBe('1x2')
  })

  it('falls back to the active pane when every pane is taken and adaptation is off', () => {
    const h = harness('1x2', ['tab-1', 'tab-2'])
    seed(h, ['tab-1', 'tab-2'])
    h.split.setActiveTile(1)
    h.adapt = false
    expect(h.occupancy.claimTileForNewTab()).toBe(1)
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
 * The window now keeps this up to date on every settle, so by the time a new tab is asked for the group
 * usually has it already. The handover here is kept as the belt-and-braces write, and it is the reason
 * these checks stay: the settle is *scheduled*, one `setImmediate` per burst, so two messages arriving in
 * the same turn of the loop — split this window, then open a tab — reach the collapse before any round
 * could have written anything down. This is the last moment the arrangement exists.
 */
describe('the arrangement a new tab displaces', () => {
  it('is handed over before the panes go, layout and seating together', () => {
    /*
      What was lost before this existed. "The pages stay loaded and choosing a layout again brings them
      back" was true and not enough: they came back in the strip's order, into whichever layout was
      chosen next, so *which* arrangement it had been and who sat where was gone and unrecoverable.

      Both halves are asserted. Without the layout id there is nothing to apply; without the seating the
      recording is only a set of tabs, which the group already is.
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

  it('hands over nothing when the user turned adaptation off', () => {
    // That branch does not collapse anything, so nothing is displaced. Recording here would invent an
    // arrangement to go back to for a layout that never left.
    const h = harness('1x2', ['a'])
    h.split.assignTab('a', 0)
    h.adapt = false
    h.occupancy.claimTileForNewTab()
    expect(h.kept).toEqual([])
  })

  it('hands over nothing from a window whose panes are all empty', () => {
    const h = harness('2x2', [])
    h.occupancy.claimTileForNewTab()
    expect(h.kept).toEqual([])
  })

  it('hands over nothing from a single view', () => {
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

  it('brings back the layout and seats every member where it was', () => {
    // The half without which the recording is a memory nobody can read.
    const h = displaced()
    const kept = h.kept[0]!

    h.occupancy.restoreArrangement('c', kept)

    expect(h.split.layout).toBe('2x2')
    expect(h.split.toState().tileTabIds).toEqual(['a', 'b', 'c', 'd'])
  })

  it('makes the tab that was clicked the active one', () => {
    // The tab the user clicked has to be the one they end up in. Restoring the arrangement and leaving
    // the focus in tile 0 would answer a click on the third pane by focusing the first.
    const h = displaced()
    h.occupancy.restoreArrangement('c', h.kept[0]!)
    expect(h.activated).toContain(2)
    expect(h.split.activeTile).toBe(2)
  })

  it('leaves a closed member’s tile empty rather than shifting the others along', () => {
    /*
      Spelled out in the arrangement's own docblock and the reason `tiles` is positional. Closing `b` and
      sliding `c` and `d` up would answer "put it back the way it was" by rearranging two pages that
      never moved.
    */
    const h = displaced()
    const kept = h.kept[0]!
    const withoutB: TabGroupLayout = {
      id: kept.id,
      tiles: kept.tiles.map((id) => (id === 'b' ? null : id))
    }

    h.occupancy.restoreArrangement('a', withoutB)

    expect(h.split.toState().tileTabIds).toEqual(['a', null, 'c', 'd'])
  })

  it('costs the tab that displaced it nothing but its tile', () => {
    // Spec 2 from the other direction, and the way back: the new tab is unassigned rather than closed,
    // stays in the strip, and one click on it takes the window again.
    const h = displaced()
    h.occupancy.restoreArrangement('a', h.kept[0]!)

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
    const withoutB: TabGroupLayout = {
      id: kept.id,
      tiles: kept.tiles.map((id) => (id === 'b' ? null : id))
    }

    h.occupancy.restoreArrangement('a', withoutB)

    expect(h.fillers).toEqual([])
  })

  it('seats the members without changing a layout that already matches', () => {
    // A group folded away and opened again is displaced without the layout changing, so the arrangement
    // is applied by seating alone. `applyLayout` is a no-op for the same id, and depending on it would
    // make the restore silently do nothing.
    const h = harness('1x2', ['a', 'b'])
    h.split.assignTab('b', 0)

    h.occupancy.restoreArrangement('a', { id: '1x2', tiles: ['a', 'b'] })

    expect(h.split.toState().tileTabIds).toEqual(['a', 'b'])
    expect(h.split.activeTile).toBe(0)
  })
})

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
