import { z } from 'zod'
import { LAYOUT_IDS } from '../split/layout.js'
import { tileAudioSchema } from '../model.js'
import type { SameShape } from '../ipc/same-shape.js'
import { stripSpotSchema } from '../strip/schema.js'
import type { KnownFields } from '../known-fields.js'
import type { Arrangement, ArrangementDocument } from './model.js'
import type { ArrangementSummary } from './screen.js'

/**
 * What `arrangements.json` must look like to be usable.
 *
 * Separate from `model.ts` for the reason that file's header gives: the split view is a
 * renderer, and a value import of zod anywhere reachable from it lands in a bundle the user
 * waits for. An architecture test walks that graph, so the split is enforced rather than
 * remembered.
 *
 * ## Strict about identity, healing about values
 *
 * The line is the one `HistoryStore` and `TabGroupStore` draw, and it is drawn by what a
 * failure costs: `JsonStore` replaces a document that fails validation with the defaults, so
 * every field that could plausibly change shape between versions has to heal or a future
 * build will silently throw away every arrangement the user has.
 *
 *   - **`id` stays strict.** A recording whose id is a number is not a document this browser
 *     wrote, and there is no value to heal towards — the id is how `forgetArrangement`
 *     addresses it.
 *   - **`layoutId` heals to `1x1`.** Dropping a layout from `LAYOUT_IDS` in a later version
 *     would otherwise cost the user every recording rather than the ones that used it. `1x1`
 *     is chosen because it is the one layout that cannot legally hold an arrangement: its
 *     single tile is below `MIN_ARRANGED_TILES`, so `repairArrangements` discards exactly
 *     that recording on the very next pass. The healed value is a way of marking a record
 *     for deletion by a rule the schema cannot express.
 *   - **A seat that is not a tab id heals to an empty tile**, and the healing is on the
 *     element rather than the array. One malformed entry would otherwise fail its recording,
 *     which fails the array, which fails the document — every arrangement lost over one bad
 *     string. Emptied, the recording either still seats `MIN_ARRANGED_TILES` tabs and is
 *     usable, or it does not and `repairArrangements` drops it.
 *   - **`recordedAt` heals to 0.** It orders `reconcileArrangements` and nothing else; a
 *     nonsense timestamp makes a recording the older of two sharing a tab, which is the right
 *     outcome for a record nobody can date.
 *   - **The view heals field by field to an empty value** — `activeTile` to 0, `fractions` to
 *     none, `tileAudio` to no tiles, and a single malformed tile's sound to loud. The version-1
 *     migration writes every field, so this is the net under it: a file cut short or edited by
 *     hand. Empty rather than the layout's defaults, because the defaults depend on the layout
 *     and a field schema cannot see its neighbour; `repairArrangements` fills them in. A view
 *     is how a recording looked, never whether it exists, so no view field may cost one.
 *
 * The cross-field facts — a seating whose length matches its layout, no tab in two tiles, at
 * least `MIN_ARRANGED_TILES` seated, a view that fits the layout — cannot be stated here at all
 * and belong to `repairArrangements`, which runs on the loaded document.
 */
export const arrangementSchema = z.looseObject({
  id: z.string().min(1),
  layoutId: z.enum(LAYOUT_IDS).catch('1x1'),
  seats: z.array(z.string().min(1).nullable().catch(null)),
  activeTile: z.number().int().nonnegative().catch(0),
  fractions: z.record(z.string(), z.number()).catch({}),
  tileAudio: z.array(tileAudioSchema.catch({ muted: false, volume: 1 })).catch([]),
  recordedAt: z.number().int().nonnegative().catch(0)
})

/**
 * Both levels keep fields this build does not know, like every store's file: a field a newer build
 * added to its recordings survives this one saving the file. `KnownFields` below takes the index
 * signature that adds back off before the shapes are compared.
 */
export const arrangementDocumentSchema = z.looseObject({
  version: z.literal(2),
  arrangements: z.array(arrangementSchema)
})

