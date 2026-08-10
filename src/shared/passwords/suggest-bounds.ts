import { anchorSurface, type Rect } from '../ui/anchor.js'
import type { AutofillSuggestContent } from '../overlay/surface.js'

/**
 * Where the account picker goes, from what the page can see and what only the core knows.
 *
 * ## The chain, and why it has four links rather than one
 *
 * The page knows where its field is and cannot be trusted about anything else; the core knows where the
 * page is and has never heard of a field. Neither half can produce this rectangle alone, so the report
 * crosses the boundary in the units the page has — CSS pixels from `getBoundingClientRect()`, plus the
 * visual viewport's scale and offset — and every conversion happens here, in the core, once:
 *
 *  1. **Pinch.** `getBoundingClientRect()` is relative to the *layout* viewport, while the pixels on
 *     screen are the *visual* one. Subtracting `visualViewport.offsetLeft` / `offsetTop` moves the point
 *     into the visible box; multiplying by `visualViewport.scale` turns a CSS pixel into a rendered one.
 *     Skip either and a pinched-in page puts the list at the field's un-zoomed position, which at scale 2
 *     is halfway across the tile.
 *  2. **Page zoom.** A tile at 150 % renders every CSS pixel one and a half pixels wide. The page cannot
 *     report this — `getBoundingClientRect()` is in CSS pixels precisely so that it does not change when
 *     the user zooms — so the factor comes from the tile.
 *  3. **The view's origin.** Everything above is relative to the top-left of the page view. The overlay
 *     layer works in window coordinates, and in a split layout the view's own origin is the only thing
 *     that says which of four tiles the field is in.
 *  4. **Placement.** With the field located, `anchorSurface` puts the list below it, or above when there
 *     is not enough room below, clamped into the tile so a list in one pane never covers its neighbour.
 *
 * ## Why nothing here follows the field
 *
 * The list closes on a scroll, a zoom or a resize rather than tracking the field (KTD9). Keeping a
 * conversion of four factors correct *continuously* costs more than reopening the list costs the user,
 * and it fails in the direction that matters: a stale rectangle is a menu of the user's account names
 * floating over the wrong part of a page. So this function answers "where is it *now*", once per
 * presentation, and the core takes the surface down when any input to it changes.
 *
 * ## Why it is its own module
 *
 * Zod-free and dependency-free, like `ui/anchor.ts`: the overlay renderer reaches it at runtime, and
 * `fill-policy.ts` next door carries the public-suffix table. Pure, so the hard part of this feature is
 * a table of cases rather than something you find out by pinch-zooming a real page and squinting.
 */

/** One saved credential, one line. Tall enough to be a pointer target without being a button. */
export const AUTOFILL_SUGGEST_ROW_HEIGHT = 44

/**
 * How many credentials are visible before the list scrolls.
 *
 * A ceiling rather than a scroll bar's business, because this surface subtracts its own rectangle from
 * the page underneath: somebody with thirty accounts on one site would otherwise get a menu covering the
 * form they are trying to fill in.
 */
export const AUTOFILL_SUGGEST_MAX_ROWS = 5

/**
 * A statement instead of a list — locked, nothing saved, refused, switched off.
 *
 * Taller than a row and deliberately so. These are sentences, not names, and they are translated: the
 * German for "this page is not encrypted, so the password was not offered" wraps to two lines at this
 * width, and a notice clipped at one line is a refusal the user cannot read.
 */
export const AUTOFILL_SUGGEST_NOTICE_HEIGHT = 64

/** Wide enough for an e-mail address, narrow enough not to cover the form. Matches the find bar. */
export const AUTOFILL_SUGGEST_WIDTH = 320

/** The frame's own breathing room, above and below the content, so the first row is not against the edge. */
export const AUTOFILL_SUGGEST_PADDING = 6

/**
 * The gap between the field and the list, and the clearance the list keeps from the tile's edges.
 *
 * The inset is the find bar's, for the same reason: it is what makes the surface legible as something
 * floating over the page rather than as part of it, and it keeps the list off a tile's border in a split.
 */
export const AUTOFILL_SUGGEST_GAP = 4
export const AUTOFILL_SUGGEST_INSET = 8

/** Less than this and there is no list, only a sliver holding the layer. See `autofillSuggestBounds`. */
export const AUTOFILL_SUGGEST_MIN_HEIGHT = AUTOFILL_SUGGEST_PADDING * 2 + AUTOFILL_SUGGEST_ROW_HEIGHT

/**
 * The field, as the page is able to describe it.
 *
 * Every number here comes from a renderer and is therefore a claim, not a fact — which is exactly why it
 * is only ever used to decide *where to draw*. A page that lies about its own field moves our list around
 * its own document and gains nothing else: the credential is chosen in the chrome and the fill is
 * re-checked against the document as it is at that moment.
 */
export interface ReportedFieldRect {
  /** `getBoundingClientRect()`, in CSS pixels, relative to the layout viewport. */
  readonly rect: Rect
  /** `visualViewport.scale`: 1 unless the user has pinched. */
  readonly scale: number
  /** `visualViewport.offsetLeft`, in CSS pixels. */
  readonly offsetX: number
  /** `visualViewport.offsetTop`, in CSS pixels. */
  readonly offsetY: number
}

