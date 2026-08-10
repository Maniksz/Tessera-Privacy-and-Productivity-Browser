import {
  MIN_ARRANGED_TILES,
  arrangementIsCurrent,
  seatedTabs,
  type WindowTabs
} from '@shared/arrangements/model.js'
import type { LayoutId } from '@shared/split/layout.js'
import type { ArrangementBook } from '../data/ArrangementStore.js'

/**
 * Arrangements, from the window's side.
 *
 * The pure model decides what a recording may be and the store gives it identity, time and a
 * file. What is left is the pair of moments where a recording meets a window: the settle that
 * has just changed which pages are in which pane, and the click on a tab whose panes are gone.
 * `keep()` and `restoreFor()` are the two ends of that one feature.
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
 * capability to reach the premise.
 *
 * ## Every rule is the model's
 *
 * Nothing in here decides what supersedes what, what may be evicted, what counts as protected or
 * whether a recording may be applied. Those are `recordArrangement`, `arrangementOfTab` and
 * `arrangementIsProtected` in `@shared/arrangements/model.ts`, where they can be read and tested
 * without a window. What is decided here — and only here — is *when to leave the store alone*,
 * because that is a fact about the window's broadcast round rather than about arrangements: this
 * runs inside a publish, and a write publishes.
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
 * another window's recordings (R16), and a recording worth restoring is by definition one whose
 * tabs are *not* in tiles right now — the panes were put away. Deriving the live set from
 * `tileTabIds()` and `hiddenTabIds()` would therefore mark every put-away recording as belonging
 * to another window, `arrangementOfTab` would answer nothing for ever, and the click that R7 is
 * about would do nothing. The same gap makes `keep()` fail to supersede its own older recording
 * whenever that recording seats a tab the window is not currently tiling, leaving two ways back
 * for one tab.
 *
 * It costs nothing that KTD1 was buying. The decision KTD1 makes is that no capability here
 * reaches a group; a list of the window's own tab ids reaches nothing but tabs.
 */
