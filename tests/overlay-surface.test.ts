import { describe, expect, it } from 'vitest'
import {
  OVERLAY_KINDS,
  OVERLAY_MARKS_THE_PAGE,
  OVERLAY_PRECEDENCE,
  OVERLAY_REGION,
  departureMatters,
  marksThePage,
  mayPresentOver,
  overlayBounds,
  overlayRegionRect,
  regionOf,
  surfaceIdentity,
  takesFocus,
  type OverlayKind,
  type OverlayPresentation
,
  type FindBarPresentation,
  type TileBarPresentation
} from '@shared/overlay/surface.js'
import { TILE_BAR_HEIGHT } from '@shared/split/tile-bar.js'
import { FIND_BAR_HEIGHT, FIND_BAR_WIDTH } from '@shared/find/bar.js'

/**
 * How much of the window the overlay layer takes, and who gets it when two things want it.
 *
 * The region decides which clicks the chrome UI still receives while a surface is up, so getting
 * it wrong is not a cosmetic problem: a surface sized to the whole window when it should have
 * left the tab strip alone silently swallows every click on the tab strip.
 *
 * The precedence decides something worse. The layer shows one surface at a time, so presenting is
 * replacing, and a replaced permission prompt is reported as vacated — which refuses the page's
 * request. Once a surface exists that a *drifting pointer* can claim, an unranked layer means the
 * browser answering a consent dialogue because somebody's hand moved.
 */

const WINDOW = { width: 1440, height: 900 }
const CONTENT = { x: 0, y: 88, width: 1440, height: 812 }

/**
 * One narrowed sample, because a `Record<OverlayKind, OverlayPresentation>` cannot express that the
 * `tile-bar` entry is a `TileBarPresentation` — the value type is the whole union, so spreading the entry and
 * adding `invokedBy` produces three members that have no such field. Checked rather than asserted, so a
 * sample table edited to hold the wrong kind fails here instead of somewhere further away.
 */
function tileBarSample(overrides: Partial<TileBarPresentation> = {}): TileBarPresentation {
  const sample = SAMPLES['tile-bar']
  if (sample.kind !== 'tile-bar') throw new Error('the tile-bar sample is no longer a tile bar')
  return { ...sample, ...overrides }
}

/** The same narrowing, for the same reason, on the other kind that carries its own rectangle. */
function findBarSample(overrides: Partial<FindBarPresentation> = {}): FindBarPresentation {
  const sample = SAMPLES['find-bar']
  if (sample.kind !== 'find-bar') throw new Error('the find-bar sample is no longer a find bar')
  return { ...sample, ...overrides }
}

const SAMPLES: Readonly<Record<OverlayKind, OverlayPresentation>> = {
  'layout-menu': {
    kind: 'layout-menu',
    anchor: { x: 10, y: 10, width: 20, height: 20 },
    current: '1x1'
  },
  'tab-drop': {
    kind: 'tab-drop',
    origin: { x: 0, y: 88 },
    zones: [],
    activeZoneId: null,
    title: 'a tab'
  },
  'permission-request': {
    kind: 'permission-request',
    requestId: 'r1',
    origin: 'https://example.com',
    subject: 'camera',
    devices: ['camera'],
    waiting: 0
  },
  'tile-bar': {
    kind: 'tile-bar',
    tileIndex: 1,
    bounds: { x: 720, y: 88, width: 720, height: TILE_BAR_HEIGHT },
    tabId: 't2',
    url: 'https://example.com/',
    canGoBack: true,
    canGoForward: false,
    loading: false,
    invokedBy: 'pointer'
  },
  'find-bar': {
    kind: 'find-bar',
    sessionId: 'find-1',
    tileIndex: 1,
    bounds: {
      x: 1440 - FIND_BAR_WIDTH - 8,
      y: 96,
      width: FIND_BAR_WIDTH,
      height: FIND_BAR_HEIGHT
    },
    tabId: 't2',
    query: 'needle',
    matches: 3,
    activeMatch: 2
  }
}

