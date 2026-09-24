import { isHomeUrl } from '../url/omnibox.js'
import { TILE_COUNT, type LayoutId } from './layout.js'

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
 * A second, wider rule sits beside it since tiled views became entries in the strip (R8, KTD8): when
 * the user changes a view to fewer tiles or ends it, every tile showing the start page closes,
 * whoever opened it (`isStartPageTile`, `planShrink`). It is the user's decision about the panes, so
 * it applies only there — putting a view away, folding its group or closing one of its tabs keeps
 * every start page in it.
 *
 * Pure so the rules can be tested directly rather than only through a running window.
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

/**
 * The smallest arrangement down the shrink chain that still has room for `occupants`.
 *
 * Written as "how few panes will do" rather than "one step per closed tab", although the two agree
 * whenever the view had no empty pane before the close. The difference is one that had: a seat whose
 * tab closed while the view was put away comes back empty, and counting steps would leave it standing
 * beside the pane the close emptied, with nothing ever to fill it now that no loaded tab is pulled in
 * (KTD10). `1x1` is the floor, so a window with nothing left in a tile still has one to put something
 * back into.
 *
 * Here rather than beside its first caller, `closeRanks`, because a chosen smaller layout asks the
 * same question once its start pages are gone (`planShrink`). Every step of the chain removes exactly
 * one tile, so this terminates on any layout.
 */
export function layoutFitting(layout: LayoutId, occupants: number): LayoutId {
  let current = layout
  for (;;) {
    const smaller = shrunkLayout(current)
    if (smaller === null || TILE_COUNT[smaller] < Math.max(occupants, 1)) return current
    current = smaller
  }
}

/** What a tile shows, as far as "is this a start page?" needs to know. */
export interface TileContent {
  /** The address the page has committed to, `''` before its first navigation commits. */
  committedUrl: string
  loading: boolean
  /** An address asked for and not yet loaded, `null` when nothing is on its way. */
  pendingInput: string | null
}

/**
 * True for a tile that is showing the start page and nothing else (KTD8).
 *
 * The one test for which tiles changing or ending a tiled view closes (R8). Deliberately about what
 * the tile shows rather than who opened it: a start page the user opened and one the browser filled a
 * pane with look the same, and a rule the user cannot see the difference of is not one they can
 * predict (session-settled). That is why this is not `ephemeral`, which is only the browser's own.
 *
 * All three parts, because a tile on its way somewhere is not a start page yet. An empty address with
 * its first navigation running, or a start page with an address typed into it, is a page arriving,
 * and closing it would lose that page. Home is `isHomeUrl`'s, so an empty address and `about:blank`
 * count as the address bar already counts them.
 */
export function isStartPageTile(tile: TileContent): boolean {
  return isHomeUrl(tile.committedUrl) && !tile.loading && tile.pendingInput === null
}

/** How a tiled view becomes a smaller one, or ends; see `planShrink`. */
export interface ShrinkPlan {
  /** The start pages, in tile order. They close. */
  close: string[]
  /** Every other page, in tile order: the ones seated and then the ones freed. */
  remaining: string[]
  /** Who sits where afterwards, from the first tile, with no gap. */
  seats: string[]
  /** The pages that find no tile and become ordinary tabs, in tile order. */
  freed: string[]
  /** The layout it ends in. `1x1` means the tiled view is over. */
  layout: LayoutId
  /** The page active afterwards, or `null` when no page is left. */
  active: string | null
}

/**
 * Changing a tiled view to fewer tiles, or ending it (R8, KTD8), as a plan the window carries out.
 *
 * In the order the plan names: the start pages close, the other pages move up into the leading tiles
 * in tile order, and the layout is the smallest that fits them on the way down from the one chosen
 * (`layoutFitting`) — so choosing three tiles for two pages gives two, rather than one pane the next
 * fill would give a fresh start page. What finds no tile is freed, an ordinary tab from then on.
 *
 * Fewer than two pages left is no tiled view, and the plan ends in one pane like the choice of `1x1`
 * does. Ending shows the active page if it survives and the first remaining one otherwise, so the page
 * the user was looking at is the one still in front of them (AE3). A smaller split keeps the active
 * page active when it still has a tile, and makes the first one active when not.
 *
 * Pure over the seating and a predicate, so the same plan serves a view on screen and one put away,
 * whose stored seats are all it has (KTD12).
 */
export function planShrink(
  seats: ReadonlyArray<string | null>,
  isStartPage: (tabId: string) => boolean,
  target: LayoutId,
  activeTabId: string | null = null
): ShrinkPlan {
  const occupants = seats.filter((tabId): tabId is string => tabId !== null)
  const close = occupants.filter((tabId) => isStartPage(tabId))
  const remaining = occupants.filter((tabId) => !isStartPage(tabId))
  const layout = layoutFitting(target, remaining.length)
  const survivor = activeTabId !== null && remaining.includes(activeTabId) ? activeTabId : null
  // One pane shows the page the user was looking at; more fill up from the first tile.
  const seated =
    layout === '1x1' && survivor !== null ? [survivor] : remaining.slice(0, TILE_COUNT[layout])
  return {
    close,
    remaining,
    seats: seated,
    freed: remaining.filter((tabId) => !seated.includes(tabId)),
    layout,
    active: survivor !== null && seated.includes(survivor) ? survivor : (seated[0] ?? null)
  }
}

/**
 * The strip order with `run` standing where a tiled view's entry stood, in the order given.
 *
 * Where the entry stood is where its first member is in the strip (KTD6), so the pages of a view that
 * ended or shrank stay in the place the user knew it by, in tile order, and a page that found no tile
 * is right behind the view it left (R8). `members` are every tab the view held, including the start
 * pages about to close: the first of them may be one, and the place is the entry's, not the first
 * surviving page's.
 *
 * Only tabs the strip holds are moved, so a run naming one that is gone cannot bring it back.
 */
export function orderWithRunAtEntry(
  order: readonly string[],
  members: readonly string[],
  run: readonly string[]
): string[] {
  const memberSet = new Set(members)
  const entry = order.findIndex((tabId) => memberSet.has(tabId))
  if (entry === -1) return [...order]
  const placed = run.filter((tabId) => order.includes(tabId))
  const moving = new Set(placed)
  const rest = order.filter((tabId) => !moving.has(tabId))
  const before = order.slice(0, entry).filter((tabId) => !moving.has(tabId)).length
  return [...rest.slice(0, before), ...placed, ...rest.slice(before)]
}
