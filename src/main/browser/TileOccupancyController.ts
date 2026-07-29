import { emptyTiles, shrunkLayout, tabsToCloseOnShrink } from '@shared/split/tile-fill.js'
import type { DropZone } from '@shared/split/dropzones.js'
import type { LayoutId } from '@shared/split/layout.js'
import type { TabGroupLayout } from '@shared/tabgroups/model.js'
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
 * Taking the window away from an arrangement is the one thing here that loses something a user cared
 * about, so it is also the one thing here that reports what it is about to destroy: `keepArrangement`
 * hands the arrangement to a tab group on the way out and `restoreArrangement` puts it back. The tabs
 * never needed saving — they stay loaded either way — but which layout they were in and who sat where
 * did. The window keeps that up to date on every settle now (`BrowserWindowController`); the call here
 * is the one write that cannot wait for a settle, because the settle it would wait for is the collapse.
 *
 * Behind the host seam it is testable without a window, which matters because the rules interact:
 * shrinking a layout can close a tab, closing a tab can shrink a layout, and getting that wrong
 * is either an infinite loop or a pane that will not go away.
 */

/**
 * Why the layout is changing, as the two consequences that follow from it.
 *
 * Both flags answer one question — *did the user ask for this arrangement?* — and both exist because
 * the answer is no for the two changes the browser makes on its own. `fill` came first, from a
 * shrink that conjured a replacement for the tab the user had just closed. `rehome` had to join it
 * when a drop turned out to be the one caller for which moving loaded tabs into the fresh tiles is
 * wrong: it takes the room the displaced page needs. Required rather than optional, so a new caller
 * has to decide rather than inherit.
 */
export interface LayoutChangeOptions {
  /** Give a tile that is still empty a start page of its own. */
  fill: boolean
  /**
   * Move loaded-but-hidden tabs into the tiles that have nothing in them.
   *
   * Necessary and not sufficient. Both flags say what the *caller* is doing; whether the user wants
   * either of them at all is `adaptEnabled`, and the two are checked together at the call site.
   */
  rehome: boolean
}

export interface TileOccupancyHost {
  split: SplitController
  /**
   * Whether the user wants the layout to follow the tabs. Off means panes stay as they are: no tile
   * is filled, no loaded tab slides into one, and no tile goes away.
   */
  adaptEnabled(): boolean
  /** Tab-bar order, which is independent of tile assignment. */
  tabOrder(): readonly string[]
  /** True for a tab the browser opened to fill a tile and the user never navigated. */
  isEphemeral(tabId: string): boolean
  /**
   * True for a tab whose group is folded away, and therefore not one to put back into a tile.
   *
   * Named for the cause rather than for the effect, because this file already has a private
   * `#firstHiddenTab` that means something else entirely — "loaded but in no tile". See it for what
   * went wrong while both were called hidden.
   */
  isHiddenByCollapse(tabId: string): boolean
  /** Take a tab out of the grid without closing it (spec 2). */
  unassign(tabId: string): void
  assignTabToTile(tabId: string, tileIndex: number): void
  closeTab(tabId: string): void
  /** Make a tile active, with the focus, audio and reposition work that goes with it. */
  setActiveTile(tileIndex: number): void
  /** Open a start-page tab for an empty tile, marked as a filler. */
  openFiller(tileIndex: number): void
  applyLayout(layout: LayoutId, options: LayoutChangeOptions): void
  /**
   * Hand over the arrangement that is being put away, so something can keep it.
   *
   * Deliberately "here is what is about to be lost" rather than "make a group": this controller owns
   * tiles, not groups, and whether the arrangement is worth keeping and where it goes is a decision
   * about groups. See `TabGroupController.keepArrangement`.
   *
   * Kept on the seam although the window now maintains the arrangement on every settle, which would
   * make this a second write of a value that is already current. It is not removed, because the
   * settle is *scheduled* — one `setImmediate` per burst — and two IPC messages delivered in the same
   * turn of the loop ("split this window", then "new tab") would reach the collapse before the round
   * that would have written anything down. This is the only moment the arrangement still exists, and
   * in every other case the write is refused as already-current and costs a comparison.
   */
  keepArrangement(layout: TabGroupLayout): void
}

