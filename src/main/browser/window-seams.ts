import type { LayoutId, Rect } from '@shared/split/layout.js'
import { TILE_BOUND_KINDS, type OverlayPresentation } from '@shared/overlay/surface.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { effectiveZoomPercent } from '@shared/zoom/model.js'
import { groupOfTab, isTabHidden } from '@shared/tabgroups/model.js'
import { defaultArrangementView, seatedTabs } from '@shared/arrangements/model.js'
import type { DropZone } from '@shared/split/dropzones.js'
import { isStartPageTile } from '@shared/split/tile-fill.js'
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
 * finished — the window still owns them and still decides when each is asked anything. The ordering
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
    /*
      `arrangements` and `groups` are declared further down and read here only when a drop lands,
      which is a user action and so never happens during construction. See `dropTab`.
    */
    drop: (tabId, zone) => {
      if (occupancy !== null) dropTab(internals, { occupancy, arrangements, groups }, tabId, zone)
    }
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
    askPageToExitFullscreen: (tabId) => askPageToExitFullscreen(internals, tabId),
    changed: () => {
      internals.relayout()
      internals.broadcast()
    }
  })

  /*
    Before `occupancy`, and that is the second ordering constraint in this file.

    The occupancy controller asks the groups one question: whether a tab is folded away, which decides
    whether a single view may show it when its own tab closes. That edge is satisfied directly by the
    construction order. The fold used to ask the other way — `shrinkTiles`, the panes it had emptied
    taken away. That edge now goes to `arrangements` instead, because a fold puts its tiled view away
    whole (R11), and it is read through a closure for the same reason `drag` reads `occupancy`.

    The groups used to ask a third thing — `keepArrangement`, the tiling on its way out — and that edge
    is the defect this wiring was rebuilt for. A group was the only place a layout could be written
    down, so the tiling automation reached into the book of groups, and reaching into it meant creating
    a group and pulling loose tabs into it. Membership changed because panes moved. That edge now goes
    to `arrangements` below, whose host has no book of groups to reach (R1, R2, R3).
  */
  const groups: TabGroupController = new TabGroupController({
    book: internals.tabGroups,
    tabOrder: () => internals.tabOrder(),
    setTabOrder: (order) => internals.setTabOrder(order),
    /*
      `arrangements` is declared further down, and this closure is the one place that reaches it
      early. Safe for the reason every lazy edge in this file is: the fold is a user action, so
      nothing calls it during construction, and by the first call the constant exists.
    */
    releaseTiles: (tabIds) => releaseTiles(internals, () => arrangements.putAway(), tabIds),
    // Lazy for the same reason. `summaries()` reads the book and the groups, never `displayOrder`,
    // so asking for it from inside `displayOrder` cannot loop.
    arrangements: () => arrangements.summaries(),
    activeTabId: () => internals.split.activeTabId(),
    activateTab: (tabId) => internals.activateTab(tabId),
    liveTabIds: () => internals.tabIds(),
    broadcast: () => internals.broadcast()
  })

  /*
    Before `arrangements`, which puts a tiled view's tile sounds back and has them applied at once
    (KTD11). The audio controller reaches only the split and the tabs in its tiles, so nothing it
    needs is built later.
  */
  const audio = new TileAudioController({
    split: internals.split,
    onlyActiveAudible: () => internals.getSettings()['splitView.onlyActiveTileAudible'],
    muteAllButActive: () => internals.getSettings()['splitView.muteAllButActive'],
    setTileMuted: (tileIndex, muted) => tabInTile(internals, tileIndex)?.setMuted(muted)
  })

  /*
    Between `groups` and `occupancy`, and that is the third ordering constraint — one of two where the
    dependency runs *both* ways. The other is with `groups`: this one asks the groups what is hidden,
    and since U3 a fold asks this one to put its tiled view away — through a closure over the constant,
    for the reason given where `groups` is built.

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
  const arrangements: ArrangementController = new ArrangementController({
    book: internals.arrangements,
    liveTabIds: () => internals.tabIds(),
    hiddenTabIds: () => {
      const snapshot = groups.groups()
      return internals.tabIds().filter((tabId) => isTabHidden(snapshot, tabId))
    },
    currentLayout: () => internals.split.layout,
    tileTabIds: () => internals.split.toState().tileTabIds,
    currentView: () => {
      const state = internals.split.toState()
      return {
        activeTile: state.activeTile,
        fractions: state.fractions,
        tileAudio: state.tileAudio
      }
    },
    applyArrangement: (layoutId, seats, activatedTabId) => {
      occupancy?.restoreArrangement(layoutId, seats, activatedTabId)
    },
    applyView: (view) => {
      internals.split.restoreView(view, internals.contentRect())
      audio.apply()
      internals.relayout()
      internals.broadcast()
    },
    stowTiling: () => stowTiling(internals, audio),
    /*
      Through `occupancy`, read lazily for the reason `applyArrangement` is: the plan for a view that
      ends is the one the occupancy controller carries out on screen, and ending one off screen is
      the same plan without the screen (KTD12).
    */
    dissolveOffScreen: (seats) => occupancy?.dissolveOffScreen(seats)
  })

  occupancy = new TileOccupancyController({
    split: internals.split,
    adaptEnabled: () => internals.getSettings()['splitView.adaptLayoutToTabs'],
    tabOrder: () => internals.tabOrder(),
    setTabOrder: (order) => internals.setTabOrder(order),
    isEphemeral: (tabId) => internals.tab(tabId)?.ephemeral === true,
    isStartPage: (tabId) => isStartPage(internals, tabId),
    isHiddenByCollapse: (tabId) => groups.isHidden(tabId),
    /*
      Answered from the book alone, so the question carries nothing about groups to the occupancy
      controller (KTD4). Whether a folded view may come back is `restore`'s to decide, which is why
      the strip-order walk below needs no group edge either.
    */
    isArrangementMember: (tabId) => arrangements.isMember(tabId),
    restoreFirstArrangement: () => restoreFirstArrangement(internals, arrangements),
    unassign: (tabId) => internals.tab(tabId)?.setTileIndex(null),
    assignTabToTile: (tabId, tileIndex) => internals.assignTabToTile(tabId, tileIndex),
    closeTab: (tabId) => internals.closeTab(tabId),
    setActiveTile: (tileIndex) => internals.setActiveTile(tileIndex),
    openFiller: (tileIndex) => internals.openFiller(tileIndex),
    applyLayout: (layout, options) => internals.applyLayout(layout, options),
    putAway: () => arrangements.putAway(),
    endTiling: () => arrangements.endTiling()
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
        zoomed: state.zoomPercent !== null && state.zoomPercent !== defaultZoom(),
        releasable: arrangements.isMember(state.id)
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
 * Whether a tab shows the start page with nothing on its way in (KTD8), read off the tab's state.
 *
 * `url` rather than `Tab.currentUrl`, because a tab restored or discarded without a live page has
 * committed nothing and reports the address it will load: a restored start page is a start page
 * (R15), and a restored web page is not, although its committed address is still empty. A tab that
 * is gone is no start page to close.
 */
function isStartPage(internals: WindowInternals, tabId: string): boolean {
  const state = internals.tab(tabId)?.toState()
  if (state === undefined) return false
  return isStartPageTile({
    committedUrl: state.url,
    loading: state.loading,
    pendingInput: state.pendingInput
  })
}

/**
 * Asks a page to leave its own fullscreen.
 *
 * Asked rather than forced, and the failure swallowed on purpose. Leaving fullscreen is the page's own
 * API; a page that has navigated away, or one whose script has been stopped, simply will not answer —
 * and the tile has already left fullscreen from the browser's side, so there is nothing here for a
 * caller to do about it. Two seams need it: the ladder's first rung, and a tiled view being put away.
 */
function askPageToExitFullscreen(internals: WindowInternals, tabId: string): void {
  liveContentsOf(internals.tab(tabId)?.view)
    ?.executeJavaScript('document.exitFullscreen?.()', true)
    .catch(() => {})
}

/**
 * Takes a tiled view off screen: every pane emptied, the single layout, nothing closed (U2, R3).
 *
 * The window half of `ArrangementController.putAway`, which has written the view down by the time
 * this runs. The order is the point:
 *
 *   1. **A page in tile fullscreen is asked to leave it** (KTD11). The layout change below clears the
 *      split's own record of it, but the page would stay in its fullscreen state, off screen, and come
 *      back with its player still believing it fills the window.
 *   2. **Every pane is emptied first**, through `assignTabToTile`, so each tab learns it has no tile.
 *      The layout change that follows then orphans nothing, which is what keeps `afterLayoutChange`
 *      from closing a start page the browser opened as a filler — it is a member of the tiled view,
 *      and putting the view away is not ending it (R8, AE4). The same reason `workspaces:open`
 *      clears its tiles before its own layout change.
 *   3. **The single layout, without filling or pulling anything in.** Maximising ends with it.
 *   4. **The tiled view's dividers and sounds leave with it.** They are the arrangement's now, not
 *      the window's, so the single page shown next starts from the defaults rather than inheriting a
 *      muted tile from a view it was never part of.
 *
 * A window already on the single layout only has its pane emptied: there is no layout to change,
 * and the one tile's sound is the window's own, as it always was.
 */
function stowTiling(internals: WindowInternals, audio: TileAudioController): void {
  const { split } = internals
  const fullscreenTile = split.fullscreenTile
  const inFullscreen = fullscreenTile === null ? null : split.tabIdAt(fullscreenTile)
  if (inFullscreen !== null) askPageToExitFullscreen(internals, inFullscreen)

  for (const tabId of split.toState().tileTabIds) {
    if (tabId !== null) internals.assignTabToTile(tabId, null)
  }
  if (split.layout === '1x1') return

  internals.applyLayout('1x1', { fill: false, closeStartPages: false })
  split.restoreView(defaultArrangementView('1x1'), internals.contentRect())
  audio.apply()
}

/**
 * Takes a fold's tabs off the screen, closing none of them, and answers whether any was on it.
 *
 * ## A tiled view goes whole
 *
 * A split holding a folded tab is put away through `putAway` — `ArrangementController.putAway`, which
 * writes the view down as it stands and then stows it — rather than having the folded tiles emptied
 * one by one (R11, AE6). Emptying them was what this did until U3, and with the view an entry in the
 * strip it was a rewrite of that entry: the survivors were compacted into a smaller layout and the
 * next settle wrote the reduced seating in, or ended the view once fewer than two were left. Whole,
 * the view keeps its seats, its dividers, its active tile and its start pages (R8), and comes back
 * with them once the group is open and its entry is clicked. Any split, not only one showing two or
 * more tabs: a split with one folded page and empty panes beside it has nothing to keep, and putting
 * it away is still what leaves no empty pane standing, now that the fold asks for no shrink.
 *
 * Which tabs are folded is the only thing about groups that reaches here, and it arrives as ids.
 *
 * ## A single page leaves its pane
 *
 * Written against the split rather than `Tab.setTileIndex(null)`, and that is the correction this
 * function first existed for: folding a group away used to write only the field the strip draws from
 * and tell `SplitController` nothing — so `relayout()`, which reads `split.tabIdAt`, went on showing
 * the page with no tab left in the strip to close, mute or switch away from it (KTD5). One redraw,
 * and no half-released grid in between for anything downstream to read.
 *
 * Either way the screen is left empty when the answer is `true`, which is what tells the fold it has
 * a tab to give the window. Naming a tab that is already off the grid is ordinary rather than an
 * error: the caller passes every hidden member, and most folds happen with some of them untiled.
 */
function releaseTiles(
  internals: WindowInternals,
  putAway: () => void,
  tabIds: readonly string[]
): boolean {
  const held = tabIds.filter((tabId) => internals.split.tileOfTab(tabId) !== null)
  if (held.length === 0) return false
  if (internals.split.layout !== '1x1') {
    putAway()
    return true
  }

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
 * A tab dragged from the strip and let go over a tile (R9, R12, KTD4).
 *
 * The placing is the occupancy controller's (`applyDrop`); this adds the two things a drop means for
 * the tab's other memberships, which neither the occupancy controller nor the arrangement controller
 * may know about:
 *
 *   1. **It leaves the tiled view it was in**, when that is not the one on screen. A tab is in at most
 *      one view (R4), so a member of a put-away view that is dropped onto a tile is taken out of that
 *      view first — through the book, which empties its seat and ends a view left with fewer than two
 *      pages, the way a closing tab does. Without it the next settle's update of the visible view is
 *      refused for a seat held elsewhere, and the entry on screen goes stale.
 *   2. **It takes the group of the view it lands in** (R10, R12). Whatever the other pages on screen
 *      are in — the view it joins, or the page an edge drop has just made a view with — the dropped
 *      tab is put in too, or taken out of its own group when they are in none. Through the groups'
 *      own `addTab` and `removeTab`, so the strip settles in one pass. A drop that leaves a single page
 *      on screen makes no view and changes no group.
 *
 * Read off the screen rather than the book, because the book learns of the new seating only at the
 * next settle. The view's group is its first other page's, which R10 makes every page's.
 */
function dropTab(
  internals: WindowInternals,
  seams: {
    occupancy: TileOccupancyController
    arrangements: ArrangementController
    groups: TabGroupController
  },
  tabId: string,
  zone: DropZone
): void {
  const owner = internals.arrangements.list().find((held) => held.seats.includes(tabId))
  const onScreen = internals.split.tileOfTab(tabId) !== null
  if (owner !== undefined && owner.id !== seams.arrangements.liveId && !onScreen) {
    internals.arrangements.removeTab(tabId)
  }

  seams.occupancy.applyDrop(tabId, zone)

  const beside = seatedTabs(internals.split.toState().tileTabIds).filter((id) => id !== tabId)
  if (beside.length === 0) return
  const groups = seams.groups.groups()
  const target = groupOfTab(groups, beside[0]!)
  if (target?.id === groupOfTab(groups, tabId)?.id) return
  if (target === undefined) seams.groups.removeTab(tabId)
  else seams.groups.addTab(target.id, tabId)
}

/**
 * Brings back the first tiled view in strip order that may come back (KTD10).
 *
 * The last resort of a single view whose only tab closed with nothing but members and folded tabs
 * left. "First in strip order" is the view whose first member comes first in the strip, which is
 * where the strip draws its entry (KTD6). Each candidate is offered to `restore`, which refuses one
 * a collapsed group is holding or one that is not wholly this window's, and the walk goes on past a
 * refusal — so a folded view early in the strip does not leave the window blank while an open one
 * waits further along. Nothing at all is the answer when none may come back.
 */
function restoreFirstArrangement(
  internals: WindowInternals,
  arrangements: ArrangementController
): void {
  const held = internals.arrangements.list()
  const tried = new Set<string>()
  for (const tabId of internals.tabOrder()) {
    const owner = held.find((arrangement) => arrangement.seats.includes(tabId))
    if (owner === undefined || tried.has(owner.id)) continue
    tried.add(owner.id)
    arrangements.restore(owner.id)
    if (arrangements.liveId === owner.id) return
  }
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
