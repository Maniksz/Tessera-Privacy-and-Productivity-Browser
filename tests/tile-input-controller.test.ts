import { describe, expect, it } from 'vitest'
import { TileInputController, type TileInputHost } from '@main/browser/TileInputController.js'
import {
  TILE_BAR_HEIGHT,
  TILE_BAR_POINTER_AWAY,
  tileBarPresentation,
  type TileBarMode,
  type TileBarTab
} from '@shared/split/tile-bar.js'
import type {
  FindBarPresentation,
  OverlayInvocation,
  OverlayPresentation,
  OverlayState,
  PermissionRequestPresentation,
  TileBarPresentation
} from '@shared/overlay/surface.js'
import type { Point } from '@shared/split/dropzones.js'
import { computeTileRects, type Rect } from '@shared/split/layout.js'

/**
 * The wiring between the tile input decisions and the window that has to carry them out.
 *
 * The decisions themselves are pure and tested elsewhere — `tileBarStep` and `tileBarRefresh` in
 * `tile-bar.test.ts`, `decideNavigationGesture` in `navigation-gestures.test.ts`. What is here is
 * the seam: which host call each answer becomes, and what the controller reads off the window to
 * ask the question in the first place. Both are the kind of mistake that no pure test can catch and
 * no review notices — an argument taken from the wrong getter, or a `hide` carried out by the wrong
 * dismissal — and both are visible to the user immediately.
 *
 * The host is ten plain functions over plain data, so none of this needs a window.
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1440, height: 812 }
/** Two tiles, because `tileBarStep` refuses a bar in a single-tile window. */
const COLUMNS = computeTileRects('1x2', {}, CONTENT, { gutter: 8 })

function tileRect(index: number): Rect {
  const [rect] = COLUMNS.slice(index, index + 1)
  if (rect === undefined) throw new Error(`no tile ${index}`)
  return rect
}

/** A point well inside a tile, in the space `tileRects` reports. */
function inTile(index: number): Point {
  const rect = tileRect(index)
  return { x: rect.x + 20, y: rect.y + 20 }
}

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

/**
 * A bar as the core would have built it, to sit on the layer as the state a request finds.
 *
 * Built with the same function the controller builds one with, deliberately: a refresh compares the
 * new bar against the old field by field, so a hand-written fixture would turn every refresh test
 * into a test of whether the fixture got the strip's arithmetic right.
 */
function barOn(
  tileIndex: number,
  onTab: TileBarTab,
  invokedBy: OverlayInvocation = 'pointer'
): TileBarPresentation {
  const bar = tileBarPresentation({ tileIndex, rects: COLUMNS, tab: onTab, invokedBy })
  if (bar === null) throw new Error(`no bar for tile ${tileIndex}`)
  return bar
}

function permissionPrompt(): PermissionRequestPresentation {
  return {
    kind: 'permission-request',
    requestId: 'req-1',
    origin: 'https://example.com',
    subject: 'camera',
    devices: ['camera'],
    waiting: 0
  }
}

/** A find bar in a tile — the other surface on this layer that carries a `tileIndex`. */
function findBarOn(tileIndex: number): FindBarPresentation {
  return {
    kind: 'find-bar',
    sessionId: 'find-1',
    tileIndex,
    bounds: tileRect(tileIndex),
    tabId: 'tab-a',
    query: 'half typed',
    matches: 3,
    activeMatch: 1
  }
}

interface Harness {
  input: TileInputController
  rects: Array<Rect | null>
  activeTile: number
  mode: TileBarMode
  overlay: OverlayState
  /** The tab in each tile, by index. */
  tabs: Array<TileBarTab | null>
  cursor: Point | null
  /**
   * Every call the controller made on its host, in order.
   *
   * Recorded as a list rather than as counters because the assertion that matters most is a
   * negative one: several of these answers are "do nothing at all", and only a complete log can
   * tell "nothing happened" apart from "something happened that nobody looked for".
   */
  calls: string[]
  presented: OverlayPresentation[]
  navigated: Array<{ intent: 'back' | 'forward'; tileIndex: number }>
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const state: Partial<Harness> = {
    rects: [...COLUMNS],
    activeTile: 0,
    mode: 'hover',
    overlay: null,
    tabs: [tab('tab-a'), tab('tab-b')],
    cursor: null,
    calls: [],
    presented: [],
    navigated: [],
    ...overrides
  }

