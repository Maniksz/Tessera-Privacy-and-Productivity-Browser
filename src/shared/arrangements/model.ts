import type { TileAudio } from '../model.js'
import { DEFAULT_FRACTIONS, TILE_COUNT, withDefaults, type LayoutId } from '../split/layout.js'

/**
 * Arrangements — a set of tabs tiled together, kept as one unit whether or not the window is
 * showing it. The interface calls it a *Kachelansicht*.
 *
 * ## An entity, not a recording
 *
 * This module used to keep an invisible recording of a tiling that had been put away: its id
 * changed on every settle, a new recording overlapping an old one replaced it without a word,
 * and the oldest fell off at a cap of thirty-two. None of that was visible, so none of it was a
 * loss. The strip now shows every arrangement as an entry (R1), and each of those three rules
 * would make an entry vanish under the user's hand. So (KTD1, KTD2, KTD3):
 *
 *   - **the id is given once, at `createArrangement`, and kept by every change** —
 *     `updateArrangement` rewrites layout, seats and view under the id it already has;
 *   - **membership changes only through named operations** — create, update, remove a closed
 *     tab, forget one, forget a window's. A tab already in an arrangement is refused by the next
 *     one rather than taken from the first, which is how "a tab belongs to at most one" (R4)
 *     holds without anything being replaced;
 *   - **nothing is evicted**. There is no cap: `retainTabs` bounds the document at start-up to
 *     arrangements whose tabs came back, and a window that closes forgets its own (R16).
 *
 * An arrangement also carries its **view** — the active tile, the divider positions and each
 * tile's sound — because bringing one back must show it as it was left (R4), and after a
 * restart as well (R15).
 *
 * ## Why this file has no zod import
 *
 * The tab strip and the split view are renderers, so every value import that is reachable
 * from them lands in a bundle the user waits for. Co-locating a schema with a pure helper
 * dragged the whole validation library into the UI bundle once already — about half a
 * megabyte of startup parse work — and an architecture test now walks the value-import
 * graph to keep it out. The schema therefore lives next door in `schema.ts`, which imports
 * this file and is never imported by it, with `SameShape` assertions holding the two
 * together. See `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`.
 *
 * ## An arrangement is not a group
 *
 * `shared/tabgroups/model.ts` names three independent facts about a tab — its position in
 * the strip, its tile, and its group — and this file is a fourth that used to be smuggled
 * into the third. A group carried a `layout` field, so the tiling automation had to reach
 * for a group to write anything down, and reaching for one meant creating one and pulling
 * loose tabs into it. Membership changed because panes moved, which is the defect this
 * module exists to remove.
 *
 * So an arrangement says nothing about membership, has no name, no colour, and no place in
 * the strip. It is a recording of **which layout and who sat in which tile**, addressed by
 * the tab ids it seats and by nothing else. Nothing here may take a group, return a group,
 * or need one to exist — that is the narrowing the whole rebuild is for, and it is a
 * property of the file's imports rather than of anyone's discipline.
 *
 * ## Why the window's tabs arrive on every call
 *
 * The recordings of every ordinary window live in one document, because they outlive the
 * windows that made them and a window has no identity that survives a restart. Two facts
 * therefore cannot be read off a recording and have to be handed in by the caller:
 *
 *   - **which tabs the calling window owns** — without it, one window's settle could change
 *     another window's arrangement and a click in one window could re-tile the other (R16);
 *   - **which tabs the strip is currently hiding**, because their group is collapsed —
 *     without it, a recording would be applied over tabs that are not there to be seated
 *     (R14).
 *
 * Both arrive as sets of tab ids, never as groups. Hiddenness is a fact about tabs here,
 * not a capability to ask about groups: `WindowTabs` is the entire vocabulary this module
 * has for the world outside it.
 *
 * ## Why protection is computed and never stored
 *
 * A `protected` flag on a recording would be written when a group collapses and would have
 * to be cleared on every path that can make a tab visible again — expanding, leaving the
 * group, dissolving it, closing the tab. Miss one and the recording stays unapplicable for
 * ever. Derived from the hidden set on every call it cannot go stale: the protection ends the
 * moment the tabs come back, with nothing to clear (KTD8).
 *
 * ## Why every operation is pure
 *
 * Each takes the current recordings and returns new ones. Identity and time come from the
 * caller — the store makes ids and reads the clock — so every rule in here is testable
 * without a window, a clock or a file, and there is one place the invariants live rather
 * than one per controller that happens to touch them.
 */

