import { describe, expect, it } from 'vitest'
import { SplitController } from '@main/browser/SplitController.js'
import {
  TileOccupancyController,
  type TileOccupancyHost
} from '@main/browser/TileOccupancyController.js'
import { dropZonesFor } from '@shared/split/dropzones.js'
import type { LayoutId, Rect } from '@shared/split/layout.js'

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
    adapt: true
  }

  let fillerSequence = 0

  const host: TileOccupancyHost = {
    split,
    adaptEnabled: () => state.adapt!,
    tabOrder: () => state.order!,
    isEphemeral: (tabId) => state.ephemeral!.has(tabId),
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
    h.occupancy.afterLayoutChange(['tab-3', 'tab-4'], { fill: false })
    expect(h.unassigned).toEqual(['tab-3', 'tab-4'])
    expect(h.closed).toEqual([])
  })

  it('closes an untouched filler that lost its tile', () => {
    const h = harness('2x2', ['tab-1', 'filler-x'])
    h.ephemeral.add('filler-x')
    h.occupancy.afterLayoutChange(['filler-x'], { fill: false })
    expect(h.closed).toEqual(['filler-x'])
  })

  it('keeps a filler the user navigated, because it left the set', () => {
    const h = harness('2x2', ['tab-1', 'was-a-filler'])
    h.occupancy.afterLayoutChange(['was-a-filler'], { fill: false })
    expect(h.closed).toEqual([])
    expect(h.unassigned).toEqual(['was-a-filler'])
  })

  it('moves a hidden tab into a tile that has nothing in it', () => {
    const h = harness('1x2', ['tab-1', 'tab-hidden'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: false })
    expect(h.split.tabIdAt(1)).toBe('tab-hidden')
  })

  it('prefers a hidden tab over opening a new one', () => {
    // Reusing what is already loaded costs nothing; a new tab costs a renderer process.
    const h = harness('1x2', ['tab-1', 'tab-hidden'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: true })
    expect(h.fillers).toEqual([])
    expect(h.split.tabIdAt(1)).toBe('tab-hidden')
  })

  it('fills what is still empty after the hidden tabs run out', () => {
    const h = harness('2x2', ['tab-1', 'tab-hidden'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: true })
    expect(h.split.tabIdAt(1)).toBe('tab-hidden')
    expect(h.fillers).toEqual([2, 3])
  })

  it('leaves tiles empty when asked not to fill', () => {
    const h = harness('2x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    h.occupancy.afterLayoutChange([], { fill: false })
    expect(h.fillers).toEqual([])
    expect(h.split.tabIdAt(1)).toBeNull()
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

  it('leaves the layout alone when the user turned adaptation off', () => {
    const h = harness('1x2', ['tab-2'])
    h.split.assignTab('tab-2', 1)
    h.adapt = false
    h.occupancy.afterTabClosed(0)
    expect(h.split.layout).toBe('1x2')
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
  it('takes an empty tile rather than the active one', () => {
    // The complaint this fixes: a new tab replaced the page in front of the user while empty
    // panes sat beside it.
    const h = harness('1x2', ['tab-1'])
    h.split.assignTab('tab-1', 0)
    h.split.setActiveTile(0)
    expect(h.occupancy.tileForNewTab()).toBe(1)
  })

  it('falls back to the active tile when every tile is taken', () => {
    const h = harness('1x2', ['tab-1', 'tab-2'])
    seed(h, ['tab-1', 'tab-2'])
    h.split.setActiveTile(1)
    expect(h.occupancy.tileForNewTab()).toBe(1)
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
})
