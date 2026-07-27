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
  PasswordUnlockResponse,
  PasswordUpdateRequest,
  PasswordVaultStateResponse,
  VaultCopyOutcome
} from '@shared/passwords/api.js'
import type { ChromeImportResult } from '@shared/passwords/chrome-import.js'
import type { PasswordSummary } from '@shared/passwords/model.js'
import { RESET_VAULT_CONFIRMATION, type VaultStatus } from '@shared/passwords/vault.js'
import type { MasterPasswordHost, MasterPasswordPrompt } from './MasterPasswordPrompt.js'

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
  lock(): Promise<void>
  /**
   * Writes the sealed document and the wrapped key into a directory. `0` means nothing was there.
   *
   * On this interface because the reset offers it, and the *ordering* is the thing worth testing: the
   * copy happens before anything is deleted, and a copy that fails stops the deletion. A fake vault
   * that records the order proves both.
   */
  copyTo(directory: string): Promise<number>
  resetVault(confirmation: string): Promise<boolean>
  /** `null` while locked, so the caller can report that rather than an empty import. */
  importChromeCsv(text: string): ChromeImportResult | null
}

/**
 * What the user chose when offered a copy of the vault they are about to lose.
 *
 * Three answers and not two, because "cancel the whole thing" has to be one of them: the offer is shown
 * at the point of no return, and a dialogue whose only choices are "keep a copy" and "delete" has taken
 * away the answer most people want when they read the sentence and reconsider.
 */
export type VaultCopyChoice =
  | { readonly choice: 'copy'; readonly directory: string }
  | { readonly choice: 'discard' }
  | { readonly choice: 'cancel' }

/** A file the user picked, and its contents. Produced by the core's own dialog, never by a page. */
export interface ImportSource {
  readonly path: string
  readonly text: string
}

export interface PasswordApiOptions {
  readonly vault: PasswordApiVault
  /**
   * Who asks for the master password, and the only thing in this program that ever holds one.
   *
   * Reached from here rather than reimplemented, because "the page asks and the core checks" is the whole
   * arrangement: this class turns two channels into two calls on it and never sees a candidate. See
   * `MasterPasswordPrompt`.
   */
  readonly prompt: MasterPasswordPrompt
  /**
   * Opens a native file chooser and reads what was picked, or answers `null` when it was cancelled.
   *
   * Injected rather than called here, so this class needs no Electron and the import's rules are
   * exercised without one. It may reject — an unreadable file, a device that went away — and `import`
   * turns that into an outcome rather than letting it out, because a rejected promise on this boundary
   * becomes an English sentence on a translated page.
   */
  readonly chooseImportFile: () => Promise<ImportSource | null>
  /**
   * Asks whether to keep a copy of the vault about to be destroyed, and where.
   *
   * Injected for the same reason as the file chooser, and it carries more weight than most seams here:
   * the *wording* is the point of the offer. The user has to be told, in one breath, that a copy is worth
   * keeping and that it is unreadable without the password they have just told us they forgot. That
   * sentence is translated and lives with the dialogue; what this class owns is that it is asked **before**
   * anything is deleted.
   */
  readonly askAboutVaultCopy: () => Promise<VaultCopyChoice>
}

export class PasswordApi {
  readonly #vault: PasswordApiVault
  readonly #prompt: MasterPasswordPrompt
  readonly #chooseImportFile: () => Promise<ImportSource | null>
  readonly #askAboutVaultCopy: () => Promise<VaultCopyChoice>