/**
 * Tiles that must hold a tab for a tiling to be worth recording.
 *
 * Two, taken over unchanged from the tab groups it used to live with. One page in one pane
 * is not an arrangement — it is the single view the browser is about to switch to anyway,
 * and recording it would make a recording out of every new tab opened from a window that
 * happened to have one pane filled. It is also the floor on the way back down: a recording
 * whose tabs have closed until one is left has nothing to restore, and applying a four-tile
 * layout to seat a single page would put three empty panes on screen — the outcome
 * `TileOccupancyController` exists to prevent.
 */
export const MIN_ARRANGED_TILES = 2

/**
 * A tiling that has been put away: which layout, and who sat in which tile.
 *
 * `seats` is one entry per tile of `layoutId`, in tile order, naming the tab that was in it
 * or `null` for a tile that was empty. Positional rather than a list of tab ids, because
 * the position *is* the information: a tab that has closed since must leave its tile empty
 * rather than let the others shift along, or coming back to a `2x2` would rearrange the
 * three pages that survived.
 *
 * The shape is also exactly what restoring needs — `applyArrangement(layoutId, seats,
 * activatedTabId)` — so nothing has to be guessed on the way back.
 *
 * The view fields always fit the layout: one `tileAudio` entry per tile, `activeTile` a tile
 * the layout has, and `fractions` exactly the layout's own dividers. Every write path fits them
 * (`fitArrangementView`), so a reader never has to.
 */
export interface Arrangement extends ArrangementView {
  id: string
  layoutId: LayoutId
  /** Tab id per tile, `null` for an empty tile. Exactly `TILE_COUNT[layoutId]` entries. */
  seats: Array<string | null>
  /**
   * When the arrangement was created, kept by `updateArrangement`. It orders nothing but
   * `reconcileArrangements`, where the newer of two arrangements sharing a tab is the one kept.
   */
  recordedAt: number
}

/**
 * How an arrangement looks on screen, apart from who sits where (KTD11).
 *
 * Kept with the arrangement rather than with the window, because a window shows one at a time
 * and every other one has to remember its own: bringing an arrangement back must put the focus,
 * the dividers and the muted tiles where they were when it was put away.
 */
export interface ArrangementView {
  /** The tile that had the focus. */
  activeTile: number
  /** Divider positions, keyed by divider id from `split/layout.ts`. */
  fractions: Record<string, number>
  /** Per tile, in tile order: muted and volume, as `SplitController` keeps them. */
  tileAudio: TileAudio[]
}

/**
 * What a caller proposes to create.
 *
 * The same fields as an `Arrangement`, and deliberately not the same type: this one has not
 * been through the rules yet. Identity and time are on it because the pure layer must not
 * invent either — that is the division `TabGroupStore` already uses, and it is what lets
 * every test in this module assert on exact objects. The view is optional: a tiling that has
 * just come into being starts from `defaultArrangementView`.
 */
export interface ArrangementDraft extends Partial<ArrangementView> {
  id: string
  layoutId: LayoutId
  seats: ReadonlyArray<string | null>
  recordedAt: number
}

/**
 * What `updateArrangement` may change. Every field optional, so a caller writing the view alone
 * — putting an arrangement away — cannot also rewrite who sits where by accident.
 */
export interface ArrangementPatch extends Partial<ArrangementView> {
  layoutId?: LayoutId
  seats?: ReadonlyArray<string | null>
}

export interface ArrangementDocument {
  /** 2 since the view fields; `ARRANGEMENT_MIGRATIONS` in the store brings a version 1 up. */
  version: 2
  /** Oldest first, which is the order `createArrangement` appends in. */
  arrangements: Arrangement[]
}

/**
 * The two facts about the calling window that a recording cannot know about itself.
 *
 * Passed together rather than as two loose string arrays, because the pair is meaningless
 * apart and swapping them at a call site would compile: `hiddenTabIds` is a subset of
 * `liveTabIds`, and reversing them would turn every protection in this file inside out.
 */
