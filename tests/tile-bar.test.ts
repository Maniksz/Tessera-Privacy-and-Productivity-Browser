import { describe, expect, it } from 'vitest'
import {
  TILE_BAR_HEIGHT,
  TILE_BAR_MODES,
  TILE_BAR_POINTER_AWAY,
  TILE_BAR_REVEAL_WITHIN,
  nextRevealedTile,
  tileBarAllows,
  tileBarBounds,
  tileBarPresentation,
  tileBarRefresh,
  tileBarStep,
  tileBarVisibility,
  type TileBarMode,
  type TileBarTab
} from '@shared/split/tile-bar.js'
import { LAYOUT_IDS, TILE_COUNT, computeTileRects, type Rect } from '@shared/split/layout.js'
import { takesFocus } from '@shared/overlay/surface.js'

/**
 * The navigation bar at the top edge of a tile.
 *
 * Two rules, and both of them are the kind that look obvious and are not. The reveal has two
 * thresholds rather than one because a single threshold makes the bar flicker: the moment it
 * appears the pointer is inside it, and the next sample a pixel lower would hide it again. And
 * the bar occupies a strip rather than the tile, because the overlay layer swallows every pointer
 * event inside its bounds — a bar sized to the tile would make the page under it unusable.
 *
 * The rest of this file is about the two things that make the bar different from the toolbar it
 * copies: every control acts on *its own* tile's tab rather than the active one, and the whole
 * feature has to be reachable without a mouse (spec 7).
 */

const TILE: Rect = { x: 100, y: 200, width: 600, height: 400 }
const CONTENT: Rect = { x: 0, y: 88, width: 1440, height: 812 }

function tab(id: string, overrides: Partial<TileBarTab> = {}): TileBarTab {
  return {
    id,
    url: `https://example.com/${id}`,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    // A pane nobody has zoomed, which is every pane until a test says otherwise.
    zoomPercent: 100,
    zoomed: false,
    ...overrides
  }
}

describe('revealing the bar', () => {
  it('appears when the pointer reaches the top edge', () => {
    expect(tileBarVisibility(false, 0)).toBe(true)
    expect(tileBarVisibility(false, TILE_BAR_REVEAL_WITHIN)).toBe(true)
  })

  it('does not appear from a pointer just below the reveal band', () => {
    // Otherwise it would open while someone reaches for a link near the top of the page.
    expect(tileBarVisibility(false, TILE_BAR_REVEAL_WITHIN + 1)).toBe(false)
  })

  it('stays open while the pointer rests inside it', () => {
    // This is the gap the second threshold exists for. With one threshold, the bar would close
    // under the pointer that just opened it.
    for (let y = TILE_BAR_REVEAL_WITHIN + 1; y <= TILE_BAR_HEIGHT; y += 1) {
      expect(tileBarVisibility(true, y), `y=${y}`).toBe(true)
    }
  })

  it('closes once the pointer leaves its height', () => {
    expect(tileBarVisibility(true, TILE_BAR_HEIGHT + 1)).toBe(false)
  })

  it('ignores a pointer above the tile', () => {
    // A negative position is the pointer in the chrome UI, not at the tile's edge.
    expect(tileBarVisibility(false, -1)).toBe(false)
    expect(tileBarVisibility(true, -1)).toBe(false)
  })

  it('is stable: asking again with the same position never flips the answer', () => {
    // The property that rules out flicker, checked across the whole range rather than at the
    // interesting points only.
    for (let y = -5; y <= TILE_BAR_HEIGHT + 5; y += 1) {
      const first = tileBarVisibility(false, y)
      expect(tileBarVisibility(first, y), `closed then y=${y}`).toBe(first)

      const second = tileBarVisibility(true, y)
      expect(tileBarVisibility(second, y), `open then y=${y}`).toBe(second)
    }
  })

  it('reveals within a narrower band than it closes on', () => {
    // If these ever met, the hysteresis would be gone and so would the reason for two constants.
    expect(TILE_BAR_REVEAL_WITHIN).toBeLessThan(TILE_BAR_HEIGHT)
  })

  it('keeps the three thresholds in the one order that works', () => {
    /*
      The reveal band was raised because six pixels was too tight to aim at, and this is the
      constraint that raising it has to respect. Reveal below hold, hold below the reported
      departure: bring reveal up to or past the hold threshold and every position answers "show",
      including the one a surface reports when the pointer has left — so the bar never goes away.
      Bring the departure constant down to the hold threshold and it reads as "still inside".
    */
    expect(TILE_BAR_REVEAL_WITHIN).toBeLessThan(TILE_BAR_HEIGHT)
    expect(TILE_BAR_HEIGHT).toBeLessThan(TILE_BAR_POINTER_AWAY)
  })

  it('reveals from far enough out to be aimed at rather than stabbed at', () => {
    // The complaint: the bar came out only within six pixels of the edge. The number itself is a
    // judgement, but a band this narrow is not reachable on purpose, so it has a floor.
    expect(TILE_BAR_REVEAL_WITHIN).toBeGreaterThanOrEqual(12)
    for (let y = 0; y <= 12; y += 1) expect(tileBarVisibility(false, y), `y=${y}`).toBe(true)
  })

  it('leaves a gap between revealing and dismissing for the pointer to rest in', () => {
    // Everything strictly between the two thresholds must answer "whatever it already was", or the
    // bar flickers under the pointer that opened it.
    for (let y = TILE_BAR_REVEAL_WITHIN + 1; y <= TILE_BAR_HEIGHT; y += 1) {
      expect(tileBarVisibility(false, y), `closed, y=${y}`).toBe(false)
      expect(tileBarVisibility(true, y), `open, y=${y}`).toBe(true)
    }
  })

  it('reads a reported departure as away, whichever edge the pointer left by', () => {
    // The constant a surface reports when the pointer leaves it. Above the hold threshold, because
    // the alternative — the pointer's real position — is 0 for an upward departure and would hold
    // the bar open for ever.
    expect(tileBarVisibility(true, TILE_BAR_POINTER_AWAY)).toBe(false)
    expect(TILE_BAR_POINTER_AWAY).toBeGreaterThan(TILE_BAR_HEIGHT)
  })
})

