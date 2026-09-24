import { z } from 'zod'
import type { SameShape } from '../ipc/same-shape.js'
import {
  IMPORT_BROWSERS,
  IMPORT_REFUSALS,
  type BookmarkImportOutcome,
  type HistoryImportOutcome,
  type ImportOffer,
  type ImportSource
} from './model.js'

/**
 * The import's wire shapes (U24), spread into `invokeContract` so that file stays under its bar. The
 * core and the contract read this; the pages read `model.ts`.
 *
 * A request names a profile by the id the core listed and carries nothing else: no path, no file.
 * The core finds the profiles again and reads only a file of one it found.
 */

const count = z.number().int().nonnegative()
const source = z.strictObject({ source: z.string().min(1).max(512) })
const refused = z.strictObject({ outcome: z.literal('refused'), reason: z.enum(IMPORT_REFUSALS) })
const ok = z.strictObject({ ok: z.literal(true) })

const sourceSchema = z.strictObject({
  id: z.string(),
  browser: z.enum(IMPORT_BROWSERS),
  profile: z.string(),
  bookmarks: z.boolean(),
  history: z.boolean()
})

const bookmarkOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('imported'),
    imported: count,
    skipped: count,
    duplicates: count
  }),
  refused
])

const historyOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.enum(['preview', 'imported']),
    counts: z.strictObject({ added: count, merged: count, dropped: count, skipped: count })
  }),
  refused
])

const offerSchema = z.strictObject({ show: z.boolean() })

const _sourceWireMatchesModel: SameShape<z.output<typeof sourceSchema>, ImportSource> = true
const _bookmarkWireMatchesModel: SameShape<
  z.output<typeof bookmarkOutcomeSchema>,
  BookmarkImportOutcome
> = true
const _historyWireMatchesModel: SameShape<
  z.output<typeof historyOutcomeSchema>,
  HistoryImportOutcome
> = true
const _offerWireMatchesModel: SameShape<z.output<typeof offerSchema>, ImportOffer> = true
void _sourceWireMatchesModel
void _bookmarkWireMatchesModel
void _historyWireMatchesModel
void _offerWireMatchesModel

export const importInvokeContract = {
  'import:sources': { request: z.void(), response: z.array(sourceSchema).readonly() },
  'import:bookmarks': { request: source, response: bookmarkOutcomeSchema },
  'import:previewHistory': { request: source, response: historyOutcomeSchema },
  'import:history': { request: source, response: historyOutcomeSchema },
  'import:offer': { request: z.void(), response: offerSchema },
  'import:closeOffer': { request: z.void(), response: ok },
  'import:openSettings': { request: z.void(), response: ok }
}