  const host: TileInputHost = {
    tileRects: () => state.rects!,
    activeTile: () => state.activeTile!,
    tileBarMode: () => state.mode!,
    overlayPresentation: () => state.overlay!,
    present: (presentation) => {
      state.calls!.push('present')
      state.presented!.push(presentation)
    },
    dismissTileBar: () => {
      state.calls!.push('dismissTileBar')
    },
    tabIn: (tileIndex) => state.tabs![tileIndex] ?? null,
    cursor: () => state.cursor!,
    goBack: (tileIndex) => {
      state.calls!.push(`goBack:${tileIndex}`)
      state.navigated!.push({ intent: 'back', tileIndex })
    },
    goForward: (tileIndex) => {
      state.calls!.push(`goForward:${tileIndex}`)
      state.navigated!.push({ intent: 'forward', tileIndex })
    }
  }

  state.input = new TileInputController(host)
  return state as Harness
}

/** The last presentation handed to the host, which is what the user would be looking at. */
function lastBar(h: Harness): TileBarPresentation {
  const [presentation] = h.presented.slice(-1)
  if (presentation?.kind !== 'tile-bar') {
    throw new Error(`no tile bar presented; got ${JSON.stringify(h.presented)}`)
  }
  return presentation
}

describe('what the controller reads off the layer before deciding', () => {
  it('treats a bar already up as the bar that is up', () => {
    // The control for the two tests below: in the hysteresis gap the answer depends entirely on
    // what the controller believed was on the layer, so this is the case that must say "present".
    const h = harness({ overlay: barOn(1, tab('tab-b')) })

    h.input.requestTileBar({ invokedBy: 'pointer', tileIndex: 1, y: TILE_BAR_HEIGHT })

    expect(lastBar(h).tileIndex).toBe(1)
  })

  it('does not mistake a find bar in the same tile for its navigation bar', () => {
    /*
      The find bar is the other surface that carries a `tileIndex`, so it is the one thing a
      narrowing by "has a tile" instead of by kind would let through: the controller would believe
      a bar was already open in that tile, and a pointer resting in the hysteresis gap — where the
      answer is "whatever it already was" — would become a request to present over somebody's
      half-typed query.

      The layer would refuse that today, because a tile bar outranks nothing (`OVERLAY_PRECEDENCE`).
      That is the second lock, and this is the first: the controller must not be the thing that
      relies on it. Reordering that table is otherwise the kind of change whose consequence is a
      search term vanishing because a hand moved towards a tile's top edge.
    */
    const h = harness({ overlay: findBarOn(1) })

    h.input.requestTileBar({ invokedBy: 'pointer', tileIndex: 1, y: TILE_BAR_HEIGHT })

    expect(h.presented).toEqual([])
  })

  it('passes a permission prompt as no bar at all', () => {
    // A prompt is not a bar holding itself open, so a pointer resting where a bar would have
    // stayed up reveals nothing. The window is for answering the prompt while it is there.
    const h = harness({ overlay: permissionPrompt() })

    h.input.requestTileBar({ invokedBy: 'pointer', tileIndex: 1, y: TILE_BAR_HEIGHT })

    expect(h.presented).toEqual([])
  })
})

