import type {
  PasswordCreateRequest,
  PasswordCreateResponse,
  PasswordForgetNeverSavedRequest,
  PasswordImportResponse,
  PasswordListResponse,
  PasswordMasterPasswordRequest,
  PasswordMasterPasswordResponse,
  PasswordOkResponse,
  PasswordRemoveRequest,
  PasswordRemoveResponse,
  PasswordResetVaultRequest,
  PasswordResetVaultResponse,
  PasswordRevealRequest,
  PasswordRevealResponse,
  PasswordUnlockRequest,
  PasswordUnlockResponse,
  PasswordUpdateRequest,
  PasswordVaultStateResponse
} from '@shared/passwords/api.js'
import type { ChromeImportResult } from '@shared/passwords/chrome-import.js'
import type { PasswordSummary } from '@shared/passwords/model.js'
import type {
  MasterPasswordOutcome,
  UnlockOutcome,
  VaultStatus
} from '@shared/passwords/vault.js'

/**
 * What `tessera://passwords` is allowed to do.
 *
 * ## Why it is a class here rather than handler bodies in `ipc/handlers.ts`
 *
 * Because these are the operations that touch a password vault, and every one of them should be
 * something a test can call. The IPC layer's job is to resolve the sender and delegate — handlers stay
 * thin, as that file says — so the delegation is one line each and the substance is here, where it is
 * measured.
 *
 * ## Which of these may return a secret
 *
 * One: `reveal`. Everything else answers with summaries, counts, a status or `{ ok: true }`. That is
 * the whole of the bound described in `shared/passwords/reveal.ts` — a passwords tab left open holds a
 * list of sites and usernames plus, at most, the one password the user asked to see. It only holds if
 * there is no second call that can fetch them in bulk, so there is not one, and there is deliberately
 * no export.
 *
 * ## What `reveal` can now do, and what it still cannot
 *
 * It can require the vault to be open, which is a real gate rather than the theatre this file used to
 * have to admit to: with a master password set, `secretOf` answers `null` until somebody has proved
 * knowledge of it, because until then the vault key is not in this process at all. That is the
 * re-authentication `safeStorage` could not provide, and it is provided by knowing something rather
 * than by asking the operating system to vouch for a session it will always vouch for.
 *
 * What it still cannot do is re-authenticate *per reveal*. Once the vault is open, every reveal
 * succeeds until it locks. Asking for the master password on each one would be the honest maximum and
 * would also be unusable, so the lifetime of the unlock is the bound instead: an idle timeout, an
 * explicit lock, and the last window closing. `reveal.ts`'s thirty-second on-screen limit still applies
 * on top of that, and the two are independent.
 *
 * ## Why the import takes no payload
 *
 * The core opens the file chooser and reads the file. A page-side file input would have put an entire
 * exported vault into one IPC message; see `shared/passwords/api.ts`. `chooseImportFile` is injected so
 * this class stays free of Electron and the whole import is testable without a dialog.
 */

/**
 * The slice of the vault this class touches.
 *
 * Written out rather than importing `PasswordVault`, for the reason `AutofillVault` and
 * `SafeStorageLike` exist: a test supplies a fake and the real code path runs. It also documents the
 * surface — and what is absent from it is the point, as everywhere else here. There is no method that
 * returns the collection *with* passwords, and no method that exports.
 */
export interface PasswordApiVault {
  status(): VaultStatus
  list(): PasswordSummary[]
  neverSavedOrigins(): string[]
  secretOf(id: string): string | null
  create(input: { url: string; username: string; password: string }): PasswordCreateResponse['outcome']
  update(id: string, patch: { username?: string; password?: string }): void
  remove(id: string): boolean
  forgetNeverSaved(url: string): void
  unlock(masterPassword: string): Promise<UnlockOutcome>
  lock(): Promise<void>
  setMasterPassword(request: {
    current: string | null
    next: string | null
  }): Promise<MasterPasswordOutcome>
  resetVault(confirmation: string): Promise<boolean>
  /** `null` while locked, so the caller can report that rather than an empty import. */
  importChromeCsv(text: string): ChromeImportResult | null
}

/** A file the user picked, and its contents. Produced by the core's own dialog, never by a page. */
export interface ImportSource {
  readonly path: string
  readonly text: string
}

export interface PasswordApiOptions {
  readonly vault: PasswordApiVault
  /**
   * Opens a native file chooser and reads what was picked, or answers `null` when it was cancelled.
   *
   * Injected rather than called here, so this class needs no Electron and the import's rules are
   * exercised without one. It may reject — an unreadable file, a device that went away — and `import`
   * turns that into an outcome rather than letting it out, because a rejected promise on this boundary
   * becomes an English sentence on a translated page.
   */
  readonly chooseImportFile: () => Promise<ImportSource | null>
}

export class PasswordApi {
  readonly #vault: PasswordApiVault
  readonly #chooseImportFile: () => Promise<ImportSource | null>

  constructor(options: PasswordApiOptions) {
    this.#vault = options.vault
    this.#chooseImportFile = options.chooseImportFile
  }

