import { TILE_COUNT, type LayoutId } from '../split/layout.js'

/**
 * Arrangements — the tiling a window has put away, kept so a click can bring it back.
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
 *   - **which tabs the calling window owns** — without it, one window's settle would evict
 *     another window's recording and a click in one window could re-tile the other (R16);
 *   - **which tabs the strip is currently hiding**, because their group is collapsed —
 *     without it, a recording would be applied over tabs that are not there to be seated
 *     (R14) and would be evicted while the user is still one click from wanting it (R15).
 *
 * Both arrive as sets of tab ids, never as groups. Hiddenness is a fact about tabs here,
 * not a capability to ask about groups: `WindowTabs` is the entire vocabulary this module
 * has for the world outside it.
 *
 * ## Why protection is computed and never stored
 *
 * A `protected` flag on a recording would be written when a group collapses and would have
 * to be cleared on every path that can make a tab visible again — expanding, leaving the
 * group, dissolving it, closing the tab. Miss one and the recording is protected for ever,
 * and the cap then fills with entries nothing may evict, which is the failure mode a cap
 * exists to prevent. Derived from the hidden set on every call it cannot go stale: the
 * protection ends the moment the tabs come back, with nothing to clear (KTD8).
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
 * Recordings kept at most, across every ordinary window.
 *
 * This number is load-bearing rather than hygiene. It replaces the back-pressure that
 * `MAX_TAB_GROUPS` used to apply through `groupToHoldArrangement`: a recording no longer
 * costs a chip in the strip, so nothing else in the design pushes back on making them, and
 * without a cap a long session would grow the document without bound.
 *
 * Thirty-two, and the two rejected numbers say what it is balancing:
 *
 *   - **Not fifty**, the group cap. A group is visible and the user can dissolve one; a
 *     recording is invisible, so the only thing that keeps the document from becoming
 *     clutter is that the oldest fall off. A cap the user cannot see should be the smallest
 *     one that never bites.
 *   - **Not eight**, which would be small enough to bite. The document is shared by every
 *     ordinary window, so the cap is spent by all of them together, while eviction is
 *     confined to the caller's own window (R16). At eight, three windows tiling in turn
 *     would push one another's recordings out within a few minutes.
 *
 * Thirty-two recordings mean at least sixty-four tabs have been tiled and put away in one
 * session — well past any believable window, and reached at all only by a caller with a bug
 * or a hand-edited file, which is what the cap is here to bound.
 */
export const MAX_ARRANGEMENTS = 32

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
 */
export interface Arrangement {
  id: string
  layoutId: LayoutId
  /** Tab id per tile, `null` for an empty tile. Exactly `TILE_COUNT[layoutId]` entries. */
  seats: Array<string | null>
  recordedAt: number
}

/**
 * What a caller proposes to record.
 *
 * The same fields as an `Arrangement`, and deliberately not the same type: this one has not
 * been through the rules yet. Identity and time are on it because the pure layer must not
 * invent either — that is the division `TabGroupStore` already uses, and it is what lets
 * every test in this module assert on exact objects.
 */
export interface ArrangementDraft {
  id: string
  layoutId: LayoutId
  seats: ReadonlyArray<string | null>
  recordedAt: number
}

