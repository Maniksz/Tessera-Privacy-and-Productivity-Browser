import {
  contiguousOrder,
  isTabHidden,
  tabsHiddenByCollapse,
  type TabGroup
} from '@shared/tabgroups/model.js'
import type { TabGroupColor } from '@shared/tabgroups/palette.js'
import type { TabGroupBook } from '../data/TabGroupStore.js'

/**
 * Tab groups, from the window's side.
 *
 * The store holds the groups and the pure model decides what a legal group is; this is the part that
 * has to reconcile them with a window's two other pieces of state — the strip's order, and which tab
 * sits in which tile. Both couplings are easy to get subtly wrong and neither is visible from a unit
 * test of the model:
 *
 *   - **Order.** A group must appear as one run of tabs. Grouping the first and the last tab of five
 *     has to move something, and the window's `#tabOrder` is the only thing that knows what.
 *   - **Tiles.** Collapsing a group hides its tabs, and a hidden tab must not go on holding a tile —
 *     that tile would show a page with no tab in the strip to close, mute or switch away from.
 *
 * Behind a host seam so both can be tested without a window, which matters because they interact: a
 * collapse changes which tabs are visible, and the visible set is what the order is drawn from.
 *
 * ## There is no third coupling any more
 *
 * There used to be one, and removing it is what this controller is for. `keepArrangement` and
 * `takeArrangementFor` recorded which split layout a group's tabs sat in and put it back when one was
 * clicked — which meant the tiling automation reached in here to create groups and to absorb loose
 * tabs into groups the user had named. The recording survives; it lives on its own carrier now
 * (`ArrangementController`), which knows nothing about groups and cannot change a membership.
 *
 * So **every write in this file starts with a user action**, and that is a rule rather than an
 * accident of the current call graph. Nothing here creates, dissolves or re-members a group because
 * the tiling changed. A group outlives the split it came from: it lives until the user dissolves it
 * or its last member closes.
 */

export interface TabGroupHost {
  /** Already bound to this window's browsing mode; a private window's discards. */
  book: TabGroupBook
  /** The strip's order, which this controller rewrites when a group needs to become contiguous. */
  tabOrder(): readonly string[]
  setTabOrder(order: readonly string[]): void
  /**
   * Take these tabs out of the grid without closing any of them — a collapsed group's tabs stay
   * loaded (spec 2). Answers whether any of them held a tile at all.
   *
   * Plural, and it has to reach the split rather than the tabs. The single-tab version wrote
   * `tileIndex = null` on a `Tab` and left `SplitController` believing the tile was still occupied,
   * so a folded group's pages stayed on screen — precisely the state the docblock over `setCollapsed`
   * claims to prevent (KTD5).
   */
  releaseTiles(tabIds: readonly string[]): boolean
  /** Take away the panes the release has just emptied, without filling or closing anything (R9). */
  shrinkTiles(): void
  /** The tab in the active tile, read before the fold to decide whether R10 has anything to do. */
  activeTabId(): string | null
  /** Make a tab the active one, the way a click in the strip does. */
  activateTab(tabId: string): void
  /** Every live tab id, so a group can be told which of its members still exist. */
  liveTabIds(): readonly string[]
  /** Push the new state to the renderer. */
  broadcast(): void
}

export class TabGroupController {
  private readonly host: TabGroupHost

  constructor(host: TabGroupHost) {
    this.host = host
  }

  groups(): TabGroup[] {
    return this.host.book.list()
  }

  /**
   * The strip's order with every group's members gathered into one run.
   *
   * Derived on every read rather than stored. A group's position is decided by where its members
   * already sit, so a rank kept alongside would be a second source of ordering truth — and the two
   * would disagree the first time a tab was dragged.
   */
  displayOrder(): string[] {
    return contiguousOrder(this.host.tabOrder(), this.groups())
  }

  /** True for a tab inside a collapsed group: still loaded and running, just not drawn. */
  isHidden(tabId: string): boolean {
    return isTabHidden(this.groups(), tabId)
  }

