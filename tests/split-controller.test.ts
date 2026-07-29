import { describe, expect, it } from 'vitest'
import { SplitController } from '@main/browser/SplitController.js'
import { TILE_COUNT, type Rect } from '@shared/split/layout.js'

/**
 * `SplitController` — the split-view state machine.
 *
 * The Gherkin feature describes the behaviour in the user's terms; this covers the
 * state transitions and the invariants that hold between them, including the ones
 * a scenario would be clumsy to express.
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1600, height: 900 }

describe('construction', () => {
  it('starts as a single tile', () => {
    const split = new SplitController()
    expect(split.layout).toBe('1x1')
    expect(split.tileCount).toBe(1)
    expect(split.activeTile).toBe(0)
  })

  it('accepts a restored snapshot', () => {
    const split = new SplitController({
      layout: '2x2',
      fractions: { v: 0.3, h: 0.7 },
      activeTile: 2,
      tileAudio: [
        { muted: true, volume: 0.5 },
        { muted: false, volume: 1 },
        { muted: false, volume: 1 },
        { muted: false, volume: 1 }
      ]
    })
    expect(split.layout).toBe('2x2')
    expect(split.activeTile).toBe(2)
    expect(split.tileAudio(0).muted).toBe(true)
    expect(split.toState().fractions['v']).toBe(0.3)
  })

  it('clamps a restored active tile that no longer exists', () => {
    // A session file from a wider layout must not leave the active index out of
    // range; that would make the first keystroke act on nothing.
    const split = new SplitController({ layout: '1x1', activeTile: 3 })
    expect(split.activeTile).toBe(0)
  })

  it('ignores a non-finite restored active tile', () => {
    const split = new SplitController({ layout: '2x2', activeTile: Number.NaN })
    expect(split.activeTile).toBe(0)
  })
})

describe('setLayout', () => {
  it('reports nothing orphaned when growing', () => {
    const split = new SplitController({ layout: '1x1' })
    split.assignTab('a', 0)
    expect(split.setLayout('2x2')).toEqual([])
    expect(split.tabIdAt(0)).toBe('a')
  })

  it('reports the tabs that lost their tile when shrinking', () => {
    const split = new SplitController({ layout: '2x2' })
    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) split.assignTab(id, index)
    expect(split.setLayout('1x2')).toEqual(['c', 'd'])
  })

  it('returns an empty list when the layout does not change', () => {
    const split = new SplitController({ layout: '2x2' })
    expect(split.setLayout('2x2')).toEqual([])
  })

  it('keeps divider positions that the new layout also has', () => {
    const split = new SplitController({ layout: '2x2' })
    split.setFractions({ v: 0.3 }, CONTENT)
    split.setLayout('1x2')
    expect(split.toState().fractions['v']).toBeCloseTo(0.3, 6)
  })

  it('drops divider positions the new layout does not have', () => {
    const split = new SplitController({ layout: '2x2' })
    split.setFractions({ h: 0.3 }, CONTENT)
    split.setLayout('1x2')
    // `1x2` has no horizontal divider, so carrying `h` would be dead state that
    // reappears if the user goes back to a layout that uses it.
    expect(split.toState().fractions['h']).toBeUndefined()
  })

  it('clears maximise and fullscreen, which referred to a specific tile', () => {
    const split = new SplitController({ layout: '2x2' })
    split.assignTab('a', 3)
    split.enterTileFullscreen(3)
    split.toggleTileMaximized(3)
    split.setLayout('1x2')
    expect(split.maximizedTile).toBeNull()
    expect(split.fullscreenTile).toBeNull()
    expect(split.escalation).toBe('none')
  })

  it('preserves per-tile audio for tiles that still exist', () => {
    const split = new SplitController({ layout: '2x2' })
    split.setTileMuted(1, true)
    split.setLayout('1x2')
    expect(split.tileAudio(1).muted).toBe(true)
  })

  it('gives every layout the declared tile count', () => {
    const split = new SplitController()
    for (const [layout, count] of Object.entries(TILE_COUNT)) {
      split.setLayout(layout as keyof typeof TILE_COUNT)
      expect(split.tileCount, layout).toBe(count)
    }
  })

  it('reports the tab that lost its column when a wide row shrinks', () => {
    const split = new SplitController({ layout: '1x4' })
    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) split.assignTab(id, index)
    expect(split.setLayout('1x3')).toEqual(['d'])
    expect(split.tabIdAt(2)).toBe('c')
  })

  it('carries the boundaries a narrower row still has and drops the rest', () => {
    const split = new SplitController({ layout: '1x4' })
    split.setFractions({ v: 0.3, v3: 0.7 }, CONTENT)
    split.setLayout('1x3')
    expect(split.toState().fractions['v']).toBeCloseTo(0.3, 6)
    // `1x3` has no third boundary, so keeping `v3` would be dead state that
    // reappears the moment the user goes back to four columns.
    expect(split.toState().fractions['v3']).toBeUndefined()
  })

  it('carries the leftmost boundary between a two-column layout and a wider row', () => {
    // The reason it is called `v` in every one of them: growing the row keeps the
    // divider the user placed instead of snapping it back to the default.
    const split = new SplitController({ layout: '1x2' })
    split.setFractions({ v: 0.3 }, CONTENT)
    split.setLayout('1x4')
    expect(split.toState().fractions['v']).toBeCloseTo(0.3, 6)
  })
})

describe('a row of columns', () => {
  it('keeps the boundaries in order when a drag pushes one past another', () => {
    // The real path a divider drag takes: the renderer sends the raw fraction and
    // the controller is the single authority on where it may land.
    const split = new SplitController({ layout: '1x4' })
    split.setFractions({ v2: 0.02 }, CONTENT)
    const { v, v2, v3 } = split.toState().fractions
    expect(v!).toBeLessThan(v2!)
    expect(v2!).toBeLessThan(v3!)
  })

  it('gives every column a real rectangle after such a drag', () => {
    const split = new SplitController({ layout: '1x4' })
    split.setFractions({ v: 0.95, v2: 0.05, v3: 0.5 }, CONTENT)
    for (const rect of split.tileRects(CONTENT)) {
      expect(rect).not.toBeNull()
      expect((rect as Rect).width).toBeGreaterThan(0)
    }
  })

  it('moves the active tile along the row and back', () => {
    const split = new SplitController({ layout: '1x4' })
    for (const expected of [1, 2, 3]) {
      expect(split.moveActiveTile('right', CONTENT)).toBe(true)
      expect(split.activeTile).toBe(expected)
    }
    expect(split.moveActiveTile('right', CONTENT)).toBe(false)
    expect(split.moveActiveTile('left', CONTENT)).toBe(true)
    expect(split.activeTile).toBe(2)
  })

  it('does not move up or down in a row of columns', () => {
    const split = new SplitController({ layout: '1x3' })
    expect(split.moveActiveTile('up', CONTENT)).toBe(false)
    expect(split.moveActiveTile('down', CONTENT)).toBe(false)
  })

  it('survives a restart with its boundaries where they were', () => {
    const split = new SplitController({ layout: '1x4' })
    split.setFractions({ v: 0.3, v2: 0.55, v3: 0.8 }, CONTENT)
    const restored = new SplitController(JSON.parse(JSON.stringify(split.toPersistence())))
    expect(restored.layout).toBe('1x4')
    expect(restored.toState().fractions['v2']).toBeCloseTo(0.55, 6)
    expect(restored.tileCount).toBe(4)
  })

  it('returns a wide row to an even split on reset', () => {
    const split = new SplitController({ layout: '1x3' })
    split.setFractions({ v: 0.55 }, CONTENT)
    split.resetFractions()
    expect(split.toState().fractions['v']).toBeCloseTo(1 / 3, 10)
    expect(split.toState().fractions['v2']).toBeCloseTo(2 / 3, 10)
  })
})

describe('tab assignment', () => {
  it('reports which tile a tab is in', () => {
    const split = new SplitController({ layout: '1x2' })
    split.assignTab('a', 1)
    expect(split.tileOfTab('a')).toBe(1)
    expect(split.tileOfTab('nobody')).toBeNull()
  })

  it('moves rather than duplicates', () => {
    const split = new SplitController({ layout: '1x2' })
    split.assignTab('a', 0)
    split.assignTab('a', 1)
    expect(split.tabIdAt(0)).toBeNull()
    expect(split.tabIdAt(1)).toBe('a')
  })

  it('clamps an out-of-range tile index', () => {
    const split = new SplitController({ layout: '1x2' })
    split.assignTab('a', 99)
    expect(split.tabIdAt(1)).toBe('a')
  })

  it('unassigns without closing', () => {
    const split = new SplitController({ layout: '1x2' })
    split.assignTab('a', 0)
    split.assignTab('a', null)
    expect(split.tileOfTab('a')).toBeNull()
  })

  it('forgets a closed tab', () => {
    const split = new SplitController({ layout: '1x2' })
    split.assignTab('a', 0)
    split.forgetTab('a')
    expect(split.tabIdAt(0)).toBeNull()
  })

  it('tolerates forgetting a tab it never had', () => {
    const split = new SplitController({ layout: '1x2' })
    expect(() => split.forgetTab('ghost')).not.toThrow()
  })

  it('finds the first empty tile', () => {
    const split = new SplitController({ layout: '2x2' })
    split.assignTab('a', 0)
    expect(split.firstEmptyTile()).toBe(1)
  })

  it('reports no empty tile when the grid is full', () => {
    const split = new SplitController({ layout: '1x2' })
    split.assignTab('a', 0)
    split.assignTab('b', 1)
    expect(split.firstEmptyTile()).toBeNull()
  })

  it('reports the active tile’s tab', () => {
    const split = new SplitController({ layout: '1x2' })
    split.assignTab('a', 1)
    split.setActiveTile(1)
    expect(split.activeTabId()).toBe('a')
  })
})

describe('active tile', () => {
  it('clamps an out-of-range index', () => {
    const split = new SplitController({ layout: '1x2' })
    split.setActiveTile(9)
    expect(split.activeTile).toBe(1)
    split.setActiveTile(-3)
    expect(split.activeTile).toBe(0)
  })

  it('reports whether a directional move happened', () => {
    const split = new SplitController({ layout: '2x2' })
    expect(split.moveActiveTile('right', CONTENT)).toBe(true)
    expect(split.activeTile).toBe(1)
    expect(split.moveActiveTile('right', CONTENT)).toBe(false)
    expect(split.activeTile).toBe(1)
  })

  it('does not move in a single-tile layout', () => {
    const split = new SplitController({ layout: '1x1' })
    expect(split.moveActiveTile('right', CONTENT)).toBe(false)
  })
})

describe('audio', () => {
  it('mutes a tile', () => {
    const split = new SplitController({ layout: '1x2' })
    split.setTileMuted(0, true)
    expect(split.tileAudio(0).muted).toBe(true)
  })

  it('returns a safe default for an out-of-range tile', () => {
    const split = new SplitController({ layout: '1x1' })
    expect(split.tileAudio(5)).toEqual({ muted: false, volume: 1 })
  })

  it('ignores muting a tile that does not exist', () => {
    const split = new SplitController({ layout: '1x1' })
    expect(() => split.setTileMuted(9, true)).not.toThrow()
  })

  it('keeps an explicitly muted tile muted regardless of focus rules', () => {
    const split = new SplitController({ layout: '1x2' })
    split.setTileMuted(0, true)
    split.setActiveTile(0)
    expect(split.shouldTileBeMuted(0, false, false)).toBe(true)
  })

  it('mutes everything but the active tile when asked', () => {
    const split = new SplitController({ layout: '2x2' })
    split.setActiveTile(2)
    expect(split.shouldTileBeMuted(2, true, false)).toBe(false)
    expect(split.shouldTileBeMuted(0, true, false)).toBe(true)
  })

  it('treats the global switch the same way', () => {
    const split = new SplitController({ layout: '2x2' })
    split.setActiveTile(0)
    expect(split.shouldTileBeMuted(1, false, true)).toBe(true)
  })

  it('leaves everything audible when neither option is set', () => {
    const split = new SplitController({ layout: '2x2' })
    expect(split.shouldTileBeMuted(1, false, false)).toBe(false)
  })
})

describe('escalation ladder', () => {
  it('reports no escalation initially', () => {
    expect(new SplitController({ layout: '2x2' }).escalation).toBe('none')
  })

  it('reports tile fullscreen', () => {
    const split = new SplitController({ layout: '2x2' })
    split.enterTileFullscreen(1)
    expect(split.escalation).toBe('tile-fullscreen')
    expect(split.isTileScopedFullscreen).toBe(true)
  })

  it('does not treat single-tile fullscreen as tile-scoped', () => {
    // In a 1x1 layout the tile *is* the window, so real fullscreen is correct.
    const split = new SplitController({ layout: '1x1' })
    split.enterTileFullscreen(0)
    expect(split.isTileScopedFullscreen).toBe(false)
  })

  it('ranks window fullscreen above the tile states', () => {
    const split = new SplitController({ layout: '2x2' })
    split.enterTileFullscreen(0)
    split.toggleTileMaximized(0)
    split.setWindowFullscreen(true)
    expect(split.escalation).toBe('window-fullscreen')
  })

  it('ranks maximise above tile fullscreen', () => {
    const split = new SplitController({ layout: '2x2' })
    split.enterTileFullscreen(0)
    split.toggleTileMaximized(0)
    expect(split.escalation).toBe('tile-maximized')
  })

  it('steps back one rung per escape, innermost first', () => {
    /*
      The order, asserted from the top of the ladder down. It used to run the other way — window
      fullscreen off first — and that is the defect behind "wenn f11 gedrückt und ich mache ein
      video klein, schließt sich f11": the same `Escape` that takes a video out of fullscreen
      reaches this browser, and taking the outermost rung with it spends a press the user has
      already spent.
    */
    const split = new SplitController({ layout: '2x2' })
    split.enterTileFullscreen(0)
    split.toggleTileMaximized(0)
    split.setWindowFullscreen(true)

    expect(split.escape()).toBe('exit-tile-fullscreen')
    split.leaveTileFullscreen()
    expect(split.escape()).toBe('restore-tile')
    expect(split.escape()).toBe('exit-window-fullscreen')
    split.setWindowFullscreen(false)
    expect(split.escape()).toBe('none')
  })

  it('keeps the window in fullscreen while an inner rung is still there', () => {
    // The report, as one assertion. A fullscreen page inside a fullscreen window: the press that
    // shrinks the page must not also drop the window, so the window's own state is untouched.
    const split = new SplitController({ layout: '1x1' })
    split.setWindowFullscreen(true)
    split.enterTileFullscreen(0)

    expect(split.escape()).toBe('exit-tile-fullscreen')
    expect(split.isWindowFullscreen).toBe(true)
    expect(split.escalation).toBe('window-fullscreen')
  })

  it('reports the outermost rung while escape takes the innermost', () => {
    /*
      The two orders disagreeing is the design, not a bug, and this is the case that shows why.
      `escalation` answers "how much of the window has been given to content" — the chrome is hidden
      because a tile is maximised, and it stays hidden after the page's fullscreen comes off. A
      version that reported the innermost rung would put the toolbar back over a maximised tile.
    */
    const split = new SplitController({ layout: '2x2' })
    split.enterTileFullscreen(0)
    split.toggleTileMaximized(0)

    expect(split.escalation).toBe('tile-maximized')
    expect(split.escape()).toBe('exit-tile-fullscreen')
    split.leaveTileFullscreen()
    expect(split.escalation).toBe('tile-maximized')
  })

  it('toggles maximise off when applied twice to the same tile', () => {
    const split = new SplitController({ layout: '2x2' })
    split.toggleTileMaximized(1)
    split.toggleTileMaximized(1)
    expect(split.maximizedTile).toBeNull()
  })

  it('switches the maximised tile when applied to another one', () => {
    const split = new SplitController({ layout: '2x2' })
    split.toggleTileMaximized(1)
    split.toggleTileMaximized(2)
    expect(split.maximizedTile).toBe(2)
  })

  it('maximises the active tile when none is named', () => {
    const split = new SplitController({ layout: '2x2' })
    split.setActiveTile(3)
    split.toggleTileMaximized()
    expect(split.maximizedTile).toBe(3)
  })

  it('makes the maximised tile active', () => {
    const split = new SplitController({ layout: '2x2' })
    split.toggleTileMaximized(2)
    expect(split.activeTile).toBe(2)
  })
})

