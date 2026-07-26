import { z } from 'zod'
import { USER_RULE_ORIGINS } from './user-rules.js'
import type { UserRule } from './user-rules.js'

/**
 * A rule the user wrote themselves, on the wire.
 *
 * Its own file for the reason the rest of this directory is zod-free: the settings page and the blocker
 * menu import the *type* to render these, and a value import of the validation library in a renderer bundle
 * is parse work on every window open. The architecture test follows value imports from `src/renderer` and
 * forbids zod anywhere they reach.
 *
 * Strict, unlike the storage schema in `main/data/UserRuleStore.ts`. That one reads a file that may have
 * been written by an older build and heals what it can, because a rule the user made by hand cannot be
 * downloaded again. This one reads a message the core just produced from its own types, where a mismatch
 * means the two halves disagree — something to surface rather than to repair.
 */
export const userRuleSchema = z.object({
  id: z.string().min(1),
  /** The filter line, verbatim: `example.com##.ad-slot`. */
  text: z.string().min(1),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  origin: z.enum(USER_RULE_ORIGINS)
})

// Keeps the schema and the interface from drifting apart in either direction.
type SchemaRule = z.output<typeof userRuleSchema>
const _schemaMatchesModel: SchemaRule = null as unknown as UserRule
const _modelMatchesSchema: UserRule = null as unknown as SchemaRule
void _schemaMatchesModel
void _modelMatchesSchema
