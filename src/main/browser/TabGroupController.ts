import {
  arrangedTabs,
  arrangementIsCurrent,
  contiguousOrder,
  groupToHoldArrangement,
  isTabHidden,
  tabsHiddenByCollapse,
  tabsToAbsorb,
  type TabGroup,
  type TabGroupLayout
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
 * ## The third coupling: the arrangement a multi-view is
 *
 * `keepArrangement` and `takeArrangementFor` are the two ends of one feature — a window showing
 * several pages at once is a tab group, and getting back to it is clicking one of its tabs. The split
 * controller knows *what* the arrangement is and nothing about groups; the store knows about groups
 * and nothing about tiles. This is where they meet, and the decisions themselves are pure functions
 * (`groupToHoldArrangement`, `arrangementIsCurrent`) so the interesting cases can be checked without
 * either.
 *
 * **Nothing here dissolves a group because the tiling shrank, and that is a rule rather than an
 * omission.** A group outlives the split it came from: it lives until the user dissolves it or its
 * last member closes. Tying its lifetime to the panes would mean a chip that disappears every time a
 * new tab takes the window — and taking the way back away at exactly the moment the user needs it.
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
   *
   * Unless the group is carrying an arrangement, in which case it is not a guess and clicking a member
   * restores it (`takeArrangementFor`).
   *
   * ## Collapsing writes nothing, and that is now a consequence rather than a boundary
   *
   * It used to be a rule with an argument behind it: a recording existed only where the *browser* took
   * the tiles away, so the user folding tabs away deliberately recorded nothing. The reason has
   * changed. Under the maintained arrangement the last settle already wrote what the panes held, so
   * collapsing has nothing left to save — expanding and clicking a member brings the panes back from
   * a recording made before the fold, not from one made by it.
   *
   * There was a commissioned change to call `keepArrangement` from here (docs/STATUS.md, "Einklappen
   * nimmt die Anordnung auf"). It is **not** made, and not only because it is redundant: `TabGroupHost`
   * below has no split, no layout id and no tile map, so this method could not build a `TabGroupLayout`
   * without widening the seam that keeps this controller testable without a window. The seam was not
   * widened, and nothing was lost by leaving it alone.
   */
  setCollapsed(id: string, collapsed: boolean): void {
    this.host.book.setCollapsed(id, collapsed)
    for (const tabId of tabsHiddenByCollapse(this.groups())) {
      this.host.unassign(tabId)
    }
    this.#settle()
  }

  /**
   * Brings the group that owns this arrangement up to date with it, making one if there is none.
   *
   * Called every time a window's tiling settles — `BrowserWindowController` runs it from the same
   * coalesced round that publishes tab state — and once more by
   * `TileOccupancyController.claimTileForNewTab` at the moment the panes go. Which group takes it, and
   * why the four answers are what they are, is `groupToHoldArrangement`; whether there is anything to
   * do at all is `arrangementIsCurrent`. Both live in the model, so the cases can be read and tested
   * without a window.
   *
   * ## Why it may write nothing, and must say so by writing nothing
   *
   * Returns without touching the store whenever the holder already carries this exact arrangement and
   * already has every seated tab. That is not an optimisation. A write publishes, and this runs inside
   * a publish, so a pass that wrote unconditionally would schedule the next round from inside the
   * current one and never stop — and it would hand the debounced store a document on every navigation
   * event. Silence in the steady state is what makes "maintain it on every settle" affordable.
   *
   * A created group is deliberately **unnamed**. An unnamed group is already a first-class state in this
   * model — drawn as a bare colour, labelled `tabgroup.unnamed` for a screen reader — and a name stored
   * in the document would be frozen in the language it was captured in: recorded in German, it would
   * still say "Geteilte Ansicht" after the user switched to English, because a stored string cannot be
   * re-read from the catalogue. Naming it would also mean threading a locale through the split seam for
   * the sake of a label the user can type themselves.
   */
  keepArrangement(layout: TabGroupLayout): void {
    const groups = this.groups()
    const holder = groupToHoldArrangement(groups, layout)
    if (holder.kind === 'none') return
    if (holder.kind === 'create') {
      this.host.book.create({ tabIds: arrangedTabs(layout), layout })
      // A new group gathers its members into one run, exactly as `create` does.
      this.#settle()
      return
    }

    if (arrangementIsCurrent(groups, layout)) return
    /*
      The loose tabs join before the arrangement is written, and the order is load-bearing:
      `setGroupLayout` drops an arrangement naming a tab the group does not have, so writing first
      would store nothing and leave `arrangementIsCurrent` answering "no" for ever — the write storm
      this method exists to avoid, arrived at from the other side.

      `addTab` rather than `create`: joining takes nothing from anybody, where creating would take
      these members away from the group that already holds them. See `groupToHoldArrangement`.
    */
    for (const tabId of tabsToAbsorb(groups, holder.groupId, layout)) {
      this.host.book.addTab(holder.groupId, tabId)
    }
    this.host.book.setLayout(holder.groupId, layout)
    // Absorbing reorders the strip, exactly as `addTab` does; with nothing absorbed this settles an
    // order that is already settled and costs a comparison.
    this.#settle()
  }

  /**
   * The arrangement to put back for a tab being activated.
   *
   * `null` unless the tab's group is carrying an arrangement that seats *this* tab. A member added to
   * the group since is not in it, and restoring for that tab would apply a layout with nowhere for the
   * tab the user just clicked — they would click a tab and watch a different set of pages appear.
   *
   * ## Why the restore no longer spends it
   *
   * It used to, and the argument was sound for what the recording then was: a snapshot of one
   * displacement. Left in place, a second activation would replay it — and by then the user might have
   * dragged a page into another pane or chosen a different layout, so replaying would quietly undo work
   * they did after the first restore.
   *
   * What removes the argument is not a change of mind about that risk but a change in the recording.
   * The arrangement is rewritten every time the tiling settles (`keepArrangement`), so it cannot be
   * older than the last thing the user did to the panes: the drag into another pane *is* the new
   * arrangement, and replaying it replays that. A recording that can never be stale never needs to be
   * spent, and spending it was the reason a second return to a multi-view did nothing until something
   * displaced it again.
   *
   * So this reads and hands back, and changes nothing — no write, and nothing to publish. The group
   * stands either way: it is the thing that answers the request this feature exists for, and its name,
   * its colour and its way back all survive the trip.
   */
  takeArrangementFor(tabId: string): TabGroupLayout | null {
    const group = this.host.book.groupOfTab(tabId)
    if (group?.layout === undefined) return null
    if (!group.layout.tiles.includes(tabId)) return null
    // Already a snapshot: `groupOfTab` hands out a deep copy, so the caller cannot reseat the stored
    // arrangement by writing into the array it applies.
    return group.layout
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