describe('geometry', () => {
  it('gives the whole area to a maximised tile and collapses the rest', () => {
    const split = new SplitController({ layout: '2x2' })
    split.toggleTileMaximized(1)
    const rects = split.tileRects(CONTENT)
    expect(rects[1]).toEqual(CONTENT)
    expect(rects[0]).toBeNull()
    expect(rects[2]).toBeNull()
    expect(rects[3]).toBeNull()
  })

  it('leaves the grid untouched during tile fullscreen', () => {
    // Spec 2: the other tiles stay visible and keep playing.
    const split = new SplitController({ layout: '2x2' })
    const before = split.tileRects(CONTENT)
    split.enterTileFullscreen(0)
    expect(split.tileRects(CONTENT)).toEqual(before)
  })

  it('separates tiles by a gutter so the dividers can be grabbed', () => {
    const split = new SplitController({ layout: '1x2' })
    const [left, right] = split.tileRects(CONTENT)
    expect(left).not.toBeNull()
    expect(right).not.toBeNull()
    const gap = (right as Rect).x - ((left as Rect).x + (left as Rect).width)
    expect(gap).toBeGreaterThan(0)
  })
})

describe('persistence', () => {
  it('round-trips through JSON', () => {
    const split = new SplitController({ layout: '1+2' })
    split.setFractions({ v: 0.7 }, CONTENT)
    split.setTileMuted(1, true)
    split.setActiveTile(2)

    const restored = new SplitController(JSON.parse(JSON.stringify(split.toPersistence())))
    expect(restored.layout).toBe('1+2')
    expect(restored.toState().fractions['v']).toBeCloseTo(0.7, 6)
    expect(restored.tileAudio(1).muted).toBe(true)
    expect(restored.activeTile).toBe(2)
  })

  it('does not persist transient escalation state', () => {
    // Restoring into a fullscreen a page never requested would be wrong.
    const split = new SplitController({ layout: '2x2' })
    split.enterTileFullscreen(1)
    split.toggleTileMaximized(1)
    const restored = new SplitController(split.toPersistence())
    expect(restored.escalation).toBe('none')
  })

  it('does not persist tab assignment, which belongs to the session', () => {
    const split = new SplitController({ layout: '1x2' })
    split.assignTab('a', 0)
    expect(Object.keys(split.toPersistence())).not.toContain('tileTabIds')
  })

  it('returns copies rather than internal references', () => {
    const split = new SplitController({ layout: '1x2' })
    const state = split.toState()
    state.fractions['v'] = 0.99
    state.tileAudio[0]!.muted = true
    expect(split.toState().fractions['v']).not.toBe(0.99)
    expect(split.tileAudio(0).muted).toBe(false)
  })
})

describe('resetFractions', () => {
  it('returns dividers to the layout default', () => {
    const split = new SplitController({ layout: '1+2' })
    split.setFractions({ v: 0.8 }, CONTENT)
    split.resetFractions()
    expect(split.toState().fractions['v']).toBe(0.6)
  })
})
