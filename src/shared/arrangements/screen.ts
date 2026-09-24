import type { LayoutId } from '../split/layout.js'
import {
  MIN_ARRANGED_TILES,
  arrangementIsApplicable,
  arrangementIsCurrent,
  cloneArrangements,
  fitArrangementView,
  seatedTabs,
  type Arrangement,
  type ArrangementView,
  type WindowTabs
} from './model.js'

/**
 * Arrangements where they meet a window's screen: which one is on it, and what the strip is told.
 *
 * `model.ts` is what an arrangement is and how it may change; this is the pure half of U2, the
 * questions a window asks now that it knows which arrangement it is showing (`liveId`, KTD2) — which
 * one to adopt, whether the view on screen is already written down, which one a restart shows
 * (KTD3), what `arrangements:changed` carries (KTD5), and whether a window closing takes its
 * arrangements with it. Its own file because every one of them is about a screen and none is about
 * the document, and because `model.ts` is long enough that a second subject would bury the first.
 *
 * No zod here either, for `model.ts`'s reason: the strip model a later unit builds imports this.
 */

/**
 * The one arrangement that holds every tab on screen, for a window to adopt as its visible one.
 *
 * `ArrangementController.keep()` updates the visible arrangement in place under its id (KTD2),
 * so it has to know which one that is. Usually it does — it created it, or `restore` put it on
 * screen. This is the answer for the moments it does not: a workspace seated the tabs, or a
 * layout change showed exactly the members of a put-away one. Adopting it rather than creating a
 * second is what keeps two entries from naming the same tabs (R4).
 *
 * All or nothing. A screen that shows one member next to a tab of no arrangement is not that
 * arrangement, and adopting it would pull the stranger in on the next update; the answer is then
 * nothing, and `createArrangement` refuses the mixed seating in turn — so a mix nobody asked for
 * changes no membership (R16). The arrangement must also be wholly the calling window's, for the
 * reason every operation here takes `WindowTabs`.
 *
 * Found through the first tab on screen, which is enough: a tab sits in at most one arrangement,
 * so the only candidate is the one holding it.
 */
export function arrangementHolding(
  arrangements: readonly Arrangement[],
  seats: ReadonlyArray<string | null>,
  window: WindowTabs
): Arrangement | undefined {
  const shown = seatedTabs(seats)
  const [first] = shown
  if (first === undefined) return undefined
  const owner = arrangements.find((arrangement) => arrangement.seats.includes(first))
  if (owner === undefined) return undefined
  if (!shown.every((tabId) => owner.seats.includes(tabId))) return undefined
  const live = new Set(window.liveTabIds)
  if (!seatedTabs(owner.seats).every((tabId) => live.has(tabId))) return undefined
  return cloneArrangements([owner])[0]
}

/**
 * Whether the arrangement already holds this view — the gate that keeps `keep()` off the store.
 *
 * The view the window reports is read the way `updateArrangement` would write it, through the
 * same `fitArrangementView`: a divider the layout does not have is dropped and a missing tile's sound is
 * loud. Compared raw, a view that differs only in what the write normalises away would never be
 * "current", and the broadcast round would write the document on every pass — the write storm
 * `arrangementIsCurrent` exists to prevent, one field over.
 *
 * Read against the arrangement's own layout. The caller asks `arrangementIsCurrent` about the
 * layout first; a different layout is a write anyway.
 */
export function arrangementViewIsCurrent(arrangement: Arrangement, view: ArrangementView): boolean {
  const fitted = fitArrangementView(arrangement.layoutId, view)
  if (arrangement.activeTile !== fitted.activeTile) return false
  const dividers = Object.entries(fitted.fractions)
  if (!dividers.every(([id, value]) => arrangement.fractions[id] === value)) return false
  return fitted.tileAudio.every((audio, index) => {
    const held = arrangement.tileAudio[index]
    return held?.muted === audio.muted && held.volume === audio.volume
  })
}

/**
 * The tab an arrangement shows in its active tile, or its first member when that tile is empty.
 *
 * What bringing it back activates (R4: "mit ihrer zuletzt aktiven Kachel"), and what the strip
 * titles its entry with (R2). The fallback is for a tile whose tab has closed since: the seat
 * stays empty so the others do not move, and the focus goes to a page rather than to a hole.
 * `null` only for a seating with nobody in it, which no stored arrangement has.
 */
export function activeTabOf(arrangement: Arrangement): string | null {
  return arrangement.seats[arrangement.activeTile] ?? seatedTabs(arrangement.seats)[0] ?? null
}

/**
 * The arrangement a click on its entry may bring back, by id (R4), or nothing.
 *
 * The same "whole or not at all" `arrangementOfTab` answers for a tab: nothing while one of its
 * tabs is hidden by a collapsed group (R11) or belongs to another window (R16).
 */
export function restorableArrangement(
  arrangements: readonly Arrangement[],
  id: string,
  window: WindowTabs
): Arrangement | undefined {
  return arrangements.find(
    (arrangement) => arrangement.id === id && arrangementIsApplicable(arrangement, window)
  )
}

