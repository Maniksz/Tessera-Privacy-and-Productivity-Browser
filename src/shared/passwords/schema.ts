import { z } from 'zod'
import type { SameShape } from '../ipc/same-shape.js'
import type {
  PasswordCreateResponse,
  PasswordImportResponse,
  PasswordListResponse,
  PasswordMasterPasswordResponse,
  PasswordResetVaultResponse,
  PasswordUnlockResponse,
  PasswordVaultStateResponse
} from './api.js'
import { CSV_REFUSALS, ROW_REFUSALS, type ChromeImportResult } from './chrome-import.js'
import type { PasswordSummary } from './model.js'
import {
  MASTER_PASSWORD_INTENTS,
  MASTER_PASSWORD_REQUEST_OUTCOMES,
  PROMPT_ACTIONS,
  UNLOCK_REQUEST_OUTCOMES
} from './prompt.js'
import type { VaultStatus } from './vault.js'

/**
 * The password boundary, as validation.
 *
 * ## Why the schemas are here and not beside their interfaces
 *
 * The same `model.ts` / `schema.ts` split `quicklinks`, `media`, `reader` and `tabgroups` use, and for the
 * same measured reason: `tessera://passwords` imports `api.ts`, `model.ts`, `vault.ts` and `prompt.ts` at
 * runtime, and a value import of zod from any of them would put roughly 500 kB of validation library into a
 * bundle the user waits for. An architecture test walks the renderer value-import graph to keep that true,
 * which is why this file exists rather than a few `z.object`s next to the types they describe.
 *
 * ## Why they are here and not in `contract.ts`
 *
 * They were there, and they took that file from 1000 lines to 1200 — past the point where the
 * largest-file metric means what it was set to mean. Every other feature of this size keeps its wire
 * shapes in its own directory; passwords had not, only because they landed with the contract entries.
 *
 * ## What is worth reading this file *for*
 *
 * What it does not contain. A request schema is where a field has to appear to be accepted across this
 * boundary, so the absence of any `masterPassword`, `current` or `next` below is the enforcement of the
 * decision `api.ts` describes: the candidate is typed into a prompt on the overlay layer and read in the
 * main process, and no channel can carry one because no channel has a shape that would admit one.
 *
 * The two-way `SameShape` assertions are the other half. Each turns a divergence between one of these
 * schemas and the interface the page renders into a compile error, in both directions.
 */

/** Never carries a password. `PasswordSummary` exists so the compiler can say so. */
export const passwordSummarySchema = z.object({
  id: z.string(),
  origin: z.string(),
  username: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().nullable()
})

const _passwordSummaryWireMatchesModel: SameShape<
  z.output<typeof passwordSummarySchema>,
  PasswordSummary
> = true
void _passwordSummaryWireMatchesModel

/**
 * What a save attempt made of it.
 *
 * Five values, not the model's four: `locked` is the vault closing while somebody was typing, and it
 * is separate from `rejected` because the two need different sentences and different next actions.
 * Asserted against the API interface rather than against `SaveOutcome`, which is the *store*
 * vocabulary and knows nothing about a lock.
 */
export const PASSWORD_SAVE_OUTCOMES = [
  'created',
  'updated',
  'unchanged',
  'rejected',
  'locked'
] as const
const _saveOutcomeMatchesApi: SameShape<
  (typeof PASSWORD_SAVE_OUTCOMES)[number],
  PasswordCreateResponse['outcome']
> = true
void _saveOutcomeMatchesApi

/**
 * What the core tells the page about the lock.
 *
 * Carries no count of entries and no origins on purpose: it is answered while the vault may be
 * *closed*, and a status reply saying "you have 43 saved passwords" would hand a locked vault's
 * contents to anything that could ask. See `VaultStatus`.
 */
export const vaultStatusSchema = z.object({
  protection: z.enum(['keystore+master', 'master', 'keystore', 'plain']),
  unlocked: z.boolean(),
  /** The key file exists and cannot be opened at all — no master password will help. */
  unreadable: z.boolean(),
  /** Shown to the user, so a vault that locks itself is not read as a fault. */
  idleTimeoutMs: z.number()
})

const _vaultStatusWireMatchesModel: SameShape<z.output<typeof vaultStatusSchema>, VaultStatus> = true
void _vaultStatusWireMatchesModel

export const passwordListResponseSchema = z.object({
  /** Empty while the vault is locked, and not because it was filtered: there is nothing to read. */
  credentials: z.array(passwordSummarySchema),
  neverSaved: z.array(z.string()),
  /**
   * How the vault is actually protected on this machine, and whether it is open.
   *
   * On the wire because it is the one fact a user cannot discover for themselves and the one that
   * changes what these entries are worth. See `PasswordListResponse`.
   */
  vault: vaultStatusSchema
})

const _passwordListWireMatchesApi: SameShape<
  z.output<typeof passwordListResponseSchema>,
  PasswordListResponse
> = true
void _passwordListWireMatchesApi

