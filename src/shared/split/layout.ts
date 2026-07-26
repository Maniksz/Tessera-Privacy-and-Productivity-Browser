/**
 * Split-view geometry.
 *
 * Pure, dependency-free and side-effect-free on purpose: the main process uses
 * it to position native views, the renderer uses it to draw divider handles,
 * and the unit tests use it to pin the behaviour down. One implementation, so
 * the handles a user drags can never disagree with where the content lands.
 */

/*
  Ids read "rows x columns", so `1x2` is two columns and `2x1` two rows. `1x3` and
  `1x4` continue that reading as a three- and four-column row; `1+2` is the one
  asymmetric shape and is named for what it looks like instead.

  New ids are appended rather than slotted in beside `1x2`, because the order here
  is also the order the layout menu lists them in — reordering would reshuffle a
  menu people have learnt the shape of, while gaining nothing: a persisted layout
  is matched by name, never by position.
*/
export const LAYOUT_IDS = ['1x1', '1x2', '2x1', '2x2', '1+2', '1x3', '1x4'] as const
export type LayoutId = (typeof LAYOUT_IDS)[number]

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** Divider position as a fraction of the axis it splits, keyed by divider id. */
export type Fractions = Readonly<Record<string, number>>

export type DividerOrientation = 'vertical' | 'horizontal'

export interface DividerDescriptor {
  id: string
  orientation: DividerOrientation
  /**
   * Region of the content area the divider lives in, in normalised
   * coordinates. A divider only spans part of the area in asymmetric layouts:
   * in `1+2` the horizontal divider exists only in the right-hand column.
   */
  region: Rect
}

/** How many tiles a layout shows. */
export const TILE_COUNT: Readonly<Record<LayoutId, number>> = {
  '1x1': 1,
  '1x2': 2,
  '2x1': 2,
  '2x2': 4,
  '1+2': 3,
  '1x3': 3,
  '1x4': 4
}

export const DEFAULT_FRACTIONS: Readonly<Record<LayoutId, Fractions>> = {
  '1x1': {},
  '1x2': { v: 0.5 },
  '2x1': { h: 0.5 },
  '2x2': { v: 0.5, h: 0.5 },
  '1+2': { v: 0.6, hRight: 0.5 },
  '1x3': { v: 1 / 3, v2: 2 / 3 },
  '1x4': { v: 0.25, v2: 0.5, v3: 0.75 }
}

/**
 * The vertical dividers of each layout, in left-to-right order.
 *
 * Written out, and written out for *every* layout rather than only for the wide
 * rows. Two reasons.
 *
 * The names could not be derived anyway. The leftmost boundary keeps the plain `v`
 * that `1x2`, `2x2` and `1+2` have always used, so switching between them and a
 * three-column row carries the divider the user placed instead of resetting it, and
 * so no session file already on disk is orphaned. The ordinals begin at the second
 * boundary, which is where "the vertical divider" stops being a single thing.
 *
 * And listing the settled layouts too means `clampColumns` runs on all of them. The
 * code that keeps boundaries in order is then the code the everyday layouts take,
 * instead of a branch only a four-column row ever reaches — where a mistake would
 * sit unnoticed until someone chose that layout.
 *
 * Every id here must also be a key of the layout's `DEFAULT_FRACTIONS`. That is
 * what makes reading a value out of a fraction map total rather than something
 * needing an `undefined` guard, so the tests assert it directly.
 */
const COLUMN_DIVIDERS: Readonly<Record<LayoutId, readonly string[]>> = {
  '1x1': [],
  '1x2': ['v'],
  '2x1': [],
  '2x2': ['v'],
  '1+2': ['v'],
  '1x3': ['v', 'v2'],
  '1x4': ['v', 'v2', 'v3']
}

/** Smallest a tile may get before its divider stops moving. */
export const MIN_TILE_SIZE: Size = { width: 240, height: 180 }

/**
 * Gap between adjacent tiles, in px.
 *
 * Not decoration — it is what makes the dividers draggable at all. Tab content
 * is rendered by native views layered *above* the chrome UI, so a divider drawn
 * in the DOM underneath them would never receive a mouse event. Leaving a strip
 * that no native view covers gives the DOM a hit area to own.
 */
export const TILE_GUTTER = 8

/** Snapping distance, as a fraction, for the equal-split detent. */
const SNAP_THRESHOLD = 0.02

export function isLayoutId(value: unknown): value is LayoutId {
  return typeof value === 'string' && (LAYOUT_IDS as readonly string[]).includes(value)
}

/**
 * Divider handles for a layout, in normalised coordinates. Returns an empty
 * array for `1x1`, which has nothing to drag.
 */