export interface WindowTabs {
  /** Every tab alive in the window making the call (R16). */
  liveTabIds: readonly string[]
  /** Those of them the strip is not showing, because their group is collapsed (KTD8). */
  hiddenTabIds: readonly string[]
}

export function emptyArrangementDocument(): ArrangementDocument {
  return { version: 2, arrangements: [] }
}

/** What a tile's sound is before anybody touches it, as `SplitController` starts one. */
const LOUD: TileAudio = { muted: false, volume: 1 }

/**
 * The view an arrangement of this layout starts with: the first tile active, the layout's
 * default dividers, every tile loud at full volume — what `SplitController` gives a fresh tile.
 *
 * Also what the version-1 migration writes into every stored arrangement (KTD15), so an upgraded
 * file and a tiling made today start from the same place. A fresh object per call.
 */
export function defaultArrangementView(layoutId: LayoutId): ArrangementView {
  return {
    activeTile: 0,
    fractions: { ...DEFAULT_FRACTIONS[layoutId] },
    tileAudio: Array.from({ length: TILE_COUNT[layoutId] }, () => ({ ...LOUD }))
  }
}

// --- reads -------------------------------------------------------------------

/** The tabs a seating puts on screen, in tile order, skipping the empty tiles. */
export function seatedTabs(seats: ReadonlyArray<string | null>): string[] {
  return seats.filter((tabId): tabId is string => tabId !== null)
}

/**
 * True while at least one of the recording's tabs is hidden by a collapsed group.
 *
 * The `Geschützt` state of the plan's diagram, and the reason it is a function rather than
 * a field is in the header. A protected recording is not applied (R14): seating the visible
 * tabs alone would put an arrangement on screen that is not the one the user made.
 */
export function arrangementIsProtected(
  arrangement: Arrangement,
  hiddenTabIds: readonly string[]
): boolean {
  return isProtectedBy(arrangement, new Set(hiddenTabIds))
}

/**
 * The recording a click on this tab should bring back, if there is one to bring back.
 *
 * Answers nothing rather than a recording the caller would have to check, and the filtering
 * is here rather than at the call site so that "ganz oder gar nicht" (KD8) is one testable
 * function instead of a condition in a controller that only a window's worth of state can
 * reach. Nothing is answered when
 *
 *   - no recording seats the tab;
 *   - the recording seats a tab of another window, so applying it here would move a page the
 *     caller does not own (R16);
 *   - any of its tabs is hidden (R14). Seating the visible ones would leave a pane empty,
 *     would never match the recording, and would therefore let the next click apply the very
 *     same arrangement again — the recording would be spent without ever being reached.
 */
export function arrangementOfTab(
  arrangements: readonly Arrangement[],
  tabId: string,
  window: WindowTabs
): Arrangement | undefined {
  const sets = tabSetsOf(window)
  return arrangements.find(
    (arrangement) => arrangement.seats.includes(tabId) && isUnobstructed(arrangement, sets)
  )
}

/**
 * True when this recording is exactly what the window is showing.
 *
 * The idempotence gate, and the reason a maintenance pass may run on every broadcast round.
 * Two failures it prevents, neither theoretical, both learned from the tab-group version of
 * this function. **A write storm:** the pass runs from the coalesced round that publishes tab
 * state, which fires on every title change and navigation, so an unconditional write would
 * debounce a document to disk for the rest of the session. **A round that schedules the next
 * one:** the pass runs inside a publish and a write publishes, so without a "nothing changed"
 * answer the two feed each other for ever.
 *
 * Compared element by element, because `seats` is positional: the same tabs in swapped panes
 * is a different arrangement, and comparing them as sets would leave a drag between two tiles
 * unseen. The length is compared too, so a caller handing in a seating from a layout with
 * more tiles cannot match a shorter recording by having the right prefix.
 */
export function arrangementIsCurrent(
  arrangement: Arrangement,
  layoutId: LayoutId,
  seats: ReadonlyArray<string | null>
): boolean {
  if (arrangement.layoutId !== layoutId) return false
  if (arrangement.seats.length !== seats.length) return false
  return arrangement.seats.every((tabId, index) => tabId === seats[index])
}

