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
import { AUTOFILL_KEY_VAULTS, type AutofillKeyState, type PasswordSummary } from './model.js'
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
  protection: z.enum([
    'keystore+master',
    'weak-keystore+master',
    'master',
    'keystore',
    'weak-keystore',
    'plain'
  ]),
  unlocked: z.boolean(),
  /** The key file exists and cannot be opened at all — no master password will help. */
  unreadable: z.boolean(),
  /** Shown to the user, so a vault that locks itself is not read as a fault. */
  idleTimeoutMs: z.number(),
  /**
   * The following four only on an unlocked vault whose document did not load cleanly — and `newer`
   * also on a locked one whose key file a newer version wrote.
   */
  newer: z.literal(true).exactOptional(),
  invalid: z.literal(true).exactOptional(),
  readOnly: z.literal(true).exactOptional(),
  unreadableEntries: z.number().int().positive().exactOptional()
})

const _vaultStatusWireMatchesModel: SameShape<
  z.output<typeof vaultStatusSchema>,
  VaultStatus
> = true
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

/**
 * The account picker's answer: which entry, or "unlock first".
 *
 * Two opaque ids and a verb, and the absence of a username is the property worth naming — the
 * surface exists to keep account names out of the page, and an answer carrying one would put one
 * back on the wire for no purpose, since the core resolves the entry from the id it minted.
 *
 * A discriminated union rather than an optional `entryId`, so an unlock that arrived carrying an
 * entry id is a parse failure rather than a choice nobody made.
 *
 * The request id is checked against the picker actually on screen, exactly as the master-password
 * prompt's is — and here it is stronger, because that id *is* the consent that authorises the fill
 * (`shared/passwords/consent.ts`). A stale one authorises nothing at all.
 */
export const passwordSuggestAnswerSchema = z.discriminatedUnion('action', [
  z.object({
    requestId: z.string().min(1),
    action: z.literal('choose'),
    entryId: z.string().min(1)
  }),
  z.object({ requestId: z.string().min(1), action: z.literal('unlock') })
])

const nothing = z.void()
const ok = z.object({ ok: z.literal(true) })
/** A rectangle in window coordinates, as the chrome renderer measures its own buttons. */
const anchorRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

/**
 * What the toolbar key shows: a state and a count, never a name. See `AutofillKeyState`.
 *
 * Strict, so a field added in the core that named an account would be refused here rather than
 * quietly reaching every window's chrome on the next lock.
 */
export const autofillKeyStateSchema = z.strictObject({
  vault: z.enum(AUTOFILL_KEY_VAULTS),
  matches: z.number().int().min(0)
})

const _autofillKeyWireMatchesModel: SameShape<
  z.output<typeof autofillKeyStateSchema>,
  AutofillKeyState
> = true
void _autofillKeyWireMatchesModel

/**
 * The vault's channels, spread into `invokeContract` (`shared/ipc/contract.ts`).
 *
 * Here rather than there so the contract file stays under the largest-file bar, and so each channel
 * sits beside the schemas it is made of. Nothing about their checking changes: the exhaustiveness
 * assertion over `InvokeChannel` is on the object they are spread into.
 */
