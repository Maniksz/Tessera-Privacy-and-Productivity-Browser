import { describe, expect, it } from 'vitest'
import { dropZonesFor, relativeTo, zoneAt } from '@shared/split/dropzones.js'
import {
  DEFAULT_FRACTIONS,
  LAYOUT_IDS,
  TILE_COUNT,
  TILE_GUTTER,
  computeTileRects,
  type LayoutId,
  type Rect
} from '@shared/split/layout.js'

/**
 * Where a dragged tab can be dropped.
 *
 * The promise these zones make is precise — "the page will open *here*" — so the tests are
 * about the promise being kept: that every preview is a rectangle the layout can actually
 * produce, that no point inside the tile area is dead, and that dragging can reach the
 * three- and four-tile arrangements at all. That last one was the gap: edge zones existed only
 * in a single-tile layout, so a drag could get you to two tiles and no further.
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1200, height: 800 }

function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function kindsIn(layout: LayoutId): string[] {
  return dropZonesFor(layout, CONTENT).map((zone) => zone.id)
}

describe('reaching every arrangement by dragging', () => {
  it('offers all four splits from a single view', () => {
    expect(kindsIn('1x1')).toEqual(['0-left', '0-right', '0-top', '0-bottom', '0-centre'])
  })

  it('reaches two columns and two rows from a single view', () => {
    const targets = dropZonesFor('1x1', CONTENT).map((zone) => zone.layout)
    expect(targets).toContain('1x2')
    expect(targets).toContain('2x1')
  })

  it('reaches the three-tile arrangement by splitting the right column', () => {
    // The gap this closes: without it, dragging could produce two tiles and nothing beyond.
    const zones = dropZonesFor('1x2', CONTENT)
    const toThree = zones.filter((zone) => zone.layout === '1+2')
    expect(toThree.length).toBe(2)
    expect(toThree.map((zone) => zone.tileIndex)).toEqual([1, 2])
  })

  it('reaches the four-tile grid by splitting the left column', () => {
    const toFour = dropZonesFor('1x2', CONTENT).filter((zone) => zone.layout === '2x2')
    expect(toFour.map((zone) => zone.tileIndex)).toEqual([0, 2])
  })

  it('reaches the four-tile grid from two rows, either side', () => {
    const toFour = dropZonesFor('2x1', CONTENT).filter((zone) => zone.layout === '2x2')
    expect(toFour.map((zone) => zone.tileIndex)).toEqual([0, 1, 2, 3])
  })

  it('can still halve the wide tile of the three-tile arrangement', () => {
    const toFour = dropZonesFor('1+2', CONTENT).filter((zone) => zone.layout === '2x2')
    expect(toFour.map((zone) => zone.tileIndex)).toEqual([0, 2])
  })

  it('offers no further split once there are four tiles', () => {
    for (const layout of ['2x2', '1x4'] as const) {
      const zones = dropZonesFor(layout, CONTENT)
      expect(zones.length, layout).toBe(4)
      for (const zone of zones) expect(zone.layout, `${layout} ${zone.id}`).toBeNull()
    }
  })

  it('grows the row one column at a time from a vertical edge', () => {
    // The rule the table is written to: a vertical edge always means "another
    // column", never "turn this on its side". The right edge of the last column is
    // the plainest case of it — the page lands in a new column beyond everything.
    const growth: ReadonlyArray<[LayoutId, number, LayoutId, number]> = [
      ['1x1', 0, '1x2', 1],
      ['1x2', 1, '1x3', 2],
      ['1x3', 2, '1x4', 3]
    ]
    for (const [from, tile, to, landsIn] of growth) {
      const zone = dropZonesFor(from, CONTENT).find((candidate) => candidate.id === `${tile}-right`)
      expect(zone, `${from} ${tile}-right`).toBeDefined()
      expect(zone!.layout, from).toBe(to)
      expect(zone!.tileIndex, from).toBe(landsIn)
    }
  })

  it('reaches every column of a three-column row from a two-column one', () => {
    const toThree = dropZonesFor('1x2', CONTENT).filter((zone) => zone.layout === '1x3')
    // Three gaps, three zones: the leading one from the first column's left edge, the
    // other two from the right edge of the column each sits beside. The second column's
    // left edge is gone because it opens the gap `0-right` already offers.
    expect(toThree.map((zone) => zone.id)).toEqual(['0-left', '0-right', '1-right'])
    expect(toThree.map((zone) => zone.tileIndex)).toEqual([0, 1, 2])
  })

  it('reaches every column of a four-column row from a three-column one', () => {
    const toFour = dropZonesFor('1x3', CONTENT).filter((zone) => zone.layout === '1x4')
    expect(toFour.map((zone) => zone.id)).toEqual(['0-left', '0-right', '1-right', '2-right'])
    expect(toFour.map((zone) => zone.tileIndex)).toEqual([0, 1, 2, 3])
  })

  it('offers each tile of each target layout exactly once', () => {
    /*
      The defect this pins down. A column's right edge and its neighbour's left edge open the
      same gap, and both were listed — so two zones led to one tile and drew two identical
      previews, one over the other. The tile that paid for it was the one with a neighbour on
      each side: both of the middle column's bands were duplicates, and together they took 60 %
      of it.
    */
    for (const layout of LAYOUT_IDS) {
      const targets = dropZonesFor(layout, CONTENT)
        .filter((zone) => zone.layout !== null)
        .map((zone) => `${zone.layout}#${zone.tileIndex}`)
      expect(new Set(targets).size, layout).toBe(targets.length)
    }
  })

  it('gives a tile with a neighbour on each side at most one band', () => {
    // The report was "dragging onto the middle tile does not work", and this is the shape of it:
    // a gap belongs to one column, so a middle column cannot be carved from both sides at once.
    for (const [layout, middle] of [
      ['1x3', 1],
      ['1x4', 1],
      ['1x4', 2]
    ] as const) {
      const bands = dropZonesFor(layout, CONTENT).filter(
        (zone) => zone.tileIndex === middle && zone.kind !== 'tile'
      )
      expect(bands.length, `${layout} tile ${middle}`).toBeLessThanOrEqual(1)
    }
  })

  it('leaves the middle column of a three-column row mostly droppable', () => {
    // The number the report came down to: 40 % of the middle column accepted a plain drop,
    // because a band was taken off each side for two offers its neighbours already made.
    const [middle] = computeTileRects('1x3', DEFAULT_FRACTIONS['1x3'], CONTENT, {
      gutter: TILE_GUTTER
    }).slice(1, 2)
    const centre = dropZonesFor('1x3', CONTENT).find((zone) => zone.id === '1-centre')!
    expect(centre.hit.width / middle!.width).toBeGreaterThan(0.6)
  })

  it('still reaches the grid and the three-tile shape from two columns', () => {
    // Growing the row must not have taken the horizontal routes away.
    const zones = dropZonesFor('1x2', CONTENT)
    expect(zones.filter((zone) => zone.layout === '2x2').map((zone) => zone.tileIndex)).toEqual([
      0, 2
    ])
    expect(zones.filter((zone) => zone.layout === '1+2').map((zone) => zone.tileIndex)).toEqual([
      1, 2
    ])
  })

  it('offers a wide row nothing above or below, because no such arrangement exists', () => {
    // There is no layout with a half-height middle column, and an edge that leads
    // nowhere would be a target that silently does nothing.
    for (const layout of ['1x3', '1x4'] as const) {
      const upright = dropZonesFor(layout, CONTENT).filter(
        (zone) => zone.kind === 'top' || zone.kind === 'bottom'
      )
      expect(upright, layout).toEqual([])
    }
  })

  it('lets a row be reached by dragging alone, from a single view up to four columns', () => {
    // The whole path, so the chain cannot be broken in the middle: each step must
    // offer the next row, and the last must offer nothing further.
    const chain: readonly LayoutId[] = ['1x1', '1x2', '1x3', '1x4']
    const reached = chain.slice(0, -1).map((layout) => {
      const rightmost = `${TILE_COUNT[layout] - 1}-right`
      return dropZonesFor(layout, CONTENT).find((zone) => zone.id === rightmost)?.layout ?? null
    })
    expect(reached).toEqual(chain.slice(1))
    expect(dropZonesFor('1x4', CONTENT).filter((zone) => zone.layout !== null)).toEqual([])
  })
})

