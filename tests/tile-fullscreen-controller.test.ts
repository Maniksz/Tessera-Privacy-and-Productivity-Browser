import { describe, expect, it } from 'vitest'
import { SplitController } from '@main/browser/SplitController.js'
import {
  TileFullscreenController,
  windowFullscreenPermitted,
  type TileFullscreenHost
} from '@main/browser/TileFullscreenController.js'
import { LAYOUT_IDS, TILE_COUNT, type LayoutId } from '@shared/split/layout.js'

/**
 * Fullscreen scoped to a tile, and the ladder back out (spec 2).
 *
 * The requirement this protects is the browser's whole reason to exist: a video going
 * fullscreen in one tile must not blank the other three. The mechanism is indirect — the
 * window is marked un-fullscreenable so the page's request is honoured without the window
 * following it — which is exactly the kind of rule that needs a test saying what it is for.
 */

interface Harness {
  controller: TileFullscreenController
  split: SplitController
  fullScreenable: boolean[]
  exitedWindowFullscreen: number
  askedPages: string[]
  changes: number
  scope: 'tile' | 'window'
}

function harness(layout: LayoutId = '2x2'): Harness {
  const split = new SplitController({ layout })
  const state: Partial<Harness> = {
    split,
    fullScreenable: [],
    exitedWindowFullscreen: 0,
    askedPages: [],
    changes: 0,
    scope: 'tile'
  }

  const host: TileFullscreenHost = {
    split,
    fullscreenScope: () => state.scope!,
    setFullScreenable: (allowed) => {
      state.fullScreenable!.push(allowed)
    },
    exitWindowFullscreen: () => {
      state.exitedWindowFullscreen! += 1
    },
    askPageToExitFullscreen: (tabId) => {
      state.askedPages!.push(tabId)
    },
    changed: () => {
      state.changes! += 1
    }
  }

  state.controller = new TileFullscreenController(host)
  return state as Harness
}

describe('windowFullscreenPermitted', () => {
  it('allows real fullscreen in a single-tile layout', () => {
    expect(windowFullscreenPermitted('1x1', 'tile')).toBe(true)
  })

  it('refuses it in every split layout under tile scope', () => {
    for (const layout of LAYOUT_IDS) {
      if (TILE_COUNT[layout] === 1) continue
      expect(windowFullscreenPermitted(layout, 'tile'), layout).toBe(false)
    }
  })

  it('allows it in any layout once the user asks for window scope', () => {
    for (const layout of LAYOUT_IDS) {
      expect(windowFullscreenPermitted(layout, 'window'), layout).toBe(true)
    }
  })
})

describe('applyPolicy', () => {
  it('marks a split window un-fullscreenable, which is what keeps the other tiles alive', () => {
    const h = harness('2x2')
    h.controller.applyPolicy()
    expect(h.fullScreenable).toEqual([false])
  })

  it('marks a single-tile window fullscreenable', () => {
    const h = harness('1x1')
    h.controller.applyPolicy()
    expect(h.fullScreenable).toEqual([true])
  })

  it('follows the setting when the user prefers window scope', () => {
    const h = harness('2x2')
    h.scope = 'window'
    h.controller.applyPolicy()
    expect(h.fullScreenable).toEqual([true])
  })
})

describe('a page asking for fullscreen', () => {
  it('makes that tile fullscreen and active', () => {
    const h = harness('2x2')
    h.split.assignTab('tab-b', 2)
    h.controller.onPageEnter('tab-b')

    expect(h.split.fullscreenTile).toBe(2)
    expect(h.split.activeTile).toBe(2)
    expect(h.changes).toBe(1)
  })

  it('ignores a tab that is not in any tile', () => {
    // A background tab can fire the event; it has no tile to make fullscreen.
    const h = harness('2x2')
    h.controller.onPageEnter('tab-hidden')
    expect(h.split.fullscreenTile).toBeNull()
    expect(h.changes).toBe(0)
  })

  it('leaves tile fullscreen when the page drops out of it', () => {
    const h = harness('2x2')
    h.split.assignTab('tab-b', 1)
    h.controller.onPageEnter('tab-b')
    h.controller.onPageLeave()
    expect(h.split.fullscreenTile).toBeNull()
  })
})

describe('escape', () => {
  it('asks the page to leave fullscreen so its player interface switches back', () => {
    const h = harness('2x2')
    h.split.assignTab('tab-b', 1)
    h.controller.onPageEnter('tab-b')

    h.controller.escape()
    expect(h.askedPages).toEqual(['tab-b'])
    expect(h.split.fullscreenTile).toBeNull()
  })

  it("leaves the window's own fullscreen when that is the rung it is on", () => {
    const h = harness('1x1')
    h.split.setWindowFullscreen(true)
    h.controller.escape()
    expect(h.exitedWindowFullscreen).toBe(1)
  })

  it('re-applies the policy afterwards', () => {
    // Stepping down a rung can change what the window is allowed to do.
    const h = harness('2x2')
    h.controller.escape()
    expect(h.fullScreenable.length).toBeGreaterThan(0)
  })

  it('is harmless when there is nothing to step back from', () => {
    const h = harness('2x2')
    h.controller.escape()
    expect(h.exitedWindowFullscreen).toBe(0)
    expect(h.askedPages).toEqual([])
    expect(h.changes).toBe(1)
  })

  it('takes exactly one rung per press', () => {
    // What makes Escape predictable: a maximised tile in a fullscreen page state must not
    // collapse both at once.
    const h = harness('2x2')
    h.split.assignTab('tab-b', 1)
    h.controller.onPageEnter('tab-b')

    h.controller.escape()
    expect(h.split.fullscreenTile).toBeNull()
    expect(h.exitedWindowFullscreen).toBe(0)
  })
})
