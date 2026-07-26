import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FRACTIONS,
  LAYOUT_IDS,
  MIN_TILE_SIZE,
  TILE_COUNT,
  clampFraction,
  clampFractions,
  computeTileRects,
  dividersFor,
  tileInDirection,
  type LayoutId,
  type Rect
} from '@shared/split/layout.js'

const CONTENT: Rect = { x: 0, y: 88, width: 1600, height: 900 }

/**
 * Split-view geometry. Spec 7 requires end-to-end coverage of the split layout;
 * these are the pure-geometry foundations that the end-to-end tests then rely
 * on.
 */

describe('computeTileRects', () => {
  it('gives the whole content area to a single tile', () => {
    expect(computeTileRects('1x1', {}, CONTENT)).toEqual([CONTENT])
  })

  it('produces the declared number of tiles for every layout', () => {
    for (const [layout, count] of Object.entries(TILE_COUNT)) {
      const rects = computeTileRects(layout as keyof typeof TILE_COUNT, {}, CONTENT)
      expect(rects, layout).toHaveLength(count)
    }
  })

  it('leaves no seam or overlap between neighbours', () => {
    const [left, right] = computeTileRects('1x2', { v: 0.5 }, CONTENT)
    expect(left).toBeDefined()
    expect(right).toBeDefined()
    // Boundaries are rounded, not sizes, so the two exactly meet.
    expect(left!.x + left!.width).toBe(right!.x)
    expect(left!.width + right!.width).toBe(CONTENT.width)
  })

  it('covers the content area exactly in a 2x2 grid', () => {
    const rects = computeTileRects('2x2', { v: 0.5, h: 0.5 }, CONTENT)
    const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0)
    expect(area).toBe(CONTENT.width * CONTENT.height)
  })

  it('keeps the grid flush with the content edges when a gutter is used', () => {
    const rects = computeTileRects('2x2', { v: 0.5, h: 0.5 }, CONTENT, { gutter: 8 })
    const minX = Math.min(...rects.map((r) => r.x))
    const maxRight = Math.max(...rects.map((r) => r.x + r.width))
    const minY = Math.min(...rects.map((r) => r.y))
    const maxBottom = Math.max(...rects.map((r) => r.y + r.height))

    expect(minX).toBe(CONTENT.x)
    expect(maxRight).toBe(CONTENT.x + CONTENT.width)
    expect(minY).toBe(CONTENT.y)
    expect(maxBottom).toBe(CONTENT.y + CONTENT.height)
  })

  it('separates neighbours by the gutter width', () => {
    const [left, right] = computeTileRects('1x2', { v: 0.5 }, CONTENT, { gutter: 8 })
    expect(right!.x - (left!.x + left!.width)).toBe(8)
  })

  it('offsets tiles by the content origin, not the window origin', () => {
    const rects = computeTileRects('2x1', { h: 0.5 }, CONTENT)
    expect(rects[0]!.y).toBe(CONTENT.y)
    expect(rects[1]!.y).toBe(CONTENT.y + CONTENT.height / 2)
  })

  it('gives 1+2 one full-height tile and two stacked ones', () => {
    const [big, topRight, bottomRight] = computeTileRects('1+2', { v: 0.6, hRight: 0.5 }, CONTENT)
    expect(big!.height).toBe(CONTENT.height)
    expect(topRight!.x).toBe(big!.x + big!.width)
    expect(bottomRight!.x).toBe(topRight!.x)
    expect(topRight!.height + bottomRight!.height).toBe(CONTENT.height)
  })

  it('honours the minimum tile size instead of collapsing a tile', () => {
    const rects = computeTileRects('1x2', { v: 0.001 }, CONTENT)
    expect(rects[0]!.width).toBeGreaterThanOrEqual(MIN_TILE_SIZE.width)
  })
})

/**
 * Rows of three and four columns.
 *
 * The two-column layout got away with a single fraction, so nothing before these
 * layouts could put two boundaries in the wrong order. Everything here is about
 * that: the columns meet, they stay in order, and none can be squeezed out.
 */
