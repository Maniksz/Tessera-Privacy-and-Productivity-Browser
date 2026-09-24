import { describe, expect, it } from 'vitest'
import {
  AUTOFILL_SUGGEST_MAX_ROWS,
  AUTOFILL_SUGGEST_MIN_HEIGHT,
  AUTOFILL_SUGGEST_NOTICE_HEIGHT,
  AUTOFILL_SUGGEST_PADDING,
  AUTOFILL_SUGGEST_ROW_HEIGHT,
  AUTOFILL_SUGGEST_WIDTH,
  autofillSuggestBounds,
  autofillSuggestBoundsAt,
  autofillSuggestHeight,
  fieldRectInWindow,
  type ReportedFieldRect,
  type SuggestViewGeometry
} from '@shared/passwords/suggest-bounds.js'
import type { AutofillSuggestContent } from '@shared/overlay/surface.js'

/**
 * Where the account picker lands, from four facts that live in three different places.
 *
 * This is the hardest arithmetic in the feature and the one whose failure is loudest: get it wrong and a
 * menu of somebody's account names appears beside the wrong part of a page, or over a neighbouring tile.
 * A table of cases is the only way to hold it — pinch-zooming a real page and squinting tells you that
 * *this* case works, and nothing about the other seven.
 *
 * The cases are written as the chain: no zoom, page zoom, pinch, both; then the two ways there is nowhere
 * to put a list at all.
 */

/** One full-width tile under an 88px chrome, which is the geometry every other case varies from. */
const TILE: SuggestViewGeometry = {
  bounds: { x: 0, y: 88, width: 1440, height: 812 },
  pageZoom: 1
}

/** A field near the top of the page, reported by a page that is neither zoomed nor pinched. */
function field(overrides: Partial<ReportedFieldRect> = {}): ReportedFieldRect {
  return {
    rect: { x: 100, y: 40, width: 240, height: 32 },
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    ...overrides
  }
}

const TWO_ENTRIES: AutofillSuggestContent = {
  state: 'entries',
  entries: [
    { id: 'p1', username: 'ada@example.com' },
    { id: 'p2', username: 'grace@example.com' }
  ]
}

/** What two rows come to, so the expected rectangles below do not hard-code a number twice. */
const TWO_ROW_HEIGHT = AUTOFILL_SUGGEST_ROW_HEIGHT * 2 + AUTOFILL_SUGGEST_PADDING * 2

function entriesOf(count: number): AutofillSuggestContent {
  return {
    state: 'entries',
    entries: Array.from({ length: count }, (_, index) => ({
      id: `p${index}`,
      username: `user${index}@example.com`
    }))
  }
}