/** The page view the field is in, as the core knows it. */
export interface SuggestViewGeometry {
  /** The tile this view fills, in window coordinates — the same rectangle the find bar is clamped to. */
  readonly bounds: Rect
  /** The tile's page zoom as a factor: 1.5 at 150 %. Never a percentage, so the arithmetic is one step. */
  readonly pageZoom: number
}

/** Rounds an edge pair together, so a rectangle cannot gain or lose a pixel by rounding twice. */
function roundSpan(start: number, length: number): { start: number; length: number } {
  const from = Math.round(start)
  return { start: from, length: Math.round(start + length) - from }
}

function overlaps(rect: Rect, within: Rect): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false
  if (rect.x + rect.width <= within.x || rect.x >= within.x + within.width) return false
  return rect.y + rect.height > within.y && rect.y < within.y + within.height
}

/**
 * The field's rectangle in window coordinates, or `null` when it is not on screen.
 *
 * `null` rather than an off-screen rectangle, and that is the answer to the case this is most likely to
 * meet: a page that scrolls the field out from under its own badge, or reports a rectangle from before it
 * did. Clamped instead, the list would appear pinned to the top or bottom edge of the tile with no field
 * beside it — a menu of the user's account names apparently belonging to whatever is there now.
 */
export function fieldRectInWindow(
  field: ReportedFieldRect,
  view: SuggestViewGeometry
): Rect | null {
  const factor = field.scale * view.pageZoom
  if (!(factor > 0)) return null

  const horizontal = roundSpan(
    view.bounds.x + (field.rect.x - field.offsetX) * factor,
    field.rect.width * factor
  )
  const vertical = roundSpan(
    view.bounds.y + (field.rect.y - field.offsetY) * factor,
    field.rect.height * factor
  )
  const rect: Rect = {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.length,
    height: vertical.length
  }
  return overlaps(rect, view.bounds) ? rect : null
}

/**
 * How tall the list wants to be for what it has to say.
 *
 * An exhaustive switch, so a sixth content state cannot be added without deciding how much room it
 * needs — the failure otherwise is a state that renders into a box sized for a different one.
 */
export function autofillSuggestHeight(content: AutofillSuggestContent): number {
  return AUTOFILL_SUGGEST_PADDING * 2 + contentHeight(content)
}

function contentHeight(content: AutofillSuggestContent): number {
  switch (content.state) {
    case 'entries':
      /*
        A floor of one row, although the core never sends an offer of nothing — an empty offer is the
        `empty` state, which is a sentence. The floor is here because the alternative is a twelve-pixel
        box: a surface too small to see, holding the layer against everything else, which is the failure
        `findBarPresentation` refuses at the other end.
      */
      return (
        Math.max(1, Math.min(content.entries.length, AUTOFILL_SUGGEST_MAX_ROWS)) *
        AUTOFILL_SUGGEST_ROW_HEIGHT
      )
    case 'locked':
      // A sentence and a button under it. The button is a real control and needs a row of its own.
      return AUTOFILL_SUGGEST_NOTICE_HEIGHT + AUTOFILL_SUGGEST_ROW_HEIGHT
    case 'empty':
    case 'refused':
    case 'disabled':
      return AUTOFILL_SUGGEST_NOTICE_HEIGHT
  }
}

/**
 * The list's rectangle in window coordinates, or `null` when there is nowhere to put it.
 *
 * Three ways to have no rectangle, all ordinary rather than exceptional, and each of them is a
 * presentation the core declines to make:
 *
 *  - the field is not on screen — see `fieldRectInWindow`;
 *  - the tile is too narrow to hold a list clear of its own edges, which a grid computed before the
 *    first paint produces;
 *  - the tile is too short to hold even one row, so the list would be a sliver of a menu.
 *
 * Anchored in tile-local coordinates and translated back afterwards, which is what makes the clamp a
 * clamp *to the tile* rather than to the window: clamped to the window, a list against a field near the
 * left edge of the right-hand pane would grow across the pane beside it — the one thing a per-tile
 * surface may never do.
 */
export function autofillSuggestBounds(input: {
  readonly field: ReportedFieldRect
  readonly view: SuggestViewGeometry
  readonly content: AutofillSuggestContent
}): Rect | null {
  const { view } = input
  const anchor = fieldRectInWindow(input.field, view)
  if (anchor === null) return null

  const placed = anchorSurface(
    { ...anchor, x: anchor.x - view.bounds.x, y: anchor.y - view.bounds.y },
    { width: AUTOFILL_SUGGEST_WIDTH, height: autofillSuggestHeight(input.content) },
    { width: view.bounds.width, height: view.bounds.height },
    {
      gap: AUTOFILL_SUGGEST_GAP,
      margin: AUTOFILL_SUGGEST_INSET,
      // Lined up with the field's left edge, the way a menu under a text field reads. `end` would hang
      // the list off the right edge of a field that is wider than it is.
      align: 'start'
    }
  )

  if (placed.rect.width <= 0 || placed.rect.height < AUTOFILL_SUGGEST_MIN_HEIGHT) return null
  return {
    ...placed.rect,
    x: placed.rect.x + view.bounds.x,
    y: placed.rect.y + view.bounds.y
  }
}