describe('side-by-side layouts', () => {
  /** Every layout that is a plain left-to-right row of columns, narrowest first. */
  const SIDE_BY_SIDE = ['1x2', '1x3', '1x4'] as const

  it('gives a row a column per tile, full height', () => {
    for (const layout of SIDE_BY_SIDE) {
      const rects = computeTileRects(layout, {}, CONTENT)
      expect(rects, layout).toHaveLength(TILE_COUNT[layout])
      for (const rect of rects) {
        expect(rect.y, layout).toBe(CONTENT.y)
        expect(rect.height, layout).toBe(CONTENT.height)
      }
    }
  })

  it('leaves no seam or overlap between the columns of a row', () => {
    // The same property the 1x2 and 2x2 tests pin down, walked along the row: each
    // column starts exactly where the one before it ended, and the last reaches the
    // right edge. Rounded boundaries rather than rounded widths is what makes that
    // hold at any window width.
    for (const layout of SIDE_BY_SIDE) {
      let edge = CONTENT.x
      for (const rect of computeTileRects(layout, {}, CONTENT)) {
        expect(rect.x, layout).toBe(edge)
        edge = rect.x + rect.width
      }
      expect(edge, layout).toBe(CONTENT.x + CONTENT.width)
    }
  })

  it('covers the content area exactly, whatever the boundaries are', () => {
    for (const layout of SIDE_BY_SIDE) {
      for (const fractions of [{}, { v: 0.1, v2: 0.9 }, { v: 0.5, v2: 0.5, v3: 0.5 }]) {
        const rects = computeTileRects(layout, fractions, CONTENT)
        const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0)
        expect(area, `${layout} ${JSON.stringify(fractions)}`).toBe(CONTENT.width * CONTENT.height)
      }
    }
  })

  it('divides a row evenly until someone drags it', () => {
    // Within a pixel, not to the pixel: boundaries are rounded rather than widths,
    // which is what keeps the columns seamless, and three columns cannot divide
    // 1600 exactly. Spreading the remainder is the price of no gap and no overlap.
    for (const layout of SIDE_BY_SIDE) {
      const widths = computeTileRects(layout, {}, CONTENT).map((rect) => rect.width)
      expect(Math.max(...widths) - Math.min(...widths), layout).toBeLessThanOrEqual(1)
    }
  })

  it('gives a row one draggable boundary fewer than it has columns', () => {
    for (const layout of SIDE_BY_SIDE) {
      const dividers = dividersFor(layout, DEFAULT_FRACTIONS[layout])
      expect(dividers.length, layout).toBe(TILE_COUNT[layout] - 1)
      expect(
        dividers.map((divider) => divider.orientation),
        layout
      ).toEqual(dividers.map(() => 'vertical'))
    }
  })

  it('names the boundaries of a row in left-to-right order', () => {
    // The order is what `clampFractions` relies on to tell which boundary has to
    // stay left of which; a shuffled list would order the wrong pair.
    expect(dividersFor('1x3', DEFAULT_FRACTIONS['1x3']).map((d) => d.id)).toEqual(['v', 'v2'])
    expect(dividersFor('1x4', DEFAULT_FRACTIONS['1x4']).map((d) => d.id)).toEqual([
      'v',
      'v2',
      'v3'
    ])
    for (const layout of ['1x3', '1x4'] as const) {
      const positions = dividersFor(layout, DEFAULT_FRACTIONS[layout]).map(
        (divider) => DEFAULT_FRACTIONS[layout][divider.id] ?? 0
      )
      expect(positions, layout).toEqual([...positions].sort((a, b) => a - b))
    }
  })

  it('keeps the leftmost boundary named as it always was', () => {
    // `v` rather than `v1`, so a divider placed in a two-column layout carries over
    // when the row grows instead of jumping back to the default.
    expect(Object.keys(DEFAULT_FRACTIONS['1x3'])).toContain('v')
    expect(Object.keys(DEFAULT_FRACTIONS['1x4'])).toContain('v')
  })

  it('spans a row boundary across the whole area, because that is where it is', () => {
    for (const divider of dividersFor('1x4', DEFAULT_FRACTIONS['1x4'])) {
      expect(divider.region, divider.id).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    }
  })

  it('only ever names a divider the layout has a default for', () => {
    // The invariant that lets the geometry read a boundary out of a fraction map
    // without an `undefined` branch. Asserting it here is what keeps that safe.
    for (const layout of LAYOUT_IDS) {
      const known = Object.keys(DEFAULT_FRACTIONS[layout])
      for (const divider of dividersFor(layout, DEFAULT_FRACTIONS[layout])) {
        expect(known, `${layout} ${divider.id}`).toContain(divider.id)
      }
    }
  })
})

