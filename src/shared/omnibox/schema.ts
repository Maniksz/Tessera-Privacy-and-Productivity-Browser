import { z } from 'zod'
import type { SameShape } from '../ipc/same-shape.js'
import { MAX_RANKED_ROWS, type SuggestionSource } from '../search/rank.js'
import {
  OMNIBOX_MAX_TEXT,
  OMNIBOX_ROW_SOURCES,
  type OmniboxSuggestRequest,
  type OmniboxSuggestionsPresentation
} from './model.js'

/**
 * The address bar's suggestions on the wire (U18), spread into `shared/ipc/contract.ts`.
 *
 * Here rather than there for the passwords' reason: the contract is past its line bar, and each shape sits
 * beside the model it has to agree with, checked both ways by `SameShape`.
 */

const nothing = z.void()
const ok = z.object({ ok: z.literal(true) })
const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })

const _sourcesMatchRanker: SameShape<(typeof OMNIBOX_ROW_SOURCES)[number], SuggestionSource> = true
void _sourcesMatchRanker

/**
 * The list as the layer is sent it. Never more rows than the ranker returns, so a presentation cannot
 * become a way to hand a renderer the whole history.
 */
export const omniboxSuggestionsPresentationSchema = z.object({
  kind: z.literal('omnibox-suggestions'),
  seq: z.number().int().nonnegative(),
  bounds: rectSchema,
  text: z.string().max(OMNIBOX_MAX_TEXT),
  lead: z.discriminatedUnion('action', [
    z.object({ action: z.literal('open'), url: z.string() }),
    z.object({ action: z.literal('search'), engine: z.string() })
  ]),
  rows: z
    .array(
      z.object({
        source: z.enum(OMNIBOX_ROW_SOURCES),
        title: z.string(),
        url: z.string(),
        tabId: z.string().nullable()
      })
    )
    .max(MAX_RANKED_ROWS),
  selected: z.number().int().nonnegative()
})

/**
 * What the address bar may send: the text, where the field is, and a number. Strict, so rows in a request
 * are refused rather than overwritten — the chrome UI has none to give (KTD12).
 */
export const omniboxSuggestRequestSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  text: z.string().max(OMNIBOX_MAX_TEXT),
  anchor: rectSchema,
  selected: z.number().int().nonnegative()
})

const _presentationWireMatchesModel: SameShape<
  z.output<typeof omniboxSuggestionsPresentationSchema>,
  OmniboxSuggestionsPresentation
> = true
void _presentationWireMatchesModel
const _requestWireMatchesModel: SameShape<
  z.output<typeof omniboxSuggestRequestSchema>,
  OmniboxSuggestRequest
> = true
void _requestWireMatchesModel

export const omniboxInvokeContract = {
  /**
   * One keystroke or arrow key in the address bar. The core ranks, presents and drops what is stale; the
   * answer arrives as `overlay:presented`, which both renderers already follow.
   */
  'omnibox:suggest': { request: omniboxSuggestRequestSchema, response: ok },
  /** Escape in the address bar: closes the list, and only the list. */
  'omnibox:close': { request: nothing, response: ok }
}
