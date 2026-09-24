import {
  emptyTiles,
  layoutFitting,
  orderWithRunAtEntry,
  planShrink,
  tabsToCloseOnShrink,
  type ShrinkPlan
} from '@shared/split/tile-fill.js'
import type { DropZone } from '@shared/split/dropzones.js'
import { TILE_COUNT, type LayoutId } from '@shared/split/layout.js'
import type { SplitController } from './SplitController.js'

/**
 * Keeps the tiles and the tabs in them matched.
 *
 * Three complaints turned out to be the same idea. Choosing a four-tile layout while holding one
 * tab left three panes reading "drag a tab here" — an instruction rather than a browser. Closing
 * a tab left its pane behind, empty, waiting. And a new tab took the *active* pane, so it
 * replaced whatever was in front of the user while empty panes sat beside it.
 *
 * Underneath all three: nothing owned the question "which tab belongs in which tile, and how many
 * tiles should there be". This does.
 *
 * ## The one rule everything here serves
 *
 * **A tab arriving never costs the user a page they can see, and never leaves a pane with nothing in
 * it.** Every method below is a different way of keeping that: growing a layout gives its new panes
 * something to show, shrinking one takes the pane away rather than emptying it, a drop moves the page
 * it displaces instead of pushing it off screen, and a new tab — see `claimTileForNewTab` — takes the
 * window rather than a pane, so it can do neither.
 *
 * Taking the window away from a tiling is the one thing here that loses something a user cared about,
 * so it is also the one thing here that reports what it is about to destroy: `putAway` tells the
 * arrangement controller to write down what is on screen and take the panes away, and `restoreArrangement`
 * puts a recording back. The tabs never needed saving — they stay loaded either way — but which layout
 * they were in and who sat where did. The window keeps that up to date on every settle now
 * (`BrowserWindowController`); the call here is the one write that cannot wait for a settle, because
 * the settle it would wait for is the collapse.
 *
 * ## Nothing automatic moves a tab into a pane (U3)
 *
 * Three paths here used to seat a loaded tab that had no pane: a closed tab's pane took the first
 * one, a chosen layout took them before opening start pages, and a drop filled the tiles nobody
 * aimed at. That was economy while a tiled view was invisible — a loaded page is cheaper than a new
 * one. It stopped being economy when every tiled view became an entry in the strip: a loaded tab is
 * now an ordinary tab where the user left it or a member of another view, and moving it into a pane
 * takes it out of its place without anyone asking (R16, KTD10). So every writer of a seat has one
 * rule, and a tab reaches a pane only because the user put it there, because it is a start page the
 * browser opened for a pane of its own, or — once, for a single view whose only tab closed — because
 * the window would otherwise show nothing at all (`afterTabClosed`).
 *
 * Behind the host seam it is testable without a window, which matters because the rules interact:
 * shrinking a layout can close a tab, closing a tab can shrink a layout, and getting that wrong
 * is either an infinite loop or a pane that will not go away.
 */

/**
 * Why the layout is changing, as the consequences that follow from it.
 *
 * `fill` answers *did the user ask for this arrangement?*, and it exists because the answer is no for
 * every change the browser makes on its own — it came from a shrink that conjured a replacement for
 * the tab the user had just closed. Required rather than optional, so a new caller has to decide
 * rather than inherit. Whether the user wants filling at all is `adaptEnabled`, checked in
 * `fillEmptyTiles`.
 *
 * `closeStartPages` answers *is the user changing or ending this tiled view?* (R8, KTD8). Then a start
 * page that loses its tile closes, whoever opened it; every other change leaves it standing, because
 * putting a view away, folding its group or closing one of its tabs is not a decision about its
 * panes, and a start page in it is a member like any page (AE4). True only from `chooseLayout` —
 * and, through it, from the entry's menu — which also arranges for every start page to be among the
 * tabs the change takes off the grid. Required for the same reason `fill` is.
 *
 * There used to be a flag, `rehome`, for moving loaded tabs into the empty tiles. It went with the
 * act it switched (U3, KTD10): with nothing left to switch, a flag every caller must still set would
 * be a decision with no consequence, and the next reader would look for the one.
 */