describe('overlay regions', () => {
  it('gives every kind a region', () => {
    // `satisfies` already enforces this at build time; asserted here too so a mutation that
    // drops an entry fails a test rather than only a compile.
    for (const kind of OVERLAY_KINDS) {
      expect(OVERLAY_REGION[kind], `${kind} has no region`).toBeDefined()
    }
  })

  it('gives a menu the whole window, so a click anywhere outside dismisses it', () => {
    expect(regionOf('layout-menu')).toBe('window')
  })

  it('covers the window from the origin for a window region', () => {
    expect(overlayRegionRect('window', WINDOW, CONTENT)).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 900
    })
  })

  it('leaves the toolbar live for a content region', () => {
    // What a drag indicator needs: the tab strip must keep receiving the drag it started.
    const rect = overlayRegionRect('content', WINDOW, CONTENT)
    expect(rect).toEqual(CONTENT)
    expect(rect.y).toBeGreaterThan(0)
  })

  it('does not confuse the two regions', () => {
    const asWindow = overlayRegionRect('window', WINDOW, CONTENT)
    const asContent = overlayRegionRect('content', WINDOW, CONTENT)
    expect(asWindow).not.toEqual(asContent)
  })

  it('gives a tile bar the strip it names and nothing more', () => {
    /*
      The one region the window cannot produce on its own: which strip depends on which tile. Sized
      to the content area instead, a bar revealed in one tile would swallow every click in the other
      three — four unusable pages to show one control.
    */
    expect(regionOf('tile-bar')).toBe('tile')
    expect(overlayBounds(SAMPLES['tile-bar'], WINDOW, CONTENT)).toEqual({
      x: 720,
      y: 88,
      width: 720,
      height: TILE_BAR_HEIGHT
    })
  })

  it('gives a find bar a box inside the tile it searches', () => {
    /*
      The same region as the tile bar and for the same reason — the window cannot produce it, because
      only the presentation knows which tile — but a corner rather than a strip. The layer swallows
      pointer events inside its bounds, and a find bar is up for as long as somebody is walking through
      matches, so a strip across the tile would take a band out of the very document being searched.
    */
    expect(regionOf('find-bar')).toBe('tile')
    expect(overlayBounds(SAMPLES['find-bar'], WINDOW, CONTENT)).toEqual({
      x: 1440 - FIND_BAR_WIDTH - 8,
      y: 96,
      width: FIND_BAR_WIDTH,
      height: FIND_BAR_HEIGHT
    })
  })

  it('sizes every other surface from its region', () => {
    expect(overlayBounds(SAMPLES['layout-menu'], WINDOW, CONTENT)).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 900
    })
    expect(overlayBounds(SAMPLES['tab-drop'], WINDOW, CONTENT)).toEqual(CONTENT)
    expect(overlayBounds(SAMPLES['permission-request'], WINDOW, CONTENT)).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 900
    })
  })
})

