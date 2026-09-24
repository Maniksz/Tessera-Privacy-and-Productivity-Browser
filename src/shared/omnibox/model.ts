import type { SuggestionSource } from '../search/rank.js'
import type { Rect } from '../ui/anchor.js'

/**
 * The address bar's suggestion list (U18, R28–R30, KTD12): what the layer is sent and what a choice does.
 *
 * ## Who holds what
 *
 * The chrome UI sends a kind, the field's rectangle and the text, with a running number (`seq`). The core
 * fills the rows from its stores — the chrome UI is never asked for rows, so it cannot show any the core
 * would not — and presents them on the overlay layer, because a list drawn in the toolbar's DOM would sit
 * behind the page. Both renderers are then told the same presentation: the overlay draws it, the address
 * bar walks it with the arrow keys. The number is how either side knows a presentation still belongs to
 * what is in the field.
 *
 * ## Row zero
 *
 * Always what Enter would do with the text as typed: open it, or search for it. That is the line the old
 * hint under the field said, drawn behind the page where nobody could see it; here it is the first row,
 * and the one selected until an arrow key moves on. Its index is 0, the ranked rows follow from 1.
 *
 * Zod-free, like every model both renderers import; the wire shapes are in `schema.ts`.
 */

/** What row zero says: which address Enter opens, or which engine it searches with. */
export type OmniboxLead = { action: 'open'; url: string } | { action: 'search'; engine: string }

/** One ranked suggestion, as the list draws it and a choice acts on it. */
export interface OmniboxRow {
  source: SuggestionSource
  title: string
  url: string
  /** The open tab this row switches to, or `null` for a row that navigates instead. */
  tabId: string | null
}

/** The list on the overlay layer; see `OVERLAY_REGION['omnibox-suggestions']`. */
export interface OmniboxSuggestionsPresentation {
  kind: 'omnibox-suggestions'
  /** The request this answers. A presentation whose number is not the latest sent is stale. */
  seq: number
  /** The list, in window coordinates, below the address field. */
  bounds: Rect
  /** The text it was ranked against, which is what row zero opens or searches for. */
  text: string
  lead: OmniboxLead
  /** At most `MAX_RANKED_ROWS`, best first. May be empty: row zero is always there. */
  rows: OmniboxRow[]
  /** 0 for row zero, `n` for `rows[n - 1]`. */
  selected: number
}

/** What the address bar sends on every keystroke and arrow key. Never rows. */
export interface OmniboxSuggestRequest {
  seq: number
  text: string
  /** The address field's box, in window coordinates. */
  anchor: Rect
  selected: number
}

/** Every source a row can come from, for the wire schema; kept equal to `SuggestionSource` there. */
export const OMNIBOX_ROW_SOURCES = ['history', 'bookmark', 'quicklink', 'tab'] as const

/**
 * The longest text that is ranked. A pasted `data:` address can run to megabytes, and ranking it on every
 * keystroke would stall the core for text nobody wants suggestions for; past this the list closes.
 */
export const OMNIBOX_MAX_TEXT = 2048

/** One row's height. The surface draws rows at exactly this height, so the box always fits them. */
export const OMNIBOX_ROW_HEIGHT = 34
/** The frame's padding above and below the rows. */
export const OMNIBOX_LIST_PADDING = 4
/** The gap between the field and the list. */
export const OMNIBOX_LIST_GAP = 4

/** The list's rectangle: under the field, as wide as it, as tall as row zero plus `rowCount` rows. */
export function omniboxListBounds(anchor: Rect, rowCount: number): Rect {
  return {
    x: anchor.x,
    y: anchor.y + anchor.height + OMNIBOX_LIST_GAP,
    width: anchor.width,
    height: (rowCount + 1) * OMNIBOX_ROW_HEIGHT + 2 * OMNIBOX_LIST_PADDING
  }
}

/** `selected` held inside the list: row zero up to the last ranked row. */
export function clampSelection(selected: number, rowCount: number): number {
  return Math.min(Math.max(0, Math.trunc(selected)), rowCount)
}

/** Where an arrow key moves the selection. Stops at both ends rather than wrapping. */
export function nextSelection(selected: number, rowCount: number, key: 'up' | 'down'): number {
  return clampSelection(key === 'down' ? selected + 1 : selected - 1, rowCount)
}

/**
 * What choosing row `index` does: switch to a tab (`tabs:activate`), or navigate (`nav:navigate`).
 *
 * Row zero, and an index past the end, navigate the typed text — the same as Enter with nothing chosen,
 * so a choice can never do something the first row did not say.
 */
export function omniboxChoice(
  presentation: Pick<OmniboxSuggestionsPresentation, 'text' | 'rows'>,
  index: number
): { tabId: string } | { input: string } {
  const row = index > 0 ? presentation.rows[index - 1] : undefined
  if (row === undefined) return { input: presentation.text }
  if (row.tabId !== null) return { tabId: row.tabId }
  return { input: row.url }
}
