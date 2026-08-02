import { copyFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  parseChromePasswordCsv,
  type ChromeImportResult
} from '@shared/passwords/chrome-import.js'
import {
  discardingPasswordWriter,
  type BrowsingMode,
  type PasswordSummary,
  type PasswordWriter,
  type SaveCredentialInput,
  type SaveOutcome,
  type UpdateCredentialPatch
} from '@shared/passwords/model.js'
import type { StoredCredentialState } from '@shared/passwords/save-policy.js'
import {
  RESET_VAULT_CONFIRMATION,
  VAULT_IDLE_SWEEP_MS,
  VAULT_IDLE_TIMEOUT_MS,
  assessMasterPassword,
  isVaultIdle,
  vaultHasMasterPassword,
  vaultKeyProtection,
  type MasterPasswordOutcome,
  type UnlockOutcome,
  type VaultStatus
} from '@shared/passwords/vault.js'
import type { SafeStorageLike } from '../crypto/local-data-key.js'
import {
  VaultKeyUnreadableError,
  WrongMasterPasswordError,
  deleteVaultKeyFile,
  newVaultKey,
  openVaultKey,
  readVaultKeyFile,
  vaultKeyProtectionOf,
  wrapVaultKey,
  writeVaultKeyFile,
  type VaultKeyFile
} from '../crypto/vault-key.js'
import { UnreadableDocumentError, type DocumentCodec } from '../data/JsonStore.js'
import { PasswordStore } from '../data/PasswordStore.js'
import type { AutofillVault } from './AutofillService.js'
import { applyChromeImport, type ImportTarget } from './import.js'
import { createVaultDocumentCodec } from './vault-codec.js'

/**
 * The vault, and whether it is open.
 *
 * ## What this class is for
 *
 * `PasswordStore` is persistence; this is the *lock* around it. It holds the vault key while the
 * vault is open, decides when to let go of it, and owns the one consequence that shapes everything
 * else here: **while the vault is locked there is no store at all.** Not a store that refuses — a
 * `null`. The document is a sealed file and the key is not in the process, so there is nothing to
 * read from and nothing to accidentally read from. Every locked answer below (`[]`, `null`,
 * `'none'`, `discardingPasswordWriter`) is a fact about that state rather than a policy applied to it,
 * which is the difference between a guarantee and a check somebody has to remember.
 *
 * ## The three ways the key goes away
 *
 * Explicit lock, idle timeout, and the last window closing — the last one from `index.ts`, which is
 * the only place that knows a window closed. `reveal.ts` names all three, and each is a *drop*, not a
 * flag: the store is released and the key buffer is overwritten.
 *
 * ## Why the idle timer measures user acts, not reads
 *
 * `list()` is called by autofill on every focus of a password field, and **a page can cause focus
 * whenever it likes**. If a read counted as activity, a site could hold the vault open indefinitely
 * with a loop, and the idle timeout would be a promise the browser could not keep on a page it did not
 * control. So activity is only: an unlock, a secret actually handed out (`secretOf`, which autofill
 * reaches only after `decideFill` has seen a real input event within five seconds), and a deliberate
 * write — add, edit, remove, import. Reads do not extend the lease.
 *
 * ## Why a vault with no master password is never idle-locked
 *
 * There is nothing to lock it back to: reopening asks nobody for anything. A timer that closed it
 * would cost the user their autofill for as long as the reopen took and buy exactly nothing. The
 * timeout is a property of the master password, not of the vault.
 */

export interface PasswordVaultOptions {
  /** `passwords.key`. See `crypto/vault-key.ts` for what is in it. */
  readonly keyFilePath: string
  /** `passwords.json`. */
  readonly documentPath: string
  /** Electron's `safeStorage` satisfies this; a test supplies a key store that misbehaves. */
  readonly safeStorage: SafeStorageLike
  /**
   * The codec the document was sealed with before the vault had a key of its own.
   *
   * `LocalDataProtection.codec` in the application. Used for reading only, once, and then never
   * again — see `vault-codec.ts` for the migration and why it narrows rather than widens.
   */
  readonly previousCodec: DocumentCodec | null
  readonly now?: () => number
  /**
   * How long the vault stays unlocked with nobody using it, read per check.
   *
   * A function rather than a number, and the change is what makes `passwords.lockAfterMinutes` a
   * setting rather than a constant with a label. Captured at construction it would take a restart to
   * move, which spec 5 forbids and which is worse here than elsewhere: somebody shortening this has
   * just decided the current timeout is too long, and telling them it applies tomorrow is telling
   * them no.
   *
   * Absent means `VAULT_IDLE_TIMEOUT_MS` — the fallback for a build with no settings behind it, which
   * in practice is a test.
   */
  readonly idleTimeoutMs?: () => number
  /**
   * How often the idle check runs. `0` starts no timer, and a test then calls `sweepIdle()`.
   *
   * A timer rather than a check on the next read, because the promise is that the key *is gone* after
   * the timeout — a key still in memory that would be refused if asked is exactly what a crash dump
   * picks up.
   */
  readonly idleSweepMs?: number
  readonly generateId?: () => string
  readonly debounceMs?: number
}