export function dividersFor(layout: LayoutId, fractions: Fractions): DividerDescriptor[] {
  const f = withDefaults(layout, fractions)
  switch (layout) {
    case '1x1':
      return []
    case '1x2':
      return [{ id: 'v', orientation: 'vertical', region: { x: 0, y: 0, width: 1, height: 1 } }]
    case '2x1':
      return [{ id: 'h', orientation: 'horizontal', region: { x: 0, y: 0, width: 1, height: 1 } }]
    case '2x2':
      return [
        { id: 'v', orientation: 'vertical', region: { x: 0, y: 0, width: 1, height: 1 } },
        { id: 'h', orientation: 'horizontal', region: { x: 0, y: 0, width: 1, height: 1 } }
      ]
    case '1+2':
      return [
        { id: 'v', orientation: 'vertical', region: { x: 0, y: 0, width: 1, height: 1 } },
        {
          id: 'hRight',
          orientation: 'horizontal',
          // Only spans the right column, starting where the vertical divider sits.
          region: { x: f.v ?? 0.6, y: 0, width: 1 - (f.v ?? 0.6), height: 1 }
        }
      ]
    case '1x3':
    case '1x4':
      // Every boundary of a column row runs the full height, so the region is the
      // whole area and only the fraction tells the handles apart. Taken from the
      // same table `clampColumns` orders, so a handle can never appear where no
      // boundary is.
      return COLUMN_DIVIDERS[layout].map((id) => ({
        id,
        orientation: 'vertical' as const,
        region: { x: 0, y: 0, width: 1, height: 1 }
      }))
  }
}

/** Fills in any missing divider with its layout default. */
export function withDefaults(layout: LayoutId, fractions: Fractions): Fractions {
  const defaults = DEFAULT_FRACTIONS[layout]
  const merged: Record<string, number> = { ...defaults }
  for (const id of Object.keys(defaults)) {
    const value = fractions[id]
    if (typeof value === 'number' && Number.isFinite(value)) merged[id] = value
  }
  return merged
}

/**
 * Which axis a divider splits, and therefore which content dimension bounds it.
 * `1+2`'s `hRight` splits the height of the right column, but the column is
 * full-height, so the bound is still the content height.
 */
function axisFor(dividerId: string): 'width' | 'height' {
  return dividerId.startsWith('v') ? 'width' : 'height'
}

/**
 * Clamps a divider so neither side falls below the minimum tile size, then
 * snaps to the equal-split detent when close. Returns the layout default when
 * the content is too small to honour the minimum at all — the caller has
 * nothing better to offer in that case, and a symmetric split is the least
 * surprising fallback.
 *
 * Deliberately one divider at a time, which is all a two-tile split needs. A row
 * of three or four columns has boundaries that constrain *each other*, and that
 * belongs to `clampFractions`, which is the function that sees them all.
 */
export function clampFraction(
  layout: LayoutId,
  dividerId: string,
  value: number,
  content: Size,
  minTile: Size = MIN_TILE_SIZE
): number {
  const axis = axisFor(dividerId)
  const available = content[axis]
  const minimum = minTile[axis]

  if (!Number.isFinite(value)) return DEFAULT_FRACTIONS[layout][dividerId] ?? 0.5
  if (available <= 0) return DEFAULT_FRACTIONS[layout][dividerId] ?? 0.5

  const lower = minimum / available
  const upper = 1 - lower
  if (lower >= upper) return 0.5

  let next = Math.min(Math.max(value, lower), upper)
  if (Math.abs(next - 0.5) <= SNAP_THRESHOLD && 0.5 >= lower && 0.5 <= upper) next = 0.5
  return next
}

/**
 * The column boundaries of a layout, in order, read out of a fraction map.
 *
 * Filters entries instead of indexing by id. `f[id]` on a `Record<string, number>`
 * is `number | undefined`, and the guard that would need can never run:
 * `withDefaults` fills every key `DEFAULT_FRACTIONS` declares and `COLUMN_DIVIDERS`
 * names only those. An unreachable guard is a line no test can cover, and this
 * directory is held to covering every line.
 */
function columnFractionsOf(layout: LayoutId, fractions: Fractions): Array<[string, number]> {
  return COLUMN_DIVIDERS[layout].flatMap((id) =>
    Object.entries(fractions).filter(([key]) => key === id)
  )
}