describe('previews', () => {
  it('promises a rectangle the target layout actually produces', () => {
    // Every split preview must equal a tile of the layout it switches to, because that is
    // literally where the page will be.
    for (const layout of LAYOUT_IDS) {
      for (const zone of dropZonesFor(layout, CONTENT)) {
        if (zone.layout === null) continue
        const real = dropZonesFor(zone.layout, CONTENT).find(
          (candidate) => candidate.kind === 'tile' && candidate.tileIndex === zone.tileIndex
        )
        expect(real, `${layout} ${zone.id}`).toBeDefined()
        expect(zone.preview, `${layout} ${zone.id}`).toEqual(real!.preview)
      }
    }
  })

  it('promises more than the region hovered, for every split', () => {
    for (const layout of LAYOUT_IDS) {
      for (const zone of dropZonesFor(layout, CONTENT)) {
        if (zone.layout === null) continue
        const hitArea = zone.hit.width * zone.hit.height
        const previewArea = zone.preview.width * zone.preview.height
        expect(previewArea, `${layout} ${zone.id}`).toBeGreaterThan(hitArea)
      }
    }
  })

  it('previews the tile itself for a plain drop', () => {
    for (const layout of LAYOUT_IDS) {
      for (const zone of dropZonesFor(layout, CONTENT)) {
        if (zone.kind !== 'tile') continue
        // The centre band is a subset of the tile; the preview is the whole tile.
        expect(zone.preview.width, `${layout} ${zone.id}`).toBeGreaterThanOrEqual(zone.hit.width)
      }
    }
  })

  it('previews halves that match the real geometry, gutter included', () => {
    const zones = dropZonesFor('1x1', CONTENT)
    const left = zones.find((zone) => zone.id === '0-left')!
    const right = zones.find((zone) => zone.id === '0-right')!
    expect(right.preview.x - (left.preview.x + left.preview.width)).toBe(TILE_GUTTER)
    expect(left.preview.x).toBe(CONTENT.x)
    expect(right.preview.x + right.preview.width).toBe(CONTENT.x + CONTENT.width)
  })

  it('keeps every zone inside the tile area', () => {
    for (const layout of LAYOUT_IDS) {
      for (const zone of dropZonesFor(layout, CONTENT)) {
        for (const rect of [zone.hit, zone.preview]) {
          expect(rect.x, layout).toBeGreaterThanOrEqual(CONTENT.x)
          expect(rect.y, layout).toBeGreaterThanOrEqual(CONTENT.y)
          expect(rect.x + rect.width, layout).toBeLessThanOrEqual(CONTENT.x + CONTENT.width)
          expect(rect.y + rect.height, layout).toBeLessThanOrEqual(CONTENT.y + CONTENT.height)
        }
      }
    }
  })

  it('gives every zone a distinct id', () => {
    for (const layout of LAYOUT_IDS) {
      const ids = dropZonesFor(layout, CONTENT).map((zone) => zone.id)
      expect(new Set(ids).size, layout).toBe(ids.length)
    }
  })

  it('gives every tile exactly one plain drop zone', () => {
    for (const layout of LAYOUT_IDS) {
      const plain = dropZonesFor(layout, CONTENT).filter((zone) => zone.kind === 'tile')
      expect(plain.length, layout).toBe(TILE_COUNT[layout])
      expect(plain.map((zone) => zone.tileIndex), layout).toEqual(
        Array.from({ length: TILE_COUNT[layout] }, (_, index) => index)
      )
    }
  })
})

