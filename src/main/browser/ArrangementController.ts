import {
  MIN_ARRANGED_TILES,
  arrangementIsCurrent,
  arrangementsEndedBy,
  seatedTabs,
  type Arrangement,
  type ArrangementView,
  type WindowTabs
} from '@shared/arrangements/model.js'
import {
  activeTabOf,
  arrangementHolding,
  arrangementSummaries,
  arrangementViewIsCurrent,
  restorableArrangement,
  settleRestoredScreen,
  type ArrangementSummary
} from '@shared/arrangements/screen.js'
import type { LayoutId } from '@shared/split/layout.js'
import type { ArrangementBook } from '../data/ArrangementStore.js'

/**
 * Arrangements, from the window's side.
 *
 * The pure model decides what an arrangement may be and the store gives it identity, time and a
 * file. What is left is where an arrangement meets a window: the settle that has just changed which
 * pages are in which pane, the moment the panes are put away for something else, and the click that
 * brings them back. Since U2 the window also knows **which arrangement is on screen** — `liveId` —
 * because the strip shows every arrangement as an entry (R1), and an entry has to keep its id
 * through every change the user makes to the tiling it stands for (KTD1, KTD2).
 *
 * ## What this file is for, which is what it cannot reach
 *
 * `TabGroupController.keepArrangement` used to do the keeping, and it had to reach for a group
 * to have anywhere to put a layout — so a settle created groups and pulled loose tabs into
 * them. Membership changed because panes moved. That defect is not fixed here by being careful:
 * it is fixed by `ArrangementHost` below having no book of groups, no group type, and no way to
 * ask about one. The path does not exist, so no future edit to this file can take it (KTD1).
 *
 * The narrowing is a narrowing rather than a separation, and the difference is worth stating.
 * Hiddenness is still a fact about groups — a tab is hidden because its group is collapsed —
 * but it arrives here as a set of tab ids that the seam computes from
 * `TileOccupancyHost.isHiddenByCollapse`. This controller consumes the *conclusion* and holds no
 * capability to reach the premise. The start-up pass over group boundaries (KTD15) is the same
 * line drawn again: it runs in `session-restore/apply.ts` against the book directly, with the
 * member sets computed there, and never passes through this file.
 *
 * ## Every rule is the model's
 *
 * Nothing in here decides which seating may become an arrangement, which arrangement a screen
 * belongs to, or whether one may be brought back. Those are `createArrangement`,
 * `arrangementHolding`, `restorableArrangement` and `settleRestoredScreen` in
 * `@shared/arrangements/model.ts` and `screen.ts`, where they can be read and tested without a window. What is
 * decided here — and only here — is *when*: when to leave the store alone, because this runs inside
 * a publish and a write publishes; and in which order the screen is cleared and refilled, because
 * that is a fact about one window's panes rather than about arrangements.
 */

/**
 * Everything the arrangement controller may do to the window it belongs to.
 *
 * Read the list for what is missing rather than for what is here. There is no `TabGroupBook`, no
 * `groups()`, no `TabGroup` — not even as a type import — so "the automation must not change
 * group membership" (R1, R2, R3) is a property of this declaration rather than of anyone's
 * discipline, and the proof is that the file compiles.
 *
 * ## The plan asked for five capabilities and the fifth is not enough
 *
 * KTD1 lists exactly five: the book, `currentLayout()`, `tileTabIds()`, `hiddenTabIds()` and
 * `applyArrangement()`. `liveTabIds()` is a sixth, and it is here because without it
 * `restoreFor` cannot work at all — not as an edge case, structurally. Every operation in the
 * model takes a `WindowTabs`, whose `liveTabIds` is how one window's activity is kept off
 * another window's arrangements (R16), and an arrangement worth restoring is by definition one
 * whose tabs are *not* in tiles right now — the panes were put away. Deriving the live set from
 * `tileTabIds()` and `hiddenTabIds()` would therefore mark every put-away arrangement as belonging
 * to another window, and the click that brings one back would do nothing.
 *
 * U2 adds three, all about the view rather than about membership: `currentView()` and
 * `applyView()` carry the dividers, the active tile and the tile sounds to and from the window
 * (KTD11), and `stowTiling()` takes the panes off screen when a view is put away. None of them
 * reaches anything but this window's split.
 */
