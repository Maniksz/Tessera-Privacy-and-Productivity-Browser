import type { Rect } from './layout.js'
import type { OverlayInvocation, TileBarPresentation } from '../overlay/surface.js'

/**
 * The navigation bar that appears at the top edge of a tile.
 *
 * The complaint it answers: in a split layout the toolbar acts on one tile, so the other tiles
 * had no way to go back or to edit their address. A bar per tile, revealed by reaching for the
 * top edge, gives each tile the controls the toolbar gives the active one — without spending
 * permanent vertical space on three copies of it.
 *
 * ## Why the reveal needs hysteresis
 *
 * Showing and hiding at the same position makes the bar flicker: the moment it appears, the
 * pointer is inside it, and the next sample is read as "still at the top", but a sample a pixel
 * lower would hide it again. Two thresholds — a narrow one to reveal, the bar's own height to
 * dismiss — give the pointer somewhere to rest.
 *
 * ## Why the pointer position comes from the page, not from the chrome UI
 *
 * A tile is a native view stacked above the chrome renderer, so the chrome never sees a pointer
 * that is over a page. The core reads it from the view's own input events instead. Once the bar
 * is up it covers the strip, so the *hiding* decision cannot come from the same source — the
 * view stops receiving moves there. The bar reports its own departure.
 *
 * ## Why a hover is not the only way in
 *
 * A control reachable only by pointer fails spec 7, which requires the whole browser to be
 * operable from the keyboard. So the same bar has a second entrance: a shortcut presents it for
 * the active tile and moves focus into it, and Escape takes it down. That is why a request
 * carries *why* it was made — the two entrances agree on everything except the keyboard, and the
 * one thing a hover may never do is take focus away from the page the user is typing in.
 *
 * Pure so every rule here can be tested without a window.
 */

/** Height of the bar, and the distance at which the pointer stops holding it open. */
export const TILE_BAR_HEIGHT = 40

/** How close to the top edge the pointer has to come for the bar to appear. */
export const TILE_BAR_REVEAL_WITHIN = 6

/**
 * The position a surface reports when the pointer has left its strip.
 *
 * Past the hold threshold on purpose, and a constant rather than the pointer's real position: the
 * bar covers the strip, so the pointer leaves it either upwards (towards the chrome) or downwards
 * (into the page), and the two directions produce coordinates at opposite ends of the strip. Taken
 * from the event, an upward departure would read as "still at the very top" and hold the bar open
 * for ever.
 */
export const TILE_BAR_POINTER_AWAY = TILE_BAR_HEIGHT + 1

/**
 * Whether the bar should be up, given where it was and where the pointer is.
 *
 * `pointerY` is relative to the tile, which is what a view reports about itself.
 */
export function tileBarVisibility(wasVisible: boolean, pointerY: number): boolean {
  if (pointerY < 0) return false
  if (pointerY <= TILE_BAR_REVEAL_WITHIN) return true
  // Between the two thresholds the answer is "whatever it already was" — that gap is the whole
  // point of having two of them.
  if (pointerY <= TILE_BAR_HEIGHT) return wasVisible
  return false
}

/**
 * The strip the bar occupies, in the same space the tile rect is given in.
 *
 * Only the strip, never the whole tile: the overlay layer swallows every pointer event inside
 * its bounds, so a bar sized to the tile would make the page under it unusable while it was up.
 */
export function tileBarBounds(tileRect: Rect): Rect {
  return {
    x: tileRect.x,
    y: tileRect.y,
    width: tileRect.width,
    height: Math.min(TILE_BAR_HEIGHT, tileRect.height)
  }
}

/**
 * How the bar may be reached, as a user-facing setting.
 *
 * `keyboard` is not a lesser version of `hover` and is not there for tidiness. The reveal costs a
 * subscription to every tile view's input events, which is per-mouse-move work in the main
 * process — precisely the kind of cost the older machines this has to stay usable on cannot
 * absorb. It also lets someone who finds surfaces appearing under their pointer intolerable keep
 * the feature rather than lose it, which `off` alone would not offer.
 */
export const TILE_BAR_MODES = ['hover', 'keyboard', 'off'] as const

export type TileBarMode = (typeof TILE_BAR_MODES)[number]

/** Whether the setting admits a request that came in this way. */
export function tileBarAllows(mode: TileBarMode, invokedBy: OverlayInvocation): boolean {
  if (mode === 'off') return false
  if (mode === 'keyboard') return invokedBy === 'keyboard'
  return true
}

/**
 * Which tile's bar should be up after a pointer report, given which one is up now.
 *
 * Reports name the tile they are about, and a report about *another* tile decides nothing. That
 * asymmetry is the fix for a race that is otherwise unavoidable: the pointer crossing from one
 * tile's strip into the next produces a departure from the first and an arrival at the second,
 * from two different renderers, in no guaranteed order. Treated symmetrically, a departure that
 * arrived second would close the bar the arrival had just opened, and the bar would appear and
 * vanish depending on scheduling.
 */