/**
 * True when this arrangement is the calling window's to act on, and free to act on: every tab is
 * the window's and none is hidden by a collapsed group. `arrangementOfTab`'s test for one arrangement
 * already in hand, for the callers that address one by id (`screen.ts`).
 */
export function arrangementIsApplicable(arrangement: Arrangement, window: WindowTabs): boolean {
  return isUnobstructed(arrangement, tabSetsOf(window))
}

// --- writes ------------------------------------------------------------------

/**
 * Creates an arrangement for a tiling that has just come into being, or refuses to.
 *
 * Refused — the list handed back unchanged — when
 *
 *   - **it is not worth keeping**: `seatsWorthKeeping`, the one gate every seating passes;
 *   - **it names a tab the calling window does not own**. Refused rather than trimmed: the caller
 *     has mixed up two windows, and keeping the remainder would write down a tiling that never
 *     existed (R16);
 *   - **one of its tabs already sits in another arrangement**, hidden or not. The old rule
 *     replaced that arrangement, which was harmless while nobody could see it and is an entry
 *     vanishing from the strip now (KTD2). A tab joins another arrangement only through a named
 *     operation that takes it out of the first, so a refusal here means the caller has skipped
 *     one — and the right answer to a skipped step is to change nothing;
 *   - **its id is taken**. Ids come from the store and do not collide, so this only guards the
 *     rule that `forgetArrangement(id)` addresses exactly one arrangement.
 *
 * Nothing is evicted to make room, because there is no room to make (KTD3). The caller learns
 * the outcome from whether the id is in the answer, which is how the store tells its own caller.
 *
 * Always returns a fresh array of fresh arrangements, including when it changes nothing, so no
 * caller can mutate a stored document through the value it was handed.
 */
export function createArrangement(
  arrangements: readonly Arrangement[],
  draft: ArrangementDraft,
  window: WindowTabs
): Arrangement[] {
  const seats = seatsWorthKeeping(draft.layoutId, draft.seats, tabSetsOf(window).live)
  const taken = arrangements.some((arrangement) => arrangement.id === draft.id)
  if (seats === null || taken || seatsHeldElsewhere(arrangements, seats, undefined)) {
    return cloneArrangements(arrangements)
  }

  return [
    ...cloneArrangements(arrangements),
    {
      id: draft.id,
      layoutId: draft.layoutId,
      seats,
      ...fitArrangementView(draft.layoutId, draft),
      recordedAt: draft.recordedAt
    }
  ]
}

/**
 * Changes one arrangement under the id it already has (KTD1).
 *
 * What the visible arrangement goes through when its panes change — a tab dropped onto a tile,
 * a layout chosen — and what putting one away writes its view with. The id is kept whatever
 * changes, which is the point: an entry in the strip is the same entry after its layout changed,
 * and a session slot naming it still names it.
 *
 * Refused, with the list unchanged, when
 *
 *   - **the arrangement has a tab the calling window does not own** (R16);
 *   - **the new seating is no arrangement**, by the same gate as `createArrangement`, including
 *     a new layout handed in without the seating that fits it. Refused rather than dropping the
 *     arrangement: ending one is `forgetArrangement`, a named operation with a caller who knows
 *     it is ending something, not the side effect of a write that went wrong;
 *   - **the new seating takes a tab from another arrangement** (R4).
 *
 * Deliberately not refused while a collapsed group hides the tabs. Collapsing a group puts the
 * visible arrangement in it away (R11), and putting away is exactly this write of the view — so
 * hiddenness, which stops an arrangement being *applied*, must not stop it being *remembered*.
 *
 * The view is fitted to the layout afterwards, so a patch that changes the layout keeps whatever
 * of the old view still fits it: the dividers the two layouts share, the sound of the tiles both
 * have, and the focus if that tile still exists.
 */