export interface LayoutChangeOptions {
  /** Give a tile that is still empty a start page of its own. */
  fill: boolean
  /** Close a tab showing the start page when it loses its tile (`isStartPageTile`). */
  closeStartPages: boolean
}

/** What every layout the browser changes on its way to something else asks for: nothing more. */
const INCIDENTAL: LayoutChangeOptions = { fill: false, closeStartPages: false }

export interface TileOccupancyHost {
  split: SplitController
  /**
   * Whether the user wants the layout to follow the tabs. Off means panes stay as they are: no tile
   * is filled, no loaded tab slides into one, and no tile goes away.
   */
  adaptEnabled(): boolean
  /** Tab-bar order, which is independent of tile assignment. */
  tabOrder(): readonly string[]
  /**
   * Rewrites the strip order, for the pages of a tiled view that changed or ended: they stand where
   * its entry stood, in tile order (R8). The only reorder this controller makes.
   */
  setTabOrder(order: readonly string[]): void
  /** True for a tab the browser opened to fill a tile and the user never navigated. */
  isEphemeral(tabId: string): boolean
  /**
   * True for a tab showing the start page with nothing on its way in (`isStartPageTile`, KTD8).
   *
   * Beside `isEphemeral` and wider than it: that one is the browser's own untouched filler, this one
   * is any start page, whoever opened it. Changing or ending a tiled view closes these (R8).
   */
  isStartPage(tabId: string): boolean
  /**
   * True for a tab whose group is folded away, and therefore not one to put back into a tile.
   *
   * Named for the cause rather than for the effect, because "hidden" in this file used to mean
   * something else entirely — "loaded but in no tile", the old name of `#firstLooseTab`. See it for
   * what went wrong while both were called hidden.
   */
  isHiddenByCollapse(tabId: string): boolean
  /**
   * True for a tab that belongs to a tiled view, on screen or put away (KTD4).
   *
   * The question every automatic seat now asks before it chooses a page, and deliberately about the
   * view rather than about anything a view might be grouped with: `window-seams.ts` answers it from
   * the book of arrangements alone. A member standing alone in a pane would be a page on screen
   * whose entry in the strip claims it for a tiling that is not there (KTD10).
   */
  isArrangementMember(tabId: string): boolean
  /**
   * Bring back the first tiled view in strip order that may come back, with its last active tile.
   *
   * The last resort of a single view whose only tab has closed and whose every other tab is either
   * folded away or a member (KTD10). The whole view rather than one of its members, for the reason
   * `isArrangementMember` gives. Which view is first is the strip's order, which this controller
   * holds only as tab ids; which of them may come back is `ArrangementController.restore`'s to say.
   */
  restoreFirstArrangement(): void
  /** Take a tab out of the grid without closing it (spec 2). */
  unassign(tabId: string): void
  assignTabToTile(tabId: string, tileIndex: number | null): void
  closeTab(tabId: string): void
  /** Make a tile active, with the focus, audio and reposition work that goes with it. */
  setActiveTile(tileIndex: number): void
  /** Open a start-page tab for an empty tile, marked as a filler. */
  openFiller(tileIndex: number): void
  applyLayout(layout: LayoutId, options: LayoutChangeOptions): void
  /**
   * Put the tiled view on screen away, because it is about to stop being on screen (R3).
   *
   * Deliberately "now is the moment" rather than "here is the arrangement": the reader of the tiling
   * is `ArrangementController.putAway`, which takes the layout, the seating and the view off the
   * same split controller this one holds, so passing them would be handing over a copy of what the
   * other side is looking at. It writes the view down first — the one moment it still exists, in a
   * burst too fast for the scheduled round — and then empties every pane and falls back to the
   * single layout, closing nothing (R8). The one pane left is empty, for whoever asked.
   *
   * It used to be `keepTiling`, which only wrote the tiling down and left the layout change to this
   * controller, and before that `keepArrangement(layout)`, which went to a tab group. That is the
   * defect the rebuild removed: a group was the only place a layout could be stored, so this call
   * created groups and pulled loose tabs into them (R1, R3). Nothing about a group is reachable from
   * here any more, by way of `window-seams.ts` rather than by way of care. The layout change moved
   * behind the seam in U2 because putting a view away is more than a layout change — its panes are
   * emptied first, so a start page in it is not orphaned and closed on the way — and the same
   * sequence is what bringing another view back and opening a workspace need.
   */
  putAway(): void
  /**
   * Forget the tiling that is on screen, because the user is putting it down for a single page.
   *
   * `putAway`'s opposite, and called at the same moment for the same reason: *before*
   * `applyLayout`, while the seating still names every pane. Reached only from `chooseLayout`, which
   * says why a chosen single layout is the one change that ends a tiling instead of putting it away.
   */
  endTiling(): void
}

