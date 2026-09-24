import { TILE_COUNT, type LayoutId, type Rect } from './layout.js'

/**
 * Tile headers (U20, R34, KTD14): a strip above each tile's page with its favicon and title.
 *
 * ## The header takes its room from the page
 *
 * A native view sits above the chrome renderer, so DOM drawn over a view is never seen. The header is
 * therefore not laid *on* the page: the view is moved down by the header's height and made that much
 * shorter, and the chrome draws the header in the strip the view gave up. That is why this is a
 * question of view geometry rather than of decoration, and why it lives beside `layout.ts`.
 *
 * ## One function for both sides
 *
 * The core places the views with it (`SplitController.tiles`, through `planViews`) and the renderer
 * draws the headers and the failure panels with it (`useTileRects`). Two derivations of one rectangle
 * drift — `chrome-insets.ts` records the time they did, and the divider handles ended up under the
 * views. So neither side knows the height; both ask here.
 *
 * ## Where there is none
 *
 * A single tile has the toolbar above it, which already is its header. A maximised tile shows one page
 * the way `1x1` does. A page in fullscreen inside its tile fills that tile, and only that tile loses its
 * header: the other tiles stay visible and keep playing (spec 2), so their views do not move either.
 *
 * The minimum tile size is the tile's, header included. A divider stops where it stopped before this
 * existed, and the page gets what is left.
 *
 * Zod-free: the chrome renderer imports it at runtime.
 */

/** Height of the strip, in px. */
export const TILE_HEADER_HEIGHT = 28

/** What decides whether tiles carry a header. A subset of `SplitState` and of `SplitController`. */
export interface TileHeaderSplit {
  readonly layout: LayoutId
  readonly maximizedTile: number | null
  readonly fullscreenTile: number | null
}

/** Whether each tile of the layout carries a header, one flag per tile. */
export function tileHeaders(enabled: boolean, split: TileHeaderSplit): boolean[] {
  const count = TILE_COUNT[split.layout]
  const shown = enabled && count > 1 && split.maximizedTile === null
  return Array.from({ length: count }, (_, index) => shown && index !== split.fullscreenTile)
}

/** The strip at the top of a tile the header is drawn in; never taller than the tile. */
export function headerRectOf(tile: Rect): Rect {
  return {
    x: tile.x,
    y: tile.y,
    width: tile.width,
    height: Math.min(TILE_HEADER_HEIGHT, tile.height)
  }
}

/**
 * Where a tile's view goes: below its header when it has one.
 *
 * Without one the tile rectangle itself comes back, not a copy — with the setting off, nothing about
 * the layout the views get may differ from what it was before headers existed.
 */
export function viewRectOf(tile: Rect, header: boolean): Rect {
  if (!header) return tile
  const strip = headerRectOf(tile).height
  return { x: tile.x, y: tile.y + strip, width: tile.width, height: tile.height - strip }
}

/**
 * Every tile's view rectangle, `null` staying `null` for a collapsed tile.
 *
 * A tile without a flag has no header: fewer flags than tiles is read as "none", never guessed at.
 */
export function viewRects(
  tiles: ReadonlyArray<Rect | null>,
  headers: readonly boolean[]
): Array<Rect | null> {
  return tiles.map((tile, index) =>
    tile === null ? null : viewRectOf(tile, headers[index] === true)
  )
}
