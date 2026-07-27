import type { ChromeImportResult } from './chrome-import.js'
import type { PasswordSummary } from './model.js'
import type {
  MasterPasswordIntent,
  MasterPasswordRequestOutcome,
  UnlockRequestOutcome
} from './prompt.js'
import type { VaultStatus } from './vault.js'

/**
 * What `tessera://passwords` may ask the core for, and what it gets back.
 *
 * ## Why these shapes are named here rather than only in the contract
 *
 * `shared/ipc/contract.ts` is the single source of truth for the boundary and holds the zod schema
 * for every channel below. This file holds the *interfaces* those schemas produce, for two reasons.
 * The page needs them and cannot see the core. And the schemas land in `contract.ts` in a separate,
 * coordinated edit to a file this change does not own — so until they do, this is where the page and
 * the core agree, and `PasswordApi`'s return types are checked against it on the core side. When the
 * contract entries are in place the interfaces below become the assertion target for the same
 * two-way `SchemaX`/`ModelX` assignment `HistoryStore` uses, and drift becomes a compile error.
 *
 * ## The one shape that is not here
 *
 * There is no response anywhere in this file that carries more than one password. `passwords:list`
 * answers with summaries; `passwords:reveal` answers with exactly one secret, for exactly one id,
 * because the user asked for that one. An "export everything" call is deliberately absent, and its
 * absence is a feature: the bound on what an open passwords tab is holding is only real if there is
 * no call that can fill it up in one go. See `reveal.ts` for the whole argument.
 *
 * The import is the mirror image and is arranged so that it stays true. `passwords:import` takes **no
 * payload**: the core opens a native file chooser, reads the file itself, and answers with counts. A
 * page-side `<input type="file">` would have been less code and would have put an entire exported
 * vault — every password the user has ever had, in clear text — into a single IPC message and into a
 * renderer's heap. The rule is that no payload carries a password it does not need, and this one does
 * not need any.
 *
 * ## Not one request here carries a password, and that is a structural claim
 *
 * There is no field of type `masterPassword` anywhere in this file, and there is no channel that has
 * one. This *was* the obvious design — `passwords:unlock { masterPassword }` and
 * `passwords:setMasterPassword { current, next }` — and the two of them were written down here with an
 * argument for why crossing was unavoidable. It is not unavoidable.
 *
 * What replaced them: `passwords:requestUnlock` takes **no payload** and answers one of four words. The
 * core raises a prompt on the overlay layer, reads the keystrokes off that view's own input pipeline in
 * the main process, checks the candidate itself, and reports the outcome. See
 * `main/passwords/MasterPasswordPrompt.ts` for how, and `shared/passwords/prompt.ts` for what it costs.
 *
 * Why the change is worth its cost: a payload can only be defended by promises about everyone who can
 * see it — the preload, the renderer, the router's logs, whatever a future `console.warn` decides is
 * useful context. An absent payload needs no promises. And the audience for those promises includes a
 * page that *looks* like `tessera://passwords`: the address bar is the only thing that distinguishes
 * them, as for every internal page in every browser, so a design where that page could ask for the
 * master password at all was one where the lookalike could too. Now neither can — the field is browser
 * chrome, drawn on a layer a page cannot reach, and it holds no value even there.
 */

export interface PasswordListResponse {
  /**
   * Never carries a password. `PasswordSummary` exists so the compiler can say so.
   *
   * **Empty while the vault is locked**, and not because it is filtered: there is no store to read
   * from, because the document is a sealed file and the key is not in the process. The page renders
   * `vault` in that case and does not draw a list at all.
   */
  credentials: PasswordSummary[]
  /** Origins where the user answered "never here", so the choice can be undone. Empty while locked. */
  neverSaved: string[]
  /**
   * How the vault is actually protected on this machine, and whether it is open.
   *
   * On the page rather than only in a log, because it is the one fact a user cannot discover for
   * themselves and the one that changes what these entries are worth. `protection: 'keystore'` — the
   * default on a fresh profile — means anyone already logged in as this user can read the vault, and a
   * password manager that did not say so on its own front page would be misrepresenting itself.
   * `'plain'` means there was no key store to wrap a key with either. See `vault.ts`.
   */
  vault: VaultStatus
}