export function nextRevealedTile(
  shown: number | null,
  report: { tileIndex: number; y: number }
): number | null {
  if (tileBarVisibility(shown === report.tileIndex, report.y)) return report.tileIndex
  // Only the tile that has the bar can say the pointer has left it.
  if (shown === report.tileIndex) return null
  return shown
}

/** What the bar needs to know about a tab. A subset of `TabState`, so a tab state satisfies it. */
export interface TileBarTab {
  id: string
  url: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/**
 * The bar for one tile, or `null` when that tile cannot have one.
 *
 * Three ways to have no bar, and all three are ordinary rather than exceptional:
 *
 *  - the index names no tile, which is what an out-of-date pointer report from a view whose
 *    layout has since shrunk looks like;
 *  - the tile is collapsed behind a maximised neighbour, which `tileRects` reports as `null`;
 *  - the tile holds no tab, so back, forward and an address would have nothing to act on. An
 *    empty tile with a live-looking navigation bar is the worst of the three: every control would
 *    be a no-op the user cannot tell from a broken one.
 */
export function tileBarPresentation(input: {
  tileIndex: number
  /** Tile rectangles as the split controller reports them; `null` for a collapsed tile. */
  rects: ReadonlyArray<Rect | null>
  tab: TileBarTab | null
  invokedBy: OverlayInvocation
}): TileBarPresentation | null {
  // `slice` rather than an index plus a guard: total either way, and this directory is held to
  // covering every branch it declares. See `dropzones.ts` for the same idiom.
  const [rect] = input.rects.slice(input.tileIndex, input.tileIndex + 1)
  if (rect === undefined || rect === null) return null
  // A degenerate tile — a grid computed before the first paint has these — would give the layer a
  // zero-width strip: an invisible surface holding the layer against everything else.
  if (rect.width <= 0 || rect.height <= 0) return null

  const tab = input.tab
  if (tab === null) return null

  return {
    kind: 'tile-bar',
    tileIndex: input.tileIndex,
    bounds: tileBarBounds(rect),
    tabId: tab.id,
    url: tab.url,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    loading: tab.loading,
    invokedBy: input.invokedBy
  }
}

/** The bar that is currently up, as the core remembers it between requests. */
export interface TileBarState {
  tileIndex: number
  invokedBy: OverlayInvocation
}

/**
 * A request for the bar: the pointer moved inside a tile, or the user pressed the shortcut.
 *
 * The keyboard form carries no position because there is none to carry — the caller names the
 * active tile, which is the one the user means when they have not pointed at anything.
 */
export type TileBarRequest =
  | { invokedBy: 'pointer'; tileIndex: number; y: number }
  | { invokedBy: 'keyboard'; tileIndex: number }

export type TileBarAction =
  | { do: 'present'; presentation: TileBarPresentation }
  | { do: 'hide' }
  /** Leave the layer exactly as it is — including a bar that is already up. */
  | { do: 'nothing' }

/**
 * The whole decision, as one pure step: what should happen to the tile bar now.
 *
 * All of it is here rather than in the window controller because every part of it is a rule
 * somebody can get wrong — which tile a report is about, whether the setting admits it, whether
 * the tile even has a tab — and a rule that lives inside a class holding a `BrowserWindow` can
 * only be checked by driving a browser. The controller is left with three cases and no arithmetic.
 *
 * Re-presenting the same tile is deliberately *not* suppressed. It is nearly free (the layer is
 * already there, and only the surface's props change), the repeat reveals a hover can produce are
 * few because the bar itself covers the strip the reports come from, and the same call is how an
 * open bar picks up a navigation in its tab. Suppressing it would need a comparison of everything
 * the presentation carries, and getting that comparison subtly wrong shows up as an address bar
 * displaying the previous page.
 */
export function tileBarStep(input: {
  current: TileBarState | null
  mode: TileBarMode
  request: TileBarRequest
  rects: ReadonlyArray<Rect | null>
  /** The tab in a tile, resolved by the caller, which is the only side that knows the tabs. */
  tabOf: (tileIndex: number) => TileBarTab | null
}): TileBarAction {
  /*
    `nothing`, not `hide`.

    In `keyboard` mode the pointer reports still arrive — the setting decides what the browser
    reveals, not what the mouse does — and a bar the user opened with the shortcut must survive
    the mouse moving somewhere unrelated.
  */
  if (!tileBarAllows(input.mode, input.request.invokedBy)) return { do: 'nothing' }

  const target =
    input.request.invokedBy === 'keyboard'
      ? input.request.tileIndex
      : nextRevealedTile(input.current?.tileIndex ?? null, input.request)
  if (target === null) return { do: 'hide' }

  const presentation = tileBarPresentation({
    tileIndex: target,
    rects: input.rects,
    tab: input.tabOf(target),
    invokedBy: input.request.invokedBy
  })
  if (presentation === null) return { do: 'hide' }
  return { do: 'present', presentation }
}