describe('where the bar sits', () => {
  it('takes a strip at the top of the tile, never the whole tile', () => {
    const bounds = tileBarBounds(TILE)
    expect(bounds).toEqual({ x: TILE.x, y: TILE.y, width: TILE.width, height: TILE_BAR_HEIGHT })
  })

  it("spans the tile's full width, so the address field has room", () => {
    expect(tileBarBounds(TILE).width).toBe(TILE.width)
  })

  it('never reaches past a tile shorter than the bar', () => {
    // A four-tile grid in a short window can produce this, and a strip taller than its tile would
    // cover the neighbour below it.
    const short: Rect = { x: 0, y: 0, width: 300, height: 20 }
    expect(tileBarBounds(short).height).toBe(20)
  })

  it('starts at the tile, not at the window', () => {
    const bounds = tileBarBounds(TILE)
    expect(bounds.x).toBe(TILE.x)
    expect(bounds.y).toBe(TILE.y)
  })

  it('sits inside its own tile in every layout, and never over a neighbour', () => {
    /*
      Every arrangement, not a representative one. The bar is positioned from the same rectangles
      that position the tile views, so the property to check is containment: a strip that reached
      past its tile would cover the top of the page next door, and in a column layout that is a
      page the user is watching.
    */
    for (const layout of LAYOUT_IDS) {
      const rects = computeTileRects(layout, {}, CONTENT, { gutter: 8 })
      expect(rects.length, layout).toBe(TILE_COUNT[layout])

      rects.forEach((rect, index) => {
        const bar = tileBarBounds(rect)
        expect(bar.x, `${layout} tile ${index} x`).toBe(rect.x)
        expect(bar.y, `${layout} tile ${index} y`).toBe(rect.y)
        expect(bar.width, `${layout} tile ${index} width`).toBe(rect.width)
        expect(bar.height, `${layout} tile ${index} height`).toBe(TILE_BAR_HEIGHT)

        for (const [other, otherRect] of rects.entries()) {
          if (other === index) continue
          const overlaps =
            bar.x < otherRect.x + otherRect.width &&
            bar.x + bar.width > otherRect.x &&
            bar.y < otherRect.y + otherRect.height &&
            bar.y + bar.height > otherRect.y
          expect(overlaps, `${layout}: tile ${index} bar overlaps tile ${other}`).toBe(false)
        }
      })
    }
  })
})