export interface PasswordRevealRequest {
  id: string
}

export interface PasswordRevealResponse {
  /** `null` when the entry has gone between the list being drawn and the click. */
  password: string | null
}

export interface PasswordCreateRequest {
  /** Any address; the core reduces it to an origin, so a pasted deep link works. */
  url: string
  username: string
  password: string
}

export interface PasswordCreateResponse {
  /**
   * What happened, in the vocabulary the model uses.
   *
   * `rejected` reaches the page as a value rather than as a thrown error on purpose: the causes are
   * all things the user typed — an address with no host, an empty password — and an error message
   * built from a rejected promise would be a sentence about a password field.
   *
   * `locked` is separate from `rejected` because the two need different sentences and different next
   * actions: one is "fix what you typed", the other is "the vault closed while you were typing, and
   * what you typed is still in the form". A single value would have made the second look like the
   * first, and the user would have edited a perfectly good entry looking for the mistake.
   */
  outcome: 'created' | 'updated' | 'unchanged' | 'rejected' | 'locked'
}

export interface PasswordUpdateRequest {
  id: string
  username?: string
  password?: string
}

export interface PasswordRemoveRequest {
  id: string
}

export interface PasswordRemoveResponse {
  removed: boolean
}

export interface PasswordForgetNeverSavedRequest {
  origin: string
}

/**
 * `{ ok: true }`, matching the shape every other write on this boundary answers with.
 *
 * `ok` acknowledges that the request was accepted and dispatched; it is not a claim that a row
 * changed. A write to a *locked* vault changes nothing and still answers `ok`, and the page learns the
 * truth the way it learns everything else — it refreshes after every write, and a locked vault answers
 * that refresh with the lock panel. Adding a third value here would have put a "did it work?" branch on
 * a path where the honest answer is always visible one call later.
 */
export interface PasswordOkResponse {
  ok: true
}

// --- the lock ----------------------------------------------------------------

export interface PasswordVaultStateResponse {
  vault: VaultStatus
}

/**
 * What a request to unlock came to.
 *
 * **No request shape at all**, deliberately: `passwords:requestUnlock` takes no payload, because there
 * is nothing a caller could usefully say. It asks the core to put the prompt up; the core asks the
 * person. The promise settles when they answer, cancel, or the prompt leaves the screen — which can be
 * a while, and that is the correct representation of "somebody is being asked something".
 */
export interface PasswordUnlockResponse {
  outcome: UnlockRequestOutcome
  /** The state afterwards, so a successful unlock needs no second round trip to redraw. */
  vault: VaultStatus
}

/**
 * Which master-password operation the user chose.
 *
 * The *intent*, not the sequence: the core derives which questions to ask from the vault's actual state,
 * and always in the direction that demands more proof — asking to "set" one on a vault that already has
 * one asks for the existing one first. A payload that named the questions would be a payload that could
 * skip one.
 */
export interface PasswordMasterPasswordRequest {
  intent: MasterPasswordIntent
}

export interface PasswordMasterPasswordResponse {
  outcome: MasterPasswordRequestOutcome
  vault: VaultStatus
}

/**
 * Destroying the vault, for a user who has forgotten the master password.
 *
 * The token is `RESET_VAULT_CONFIRMATION` and is not user-visible text: it is here so that an empty or
 * mistaken invoke on this channel cannot delete anything. The sentence the user reads, and the
 * confirmation they give, are translated and on the page.
 */
export interface PasswordResetVaultRequest {
  confirmation: string
}

/**
 * What became of the offer to keep a copy of the sealed vault.
 *
 * A field of its own rather than folded into `reset`, because the two answer different questions and the
 * page has to say both: whether the vault is gone, and whether anything was kept. `failed` is the one
 * that changes the outcome — a copy that could not be written **aborts the reset**, because discarding
 * the vault after failing to save it is the one result nobody asked for.
 */
export type VaultCopyOutcome =
  /** Never offered: the confirmation token was wrong, so nothing happened at all. */
  | 'none'
  | 'saved'
  /** Offered and turned down. The user chose to discard without keeping anything. */
  | 'declined'
  | 'failed'

