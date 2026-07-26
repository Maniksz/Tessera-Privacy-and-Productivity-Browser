/**
 * Tab ids, and the one arithmetic that has to survive a restart.
 *
 * ## The collision this file exists to prevent
 *
 * A tab id comes from a counter in `src/main/browser/Tab.ts` that starts again at
 * `tab-1` on every launch. That is harmless while nothing outlives the process — and
 * the moment session restore brings a tab back it stops being harmless, because a
 * restored tab has to carry **the id it had**. Anything else and a stored tab group
 * naming `['tab-1', 'tab-3']` still cannot be reattached, which is the whole reason
 * `retainTabs` is called with nothing today.
 *
 * Bringing the old ids back creates the opposite danger, and it is much worse than the
 * bug it fixes: restore `tab-1` … `tab-9`, then let the counter hand out `tab-1` for the
 * next new tab, and two different pages answer to one id. Every id-keyed thing in the
 * browser then disagrees quietly — `SplitController` puts the wrong page in a tile,
 * `TabGroupController` groups the wrong tab, the drag controller drops the wrong one,
 * and `closeTab` destroys whichever the map happens to hold. No error, no warning, and
 * no way for a user to describe what happened.
 *
 * So the counter has to be raised past every id that comes back, and the raising has to
 * be impossible to forget. `Tab.ts` therefore exposes `adoptTabId` — a function that
 * *is* the reservation — rather than a `reserve` call that must happen before the first
 * `createTab`. Ordering rules are conventions; a function that does both is an
 * invariant.
 *
 * ## Why the two halves live here rather than beside the counter
 *
 * `Tab.ts` cannot run outside a browser process and is excluded from coverage for that
 * reason, so anything decided in it is decided where no unit test can see it. The
 * format of an id and the sequence it belongs to are pure arithmetic, so they sit here
 * and the file with the counter keeps three lines: `+= 1`, `tabIdForSequence`,
 * `Math.max(sequence, sequenceOfTabId(id))`.
 *
 * Both functions read the same prefix constant. Written twice they would agree today
 * and drift the first time anyone renamed the prefix — and a `sequenceOfTabId` that
 * stopped recognising the ids `tabIdForSequence` produces would silently return 0 for
 * every restored id, which is exactly the collision above with the guard still in place.
 */

/** The one place the shape of a tab id is written down. */
const TAB_ID_PREFIX = 'tab-'

/**
 * Derived from the prefix rather than spelled out, so the pattern cannot stop matching
 * the ids the generator produces. Built once: a fresh `RegExp` per id would be a
 * needless allocation on a path a restore walks for every tab.
 */
const TAB_ID_PATTERN = new RegExp(`^${TAB_ID_PREFIX}\\d+$`)

/** The id belonging to a counter value. `nextTabId()` in `Tab.ts` is this plus `+= 1`. */
export function tabIdForSequence(sequence: number): string {
  return `${TAB_ID_PREFIX}${sequence}`
}

/**
 * The counter value an id came from, or 0 when it did not come from this counter.
 *
 * Total on purpose, and 0 is the safe answer in both odd cases:
 *
 *   - A **hand-edited or foreign id** (`tab-abc`, `restored-7`) contributes nothing to
 *     the high-water mark — and it cannot collide either, because every id the counter
 *     produces ends in digits.
 *   - A **number too large to count with** (`tab-` followed by twenty digits) also
 *     yields 0. Returning it would set the counter to an unsafe integer, where `+= 1`
 *     stops changing the value and the *next* two fresh tabs would share an id — the
 *     failure this module exists to prevent, reintroduced by the guard against it.
 *     Nothing legitimate reaches that magnitude, and no fresh id can equal such an id
 *     anyway, since the counter would have to pass through every value below it first.
 */
export function sequenceOfTabId(id: string): number {
  if (!TAB_ID_PATTERN.test(id)) return 0
  const value = Number(id.slice(TAB_ID_PREFIX.length))
  return Number.isSafeInteger(value) ? value : 0
}