describe('which tile a pointer report is about', () => {
  it('reveals the tile the pointer reached', () => {
    expect(nextRevealedTile(null, { tileIndex: 2, y: 3 })).toBe(2)
  })

  it('moves the bar from one tile to the next', () => {
    expect(nextRevealedTile(0, { tileIndex: 1, y: 0 })).toBe(1)
  })

  it('hides when the tile holding the bar says the pointer has left', () => {
    expect(nextRevealedTile(1, { tileIndex: 1, y: TILE_BAR_POINTER_AWAY })).toBeNull()
  })

  it('lets a report about another tile decide nothing', () => {
    /*
      The race this exists for. Crossing from one tile's strip into the next produces a departure
      from the first and an arrival at the second, reported by two different renderers in no
      guaranteed order. If a departure could close a bar it does not own, the late-arriving one
      would shut the bar the arrival had just opened — and whether the feature worked would depend
      on scheduling.
    */
    expect(nextRevealedTile(1, { tileIndex: 0, y: TILE_BAR_POINTER_AWAY })).toBe(1)
    expect(nextRevealedTile(1, { tileIndex: 0, y: 300 })).toBe(1)
  })

  it('stays closed while the pointer is deep inside a page', () => {
    expect(nextRevealedTile(null, { tileIndex: 0, y: 300 })).toBeNull()
  })
})

describe('the bar for a tile', () => {
  const rects: Array<Rect | null> = [
    { x: 0, y: 88, width: 720, height: 812 },
    { x: 720, y: 88, width: 720, height: 812 }
  ]

  it('carries the tab of its own tile, not of the active one', () => {
    /*
      The single most important property of this feature. The toolbar's back button acts on the
      active tile; a per-tile bar whose buttons did the same would navigate the neighbour, which is
      the complaint the feature exists to answer.
    */
    const bar = tileBarPresentation({ tileIndex: 1, rects, tab: tab('t2'), invokedBy: 'pointer' })
    expect(bar?.tabId).toBe('t2')
    expect(bar?.tileIndex).toBe(1)
  })

  it('reports the strip of its own tile', () => {
    const bar = tileBarPresentation({ tileIndex: 1, rects, tab: tab('t2'), invokedBy: 'pointer' })
    expect(bar?.bounds).toEqual({ x: 720, y: 88, width: 720, height: TILE_BAR_HEIGHT })
  })

  it('carries what the buttons need to render, from the tab', () => {
    const bar = tileBarPresentation({
      tileIndex: 0,
      rects,
      tab: tab('t1', { canGoBack: true, canGoForward: true, loading: true, url: 'https://a.test/' }),
      invokedBy: 'keyboard'
    })
    expect(bar).toMatchObject({
      canGoBack: true,
      canGoForward: true,
      loading: true,
      url: 'https://a.test/',
      invokedBy: 'keyboard'
    })
  })

  it('gives a tile with no tab no bar at all', () => {
    // Every control would be a no-op, and a no-op button is indistinguishable from a broken one.
    expect(tileBarPresentation({ tileIndex: 0, rects, tab: null, invokedBy: 'pointer' })).toBeNull()
  })

  it('gives a collapsed tile no bar', () => {
    // What `tileRects` reports for the tiles a maximised neighbour has taken over.
    expect(
      tileBarPresentation({ tileIndex: 1, rects: [rects[0]!, null], tab: tab('t2'), invokedBy: 'pointer' })
    ).toBeNull()
  })

  it('gives an index that names no tile no bar', () => {
    // A pointer report from a view whose layout has since shrunk looks exactly like this.
    expect(tileBarPresentation({ tileIndex: 7, rects, tab: tab('t1'), invokedBy: 'pointer' })).toBeNull()
  })

  it('gives a tile with no area no bar', () => {
    // A layout computed before the first paint. A zero-width surface would hold the layer against
    // everything else while being invisible.
    const empty: Array<Rect | null> = [{ x: 0, y: 0, width: 0, height: 0 }]
    expect(tileBarPresentation({ tileIndex: 0, rects: empty, tab: tab('t1'), invokedBy: 'pointer' })).toBeNull()
  })
})

