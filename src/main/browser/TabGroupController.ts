import { resolveStripDrop, type StripDrop } from '@shared/strip/drop.js'
import { stripOrder, viewOfTab, type StripArrangement } from '@shared/strip/model.js'
import {
  findGroup,
  groupInsertionSteps,
  groupOfTab,
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
 *     that tile would show a page with no tab in the strip to close, mute or switch away from. A
 *     tiled view holding one is put away whole rather than thinned out (R11).
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
 *
 * ## A tiled view joins and leaves as one
 *
 * Every tab of a tiled view is in the same group or in none (R10, KTD4). Groups stay sets of tab
 * ids, so that is kept here rather than by a second kind of member: `create`, `addTab` and
 * `removeTab` widen a request that names one member of a view to the whole view, its members in
 * tile order and as one run. The view's members are a read of `arrangements()` — nothing here
 * changes one — and a user acting on a view or on one of its tiles is a grouping act for the whole
 * view, which is the plan's amendment to "every write starts with a user action" rather than an
 * exception to it. Ending a view, or taking one tab out of it, leaves every tab's group as it was.
 */

export interface TabGroupHost {
  /** Already bound to this window's browsing mode; a private window's discards. */
  book: TabGroupBook
  /** The strip's order, which this controller rewrites when a group needs to become contiguous. */
  tabOrder(): readonly string[]
  setTabOrder(order: readonly string[]): void
  /**
   * Take these tabs off the screen without closing any of them — a collapsed group's tabs stay
   * loaded (spec 2). Answers whether any of them was on screen, which leaves the screen empty.
   *
   * Empty because of what "off the screen" means for each shape of window. A tiled view holding one
   * of them is put away whole, with its seats and its view as they were, and the single layout left
   * empty (R11). A single page leaves the only pane there is. Either way the window needs a tab
   * afterwards, which is `setCollapsed`'s to give.
   *
   * Plural, and it has to reach the split rather than the tabs. The single-tab version wrote
   * `tileIndex = null` on a `Tab` and left `SplitController` believing the tile was still occupied,
   * so a folded group's pages stayed on screen — precisely the state the docblock over `setCollapsed`
   * claims to prevent (KTD5).
   */
  releaseTiles(tabIds: readonly string[]): boolean
  /** The tab in the active tile, read before the fold so it can take the window back after it. */
  activeTabId(): string | null
  /** Make a tab the active one, the way a click in the strip does. */
  activateTab(tabId: string): void
  /** Every live tab id, so a group can be told which of its members still exist. */
  liveTabIds(): readonly string[]
  /** Push the new state to the renderer. */
  broadcast(): void
  /**
   * This window's tiled views — `ArrangementController.summaries()` — so the strip order holds each
   * one as a run (KTD6), and so a request naming one member reaches the whole view (R10). A read of
   * the arrangements' answer, never a write to them: nothing here changes a view's membership.
   */
  arrangements(): readonly StripArrangement[]
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
   * The strip's order with every group's members gathered into one run, and every tiled view's
   * members into one run inside it (`stripOrder`, KTD6).
   *
   * Derived on every read rather than stored. A group's position is decided by where its members
   * already sit, so a rank kept alongside would be a second source of ordering truth — and the two
   * would disagree the first time a tab was dragged.
   *
   * The tiled views are the host's unless handed in: the window's broadcast round reads them once
   * after `keep()` and sends the same answer as `arrangements:changed`, rather than asking twice.
   */
  displayOrder(arrangements: readonly StripArrangement[] = this.host.arrangements()): string[] {
    return stripOrder(this.host.tabOrder(), this.groups(), arrangements)
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
    const tabIds = this.#withViews(input.tabIds.filter((tabId) => live.has(tabId))).filter(
      (tabId) => live.has(tabId)
    )
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
   * The way back is not a guess and is not here: the tiled view's entry in the strip holds what the
   * panes looked like, and clicking it is what applies it.
   *
   * ## Two steps, in this order
   *
   * **Release**, then **activate**. The release reaches the split grid — that is the whole of
   * `releaseTiles`, and the reason it exists (KTD5). A tiled view holding a folded tab is put away
   * whole: its seats, its dividers, its active tile and every start page in it stay as they were, and
   * no page moves into a pane (R8, R11, AE6). It used to release the folded members' tiles one by one
   * and shrink the layout round whatever was left, which rewrote the view — the next settle wrote the
   * reduced seating into its entry, or ended it once fewer than two were left. Now that a view is an
   * entry the user can see, a fold changing it is a membership nobody chose; `setCollapsed` reversing
   * the earlier "release only the members' tiles" rule is the plan's own (R10 replaces R9/AE10).
   *
   * The activation exists because every release leaves the screen empty, and with nothing in the
   * active tile `SplitController.activeTabId()` is `null`: every toolbar command would silently do
   * nothing. The tab that was active takes the window back if the fold did not hide it — a page the
   * user was watching beside the folded ones, in a view only partly grouped — and otherwise the first
   * tab of the strip order the fold has not hidden. A window whose every remaining tab is hidden gets
   * no activation, because there is nothing left to activate.
   *
   * Expanding runs both too, and both decline: no member holds a tile, so `releaseTiles` answers
   * `false` and nothing is activated. Nothing comes back on its own (R11).
   *
   * ## Collapsing writes nothing here
   *
   * The put-away is the arrangement controller's, on a carrier this file cannot reach, and it writes
   * the view down exactly as it stood — which is also what makes a tiling that had not settled yet
   * survive the fold instead of being lost to it.
   */
  setCollapsed(id: string, collapsed: boolean): void {
    // Before the fold, because releasing the tile is what makes the answer `null`.
    const wasActive = this.host.activeTabId()

    this.host.book.setCollapsed(id, collapsed)
    this.#settleFolded(wasActive)
  }

  dissolve(id: string): void {
    this.host.book.dissolve(id)
    this.host.broadcast()
  }

  /**
   * Same rule as `create`: a tab this window does not have cannot join a group.
   *
   * A member of a tiled view brings the whole view, in tile order and as one run starting at
   * `index` — counted, as for a single tab, among the group's members that are not moving. See
   * `#join` for why that takes two passes, and why a group holding little besides the view survives.
   */
  addTab(groupId: string, tabId: string, index?: number): void {
    if (!this.host.liveTabIds().includes(tabId)) {
      throw new Error(`no tab ${tabId} in this window`)
    }
    this.#join(groupId, this.#withViews([tabId]), index)
    this.#settle()
  }

  /** A member of a tiled view takes the whole view out with it (R10). */
  removeTab(tabId: string): void {
    for (const member of this.#withViews([tabId])) this.host.book.removeTab(member)
    this.#settle()
  }

  /**
   * A tab or a tiled view's entry let go in the strip: before or after a tab, an entry or a chip, or at
   * the end (`strip:drop`, R12, KTD7).
   *
   * `resolveStripDrop` decides where it goes and which group it is in afterwards; this writes that
   * through the store and the window's order and settles once. A drop onto a folded chip folds the
   * dropped tabs away with the group, so it ends the way a fold does: whatever of them held a tile gives
   * it up, and the window gets a tab it can still show (R11). A drop that moves nothing writes nothing
   * and publishes nothing.
   */
  dropInStrip(drop: StripDrop): void {
    const wasActive = this.host.activeTabId()
    const plan = resolveStripDrop(
      this.host.tabOrder(),
      this.groups(),
      this.host.arrangements(),
      drop
    )
    if (plan === null) return

    if (plan.groupId === null) {
      for (const tabId of plan.tabIds) {
        if (groupOfTab(this.groups(), tabId) !== undefined) this.host.book.removeTab(tabId)
      }
    } else {
      this.#join(plan.groupId, plan.tabIds, plan.index)
    }
    this.host.setTabOrder(plan.order)

    const folded =
      plan.groupId !== null && findGroup(this.groups(), plan.groupId)?.collapsed === true
    if (folded) this.#settleFolded(wasActive)
    else this.#settle()
  }

  /**
   * Puts these tabs — already widened to their views — in a group, from `index` among its members that
   * are not moving, or appended when there is no index.
   *
   * Two passes when an index is asked for, because the store places one tab at a time: a view's members
   * are first sent to the end of the group, so none of them is left standing before the index to shift
   * it, and then placed one after another from the index. The target is never emptied on the way. The
   * steps are `groupInsertionSteps`, the same ones `resolveStripDrop` plans a drop with.
   */
  #join(groupId: string, members: readonly string[], index: number | undefined): void {
    if (index === undefined) {
      for (const member of members) this.host.book.addTab(groupId, member)
      return
    }
    for (const step of groupInsertionSteps(members, index)) {
      this.host.book.addTab(groupId, step.tabId, step.index)
    }
  }

  /**
   * Settles after something was folded away: every hidden tab gives up its tile, and a window left with
   * an empty screen gets back the tab that was active if it is still visible, or the first one that is.
   *
   * Every hidden tab in the window, not just this group's, and one call rather than a loop. Every
   * hidden tab because the set is what must be true afterwards rather than a diff of this one change,
   * and a member of another folded group that has somehow acquired a tile is a bug either way. One
   * call because the grid should not be observable half-released; see `releaseTiles`.
   */
  #settleFolded(wasActive: string | null): void {
    const hidden = tabsHiddenByCollapse(this.groups())
    const cleared = this.host.releaseTiles(hidden)

    this.#settle()

    if (!cleared) return
    const stays = wasActive !== null && !hidden.includes(wasActive) ? wasActive : undefined
    const visible = stays ?? this.displayOrder().find((tabId) => !hidden.includes(tabId))
    if (visible !== undefined) this.host.activateTab(visible)
  }

  /**
   * These tabs with each one that belongs to a tiled view replaced by all of that view's members, in
   * tile order, without repeats. A tab of no view stands for itself.
   */
  #withViews(tabIds: readonly string[]): string[] {
    const views = this.host.arrangements()
    const widened = new Set<string>()
    for (const tabId of tabIds) {
      for (const member of viewOfTab(views, tabId)?.tabIds ?? [tabId]) widened.add(member)
    }
    return [...widened]
  }

  /** Rewrites the order so every group is one run, then publishes. */
  #settle(): void {
    this.host.setTabOrder(this.displayOrder())
    this.host.broadcast()
  }
}