  /**
   * The list, and the lock's state.
   *
   * Answered while locked as well, with both collections empty — that is what a closed vault has, not
   * a filtered view of what it holds. The page draws `vault` in that case. Returning the status from
   * the same call that returns the list means the two cannot be out of step, which they would be with a
   * separate `passwords:status` and one extra round trip between them.
   */
  list(): PasswordListResponse {
    return {
      credentials: this.#vault.list(),
      neverSaved: this.#vault.neverSavedOrigins(),
      vault: this.#vault.status()
    }
  }

  /**
   * One password, for one id.
   *
   * `null` for an unknown id rather than a rejection: the id came from a list the page was already
   * holding, and an entry can be removed in another window between the row being drawn and the button
   * being pressed. `null` is also the answer for a locked vault, and the two are deliberately the same
   * shape — the page has the status and does not need this call to explain itself.
   */
  reveal(request: PasswordRevealRequest): PasswordRevealResponse {
    return { password: this.#vault.secretOf(request.id) }
  }

  /**
   * Adds an entry the user typed.
   *
   * Goes through `create` rather than a mode-bound writer, and that asymmetry is deliberate: the writer
   * exists to stop a private window recording what was *browsed*, and refusing an explicit "add this
   * entry" because the passwords tab happens to be in a private window would be a rule protecting
   * nobody. See `PasswordStore.create`.
   */
  create(request: PasswordCreateRequest): PasswordCreateResponse {
    return {
      outcome: this.#vault.create({
        url: request.url,
        username: request.username,
        password: request.password
      })
    }
  }

  /**
   * Edits an entry.
   *
   * Rebuilt key by key rather than spread. `exactOptionalPropertyTypes` treats an absent field and one
   * holding `undefined` as different types, and a request that crossed IPC has the second shape — so
   * spreading it would hand the store `{ password: undefined }` and claim an edit that was never asked
   * for, which here means overwriting a password with nothing.
   */
  update(request: PasswordUpdateRequest): PasswordOkResponse {
    this.#vault.update(request.id, {
      ...(request.username === undefined ? {} : { username: request.username }),
      ...(request.password === undefined ? {} : { password: request.password })
    })
    return { ok: true }
  }

  remove(request: PasswordRemoveRequest): PasswordRemoveResponse {
    return { removed: this.#vault.remove(request.id) }
  }

  /** Undoes a "never here", so a site the user changed their mind about can be offered again. */
  forgetNeverSaved(request: PasswordForgetNeverSavedRequest): PasswordOkResponse {
    this.#vault.forgetNeverSaved(request.origin)
    return { ok: true }
  }

  // --- the lock ---------------------------------------------------------------

  /**
   * Opens the vault.
   *
   * The candidate is passed straight through and is not held, copied, logged or included in the reply.
   * The reply is one word plus the resulting state, which is the whole reason `UnlockOutcome` is a
   * union of values: an error object would have carried a message, and a message is a thing that gets
   * logged.
   */
  async unlock(request: PasswordUnlockRequest): Promise<PasswordUnlockResponse> {
    const outcome = await this.#vault.unlock(request.masterPassword)
    return { outcome, vault: this.#vault.status() }
  }

  /** Closes the vault now, without waiting for the idle timeout. */
  async lock(): Promise<PasswordVaultStateResponse> {
    await this.#vault.lock()
    return { vault: this.#vault.status() }
  }

  async setMasterPassword(
    request: PasswordMasterPasswordRequest
  ): Promise<PasswordMasterPasswordResponse> {
    const outcome = await this.#vault.setMasterPassword({
      current: request.current,
      next: request.next
    })
    return { outcome, vault: this.#vault.status() }
  }

  /**
   * Destroys the vault and starts an empty one.
   *
   * The escape hatch for a forgotten master password. `reset: false` for a wrong confirmation token,
   * rather than a throw: this is the one operation whose failure must be quiet and whose success must
   * be deliberate.
   */
  async resetVault(request: PasswordResetVaultRequest): Promise<PasswordResetVaultResponse> {
    const reset = await this.#vault.resetVault(request.confirmation)
    return { reset, vault: this.#vault.status() }
  }

  // --- importing --------------------------------------------------------------

  /**
   * Imports an exported CSV the user picks in a native dialog.
   *
   * Three things are kept apart here that would be easy to collapse into one "failed": the user
   * cancelled, the file could not be read, and the file was read and its *contents* were refused. Only
   * the last one is about the file's shape, and only the last one has a report worth showing.
   */
  async import(): Promise<PasswordImportResponse> {
    let source: ImportSource | null
    try {
      source = await this.#chooseImportFile()
    } catch (error) {
      // The message is the operating system's and names a path, never a credential — the file has not
      // been parsed at this point. Logged rather than returned, so nothing untranslated reaches the page.
      console.warn('[passwords] the import file could not be read:', String(error))
      return { outcome: 'unreadable', vault: this.#vault.status() }
    }
    if (source === null) return { outcome: 'cancelled', vault: this.#vault.status() }

    const report = this.#vault.importChromeCsv(source.text)
    if (report === null) return { outcome: 'locked', vault: this.#vault.status() }
    return {
      outcome: 'imported',
      report,
      filePath: source.path,
      vault: this.#vault.status()
    }
  }
}