describe('the field, converted into the window', () => {
  it('offsets an unzoomed field by the view it sits in', () => {
    // The simplest link of the chain, and the one every other case is measured against: CSS pixels are
    // window pixels, and all that happens is the tile's own origin being added.
    expect(fieldRectInWindow(field(), TILE)).toEqual({ x: 100, y: 128, width: 240, height: 32 })
  })

  it('scales a field by the tile page zoom', () => {
    /*
      A tile at 150 % renders every CSS pixel one and a half pixels wide, and the page cannot report that
      — `getBoundingClientRect()` is in CSS pixels precisely so that it does not move when the user zooms.
      Left out, the list would appear a third of the way back towards the top-left of the page.
    */
    expect(fieldRectInWindow(field(), { ...TILE, pageZoom: 1.5 })).toEqual({
      x: 150,
      y: 148,
      width: 360,
      height: 48
    })
  })

  it('subtracts the visual viewport offset before scaling by the pinch', () => {
    /*
      Both halves of the pinch, in the order they have to happen. `getBoundingClientRect()` is relative to
      the *layout* viewport while the pixels are the *visual* one, so the offset comes off first and the
      scale is applied to what is left. Scaling first would multiply the offset too and put the list
      further away the harder the user had pinched.
    */
    expect(fieldRectInWindow(field({ scale: 2, offsetX: 50, offsetY: 30 }), TILE)).toEqual({
      x: 100,
      y: 108,
      width: 480,
      height: 64
    })
  })

  it('multiplies pinch and page zoom together', () => {
    // The two are independent factors on the same pixel: 150 % of a page pinched to 2 is three times.
    expect(
      fieldRectInWindow(field({ scale: 2, offsetX: 50, offsetY: 30 }), { ...TILE, pageZoom: 1.5 })
    ).toEqual({ x: 150, y: 118, width: 720, height: 96 })
  })

  it('places a field in the tile it belongs to, not in the window', () => {
    // What a split layout turns this into: the same CSS rectangle in the right-hand pane is 720 pixels
    // further along, and a conversion that forgot the origin would draw the list over the left pane.
    const right: SuggestViewGeometry = {
      bounds: { x: 720, y: 88, width: 720, height: 812 },
      pageZoom: 1
    }
    expect(fieldRectInWindow(field(), right)).toEqual({ x: 820, y: 128, width: 240, height: 32 })
  })

  it('answers nothing for a field scrolled out of view', () => {
    /*
      `null` rather than a clamped rectangle, and this is the case it is most likely to meet: a page that
      scrolled the field away from under its own badge, or reported a rectangle from before it did.
      Clamped, the list would sit pinned to the edge of the tile with no field beside it — a menu of the
      user's account names apparently belonging to whatever is there now.
    */
    expect(
      fieldRectInWindow(field({ rect: { x: 100, y: 900, width: 240, height: 32 } }), TILE)
    ).toBe(null)
    expect(
      fieldRectInWindow(field({ rect: { x: -300, y: 40, width: 240, height: 32 } }), TILE)
    ).toBe(null)
  })

  it('answers nothing for a field with no area', () => {
    // A display:none field still has a rectangle; it is 0x0. There is nothing to anchor to.
    expect(fieldRectInWindow(field({ rect: { x: 100, y: 40, width: 0, height: 0 } }), TILE)).toBe(
      null
    )
  })

  it('answers nothing for a scale that cannot be a scale', () => {
    // A renderer reporting zero would otherwise collapse the field to a point at the tile's origin, and
    // the list would appear in the top-left corner of the page for no visible reason.
    expect(fieldRectInWindow(field({ scale: 0 }), TILE)).toBe(null)
    expect(fieldRectInWindow(field(), { ...TILE, pageZoom: 0 })).toBe(null)
  })
})

describe('how tall the list wants to be', () => {
  it('gives one row per credential', () => {
    expect(autofillSuggestHeight(entriesOf(1))).toBe(
      AUTOFILL_SUGGEST_ROW_HEIGHT + AUTOFILL_SUGGEST_PADDING * 2
    )
    expect(autofillSuggestHeight(TWO_ENTRIES)).toBe(TWO_ROW_HEIGHT)
  })

  it('stops at the visible maximum however many are saved', () => {
    /*
      The surface subtracts its own rectangle from the page underneath, so somebody with thirty accounts
      on one site would otherwise get a menu covering the form they are trying to fill in.
    */
    const full = autofillSuggestHeight(entriesOf(AUTOFILL_SUGGEST_MAX_ROWS))
    expect(autofillSuggestHeight(entriesOf(30))).toBe(full)
    expect(full).toBe(
      AUTOFILL_SUGGEST_MAX_ROWS * AUTOFILL_SUGGEST_ROW_HEIGHT + AUTOFILL_SUGGEST_PADDING * 2
    )
  })

  it('keeps a floor of one row for a list that arrived empty', () => {
    // The core sends `empty` rather than an offer of nothing, so this is a defence and not a state. What
    // it defends against is a twelve-pixel box: a surface too small to see, holding the layer.
    expect(autofillSuggestHeight(entriesOf(0))).toBe(AUTOFILL_SUGGEST_MIN_HEIGHT)
  })

  it('gives every notice a line of its own', () => {
    const notice = AUTOFILL_SUGGEST_NOTICE_HEIGHT + AUTOFILL_SUGGEST_PADDING * 2
    expect(autofillSuggestHeight({ state: 'empty' })).toBe(notice)
    expect(autofillSuggestHeight({ state: 'disabled' })).toBe(notice)
    expect(autofillSuggestHeight({ state: 'refused', reason: 'insecure-page' })).toBe(notice)
  })

  it('gives the locked state room for its unlock button', () => {
    // The one notice with a real control under it, and a button needs a row rather than a sentence.
    expect(autofillSuggestHeight({ state: 'locked' })).toBe(
      AUTOFILL_SUGGEST_NOTICE_HEIGHT + AUTOFILL_SUGGEST_ROW_HEIGHT + AUTOFILL_SUGGEST_PADDING * 2
    )
  })
})

