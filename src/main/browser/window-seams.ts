import type { LayoutId, Rect } from '@shared/split/layout.js'
import { TILE_BOUND_KINDS, type OverlayPresentation } from '@shared/overlay/surface.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { effectiveZoomPercent } from '@shared/zoom/model.js'
import { isTabHidden } from '@shared/tabgroups/model.js'
import type { ArrangementBook } from '../data/ArrangementStore.js'
import type { TabGroupBook } from '../data/TabGroupStore.js'
import type { SplitController } from './SplitController.js'
import type { OverlayLayer } from './OverlayLayer.js'
import type { Tab } from './Tab.js'
import { ArrangementController } from './ArrangementController.js'
import { TabDragController } from './TabDragController.js'
import { TabGroupController } from './TabGroupController.js'
import { TileAudioController } from './TileAudioController.js'
import { TileFullscreenController } from './TileFullscreenController.js'
import { TileInputController } from './TileInputController.js'
import { TileOccupancyController, type LayoutChangeOptions } from './TileOccupancyController.js'
import { liveContentsOf } from './view-contents.js'

/**
 * Builds the seven controllers a window delegates to, and — the actual point — writes down what each of them
 * is allowed to reach.
 *
 * ## Why this is a file and not a hundred lines of a constructor
 *
 * Every one of these seven exists because a decision was worth testing without a browser, and each is written
 * against a host interface for exactly that reason. But the *host objects* were all built inline, which meant
 * the constructor was a hundred lines of closures over private fields and there was nowhere to look up the
 * answer to "what can the drag controller touch?" — you had to read its literal and then read its interface.
 *
 * Collected here, the answer is one screen: `WindowInternals` is the whole surface a window exposes to its own
 * seams, and every closure below is visibly a projection of it. A seam that starts wanting something new has to
 * add it to that interface, where it is a deliberate widening rather than one more `this.#tabs.get(…)` buried in
 * a literal.
 *
 * ## What this is not
 *
 * Not a dependency-injection container and not a lifecycle. It is called once, returns seven objects, and is
 * finished — the window still owns them and still decides when each is asked anything. The three ordering
 * constraints are spelled out where each bites.
 */

/**
 * Everything a window exposes to the controllers it delegates to.
 *
 * Deliberately a *narrow* view of a window rather than the window itself. Passing `BrowserWindowController` here
 * would compile and would mean any seam could reach anything — including creating windows and closing tabs —
 * and the reason each of these controllers is testable is precisely that none of them can.
 */
export interface WindowInternals {
  split: SplitController
  overlay: OverlayLayer
  /** `true` once the window is gone; every reader here has to survive that. */
  isDestroyed(): boolean
  getSettings(): SettingsSnapshot
  contentBounds(): { x: number; y: number; width: number; height: number }
  /**
   * Where the pointer is on the screen, in the coordinates `contentBounds` uses.
   *
   * Handed in rather than read from Electron's `screen` here, so this file imports nothing from
   * Electron at runtime and a test can build every seam without an Electron process (ownership plan
   * U6). The same line `window-options.ts` draws with its type-only import.
   */
  cursorScreenPoint(): { x: number; y: number }
  contentRect(): Rect
  setFullScreenable(allowed: boolean): void
  exitWindowFullscreen(): void
  /** Puts the window back, for a fullscreen that was taken away by something other than the user. */
  enterWindowFullscreen(): void
  /** Flips it, for the key that means "fullscreen" rather than "leave fullscreen". */
  toggleWindowFullscreen(): void

  /** The window's tabs, by id. A seam reads; only the window adds and removes. */
  tab(tabId: string): Tab | undefined
  tabIds(): readonly string[]
  /** Strip order, which is independent of tile assignment. */
  tabOrder(): readonly string[]
  setTabOrder(order: readonly string[]): void

