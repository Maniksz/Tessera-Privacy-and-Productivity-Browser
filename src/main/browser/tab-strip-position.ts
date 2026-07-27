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
 * The tab at a position, or `null` when the strip is shorter than that.
 *
 * `null` for a position past the end rather than the last tab: `Control+5` with three tabs open is a
 * key for a tab that is not there, and every browser that has this feature does nothing. Clamping
 * would make one key mean two different tabs depending on how many are open.
 *
 * `hiddenByCollapse` is the ids `tabsHiddenByCollapse` reports — the same shared function the strip
 * hides them with, so the two cannot disagree about what is on screen.
 */
export function tabForStripPosition(
  displayOrder: readonly string[],
  hiddenByCollapse: readonly string[],
  position: StripPosition
): string | null {
  const away = new Set(hiddenByCollapse)
  const drawn = displayOrder.filter((tabId) => !away.has(tabId))

  const index = position === 'last' ? drawn.length - 1 : position - 1
  /*
    Before the slice, and not merely tidiness: `slice(-1, 0)` is empty but `slice(-2, -1)` is the
    second-to-last element, so a position below one would count backwards from the right-hand end
    instead of answering "not there". `last` on an empty strip arrives here too.
  */
  if (index < 0) return null
  // A slice rather than an index and a null check, so a position past the end has one answer instead
  // of a second branch that says the same thing.
  const [tabId] = drawn.slice(index, index + 1)
  return tabId ?? null
}
