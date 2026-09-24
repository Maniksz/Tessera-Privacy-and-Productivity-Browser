import {
  stripEntries,
  stripItems,
  type StripArrangement,
  type StripEntry
} from '@shared/strip/model.js'
import type { TabGroup } from '@shared/tabgroups/model.js'

/**
 * Which tab a positional key names (spec 9).
 *
 * `Control+1` … `Control+8` — `Command+1` … `Command+8` on macOS — and `Control+9` for the last one.
 * `TAB_BY_INDEX_ACCELERATORS` has held those eight strings since the binding table was written, and
 * until now nothing in `src/` read the table at all: it existed, a test checked that it had eight
 * entries, and it hung on nothing.
 *
 * ## Position in the strip, which is not the same as any of the three near misses
 *
 * A positional key means "the third tab from the left", and three other orders are close enough to
 * pass a casual reading:
 *
 *   - **Not the tile index.** In a 2x2 layout four of perhaps nine tabs are in tiles, and `Control+3`
 *     would then name a pane rather than a tab — and mean nothing at all for the tabs that are in no
 *     tile.
 *   - **Not creation order.** `#tabOrder` is what dragging a tab rewrites, and creation order is what
 *     the map's insertion order happens to hold.
 *   - **Not `#tabOrder` either, quite.** Two things sit between it and the strip: a group is drawn as
 *     one run of tabs (`contiguousOrder`, applied on every broadcast), and a *collapsed* group's tabs
 *     are still in that order while not being drawn at all.
 *
 * The second of those is not a nicety. `activateTab` on a tab that has no tile puts it in one, so a
 * positional key that counted a collapsed group's hidden members would open a page in a pane with
 * nothing in the strip to close it, mute it or switch away from it — precisely the state
 * `TabGroupController.setCollapsed` gives up a tile to avoid. Counting what the strip draws is
 * therefore the difference between a key that selects the wrong tab and a key that produces a pane the
 * user cannot get rid of.
 */

/** A one-based place in the strip, or its last drawn tab — `Control+9` rather than `Control+1`…`8`. */
export type StripPosition = number | 'last'

/**
 * The entry at a position, counting entries rather than tabs (U5, R13) — or `null` when the strip is
 * shorter than that.
 *
 * A tiled view is one entry, so it is one position: with X, the view A and Y drawn, `Control+3` is Y.
 * Counting its members would make the key land on the second page of a view as though it had a place
 * of its own. The chips are not positions and a folded group's members are not drawn, both as above.
 *
 * The entry comes back whole rather than as a tab, so the window can tell a view from a page. Landing
 * on either is activating `focusTabOf(entry)` — for a view, the member of its active tile, which is
 * how a put-away view comes back with that tile focused (R4). The order goes through the strip model,
 * so the key counts exactly what the strip draws from the same inputs.
 */
export function entryForStripPosition(
  order: readonly string[],
  groups: readonly TabGroup[],
  arrangements: readonly StripArrangement[],
  position: StripPosition
): StripEntry | null {
  const entries = stripEntries(stripItems(order, groups, arrangements))
  const index = position === 'last' ? entries.length - 1 : position - 1
  /*
    Before the slice, and not merely tidiness: `slice(-1, 0)` is empty but `slice(-2, -1)` is the
    second-to-last element, so a position below one would count backwards from the right-hand end
    instead of answering "not there". `last` on an empty strip arrives here too.

    `null` for a position past the end rather than the last entry: `Control+5` with three entries is a
    key for something that is not there, and every browser that has this feature does nothing.
  */
  if (index < 0) return null
  const [entry] = entries.slice(index, index + 1)
  return entry ?? null
}