describe('carrying out what a bar request decided', () => {
  it('presents the bar the decision built', () => {
    const h = harness()

    h.input.requestTileBar({ invokedBy: 'pointer', tileIndex: 1, y: 0 })

    expect(h.calls).toEqual(['present'])
    expect(lastBar(h)).toMatchObject({ tileIndex: 1, tabId: 'tab-b', invokedBy: 'pointer' })
  })

  it('presents a keyboard-invoked bar as keyboard-invoked', () => {
    // The one field that decides whether the layer takes the focus (`takesFocus`). Presenting the
    // shortcut's bar as a hover's would leave a bar nobody can type into, which is spec 7.
    const h = harness()

    h.input.requestTileBar({ invokedBy: 'keyboard', tileIndex: 0 })

    expect(lastBar(h).invokedBy).toBe('keyboard')
  })

  it('takes a departed bar down by kind and does nothing else', () => {
    /*
      The whole call log, and the assertion is the shape of it. A pointer leaving a tile must not
      take down a permission prompt: the layer shows one surface at a time, a prompt that leaves it
      is settled the safe way — refused — and that is a page's `getUserMedia` denied because a hand
      moved towards the top of a tile. The by-kind dismissal is what makes that unreachable rather
      than unlikely, so a plain dismiss appearing on the host and being used here has to fail.
    */
    const h = harness({ overlay: permissionPrompt() })

    h.input.requestTileBar({ invokedBy: 'pointer', tileIndex: 0, y: TILE_BAR_POINTER_AWAY })

    expect(h.calls).toEqual(['dismissTileBar'])
  })

  it('leaves the layer completely alone when the decision is to do nothing', () => {
    /*
      `keyboard` mode still receives pointer reports — the setting decides what the browser reveals,
      not what the mouse does — and a bar the user opened with the shortcut has to survive the mouse
      moving somewhere unrelated. `nothing` therefore has to be *no host call*: carrying it out as a
      dismissal would close that bar, and carrying it out as a present would move it.
    */
    const h = harness({ mode: 'keyboard', overlay: barOn(0, tab('tab-a'), 'keyboard') })

    h.input.requestTileBar({ invokedBy: 'pointer', tileIndex: 1, y: 0 })

    expect(h.calls).toEqual([])
  })
})

describe('reading a tab’s state back into the bar that is up', () => {
  it('hands the whole bar to the comparison, not just which tile it is on', () => {
    /*
      The asymmetry with `requestTileBar`, which passes a two-field projection, and it is
      load-bearing rather than accidental: the refresh answers `nothing` by comparing the new bar
      against the old one field by field. Given only the tile index and the invocation, every field
      of the old bar would read as absent, every comparison would fail, and every refresh would
      re-present — which resets the address field of a keyboard-opened bar somebody is halfway
      through typing into. That is exactly what the comparison exists to prevent, and this is the
      only place that proves the comparison is given anything to compare.
    */
    const unchanged = tab('tab-a', { canGoBack: true })
    const h = harness({ overlay: barOn(0, unchanged), tabs: [unchanged, tab('tab-b')] })

    h.input.refreshTileBar()

    expect(h.calls).toEqual([])
  })

  it('re-presents the bar with the state the tab is actually in', () => {
    /*
      The reported bug: pressing back in a tile's own bar navigated the page and left the bar
      showing what it read when it opened, so forward stayed greyed out until the bar was
      re-opened. A presentation is a snapshot; this is what unfreezes it.
    */
    const h = harness({
      overlay: barOn(0, tab('tab-a', { canGoBack: true })),
      tabs: [tab('tab-a', { canGoBack: false, canGoForward: true }), tab('tab-b')]
    })

    h.input.refreshTileBar()

    expect(h.calls).toEqual(['present'])
    expect(lastBar(h)).toMatchObject({ tileIndex: 0, canGoBack: false, canGoForward: true })
  })

  it('takes the bar down when the setting stops admitting it', () => {
    // The setting can be turned off while a bar is on screen, and a refresh must not be the thing
    // that keeps it alive.
    const h = harness({ mode: 'off', overlay: barOn(0, tab('tab-a')) })

    h.input.refreshTileBar()

    expect(h.calls).toEqual(['dismissTileBar'])
  })

  it('takes the bar down when its tile no longer holds a tab', () => {
    // An empty tile with a live-looking bar is the worst version of this: every control would be a
    // no-op the user cannot tell from a broken one.
    const h = harness({ overlay: barOn(0, tab('tab-a')), tabs: [null, tab('tab-b')] })

    h.input.refreshTileBar()

    expect(h.calls).toEqual(['dismissTileBar'])
  })

  it('touches nothing when the layer is not showing a bar', () => {
    /*
      A refresh runs on every tab change — a title, a load finishing, a navigation in a tile nobody
      is looking at — so it fires constantly while a permission prompt is on screen. Answering that
      with any host call at all would make an unrelated page finishing its load the reason a consent
      dialogue disappeared.
    */
    const h = harness({ overlay: permissionPrompt() })

    h.input.refreshTileBar()

    expect(h.calls).toEqual([])
  })
})

