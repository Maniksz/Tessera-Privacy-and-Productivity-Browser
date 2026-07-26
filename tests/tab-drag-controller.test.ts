import { describe, expect, it } from 'vitest'
import { TabDragController, type TabDragHost } from '@main/browser/TabDragController.js'
import type { TabDropPresentation } from '@shared/overlay/surface.js'
import type { DropZone } from '@shared/split/dropzones.js'
import type { LayoutId, Rect } from '@shared/split/layout.js'

/**
 * The drag from press to drop.
 *
 * Worth testing directly because the failure modes are all about *sequence*, not geometry:
 * a drop applied twice, an indicator left on screen after the pointer is gone, a drag that
 * survives the tab it was dragging. None of that shows up in a screenshot, and all of it is
 * visible here.
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1200, height: 800 }

interface Recorder {
  controller: TabDragController
  presented: TabDropPresentation[]
  dismissals: number
  drops: Array<{ tabId: string; zone: DropZone }>
  /** Tabs the host knows about; delete one to simulate it closing mid-drag. */
  titles: Map<string, string>
  layout: LayoutId
}

function harness(layout: LayoutId = '1x1'): Recorder {
  const recorder: Partial<Recorder> = {
    presented: [],
    dismissals: 0,
    drops: [],
    titles: new Map([['tab-1', 'Example']]),
    layout
  }

  const host: TabDragHost = {
    layout: () => recorder.layout!,
    contentRect: () => CONTENT,
    titleOf: (tabId) => recorder.titles!.get(tabId) ?? null,
    present: (presentation) => {
      recorder.presented!.push(presentation)
    },
    dismiss: () => {
      recorder.dismissals! += 1
    },
    drop: (tabId, zone) => {
      recorder.drops!.push({ tabId, zone })
    }
  }

  recorder.controller = new TabDragController(host)
  return recorder as Recorder
}

/** A point inside the tile area, in window coordinates. */
const inTiles = { x: 60, y: CONTENT.y + 400 }
/** A point in the tab strip, above the tile area. */
const inStrip = { x: 60, y: 10 }

describe('starting a drag', () => {
  it('presents the indicator with every zone', () => {
    const h = harness('1x1')
    h.controller.start('tab-1')
    expect(h.presented.length).toBe(1)
    // Four splits plus the plain drop in the middle.
    expect(h.presented[0]?.zones.length).toBe(5)
    expect(h.controller.active).toBe(true)
  })

  it('names the tab being dragged', () => {
    const h = harness()
    h.controller.start('tab-1')
    expect(h.presented[0]?.title).toBe('Example')
  })

  it('reports the overlay origin so the surface can convert pointer positions', () => {
    const h = harness()
    h.controller.start('tab-1')
    expect(h.presented[0]?.origin).toEqual({ x: CONTENT.x, y: CONTENT.y })
  })

  it('sends zones in the overlay coordinate space, not window space', () => {
    // The surface renders inside the tile area, so its origin is that area's corner. Zones
    // still carrying the chrome inset would be drawn 88 pixels too low.
    const ys = (h => {
      h.controller.start('tab-1')
      return (h.presented[0]?.zones ?? []).map((zone) => zone.hit.y)
    })(harness('1x1'))

    expect(ys.length).toBeGreaterThan(0)
    expect(Math.min(...ys)).toBe(0)
    expect(ys.every((y) => y < CONTENT.height)).toBe(true)
  })

  it('targets nothing until the pointer moves', () => {
    const h = harness()
    h.controller.start('tab-1')
    expect(h.presented[0]?.activeZoneId).toBeNull()
  })

  it('ignores a tab the window does not have', () => {
    const h = harness()
    h.controller.start('gone')
    expect(h.presented).toEqual([])
    expect(h.controller.active).toBe(false)
  })
})

