import {
  DEFAULT_FRACTIONS,
  TILE_GUTTER,
  computeTileRects,
  type Fractions,
  type LayoutId,
  type Rect
} from './layout.js'

/**
 * Where a dragged tab can be dropped, and what happens when it is.
 *
 * The requirement (spec 2, and the "Windows snap" this was asked for) is that the indicator
 * shows *exactly* where the page will open — not merely that a drop is possible. So each zone
 * carries two rectangles:
 *
 *   - `hit`     — the region the pointer has to be in for this zone to win
 *   - `preview` — where the page will actually end up
 *
 * They differ whenever a drop changes the layout: brushing a tile's edge offers *half of that
 * tile*, so a narrow target promises a large result. `preview` is computed with
 * `computeTileRects` — the same function that positions the real views — against the layout the
 * drop would produce. A preview drawn from its own arithmetic would drift from reality the
 * first time the gutter or the minimum tile size changed.
 *
 * ## Every tile can be split, not just a single view
 *
 * An earlier version offered edge zones only in a single-tile layout, so dragging could get you
 * to two tiles and no further — there was no way to reach a three- or four-tile arrangement by
 * dragging at all. `SPLIT_TARGETS` fixes that: it says, for each layout, tile and edge, which
 * layout the drop switches to and which of its tiles the page lands in.
 *
 * The table is explicit rather than derived because the layouts are a fixed set, not an
 * arbitrary tree. Deriving "the layout with one more tile in this direction" would invent
 * arrangements that do not exist and hide the ones that do.
 *
 * Pure and zod-free: both renderers and the core import it.
 */

export type DropZoneKind =
  /** Open in this tile, replacing what is there. The layout does not change. */
  | 'tile'
  /** Split, with the page taking the named side. */
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'

export type SplitEdge = 'left' | 'right' | 'top' | 'bottom'

export interface DropZone {
  /** Stable across recomputations, so React keys and the "did the target change" test hold. */
  id: string
  kind: DropZoneKind
  hit: Rect
  preview: Rect
  /** Layout to switch to before assigning, or null to keep the current one. */
  layout: LayoutId | null
  tileIndex: number
}

export interface Point {
  x: number
  y: number
}

interface SplitTarget {
  layout: LayoutId
  tileIndex: number
}

/**
 * Which arrangement each edge of each tile leads to.
 *
 * Read as "in this layout, dragging onto this edge of this tile gives you that layout, with the
 * page in that tile". Absent means the arrangement does not exist and the edge offers nothing —
 * a four-tile grid cannot be split further, and a two-column layout has no way to split only
 * its left column horizontally except by becoming a full grid.
 *
 * `2x2` tile order is top-left, top-right, bottom-left, bottom-right. `1+2` is the wide left
 * tile, then the two on the right, top before bottom. A row of columns runs left to right.
 *
 * The rule for a vertical edge is that the row of columns *grows*: `1x1` to `1x2` to `1x3` to
 * `1x4`, with the page landing in the column the edge points at. Splitting a column
 * horizontally is only offered where the result exists at all, which is the two-column case
 * and the full grid — there is no arrangement with a half-height middle column, so `1x3` and
 * `1x4` offer nothing above or below.
 */
const SPLIT_TARGETS: Readonly<Record<string, SplitTarget>> = {
  // A single view splits any way you like.
  '1x1:0:left': { layout: '1x2', tileIndex: 0 },
  '1x1:0:right': { layout: '1x2', tileIndex: 1 },
  '1x1:0:top': { layout: '2x1', tileIndex: 0 },
  '1x1:0:bottom': { layout: '2x1', tileIndex: 1 },

  // Two columns. Splitting one horizontally needs the full grid on the left, and gives the
  // three-tile arrangement on the right, which keeps the left view at full height. Splitting
  // either one sideways again makes it a three-column row, with the new column at that edge.
  '1x2:0:top': { layout: '2x2', tileIndex: 0 },
  '1x2:0:bottom': { layout: '2x2', tileIndex: 2 },
  '1x2:1:top': { layout: '1+2', tileIndex: 1 },
  '1x2:1:bottom': { layout: '1+2', tileIndex: 2 },
  '1x2:0:left': { layout: '1x3', tileIndex: 0 },
  '1x2:0:right': { layout: '1x3', tileIndex: 1 },
  '1x2:1:left': { layout: '1x3', tileIndex: 1 },
  '1x2:1:right': { layout: '1x3', tileIndex: 2 },

  // Two rows. Splitting either one sideways gives the full grid.
  '2x1:0:left': { layout: '2x2', tileIndex: 0 },
  '2x1:0:right': { layout: '2x2', tileIndex: 1 },
  '2x1:1:left': { layout: '2x2', tileIndex: 2 },
  '2x1:1:right': { layout: '2x2', tileIndex: 3 },

  // Three columns becoming four. The right edge of a column and the left edge of the column
  // beside it both open the same gap, so they lead to the same new column — the indicator says
  // which.
  '1x3:0:left': { layout: '1x4', tileIndex: 0 },
  '1x3:0:right': { layout: '1x4', tileIndex: 1 },
  '1x3:1:left': { layout: '1x4', tileIndex: 1 },
  '1x3:1:right': { layout: '1x4', tileIndex: 2 },
  '1x3:2:left': { layout: '1x4', tileIndex: 2 },
  '1x3:2:right': { layout: '1x4', tileIndex: 3 },

  // The wide left tile of the three-tile arrangement can still be halved.
  '1+2:0:top': { layout: '2x2', tileIndex: 0 },
  '1+2:0:bottom': { layout: '2x2', tileIndex: 2 }

  // `2x2` and `1x4` are absent: four tiles is the most the fixed set offers, so every edge
  // there is a plain drop.
}