/** Which arrangement a restored window shows, and which ones are in its way (KTD3). */
export interface RestoredScreen {
  liveId: string | null
  forget: string[]
}

/**
 * Settles a restored window's screen with the arrangements that came back, before the first
 * broadcast — so there is exactly one entry for what the window shows (R15).
 *
 * Two sources describe the same tiling after a restart: the session slot, which brought the tabs
 * back into their tiles, and the arrangements file, which holds the entry. They agree when both
 * were written by the same round, which is the usual case; this is for the others.
 *
 *   - **The slot names an id** (`savedId`) and an arrangement with that id shares a tab with the
 *     screen: that is the visible one.
 *   - **The slot names none** — a session from a build before U2 — or its id did not come back:
 *     the arrangement whose seats are exactly the screen's is adopted.
 *   - **Every other arrangement of this window that shares a tab with the screen is forgotten.**
 *     The screen is what the user sees, so it wins; an arrangement holding one of its tabs would
 *     otherwise make the next update, or the next creation, refuse the screen for good (KTD2).
 *
 * A screen of fewer than `MIN_ARRANGED_TILES` tabs shows no arrangement — the window came back
 * with `splitView.restoreLayoutOnStart` off, or put away — and then nothing is forgotten either:
 * every arrangement is a put-away entry, which is exactly how it should come back.
 */
export function settleRestoredScreen(
  arrangements: readonly Arrangement[],
  layoutId: LayoutId,
  seats: ReadonlyArray<string | null>,
  savedId: string | null,
  window: WindowTabs
): RestoredScreen {
  const shown = new Set(seatedTabs(seats))
  if (shown.size < MIN_ARRANGED_TILES) return { liveId: null, forget: [] }

  const live = new Set(window.liveTabIds)
  const inTheWay = arrangements.filter((arrangement) => {
    const tabs = seatedTabs(arrangement.seats)
    return tabs.every((tabId) => live.has(tabId)) && tabs.some((tabId) => shown.has(tabId))
  })
  const kept =
    inTheWay.find((arrangement) => arrangement.id === savedId) ??
    inTheWay.find((arrangement) => arrangementIsCurrent(arrangement, layoutId, seats))

  return {
    liveId: kept?.id ?? null,
    forget: inTheWay.filter((arrangement) => arrangement !== kept).map((entry) => entry.id)
  }
}

/**
 * One arrangement as the strip is told about it: the payload of `arrangements:changed` (KTD5).
 *
 * A summary per arrangement rather than a field per tab, because the strip draws one entry per
 * arrangement: members in tile order for the favicons, the tab of the active tile for the title
 * (R2), and whether it is the one on screen. `activeTile` is carried beside `activeTabId` so a
 * later unit can tell a focus that fell back to the first member from one that is really there.
 */
export interface ArrangementSummary {
  id: string
  layoutId: LayoutId
  /** Members in tile order, empty seats left out. */
  tabIds: string[]
  activeTile: number
  activeTabId: string | null
  /** The arrangement on screen; at most one per window. */
  visible: boolean
}

/**
 * The calling window's arrangements, summarised, in document order.
 *
 * Only arrangements wholly of this window's tabs: the document is shared between every ordinary
 * window, and another window's entries in this strip would be entries nothing here can act on
 * (R16). One whose tabs are hidden by a collapsed group is included — the chip counts it (R11).
 */
export function arrangementSummaries(
  arrangements: readonly Arrangement[],
  window: WindowTabs,
  liveId: string | null
): ArrangementSummary[] {
  const live = new Set(window.liveTabIds)
  return arrangements
    .filter((arrangement) => seatedTabs(arrangement.seats).every((tabId) => live.has(tabId)))
    .map((arrangement) => ({
      id: arrangement.id,
      layoutId: arrangement.layoutId,
      tabIds: seatedTabs(arrangement.seats),
      activeTile: arrangement.activeTile,
      activeTabId: activeTabOf(arrangement),
      visible: arrangement.id === liveId
    }))
}

/**
 * Whether a window closing takes its arrangements with it (KTD3).
 *
 * The rule `forgetWindow` in `shared/session/model.ts` keeps for a session slot, and for the same
 * reason: **the last ordinary window closing is how a session ends on most platforms**, and what
 * that window held is what the next start has to bring back. So its arrangements stay — the next
 * start's `retainTabs` keeps them if their tabs come back and drops them if not. Any other window
 * closing is the user getting rid of it, and an entry for tabs that no longer exist would be
 * clutter nothing could ever clear before the next restart.
 *
 * Nothing is forgotten once the browser is shutting down. Every window closes then, in some order,
 * and the ones closing first would each find another still open — so "quit with two windows" would
 * lose one window's arrangements depending on which closed first. `SessionStore.seal` is the same
 * answer on the slot side. A private window has nothing to forget: its book was never the file.
 */
export function windowCloseForgetsArrangements(
  closing: { privateMode: boolean },
  stillOpen: ReadonlyArray<{ privateMode: boolean }>,
  shuttingDown: boolean
): boolean {
  if (shuttingDown || closing.privateMode) return false
  return stillOpen.some((window) => !window.privateMode)
}