describe('moving during a drag', () => {
  it('targets the zone under the pointer', () => {
    const h = harness('1x1')
    h.controller.start('tab-1')
    h.controller.move(inTiles)
    expect(h.controller.activeZoneId).toBe('0-left')
  })

  it('pushes a new presentation only when the target changes', () => {
    const h = harness('1x1')
    h.controller.start('tab-1')
    const afterStart = h.presented.length

    h.controller.move(inTiles)
    const afterFirst = h.presented.length
    expect(afterFirst).toBe(afterStart + 1)

    // Three more samples inside the same zone: a pointer produces these far faster than the
    // indicator can meaningfully change, and each one would otherwise be an IPC round trip.
    h.controller.move({ x: inTiles.x + 1, y: inTiles.y })
    h.controller.move({ x: inTiles.x + 2, y: inTiles.y })
    h.controller.move({ x: inTiles.x + 3, y: inTiles.y })
    expect(h.presented.length).toBe(afterFirst)
  })

  it('clears the target when the pointer goes back to the tab strip', () => {
    const h = harness('1x1')
    h.controller.start('tab-1')
    h.controller.move(inTiles)
    h.controller.move(inStrip)
    expect(h.controller.activeZoneId).toBeNull()
    expect(h.presented[h.presented.length - 1]?.activeZoneId).toBeNull()
  })

  it('does nothing when no drag is in progress', () => {
    const h = harness()
    h.controller.move(inTiles)
    expect(h.presented).toEqual([])
  })

  it('keeps the zones it started with, even if the layout changes underneath', () => {
    // A page finishing its load must not move the target out from under a pointer that has
    // not moved.
    const h = harness('1x1')
    h.controller.start('tab-1')
    h.layout = '2x2'
    h.controller.move(inTiles)
    expect(h.presented[h.presented.length - 1]?.zones.length).toBe(5)
  })
})

describe('ending a drag', () => {
  it('drops into the zone under the pointer and dismisses the indicator', () => {
    const h = harness('1x1')
    h.controller.start('tab-1')
    h.controller.end(inTiles, true)

    expect(h.drops.length).toBe(1)
    expect(h.drops[0]?.tabId).toBe('tab-1')
    expect(h.drops[0]?.zone.id).toBe('0-left')
    expect(h.dismissals).toBe(1)
    expect(h.controller.active).toBe(false)
  })

  it('moves nothing when the drag was cancelled', () => {
    const h = harness('1x1')
    h.controller.start('tab-1')
    h.controller.end(inTiles, false)
    expect(h.drops).toEqual([])
    expect(h.dismissals).toBe(1)
  })

  it('moves nothing when released over the tab strip', () => {
    // That release is a reorder, which the tab strip handles itself.
    const h = harness('1x1')
    h.controller.start('tab-1')
    h.controller.end(inStrip, true)
    expect(h.drops).toEqual([])
    expect(h.dismissals).toBe(1)
  })

  it('moves nothing when the tab was closed mid-drag', () => {
    const h = harness('1x1')
    h.controller.start('tab-1')
    h.titles.delete('tab-1')
    h.controller.end(inTiles, true)
    expect(h.drops).toEqual([])
  })

  it('cannot drop twice from one gesture', () => {
    // Both renderers can report an ending; the second must be a no-op rather than a second
    // move of the same tab.
    const h = harness('1x1')
    h.controller.start('tab-1')
    h.controller.end(inTiles, true)
    h.controller.end(inTiles, true)
    expect(h.drops.length).toBe(1)
  })

  it('still dismisses when there was no drag at all', () => {
    // A stray report must leave nothing on screen.
    const h = harness()
    h.controller.end(inTiles, true)
    expect(h.dismissals).toBe(1)
    expect(h.drops).toEqual([])
  })
})

describe('cancelling a drag', () => {
  it('dismisses the indicator and moves nothing', () => {
    const h = harness('1x1')
    h.controller.start('tab-1')
    h.controller.cancel()
    expect(h.dismissals).toBe(1)
    expect(h.drops).toEqual([])
    expect(h.controller.active).toBe(false)
  })

  it('is silent when nothing is being dragged', () => {
    // Called on every window blur and resize, so it must not dismiss a menu that is up for
    // some entirely unrelated reason.
    const h = harness()
    h.controller.cancel()
    expect(h.dismissals).toBe(0)
  })

  it('makes a later end a no-op', () => {
    const h = harness('1x1')
    h.controller.start('tab-1')
    h.controller.cancel()
    h.controller.end(inTiles, true)
    expect(h.drops).toEqual([])
  })
})

describe('a multi-tile layout', () => {
  it('offers one zone per tile and targets the one under the pointer', () => {
    const h = harness('2x2')
    h.controller.start('tab-1')
    // A four-tile grid cannot be split further, so each tile offers only a plain drop.
    expect(h.presented[0]?.zones.length).toBe(4)

    // Bottom right quadrant, in window coordinates.
    h.controller.move({ x: CONTENT.width - 40, y: CONTENT.y + CONTENT.height - 40 })
    expect(h.controller.activeZoneId).toBe('3-centre')
  })

  it('keeps the layout when dropping into an existing tile', () => {
    const h = harness('2x2')
    h.controller.start('tab-1')
    h.controller.end({ x: 40, y: CONTENT.y + 40 }, true)
    expect(h.drops[0]?.zone.layout).toBeNull()
    expect(h.drops[0]?.zone.tileIndex).toBe(0)
  })
})