describe('boundaries of a row stay in order', () => {
  const boundariesOf = (layout: LayoutId, fractions: Record<string, number>): number[] => {
    const clamped = clampFractions(layout, fractions, CONTENT)
    return dividersFor(layout, clamped).map((divider) => clamped[divider.id] ?? Number.NaN)
  }

  it('keeps a middle boundary right of the one before it when dragged past it', () => {
    // The failure this rules out: clamped one at a time, `v2` at 0.05 would sit left
    // of `v` at 0.25 and the column between them would have a negative width.
    const [v, v2, v3] = boundariesOf('1x4', { v2: 0.05 })
    expect(v!).toBeLessThan(v2!)
    expect(v2!).toBeLessThan(v3!)
  })

  it('keeps the order when the boundaries arrive reversed', () => {
    const [v, v2] = boundariesOf('1x3', { v: 0.8, v2: 0.2 })
    expect(v!).toBeLessThan(v2!)
  })

  it('keeps the order when every boundary is dragged to the right edge', () => {
    const positions = boundariesOf('1x4', { v: 0.9, v2: 0.95, v3: 0.99 })
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(positions.at(-1)!).toBeLessThan(1)
  })

  it('keeps the order when every boundary is dragged to the left edge', () => {
    const positions = boundariesOf('1x4', { v: 0, v2: 0, v3: 0 })
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(positions[0]!).toBeGreaterThan(0)
  })

  it('never lets a column come out inverted, whatever it is handed', () => {
    // A sweep rather than one example: the two sweeps inside the clamp are easy to
    // get right for the pair you thought of and wrong for the third boundary.
    for (const a of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
      for (const b of [0, 0.2, 0.5, 0.8, 1]) {
        for (const c of [0, 0.25, 0.75, 1]) {
          const rects = computeTileRects('1x4', { v: a, v2: b, v3: c }, CONTENT)
          const label = `${a}/${b}/${c}`
          expect(rects, label).toHaveLength(4)
          for (const rect of rects) expect(rect.width, label).toBeGreaterThan(0)
        }
      }
    }
  })

  it('honours the minimum column width rather than collapsing the first column', () => {
    const rects = computeTileRects('1x4', { v: 0 }, { x: 0, y: 0, width: 1100, height: 900 })
    for (const rect of rects) {
      expect(rect.width).toBeGreaterThanOrEqual(MIN_TILE_SIZE.width)
    }
  })

  it('shares the shortfall evenly when the window cannot fit four minimum columns', () => {
    // 4 x 240 needs 960px; this window has 800. Nobody can have their minimum, so
    // everybody is equally narrow — rather than three columns at 240 and one at 80.
    const content: Rect = { x: 0, y: 0, width: 800, height: 900 }
    const widths = computeTileRects('1x4', { v: 0.05, v2: 0.9 }, content).map((r) => r.width)
    expect(new Set(widths).size).toBe(1)
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(content.width)
  })

  it('falls back to an even row when there is no width at all yet', () => {
    // A layout computed before the first paint. Zero-width columns, but in order and
    // in the right number, so the next pass has something coherent to grow.
    const clamped = clampFractions('1x3', { v: 0.9 }, { width: 0, height: 900 })
    expect(clamped['v']).toBeCloseTo(1 / 3, 10)
    expect(clamped['v2']).toBeCloseTo(2 / 3, 10)
  })

  it('snaps a boundary to its own even-split detent, not to the middle', () => {
    // 0.5 is the detent for a lone divider; for the first of three boundaries the
    // arrangement people want back is a third of the way across.
    expect(clampFractions('1x3', { v: 0.34 }, CONTENT)['v']).toBeCloseTo(1 / 3, 10)
    expect(clampFractions('1x4', { v2: 0.49 }, CONTENT)['v2']).toBe(0.5)
    expect(clampFractions('1x4', { v: 0.26 }, CONTENT)['v']).toBe(0.25)
  })

  it('leaves a boundary clearly away from its detent alone', () => {
    expect(clampFractions('1x4', { v: 0.35 }, CONTENT)['v']).toBe(0.35)
  })

  it('agrees with clampFraction wherever there is only one boundary to place', () => {
    /*
      The claim that lets the ordering pass run on every layout rather than only on
      the wide rows: with a single vertical divider it reproduces the single-divider
      clamp exactly. If the two ever disagree, a divider would land somewhere other
      than where the handle was dropped.
    */
    for (const layout of ['1x2', '2x2', '1+2'] as const) {
      for (const value of [0, 0.1, 0.14, 0.49, 0.5, 0.505, 0.7, 0.95, 1]) {
        expect(clampFractions(layout, { v: value }, CONTENT)['v'], `${layout} v ${value}`).toBe(
          clampFraction(layout, 'v', value, CONTENT)
        )
      }
    }
  })
})