/**
 * The column boundaries of a layout, clamped and put in order *together*.
 *
 * Being in order is not a property any single boundary has, which is why this is
 * not part of `clampFraction`. Clamped independently, the middle boundary of a
 * three-column row can be dragged left of the first one, and the column between
 * them comes out with a negative width — a tile that is not merely narrow but
 * inverted.
 *
 * With one boundary to place this reproduces `clampFraction` exactly: the same
 * bounds, the same detent, the same fallback. That is what makes it safe to run on
 * every layout rather than only on the wide rows.
 */
function clampColumns(
  layout: LayoutId,
  fractions: Fractions,
  content: Size,
  minTile: Size
): Array<[string, number]> {
  const columns = columnFractionsOf(layout, fractions)
  const count = columns.length + 1
  const evenly = (index: number): number => (index + 1) / count
  const minimum = minTile.width / content.width

  /*
    Not enough width for every column to keep its minimum — four columns need 960px
    and a narrow window has less — or no width at all, which is what a layout
    computed before the first paint looks like.

    The columns then share the shortfall equally rather than the left ones keeping
    their minimum and the last collapsing to nothing. An evenly cramped row is still
    the row that was asked for, and it grows back into shape the moment the window
    does; a row with one column missing looks like a bug. This is the choice
    `clampFraction` already makes for a lone divider, where "the layout default" and
    "the even split" happen to be the same number.
  */
  if (!(content.width > 0) || count * minimum > 1) {
    return columns.map(([id], index) => [id, evenly(index)])
  }

  const bounded = columns.map(([id, value], index): [string, number] => {
    // Room for every column left and right of this boundary, not just for the two
    // tiles either side of it: the third boundary of a four-column row has three
    // columns behind it, so it can never come further left than three minimums,
    // however far the user drags.
    const lower = (index + 1) * minimum
    const upper = 1 - (count - index - 1) * minimum
    const clamped = Math.min(Math.max(value, lower), upper)
    // Detent on the even split, as `clampFraction` gives a lone divider. Feasible
    // here by construction, so it needs no in-range test: `count * minimum <= 1`
    // is exactly the statement that every even-split boundary clears its bounds.
    return [id, Math.abs(clamped - evenly(index)) <= SNAP_THRESHOLD ? evenly(index) : clamped]
  })

  /*
    Two sweeps, not one.

    A single pass can only respect the neighbour it has already visited, so pushing
    boundaries rightwards would leave the last column free to be squeezed past the
    window edge. Rightwards first, so every boundary clears the column to its left;
    that leaves boundary i at or above i * minimum, which is what makes the leftward
    sweep safe — pulling a boundary left to clear the column on its right can never
    pull it back over its predecessor, because its predecessor has that much room to
    its own left by then.

    Rejected alternative: rescaling the whole row proportionally when a drag
    violates the minimum. It keeps the order too, but moves boundaries the user did
    not touch, so one dragged divider silently rearranges the others.
  */
  let before = 0
  const pushedRight = bounded.map(([id, value]): [string, number] => {
    const next = Math.max(value, before + minimum)
    before = next
    return [id, next]
  })

  let after = 1
  return pushedRight
    .toReversed()
    .map(([id, value]): [string, number] => {
      const next = Math.min(value, after - minimum)
      after = next
      return [id, next]
    })
    .toReversed()
}

/** Clamps every divider of a layout at once. */
export function clampFractions(
  layout: LayoutId,
  fractions: Fractions,
  content: Size,
  minTile: Size = MIN_TILE_SIZE
): Fractions {
  const merged = withDefaults(layout, fractions)
  const out: Record<string, number> = {}
  for (const [id, value] of Object.entries(merged)) {
    out[id] = clampFraction(layout, id, value, content, minTile)
  }
  /*
    Column boundaries get the last word.

    `clampFraction` above has already produced a value for each of them, correct in
    isolation and not necessarily correct together. This is the only function that
    sees the whole set, so it is where the ordering has to be applied — and it
    replaces rather than adjusts, so there is one account of where a boundary may
    sit instead of two that can disagree.
  */
  for (const [id, value] of clampColumns(layout, merged, content, minTile)) out[id] = value
  return out
}

export interface TileRectOptions {
  minTile?: Size
  /** Gap left between neighbouring tiles; see `TILE_GUTTER`. */
  gutter?: number
}

/**
 * Tile rectangles in device-independent pixels, relative to `content`.
 *
 * Boundaries are rounded, not sizes: adjacent tiles therefore share an exact
 * edge and the grid never shows a one-pixel seam or overlap, whatever the
 * window width happens to be. The gutter is then taken off interior edges only,
 * so the grid still reaches the window edges.
 */