const EDGES: readonly SplitEdge[] = ['left', 'right', 'top', 'bottom']

/** Fraction of a tile's width or height that counts as its edge. */
const EDGE_FRACTION = 0.3

function tileRects(layout: LayoutId, contentRect: Rect, fractions: Fractions): Rect[] {
  return computeTileRects(layout, fractions, contentRect, { gutter: TILE_GUTTER })
}

function splitTarget(layout: LayoutId, tileIndex: number, edge: SplitEdge): SplitTarget | undefined {
  return SPLIT_TARGETS[`${layout}:${tileIndex}:${edge}`]
}

/**
 * The zones offered for a drag, given the layout the window is in.
 *
 * Every tile contributes a centre zone that opens the page in it, plus one zone per edge that
 * has somewhere to go. The bands are carved to be disjoint and to cover the tile completely, so
 * no point inside a tile is dead and no two zones can both claim a pointer.
 */
export function dropZonesFor(
  layout: LayoutId,
  contentRect: Rect,
  fractions: Fractions = DEFAULT_FRACTIONS[layout]
): DropZone[] {
  if (contentRect.width <= 0 || contentRect.height <= 0) return []

  return tileRects(layout, contentRect, fractions).flatMap<DropZone>((rect, tileIndex) => {
    const targets = new Map<SplitEdge, SplitTarget>()
    for (const edge of EDGES) {
      const target = splitTarget(layout, tileIndex, edge)
      if (target !== undefined) targets.set(edge, target)
    }

    // Bands only exist in directions that lead somewhere. Where they do not, the space belongs
    // to the remaining bands and the centre, rather than becoming a target that does nothing.
    const sideways = targets.has('left') || targets.has('right')
    const upright = targets.has('top') || targets.has('bottom')
    const bandWidth = sideways ? Math.round(rect.width * EDGE_FRACTION) : 0
    const bandHeight = upright ? Math.round(rect.height * EDGE_FRACTION) : 0

    const innerX = rect.x + bandWidth
    const innerWidth = Math.max(0, rect.width - bandWidth * 2)
    const innerY = rect.y + bandHeight
    const innerHeight = Math.max(0, rect.height - bandHeight * 2)

    const hitFor = (edge: SplitEdge): Rect => {
      switch (edge) {
        case 'left':
          return { x: rect.x, y: rect.y, width: bandWidth, height: rect.height }
        case 'right':
          return {
            x: rect.x + rect.width - bandWidth,
            y: rect.y,
            width: bandWidth,
            height: rect.height
          }
        case 'top':
          return { x: innerX, y: rect.y, width: innerWidth, height: bandHeight }
        case 'bottom':
          return {
            x: innerX,
            y: rect.y + rect.height - bandHeight,
            width: innerWidth,
            height: bandHeight
          }
      }
    }

    const zones: DropZone[] = []
    for (const [edge, target] of targets) {
      /*
        `slice` rather than an index plus a guard.

        Indexing would yield `Rect | undefined` and need an `if` for a case the table cannot
        produce — dead code, which no test can cover and which quietly costs this directory the
        strict coverage it is held to. A one-element slice is total: it is either the rectangle
        or nothing, with no branch either way.
      */
      zones.push(
        ...tileRects(target.layout, contentRect, DEFAULT_FRACTIONS[target.layout])
          .slice(target.tileIndex, target.tileIndex + 1)
          .map((preview) => ({
            id: `${tileIndex}-${edge}`,
            kind: edge,
            hit: hitFor(edge),
            preview,
            layout: target.layout,
            tileIndex: target.tileIndex
          }))
      )
    }

    zones.push({
      id: `${tileIndex}-centre`,
      kind: 'tile',
      hit: { x: innerX, y: innerY, width: innerWidth, height: innerHeight },
      preview: rect,
      layout: null,
      tileIndex
    })

    return zones
  })
}

function contains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  )
}

/** Distance from a point to the nearest edge of a rect; 0 when inside. */
function distanceTo(rect: Rect, point: Point): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width))
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height))
  return Math.hypot(dx, dy)
}

/**
 * The zone a point selects, or null when the point is outside the content area entirely.
 *
 * Falls back to the nearest zone rather than returning null for a point inside the content area.
 * Tiles are laid out with a gutter between them, so exact containment alone would leave an
 * eight-pixel dead stripe down the middle of the window where dragging does nothing — and
 * "nothing happened" is indistinguishable from a broken feature.
 */
export function zoneAt(
  zones: readonly DropZone[],
  point: Point,
  contentRect: Rect
): DropZone | null {
  if (zones.length === 0) return null
  if (!contains(contentRect, point)) return null

  const hit = zones.find((zone) => contains(zone.hit, point))
  if (hit !== undefined) return hit

  let nearest = zones[0]!
  let best = distanceTo(nearest.hit, point)
  for (const zone of zones.slice(1)) {
    const distance = distanceTo(zone.hit, point)
    if (distance < best) {
      best = distance
      nearest = zone
    }
  }
  return nearest
}

/** Moves a rect from window coordinates into a rect-relative space. */
export function relativeTo(rect: Rect, origin: Rect): Rect {
  return { ...rect, x: rect.x - origin.x, y: rect.y - origin.y }
}