describe('two claims on one layer', () => {
  it('lets anything onto a free layer', () => {
    for (const kind of OVERLAY_KINDS) {
      expect(mayPresentOver(kind, null), kind).toBe(true)
    }
  })

  it('never lets a tile bar displace a permission prompt', () => {
    /*
      The rule this whole ranking exists for. A hover-revealed bar that replaced a prompt would
      refuse the page's request — the browser answering a consent dialogue on the user's behalf
      because their pointer moved towards a tile's top edge.
    */
    expect(mayPresentOver('tile-bar', SAMPLES['permission-request'])).toBe(false)
  })

  it('declines a tile bar asked for by keyboard while a prompt is up, too', () => {
    /*
      Deliberately the same answer. A prompt is modal to the window: while it is up, answering it
      is what the window is for, so the shortcut is declined rather than served — and the prompt
      keeps the layer instead of being refused by a keystroke aimed at something else.
    */
    const byKeyboard = tileBarSample({ invokedBy: 'keyboard' })
    expect(mayPresentOver(byKeyboard.kind, SAMPLES['permission-request'])).toBe(false)
  })

  it('lets a tile bar move from one tile to the next', () => {
    // Equal ranks replace, which is what makes the bar follow the pointer across a split.
    expect(mayPresentOver('tile-bar', SAMPLES['tile-bar'])).toBe(true)
  })

  it('yields the layer to every deliberate surface', () => {
    // Nothing is waiting on a bar, so displacing one costs a redraw and no correctness.
    for (const kind of OVERLAY_KINDS) {
      if (kind === 'tile-bar') continue
      expect(mayPresentOver(kind, SAMPLES['tile-bar']), kind).toBe(true)
    }
  })

  it('claims nothing that is already up', () => {
    expect(mayPresentOver('tile-bar', SAMPLES['layout-menu'])).toBe(false)
    expect(mayPresentOver('tile-bar', SAMPLES['tab-drop'])).toBe(false)
  })

  it('keeps a queued prompt able to follow the one just answered', () => {
    // Equal ranks replace, and the permission arbiter depends on it: the next prompt takes the
    // layer directly rather than through a dismissal that would flick focus back to the chrome UI.
    expect(mayPresentOver('permission-request', SAMPLES['permission-request'])).toBe(true)
  })

  it('lets a prompt take the layer from a menu', () => {
    expect(mayPresentOver('permission-request', SAMPLES['layout-menu'])).toBe(true)
  })

  it('does not let a menu take the layer from a prompt', () => {
    expect(mayPresentOver('layout-menu', SAMPLES['permission-request'])).toBe(false)
    expect(mayPresentOver('tab-drop', SAMPLES['permission-request'])).toBe(false)
  })

  it('ranks every kind', () => {
    for (const kind of OVERLAY_KINDS) {
      expect(typeof OVERLAY_PRECEDENCE[kind], `${kind} is unranked`).toBe('number')
    }
    // The bar is the weakest and the prompt the strongest; everything else sits between them.
    const ranks = OVERLAY_KINDS.map((kind) => OVERLAY_PRECEDENCE[kind])
    expect(OVERLAY_PRECEDENCE['tile-bar']).toBe(Math.min(...ranks))
    expect(OVERLAY_PRECEDENCE['permission-request']).toBe(Math.max(...ranks))
  })

  it('never lets a hovered tile bar destroy a search somebody is typing', () => {
    /*
      The rank the find bar was given for this one case. A tile bar is claimed by a pointer drifting
      near a tile's top edge, and a find bar holds text the user typed — so the tile bar losing here is
      the same rule that protects a consent dialogue from a passing hand, one rank down.
    */
    expect(mayPresentOver('tile-bar', SAMPLES['find-bar'])).toBe(false)
    expect(mayPresentOver('find-bar', SAMPLES['tile-bar'])).toBe(true)
  })

  it('never lets a find bar displace a permission prompt', () => {
    // A keystroke aimed at a search must not answer a question about the camera.
    expect(mayPresentOver('find-bar', SAMPLES['permission-request'])).toBe(false)
  })

  it('yields the layer to a menu and to a tab drag', () => {
    /*
      Deliberately asymmetric with the tile bar above. Both of these cannot function without the
      layer — a drag with no drop indicator is a drop landing blind — and both are gestures the user
      started on purpose. Losing a search term to one of them is a fair trade, and the term comes back:
      the core remembers it and the shortcut restores it.
    */
    expect(mayPresentOver('layout-menu', SAMPLES['find-bar'])).toBe(true)
    expect(mayPresentOver('tab-drop', SAMPLES['find-bar'])).toBe(true)
    expect(mayPresentOver('find-bar', SAMPLES['layout-menu'])).toBe(false)
    expect(mayPresentOver('find-bar', SAMPLES['tab-drop'])).toBe(false)
  })

  it('lets a find bar update its own match count', () => {
    // Equal replaces, and this is what carries a new count onto the layer.
    expect(mayPresentOver('find-bar', SAMPLES['find-bar'])).toBe(true)
  })
})

describe('surfaces whose departure is not free', () => {
  it('marks the page for exactly one kind', () => {
    for (const kind of OVERLAY_KINDS) {
      expect(OVERLAY_MARKS_THE_PAGE[kind], kind).toBe(kind === 'find-bar')
    }
  })

  it('knows that a find bar leaves a highlight behind', () => {
    /*
      `findInPage` marks its match in the document and only `stopFindInPage` unmarks it. The layer is
      taken down constantly by things that know nothing about a find session — a resize, a blur, a
      layout change, a prompt, a crashed renderer — so the departure has to be announced or the page
      keeps a block of highlighted text with nothing on screen to explain it.
    */
    expect(marksThePage(SAMPLES['find-bar'])).toBe(true)
    expect(departureMatters(SAMPLES['find-bar'])).toBe(true)
  })

  it('still announces a prompt, for the other reason', () => {
    // Two separate facts, either of which is enough: an unsettled promise and a marked page.
    expect(marksThePage(SAMPLES['permission-request'])).toBe(false)
    expect(departureMatters(SAMPLES['permission-request'])).toBe(true)
  })

  it('says nothing about a surface whose going costs nothing', () => {
    expect(departureMatters(SAMPLES['layout-menu'])).toBe(false)
    expect(departureMatters(SAMPLES['tab-drop'])).toBe(false)
    expect(departureMatters(SAMPLES['tile-bar'])).toBe(false)
  })
})

