import { screen } from 'electron'
import type { LayoutId, Rect } from '@shared/split/layout.js'
import type { OverlayPresentation } from '@shared/overlay/surface.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { TabGroupBook } from '../data/TabGroupStore.js'
import type { SplitController } from './SplitController.js'
import type { OverlayLayer } from './OverlayLayer.js'
import type { Tab } from './Tab.js'
import { TabDragController } from './TabDragController.js'
import { TabGroupController } from './TabGroupController.js'
import { TileAudioController } from './TileAudioController.js'
import { TileFullscreenController } from './TileFullscreenController.js'
import { TileInputController } from './TileInputController.js'
import {
  TileOccupancyController,
  type LayoutChangeOptions
} from './TileOccupancyController.js'

/**
 * Builds the six controllers a window delegates to, and — the actual point — writes down what each of them is
 * allowed to reach.
 *
 * ## Why this is a file and not a hundred lines of a constructor
 *
 * Every one of these six exists because a decision was worth testing without a browser, and each is written
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
 * Not a dependency-injection container and not a lifecycle. It is called once, returns six objects, and is
 * finished — the window still owns them and still decides when each is asked anything. The two ordering
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
}

export interface WindowSeams {
  drag: TabDragController
  fullscreen: TileFullscreenController
  occupancy: TileOccupancyController
  audio: TileAudioController
  tileInput: TileInputController
  groups: TabGroupController
}

export function createWindowSeams(internals: WindowInternals): WindowSeams {
  /*
    `occupancy` is referenced by `drag` before it is assigned, which is why this is a `let` read through a
    closure rather than a value passed in.

    The drag controller's `drop` hands the zone to the occupancy controller, and the occupancy controller does
    not know about dragging at all — so the dependency runs one way and the *construction* order cannot satisfy
    it directly. Read lazily it is fine: nothing drops a tab during construction.
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
      internals
        .tab(tabId)
        ?.view.webContents.executeJavaScript('document.exitFullscreen?.()', true)
        .catch(() => {})
    },
    changed: () => {
      internals.relayout()
      internals.broadcast()
    }
  })

  /*
    Before `occupancy`, and that is the second ordering constraint in this file.

    A window showing several pages at once is a tab group, and the group is what carries which layout
    and who sits in which pane — so the occupancy controller hands `groups` the arrangement on the way
    out, at the one moment a collapse would otherwise destroy it. It asks a second question too:
    whether a tab is folded away, which decides whether it may be pulled back into a pane. The
    dependency runs one way, and unlike `drag`/`occupancy` the construction order can satisfy it
    directly: nothing here needs the occupancy controller.
  */
  const groups = new TabGroupController({
    book: internals.tabGroups,
    tabOrder: () => internals.tabOrder(),
    setTabOrder: (order) => internals.setTabOrder(order),
    unassign: (tabId) => internals.tab(tabId)?.setTileIndex(null),
    liveTabIds: () => internals.tabIds(),
    broadcast: () => internals.broadcast()
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
    keepArrangement: (layout) => groups.keepArrangement(layout)
  })

  const audio = new TileAudioController({
    split: internals.split,
    onlyActiveAudible: () => internals.getSettings()['splitView.onlyActiveTileAudible'],
    muteAllButActive: () => internals.getSettings()['splitView.muteAllButActive'],
    setTileMuted: (tileIndex, muted) => tabInTile(internals, tileIndex)?.setMuted(muted)
  })

  const tileInput = new TileInputController({
    tileRects: () => internals.split.tileRects(internals.contentRect()),
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
        loading: state.loading
      }
    },
    cursor: () => cursorInWindow(internals),
    goBack: (tileIndex) => tabInTile(internals, tileIndex)?.goBack(),
    goForward: (tileIndex) => tabInTile(internals, tileIndex)?.goForward()
  })

  return { drag, fullscreen, occupancy, audio, tileInput, groups }
}

/** The tab in a tile, or undefined for an empty one. Four seams want this and none should spell it out. */
function tabInTile(internals: WindowInternals, tileIndex: number): Tab | undefined {
  const tabId = internals.split.tabIdAt(tileIndex)
  return tabId === null ? undefined : internals.tab(tabId)
}

/**
 * The cursor in the space the tile rectangles use: the window's content area, not the screen.
 *
 * `null` for a destroyed window rather than a coordinate. A gesture arriving as the window closes would
 * otherwise be resolved against stale bounds and navigate a tile that is on its way out.
 */
function cursorInWindow(internals: WindowInternals): { x: number; y: number } | null {
  if (internals.isDestroyed()) return null
  const cursor = screen.getCursorScreenPoint()
  const bounds = internals.contentBounds()
  return { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
}