  assignTabToTile(tabId: string, tileIndex: number | null): void
  closeTab(tabId: string): void
  /**
   * Makes a tab the active one, by the same path a click in the strip takes — including the way back
   * to a recorded tiling for a tab that holds no tile.
   */
  activateTab(tabId: string): void
  setActiveTile(tileIndex: number): void
  /** Opens a start-page tab for an empty tile, marked as a filler. */
  openFiller(tileIndex: number): void
  applyLayout(layout: LayoutId, options: LayoutChangeOptions): void

  presentOverlay(presentation: OverlayPresentation): void
  relayout(): void
  broadcast(): void
  /** Sent to the chrome UI when the layer's presentation changes. */
  onOverlayPresentationChanged(presentation: OverlayPresentation | null): void

  /** This window's tab groups, already bound to its browsing mode. */
  tabGroups: TabGroupBook
  /**
   * This window's recorded tilings, already bound to its browsing mode.
   *
   * Bound the same way and for the same reason as `tabGroups`: `ArrangementStore.bookFor` hands a
   * private window a book over a variable, so a window holds no path to the file rather than a path
   * it is expected to leave alone.
   */
  arrangements: ArrangementBook
}

export interface WindowSeams {
  drag: TabDragController
  fullscreen: TileFullscreenController
  occupancy: TileOccupancyController
  audio: TileAudioController
  tileInput: TileInputController
  groups: TabGroupController
  arrangements: ArrangementController
}