export function updateArrangement(
  arrangements: readonly Arrangement[],
  id: string,
  patch: ArrangementPatch,
  window: WindowTabs
): Arrangement[] {
  const unchanged = cloneArrangements(arrangements)
  const current = arrangements.find((arrangement) => arrangement.id === id)
  const live = tabSetsOf(window).live
  if (current === undefined || !seatedTabs(current.seats).every((tab) => live.has(tab))) {
    return unchanged
  }

  const layoutId = patch.layoutId ?? current.layoutId
  const seats = seatsWorthKeeping(layoutId, patch.seats ?? current.seats, live)
  if (seats === null || seatsHeldElsewhere(arrangements, seats, id)) return unchanged

  const view = fitArrangementView(layoutId, { ...current, ...patch })
  return unchanged.map((arrangement) =>
    arrangement.id === id ? { ...arrangement, layoutId, seats, ...view } : arrangement
  )
}

/**
 * A tab has closed: its tile in every arrangement goes empty.
 *
 * Emptied rather than closed up, the rule everywhere `seats` is touched: the pages that stay must
 * come back in the tiles they were in. An arrangement left with fewer than `MIN_ARRANGED_TILES`
 * tabs goes, because one page in one tile is no arrangement — the remaining tab is an ordinary
 * one from then on, which is the "Aufgelöst" of the plan's lifecycle.
 *
 * No window is asked for: tab ids are unique across windows, so a closed tab can only be in the
 * arrangements of the window it closed in.
 */
export function removeTabFromArrangements(
  arrangements: readonly Arrangement[],
  tabId: string
): Arrangement[] {
  return keepWorthwhile(
    arrangements.map((arrangement) => ({
      ...arrangement,
      seats: arrangement.seats.map((seated) => (seated === tabId ? null : seated))
    }))
  )
}

/**
 * Forgets every arrangement that seats one of these tabs — a window's, when it closes.
 *
 * The caller decides *whether* a window's arrangements go: only when another ordinary window
 * stays open, as `forgetWindow` does for session slots, so that closing the last window keeps
 * them for the restart (KTD3). This decides only which ones, and one shared tab is enough —
 * an arrangement whose tabs are partly gone is no longer one anybody can bring back.
 */
export function forgetArrangementsOfTabs(
  arrangements: readonly Arrangement[],
  tabIds: readonly string[]
): Arrangement[] {
  const gone = new Set(tabIds)
  return cloneArrangements(
    arrangements.filter((arrangement) => !seatedTabs(arrangement.seats).some((t) => gone.has(t)))
  )
}

/**
 * Brings a loaded document in line with two rules older builds did not keep (KTD15, step 2).
 *
 * Runs at every start, right after `retainTabs`, with the members of every group as sets of tab
 * ids. Called with sets rather than groups so this file keeps its narrowing: it still cannot take
 * a group, and "a group" here is only "tabs that belong together".
 *
 *   1. **An arrangement reaching across a set boundary goes** — tabs in two groups, or some in a
 *      group and some in none. R10 says all tabs of an arrangement share one group or none, and
 *      the old automation, which regrouped by settle, left files that break it. Which side should
 *      win cannot be told, so neither does: the tabs stay where they are, as ordinary tabs.
 *   2. **Of arrangements sharing a tab, the newest by `recordedAt` stays** (R4). The old
 *      supersede rule made such overlaps rare but not impossible — a collapsed group protected
 *      the older one. On a tie the later entry wins, as it was the later written.
 *
 * An arrangement wholly inside a collapsed group stays: collapsing is not a boundary, and the
 * model does not know about it. Idempotent — a second pass finds nothing left to drop.
 */
export function reconcileArrangements(
  arrangements: readonly Arrangement[],
  memberSets: ReadonlyArray<readonly string[]>
): Arrangement[] {
  const setOf = new Map<string, number>()
  memberSets.forEach((members, index) => {
    for (const tabId of members) setOf.set(tabId, index)
  })
  const within = arrangements.filter((arrangement) => {
    const sets = new Set(seatedTabs(arrangement.seats).map((tabId) => setOf.get(tabId) ?? -1))
    return sets.size === 1
  })

  const newestFirst = within
    .map((arrangement, index) => ({ arrangement, index }))
    .sort((a, b) => b.arrangement.recordedAt - a.arrangement.recordedAt || b.index - a.index)
  const claimed = new Set<string>()
  const kept = new Set<Arrangement>()
  for (const { arrangement } of newestFirst) {
    const tabs = seatedTabs(arrangement.seats)
    if (tabs.some((tabId) => claimed.has(tabId))) continue
    for (const tabId of tabs) claimed.add(tabId)
    kept.add(arrangement)
  }

  return cloneArrangements(within.filter((arrangement) => kept.has(arrangement)))
}