export interface ArrangementHost {
  /**
   * Already bound to this window's browsing mode, exactly as `TabGroupHost.book` is: a private
   * window is handed one that keeps its arrangements in a variable, and nothing here has to know.
   */
  book: ArrangementBook
  /**
   * Every tab alive in this window.
   *
   * The model refuses to create, change or apply anything naming a tab that is not in this set,
   * which is the whole of R16: the arrangements of every ordinary window share one document, and a
   * window has no identity that survives a restart to scope them by instead.
   */
  liveTabIds(): readonly string[]
  /**
   * Those of this window's tabs the strip is not showing, because their group is collapsed.
   *
   * A set of tab ids and deliberately not a way to ask about groups — see the file header. The
   * seam computes it from the occupancy controller's group edge. It is what makes an arrangement
   * unapplicable (R14), recomputed on every call so that ends by itself when the group is expanded.
   */
  hiddenTabIds(): readonly string[]
  /** The layout the window is in, which is half of what an arrangement records. */
  currentLayout(): LayoutId
  /**
   * Who is in which tile right now, one entry per tile and `null` for an empty one.
   *
   * Positional, because the position is the information: comparing two seatings as sets would
   * leave a drag between two tiles unseen and the settle would record nothing.
   */
  tileTabIds(): ReadonlyArray<string | null>
  /**
   * The window's active tile, its dividers and each tile's sound, as the split holds them now.
   *
   * What `keep()` writes into the visible arrangement beside its seats, so that putting it away
   * and bringing it back shows it as it was left (KTD11, AE1).
   */
  currentView(): ArrangementView
  /**
   * Put an arrangement back on screen and make `activatedTabId` the active tile.
   *
   * The third argument is why this is not `(layoutId, seats)`. The seating names a tab per tile
   * but not which pane should have the focus, and `TileOccupancyController.restoreArrangement`
   * derives the active tile from the tab it is handed — without it the focus would stay in the
   * pane the window had before the click, so a user clicking a tab would watch their panes come
   * back with a different one selected.
   */
  applyArrangement(
    layoutId: LayoutId,
    seats: ReadonlyArray<string | null>,
    activatedTabId: string
  ): void
  /**
   * Put the dividers and the tile sounds of an arrangement back, after `applyArrangement`.
   *
   * After, because the layout has to be the arrangement's before its dividers mean anything, and
   * the sounds have to be applied to the tabs now in the tiles (KTD11).
   */
  applyView(view: Omit<ArrangementView, 'activeTile'>): void
  /**
   * Take every tab off the grid and fall back to the single layout, closing nothing.
   *
   * Every tile emptied first, so the layout change orphans no tab and no start page a tiled view
   * holds is closed on the way (R8: putting away closes nothing). Maximising ends with the layout,
   * and a page in tile fullscreen is asked to leave it rather than having only its index dropped
   * (KTD11). The one tile left is empty: whoever put the view away is about to fill it.
   */
  stowTiling(): void
}

export class ArrangementController {
  readonly #host: ArrangementHost
  /**
   * The arrangement on screen, or `null` when the window shows no tiled view.
   *
   * Held rather than derived, and that is the fix for the defect U1 left open. Derived — "the
   * arrangement whose seats are the screen's" — it is lost by the first change the user makes to
   * the screen, because after the change no arrangement matches; `keep()` would then try to create
   * a second arrangement over the same tabs, the model would refuse it (KTD2), and the change would
   * never be written down. Held, the change is an update under the id the window already knows.
   */
  #liveId: string | null = null

  constructor(host: ArrangementHost) {
    this.#host = host
  }

  /** The arrangement on screen, for the session slot (KTD3) and the strip (KTD5). */
  get liveId(): string | null {
    return this.#liveId
  }