export interface ArrangementHost {
  /**
   * Already bound to this window's browsing mode, exactly as `TabGroupHost.book` is: a private
   * window is handed one that keeps its recordings in a variable, and nothing here has to know.
   */
  book: ArrangementBook
  /**
   * Every tab alive in this window.
   *
   * The model refuses to record, evict or apply anything naming a tab that is not in this set,
   * which is the whole of R16: the recordings of every ordinary window share one document, and a
   * window has no identity that survives a restart to scope them by instead.
   */
  liveTabIds(): readonly string[]
  /**
   * Those of this window's tabs the strip is not showing, because their group is collapsed.
   *
   * A set of tab ids and deliberately not a way to ask about groups — see the file header. The
   * seam computes it from the occupancy controller's group edge. It is what makes a recording
   * protected from eviction (R15) and unapplicable (R14), recomputed on every call so the
   * protection ends by itself when the group is expanded (KTD8).
   */
  hiddenTabIds(): readonly string[]
  /** The layout the window is in, which is half of what a recording records. */
  currentLayout(): LayoutId
  /**
   * Who is in which tile right now, one entry per tile and `null` for an empty one.
   *
   * Positional, because the position is the information: comparing two seatings as sets would
   * leave a drag between two tiles unseen and the settle would record nothing.
   */
  tileTabIds(): ReadonlyArray<string | null>
  /**
   * Put a recording back on screen and make `activatedTabId` the active tile.
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
}

export class ArrangementController {
  readonly #host: ArrangementHost

  constructor(host: ArrangementHost) {
    this.#host = host
  }

  /**
   * Writes down what the window is showing, if that is worth writing down and is not written
   * down already.
   *
   * Runs from the window's coalesced broadcast round on every settle, and once more from
   * `TileOccupancyController` at the moment the panes are taken away for a new tab — the one
   * instant the arrangement still exists in a burst too fast for a scheduled round to catch.
   *
   * ## Why it returns without touching the store so often
   *
   * Both gates are refusals to *reach* the store, which is a different question from what the
   * store would then do with the draft. `record` would refuse a one-pane seating and would
   * refuse a draft identical to one it holds — but reaching it at all means a document handed to
   * the debounced writer and an `onChange` fired, and `onChange` is what publishes. This method
   * runs inside a publish, so an unconditional call would schedule the next round from inside
   * the current one and would debounce a file to disk on every title change and navigation.
   * Silence in the steady state is what makes "maintain it on every settle" affordable at all.
   *
   * The two gates use the model's own vocabulary — `MIN_ARRANGED_TILES` and
   * `arrangementIsCurrent` — rather than a second opinion about what is worth keeping. The model
   * stays the authority; this is the same rule read early to keep a hand off the store.
   *
   * Everything after the gates is the model's: which older recording this supersedes, what may
   * be evicted to make room, and the refusal to evict anything a collapsed group is protecting
   * (R15). None of it is decided here.
   */
  keep(): void {
    const layoutId = this.#host.currentLayout()
    const seats = this.#host.tileTabIds()
    if (seatedTabs(seats).length < MIN_ARRANGED_TILES) return
    if (this.#host.book.list().some((held) => arrangementIsCurrent(held, layoutId, seats))) return

    this.#host.book.record({ layoutId, seats }, this.#windowTabs())
  }

  /**
   * Brings back the arrangement a click on this tab asks for, if there is one to bring back.
   *
   * The way back from `keep()`, and the whole of R7: a tab whose panes were put away is clicked,
   * and the panes come back with that tab active.
   *
   * Which recording — and whether there is one at all — is `arrangementOfTab` in the model, not a
   * condition here. It answers nothing when no recording seats the tab, when the recording seats
   * a tab of another window (R16), and when any of its tabs is hidden by a collapsed group (R14,
   * KD8: whole or not at all). Putting that filtering behind one function is what keeps "ganz
   * oder gar nicht" testable without a window.
   *
   * The one thing decided here is the last line of defence against a pointless re-apply: a
   * recording that is exactly what the window is already showing is left alone. `keep()`'s gate
   * normally means the current tiling *is* the recording, so a click on a tab in a live
   * multi-view would otherwise re-run a layout change and move the panes' focus for nothing.
   *
   * Nothing is written and nothing is spent. The recording is rewritten by the next settle, so
   * it can never be staler than the last thing the user did to the panes — which is why applying
   * it need not consume it, and why returning to a multi-view twice works.
   */
  restoreFor(tabId: string): void {
    const arrangement = this.#host.book.arrangementOfTab(tabId, this.#windowTabs())
    if (arrangement === undefined) return
    if (arrangementIsCurrent(arrangement, this.#host.currentLayout(), this.#host.tileTabIds())) {
      return
    }

    this.#host.applyArrangement(arrangement.layoutId, arrangement.seats, tabId)
  }

  /**
   * Reconciles the recordings with the tabs that actually exist.
   *
   * The ids are a parameter rather than `host.liveTabIds()` on purpose, and it is the same limit
   * `TabGroupBook.retainTabs` carries on the group side: one document holds every ordinary window's
   * recordings, so a pass that took *this* window's tabs would delete every other window's. The
   * caller hands in the union — session restore has it, and a tab closing in a single-window
   * session is the degenerate case of the same union. `TabGroupController` had a per-window wrapper
   * around the group equivalent; it was dead and is gone, so this shape is the only one left.
   *
   * Nothing is published afterwards. A recording is invisible to the renderer, there is no IPC
   * channel carrying one (KTD6), and so there is nothing for a broadcast to say.
   */
  retainLiveTabs(ids: readonly string[]): void {
    this.#host.book.retainTabs(ids)
  }

  /**
   * The two facts about this window that a recording cannot know about itself.
   *
   * Read fresh on every call rather than held, because both change under this controller's feet:
   * a tab closes, a group is collapsed, and a cached pair would let a settle evict a recording
   * that was protected as of a moment ago.
   */
  #windowTabs(): WindowTabs {
    return { liveTabIds: this.#host.liveTabIds(), hiddenTabIds: this.#host.hiddenTabIds() }
  }
}