export const passwordInvokeContract = {
  /** Origins, usernames and timestamps. No password reaches the page through this channel. */
  'passwords:list': { request: nothing, response: passwordListResponseSchema },
  /**
   * Adds an entry the user typed.
   *
   * `rejected` is a value rather than a rejection on purpose: the causes are all things the user
   * typed — an address with no host, an empty password — and an error built from a rejected promise
   * would be a sentence about a password field.
   */
  'passwords:create': {
    request: z.object({ url: z.string(), username: z.string(), password: z.string() }),
    response: z.object({ outcome: z.enum(PASSWORD_SAVE_OUTCOMES) })
  },
  /** An absent field means "leave this alone"; it cannot move an entry to another origin. */
  'passwords:update': {
    request: z.object({
      id: z.string(),
      username: z.string().optional(),
      password: z.string().optional()
    }),
    response: ok
  },
  'passwords:remove': {
    request: z.object({ id: z.string() }),
    response: z.object({ removed: z.boolean() })
  },
  /**
   * One password, for one id.
   *
   * The only response on this whole boundary that carries a secret, and it carries exactly one.
   * `null` for an unknown id rather than a rejection: the id came from a list the page was already
   * holding, and an entry can be removed in another window between the row being drawn and the
   * button being pressed. That is a race, not a fault.
   */
  'passwords:reveal': {
    request: z.object({ id: z.string() }),
    response: z.object({ password: z.string().nullable() })
  },
  /** Undoes a "never here", so a site the user changed their mind about can be offered again. */
  'passwords:forgetNeverSaved': { request: z.object({ origin: z.string() }), response: ok },

  // --- the lock -------------------------------------------------------------
  /*
    Six channels for the lock, the master password, the reset and the import — and not one of them has a
    request field that carries a secret.

    That is the whole shape of this group and it is worth stating where the schemas are, because a
    schema is where such a field would have to appear to be accepted. `passwords:requestUnlock` and
    `passwords:beginSetMasterPassword` send nothing and an intent respectively; the candidate is typed
    into a prompt on the overlay layer whose keystrokes the core takes out of the input pipeline before
    any renderer sees them. See `shared/passwords/api.ts` for what this replaced.
  */
  'passwords:vaultStatus': { request: nothing, response: vaultStateResponseSchema },
  /**
   * Raises the prompt and resolves with one of four words.
   *
   * Pending for as long as somebody is being asked, which is minutes if they walk away — the same
   * representation `media:download` uses for a long operation, and the correct one for a question put to a
   * person. Every way the prompt can leave the screen settles it, `cancelled` being the safe reading.
   */
  'passwords:requestUnlock': { request: nothing, response: passwordUnlockResponseSchema },
  'passwords:lock': { request: nothing, response: vaultStateResponseSchema },
  /**
   * Starts the set, change or remove sequence.
   *
   * The intent, not the sequence. The core derives which questions to ask from the vault as it actually
   * is, and always towards more proof: `set` on a vault that already has a master password asks for the
   * existing one first, because a caller able to choose otherwise would have found the one way to
   * replace the lock without opening it.
   */
  'passwords:beginSetMasterPassword': {
    request: passwordMasterPasswordRequestSchema,
    response: passwordMasterPasswordResponseSchema
  },
  /**
   * Destroys the vault, after offering to put the sealed copy somewhere the user chooses.
   *
   * The token is checked in the core and is not user-visible text; it is here so that an empty or
   * mistaken invoke cannot delete anything. The sentence the user reads is translated and on the page.
   */
  'passwords:resetVault': {
    request: z.object({ confirmation: z.string() }),
    response: passwordResetVaultResponseSchema
  },
  /** No payload: the core opens the chooser and reads the file, so no export crosses this boundary. */
  'passwords:import': { request: nothing, response: passwordImportResponseSchema },
  /**
   * Continue or Cancel on the prompt. Chrome-only.
   *
   * The mouse route, and the only thing this channel can do is spend or abandon what the person at the
   * keyboard has already typed — there is nothing in the payload that could substitute for it.
   */
  'passwords:answerPrompt': {
    request: passwordPromptAnswerSchema,
    response: ok
  },
  /**
   * The account picker's answer: an entry chosen, or Unlock pressed. Chrome-only.
   *
   * Nothing comes back but `ok`, and that is the shape rather than a simplification: the credential
   * does not travel this way. The core answers a choice by handing the *page* a one-time token, which
   * the page redeems on autofill's own channel with the form as it is at that moment — so the surface
   * that made the choice never holds anything, and the rules are applied again against a document
   * this reply could not have influenced.
   */
  'passwords:answerSuggestion': {
    request: passwordSuggestAnswerSchema,
    response: ok
  },
  /**
   * Opens `tessera://passwords` in the sending window.
   *
   * `nothing` in, and that is the whole security argument rather than a simplification: with no
   * address in the request there is no address to forge, so the channel's reach is a constant in the
   * handler. `ok` out, because a tab is not state this caller tracks — the settings page has no list
   * of tabs and would have nothing to do with an id.
   */
  'passwords:openManager': { request: nothing, response: ok },

  // --- the toolbar key (R10–R13) -------------------------------------------
  /** The key's state for the sending window's active tile, the pull that goes with the push. */
  'passwords:autofillState': { request: nothing, response: autofillKeyStateSchema },
  /**
   * The key was pressed with the vault open: fill the active tile's page from browser chrome.
   *
   * Chrome-only, and the anchor is the whole request: which page is the core's to read from the
   * sender's window, and the press itself is the consent (R11), so there is nothing a caller could
   * name that would widen it. `ok` out, because the answer is a surface on the overlay layer.
   */
  'passwords:fillFromToolbar': { request: z.object({ anchor: anchorRectSchema }), response: ok }
}
