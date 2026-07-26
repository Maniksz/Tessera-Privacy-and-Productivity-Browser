import type { FindBarPresentation } from '../overlay/surface.js'
import type { Rect } from '../ui/anchor.js'
import type { FindSession } from './session.js'

/**
 * Where a find bar sits, and when a tile cannot have one.
 *
 * ## Why a box in a corner rather than a strip across the tile
 *
 * The overlay layer swallows every pointer event inside its own bounds — that is the price of being
 * the only layer above the page — so the bar's rectangle is subtracted from the page underneath for
 * as long as it is up. A strip the full width of the tile, like the tile navigation bar's, would
 * take a band of the page out of use while the user is reading the very text they searched for, and
 * a band across the top is where a heading or a site's own navigation usually is. A box in the
 * top-right corner costs a few hundred square pixels of one tile.
 *
 * It is anchored to the *searched* tile rather than to the window for a reason the split view makes
 * unavoidable: with four pages on screen, a bar floating in the window's corner would not say which
 * of them it is counting matches in.
 *
 * Pure, so "the bar is inside the tile it belongs to" is a test rather than a claim.
 */

/** Tall enough for a field and three buttons, and the same height as the tile navigation bar. */
export const FIND_BAR_HEIGHT = 40

/** Wide enough for a search term, a count and the buttons, without covering a quarter of the page. */
export const FIND_BAR_WIDTH = 320

/**
 * The gap between the bar and the tile's edges.
 *
 * Not decoration: it is what makes the bar legible as an object floating over the page rather than
 * as part of it, and it keeps the bar clear of the tile's own border in a split layout.
 */
export const FIND_BAR_INSET = 8

/**
 * The bar's rectangle inside a tile, in whatever space the tile rectangle is given in.
 *
 * Both dimensions are clamped to what the tile can actually hold, and clamped to the *inset* tile
 * rather than the whole one. That is what keeps the bar inside its own tile at every window size:
 * clamped to the full width, a narrow tile would put the bar's left edge over its neighbour, which
 * is the one thing a per-tile surface may never do.
 *
 * A tile too small to hold anything yields a zero-sized rectangle, which `findBarPresentation`
 * refuses rather than putting an invisible surface on the layer.
 */
export function findBarBounds(tileRect: Rect): Rect {
  const available = {
    width: Math.max(0, tileRect.width - FIND_BAR_INSET * 2),
    height: Math.max(0, tileRect.height - FIND_BAR_INSET * 2)
  }
  const width = Math.min(FIND_BAR_WIDTH, available.width)
  const height = Math.min(FIND_BAR_HEIGHT, available.height)
  return {
    // Right-aligned, so the bar grows away from the page's text column rather than across it.
    x: tileRect.x + tileRect.width - width - FIND_BAR_INSET,
    y: tileRect.y + FIND_BAR_INSET,
    width,
    height
  }
}

/**
 * The bar for one search, or `null` when there is nowhere to put it.
 *
 * Two ways to have no bar, both ordinary rather than exceptional:
 *
 *  - the searched tab holds no tile, which is what a tab reassigned or displaced under an open bar
 *    looks like. A bar over a page that is no longer on screen would be counting matches in
 *    something invisible;
 *  - the tile is too small to hold the bar, which a grid computed before the first paint produces.
 *    Presented anyway, it would be a zero-sized surface holding the layer against everything else.
 */
export function findBarPresentation(input: {
  session: FindSession
  /** The tile the searched tab occupies, or `null` for a tab that is loaded but off screen. */
  tileIndex: number | null
  /** The searched tab's own rectangle — the tile it fills — in window coordinates. */
  tileRect: Rect
}): FindBarPresentation | null {
  const { tileIndex } = input
  if (tileIndex === null) return null

  const bounds = findBarBounds(input.tileRect)
  if (bounds.width <= 0 || bounds.height <= 0) return null

  const { session } = input
  return {
    kind: 'find-bar',
    sessionId: session.sessionId,
    tileIndex,
    bounds,
    tabId: session.tabId,
    query: session.query,
    matches: session.matches,
    activeMatch: session.activeMatch
  }
}