/** What the user's own choice of layout asks for: its empty tiles filled, its start pages closed. */
const CHOSEN: LayoutChangeOptions = { fill: true, closeStartPages: true }

export class TileOccupancyController {
  private readonly host: TileOccupancyHost

  constructor(host: TileOccupancyHost) {
    this.host = host
  }

  /**
   * The layout the user picked, from the layout menu, its accelerator or the entry's menu.
   *
   * The one explicit layout change there is, and therefore the only one that fills — a layout the user
   * picked gets its empty tiles filled with start pages, and only with them: a loaded tab moving in
   * would be a tab leaving its place in the strip, or its tiled view, unasked (KTD10). Every other
   * route to `applyLayout` is the browser changing the layout on its way to something else: a shrink
   * after a close, a drop, a new tab taking the window. Filling those would conjure a replacement for
   * the very tab that was just closed, or open pages nobody asked for alongside a page somebody did.
   *
   * ## Fewer tiles: start pages go first (R8, KTD8)
   *
   * A choice with fewer tiles than the window has is a change to the tiled view on screen, and one
   * with a single tile ends it. Either way `planShrink` says what happens, in its order: every start
   * page closes, the other pages move up in tile order, and the layout is the smallest that fits them
   * — so a 2x2 of two start pages and two pages becomes those two pages side by side (AE2). A page that
   * finds no tile is an ordinary tab right behind the entry, and fewer than two pages left is no
   * tiled view at all. It used to be index arithmetic: whatever sat past the new tile count left the
   * grid, a page after an empty pane among them, and a start page with it stayed a member.
   *
   * A choice with as many tiles or more closes nothing. It is a reshaping or a growth, and the start
   * pages in it are panes the user still has.
   *
   * ## Choosing the single layout ends the tiling
   *
   * Every other way to one pane puts the tiling away and keeps the way back: clicking a page that was
   * beside the one left on screen brings the panes back (R7). Choosing "single" is the user saying the
   * panes are done, and keeping the way back would undo that at the next click. So the tiling on screen
   * is forgotten first — see `ArrangementController.endTiling` for what goes and what is spared — and
   * then the layout changes, the same as for a smaller split that is left with one page. No tab group
   * changes: a group the user made is theirs and outlives this like any other layout change (R2).
   *
   * A smaller split needs no such step: it is the same tiled view with fewer tiles, and the settle
   * after it writes the new seating into the same entry, under its id (KTD2). Re-choosing `1x1` in a
   * window already showing one page closes nothing and ends nothing — its seating shares no tab with
   * a tiling put away earlier, which keeps its way back.
   */
  chooseLayout(layout: LayoutId): void {
    if (TILE_COUNT[layout] < this.host.split.tileCount) {
      this.#shrinkChosen(layout)
      return
    }
    if (layout === '1x1') this.host.endTiling()
    this.host.applyLayout(layout, CHOSEN)
  }

  /**
   * Ends a tiled view that is not on screen: its start pages close, and the rest become ordinary tabs
   * where its entry stood, in tile order (KTD12).
   *
   * The half of "Kachelansicht beenden" on a put-away entry that is about tabs. The other half — the
   * entry forgotten, before any tab moves — is `ArrangementController.endArrangement`, which calls
   * this with the seats it held. The same plan as ending the view on screen, over the stored seats
   * and without a screen: nothing is seated, so the visible view and the active tab are what they
   * were, and a start page closing leaves no pane behind for `afterTabClosed` to settle.
   */
  dissolveOffScreen(seats: ReadonlyArray<string | null>): void {
    const plan = planShrink(seats, (tabId) => this.host.isStartPage(tabId), '1x1')
    this.#standAtEntry(plan)
    for (const tabId of plan.close) this.host.closeTab(tabId)
  }

