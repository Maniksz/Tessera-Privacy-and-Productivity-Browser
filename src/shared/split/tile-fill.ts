import type { LayoutId } from './layout.js'

/**
 * Filling a fresh layout, and cleaning up after it.
 *
 * Choosing a four-tile layout while holding one tab used to leave three panes showing "drag a
 * tab here" — a layout that does not yet do anything, and an instruction rather than a
 * browser. So empty tiles get a start-page tab of their own.
 *
 * That creates a problem worth naming: each of those tabs is a renderer process, and spec 2
 * requires shrinking a layout to *unassign* tabs rather than close them. Applied literally,
 * every trip through a wide layout would leave unused start pages behind in the tab strip
 * forever.
 *
 * The resolution is to distinguish the two kinds of tab. A tab the browser opened by itself,
 * that the user never navigated anywhere, was never a tab the user asked for — closing it
 * loses nothing. Spec 2's rule keeps its full force for everything else, which is what it was
 * written to protect.
 *
 * Pure so both rules can be tested directly rather than only through a running window.
 */

/**
 * The arrangement one tile smaller than `layout`, or null when it is already a single view.
 *
 * Closing a tab in a split layout used to leave the tile behind, empty, waiting to be filled.
 * The tile the tab was in should go with it — that is what "close" means for the thing you were
 * looking at. Which arrangement follows is a choice, not arithmetic: four tiles step down to the
 * three-tile layout rather than to two columns, because that keeps the most of what was on
 * screen.
 *
 * A row of columns stays a row for the same reason. `1x4` steps to `1x3`, not to the `1+2`
 * shape that also has three tiles: someone who arranged four views side by side was after the
 * arrangement, not the count, and rearranging it on a tab close would be the browser
 * reshaping a window nobody asked it to touch.
 */
export function shrunkLayout(layout: LayoutId): LayoutId | null {
  switch (layout) {
    case '2x2':
      return '1+2'
    case '1+2':
      return '1x2'
    case '1x4':
      return '1x3'
    case '1x3':
      return '1x2'
    case '1x2':
    case '2x1':
      return '1x1'
    case '1x1':
      return null
  }
}

/** Tiles with no tab in them, in order. */
export function emptyTiles(tileTabIds: ReadonlyArray<string | null>): number[] {
  return tileTabIds.flatMap((tabId, index) => (tabId === null ? [index] : []))
}

/**
 * Which of the tabs that just lost their tile should be closed rather than kept.
 *
 * Only the browser's own untouched fillers. A tab the user navigated, or opened themselves,
 * is never in `ephemeral` and therefore never closed here.
 */
export function tabsToCloseOnShrink(
  orphaned: readonly string[],
  ephemeral: ReadonlySet<string>
): string[] {
  return orphaned.filter((tabId) => ephemeral.has(tabId))
}