  constructor(options: PasswordApiOptions) {
    this.#vault = options.vault
    this.#prompt = options.prompt
    this.#chooseImportFile = options.chooseImportFile
    this.#askAboutVaultCopy = options.askAboutVaultCopy
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

  /** The lock alone, for a page redrawing it without re-reading the list. */
  vaultStatus(): PasswordVaultStateResponse {
    return { vault: this.#vault.status() }
  }

  /**
   * Asks the core to open the vault, and answers with what came of it.
   *
   * No payload, in either direction beyond one of four words. The prompt is browser chrome on the overlay
   * layer, the keystrokes are read in the main process, and this method never holds a candidate — which is
   * why there is nothing here to be careful with. That is the point of the arrangement: the previous
   * version of this method took a `masterPassword` and was surrounded by promises about not logging it.
   *
   * `host` is the window the prompt appears in, resolved from the sender. `null` when the request could
   * not be attributed to one — a page in a window that is closing — and then there is nowhere to draw a
   * dialogue, so nobody can answer it, so it is `cancelled`. The same rule `PermissionArbiter.ask` applies.
   */
  async requestUnlock(host: MasterPasswordHost | null): Promise<PasswordUnlockResponse> {
    const outcome = await this.#prompt.requestUnlock(host)
    return { outcome, vault: this.#vault.status() }
  }

  /** Closes the vault now, without waiting for the idle timeout. */
  async lock(): Promise<PasswordVaultStateResponse> {
    await this.#vault.lock()
    return { vault: this.#vault.status() }
  }

  /** Sets, changes or removes the master password, through the same prompt. */
  async beginSetMasterPassword(
    request: PasswordMasterPasswordRequest,
    host: MasterPasswordHost | null
  ): Promise<PasswordMasterPasswordResponse> {
    const outcome = await this.#prompt.requestMasterPassword(host, request.intent)
    return { outcome, vault: this.#vault.status() }
  }

  /**
   * Destroys the vault and starts an empty one — after offering to put the sealed copy aside.
   *
   * ## Why the offer comes first, and why a failed copy stops everything
   *
   * The only reason anybody is here is that they have forgotten the master password, so the vault is
   * unreadable — and *unreadable is not worthless*. Passwords come back: found in a notebook, remembered
   * in the shower, recalled by typing it into something else. A browser that deleted five years of
   * credentials because somebody could not remember a word this morning would have destroyed something it
   * had no way of valuing, and the user would not discover the loss until the day the password returned.
   *
   * So the order is: offer, copy, verify that something was written, and only then discard. Every failure
   * path leaves the vault alone:
   *
   *   - the confirmation token is wrong — nothing is offered and nothing happens, `copy: 'none'`;
   *   - the user cancels the offer — nothing happens, `reset: false`;
   *   - the copy throws, or wrote nothing — `copy: 'failed'` and **`reset: false`**. Discarding after
   *     failing to save is the single outcome this whole feature exists to prevent, and it would be the
   *     natural result of treating the copy as best-effort.
   *
   * `declined` is a real answer and is honoured: somebody who has decided the old vault is worthless does
   * not need to be argued with, and the sentence they read said what they were giving up.
   */
  async resetVault(request: PasswordResetVaultRequest): Promise<PasswordResetVaultResponse> {
    /*
      The token before the dialogue.

      Otherwise an empty or mistaken invoke on this channel would put a "your vault is about to be
      destroyed" dialogue in front of somebody, which is alarming on its own — and the reset would then be
      refused anyway, so the question was never real.
    */
    if (request.confirmation !== RESET_VAULT_CONFIRMATION) {
      return { reset: false, copy: 'none', vault: this.#vault.status() }
    }

    const choice = await this.#askAboutVaultCopy()
    if (choice.choice === 'cancel') {
      return { reset: false, copy: 'none', vault: this.#vault.status() }
    }

    let copy: VaultCopyOutcome = 'declined'
    if (choice.choice === 'copy') {
      copy = await this.#copyVault(choice.directory)
      if (copy === 'failed') return { reset: false, copy, vault: this.#vault.status() }
    }

    const reset = await this.#vault.resetVault(request.confirmation)
    return { reset, copy, vault: this.#vault.status() }
  }

  /**
   * Writes the copy, and treats "nothing was written" as a failure.
   *
   * A rejection is caught rather than let out, and the message is logged rather than returned: it comes
   * from the operating system and names a path the user chose, which is not a secret — but a rejected
   * invoke becomes an English sentence on a translated page, and this page is one somebody reads once, at
   * the worst moment.
   */
  async #copyVault(directory: string): Promise<VaultCopyOutcome> {
    try {
      return (await this.#vault.copyTo(directory)) > 0 ? 'saved' : 'failed'
    } catch (error) {
      console.warn('[passwords] the vault copy could not be written:', String(error))
      return 'failed'
    }
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