export function createWindowSeams(internals: WindowInternals): WindowSeams {
  /*
    `occupancy` is referenced by `drag` and by `arrangements` before it is assigned, which is why this is a
    `let` read through a closure rather than a value passed in.

    The drag controller's `drop` hands the zone to the occupancy controller, and the occupancy controller does
    not know about dragging at all — so that dependency runs one way and the *construction* order cannot satisfy
    it directly. The arrangement controller's is the harder case, and it is argued where it is built. Read
    lazily both are fine: nothing drops a tab or restores a tiling during construction.
  */
  let occupancy: TileOccupancyController | null = null

  const drag = new TabDragController({
    layout: () => internals.split.layout,
    contentRect: () => internals.contentRect(),
    titleOf: (tabId) => internals.tab(tabId)?.toState().title ?? null,
    present: (presentation) => internals.presentOverlay(presentation),
    dismiss: () => internals.overlay.dismiss(),
    drop: (tabId, zone) => occupancy?.applyDrop(tabId, zone)
  })

  const fullscreen = new TileFullscreenController({
    split: internals.split,
    fullscreenScope: () => internals.getSettings()['splitView.fullscreenScope'],
    setFullScreenable: (allowed) => internals.setFullScreenable(allowed),
    exitWindowFullscreen: () => internals.exitWindowFullscreen(),
    toggleWindowFullscreen: () => internals.toggleWindowFullscreen(),
    enterWindowFullscreen: () => internals.enterWindowFullscreen(),
    /*
      A turn of the event loop, not a microtask.

      The question it buys time for — did this window leave fullscreen because a page gave up its own? —
      is answered by an event Electron emits from the same native stack as the one being handled, and V8
      drains microtasks between two such callbacks. A timer cannot fall in that gap.
    */
    defer: (run) => {
      setTimeout(run, 0)
    },
    askPageToExitFullscreen: (tabId) => {
      /*
        Asked rather than forced, and the failure swallowed on purpose.

        Leaving fullscreen is the page's own API; a page that has navigated away, or one whose script has been
        stopped, simply will not answer — and the tile has already left fullscreen from the browser's side, so
        there is nothing here for a caller to do about it.
      */
      liveContentsOf(internals.tab(tabId)?.view)
        ?.executeJavaScript('document.exitFullscreen?.()', true)
        .catch(() => {})
    },
    changed: () => {
      internals.relayout()
      internals.broadcast()
    }
  })

  /*
    Before `occupancy`, and that is the second ordering constraint in this file.

    The occupancy controller asks the groups one question: whether a tab is folded away, which decides
    whether it may be pulled back into a pane. That edge is satisfied directly by the construction
    order. The one below it — `shrinkTiles`, a fold asking the panes it has just emptied to go away —
    runs the other way and is therefore read through the same lazy `occupancy` as `drag`'s. It is
    reached only from `setCollapsed`, so nothing calls it during construction.

    The groups used to ask a third thing — `keepArrangement`, the tiling on its way out — and that edge
    is the defect this wiring was rebuilt for. A group was the only place a layout could be written
    down, so the tiling automation reached into the book of groups, and reaching into it meant creating
    a group and pulling loose tabs into it. Membership changed because panes moved. That edge now goes
    to `arrangements` below, whose host has no book of groups to reach (R1, R2, R3).
  */
  const groups = new TabGroupController({
    book: internals.tabGroups,
    tabOrder: () => internals.tabOrder(),
    setTabOrder: (order) => internals.setTabOrder(order),
    releaseTiles: (tabIds) => releaseTiles(internals, tabIds),
    shrinkTiles: () => occupancy?.shrinkAfterRelease(),
    activeTabId: () => internals.split.activeTabId(),
    activateTab: (tabId) => internals.activateTab(tabId),
    liveTabIds: () => internals.tabIds(),
    broadcast: () => internals.broadcast()
  })

  /*
    Between `groups` and `occupancy`, and that is the third ordering constraint — the only one where
    the dependency runs *both* ways.

    The occupancy controller asks this one to keep the tiling it is about to put away; this one asks
    the occupancy controller to put a recording back on screen. One of the two therefore has to be
    read through a closure rather than passed in, and the choice is `occupancy` — not because the
    direction demands it, but because `occupancy` is already the lazily-read one for `drag` a few
    lines above. Making the arrangement controller lazy instead would mean a second `let`, a second
    `null` to answer for and two nullable seams instead of one, to buy nothing: neither controller
    calls anything during construction, so either order is safe.

    `hiddenTabIds` is where the narrowing lives. The occupancy controller keeps its group edge —
    `isHiddenByCollapse`, just below — and this seam asks the same question of every tab to produce a
    set of ids, so hiddenness arrives at the arrangement controller as a *conclusion* about tabs
    rather than as a capability to ask about groups (KTD1).
  */
  const arrangements = new ArrangementController({
    book: internals.arrangements,
    liveTabIds: () => internals.tabIds(),
    hiddenTabIds: () => {
      const snapshot = groups.groups()
      return internals.tabIds().filter((tabId) => isTabHidden(snapshot, tabId))
    },
    currentLayout: () => internals.split.layout,
    tileTabIds: () => internals.split.toState().tileTabIds,
    applyArrangement: (layoutId, seats, activatedTabId) => {
      occupancy?.restoreArrangement(layoutId, seats, activatedTabId)
    }
  })

  occupancy = new TileOccupancyController({
    split: internals.split,
    adaptEnabled: () => internals.getSettings()['splitView.adaptLayoutToTabs'],
    tabOrder: () => internals.tabOrder(),
    isEphemeral: (tabId) => internals.tab(tabId)?.ephemeral === true,
    isHiddenByCollapse: (tabId) => groups.isHidden(tabId),
    unassign: (tabId) => internals.tab(tabId)?.setTileIndex(null),
    assignTabToTile: (tabId, tileIndex) => internals.assignTabToTile(tabId, tileIndex),
    closeTab: (tabId) => internals.closeTab(tabId),
    setActiveTile: (tileIndex) => internals.setActiveTile(tileIndex),
    openFiller: (tileIndex) => internals.openFiller(tileIndex),
    applyLayout: (layout, options) => internals.applyLayout(layout, options),
    keepTiling: () => arrangements.keep(),
    endTiling: () => arrangements.endTiling()
  })

  const audio = new TileAudioController({
    split: internals.split,
    onlyActiveAudible: () => internals.getSettings()['splitView.onlyActiveTileAudible'],
    muteAllButActive: () => internals.getSettings()['splitView.muteAllButActive'],
    setTileMuted: (tileIndex, muted) => tabInTile(internals, tileIndex)?.setMuted(muted)
  })

  /** What "not zoomed" means on this profile right now, read per call because the setting is live. */
  const defaultZoom = (): number => internals.getSettings()['appearance.defaultZoom']

  const tileInput = new TileInputController({
    tileRects: () => internals.split.tileRects(internals.contentRect()),
    viewRects: () =>
      internals.split.viewRects(
        internals.contentRect(),
        internals.getSettings()['splitView.showTileHeaders']
      ),
    activeTile: () => internals.split.activeTile,
    tileBarMode: () => internals.getSettings()['splitView.tileBarMode'],
    overlayPresentation: () => internals.overlay.presentation,
    present: (presentation) => internals.presentOverlay(presentation),
    dismissTileBar: () => internals.overlay.dismissKind('tile-bar'),
    tabIn: (tileIndex) => {
      const state = tabInTile(internals, tileIndex)?.toState()
      if (state === undefined) return null
      return {
        id: state.id,
        url: state.url,
        canGoBack: state.canGoBack,
        canGoForward: state.canGoForward,
        loading: state.loading,
        /*
          Resolved here, where the settings are, so the surface never has to know what a `null` zoom
          means. `zoomed` is that `null` turned into the only question the bar asks about it: whether
          there is anything to reset.
        */
        zoomPercent: effectiveZoomPercent(state.zoomPercent, defaultZoom()),
        zoomed: state.zoomPercent !== null && state.zoomPercent !== defaultZoom()
      }
    },
    cursor: () => cursorInWindow(internals),
    goBack: (tileIndex) => tabInTile(internals, tileIndex)?.goBack(),
    goForward: (tileIndex) => tabInTile(internals, tileIndex)?.goForward()
  })

  return { drag, fullscreen, occupancy, audio, tileInput, groups, arrangements }
}