describe('where a navigation gesture goes', () => {
  it('navigates the tile under the cursor rather than the active one', () => {
    /*
      The reason this controller exists rather than three lines in a subscription. With pages side
      by side the hand is on the mouse over the tile being read, which is frequently not the tile
      that last had focus — and a thumb button that navigates the neighbour is indistinguishable
      from a bug. Taking the pointer from `cursor()` and the fallback from `activeTile()` the other
      way round compiles and reviews clean, and this is the assertion that does not.
    */
    const h = harness({ cursor: inTile(1), activeTile: 0 })

    h.input.navigateByGesture('app-command', 'browser-backward')

    expect(h.navigated).toEqual([{ intent: 'back', tileIndex: 1 }])
  })

  it('falls back to the active tile when the cursor is in the gutter', () => {
    // Eight pixels no view covers. Refusing there would make the divider a dead zone where the
    // mouse button silently does nothing.
    const rect = tileRect(0)
    const h = harness({ cursor: { x: rect.x + rect.width + 2, y: rect.y + 20 }, activeTile: 1 })

    h.input.navigateByGesture('swipe', 'right')

    expect(h.navigated).toEqual([{ intent: 'back', tileIndex: 1 }])
  })

  it('falls back to the active tile when there is no cursor to read', () => {
    // `cursor()` answers `null` for a window on its way out. A gesture arriving then must not be
    // resolved against stale bounds, and must not be dropped either.
    const h = harness({ cursor: null, activeTile: 1 })

    h.input.navigateByGesture('swipe', 'left')

    expect(h.navigated).toEqual([{ intent: 'forward', tileIndex: 1 }])
  })

  it('does nothing for input that is not a navigation gesture', () => {
    /*
      A five-button mouse also sends refresh, home, search and a row of media keys, and macOS sends
      vertical swipes that belong to Mission Control. There is no decision for any of them, and the
      early return is what keeps "no decision" from being read as a decision to go forward.
    */
    const h = harness({ cursor: inTile(1) })

    h.input.navigateByGesture('app-command', 'browser-refresh')
    h.input.navigateByGesture('swipe', 'up')

    expect(h.calls).toEqual([])
  })

  it('sends each of the four gestures to the direction it means', () => {
    /*
      The cross product, because the branch here is one negation away from a browser whose gestures
      all go the wrong way — and a swipe's direction is a convention, not a derivation: a swipe to
      the right goes *back*, because the page follows your fingers.
    */
    const cases: Array<[Parameters<TileInputController['navigateByGesture']>[0], string, string]> =
      [
        ['app-command', 'browser-backward', 'goBack:1'],
        ['app-command', 'browser-forward', 'goForward:1'],
        ['swipe', 'right', 'goBack:1'],
        ['swipe', 'left', 'goForward:1']
      ]

    for (const [source, name, expected] of cases) {
      const h = harness({ cursor: inTile(1) })
      h.input.navigateByGesture(source, name)
      expect(h.calls, `${source} ${name}`).toEqual([expected])
    }
  })
})