  /**
   * Writes down what the window is showing, in place, under the visible arrangement's id.
   *
   * Runs from the window's coalesced broadcast round on every settle, and once more from
   * `putAway()` at the moment the panes are taken away — the one instant the arrangement still
   * exists in a burst too fast for a scheduled round to catch.
   *
   * ## Adopt, create, update
   *
   * With no visible arrangement known, the screen is either one that already has an entry — every
   * tab on it sits in one arrangement, which `arrangementHolding` finds, and the window adopts it —
   * or a tiling that has just come into being, which gets an entry (`create`). From then on every
   * settle is an `update` of that one arrangement: a tab dropped in, two tabs swapped, a layout
   * changed, a divider dragged, the active tile moved (KTD2). Nothing else changes membership here.
   *
   * The id is let go of in two cases. **Fewer than two tabs on screen**: that is no tiled view,
   * and the arrangement — if it still exists — is a put-away entry now. **A screen that shares no
   * tab with it**: the tiling was replaced wholesale without being put away, which is another
   * tiling and must not be written over this one's seats — that would take every one of its tabs
   * out of its entry at once. The next settle then adopts or creates for what is really there.
   *
   * ## Why it returns without touching the store so often
   *
   * Every gate is a refusal to *reach* the store. Reaching it at all means a document handed to
   * the debounced writer and an `onChange` fired. This method runs inside a publish, so an
   * unconditional call would debounce a file to disk on every title change and navigation.
   * Silence in the steady state is what makes "maintain it on every settle" affordable at all:
   * `arrangementIsCurrent` and `arrangementViewIsCurrent` are the model's own reading of "nothing
   * changed", and the store writes nothing for a refusal or a change that changes nothing, as the
   * net under both.
   *
   * Nothing here schedules another round, which is what lets `arrangements:changed` go out from
   * the same round's snapshot, right after this (KTD5).
   */
  keep(): void {
    const layoutId = this.#host.currentLayout()
    const seats = this.#host.tileTabIds()
    const held = this.#host.book.list()
    const shown = seatedTabs(seats)
    if (shown.length < MIN_ARRANGED_TILES) {
      this.#liveId = null
      return
    }

    const window = this.#windowTabs()
    const view = this.#host.currentView()
    let live = this.#live(held)
    if (live !== undefined && !shown.some((tabId) => live?.seats.includes(tabId) === true)) {
      live = undefined
    }
    if (live === undefined) {
      live = arrangementHolding(held, seats, window)
      if (live === undefined) {
        this.#liveId = this.#host.book.create({ layoutId, seats, ...view }, window) ?? null
        return
      }
    }
    this.#liveId = live.id

    if (arrangementIsCurrent(live, layoutId, seats) && arrangementViewIsCurrent(live, view)) return
    this.#host.book.update(live.id, { layoutId, seats, ...view }, window)
  }

  /**
   * Puts the visible tiled view away: its entry stays, the panes go (R3).
   *
   * What a click on an ordinary tab, a new tab, a positional key or the tab search does to a tiled
   * view on screen, and what bringing another one back does first. `keep()` writes the latest
   * seating and view down — the active tile, the dividers, each tile's sound (KTD11) — and then
   * the panes are stowed: every tile emptied, the single layout, nothing closed. Membership is not
   * touched, so a start page in the view stays a member (R8, AE4).
   *
   * A window already on the single layout has nothing on screen to put away and is left alone:
   * its one tile holds an ordinary tab, and emptying it would take that tab off screen for nothing.
   */
  putAway(): void {
    if (this.#host.currentLayout() === '1x1') {
      this.#liveId = null
      return
    }
    this.#clearScreen()
  }