describe('the setting that gates it', () => {
  it('admits both routes when the bar follows the pointer', () => {
    expect(tileBarAllows('hover', 'pointer')).toBe(true)
    expect(tileBarAllows('hover', 'keyboard')).toBe(true)
  })

  it('keeps the keyboard route when the reveal is switched off', () => {
    /*
      The reason this is three modes and not a boolean. Someone who does not want surfaces
      appearing under their pointer — or whose machine cannot afford watching every mouse move —
      would otherwise have to give up the only way of navigating a non-active tile.
    */
    expect(tileBarAllows('keyboard', 'pointer')).toBe(false)
    expect(tileBarAllows('keyboard', 'keyboard')).toBe(true)
  })

  it('admits nothing when it is off', () => {
    expect(tileBarAllows('off', 'pointer')).toBe(false)
    expect(tileBarAllows('off', 'keyboard')).toBe(false)
  })

  it('answers for every mode there is', () => {
    // So a mode added to the list cannot be one the gate has no opinion about.
    for (const mode of TILE_BAR_MODES) {
      expect(typeof tileBarAllows(mode, 'keyboard'), mode).toBe('boolean')
    }
  })
})

describe('the step the core takes', () => {
  const rects: Array<Rect | null> = [
    { x: 0, y: 88, width: 720, height: 812 },
    { x: 720, y: 88, width: 720, height: 812 }
  ]
  const tabs: Record<number, TileBarTab | null> = { 0: tab('t1'), 1: tab('t2') }
  const tabOf = (tileIndex: number): TileBarTab | null => tabs[tileIndex] ?? null

  const step = (
    current: { tileIndex: number; invokedBy: 'pointer' | 'keyboard' } | null,
    request: Parameters<typeof tileBarStep>[0]['request'],
    mode: TileBarMode = 'hover'
  ): ReturnType<typeof tileBarStep> => tileBarStep({ current, mode, request, rects, tabOf })

  it('presents the bar for the tile the pointer reached', () => {
    const action = step(null, { invokedBy: 'pointer', tileIndex: 1, y: 2 })
    expect(action.do).toBe('present')
    expect(action.do === 'present' && action.presentation.tabId).toBe('t2')
  })

  it('hides when the pointer leaves the tile that has the bar', () => {
    expect(
      step({ tileIndex: 1, invokedBy: 'pointer' }, {
        invokedBy: 'pointer',
        tileIndex: 1,
        y: TILE_BAR_POINTER_AWAY
      }).do
    ).toBe('hide')
  })

  describe('the keyboard route', () => {
    it('presents the bar for the tile it is given, with no pointer anywhere near it', () => {
      /*
        Spec 7: the whole browser has to work from the keyboard. The shortcut names the active
        tile, and this is the only entrance that does not depend on where the mouse is — which is
        also why it carries no position to reason about.
      */
      const action = step(null, { invokedBy: 'keyboard', tileIndex: 1 })
      expect(action.do).toBe('present')
      expect(action.do === 'present' && action.presentation.tabId).toBe('t2')
    })

    it('asks the layer for focus, which the hover route must not', () => {
      const byKey = step(null, { invokedBy: 'keyboard', tileIndex: 0 })
      const byPointer = step(null, { invokedBy: 'pointer', tileIndex: 0, y: 1 })
      expect(byKey.do === 'present' && takesFocus(byKey.presentation)).toBe(true)
      // A bar that took focus because the pointer drifted would interrupt whatever the user was
      // typing in the page underneath, and do it silently.
      expect(byPointer.do === 'present' && takesFocus(byPointer.presentation)).toBe(false)
    })

    it('still works when the reveal is switched off', () => {
      expect(step(null, { invokedBy: 'keyboard', tileIndex: 0 }, 'keyboard').do).toBe('present')
    })

    it('is refused along with everything else when the bar is off', () => {
      expect(step(null, { invokedBy: 'keyboard', tileIndex: 0 }, 'off').do).toBe('nothing')
    })

    it('leaves a bar it opened alone when the mouse moves in keyboard-only mode', () => {
      /*
        `nothing`, not `hide`. Pointer reports keep arriving whatever the setting says — it decides
        what the browser reveals, not what the mouse does — and a bar the user opened by key must
        not be taken away by a hand brushing the trackpad.
      */
      expect(
        step({ tileIndex: 0, invokedBy: 'keyboard' }, {
          invokedBy: 'pointer',
          tileIndex: 0,
          y: TILE_BAR_POINTER_AWAY
        }, 'keyboard').do
      ).toBe('nothing')
    })
  })

  it('hides rather than presenting an empty tile', () => {
    const action = tileBarStep({
      current: null,
      mode: 'hover',
      request: { invokedBy: 'keyboard', tileIndex: 1 },
      rects,
      tabOf: () => null
    })
    expect(action.do).toBe('hide')
  })

  it('does nothing at all when the bar is switched off', () => {
    expect(step(null, { invokedBy: 'pointer', tileIndex: 0, y: 0 }, 'off').do).toBe('nothing')
  })

  describe('with a single tile', () => {
    const one: Array<Rect | null> = [{ x: 0, y: 88, width: 1440, height: 812 }]
    const single = (
      request: Parameters<typeof tileBarStep>[0]['request'],
      mode: TileBarMode = 'hover'
    ): ReturnType<typeof tileBarStep> =>
      tileBarStep({ current: null, mode, request, rects: one, tabOf })

    it('never presents a bar, however close the pointer comes', () => {
      // The toolbar above steers the same page, so a second address field over the top of it is a
      // duplicate that costs forty pixels of the document.
      expect(single({ invokedBy: 'pointer', tileIndex: 0, y: 0 }).do).toBe('hide')
      expect(single({ invokedBy: 'pointer', tileIndex: 0, y: TILE_BAR_REVEAL_WITHIN }).do).toBe(
        'hide'
      )
    })

    it('refuses the keyboard route too, since the reason is the same', () => {
      expect(single({ invokedBy: 'keyboard', tileIndex: 0 }).do).toBe('hide')
    })

    it('still says nothing rather than hide when the setting excludes the request', () => {
      // Order matters: the setting is answered first, so a mouse move in keyboard-only mode cannot
      // take down a bar the user opened with the shortcut — not even in a layout that has none.
      expect(single({ invokedBy: 'pointer', tileIndex: 0, y: 0 }, 'keyboard').do).toBe('nothing')
    })

    it('presents again as soon as there is a second tile', () => {
      expect(step(null, { invokedBy: 'keyboard', tileIndex: 0 }).do).toBe('present')
    })

    it('counts the tiles on screen, not the tiles in the layout', () => {
      /*
        A maximised tile is one tile on screen, and this rule is about what is on screen.

        `tileRects` keeps one entry per tile of the *layout* and nulls the collapsed ones, so a
        maximised tile in a `1x2` arrives here as a two-element array. Read as a length, that says
        "two tiles" while the user is looking at one — and the bar appeared over a maximised tile,
        duplicating the toolbar it exists to stand in for. It also handed the bar's own maximise
        button the one state in which it restores, under a tooltip still reading "Maximize tile".

        Both invocation routes are checked because both can reach that state: the maximised view
        spans the window so its top edge is under the pointer, and `toggleTileMaximized` makes the
        maximised tile active, which is the tile the keyboard shortcut asks for.
      */
      const maximised: Array<Rect | null> = [{ x: 0, y: 88, width: 1440, height: 812 }, null]
      const onMaximised = (
        request: Parameters<typeof tileBarStep>[0]['request']
      ): ReturnType<typeof tileBarStep> =>
        tileBarStep({ current: null, mode: 'hover', request, rects: maximised, tabOf })

      expect(onMaximised({ invokedBy: 'pointer', tileIndex: 0, y: 0 }).do).toBe('hide')
      expect(onMaximised({ invokedBy: 'keyboard', tileIndex: 0 }).do).toBe('hide')
    })
  })
})