/**
 * The recordings that end with a tiling the user has put down, as opposed to one the browser put away.
 *
 * Choosing the single layout is a statement about the panes on screen: *these* are not to be tiled
 * any more. Every other way a tiling leaves the screen — a new tab taking the window, a fold, a close
 * that shrinks the grid — is the browser making room, and there the recording is the way back (R7).
 * Here it would be the opposite of what was asked: the next click on a page that had been beside the
 * one kept would put the split straight back, and "einzeln" would last exactly until the user touched
 * another tab. This is what the tiling automation used to express by leaving a group standing, and it
 * is ended the way that group should have been: every tab stays open and in the strip, and only the
 * recording that tied them together goes.
 *
 * Every recording that shares a tab with `seats` and is free to act on (`isOwnedBySeating`). It used
 * to be the set a new recording would supersede; superseding is gone (KTD2), and the set is kept for
 * the one caller that still ends a tiling by its seating until the window knows its arrangement's id.
 * Two refusals, and both are deliberate:
 *
 *   - **A recording a collapsed group still needs is kept** (R15). It is not the tiling on screen —
 *     its hidden members are in no pane — and it is the only way back the fold left the user.
 *   - **Another window's recording is kept** (R16), even if a tab id happens to coincide.
 *
 * Answers the recordings rather than a new document, because the caller forgets them one by one
 * through the store and the usual answer — nothing to end — must not reach the store at all; see
 * `ArrangementController.keep` for why a write that changes nothing still costs a publish.
 */
export function arrangementsEndedBy(
  arrangements: readonly Arrangement[],
  seats: ReadonlyArray<string | null>,
  window: WindowTabs
): Arrangement[] {
  const sets = tabSetsOf(window)
  const seated = new Set(seatedTabs(seats))
  return cloneArrangements(
    arrangements.filter((arrangement) => isOwnedBySeating(arrangement, seated, sets))
  )
}

/**
 * Drops one recording by id.
 *
 * The deliberate forget: a window applying an arrangement and then being told to keep it
 * away, or a store asked to clear one entry. Silent about an id nothing holds, because every
 * caller of this is reacting to something that has already happened — throwing would turn a
 * race between two windows into a crash.
 */
export function forgetArrangement(arrangements: readonly Arrangement[], id: string): Arrangement[] {
  return cloneArrangements(arrangements.filter((arrangement) => arrangement.id !== id))
}

/**
 * Reconciles a loaded document with the tabs that actually came back.
 *
 * Tab ids come from a counter that starts again at `tab-1` on every launch, so a stored
 * seating of `['tab-1', 'tab-3']` names *this* run's first and third tabs, whichever pages
 * those turn out to be. Adopting a loaded document without reconciling it would seat
 * unrelated fresh tabs into an old arrangement the moment one of them was clicked.
 *
 * The tile of a tab that did not come back is emptied rather than closed up — the same rule
 * as everywhere else `seats` is touched — and a recording that falls below
 * `MIN_ARRANGED_TILES` goes, because there is nothing left in it worth restoring.
 *
 * Takes every live tab id rather than one window's, and that is the exception to the rule the
 * header states. This runs once at session restore, before any window is showing anything,
 * and it is asking which tabs exist at all; scoping it to one window would delete the
 * recordings of every other window that had not started yet.
 */
export function retainTabs(
  arrangements: readonly Arrangement[],
  liveTabIds: readonly string[]
): Arrangement[] {
  const live = new Set(liveTabIds)
  return keepWorthwhile(
    arrangements.map((arrangement) => ({
      ...arrangement,
      seats: arrangement.seats.map((tabId) => (tabId !== null && live.has(tabId) ? tabId : null))
    }))
  )
}

// --- repair ------------------------------------------------------------------