describe('clampFraction', () => {
  it('snaps close to an even split', () => {
    expect(clampFraction('1x2', 'v', 0.505, CONTENT)).toBe(0.5)
  })

  it('does not snap when clearly away from the middle', () => {
    expect(clampFraction('1x2', 'v', 0.7, CONTENT)).toBe(0.7)
  })

  it('clamps to the minimum tile width', () => {
    const clamped = clampFraction('1x2', 'v', 0, CONTENT)
    expect(clamped).toBeCloseTo(MIN_TILE_SIZE.width / CONTENT.width, 10)
  })

  it('clamps the far side symmetrically', () => {
    const clamped = clampFraction('1x2', 'v', 1, CONTENT)
    expect(clamped).toBeCloseTo(1 - MIN_TILE_SIZE.width / CONTENT.width, 10)
  })

  it('falls back to an even split when the window is too small to honour the minimum', () => {
    expect(clampFraction('1x2', 'v', 0.2, { width: 300, height: 200 })).toBe(0.5)
  })

  it('rejects non-finite input instead of producing NaN geometry', () => {
    expect(clampFraction('1x2', 'v', Number.NaN, CONTENT)).toBe(DEFAULT_FRACTIONS['1x2']['v'])
  })

  it('uses the height for horizontal dividers', () => {
    const clamped = clampFraction('2x1', 'h', 0, CONTENT)
    expect(clamped).toBeCloseTo(MIN_TILE_SIZE.height / CONTENT.height, 10)
  })
})

describe('dividersFor', () => {
  it('gives a single tile nothing to drag', () => {
    expect(dividersFor('1x1', {})).toEqual([])
  })

  it('gives 2x2 one divider per axis', () => {
    const dividers = dividersFor('2x2', DEFAULT_FRACTIONS['2x2'])
    expect(dividers.map((d) => d.id)).toEqual(['v', 'h'])
  })

  it('limits the 1+2 horizontal divider to the right-hand column', () => {
    const [, hRight] = dividersFor('1+2', { v: 0.6, hRight: 0.5 })
    // Spanning the full width would put a handle across the large tile, where
    // there is no boundary to move.
    expect(hRight!.region.x).toBeCloseTo(0.6, 10)
    expect(hRight!.region.width).toBeCloseTo(0.4, 10)
  })
})

describe('tileInDirection', () => {
  const grid = computeTileRects('2x2', { v: 0.5, h: 0.5 }, CONTENT)

  it('moves right along a row', () => {
    expect(tileInDirection(grid, 0, 'right')).toBe(1)
  })

  it('moves down a column', () => {
    expect(tileInDirection(grid, 0, 'down')).toBe(2)
  })

  it('moves back up', () => {
    expect(tileInDirection(grid, 3, 'up')).toBe(1)
  })

  it('reports no neighbour at the edge rather than wrapping silently', () => {
    expect(tileInDirection(grid, 0, 'left')).toBeNull()
    expect(tileInDirection(grid, 0, 'up')).toBeNull()
  })

  it('never returns a diagonal neighbour', () => {
    // Tile 0 is top-left, tile 3 bottom-right: they share no edge.
    expect(tileInDirection(grid, 0, 'right')).not.toBe(3)
    expect(tileInDirection(grid, 0, 'down')).not.toBe(3)
  })

  it('works on an asymmetric layout', () => {
    const rects = computeTileRects('1+2', { v: 0.6, hRight: 0.5 }, CONTENT)
    expect(tileInDirection(rects, 0, 'right')).toBe(1)
    expect(tileInDirection(rects, 1, 'left')).toBe(0)
    expect(tileInDirection(rects, 1, 'down')).toBe(2)
  })

  it('returns null for an out-of-range origin', () => {
    expect(tileInDirection(grid, 99, 'left')).toBeNull()
  })

  it('walks all the way along a four-column row and back', () => {
    const row = computeTileRects('1x4', DEFAULT_FRACTIONS['1x4'], CONTENT)
    expect([0, 1, 2].map((from) => tileInDirection(row, from, 'right'))).toEqual([1, 2, 3])
    expect([3, 2, 1].map((from) => tileInDirection(row, from, 'left'))).toEqual([2, 1, 0])
  })

  it('never skips a column of a row', () => {
    // Geometry picks the *nearest* tile in the direction asked for, so a third
    // column must never answer a single Right from the first.
    const row = computeTileRects('1x3', DEFAULT_FRACTIONS['1x3'], CONTENT)
    expect(tileInDirection(row, 0, 'right')).toBe(1)
    expect(tileInDirection(row, 2, 'left')).toBe(1)
  })

  it('reports no neighbour above or below in a row, because there is none', () => {
    const row = computeTileRects('1x4', DEFAULT_FRACTIONS['1x4'], CONTENT)
    for (const from of [0, 1, 2, 3]) {
      expect(tileInDirection(row, from, 'up'), `${from}`).toBeNull()
      expect(tileInDirection(row, from, 'down'), `${from}`).toBeNull()
    }
  })

  it('stops at the ends of a row rather than wrapping', () => {
    const row = computeTileRects('1x4', DEFAULT_FRACTIONS['1x4'], CONTENT)
    expect(tileInDirection(row, 0, 'left')).toBeNull()
    expect(tileInDirection(row, 3, 'right')).toBeNull()
  })
})