export const vaultStateResponseSchema = z.object({ vault: vaultStatusSchema })

const _vaultStateWireMatchesApi: SameShape<
  z.output<typeof vaultStateResponseSchema>,
  PasswordVaultStateResponse
> = true
void _vaultStateWireMatchesApi

/**
 * What became of a request to unlock.
 *
 * Four words, and the reply is deliberately identical whether the vault holds one credential or five
 * hundred: `vaultStatusSchema` carries no count and no origin, so this channel cannot be used to
 * discover what is in a locked vault, or whether anything is.
 */
export const passwordUnlockResponseSchema = z.object({
  outcome: z.enum(UNLOCK_REQUEST_OUTCOMES),
  vault: vaultStatusSchema
})

const _passwordUnlockWireMatchesApi: SameShape<
  z.output<typeof passwordUnlockResponseSchema>,
  PasswordUnlockResponse
> = true
void _passwordUnlockWireMatchesApi

/** The intent, and nothing that could name the questions. See `PasswordMasterPasswordRequest`. */
export const passwordMasterPasswordRequestSchema = z.object({
  intent: z.enum(MASTER_PASSWORD_INTENTS)
})

export const passwordMasterPasswordResponseSchema = z.object({
  outcome: z.enum(MASTER_PASSWORD_REQUEST_OUTCOMES),
  vault: vaultStatusSchema
})

const _passwordMasterPasswordWireMatchesApi: SameShape<
  z.output<typeof passwordMasterPasswordResponseSchema>,
  PasswordMasterPasswordResponse
> = true
void _passwordMasterPasswordWireMatchesApi

export const passwordResetVaultResponseSchema = z.object({
  reset: z.boolean(),
  /**
   * What became of the offer to keep the sealed vault.
   *
   * `failed` implies `reset: false`: a copy that could not be written aborts the deletion, because
   * discarding a vault right after failing to save it is the one outcome the offer exists to prevent.
   */
  copy: z.enum(['none', 'saved', 'declined', 'failed']),
  vault: vaultStatusSchema
})

const _passwordResetWireMatchesApi: SameShape<
  z.output<typeof passwordResetVaultResponseSchema>,
  PasswordResetVaultResponse
> = true
void _passwordResetWireMatchesApi

/**
 * An import report: counts, and origins the user can already see in their own file.
 *
 * Never a password, and the two bounds that keep it that way are in the model rather than here —
 * `MAX_REPORTED_CONFLICTS` caps the named collisions so a file engineered to collide with everything
 * cannot turn this reply into a copy of the vault index, and `skipped` is counts per reason rather than a
 * list of rows, which would have been a map of the file.
 *
 * The refusal enums are enumerated rather than left as strings on purpose: a value the page has no
 * sentence for renders as a blank where the explanation belonged, and this is a screen somebody reads
 * once, after moving every credential they own.
 */
export const chromeImportResultSchema = z.object({
  imported: z.number().int().nonnegative(),
  duplicatesIdentical: z.number().int().nonnegative(),
  duplicatesConflicting: z.number().int().nonnegative(),
  conflicts: z.array(z.object({ origin: z.string(), username: z.string() })),
  /*
    Built from `ROW_REFUSALS` rather than written out, and this is the one place in the file where that is
    the right way round: the counts are a total record over that union, so a refusal added there without an
    entry here would otherwise be a number the page silently never receives. The cast names the shape
    `fromEntries` cannot infer; the `SameShape` assertion below is what checks it.
  */
  skipped: z.object(
    Object.fromEntries(
      ROW_REFUSALS.map((refusal) => [refusal, z.number().int().nonnegative()])
    ) as Record<(typeof ROW_REFUSALS)[number], z.ZodNumber>
  ),
  full: z.number().int().nonnegative(),
  refusedByVault: z.number().int().nonnegative(),
  notesDropped: z.number().int().nonnegative(),
  refusal: z.enum(CSV_REFUSALS).nullable()
})

const _importResultWireMatchesModel: SameShape<
  z.output<typeof chromeImportResultSchema>,
  ChromeImportResult
> = true
void _importResultWireMatchesModel

export const passwordImportResponseSchema = z.object({
  outcome: z.enum(['imported', 'cancelled', 'locked', 'unreadable']),
  report: chromeImportResultSchema.optional(),
  /**
   * The file that was read, so the page can tell the user to delete it.
   *
   * The largest exposure an import creates is not in the vault: it is the plain-text CSV of every
   * password the user has, sitting in their downloads folder. This browser will not delete somebody
   * else's file behind their back, so it names it instead. See `PasswordImportResponse`.
   */
  filePath: z.string().optional(),
  vault: vaultStatusSchema
})

const _importResponseWireMatchesApi: SameShape<
  z.output<typeof passwordImportResponseSchema>,
  PasswordImportResponse
> = true
void _importResponseWireMatchesApi

/** Continue or Cancel, echoing the request the surface was shown for. Carries no candidate. */
export const passwordPromptAnswerSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(PROMPT_ACTIONS)
})