/**
 * Makes a loaded document obey the invariants the write path maintains.
 *
 * Runs when the file is read, and heals rather than rejects — a file written by an older
 * build, edited by hand or cut short by a crash must not cost the user every arrangement
 * they have. What it fixes, and why each is a repair rather than a rejection:
 *
 *   - **A seating of the wrong length for its layout.** `2x2` and `1x4` both have four
 *     tiles, so neither the count nor the id can be inferred from the other; a short array
 *     would leave the last panes empty on restore and a long one would name tiles that do
 *     not exist. This is also where a healed layout id lands: the schema turns an
 *     unrecognised one into `1x1`, whose single tile no real recording fills, so the
 *     recording is discarded here instead of in a schema that cannot express the rule.
 *   - **One tab in two tiles.** Restoring it would move the tab into the second tile and
 *     leave the first empty, so the arrangement applied would not be the one recorded.
 *   - **Fewer than `MIN_ARRANGED_TILES` seated tabs.** See there.
 *   - **A duplicate recording id.** Two entries claiming one id are one recording as far as
 *     `forgetArrangement` is concerned; the later is dropped rather than shadowing the
 *     earlier in half the operations.
 *   - **A view that does not fit its layout.** The schema heals a missing or malformed view
 *     field to an empty value, because it cannot see the layout; here it is fitted — the
 *     layout's default dividers filled in, one sound entry per tile, the focus on a tile that
 *     exists.
 *
 * What it no longer does is cut the document to a cap. There is none (KTD3): a cap that drops
 * arrangements is an entry disappearing from the strip, and the only bound left is `retainTabs`.
 *
 * No window is involved and none can be: this runs before any window has claimed a tab, so
 * neither ownership (R16) nor hiddenness is knowable yet. Both are applied on every call
 * that acts on a recording instead, which is why they are parameters everywhere else.
 */
export function repairArrangements(arrangements: readonly Arrangement[]): Arrangement[] {
  const seen = new Set<string>()
  const repaired: Arrangement[] = []

  for (const arrangement of arrangements) {
    if (seen.has(arrangement.id)) continue
    const seats = seatsWorthKeeping(arrangement.layoutId, arrangement.seats, undefined)
    if (seats === null) continue
    seen.add(arrangement.id)
    repaired.push({
      ...arrangement,
      seats,
      ...fitArrangementView(arrangement.layoutId, arrangement)
    })
  }

  return repaired
}

/**
 * Exported because the store hands snapshots out to windows and needs the same depth.
 *
 * `seats` is the array that makes a shallow copy a bug: two documents that share it are the
 * same document as far as any restore is concerned, which is the class of defect where a
 * store's "previous" and "next" turn out to be one object. The view is copied as deep for the
 * same reason — a muted tile written into a snapshot must not reach the document.
 */
export function cloneArrangements(arrangements: readonly Arrangement[]): Arrangement[] {
  return arrangements.map((arrangement) => ({
    ...arrangement,
    seats: [...arrangement.seats],
    fractions: { ...arrangement.fractions },
    tileAudio: arrangement.tileAudio.map((audio) => ({ ...audio }))
  }))
}

// --- internals ---------------------------------------------------------------

/**
 * True when this recording is the calling window's to act on, and free to act on.
 *
 * One predicate for applying and for ending by seating, so that a recording a click may not bring
 * back is not one a seating may end either — both would act on tabs that are not there.
 */
function isUnobstructed(arrangement: Arrangement, sets: WindowTabSets): boolean {
  if (!seatedTabs(arrangement.seats).every((tabId) => sets.live.has(tabId))) return false
  return !isProtectedBy(arrangement, sets.hidden)
}

/**
 * True when a seating of `seated` tabs owns this recording: it is free to act on and shares a tab.
 *
 * What choosing the single layout ends: a tab untiled on purpose is not in the arrangement it used
 * to be in any more.
 */
function isOwnedBySeating(
  arrangement: Arrangement,
  seated: ReadonlySet<string>,
  sets: WindowTabSets
): boolean {
  if (!isUnobstructed(arrangement, sets)) return false
  return seatedTabs(arrangement.seats).some((tabId) => seated.has(tabId))
}