describe('where the list lands', () => {
  it('puts a list under a field near the top of the page', () => {
    expect(autofillSuggestBounds({ field: field(), view: TILE, content: TWO_ENTRIES })).toEqual({
      x: 100,
      y: 164,
      width: AUTOFILL_SUGGEST_WIDTH,
      height: TWO_ROW_HEIGHT
    })
  })

  it('flips above a field at the bottom edge', () => {
    /*
      The case that decides whether the feature is usable on a sign-in form at the foot of a long page.
      Below, the list would be clamped to whatever few pixels remain and the user would pick an account
      from a two-pixel sliver.
    */
    const placed = autofillSuggestBounds({
      field: field({ rect: { x: 100, y: 780, width: 240, height: 32 } }),
      view: TILE,
      content: TWO_ENTRIES
    })
    expect(placed).toEqual({
      x: 100,
      y: 764,
      width: AUTOFILL_SUGGEST_WIDTH,
      height: TWO_ROW_HEIGHT
    })
    // Its foot is above the field's head, which is the whole claim of "above".
    expect(placed!.y + placed!.height).toBeLessThan(88 + 780)
  })

  it('follows the field through a page zoom of 150 %', () => {
    expect(
      autofillSuggestBounds({
        field: field(),
        view: { ...TILE, pageZoom: 1.5 },
        content: TWO_ENTRIES
      })
    ).toEqual({ x: 150, y: 200, width: AUTOFILL_SUGGEST_WIDTH, height: TWO_ROW_HEIGHT })
  })

  it('follows the field through a pinch of 2.0 with an offset', () => {
    expect(
      autofillSuggestBounds({
        field: field({ scale: 2, offsetX: 50, offsetY: 30 }),
        view: TILE,
        content: TWO_ENTRIES
      })
    ).toEqual({ x: 100, y: 176, width: AUTOFILL_SUGGEST_WIDTH, height: TWO_ROW_HEIGHT })
  })

  it('does not grow the list itself when the page is zoomed', () => {
    /*
      Deliberate, and worth an assertion because the opposite is the easy mistake. The list is browser
      chrome: it is drawn by our renderer at the window's own scale, and the page's zoom decides only
      *where* it goes. A list that scaled with the page would be a 480-pixel menu at 150 % — chrome that
      resizes because a page did.
    */
    const zoomed = autofillSuggestBounds({
      field: field(),
      view: { ...TILE, pageZoom: 1.5 },
      content: TWO_ENTRIES
    })
    expect(zoomed?.width).toBe(AUTOFILL_SUGGEST_WIDTH)
    expect(zoomed?.height).toBe(TWO_ROW_HEIGHT)
  })

  it('keeps a list against a field near a tile edge inside that tile', () => {
    /*
      The one thing a per-tile surface may never do. Clamped to the *window* instead of the tile, a list
      anchored to a field at the right of the right-hand pane would grow across the pane beside it — and
      the layer swallows pointer events, so it would also make that neighbour unclickable.
    */
    const right: SuggestViewGeometry = {
      bounds: { x: 720, y: 88, width: 720, height: 812 },
      pageZoom: 1
    }
    const placed = autofillSuggestBounds({
      field: field({ rect: { x: 600, y: 40, width: 100, height: 32 } }),
      view: right,
      content: TWO_ENTRIES
    })
    expect(placed).not.toBe(null)
    expect(placed!.x).toBeGreaterThanOrEqual(right.bounds.x)
    expect(placed!.x + placed!.width).toBeLessThanOrEqual(right.bounds.x + right.bounds.width)
  })

  it('shows the visible maximum and no more when there are more accounts than that', () => {
    const placed = autofillSuggestBounds({
      field: field(),
      view: TILE,
      content: entriesOf(30)
    })
    expect(placed?.height).toBe(autofillSuggestHeight(entriesOf(AUTOFILL_SUGGEST_MAX_ROWS)))
  })

  it('answers nothing for a field that is not on screen', () => {
    expect(
      autofillSuggestBounds({
        field: field({ rect: { x: 100, y: 900, width: 240, height: 32 } }),
        view: TILE,
        content: TWO_ENTRIES
      })
    ).toBe(null)
  })

  it('answers nothing for a tile too short to hold even one row', () => {
    /*
      What a grid computed before the first paint produces. Presented anyway it would be a sliver of a
      menu holding the layer against everything else — the failure `findBarPresentation` refuses at the
      other end of this feature.
    */
    expect(
      autofillSuggestBounds({
        field: field({ rect: { x: 100, y: 10, width: 240, height: 20 } }),
        view: { bounds: { x: 0, y: 88, width: 1440, height: 60 }, pageZoom: 1 },
        content: TWO_ENTRIES
      })
    ).toBe(null)
  })

  it('answers nothing for a tile too narrow to hold a list clear of its own edges', () => {
    expect(
      autofillSuggestBounds({
        field: field({ rect: { x: 0, y: 10, width: 8, height: 20 } }),
        view: { bounds: { x: 0, y: 88, width: 12, height: 400 }, pageZoom: 1 },
        content: TWO_ENTRIES
      })
    ).toBe(null)
  })
})

