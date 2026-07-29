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
  toggledWindowFullscreen: number
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
    toggledWindowFullscreen: 0,
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
    toggleWindowFullscreen: () => {
      state.toggledWindowFullscreen! += 1
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

  it('leaves a fullscreen window alone, or the way out is silence', () => {
    /*
      Marking a window un-fullscreenable *while it is fullscreen* is what `window-events.ts` calls
      trapping the user: `setFullScreen(false)` on such a window is silence, so the second `Escape`
      — the one that is meant to leave the window's fullscreen — would do nothing at all.

      The case only exists because `escape()` now takes the innermost rung first: leaving a tile's
      fullscreen and un-maximising a tile both call this while the window is still fullscreen.
    */
    const h = harness('2x2')
    h.split.setWindowFullscreen(true)
    h.controller.applyPolicy()
    expect(h.fullScreenable).toEqual([])
  })

  it('puts the confinement back the moment the window is no longer fullscreen', () => {
    // The other half: nothing is lost by waiting, because `leave-full-screen` runs this again.
    const h = harness('2x2')
    h.split.setWindowFullscreen(true)
    h.controller.applyPolicy()
    h.split.setWindowFullscreen(false)
    h.controller.applyPolicy()
    expect(h.fullScreenable).toEqual([false])
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

describe('the fullscreen key', () => {
  /*
    F11 takes the *window*, in every layout. Reported in exactly those words — "with F11 I meant the
    browser itself goes fullscreen, not videos/content" — after a first version put the key on the tile's
    fullscreen whenever the scope was the tile.

    The reason that first version existed is the thing these tests have to keep straight: `applyPolicy`
    marks a split window un-fullscreenable so that a *page* cannot take it, and `setFullScreen` on such a
    window is silence rather than an error. So the key has to lift the flag — and the flag cannot tell a
    person from a page, which is why the lift belongs to the key and the restore belongs to leaving.
  */
  it('takes the window in a single pane', () => {
    const h = harness('1x1')
    h.controller.toggleFullscreen()
    expect(h.toggledWindowFullscreen).toBe(1)
  })

  it('takes the window in a split layout too, which is the whole correction', () => {
    const h = harness('2x2')
    h.controller.toggleFullscreen()

    expect(h.toggledWindowFullscreen).toBe(1)
    // And emphatically not the tile: that is what a *page* asking for fullscreen gets.
    expect(h.split.fullscreenTile).toBeNull()
  })

  it('lifts the un-fullscreenable flag first, or the request is silence', () => {
    /*
      The mechanism, asserted directly. `applyPolicy` has told this window it may not go fullscreen;
      without the lift, `setFullScreen` does nothing at all and the key looks broken — which is exactly how
      the original bug presented.
    */
    const h = harness('2x2')
    h.controller.applyPolicy()
    expect(h.fullScreenable).toEqual([false])

    h.controller.toggleFullscreen()
    expect(h.fullScreenable, 'the flag was not lifted for the key').toEqual([false, true])
  })

  it('does not restore the policy itself, so the user can get back out', () => {
    // Restoring here would mark the window un-fullscreenable while it is fullscreen. The window
    // controller re-applies the policy on `leave-full-screen`, which is when a page could take it.
    const h = harness('2x2')
    h.controller.toggleFullscreen()
    expect(h.fullScreenable.at(-1)).toBe(true)
  })

  it('still takes the window when the user asked for window scope', () => {
    // Nothing to lift in that case, and the answer is the same either way.
    const h = harness('2x2')
    h.scope = 'window'
    h.controller.toggleFullscreen()
    expect(h.toggledWindowFullscreen).toBe(1)
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

  it('does not drop the window out of fullscreen to shrink a video', () => {
    /*
      The report, through the controller rather than the state machine: "wenn f11 gedrückt und ich
      mache ein video klein, schließt sich f11".

      Making the video small is an `Escape` press, and it arrives here through `Tab`'s
      `before-input-event` while it is also arriving at the page. If this took the window's
      fullscreen, one press would have two effects and the user would see only the second.
    */
    const h = harness('1x1')
    h.split.assignTab('tab-a', 0)
    h.split.setWindowFullscreen(true)
    h.controller.onPageEnter('tab-a')

    h.controller.escape()

    expect(h.askedPages).toEqual(['tab-a'])
    expect(h.exitedWindowFullscreen, 'the window left fullscreen on the same press').toBe(0)
  })

  it('leaves the window on the next press, with the flag still lifted', () => {
    // The second half of the same gesture, and the reason `applyPolicy` steps aside while the
    // window is fullscreen: an un-fullscreenable window cannot be asked to leave fullscreen.
    const h = harness('2x2')
    h.split.assignTab('tab-a', 0)
    h.split.setWindowFullscreen(true)
    h.controller.onPageEnter('tab-a')

    h.controller.escape()
    h.controller.escape()

    expect(h.exitedWindowFullscreen).toBe(1)
    expect(h.fullScreenable, 'the confinement came back while the window was still fullscreen').toEqual(
      []
    )
  })

  it('gives up a fullscreen page before it un-maximises the tile it is in', () => {
    // Same reasoning one rung down: `Escape` reaches the player too, so the press that shrinks the
    // video must not also collapse the maximised tile behind it.
    const h = harness('2x2')
    h.split.assignTab('tab-a', 0)
    h.controller.onPageEnter('tab-a')
    h.split.toggleTileMaximized(0)

    h.controller.escape()
    expect(h.split.fullscreenTile).toBeNull()
    expect(h.split.maximizedTile).toBe(0)

    h.controller.escape()
    expect(h.split.maximizedTile).toBeNull()
  })
})