export interface PasswordResetVaultResponse {
  reset: boolean
  copy: VaultCopyOutcome
  vault: VaultStatus
}

// --- importing ---------------------------------------------------------------

export interface PasswordImportResponse {
  /**
   * `cancelled` when the user closed the file chooser, which is not a failure and must not be reported
   * as one; `locked` when the vault was closed and nothing could be written; `unreadable` when the
   * file could not be read from disk at all, which is different from a file whose *contents* were
   * refused — that arrives as `imported` with a `report.refusal`.
   */
  outcome: 'imported' | 'cancelled' | 'locked' | 'unreadable'
  /**
   * Present only for `imported`. Counts and origins; never a password.
   *
   * `| undefined` written out, which under `exactOptionalPropertyTypes` is not the same type as a bare
   * `?`. It is the honest one for a value that crossed IPC: an absent property and one holding
   * `undefined` arrive indistinguishable, so declaring only the first would be a claim the wire cannot
   * keep — and the two-way assertion in `schema.ts` fails if it is made.
   */
  report?: ChromeImportResult | undefined
  /**
   * The file that was read, so the page can tell the user to delete it.
   *
   * The largest exposure this feature creates is not in the vault: it is the plain-text CSV of every
   * password the user has, now sitting in their downloads folder. This browser will not delete
   * somebody's file behind their back, so the honest alternative is to name it and say so. A path is
   * not a secret from a page that is already allowed to list the user's accounts, and the full path
   * rather than the file name because "delete this" is only actionable if it says where.
   */
  filePath?: string | undefined
  vault: VaultStatus
}

/**
 * The channels, and the payload each carries in both directions.
 *
 * A map rather than six pairs of loose types, so the page's own call helper can be generic over it
 * and a mismatched payload is a compile error on the page rather than a rejected invoke at runtime.
 */
export interface PasswordCalls {
  'passwords:list': { request: void; response: PasswordListResponse }
  'passwords:reveal': { request: PasswordRevealRequest; response: PasswordRevealResponse }
  'passwords:create': { request: PasswordCreateRequest; response: PasswordCreateResponse }
  'passwords:update': { request: PasswordUpdateRequest; response: PasswordOkResponse }
  'passwords:remove': { request: PasswordRemoveRequest; response: PasswordRemoveResponse }
  'passwords:forgetNeverSaved': {
    request: PasswordForgetNeverSavedRequest
    response: PasswordOkResponse
  }
  /** The lock's state on its own, for a page that has to redraw it without re-reading the list. */
  'passwords:vaultStatus': { request: void; response: PasswordVaultStateResponse }
  /** No payload: there is nothing to send, and that is the point. See above. */
  'passwords:requestUnlock': { request: void; response: PasswordUnlockResponse }
  'passwords:lock': { request: void; response: PasswordVaultStateResponse }
  'passwords:beginSetMasterPassword': {
    request: PasswordMasterPasswordRequest
    response: PasswordMasterPasswordResponse
  }
  /** No request payload, deliberately. See the note on the import at the top of this file. */
  'passwords:import': { request: void; response: PasswordImportResponse }
  'passwords:resetVault': {
    request: PasswordResetVaultRequest
    response: PasswordResetVaultResponse
  }
}

export type PasswordChannel = keyof PasswordCalls

/**
 * Every channel the passwords page needs, as an array.
 *
 * The value the `INTERNAL_PAGE_INVOKE_CHANNELS` entry is built from, and what a test can iterate.
 * `satisfies` ties it to the map above, so a channel added to one and not the other fails the build.
 */
export const PASSWORD_CHANNELS = [
  'passwords:list',
  'passwords:reveal',
  'passwords:create',
  'passwords:update',
  'passwords:remove',
  'passwords:forgetNeverSaved',
  'passwords:vaultStatus',
  'passwords:requestUnlock',
  'passwords:lock',
  'passwords:beginSetMasterPassword',
  'passwords:import',
  'passwords:resetVault'
] as const satisfies readonly PasswordChannel[]
