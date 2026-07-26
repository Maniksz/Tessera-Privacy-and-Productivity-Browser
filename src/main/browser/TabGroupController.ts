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
 */

export interface TabGroupHost {
  /** Already bound to this window's browsing mode; a private window's discards. */
  book: TabGroupBook
  /** The strip's order, which this controller rewrites when a group needs to become contiguous. */
  tabOrder(): readonly string[]
  setTabOrder(order: readonly string[]): void
  /** Take a tab out of the grid without closing it — a collapsed group's tabs stay loaded (spec 2). */
  unassign(tabId: string): void
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
   */
  setCollapsed(id: string, collapsed: boolean): void {
    this.host.book.setCollapsed(id, collapsed)
    for (const tabId of tabsHiddenByCollapse(this.groups())) {
      this.host.unassign(tabId)
    }
    this.#settle()
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

  /**
   * Drops members this window no longer has.
   *
   * Called when a tab closes, so a group whose last member went does not linger as a chip with nothing behind
   * it.
   *
   * **Single-window only, and that is a real limit rather than a caveat.** The document is shared by every
   * normal window, and this retains only *this* window's live ids against it — so calling it per window would
   * have each window empty the other windows' groups. It used to claim to be "the reconciliation a launch
   * needs"; it is not, for any launch with two windows open.
   *
   * The launch-time reconciliation belongs to session restore, which calls `retainTabs` once with the union of
   * every id that came back. See `applySessionRestore`.
   */
  retainLiveTabs(): void {
    this.host.book.retainTabs(this.host.liveTabIds())
    this.host.broadcast()
  }

  /** Rewrites the order so every group is one run, then publishes. */
  #settle(): void {
    this.host.setTabOrder(this.displayOrder())
    this.host.broadcast()
  }
}