  /**
   * Settles who lives where after the layout changed.
   *
   * `orphaned` are the tabs whose tile no longer exists. They stay loaded and stay in the tab
   * strip, which spec 2 requires — with exactly one exception, below.
   */
  afterLayoutChange(orphaned: readonly string[], options: LayoutChangeOptions): void {
    for (const tabId of orphaned) this.host.unassign(tabId)

    /**
     * The exceptions, and the only ones.
     *
     * A filler the browser opened by itself and the user never navigated was never a tab they
     * asked for. Keeping it would leave an unused start page behind after every trip through a
     * wide layout, one renderer process each. Spec 2's protection stays in full force for every
     * tab the user actually touched.
     *
     * The second is the user's own decision about the panes: a change that closes start pages
     * (`closeStartPages`, R8) closes every one it takes off the grid, whoever opened it.
     */
    const disposable = this.#ephemeral()
    if (options.closeStartPages) {
      for (const tabId of orphaned) if (this.host.isStartPage(tabId)) disposable.add(tabId)
    }
    for (const tabId of tabsToCloseOnShrink(orphaned, disposable)) {
      this.host.closeTab(tabId)
    }

    if (options.fill) this.fillEmptyTiles()
  }

  /**
   * Settles the tile a closed tab left behind (KTD10).
   *
   * ## A tiled view closes its ranks
   *
   * The pages after the gap move up one tile each, and the layout steps down the shrink chain as far
   * as the pages left need. Nothing comes in from outside. It used to: the first loaded tab with no
   * pane moved into the gap, and the pane went only when there was none. That kept the layout the user
   * chose, and it was the whole reason a closed tab's pane "healed". With every tiled view an entry in
   * the strip it is a page leaving its place unasked — an ordinary tab vanishing from the strip into a
   * view, or a member of another view moving into this one (R16, AE7). Closing ranks keeps what the
   * user can see and changes only how much room it takes.
   *
   * As far as needed rather than one step, because one step leaned on the pull-in. A seat whose tab
   * closed while the view was put away comes back as an empty pane, and the pull-in used to fill it at
   * the next close; without it, one step would leave that pane standing for good. The chain is the
   * same one (`shrunkLayout`), so a row stays a row. Compacting first is what makes it safe: no page
   * falls off the end, so no start page among them is swept up by `afterLayoutChange` — closing one tab
   * closes no other (R8).
   *
   * With adaptation off none of it happens, and the pane stays empty. The switch governs the browser
   * reshaping the panes, and closing ranks is exactly that; the user clears or refills the pane
   * deliberately from the tile bar, which carries Close and Home for this.
   *
   * ## A single view shows a page, never a lone member
   *
   * One pane whose only tab closed is the one place a page is still chosen, because the alternative is
   * a window showing nothing with a full strip beside it — a toolbar acting on nothing, which is what
   * the window's own "always keep a tab" rule exists to prevent. So it applies with adaptation off too:
   * no layout changes, one pane before and one after (KTD9).
   *
   * What may be chosen is the narrow part: the first tab in strip order that is neither folded away nor
   * a member of a tiled view. A member alone on screen would be a page whose entry claims it for a
   * tiling that is not there. Only when nothing else is left does a view come back, and then whole —
   * the first one in strip order, through `restoreFirstArrangement`. The same rule closes a split
   * whose ranks have just come down to one empty pane: it is the same window with nothing on it.
   */
  afterTabClosed(vacatedTile: number | null): void {
    if (vacatedTile === null) return
    if (this.host.split.layout !== '1x1') {
      if (!this.host.adaptEnabled()) return
      this.#closeRanks()
    }
    // Read again rather than assumed: closing ranks may have come down to one pane, or not.
    if (this.host.split.layout !== '1x1' || this.host.split.tabIdAt(0) !== null) return

    const loose = this.#firstLooseTab()
    if (loose === undefined) this.host.restoreFirstArrangement()
    else this.host.assignTabToTile(loose, 0)
  }

