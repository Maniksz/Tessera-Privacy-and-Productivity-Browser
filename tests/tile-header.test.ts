import { describe, expect, it } from 'vitest'
import {
  TILE_HEADER_HEIGHT,
  headerRectOf,
  tileHeaders,
  viewRectOf,
  viewRects
} from '@shared/split/tile-header.js'
import {
  LAYOUT_IDS,
  MIN_TILE_SIZE,
  TILE_COUNT,
  TILE_GUTTER,
  computeTileRects,
  type Rect
} from '@shared/split/layout.js'

/**
 * Tile headers (U20, R34, KTD14): a strip above each tile's page with its favicon and title.
 *
 * The header takes its height *from* the page rather than covering it, so what is really being decided
 * here is where the view goes. The core places the native views with this and the renderer draws the
 * header in the gap it leaves — one function, because two derivations of one rectangle drift apart
 * (`chrome-insets.ts` is the record of the last time they did).
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1600, height: 900 }
const plain = { maximizedTile: null, fullscreenTile: null } as const

describe('which tiles carry a header', () => {
  it('gives every tile of a split one when the setting is on', () => {
    for (const layout of LAYOUT_IDS) {
      if (layout === '1x1') continue
      expect(tileHeaders(true, { layout, ...plain }), layout).toEqual(
        new Array<boolean>(TILE_COUNT[layout]).fill(true)
      )
    }
  })

  it('gives none when the setting is off', () => {
    for (const layout of LAYOUT_IDS) {
      expect(tileHeaders(false, { layout, ...plain }), layout).toEqual(
        new Array<boolean>(TILE_COUNT[layout]).fill(false)
      )
    }
  })

  it('gives a single tile none: the toolbar already is its header', () => {
    expect(tileHeaders(true, { layout: '1x1', ...plain })).toEqual([false])
  })

  it('gives none while a tile is maximised, which shows one page like 1x1', () => {
    expect(tileHeaders(true, { layout: '2x2', maximizedTile: 1, fullscreenTile: null })).toEqual([
      false,
      false,
      false,
      false
    ])
  })

  it('takes it off the tile a page has put into fullscreen, and only that one', () => {
    // The other tiles stay visible and keep playing (spec 2), so their views must not move either.
    expect(tileHeaders(true, { layout: '1x2', maximizedTile: null, fullscreenTile: 1 })).toEqual([
      true,
      false
    ])
  })
})

describe('where the view goes', () => {
  const tile: Rect = { x: 10, y: 100, width: 500, height: 400 }

  it('starts the view below the header and makes it that much shorter', () => {
    expect(viewRectOf(tile, true)).toEqual({
      x: 10,
      y: 100 + TILE_HEADER_HEIGHT,
      width: 500,
      height: 400 - TILE_HEADER_HEIGHT
    })
    expect(TILE_HEADER_HEIGHT).toBe(28)
  })

  it('hands back the very tile rectangle when there is no header', () => {
    // Identity, not just equality: with the setting off nothing about today's layout may change.
    expect(viewRectOf(tile, false)).toBe(tile)
  })

  it('never lets the header reach past a tile shorter than itself', () => {
    const short: Rect = { x: 0, y: 0, width: 300, height: 20 }
    expect(headerRectOf(short)).toEqual({ x: 0, y: 0, width: 300, height: 20 })
    expect(viewRectOf(short, true)).toEqual({ x: 0, y: 20, width: 300, height: 0 })
  })

  it('puts the header exactly in the strip the view gave up', () => {
    const header = headerRectOf(tile)
    const view = viewRectOf(tile, true)
    expect(header).toEqual({ x: 10, y: 100, width: 500, height: TILE_HEADER_HEIGHT })
    expect(header.y + header.height).toBe(view.y)
    expect(header.height + view.height).toBe(tile.height)
  })

  it('shifts each view of a 2x1 down by the header and shortens it by as much', () => {
    const tiles = computeTileRects('2x1', {}, CONTENT, { gutter: TILE_GUTTER })
    const views = viewRects(tiles, tileHeaders(true, { layout: '2x1', ...plain }))
    tiles.forEach((tileRect, index) => {
      const view = views[index]!
      expect(view.x, `tile ${index}`).toBe(tileRect.x)
      expect(view.width, `tile ${index}`).toBe(tileRect.width)
      expect(view.y - tileRect.y, `tile ${index}`).toBe(TILE_HEADER_HEIGHT)
      expect(tileRect.height - view.height, `tile ${index}`).toBe(TILE_HEADER_HEIGHT)
    })
  })

  it('keeps a collapsed tile collapsed and a tile without a header flag headerless', () => {
    const tiles: Array<Rect | null> = [tile, null]
    expect(viewRects(tiles, [true, true])).toEqual([viewRectOf(tile, true), null])
    // Fewer flags than tiles reads as "no header", never as a guess.
    expect(viewRects([tile], [])).toEqual([tile])
  })

  it('leaves every tile of every layout untouched with the setting off', () => {
    for (const layout of LAYOUT_IDS) {
      const tiles = computeTileRects(layout, {}, CONTENT, { gutter: TILE_GUTTER })
      const views = viewRects(tiles, tileHeaders(false, { layout, ...plain }))
      tiles.forEach((tileRect, index) => expect(views[index], layout).toBe(tileRect))
    }
  })

  it('counts the header inside a tile held at its minimum size', () => {
    /*
      The minimum tile size is the tile's, header included. A divider dragged as far as it goes stops
      where it stopped before headers existed, and the page gets what is left rather than the tile
      growing past its minimum to make room.
    */
    const tiles = computeTileRects('2x1', { h: 0.01 }, CONTENT, { gutter: 0 })
    const [top] = tiles
    expect(top!.height).toBe(MIN_TILE_SIZE.height)
    const [view] = viewRects(tiles, [true, true])
    expect(view!.height).toBe(MIN_TILE_SIZE.height - TILE_HEADER_HEIGHT)
    expect(view!.y + view!.height).toBe(top!.y + top!.height)
  })
})