describe('where the list lands when the toolbar key asked for it', () => {
  // The key sits in the toolbar, above the tile: window coordinates, y inside the 88px chrome.
  const KEY = { x: 1300, y: 44, width: 32, height: 32 }

  it('opens at the top of the tile, right-aligned under the key', () => {
    const bounds = autofillSuggestBoundsAt({ anchor: KEY, view: TILE, content: TWO_ENTRIES })

    expect(bounds).toEqual({
      x: KEY.x + KEY.width - AUTOFILL_SUGGEST_WIDTH,
      y: TILE.bounds.y + 4,
      width: AUTOFILL_SUGGEST_WIDTH,
      height: TWO_ROW_HEIGHT
    })
  })

  it('stays inside the tile it is about, not the one the key happens to be above', () => {
    // The left of two tiles, with the key above the right one: the list is clamped back into its own.
    const left: SuggestViewGeometry = {
      bounds: { x: 0, y: 88, width: 700, height: 812 },
      pageZoom: 1
    }

    const bounds = autofillSuggestBoundsAt({ anchor: KEY, view: left, content: TWO_ENTRIES })

    expect(bounds?.x).toBe(700 - 8 - AUTOFILL_SUGGEST_WIDTH)
  })

  it('has no rectangle in a tile too short for one row', () => {
    const short: SuggestViewGeometry = {
      bounds: { x: 0, y: 88, width: 1440, height: 40 },
      pageZoom: 1
    }

    expect(autofillSuggestBoundsAt({ anchor: KEY, view: short, content: TWO_ENTRIES })).toBeNull()
  })
})