  /**
   * Gives every still-empty tile a tab of its own.
   *
   * Only for a layout the user chose — which, since a new tab no longer moves into a pane, is now
   * exactly one caller: `setLayout`. A layout the browser shrank into, or one a drop or a new tab
   * changed on the way to somewhere else, must not be refilled.
   */
  fillEmptyTiles(): void {
    if (!this.host.adaptEnabled()) return
    for (const index of emptyTiles(this.host.split.toState().tileTabIds)) {
      this.host.openFiller(index)
    }
  }

  /**
   * The tile a tab that is not in the grid should take — which usually means putting the grid away.
   *
   * ## A new tab is a new tab
   *
   * It gets the window, not a pane. This reverses an earlier decision on purpose, and the earlier
   * decision was not wrong about anything: a new tab used to take the *active* pane, so it replaced
   * the page in front of the user, and giving it an empty pane instead fixed that. But a tab that
   * lands in a quarter of the window is not what "new tab" means anywhere else in a browser, and
   * asking for one is not asking to keep the arrangement you were in.
   *
   * So the layout goes back to a single tile and the tab takes it. That is what keeps both halves of
   * what the earlier fix bought:
   *
   *  - **No pane is left reading "drag a tab here."** A tab arriving cannot create an empty pane,
   *    because it removes the panes instead of moving into one. Choosing a multi-tile layout still
   *    fills every empty pane it creates — that path is untouched, and it is now the only one that
   *    fills.
   *  - **No page the user is looking at is taken away.** Nothing is evicted from a pane; the panes
   *    themselves are put away, and every page in them stays loaded, stays a member of its view and
   *    comes back with it when its entry is clicked.
   *
   * ## Whatever `adaptLayoutToTabs` says (KTD9)
   *
   * The switch used to stop the collapse: off meant the arrangement was the user's to keep, and the
   * new tab took the first empty pane, or the active one when every pane was taken. That made a tiled
   * view the one thing a tab could join without being asked, and the second half of it replaced the
   * page in front of the user outright — the failure the earlier fix was written against. With the
   * view an entry in the strip, a tab slipping into it is a membership nobody chose (R3). So the view
   * is put away either way, and the switch keeps what it is named for: whether the browser fills new
   * panes with start pages and closes ranks after a close.
   *
   * One condition narrows it: the collapse waits until some tile actually holds something, so the
   * layout a fresh window opens in (`splitView.defaultLayout`) is not thrown away by its own first tab.
   *
   * Also the answer for a tab that is being *opened* rather than created — clicking one that has no
   * tile, which is every member of a group that was folded away. Same question, same answer.
   *
   * ## The tiling is written down before it goes
   *
   * "The pages stay loaded and choosing a layout again brings them back" was true and not enough: it
   * brought them back in the strip's order, into whatever layout was chosen next, so *which*
   * arrangement it had been and who sat where was gone. The panes are put away through `putAway`,
   * which writes the view down first — the one moment it still exists — and keeps its entry in the
   * strip (R3). See `restoreArrangement` for the way back.
   *
   * Ordinarily it is already recorded: the window writes it whenever the tiling settles, and by the
   * time a new tab is asked for the last settle has been and gone. The write in `putAway` is the
   * belt-and-braces one, for the burst where it has not — see `TileOccupancyHost.putAway`.
   *
   * Reported, not decided, here. Whether the tiling is worth recording is the arrangement model's
   * question. The two cases that skip the collapse skip the report with it, and correctly: a single
   * view has no tiling to lose, and neither has a window whose tiles are all empty.
   */
  claimTileForNewTab(): number {
    if (this.host.split.layout !== '1x1' && this.#anyTileOccupied()) this.host.putAway()
    return 0
  }

  /**
   * Puts a recorded arrangement back, and makes the tab that asked for it the active one.
   *
   * The second half of `claimTileForNewTab`. Without it the recording is a memory nobody can read.
   * Called from `ArrangementController.restoreFor` through `ArrangementHost.applyArrangement`, whose
   * three arguments are these three: the layout, the seating, and which tab the click was on.
   *
   * `fill: false` for the same reason a drop uses it: the tiles this layout change creates are about
   * to be filled by name, from the recording, and anything opened in them first would have to be
   * evicted again — which is how a page ends up leaving the screen while a pane stands
   * empty. Every seated tab is then assigned to the tile it had, and a seat that is `null` — a tab that
   * has closed since, or a tile that was empty when the tiling was recorded — leaves that tile empty
   * rather than letting the others shift along. Coming back to a `2x2` minus one tab shows the other
   * three exactly where they were.
   *
   * Whatever was in a tile is unassigned, not closed: the new tab that caused the displacement stays
   * loaded and in the strip, which is spec 2 and also the way back — clicking it gets the window again.
   *
   * The active tile is the one holding `activatedTabId`, tracked while seating rather than looked up
   * afterwards, so there is no "the tab I just placed is missing" branch. A recording that does not
   * seat it leaves the active tile where it was; `arrangementOfTab` will not hand such a recording
   * over, and a fallback that cannot be reached is worse than one that is simply harmless.
   *
   * ## Whole or nothing, and why that guard is here as well as in the model
   *
   * A recording seating a tab a collapsed group is hiding is not applied at all (R14, KD8). Seating
   * the visible ones would put a page on screen with nothing in the strip to close it — the very
   * state `setCollapsed` clears tiles to prevent — and would leave a tiling that never matches the
   * recording, so the next click would apply the same one again.
   *
   * `arrangementOfTab` refuses such a recording too, and the duplication is deliberate rather than
   * defensive habit. Until this rebuild the protection was a side effect of a recording belonging to
   * exactly one group: `sanitisedLayout` dropped any tab the group did not have, and a collapsed
   * group's own tabs could not be reached because the group carried the layout. A recording that
   * belongs to no group has neither guarantee, and this method has a caller — `applyArrangement` —
   * that any future controller could reach without going through the model.
   */
  restoreArrangement(
    layoutId: LayoutId,
    seats: ReadonlyArray<string | null>,
    activatedTabId: string
  ): void {
    if (seats.some((tabId) => tabId !== null && this.host.isHiddenByCollapse(tabId))) return

    if (layoutId !== this.host.split.layout) {
      this.host.applyLayout(layoutId, INCIDENTAL)
    }

    let active = this.host.split.activeTile
    for (const [index, seated] of seats.entries()) {
      if (seated === null) continue
      this.host.assignTabToTile(seated, index)
      if (seated === activatedTabId) active = index
    }

    // The window's own method, so focus, audio and geometry settle the way they do for a click into a
    // tile — the same reason `applyDrop` ends here.
    this.host.setActiveTile(active)
  }

  /** Where a completed drop puts the tab, including a layout change if the zone asks for one. */
  applyDrop(tabId: string, zone: DropZone): void {
    // Layout first: the tile the indicator promised is named in the arrangement the zone switches
    // to, and in the one the window is still in it may not exist yet.
    if (zone.layout !== null && zone.layout !== this.host.split.layout) {
      /*
        `fill: false`: the tile the split creates is the room the displaced page needs, and a start
        page opened into it would push that page off the screen. The pages are settled below,
        after the drop, when which tile is free is known — the half of the middle-tile fix that is
        not geometry, which used to be a second flag against pulling a loaded tab in here as well.
      */
      this.host.applyLayout(zone.layout, INCIDENTAL)
    }

    // Both read before the assignment moves either of them.
    const vacated = this.host.split.tileOfTab(tabId)
    const displaced = this.host.split.tabIdAt(zone.tileIndex)

    this.host.assignTabToTile(tabId, zone.tileIndex)
    /*
      Two pages are part of the gesture, and only two: the one dragged and the one it displaced. The
      user aimed at an occupied tile, so the browser owes the displaced page somewhere to be, and
      `#reseat` finds it. Anything still empty afterwards stays empty, with adaptation on or off.

      It used to take a loaded tab when the switch was on, exactly as a layout change did. That seated
      tabs that had nothing to do with the drag, in tiles nobody aimed at, and with every tiled view an
      entry in the strip each of them was a tab leaving its place — an ordinary one, or a member of
      another view — for a view it never joined (R16, KTD10). A drop is an explicit action, and what
      was asked for is where *this* page goes.
    */
    if (displaced !== null && displaced !== tabId) this.#reseat(displaced, zone, vacated)
    // The window's own method, so the drop lands with focus, audio and layout settled — the
    // same path a user clicking into the tile would take.
    this.host.setActiveTile(zone.tileIndex)
  }

  // --- internals -----------------------------------------------------------

  /**
   * Where the page that was in the target tile goes.
   *
   * Never off the screen, which is what used to happen: `assignTabToTile` unassigns whoever occupied
   * the tile, so a drop that had just *created* a tile cost the user a page and gave them an empty
   * pane in the same gesture. Eighteen of the twenty-four split zones did it, and the middle column
   * of a three-column row was the one where both of its own bands did.
   *
   * Two shapes of growth, and they need different answers because they are different things. A
   * vertical edge grows a *row*: a column is inserted, so the columns from there rightwards move
   * along one and their pages move with them. Everything else subdivides a tile or replaces one, and
   * then a single page moves — into the tile the dragged page just vacated, or, when it came from no
   * tile at all, into whichever tile is free, which is the one the split created.
   *
   * Either way the displaced page keeps a seat in the view, so the settle after the drop writes it
   * into the same entry and it stays a member (R16). Only when there is no room left does it leave
   * the grid, and then it is an ordinary tab in the strip — the one outcome in which a drop takes a
   * page off the screen, and a page nobody else is made to give up a tile for.
   */
  #reseat(displaced: string, zone: DropZone, vacated: number | null): void {
    if (zone.kind === 'left' || zone.kind === 'right') {
      this.#shiftAlong(zone.tileIndex, displaced)
      return
    }
    const room = vacated ?? this.host.split.firstEmptyTile()
    if (room !== null) this.host.assignTabToTile(displaced, room)
  }

