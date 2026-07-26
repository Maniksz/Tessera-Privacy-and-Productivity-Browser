import { z } from 'zod'

/**
 * What the blocker made of the user's lists, on the wire.
 *
 * Its own file for the reason the rest of this directory is zod-free: a settings page imports the
 * *type* to render these numbers, and a value import of the validation library in that bundle is
 * about half a megabyte of parse work on every window open. The architecture test follows value
 * imports from `src/renderer` and forbids zod anywhere it reaches, so this schema may only ever be
 * imported by the contract and the core.
 *
 * ## Why this is a channel at all
 *
 * A hand-written filter engine implements a subset of the Adblock Plus syntax, and the honest thing to
 * do about that is to count what it declined rather than to hope nobody notices. Without these
 * numbers, "the blocker does not work on this site" is not a diagnosis: it could be a list that failed
 * to download, a list the user switched off, a rule using syntax this build does not implement, or a
 * site that genuinely has no adverts. With them, each of those looks different.
 */

const diagnosticsSchema = z.object({
  lines: z.number().int().nonnegative(),
  blank: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  network: z.number().int().nonnegative(),
  cosmetic: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  /** Reason -> line count. Keys are stable strings a settings page can list. */
  unsupportedByReason: z.record(z.string(), z.number().int().nonnegative())
})

const refreshOutcomeSchema = z.object({
  url: z.string(),
  /** `fresh` means the cached copy was young enough to keep — not a failure. */
  status: z.enum(['fetched', 'fresh', 'failed']),
  reason: z.string().nullable()
})

export const filterStatusSchema = z.object({
  /** Lists the user configured, whether or not a copy exists. */
  configured: z.number().int().nonnegative(),
  /** Lists a copy of which is actually compiled in. The gap between the two is the interesting part. */
  loaded: z.number().int().nonnegative(),
  networkRules: z.number().int().nonnegative(),
  cosmeticRules: z.number().int().nonnegative(),
  userRules: z.number().int().nonnegative(),
  diagnostics: diagnosticsSchema,
  /** Per-list outcome of the last refresh, or `null` before one has run. */
  lastRefresh: z.array(refreshOutcomeSchema).nullable()
})

/**
 * The status as one type, derived from the schema rather than declared beside it.
 *
 * Every other document shape here keeps a hand-written interface next to its schema and a pair of
 * assignments to catch drift between them. That is worth it where the interface is imported at runtime
 * by a renderer and the schema must therefore live apart. Here it is not: nothing needs the shape
 * without also being allowed to see this file, so deriving it removes the drift instead of detecting
 * it.
 */
export type FilterStatus = z.output<typeof filterStatusSchema>