  /**
   * Brings an arrangement back by its id — the click on its entry (R4).
   *
   * With the tab of its last active tile active, falling back to its first member when that tile
   * has emptied since. Nothing for an id this window cannot bring back — see
   * `restorableArrangement` — and nothing for the arrangement already on screen.
   */
  restore(id: string): void {
    const arrangement = restorableArrangement(this.#host.book.list(), id, this.#windowTabs())
    const focus = arrangement === undefined ? null : activeTabOf(arrangement)
    if (arrangement === undefined || focus === null) return
    this.#bringBack(arrangement, focus)
  }

  /**
   * Brings back the arrangement a tab belongs to, with that tab active.
   *
   * The way back for everything that names a tab rather than an entry: the tab search, a
   * positional key, `activateTab` for a tab that holds no tile (R14). Which arrangement — and
   * whether there is one at all — is `arrangementOfTab` in the model: nothing when no arrangement
   * seats the tab, when one of its tabs is another window's (R16) or hidden by a collapsed group.
   *
   * Answers nothing, and the window reads the outcome off the split instead: a tile for the tab
   * means an arrangement was applied, none means nothing was. That keeps every reason to decline in
   * the model — a boolean threaded back would be a second, coarser account of the same decision.
   */
  restoreFor(tabId: string): void {
    const arrangement = this.#host.book.arrangementOfTab(tabId, this.#windowTabs())
    if (arrangement === undefined) return
    this.#bringBack(arrangement, tabId)
  }

  /**
   * Whether a tab belongs to a tiled view, on screen or put away, of any window (KTD4).
   *
   * The one question the automatic paths ask before they choose a page — the single view whose tab
   * closed, a workspace looking for an open tab to reuse (U3, KTD10) — so that none of them takes a
   * member out of its entry. Any window's rather than only this one's because tab ids are unique:
   * a tab of another window is never among the candidates, so asking about it costs nothing, and
   * leaving `WindowTabs` out keeps the answer a plain fact about the book.
   */
  isMember(tabId: string): boolean {
    return this.#host.book.list().some((arrangement) => arrangement.seats.includes(tabId))
  }

  /**
   * A tab has closed: its seat goes empty, and an arrangement left with fewer than two tabs ends,
   * its last tab an ordinary one (KTD2). Called by the window once the tab has really gone.
   *
   * The visible arrangement's id is let go of when it ends, so the settle that follows does not
   * try to update an arrangement that is no longer there.
   */
  tabClosed(tabId: string): void {
    this.#host.book.removeTab(tabId)
    if (this.#live(this.#host.book.list()) === undefined) this.#liveId = null
  }

  /**
   * Settles a restored window's screen with the arrangements that came back (KTD3).
   *
   * Called once per window by `applySessionRestore`, after the tabs exist and the start-up passes
   * over the book have run, and before the first broadcast — so the strip never shows two entries
   * for one tiled view (R15). `savedId` is the session slot's `arrangementId`, `null` for a slot an
   * older build wrote. Which arrangement is on screen, and which ones stand in its way and are
   * forgotten, is `settleRestoredScreen`.
   */
  settleRestored(savedId: string | null): void {
    const settled = settleRestoredScreen(
      this.#host.book.list(),
      this.#host.currentLayout(),
      this.#host.tileTabIds(),
      savedId,
      this.#windowTabs()
    )
    for (const id of settled.forget) this.#host.book.forget(id)
    this.#liveId = settled.liveId
  }

  /**
   * This window's arrangements as `arrangements:changed` carries them (KTD5).
   *
   * Read after `keep()` in the same round, so the visible one is already written down as it is.
   */
  summaries(): ArrangementSummary[] {
    return arrangementSummaries(this.#host.book.list(), this.#windowTabs(), this.#liveId)
  }

  /**
   * Forgets the tiling on screen, because the user is about to put it down for a single page.
   *
   * The counterpart of `keep()` for the one layout change that is a decision about the panes rather
   * than room being made: choosing the single layout. Called *before* the layout changes, for the
   * reason `TileOccupancyHost.putAway` gives — afterwards the seating is one page and names only
   * the tab that stayed.
   *
   * Which arrangements go is `arrangementsEndedBy`: every one this seating owns, and none a
   * collapsed group is holding on to. Nothing here closes, moves or regroups a tab, and nothing
   * touches a tab group — there is no group to reach (KTD1). Tiling again later starts from
   * nothing, and the next settle creates a new entry for it. U4 makes this the "beenden" it is.
   */
  endTiling(): void {
    const ended = arrangementsEndedBy(
      this.#host.book.list(),
      this.#host.tileTabIds(),
      this.#windowTabs()
    )
    for (const arrangement of ended) this.#host.book.forget(arrangement.id)
    this.#liveId = null
  }

  /**
   * Reconciles the arrangements with the tabs that actually exist.
   *
   * The ids are a parameter rather than `host.liveTabIds()` on purpose, and it is the same limit
   * `TabGroupBook.retainTabs` carries on the group side: one document holds every ordinary window's
   * arrangements, so a pass that took *this* window's tabs would delete every other window's.
   */
  retainLiveTabs(ids: readonly string[]): void {
    this.#host.book.retainTabs(ids)
  }

  /**
   * The screen cleared and refilled, in that order.
   *
   * Cleared first whenever something other than this arrangement is on screen: another tiled view
   * is put away whole — kept, then stowed — before any of this one's tabs moves (R16), and a single
   * page leaves its tile so it cannot end up in one of this arrangement's empty seats and be
   * written into it by the next settle. The id is the arrangement's only once it is on screen.
   *
   * An arrangement already exactly on screen is left alone: re-applying it would run a layout
   * change and move the panes' focus for nothing.
   */
  #bringBack(arrangement: Arrangement, focusTabId: string): void {
    if (arrangementIsCurrent(arrangement, this.#host.currentLayout(), this.#host.tileTabIds())) {
      this.#liveId = arrangement.id
      return
    }
    if (this.#liveId !== arrangement.id) this.#clearScreen()
    this.#host.applyArrangement(arrangement.layoutId, arrangement.seats, focusTabId)
    this.#host.applyView({ fractions: arrangement.fractions, tileAudio: arrangement.tileAudio })
    this.#liveId = arrangement.id
  }

  /** `putAway()` without its single-layout shortcut: keep what is there, then take it away. */
  #clearScreen(): void {
    this.keep()
    this.#host.stowTiling()
    this.#liveId = null
  }

  /** The visible arrangement as the book holds it, or `undefined` for none or one that has gone. */
  #live(held: readonly Arrangement[]): Arrangement | undefined {
    return held.find((arrangement) => arrangement.id === this.#liveId)
  }

  /**
   * The two facts about this window that an arrangement cannot know about itself.
   *
   * Read fresh on every call rather than held, because both change under this controller's feet:
   * a tab closes, a group is collapsed, and a cached pair would let a settle act on an arrangement
   * that stopped being this window's to act on a moment ago.
   */
  #windowTabs(): WindowTabs {
    return { liveTabIds: this.#host.liveTabIds(), hiddenTabIds: this.#host.hiddenTabIds() }
  }
}