  /**
   * Moves every page from `tileIndex` one tile along, carrying the one each step pushes out.
   *
   * Stops at the first tile that was empty, which in a row that has just grown a column is the new
   * one. A page still in hand past the last tile has left the grid — `assignTabToTile` has already
   * unassigned it — and stays loaded and in the strip, which is what spec 2 requires.
   */
  #shiftAlong(tileIndex: number, pushed: string): void {
    let carried: string | null = pushed
    for (
      let index = tileIndex + 1;
      index < this.host.split.tileCount && carried !== null;
      index++
    ) {
      const next = this.host.split.tabIdAt(index)
      this.host.assignTabToTile(carried, index)
      carried = next
    }
  }

  /**
   * Carries out `planShrink` for the view on screen, for a choice of fewer tiles (R8).
   *
   * The plan's order is the logical one — start pages close, pages move up, the layout shrinks — and
   * the order here is the one that keeps every step from costing something else:
   *
   *  1. **The view is ended first**, when the plan ends it, while the seating still names every pane:
   *     afterwards it names one page, and the entry would outlive the tiling (`endTiling`).
   *  2. **The pages stand where the entry stood** in the strip, in tile order, before any of them
   *     moves (`orderWithRunAtEntry`).
   *  3. **Every page moves to its tile, and everything else behind them**: the pages that stay in the
   *     leading tiles, then the pages that find none, then the start pages. The layout change then
   *     takes exactly those off the grid, and `closeStartPages` closes the start pages among them —
   *     unassigned before they close, so no close leaves a pane behind for `afterTabClosed` to settle.
   *  4. **The one start page a single pane cannot take off the grid** is the one left in tile 0 when
   *     no page survives. It closes last, as the tab in that pane, and the window's own rules decide
   *     what the pane shows next: the next ordinary tab, another tiled view, or — for a window with
   *     nothing else — a fresh start tab (`afterTabClosed`, `keepOneTab`).
   *  5. **The active page is made active** in its new tile, by the window's own method.
   */
  #shrinkChosen(target: LayoutId): void {
    const { split } = this.host
    const plan = planShrink(
      split.toState().tileTabIds,
      (tabId) => this.host.isStartPage(tabId),
      target,
      split.activeTabId()
    )
    if (plan.layout === '1x1') this.host.endTiling()
    this.#standAtEntry(plan)

    const placement = [...plan.seats, ...plan.freed, ...plan.close]
    for (const [index, tabId] of placement.entries()) {
      if (split.tileOfTab(tabId) !== index) this.host.assignTabToTile(tabId, index)
    }
    this.host.applyLayout(plan.layout, CHOSEN)

    for (const tabId of plan.close) {
      if (split.tileOfTab(tabId) !== null) this.host.closeTab(tabId)
    }
    const tile = plan.active === null ? null : split.tileOfTab(plan.active)
    if (tile !== null) this.host.setActiveTile(tile)
  }

  /** The pages a plan keeps, where the view's entry stood in the strip, in tile order (R8). */
  #standAtEntry(plan: ShrinkPlan): void {
    const members = [...plan.close, ...plan.remaining]
    this.host.setTabOrder(orderWithRunAtEntry(this.host.tabOrder(), members, plan.remaining))
  }

  #anyTileOccupied(): boolean {
    return emptyTiles(this.host.split.toState().tileTabIds).length < this.host.split.tileCount
  }

  #ephemeral(): Set<string> {
    const ids = new Set<string>()
    for (const tabId of this.host.tabOrder()) {
      if (this.host.isEphemeral(tabId)) ids.add(tabId)
    }
    return ids
  }

  /**
   * Closes the ranks of a tiled view a tab has just left: every page moves up to the leading tiles
   * in tile order, and the layout steps down as far as the pages left need (KTD10).
   *
   * Compacting before the layout changes is what keeps it from costing anything. `applyLayout` hands
   * every tab past the new tile count to `afterLayoutChange`, which closes the browser's own untouched
   * fillers among them; with the survivors moved down first nothing is past the end, so no start page
   * is swept up by a close that was about another tab (R8). It is also the only way the survivors keep
   * a tile at all: a `1x3` losing its first page would otherwise drop the third off the end of the grid.
   *
   * `fill: false` because a replacement for the page that just closed is exactly what must not appear,
   * and `closeStartPages: false` because closing one tab is not a decision about the others (R8).
   *
   * The active tile follows the tab that was in it, because compacting moves tabs between tiles and
   * the active *tile* index would otherwise land on whoever shifted into it. When the closed tab was
   * the active one there is nothing to follow, and the tile index stays — which puts the focus on the
   * page that moved up into it, the neighbour the strip would pick too.
   *
   * This was the shrink a folded group asked for (`shrinkAfterRelease`). A fold now puts its tiled view
   * away whole (R11), so the one caller left is a closed tab, and the method went private with it.
   */
  #closeRanks(): void {
    const occupants = this.host.split
      .toState()
      .tileTabIds.filter((tabId): tabId is string => tabId !== null)
    const stayActive = this.host.split.activeTabId()

    for (const [index, tabId] of occupants.entries()) {
      if (this.host.split.tileOfTab(tabId) !== index) this.host.assignTabToTile(tabId, index)
    }

    const target = layoutFitting(this.host.split.layout, occupants.length)
    if (target !== this.host.split.layout) this.host.applyLayout(target, INCIDENTAL)

    if (stayActive === null) return
    const tile = this.host.split.tileOfTab(stayActive)
    if (tile !== null) this.host.setActiveTile(tile)
  }

  /**
   * The first tab in strip order that a single view may show when its own tab has closed (KTD10).
   *
   * Three things rule a tab out, and each is a separate sense of "not this one". **It has a tile**:
   * then it is on screen already. **It is folded away** (`isHiddenByCollapse`): a page on screen with
   * nothing in the strip to close it, mute it or switch away from it is the state a fold exists to
   * prevent — and the one this method's predecessor recreated, because "has no tile" was its whole
   * test and a folded member has no tile on purpose. **It is a member of a tiled view**
   * (`isArrangementMember`): alone on screen it would be a page whose entry claims it for a tiling
   * that is not there, and seating it would make the next settle read one page as that view.
   *
   * Filtering here rather than in `tabOrder()` because that seam is the strip's order and is also read
   * by `#ephemeral`, where a folded filler or a member still counts.
   */
  #firstLooseTab(): string | undefined {
    return this.host
      .tabOrder()
      .find(
        (id) =>
          this.host.split.tileOfTab(id) === null &&
          !this.host.isHiddenByCollapse(id) &&
          !this.host.isArrangementMember(id)
      )
  }
}