describe('with no room', () => {
  it('offers nothing for a zero-width tile area', () => {
    expect(dropZonesFor('2x2', { x: 0, y: 0, width: 0, height: 500 })).toEqual([])
  })

  it('offers nothing for a zero-height tile area', () => {
    expect(dropZonesFor('1x1', { x: 0, y: 0, width: 500, height: 0 })).toEqual([])
  })
})

describe('zoneAt', () => {
  it('picks the zone the point is inside', () => {
    for (const layout of LAYOUT_IDS) {
      const zones = dropZonesFor(layout, CONTENT)
      for (const zone of zones) {
        if (zone.hit.width === 0 || zone.hit.height === 0) continue
        expect(zoneAt(zones, centreOf(zone.hit), CONTENT)?.id, `${layout} ${zone.id}`).toBe(zone.id)
      }
    }
  })

  it('picks the plain drop in the middle of a tile, not a split', () => {
    // Dropping into the body of a tile is the common case and must not surprise anyone with a
    // rearranged window.
    const zones = dropZonesFor('1x1', CONTENT)
    expect(zoneAt(zones, centreOf(CONTENT), CONTENT)?.kind).toBe('tile')
  })

  it('returns null above the tile area, which is the tab strip', () => {
    // A live drag with no tile targeted is a real state, not a failure.
    const zones = dropZonesFor('2x2', CONTENT)
    expect(zoneAt(zones, { x: 600, y: 10 }, CONTENT)).toBeNull()
  })

  it('returns null below and beside the tile area', () => {
    const zones = dropZonesFor('2x2', CONTENT)
    expect(zoneAt(zones, { x: 600, y: 5000 }, CONTENT)).toBeNull()
    expect(zoneAt(zones, { x: -10, y: 400 }, CONTENT)).toBeNull()
    expect(zoneAt(zones, { x: 5000, y: 400 }, CONTENT)).toBeNull()
  })

  it('leaves no dead point inside the tile area', () => {
    // Tiles are laid out with a gutter, so exact containment alone would leave an
    // eight-pixel stripe where dragging silently does nothing.
    for (const layout of LAYOUT_IDS) {
      const zones = dropZonesFor(layout, CONTENT)
      for (let x = CONTENT.x; x < CONTENT.x + CONTENT.width; x += 7) {
        for (let y = CONTENT.y; y < CONTENT.y + CONTENT.height; y += 11) {
          expect(zoneAt(zones, { x, y }, CONTENT), `${layout} at ${x},${y}`).not.toBeNull()
        }
      }
    }
  })

  it('falls back to the nearest zone in a gutter rather than to nothing', () => {
    const zones = dropZonesFor('1x2', CONTENT)
    const leftTile = zones.find((zone) => zone.id === '0-centre')!
    const inGutter = { x: leftTile.preview.x + leftTile.preview.width + 1, y: CONTENT.y + 400 }
    expect(zoneAt(zones, inGutter, CONTENT)).not.toBeNull()
  })

  it('returns null when there are no zones at all', () => {
    expect(zoneAt([], { x: 600, y: 400 }, CONTENT)).toBeNull()
  })
})

describe('relativeTo', () => {
  it('shifts a rect into a space whose origin is the given rect', () => {
    expect(relativeTo({ x: 10, y: 100, width: 50, height: 60 }, CONTENT)).toEqual({
      x: 10,
      y: 12,
      width: 50,
      height: 60
    })
  })

  it('leaves size untouched', () => {
    const rect = { x: 400, y: 300, width: 123, height: 45 }
    const moved = relativeTo(rect, CONTENT)
    expect(moved.width).toBe(rect.width)
    expect(moved.height).toBe(rect.height)
  })

  it('is a no-op against an origin at zero', () => {
    const rect = { x: 400, y: 300, width: 123, height: 45 }
    expect(relativeTo(rect, { x: 0, y: 0, width: 10, height: 10 })).toEqual(rect)
  })
})