export interface ArrangementDocument {
  version: 1
  /**
   * Newest last, which is the order `recordArrangement` appends in. Nothing reads it as a
   * ranking: eviction sorts by `recordedAt` so that a document written by an older build,
   * or repaired after a crash, cannot make the wrong entry the oldest.
   */
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
  return { version: 1, arrangements: [] }
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
 * a field is in the header. Both protections in this file are this predicate: a protected
 * recording is not evicted (R15) and is not applied (R14). The two rules are one condition
 * because they are the same fact — a recording that cannot be applied must not be thrown
 * away either, or collapsing a group would quietly destroy the arrangement the user is
 * about to expand back into.
 */
export function arrangementIsProtected(
  arrangement: Arrangement,
  hiddenTabIds: readonly string[]
): boolean {
  const hidden = new Set(hiddenTabIds)
  return seatedTabs(arrangement.seats).some((tabId) => hidden.has(tabId))
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
  return arrangements.find(
    (arrangement) => arrangement.seats.includes(tabId) && isUnobstructed(arrangement, window)
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

// --- writes ------------------------------------------------------------------

/**
 * Records a tiling the window has just put away, and makes room for it if it has to.
 *
 * Three decisions in one pass, in the order they have to happen:
 *
 *   1. **Is this worth recording at all** — `seatsWorthKeeping`. A draft naming a tab the
 *      calling window does not own is refused rather than trimmed: it means the caller has
 *      mixed up two windows, and recording the remainder would write down an arrangement
 *      that never existed.
 *   2. **What does it supersede** — every recording sharing a seated tab with it, provided
 *      that recording may be touched at all. A tab that has just been re-tiled is not in the
 *      arrangement it used to be in, so leaving the old recording would offer the user a way
 *      back that puts the tab in two places.
 *   3. **Does it fit** — the cap, evicting oldest first until it does.
 *
 * When nothing may be evicted the answer is **to record nothing**, not to evict a protected
 * recording. That direction is the one worth arguing: the alternative sacrifices a recording
 * the user is one expand away from wanting, in order to keep one they can rebuild with a
 * drag they have just performed. Refusing costs the newest arrangement, which is also the
 * one still on screen; the next settle after any expand records it again.
 *
 * Always returns a fresh array of fresh recordings, including when it changes nothing, so no
 * caller can mutate a stored document through the value it was handed.
 */
export function recordArrangement(
  arrangements: readonly Arrangement[],
  draft: ArrangementDraft,
  window: WindowTabs
): Arrangement[] {
  const seats = seatsWorthKeeping(draft.layoutId, draft.seats, new Set(window.liveTabIds))
  if (seats === null) return cloneArrangements(arrangements)

  const seated = new Set(seatedTabs(seats))
  let kept = arrangements.filter(
    (arrangement) =>
      !(
        isUnobstructed(arrangement, window) &&
        seatedTabs(arrangement.seats).some((tabId) => seated.has(tabId))
      )
  )

  while (kept.length >= MAX_ARRANGEMENTS) {
    const victim = oldestEvictable(kept, window)
    if (victim === undefined) return cloneArrangements(arrangements)
    kept = kept.filter((arrangement) => arrangement !== victim)
  }

  return [
    ...cloneArrangements(kept),
    { id: draft.id, layoutId: draft.layoutId, seats, recordedAt: draft.recordedAt }
  ]
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
 *   - **More recordings than the cap.** A quantity, and a quantity must never reach the
 *     schema: a validation failure replaces the whole document with defaults, so a `.max()`
 *     there would turn "grew larger than expected" into "lost every arrangement".
 *
 * No window is involved and none can be: this runs before any window has claimed a tab, so
 * neither ownership (R16) nor hiddenness is knowable yet. Both are applied on every call
 * that acts on a recording instead, which is why they are parameters everywhere else.
 */
export function repairArrangements(arrangements: readonly Arrangement[]): Arrangement[] {
  const seen = new Set<string>()
  const repaired: Arrangement[] = []

  for (const arrangement of arrangements) {
    if (repaired.length >= MAX_ARRANGEMENTS) break
    if (seen.has(arrangement.id)) continue
    const seats = seatsWorthKeeping(arrangement.layoutId, arrangement.seats, undefined)
    if (seats === null) continue
    seen.add(arrangement.id)
    repaired.push({ ...arrangement, seats })
  }

  return repaired
}

/**
 * Exported because the store hands snapshots out to windows and needs the same depth.
 *
 * `seats` is the array that makes a shallow copy a bug: two documents that share it are the
 * same document as far as any restore is concerned, which is the class of defect where a
 * store's "previous" and "next" turn out to be one object.
 */
export function cloneArrangements(arrangements: readonly Arrangement[]): Arrangement[] {
  return arrangements.map((arrangement) => ({ ...arrangement, seats: [...arrangement.seats] }))
}

// --- internals ---------------------------------------------------------------

/**
 * True when this recording is the calling window's to act on, and free to act on.
 *
 * One predicate for two rules on purpose — see `arrangementIsProtected`. A caller asking
 * "may I apply this" and a caller asking "may I evict this" are asking the same question,
 * and answering them from one place is what stops the two from drifting into a state where
 * a recording can be destroyed but not used.
 */
function isUnobstructed(arrangement: Arrangement, window: WindowTabs): boolean {
  const live = new Set(window.liveTabIds)
  if (!seatedTabs(arrangement.seats).every((tabId) => live.has(tabId))) return false
  return !arrangementIsProtected(arrangement, window.hiddenTabIds)
}

/**
 * The recording that has been in the document longest and may be thrown away, or nothing.
 *
 * Oldest first, chosen over newest first and over "the one sharing fewest tabs": the age of a
 * recording is the only evidence this module has about what the user has stopped caring
 * about, and it is evidence the user can act on — anything they have used recently was
 * re-recorded by the settle that followed.
 *
 * `undefined` is a real answer, not a failure. Every recording in the document can be
 * protected or foreign at once, and the caller's response is to record nothing.
 */
function oldestEvictable(
  arrangements: readonly Arrangement[],
  window: WindowTabs
): Arrangement | undefined {
  return arrangements
    .filter((arrangement) => isUnobstructed(arrangement, window))
    .reduce<Arrangement | undefined>(
      (oldest, arrangement) =>
        oldest === undefined || arrangement.recordedAt < oldest.recordedAt ? arrangement : oldest,
      undefined
    )
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
  return kept
}