export class TileOccupancyController {
  private readonly host: TileOccupancyHost

  constructor(host: TileOccupancyHost) {
    this.host = host
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
     * The exception, and the only one.
     *
     * A filler the browser opened by itself and the user never navigated was never a tab they
     * asked for. Keeping it would leave an unused start page behind after every trip through a
     * wide layout, one renderer process each. Spec 2's protection stays in full force for every
     * tab the user actually touched.
     */
    for (const tabId of tabsToCloseOnShrink(orphaned, this.#ephemeral())) {
      this.host.closeTab(tabId)
    }

    /*
      Two questions, and rehoming needs both answered yes.

      `options.rehome` is the caller's: is this an arrangement the user asked for, or one the browser
      is passing through on the way somewhere else. `adaptEnabled` is the user's own standing answer,
      given once in the settings — and it used to be asked of `fillEmptyTiles` and not of this, which
      made "off" mean "off, unless something happens to be loaded". Filling an empty tile with a start
      page and moving a hidden page into it are the same act with a different source; a user cannot
      see which one they are about to get, so they cannot predict a switch that governs only one.

      Rejected: treating a chosen layout as consent enough and leaving this to `options.rehome` alone.
      That is what shipped, and it is defensible right until someone picks a four-tile layout with
      adaptation off and gets three pages they did not choose — "die Seiten muss man dann eben öffnen"
      is the answer to exactly that.
    */
    if (options.rehome && this.host.adaptEnabled()) this.#rehomeHiddenTabs()
    if (options.fill) this.fillEmptyTiles()
  }

  /**
   * Settles the tile a closed tab left behind.
   *
   * First choice is a tab that is loaded but not currently shown: moving it in keeps the layout
   * the user chose. Only when there is nothing left to show does the tile itself go, which is
   * what "close" means for the pane you were looking at.
   *
   * ## With adaptation off, none of it happens
   *
   * One guard at the top rather than the two further down it replaces, because both halves answer the
   * same question — what should this pane hold now that its tab has left it — and with the switch off
   * the answer is "whatever the user put there, which is nothing". The shrink already stopped here;
   * the pull-in did not, so the browser went on choosing which page appeared in the pane the user had
   * just cleared while refusing to remove the pane. Of the three possible behaviours that is the one
   * nobody could have predicted from the setting's label, and it is the one that shipped.
   *
   * The cost is real and is stated rather than hidden: the pane stays, and stays empty. Nothing
   * shrinks and nothing slides in, so putting a page back means dragging one into it. That is the
   * other half of this change — the tile bar now carries Close and Home, so emptying a pane is
   * something the user does deliberately from the tile they are looking at, and Home is what to press
   * when what they wanted was this pane *cleared* rather than gone.
   *
   * Rejected: guarding the shrink only and letting the pull-in stand, on the grounds that it changes
   * no layout and the setting is named for layouts. It moves a page between tiles unasked, which is
   * the act `#rehomeHiddenTabs` performs, one tile at a time; two identical moves obeying different
   * switches is a distinction no user can see, let alone predict.
   */
  afterTabClosed(vacatedTile: number | null): void {
    if (vacatedTile === null) return
    if (!this.host.adaptEnabled()) return

    const candidate = this.#firstHiddenTab()
    if (candidate !== undefined) {
      this.host.assignTabToTile(candidate, vacatedTile)
      return
    }

    const smaller = shrunkLayout(this.host.split.layout)
    // `fill: false` is load-bearing: filling here would immediately open a replacement for the
    // tab that was just closed, and the pane would never go away. `rehome` costs nothing either
    // way — there is no hidden tab left, or the branch above would have taken it.
    if (smaller !== null) this.host.applyLayout(smaller, { fill: false, rehome: true })
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
   *    themselves are put away, and every page in them stays loaded and stays in the strip. Choosing
   *    a layout again brings them straight back into tiles (`#rehomeHiddenTabs`).
   *
   * Two conditions narrow it, and both matter. `adaptLayoutToTabs` off means the arrangement is the
   * user's to keep, so nothing collapses and the old rule stands — an empty pane before an occupied
   * one, which is the earlier fix intact. And the collapse waits until some tile actually holds
   * something, so the layout a fresh window opens in (`splitView.defaultLayout`) is not thrown away
   * by its own first tab.
   *
   * Also the answer for a tab that is being *opened* rather than created — clicking one that has no
   * tile, which is every member of a group that was folded away. Same question, same answer.
   *
   * ## The arrangement is handed over before it goes
   *
   * "The pages stay loaded and choosing a layout again brings them back" was true and not enough: it
   * brought them back in the strip's order, into whatever layout was chosen next, so *which*
   * arrangement it had been and who sat where was gone. The panes are put away, so the arrangement is
   * handed to `keepArrangement` first — the one moment it still exists — and a group keeps it. See
   * `restoreArrangement` for the way back.
   *
   * Ordinarily the group already has it: the window writes it whenever the tiling settles, and by the
   * time a new tab is asked for the last settle has been and gone. This call is the belt-and-braces
   * one, for the burst where it has not — see `TileOccupancyHost.keepArrangement`.
   *
   * Reported, not decided, here. Whether the arrangement is worth keeping and which group takes it are
   * questions about groups; this controller does not know what a group is. Both branches that skip the
   * collapse skip the handover with it, and correctly: `adaptLayoutToTabs` off never displaces
   * anything, and a window whose tiles are all empty has no arrangement to lose.
   */
  claimTileForNewTab(): number {
    if (!this.host.adaptEnabled()) {
      return this.host.split.firstEmptyTile() ?? this.host.split.activeTile
    }
    if (this.host.split.layout !== '1x1' && this.#anyTileOccupied()) {
      this.host.keepArrangement({
        id: this.host.split.layout,
        tiles: this.host.split.toState().tileTabIds
      })
      this.host.applyLayout('1x1', { fill: false, rehome: false })
    }
    return 0
  }

  /**
   * Puts a recorded arrangement back, and makes the tab that asked for it the active one.
   *
   * The second half of `claimTileForNewTab`. Without it the recording is a memory nobody can read.
   *
   * `fill: false, rehome: false` for the same reason a drop uses them: the tiles this layout change
   * creates are about to be filled by name, from the recording, and anything moved into them first
   * would have to be evicted again — which is how a page ends up leaving the screen while a pane stands
   * empty. Every seated member is then assigned to the tile it had, and a member whose tile is `null`
   * — one that has closed since, or a tile that was empty when the arrangement was recorded — leaves
   * that tile empty rather than letting the others shift along. Coming back to a `2x2` minus one tab
   * shows the other three exactly where they were.
   *
   * Whatever was in a tile is unassigned, not closed: the new tab that caused the displacement stays
   * loaded and in the strip, which is spec 2 and also the way back — clicking it gets the window again.
   *
   * The active tile is the one holding `tabId`, tracked while seating rather than looked up afterwards,
   * so there is no "the tab I just placed is missing" branch. A tab the arrangement does not seat leaves
   * the active tile where it was; `takeArrangementFor` will not hand one over in that case, and a
   * fallback that cannot be reached is worse than one that is simply harmless.
   */
  restoreArrangement(tabId: string, layout: TabGroupLayout): void {
    if (layout.id !== this.host.split.layout) {
      this.host.applyLayout(layout.id, { fill: false, rehome: false })
    }

    let active = this.host.split.activeTile
    for (const [index, member] of layout.tiles.entries()) {
      if (member === null) continue
      this.host.assignTabToTile(member, index)
      if (member === tabId) active = index
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
        `rehome: false`, and this is the half of the middle-tile fix that is not geometry.

        Rehoming as part of the layout change fills the tile the split has just created with
        whichever loaded tab comes first in the strip. The page the drop is about to displace then
        has nowhere left to go and leaves the screen — so dropping onto a tile that already held
        something took that something away *and* left the new tile holding an unrelated tab. The
        pages are settled below instead, after the drop, when which tile is free is known.
      */
      this.host.applyLayout(zone.layout, { fill: false, rehome: false })
    }

    // Both read before the assignment moves either of them.
    const vacated = this.host.split.tileOfTab(tabId)
    const displaced = this.host.split.tabIdAt(zone.tileIndex)

    this.host.assignTabToTile(tabId, zone.tileIndex)
    if (displaced !== null && displaced !== tabId) this.#reseat(displaced, zone, vacated)
    /*
      Anything still empty takes a loaded tab if there is one, exactly as a layout change does — which
      now includes being governed by the switch, because a layout change is.

      `#reseat` above is the line between the two, and it is not a fine one. The page the drop displaced
      is moved unconditionally: the user aimed at an occupied tile, so both pages are part of the gesture
      and the browser owes them somewhere to be. This is a different thing wearing the same shape. It
      seats tabs that had nothing to do with the drag, in tiles nobody aimed at, which is the setting's
      subject exactly.

      Rejected: leaving it unguarded on the grounds that a drop is an explicit user action and everything
      following from it is therefore asked for. What was asked for is where *this* page goes. Under that
      reading, dragging one page into a `2x2` with adaptation off would seat three, two of them the
      browser's choice — and the drop would be the one way left to make the setting appear not to work.
    */
    if (this.host.adaptEnabled()) this.#rehomeHiddenTabs()
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

  #anyTileOccupied(): boolean {
    return emptyTiles(this.host.split.toState().tileTabIds).length < this.host.split.tileCount
  }

  #ephemeral(): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const tabId of this.host.tabOrder()) {
      if (this.host.isEphemeral(tabId)) ids.add(tabId)
    }
    return ids
  }