describe('refreshing a bar that is already up', () => {
  /*
    The reported bug: pressing back in a tile's own bar left forward greyed out until the bar was
    re-opened, because the presentation is a snapshot taken when the bar appears.

    Every test here is about one of the two halves of the fix — that a changed tab produces a new
    presentation, and that an *unchanged* one produces nothing at all. The second half is not an
    optimisation: a bar the keyboard opened holds the focus and has an address field somebody may be
    typing in, and this is called on every tab change.
  */
  const rects = computeTileRects('1x2', { 'v-1': 0.5 }, CONTENT)
  const tabOf = (state: TileBarTab | null) => () => state

  const barFor = (state: TileBarTab, invokedBy: 'pointer' | 'keyboard' = 'pointer') => {
    const presentation = tileBarPresentation({ tileIndex: 0, rects, tab: state, invokedBy })
    if (presentation === null) throw new Error('the fixture layout has no first tile')
    return presentation
  }

  it('publishes the new state after the page went back', () => {
    // Exactly the reported gesture: back was possible, forward was not, and after the navigation the
    // opposite is true. What the user saw was the first pair, on screen, after the second was true.
    const current = barFor(tab('a', { canGoBack: true, canGoForward: false }))
    const action = tileBarRefresh({
      current,
      mode: 'hover',
      rects,
      tabOf: tabOf(tab('a', { canGoBack: false, canGoForward: true }))
    })

    expect(action.do).toBe('present')
    if (action.do !== 'present') return
    expect(action.presentation.canGoForward).toBe(true)
    expect(action.presentation.canGoBack).toBe(false)
  })

  it('does nothing when the bar would look exactly the same', () => {
    const state = tab('a', { canGoBack: true })
    expect(tileBarRefresh({ current: barFor(state), mode: 'hover', rects, tabOf: tabOf(state) }).do).toBe(
      'nothing'
    )
  })

  it('keeps the invocation that opened the bar, so a keyboard bar keeps its focus', () => {
    /*
      The field that decides whether the layer takes the focus. Re-presented as a pointer bar, a bar
      the user opened with the shortcut would lose the focus on the first navigation — which is the
      keyboard route (spec 7) breaking itself.
    */
    const current = barFor(tab('a', { canGoBack: true }), 'keyboard')
    const action = tileBarRefresh({
      current,
      mode: 'keyboard',
      rects,
      tabOf: tabOf(tab('a', { canGoForward: true }))
    })

    expect(action.do).toBe('present')
    if (action.do !== 'present') return
    expect(action.presentation.invokedBy).toBe('keyboard')
    expect(takesFocus(action.presentation)).toBe(true)
  })

  it('follows the url as well as the buttons', () => {
    // A navigation inside the same page's history changes the address and can change nothing else.
    const current = barFor(tab('a'))
    const action = tileBarRefresh({
      current,
      mode: 'hover',
      rects,
      tabOf: tabOf({ ...tab('a'), url: 'https://example.com/elsewhere' })
    })
    expect(action.do).toBe('present')
  })

  it('takes the bar down when the tab left the tile', () => {
    // The tile emptied under the bar — a tab dragged out, or closed. There is nothing left for back
    // and forward to act on, and a bar over an empty tile still swallows the pointer inside it.
    expect(
      tileBarRefresh({ current: barFor(tab('a')), mode: 'hover', rects, tabOf: tabOf(null) }).do
    ).toBe('hide')
  })

  it('takes the bar down when the setting was switched off while it was up', () => {
    // A refresh must not be the thing that keeps a bar alive that the user has just turned off.
    expect(
      tileBarRefresh({ current: barFor(tab('a')), mode: 'off', rects, tabOf: tabOf(tab('a')) }).do
    ).toBe('hide')
  })

  it('leaves a keyboard-opened bar standing in keyboard-only mode', () => {
    // The counterpart: `hover` reports are excluded in that mode, the bar itself is not.
    const state = tab('a', { canGoBack: true })
    const action = tileBarRefresh({
      current: barFor(state, 'keyboard'),
      mode: 'keyboard',
      rects,
      tabOf: tabOf({ ...state, canGoForward: true })
    })
    expect(action.do).toBe('present')
  })

  it('does nothing at all when the layer is not showing a bar', () => {
    // Called on every tab change, so most of the time this is the case.
    expect(tileBarRefresh({ current: null, mode: 'hover', rects, tabOf: tabOf(tab('a')) }).do).toBe(
      'nothing'
    )
  })
})