/** The tab in a tile, or undefined for an empty one. Four seams want this and none should spell it out. */
function tabInTile(internals: WindowInternals, tileIndex: number): Tab | undefined {
  const tabId = internals.split.tabIdAt(tileIndex)
  return tabId === null ? undefined : internals.tab(tabId)
}

/**
 * Takes several tabs out of the grid at once, closing none of them, and redraws once.
 *
 * Written against the split rather than `Tab.setTileIndex(null)`, and that is the correction it exists
 * for: folding a group away used to write only the field the strip draws from and tell `SplitController`
 * nothing — so `relayout()`, which reads `split.tabIdAt`, went on showing the page with no tab left in
 * the strip to close, mute or switch away from it (KTD5). Here rather than on the window because every
 * part of it is already a projection of `WindowInternals`: the split, the layer, the tabs, one redraw.
 *
 * Plural because a group is released as a group. One redraw for the whole fold rather than one per
 * member, and no half-released grid in between for anything downstream to read.
 *
 * Answers whether any of them actually held a tile, which tells the collapse whether there is a layout
 * to shrink. Naming a tab that is already off the grid is ordinary rather than an error: the caller
 * passes every hidden member, and most folds happen with some of them already untiled.
 */
function releaseTiles(internals: WindowInternals, tabIds: readonly string[]): boolean {
  const held = tabIds.filter((tabId) => internals.split.tileOfTab(tabId) !== null)
  if (held.length === 0) return false

  // What `assignTabToTile` dismisses and for the same reason: every tile-bound surface belongs to a
  // tile whose content is about to leave. See `TILE_BOUND_KINDS`.
  for (const kind of TILE_BOUND_KINDS) internals.overlay.dismissKind(kind)
  for (const tabId of held) {
    internals.split.assignTab(tabId, null)
    internals.tab(tabId)?.setTileIndex(null)
  }
  internals.relayout()
  internals.broadcast()
  return true
}

/**
 * The cursor in the space the tile rectangles use: the window's content area, not the screen.
 *
 * `null` for a destroyed window rather than a coordinate. A gesture arriving as the window closes would
 * otherwise be resolved against stale bounds and navigate a tile that is on its way out.
 */
function cursorInWindow(internals: WindowInternals): { x: number; y: number } | null {
  if (internals.isDestroyed()) return null
  const cursor = internals.cursorScreenPoint()
  const bounds = internals.contentBounds()
  return { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
}