describe('telling an update from a replacement', () => {
  /**
   * The defect this fixes, and it was a live one.
   *
   * Presenting is replacing, and a replaced surface whose departure matters is announced as vacated.
   * But the layer is also how a surface's *contents* change: a permission prompt is re-presented when
   * the number queued behind it changes, and a find bar on every match count. Both went down the same
   * path as a genuine replacement — so queueing a second permission request behind an open dialogue
   * announced the open one as gone, and the arbiter settled the request the user was still reading as
   * refused.
   */
  it('gives a re-presented prompt the same identity', () => {
    const prompt = SAMPLES['permission-request']
    if (prompt.kind !== 'permission-request') throw new Error('the prompt sample is not a prompt')
    expect(surfaceIdentity({ ...prompt, waiting: 2 })).toBe(surfaceIdentity(prompt))
  })

  it('gives the next queued prompt a different one', () => {
    const prompt = SAMPLES['permission-request']
    if (prompt.kind !== 'permission-request') throw new Error('the prompt sample is not a prompt')
    expect(surfaceIdentity({ ...prompt, requestId: 'r2' })).not.toBe(surfaceIdentity(prompt))
  })

  it('gives a find bar with a new count the same identity', () => {
    expect(surfaceIdentity(findBarSample({ matches: 9, activeMatch: 4 }))).toBe(
      surfaceIdentity(SAMPLES['find-bar'])
    )
  })

  it('gives a reopened find bar a different one', () => {
    // A new session is what re-selects the field, so it has to read as a new surface.
    expect(surfaceIdentity(findBarSample({ sessionId: 'find-2' }))).not.toBe(
      surfaceIdentity(SAMPLES['find-bar'])
    )
  })

  it('names every kind, and never gives two kinds the same name', () => {
    const names = OVERLAY_KINDS.map((kind) => surfaceIdentity(SAMPLES[kind]))
    for (const [index, name] of names.entries()) {
      expect(name, `${OVERLAY_KINDS[index]!} has no identity`).not.toBe('')
    }
    expect(new Set(names).size).toBe(names.length)
  })

  it("distinguishes one tile's bar from the next", () => {
    expect(surfaceIdentity(tileBarSample({ tileIndex: 2 }))).not.toBe(
      surfaceIdentity(SAMPLES['tile-bar'])
    )
  })
})

describe('which surfaces take the keyboard', () => {
  it('gives focus to everything the user asked for directly', () => {
    expect(takesFocus(SAMPLES['layout-menu'])).toBe(true)
    expect(takesFocus(SAMPLES['tab-drop'])).toBe(true)
    expect(takesFocus(SAMPLES['permission-request'])).toBe(true)
  })

  it('refuses it to a bar the pointer revealed', () => {
    /*
      The layer is a real web contents, so focusing it takes focus off the page. A bar appearing
      because the pointer drifted near a tile's top edge would interrupt whatever was being typed
      underneath — and silently, since nothing on screen says the keyboard has moved.
    */
    expect(takesFocus(SAMPLES['tile-bar'])).toBe(false)
  })

  it('grants it to a bar asked for by key, which is the request itself', () => {
    expect(takesFocus(tileBarSample({ invokedBy: 'keyboard' }))).toBe(true)
  })

  it('always gives it to the find bar, which is a text field', () => {
    // The strongest case of the five: reached only by shortcut, and its whole purpose is to be typed
    // into. A find bar that did not take focus would be a search box you cannot type in.
    expect(takesFocus(SAMPLES['find-bar'])).toBe(true)
  })
})