/** `arrangementIsProtected` against a set built once by the caller. */
function isProtectedBy(arrangement: Arrangement, hidden: ReadonlySet<string>): boolean {
  return seatedTabs(arrangement.seats).some((tabId) => hidden.has(tabId))
}

/** A window's tab ids as sets, built once per public call rather than once per recording. */
interface WindowTabSets {
  live: ReadonlySet<string>
  hidden: ReadonlySet<string>
}

function tabSetsOf(window: WindowTabs): WindowTabSets {
  return { live: new Set(window.liveTabIds), hidden: new Set(window.hiddenTabIds) }
}

/**
 * True when one of these seats names a tab that another arrangement already seats (R4).
 *
 * `except` is the arrangement being changed, whose own seats are of course not "another". Every
 * arrangement counts, whichever window it belongs to and whether a collapsed group hides it:
 * a tab id is unique across windows, and hiding a tab does not take it out of its arrangement.
 */
function seatsHeldElsewhere(
  arrangements: readonly Arrangement[],
  seats: ReadonlyArray<string | null>,
  except: string | undefined
): boolean {
  const held = new Set(
    arrangements
      .filter((arrangement) => arrangement.id !== except)
      .flatMap((arrangement) => seatedTabs(arrangement.seats))
  )
  return seatedTabs(seats).some((tabId) => held.has(tabId))
}

/**
 * A view made to fit its layout, from whatever a caller or a file brought.
 *
 * Every field is fitted rather than trusted, because each can arrive from a different layout: a
 * patch that changes `2x2` to `1x2` carries four sound entries and a horizontal divider the new
 * layout does not have. Dividers go through `withDefaults`, the split view's own rule, so a stored
 * arrangement holds exactly the dividers `SplitController` would. Missing sound is loud, and a
 * focus beyond the last tile lands on the last one — the one nearest to where it was.
 */
export function fitArrangementView(
  layoutId: LayoutId,
  view: Partial<ArrangementView>
): ArrangementView {
  const count = TILE_COUNT[layoutId]
  const wanted = view.activeTile ?? 0
  const activeTile = Number.isFinite(wanted) ? Math.trunc(wanted) : 0
  return {
    activeTile: Math.min(Math.max(activeTile, 0), count - 1),
    fractions: { ...withDefaults(layoutId, view.fractions ?? {}) },
    tileAudio: Array.from({ length: count }, (_, index) => ({
      ...(view.tileAudio?.[index] ?? LOUD)
    }))
  }
}

/**
 * A seating a document may legally carry, or `null` when what it was handed is not one.
 *
 * The single gate. Everything that can put seats into the document goes through it — a new
 * recording, a session reconciliation, a file read off disk — so there is one account of what
 * makes an arrangement usable rather than three that can disagree.
 *
 * `live` is the calling window's tabs where there is a calling window, and `undefined` on the
 * paths that run before any window owns a tab. Not defaulted to "everything": a caller that
 * forgot to pass a window would then silently record another window's tabs, which is the
 * exact failure R16 names.
 *
 * Returns a copy, so a stored seating is never an array a caller still holds.
 */
function seatsWorthKeeping(
  layoutId: LayoutId,
  seats: ReadonlyArray<string | null>,
  live: ReadonlySet<string> | undefined
): Array<string | null> | null {
  if (seats.length !== TILE_COUNT[layoutId]) return null

  const seated = new Set<string>()
  for (const tabId of seats) {
    if (tabId === null) continue
    if (seated.has(tabId)) return null
    if (live !== undefined && !live.has(tabId)) return null
    seated.add(tabId)
  }

  return seated.size < MIN_ARRANGED_TILES ? null : [...seats]
}

/** The recordings of a reconciled document that are still arrangements. */
function keepWorthwhile(arrangements: readonly Arrangement[]): Arrangement[] {
  const kept: Arrangement[] = []
  for (const arrangement of arrangements) {
    const seats = seatsWorthKeeping(arrangement.layoutId, arrangement.seats, undefined)
    if (seats !== null) kept.push({ ...arrangement, seats })
  }
  // Deep, because the view would otherwise be shared between the document handed in and the one
  // handed back — the "previous and next are one object" defect `cloneArrangements` describes.
  return cloneArrangements(kept)
}