  /**
   * Groups the given tabs, ignoring any this window does not have.
   *
   * The filtering is the part that matters, and it is here rather than in the store because this is
   * the layer that knows which tabs exist. Without it a request naming an unknown id succeeds and
   * produces a group with a phantom member: a chip that draws, that counts a tab nobody can see, and
   * that says "2 hidden" when one of the two does not exist. Found by driving the real contract.
   *
   * Unknown ids are dropped rather than refused outright, because the honest cause is a race — the
   * chrome UI took the ids from a `tabs:changed` it has already rendered, and a tab can close between
   * the render and the click. Grouping the two that are left is what the user asked for. A request
   * with *nothing* left is refused, because there is no group to make.
   */
  create(input: { tabIds: readonly string[]; name?: string; color?: TabGroupColor }): TabGroup {
    const live = new Set(this.host.liveTabIds())
    const tabIds = input.tabIds.filter((tabId) => live.has(tabId))
    if (tabIds.length === 0) {
      throw new Error('none of those tabs are in this window')
    }

    const group = this.host.book.create({
      tabIds,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.color === undefined ? {} : { color: input.color })
    })
    // Grouping tabs that were apart moves them together, so the order changes here and not only
    // when the strip is next drawn.
    this.#settle()
    return group
  }

  rename(id: string, name: string): void {
    this.host.book.rename(id, name)
    this.host.broadcast()
  }

  recolor(id: string, color: TabGroupColor): void {
    this.host.book.recolor(id, color)
    this.host.broadcast()
  }

  /**
   * Folds a group away, or opens it again.
   *
   * The tile handling is the whole reason this is not a pass-through to the store. A collapsed
   * group's tabs are hidden but still running; one that kept its tile would leave a page on screen
   * with nothing in the strip to close it, mute it or switch away from it — a pane the user cannot
   * get rid of.
   *
   * Expanding does *not* put them back. Which tile a tab should return to is not recoverable — the
   * layout may have changed, and another tab may be in that tile now — and guessing would evict
   * whatever the user has since put there. They come back as ordinary unassigned tabs, which is
   * what dragging one into a tile is for.
   *
   * The way back is not a guess and is not here: `ArrangementController` holds what the panes looked
   * like, and clicking a member is what applies it.
   *
   * ## Three steps, in this order, and each one is load-bearing
   *
   * **Release**, then **shrink**, then **activate**. The release reaches the split grid — that is the
   * whole of `releaseTiles`, and the reason it exists (KTD5). The shrink then takes the emptied panes
   * away rather than leaving them standing, which is KD7; it runs whether or not the user has layout
   * adaptation switched on, because it is undoing something the *fold* did rather than adapting to
   * anything (R9, AE10). And the activation exists because a release can leave the active tile empty:
   * `SplitController.activeTabId()` is `tabIdAt(activeTile)`, so the window would be left with no
   * active tab at all and every toolbar command would silently do nothing.
   *
   * The activation rule is narrow on purpose. Only a *previously active tab that is now hidden* moves
   * the selection, and it moves it to the first tab of the strip order the fold has not hidden. A user
   * watching a page in another pane keeps watching it — the fold is about the group, not about them —
   * and a window whose every remaining tab is hidden gets no activation, because there is nothing left
   * to activate.
   *
   * Expanding runs all three too, and all three decline: no member holds a tile, so `releaseTiles`
   * answers `false`, nothing shrinks, and no tab was hidden, so nothing is activated.
   *
   * ## Collapsing writes nothing here, and nothing to the arrangement either
   *
   * It used to be a rule with an argument behind it: a recording existed only where the *browser* took
   * the tiles away, so the user folding tabs away deliberately recorded nothing. It is now simply not
   * this controller's business — the last settle already recorded what the panes held, on a carrier
   * this file cannot reach. Expanding and clicking a member brings the panes back from a recording
   * made before the fold, not from one made by it.
   */
  setCollapsed(id: string, collapsed: boolean): void {
    // Before the fold, because releasing the tile is what makes the answer `null`.
    const wasActive = this.host.activeTabId()

    this.host.book.setCollapsed(id, collapsed)

    /*
      Every hidden tab in the window, not just this group's, and one call rather than a loop.

      Every hidden tab because the set is what must be true afterwards rather than a diff of this one
      change, and a member of another folded group that has somehow acquired a tile is a bug either
      way. One call because the grid should not be observable half-released; see `releaseTiles`.
    */
    const hidden = tabsHiddenByCollapse(this.groups())
    if (this.host.releaseTiles(hidden)) this.host.shrinkTiles()

    this.#settle()

    if (wasActive === null || !hidden.includes(wasActive)) return
    const visible = this.displayOrder().find((tabId) => !hidden.includes(tabId))
    if (visible !== undefined) this.host.activateTab(visible)
  }

  dissolve(id: string): void {
    this.host.book.dissolve(id)
    this.host.broadcast()
  }

  /** Same rule as `create`: a tab this window does not have cannot join a group. */
  addTab(groupId: string, tabId: string, index?: number): void {
    if (!this.host.liveTabIds().includes(tabId)) {
      throw new Error(`no tab ${tabId} in this window`)
    }
    this.host.book.addTab(groupId, tabId, index)
    this.#settle()
  }

  removeTab(tabId: string): void {
    this.host.book.removeTab(tabId)
    this.#settle()
  }

  /** Rewrites the order so every group is one run, then publishes. */
  #settle(): void {
    this.host.setTabOrder(this.displayOrder())
    this.host.broadcast()
  }
}