  /**
   * The first loaded tab that is off the grid and may be put back on it.
   *
   * Two different senses of "hidden" meet here, and conflating them was a bug. This method means
   * *off-screen*: loaded, running, in the strip, but in no tile. `isHiddenByCollapse` means
   * *folded away*: in a collapsed group, deliberately absent from the strip. A collapsed member is
   * off the grid too — `setCollapsed` unassigns its tile on purpose — so a plain "has no tile" test
   * finds it and seats it, which recreates exactly the state that method exists to prevent: a page
   * on screen with nothing in the strip to close it, mute it or switch away from it.
   *
   * Filtering here rather than in the two callers because both want the same thing and neither is
   * the place that knows about groups. Filtering in `tabOrder()` instead was rejected: that seam is
   * the strip's order and is also read by `#ephemeral`, where a collapsed filler still counts.
   */
  #firstHiddenTab(): string | undefined {
    return this.host
      .tabOrder()
      .find((id) => this.host.split.tileOfTab(id) === null && !this.host.isHiddenByCollapse(id))
  }

  /**
   * Moves loaded-but-hidden tabs into tiles that have nothing in them.
   *
   * No `adaptEnabled` check of its own, unlike `fillEmptyTiles`, and the asymmetry is deliberate.
   * `fillEmptyTiles` is public and called from the window, so it has to be safe alone; both callers of
   * this one are a few lines away and each had a different reason to obey the switch. A guard in here
   * would be one sentence standing in for two arguments, and the one `applyDrop` makes is the one a
   * reader of `applyDrop` has to be able to see without opening a private method.
   */
  #rehomeHiddenTabs(): void {
    for (let index = 0; index < this.host.split.tileCount; index++) {
      if (this.host.split.tabIdAt(index) !== null) continue
      const candidate = this.#firstHiddenTab()
      if (candidate === undefined) break
      this.host.assignTabToTile(candidate, index)
    }
  }
}