export function computeTileRects(
  layout: LayoutId,
  fractions: Fractions,
  content: Rect,
  options: TileRectOptions = {}
): Rect[] {
  const minTile = options.minTile ?? MIN_TILE_SIZE
  const gutter = Math.max(0, options.gutter ?? 0)
  const f = clampFractions(layout, fractions, content, minTile)
  const { x, y, width, height } = content

  const left = x
  const right = x + width
  const top = y
  const bottom = y + height

  const vx = left + Math.round(width * (f.v ?? 0.5))
  const hy = top + Math.round(height * (f.h ?? 0.5))

  const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0)
  })

  const raw = ((): Rect[] => {
    switch (layout) {
      case '1x1':
        return [rect(left, top, right, bottom)]
      case '1x2':
        return [rect(left, top, vx, bottom), rect(vx, top, right, bottom)]
      case '2x1':
        return [rect(left, top, right, hy), rect(left, hy, right, bottom)]
      case '2x2':
        return [
          rect(left, top, vx, hy),
          rect(vx, top, right, hy),
          rect(left, hy, vx, bottom),
          rect(vx, hy, right, bottom)
        ]
      case '1+2': {
        const ry = top + Math.round(height * (f.hRight ?? 0.5))
        return [rect(left, top, vx, bottom), rect(vx, top, right, ry), rect(vx, ry, right, bottom)]
      }
      case '1x3':
      case '1x4': {
        /*
          One column per gap between consecutive boundaries. `f` came out of
          `clampFractions`, so the values are already ordered — reading them back
          rather than re-deriving them keeps the columns and the divider handles
          answerable to the same numbers.

          Pairing without indexing: dropping the first boundary lines the list up
          with "the boundary before this one", carried in `start`.
        */
        const boundaries = [
          left,
          ...columnFractionsOf(layout, f).map(([, value]) => left + Math.round(width * value)),
          right
        ]
        let start = left
        return boundaries.slice(1).map((end) => {
          const column = rect(start, top, end, bottom)
          start = end
          return column
        })
      }
    }
  })()

  if (gutter === 0) return raw
  return raw.map((tile) => insetInteriorEdges(tile, content, gutter))
}

/**
 * Shrinks a tile away from its neighbours, leaving the outer edges flush with
 * the content area. An edge counts as interior when it does not sit on the
 * content boundary — which is exactly when a neighbour is on the other side.
 */
function insetInteriorEdges(tile: Rect, content: Rect, gutter: number): Rect {
  const half = Math.round(gutter / 2)
  let { x, y, width, height } = tile

  if (x > content.x) {
    x += half
    width -= half
  }
  if (tile.x + tile.width < content.x + content.width) {
    width -= half
  }
  if (y > content.y) {
    y += half
    height -= half
  }
  if (tile.y + tile.height < content.y + content.height) {
    height -= half
  }

  return { x, y, width: Math.max(0, width), height: Math.max(0, height) }
}

/**
 * Directional tile navigation for Ctrl+Alt+Arrow. Uses rectangle geometry
 * rather than a hand-written table per layout, so it stays correct when the
 * user has dragged the dividers into an asymmetric arrangement.
 *
 * Returns `null` when there is no tile in that direction, so the caller can
 * decide whether to wrap, beep, or do nothing.
 */
export function tileInDirection(
  rects: readonly Rect[],
  from: number,
  direction: 'left' | 'right' | 'up' | 'down'
): number | null {
  const origin = rects[from]
  if (!origin) return null

  const horizontal = direction === 'left' || direction === 'right'
  const originCenter = horizontal
    ? origin.y + origin.height / 2
    : origin.x + origin.width / 2

  let best: { index: number; primary: number; secondary: number } | null = null

  for (let index = 0; index < rects.length; index++) {
    if (index === from) continue
    const candidate = rects[index]
    if (!candidate) continue

    // Must actually lie in the requested direction.
    const advance = (() => {
      switch (direction) {
        case 'left':
          return origin.x - candidate.x
        case 'right':
          return candidate.x - origin.x
        case 'up':
          return origin.y - candidate.y
        case 'down':
          return candidate.y - origin.y
      }
    })()
    if (advance <= 0) continue

    // Must overlap on the perpendicular axis, otherwise it is diagonal.
    const overlaps = horizontal
      ? candidate.y < origin.y + origin.height && candidate.y + candidate.height > origin.y
      : candidate.x < origin.x + origin.width && candidate.x + candidate.width > origin.x
    if (!overlaps) continue

    const candidateCenter = horizontal
      ? candidate.y + candidate.height / 2
      : candidate.x + candidate.width / 2
    const secondary = Math.abs(candidateCenter - originCenter)

    if (!best || advance < best.primary || (advance === best.primary && secondary < best.secondary)) {
      best = { index, primary: advance, secondary }
    }
  }

  return best?.index ?? null
}