/**
 * One arrangement as `arrangements:changed` carries it to the chrome UI (KTD5).
 *
 * The event is its own rather than a field on `tabs:changed`, for the reason `tabgroups:changed`
 * is: the strip needs one summary per tiled view, not a fact per tab, and a field on `TabState`
 * would grow every tab for every consumer. The window sends it in the same round as
 * `tabs:changed`, right after the visible view has been kept, from that round's snapshot.
 *
 * Here rather than in `contract.ts`, which gains the one event line and nothing else — the same
 * split `tabgroups/schema.ts` makes for `tabgroups:changed`. Strict, unlike the file schemas above:
 * this is built by the core from its own document on every round, so a value that does not fit is
 * a bug to hear about at the boundary rather than something to heal.
 */
export const arrangementSummarySchema = z.object({
  id: z.string().min(1),
  layoutId: z.enum(LAYOUT_IDS),
  tabIds: z.array(z.string().min(1)),
  activeTile: z.number().int().nonnegative(),
  activeTabId: z.string().min(1).nullable(),
  visible: z.boolean()
})

/** The whole event: every arrangement of the window, in document order. */
export const arrangementsChangedSchema = z.object({
  arrangements: z.array(arrangementSummarySchema)
})

const ok = z.object({ ok: z.literal(true) })
const byId = z.object({ id: z.string().min(1) })

/**
 * The `arrangements:*` channels a tiled view's entry in the strip is driven through (U6), spread into
 * `invokeContract` the way `tabGroupInvokeContract` is — `contract.ts` is over its line bar and gains
 * the spread alone.
 *
 * Each names the entry by its id, the one thing about a tiled view that survives every change to it
 * (KTD1), and each acts on the *sending* window: an id another window holds is one nothing here may
 * act on (R16). Chrome-only, like every channel that rearranges the panes or closes tabs; see the
 * note in `channels.ts`.
 *
 * Changing the layout and ending the view are not channels: they are reached through the entry's
 * native menu (`arrangements:contextMenu`), whose clicks run in the core (KTD12).
 */
export const arrangementInvokeContract = {
  /** A click on the entry: the view comes back with its last active tile (R4). */
  'arrangements:activate': { request: byId, response: ok },
  /**
   * The entry's ✕: every tab of the view closes, and one whose page asks to stay becomes an ordinary
   * tab (R5, KTD13).
   */
  'arrangements:close': { request: byId, response: ok },
  /** A right-click on the entry: its native menu (R7). An unknown id opens nothing. */
  'arrangements:contextMenu': { request: byId, response: ok },
  /** The entry's speaker: every member muted or loud, on screen or put away (R6, KTD11). */
  'arrangements:setMuted': {
    request: z.object({ id: z.string().min(1), muted: z.boolean() }),
    response: ok
  },
  /**
   * A tile bar's "Release from tiled view": that tile's tab leaves the view on screen as an ordinary tab
   * right behind its entry, and the view closes ranks (U10, R9).
   *
   * The one channel here that names a tab rather than an entry, because the bar sits over a page and
   * knows no entry. It acts on the view on screen only: a tab that is not seated in it is refused.
   *
   * `at` for the same release by dragging the bar's grip into the strip: the place the strip found under
   * the pointer, where the released tab goes instead of behind the entry (U10, KTD14).
   */
  'arrangements:releaseTab': {
    request: z.object({ tabId: z.string().min(1), at: stripSpotSchema.optional() }),
    response: ok
  }
}

/**
 * Keeps the schemas and the interfaces from drifting apart, in both directions at once.
 *
 * `SameShape` rather than a pair of `null as unknown as` assignments: the pair checks one
 * direction per line, so deleting one leaves something that still compiles and still looks
 * like a guarantee. Both directions have actually broken in this codebase — a schema that
 * grew a field the interface lacks arrives as `unknown`, and the reverse quietly drops a
 * column — and an architecture test names the assignment pair the worse form.
 */
const _arrangementWireMatchesModel: SameShape<
  KnownFields<z.output<typeof arrangementSchema>>,
  Arrangement
> = true
const _arrangementDocumentWireMatchesModel: SameShape<
  KnownFields<z.output<typeof arrangementDocumentSchema>>,
  ArrangementDocument
> = true
const _arrangementSummaryWireMatchesModel: SameShape<
  z.output<typeof arrangementSummarySchema>,
  ArrangementSummary
> = true
void _arrangementWireMatchesModel
void _arrangementDocumentWireMatchesModel
void _arrangementSummaryWireMatchesModel