export class PasswordVault implements AutofillVault, ImportTarget {
  readonly #options: PasswordVaultOptions
  readonly #now: () => number
  readonly #idleTimeoutMs: () => number
  readonly #lockListeners = new Set<() => void>()

  #file: VaultKeyFile | null = null
  #key: Uint8Array | null = null
  #store: PasswordStore | null = null
  #lastActivityAt: number | null = null
  #unreadable = false
  #sweep: ReturnType<typeof setInterval> | null = null

  private constructor(options: PasswordVaultOptions) {
    this.#options = options
    this.#now = options.now ?? ((): number => Date.now())
    this.#idleTimeoutMs = options.idleTimeoutMs ?? ((): number => VAULT_IDLE_TIMEOUT_MS)
  }

  /**
   * Reads the key file and opens the vault if it can be opened without asking anybody.
   *
   * Never throws for a vault it cannot open, and that is the point of the key being separate: a
   * missing keychain, a damaged key file or a document sealed by a key that is gone all leave the
   * browser starting normally with a *locked* vault. The local-data key cannot afford that — its
   * failure means settings and history are unreadable, so `openLocalDataProtection` refuses to start —
   * but a locked password vault costs the user their autofill and nothing else, and a browser that
   * will not launch costs them the browser.
   *
   * Errors that are not about the vault — a directory in the way, no permission on the profile — are
   * let out, because those are not "locked", they are a broken profile.
   */
  static async open(options: PasswordVaultOptions): Promise<PasswordVault> {
    const vault = new PasswordVault(options)
    await vault.#load()
    const sweepMs = options.idleSweepMs ?? VAULT_IDLE_SWEEP_MS
    if (sweepMs > 0) {
      vault.#sweep = setInterval(() => {
        vault.sweepIdle()
      }, sweepMs)
      // Unreferenced so the vault's own housekeeping cannot be the reason the process stays alive.
      vault.#sweep.unref()
    }
    return vault
  }

  async #load(): Promise<void> {
    let file: VaultKeyFile | null
    try {
      file = await readVaultKeyFile(this.#options.keyFilePath)
    } catch (error) {
      if (!(error instanceof VaultKeyUnreadableError)) throw error
      // A key file that is not this format. Not repaired and not replaced: generating a new key would
      // make every stored credential permanently unreadable while looking like a successful launch.
      console.warn('[passwords] the vault key file could not be read; the vault stays locked:', error.message)
      this.#unreadable = true
      return
    }

    if (file === null) {
      await this.#createFreshVault()
      return
    }

    this.#file = file
    // A master password means locked, full stop. Nothing here tries to open it, because the only
    // thing that could is the user.
    if (file.kdf !== null) return

    let key: Uint8Array
    try {
      key = await openVaultKey({ file, safeStorage: this.#options.safeStorage, masterPassword: null })
    } catch (error) {
      if (!(error instanceof VaultKeyUnreadableError)) throw error
      console.warn('[passwords] the vault key could not be unwrapped; the vault stays locked:', error.message)
      this.#unreadable = true
      return
    }
    await this.#openStore(key)
  }

  /**
   * A new vault, on first run.
   *
   * No master password, because there is nobody to ask at startup and a browser that demanded one
   * before it would run would be one people turn off. The passwords page says what that means and
   * offers the upgrade; see `PasswordListResponse.vault`.
   */
  async #createFreshVault(): Promise<void> {
    const key = newVaultKey()
    const file = await wrapVaultKey({
      key,
      safeStorage: this.#options.safeStorage,
      masterPassword: null
    })
    await writeVaultKeyFile(this.#options.keyFilePath, file)
    this.#file = file
    await this.#openStore(key)
  }

  /**
   * Opens the document under `key`, or reports that it cannot be opened.
   *
   * `UnreadableDocumentError` is caught here rather than let out, and the reason is the same
   * asymmetry as above: the store raises it so that a vault which is *still there* behind a key this
   * process could not get hold of is never overwritten with an empty one. What to do about it is a
   * decision, and the decision for a password vault is "stay locked and say so", not "refuse to
   * start". `resetVault` is the way out for a user who has genuinely lost the key.
   */
  /**
   * Opens the document with this vault key. Answers whether it worked.
   *
   * The boolean is not decoration. Callers used to read `this.#store` back afterwards, and TypeScript keeps a
   * private field's narrowing across a method call — so a guard that genuinely catches a failed open looked dead
   * to the compiler and to the linter. Returning the outcome removes the unsoundness rather than silencing the
   * warning it produced, which would have meant deleting a real check.
   */
  async #openStore(key: Uint8Array): Promise<boolean> {
    const codec = createVaultDocumentCodec({
      vaultKey: key,
      previous: this.#options.previousCodec
    })
    try {
      this.#store = await PasswordStore.open({
        filePath: this.#options.documentPath,
        codec,
        ...(this.#options.generateId === undefined ? {} : { generateId: this.#options.generateId }),
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
        ...(this.#options.debounceMs === undefined ? {} : { debounceMs: this.#options.debounceMs })
      })
    } catch (error) {
      if (!(error instanceof UnreadableDocumentError)) throw error
      console.warn('[passwords] the vault document could not be decrypted; the vault stays locked')
      this.#unreadable = true
      key.fill(0)
      return false
    }
    this.#key = key
    this.#unreadable = false
    this.#noteActivity()
    return true
  }

  // --- the lock ---------------------------------------------------------------

  status(): VaultStatus {
    const file = this.#file
    return {
      /*
        Derived from the file rather than remembered, so what the page is told cannot disagree with
        what is on disk. With no readable file at all the level is unknown, and the honest stand-in is
        "whatever a new vault would get" — which the page ignores anyway, because `unreadable` is what
        it renders on.
      */
      protection:
        file === null
          ? vaultKeyProtection({
              keystore: this.#options.safeStorage.isEncryptionAvailable(),
              masterPassword: false
            })
          : vaultKeyProtectionOf(file),
      unlocked: this.#store !== null,
      unreadable: this.#unreadable,
      idleTimeoutMs: this.#idleTimeoutMs()
    }
  }

  isUnlocked(): boolean {
    return this.#store !== null
  }

  /**
   * Opens the vault with a master password.
   *
   * The candidate is used and dropped. It is not stored, not logged, and not echoed in any reply —
   * the outcome is one of four words, which is why `UnlockOutcome` is a union of values rather than a
   * thrown error carrying a message.
   */
  async unlock(masterPassword: string): Promise<UnlockOutcome> {
    if (this.#store !== null) return this.#hasMasterPassword() ? 'unlocked' : 'not-protected'
    if (this.#unreadable) return 'unreadable'
    const file = this.#file
    if (file === null) return 'unreadable'

    let key: Uint8Array
    try {
      key = await openVaultKey({
        file,
        safeStorage: this.#options.safeStorage,
        masterPassword
      })
    } catch (error) {
      if (error instanceof WrongMasterPasswordError) return 'wrong-password'
      if (error instanceof VaultKeyUnreadableError) {
        this.#unreadable = true
        return 'unreadable'
      }
      throw error
    }

    if (!(await this.#openStore(key))) return 'unreadable'
    return file.kdf === null ? 'not-protected' : 'unlocked'
  }

  /**
   * Closes the vault: the document is written, the store is released, the key is overwritten.
   *
   * The order matters and is easy to get wrong. The store reference is dropped *first*, so no write
   * can be scheduled while the flush is in flight, and the key is zeroed *last*, because the codec
   * holding it is the thing that seals the pending document — zeroing before the flush would encrypt
   * the vault under thirty-two zero bytes and lose it.
   */
  async lock(): Promise<void> {
    const store = this.#store
    this.#store = null
    this.#lastActivityAt = null
    if (store !== null) await store.flush()
    this.#dropKey()
    for (const listener of this.#lockListeners) {
      try {
        listener()
      } catch (error) {
        // One bad listener must not stop the others, and must not leave the vault half-locked.
        console.error('[passwords] a lock listener threw:', error)
      }
    }
  }

  /**
   * Locks the vault if it has been idle, and does nothing otherwise.
   *
   * Public so the timer is not the only thing that can drive it: a test advances a clock and calls
   * this, which is how the timeout is checked without waiting for it.
   */
  sweepIdle(): void {
    if (this.#store === null) return
    // Nothing to lock back to. See the class docblock.
    if (!this.#hasMasterPassword()) return
    if (!isVaultIdle(this.#lastActivityAt, this.#now(), this.#idleTimeoutMs())) return
    void this.lock()
  }

  /**
   * Notified when the key is dropped.
   *
   * Exists for one caller: autofill holds a submitted credential in memory while its save bar is up,
   * and a lock has to take that with it or the lock is not what it says. See
   * `AutofillService.dropPendingSaves`.
   */
  onLock(listener: () => void): () => void {
    this.#lockListeners.add(listener)
    return () => {
      this.#lockListeners.delete(listener)
    }
  }

  /**
   * Whether a candidate is the current master password. Nothing else changes.
   *
   * Verified the only way there is to verify it — by *opening the stored key file with it* — because
   * there is nothing to compare it against, and that is the design rather than a shortcoming: a stored
   * comparison value would be a second thing an attacker with the profile directory could attack.
   *
   * It exists for one caller. `MasterPasswordPrompt` asks the current password first and then asks for a
   * new one twice; without this the mistyped current password would only be discovered after all three
   * had been typed, and all three would then be thrown away. `setMasterPassword` still performs its own
   * check, so this is an early refusal and never a substitute for one — a check that can be skipped by
   * having already passed a different check is not a check.
   *
   * @returns false for a wrong candidate *and* for a key file that cannot be opened at all: neither is a
   *   candidate this vault will accept, and telling them apart here would only give a caller a way to
   *   distinguish "wrong" from "damaged" on a channel that answers one word.
   */
  async verifyMasterPassword(candidate: string): Promise<boolean> {
    const file = this.#file
    // A vault with no master password has none to verify, so no candidate is the right one.
    if (file?.kdf == null) return false
    try {
      const proof = await openVaultKey({
        file,
        safeStorage: this.#options.safeStorage,
        masterPassword: candidate
      })
      // Dropped immediately rather than used, so there is never a second live copy of the vault key in
      // this process. Same rule as `setMasterPassword`'s proof.
      proof.fill(0)
      return true
    } catch (error) {
      if (error instanceof WrongMasterPasswordError) return false
      if (error instanceof VaultKeyUnreadableError) return false
      throw error
    }
  }

  /**
   * Sets, changes or removes the master password.
   *
   * One method for all three transitions, because they are one operation with three shapes and
   * splitting them would give three places for the "prove you know the current one" check to be
   * forgotten from. `next: null` removes; `current: null` is only accepted when there is none.
   *
   * **The document is not touched.** Only `passwords.key` is rewritten, which is the whole reason the
   * vault has a key of its own: turning the master password on does not re-encrypt anything, so it
   * cannot fail halfway and cannot lose a credential. A test pins the document's bytes across the
   * transition.
   *
   * The current password is verified by *opening the stored file with it*, not by comparing it to
   * anything — there is nothing to compare it to, and that is the design. It costs one derivation,
   * which is the same half-second the unlock costs and for the same reason.
   */
  async setMasterPassword(request: {
    readonly current: string | null
    readonly next: string | null
  }): Promise<MasterPasswordOutcome> {
    const file = this.#file
    const key = this.#key
    if (file === null || key === null || this.#store === null) return 'locked'
    const hadMasterPassword = file.kdf !== null

    if (hadMasterPassword) {
      if (request.current === null) return 'wrong-password'
      try {
        const proof = await openVaultKey({
          file,
          safeStorage: this.#options.safeStorage,
          masterPassword: request.current
        })
        // Proof only. Dropped immediately rather than used, so there is never a second live copy of
        // the vault key in this process.
        proof.fill(0)
      } catch (error) {
        if (error instanceof WrongMasterPasswordError) return 'wrong-password'
        if (error instanceof VaultKeyUnreadableError) return 'locked'
        throw error
      }
    }

    if (request.next === null) {
      if (!hadMasterPassword) return 'not-protected'
      await this.#rewrapKey(key, null)
      return 'removed'
    }

    if (assessMasterPassword(request.next) !== null) return 'rejected'
    await this.#rewrapKey(key, request.next)
    return hadMasterPassword ? 'changed' : 'set'
  }

  /**
   * Rewrites the key file for the same key under a different wrapping.
   *
   * `wrapVaultKey` asks the key store whether it is available *now* rather than trusting what the old
   * file recorded, so a keyring that has since disappeared produces a `master`-only file instead of
   * one claiming a wrapping that no longer exists. That is a visible change of protection level — the
   * page renders it from `status()` — and it is the right way round: silently claiming the key store
   * still helps would be the lie.
   */
  async #rewrapKey(key: Uint8Array, masterPassword: string | null): Promise<void> {
    const file = await wrapVaultKey({
      key,
      safeStorage: this.#options.safeStorage,
      masterPassword
    })
    await writeVaultKeyFile(this.#options.keyFilePath, file)
    this.#file = file
    this.#noteActivity()
  }

  /**
   * Puts a copy of the sealed vault somewhere the user chose, so `resetVault` is not the end of it.
   *
   * ## Why this exists
   *
   * The only reason anybody reaches `resetVault` is that they have forgotten the master password, and the
   * file is then unreadable — but it is not worthless. Master passwords are remembered days later, found
   * in a notebook, recalled by typing it somewhere else. A browser that deletes the credentials of the
   * last five years because somebody could not remember a word this morning has destroyed something it
   * had no way of valuing.
   *
   * ## Why both files, and what the copy is honestly worth
   *
   * The document alone is unopenable: the key that seals it lives in `passwords.key`, wrapped. So both
   * are copied, and even then the copy is only as good as the wrapping. With `keystore+master` it is
   * *also* wrapped by this machine's key store, so the copy is recoverable on this machine, by this user,
   * with the master password — and nowhere else. With `master` alone, the password is the whole of it and
   * the copy travels. Neither of those is something a person can infer from a file, which is why the
   * sentence the user reads before this runs says it (`passwords.resetVaultKeepBody`).
   *
   * Flushed first, so the copy includes writes still sitting in the debounce timer rather than being a
   * version of the vault from thirty seconds ago.
   *
   * @returns how many files were written. Zero means there was nothing to keep, and the caller must then
   *   *not* discard anything — see `PasswordApi.resetVault`.
   */
  async copyTo(directory: string): Promise<number> {
    await this.flush()
    let written = 0
    for (const source of [this.#options.documentPath, this.#options.keyFilePath]) {
      try {
        await copyFile(source, join(directory, basename(source)))
        written += 1
      } catch (error) {
        /*
          A missing source is not an error here: a vault that has never been written has no document, and
          a key file can be the thing that went missing in the first place. Anything else — no permission,
          a full disk — is let out, because a copy that silently did not happen is the one failure this
          whole operation exists to prevent.
        */
        if ((error as { code?: string }).code !== 'ENOENT') throw error
      }
    }
    return written
  }

  /**
   * Destroys the vault and starts a new, empty one.
   *
   * The escape hatch for a forgotten master password, and for a document whose key is gone. Without
   * it such a user is left with a browser that asks, at every sign-in, for something they do not
   * have, and no way to begin again — which is how a security feature becomes the reason somebody
   * stops using the browser.
   *
   * **The document goes first.** A crash between the two deletions then leaves a key file with no
   * document, which the store reads as an empty vault and is harmless. The other order would leave a
   * sealed document with no key: `UnreadableDocumentError` at every start, for ever, with no way out
   * except the operation that just failed.
   *
   * @returns false when the confirmation token is wrong, so an empty or mistaken invoke cannot delete anything
   */
  async resetVault(confirmation: string): Promise<boolean> {
    if (confirmation !== RESET_VAULT_CONFIRMATION) return false

    this.#store = null
    this.#lastActivityAt = null
    this.#dropKey()
    this.#file = null
    this.#unreadable = false

    await rm(this.#options.documentPath, { force: true })
    // The store writes through a temporary beside the document; a leftover one would be picked up by
    // nothing, but leaving a file full of credentials behind a "delete everything" is not on.
    await rm(`${this.#options.documentPath}.tmp`, { force: true })
    await deleteVaultKeyFile(this.#options.keyFilePath)

    await this.#createFreshVault()
    for (const listener of this.#lockListeners) {
      try {
        listener()
      } catch (error) {
        console.error('[passwords] a lock listener threw:', error)
      }
    }
    return true
  }

  // --- reads (no secret, and no lease extension) -------------------------------

  list(): PasswordSummary[] {
    return this.#store?.list() ?? []
  }

  neverSavedOrigins(): string[] {
    return this.#store?.neverSavedOrigins() ?? []
  }

  summaryOf(id: string): PasswordSummary | null {
    return this.#store?.summaryOf(id) ?? null
  }

  count(): number {
    return this.#store?.list().length ?? 0
  }

  compareStored(url: string, username: string, password: string): StoredCredentialState {
    return this.#store?.compareStored(url, username, password) ?? 'none'
  }

  /**
   * The one read that hands out a secret, and therefore the one read that counts as activity.
   *
   * Reached from exactly two places: the passwords page's reveal button, and a fill that
   * `decideFill` has already authorised — which requires a real input event the core itself saw
   * within five seconds. Both are the user doing something, which is what the idle timeout is meant
   * to measure.
   */
  secretOf(id: string): string | null {
    const secret = this.#store?.secretOf(id) ?? null
    if (secret !== null) this.#noteActivity()
    return secret
  }

  // --- writes -----------------------------------------------------------------

  /**
   * The mode-bound writer, or one that keeps nothing.
   *
   * A locked vault hands back `discardingPasswordWriter` for the same structural reason a private
   * window does: an object with no reference to any store cannot leak into one. `noteUsed` is
   * deliberately *not* treated as activity — it is a side effect of a fill, and `secretOf` on the
   * same path has already counted it.
   */
  writerFor(mode: BrowsingMode): PasswordWriter {
    return this.#store?.writerFor(mode) ?? discardingPasswordWriter
  }

  /** `'rejected'` while locked: there is nothing to write into, and nothing was written. */
  create(input: SaveCredentialInput): SaveOutcome {
    const store = this.#store
    if (store === null) return 'rejected'
    this.#noteActivity()
    return store.create(input)
  }

  update(id: string, patch: UpdateCredentialPatch): void {
    if (this.#store === null) return
    this.#noteActivity()
    this.#store.update(id, patch)
  }

  remove(id: string): boolean {
    const store = this.#store
    if (store === null) return false
    this.#noteActivity()
    return store.remove(id)
  }

  forgetNeverSaved(url: string): void {
    if (this.#store === null) return
    this.#noteActivity()
    this.#store.forgetNeverSaved(url)
  }

  /**
   * Imports an exported CSV.
   *
   * The text arrives from `PasswordApi`, which read it from a file the user chose in a native dialog —
   * so no password ever crosses IPC on the way in. Parsing is `shared/passwords/chrome-import.ts` and
   * the collision rules are `import.ts`; what is here is only the refusal when the vault is closed,
   * because writing needs the key.
   */
  importChromeCsv(text: string): ChromeImportResult | null {
    if (this.#store === null) return null
    this.#noteActivity()
    return applyChromeImport(this, parseChromePasswordCsv(text))
  }

  onChange(listener: (summaries: PasswordSummary[]) => void): () => void {
    // Subscribing to a locked vault is legal and yields nothing: there is no store to hear from, and
    // the caller learns about the change of state from `status()` instead.
    return this.#store?.onChange(listener) ?? ((): void => {})
  }

  flush(): Promise<void> {
    return this.#store?.flush() ?? Promise.resolve()
  }

  /** Stops the idle timer. For shutdown, and for a test that must not leave a handle behind. */
  dispose(): void {
    if (this.#sweep !== null) clearInterval(this.#sweep)
    this.#sweep = null
  }

  #hasMasterPassword(): boolean {
    const file = this.#file
    return file !== null && vaultHasMasterPassword(vaultKeyProtectionOf(file))
  }

  #noteActivity(): void {
    this.#lastActivityAt = this.#now()
  }

  /**
   * Overwrites the key buffer and lets go of it.
   *
   * Best effort, and worth saying why it is still worth doing. JavaScript cannot promise that no copy
   * of these bytes exists — V8 may have moved the backing store during a garbage collection, and
   * nothing here can reach whatever it left behind. What zeroing does reliably remove is the *live*
   * copy, which is the one a long-running main process keeps for hours and the one a crash dump or a
   * `/proc/self/mem` read finds. A guarantee it is not; a meaningful reduction it is.
   */
  #dropKey(): void {
    const key = this.#key
    this.#key = null
    if (key !== null) key.fill(0)
  }
}
