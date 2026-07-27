import { randomBytes, scrypt } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { vaultKeyProtection, type VaultKeyProtection } from '@shared/passwords/vault.js'
import { DOCUMENT_KEY_BYTES, isSealedDocument, openDocument, sealDocument } from './envelope.js'
import type { SafeStorageLike } from './local-data-key.js'

/**
 * `passwords.key`: the vault's own key, and the two layers over it.
 *
 * ## Why the vault gets a key of its own
 *
 * This is the seam `local-data-key.ts` names — "one more layer over the same 32 bytes" — and the
 * reason it is a *separate* 32 bytes is practical rather than cryptographic. If the master password
 * wrapped the local-data key, switching it on would put history, settings, favicons, bookmarks,
 * downloads, permissions and the session behind it too: the browser could not start without it, an
 * idle lock would make the address bar stop remembering things, and forgetting it would cost the
 * whole profile instead of the credentials. A second key costs one file and confines the blast radius
 * of both the protection and its loss to the thing that needs it.
 *
 * ## The two layers compose; they do not alternate
 *
 * ```
 *   passwords.key = { version, keystore, kdf, payload }
 *
 *   payload  = keystore ? base64( safeStorage.encryptString(innerText) ) : innerText
 *   innerText= base64( inner )
 *   inner    = kdf ? OBENC-seal( scrypt(master, kdf), vaultKey ) : vaultKey
 * ```
 *
 * Nested, so opening the vault needs the key store **and** the master password. This is the point
 * that is easy to get backwards: a file that either layer could open on its own would add exactly
 * nothing, because the attacker a master password exists to stop — malware running as the logged-in
 * user, a person at an unlocked laptop, a restored profile beside an exported keychain — already has
 * the key store. `safeStorage` unwraps for whoever is logged in, without asking. That is the whole
 * argument in `shared/passwords/reveal.ts`, and this layout is its consequence.
 *
 * The pleasing part is the degraded case. With no key store the file is `master`-only, which is real
 * protection; with no master password it is `keystore`-only, which is today's; with neither it is
 * `plain` and the browser says so. Four states, one format, no special cases.
 *
 * ## What is readable in this file, and why that is not a hole
 *
 * `version`, `keystore` and the KDF parameters — including the salt — are plain JSON. A salt is not
 * a secret; hiding it would be confusing rather than safe, and its job is to defeat precomputation,
 * which it does in the open. Keeping them readable also means two questions can be answered without
 * the keychain: *is this profile's vault behind a master password?* and *can this build read this
 * file at all?* The second decides whether the browser asks for a password or reports that no
 * password will help.
 *
 * The parameters are not authenticated, and the consequence is worth stating rather than leaving to
 * be found. Someone who can write into the profile directory can lower `n`. What they get is a
 * derivation that produces a *different* key, so the GCM tag on the payload fails and the vault does
 * not open — a denial of service available to anyone who could also simply delete the file. What
 * they cannot do is make the user's correct password derive a key that opens the existing payload,
 * which is the only thing a downgrade would be worth.
 *
 * ## Where Argon2id goes
 *
 * `VaultKdf.algorithm`. Argon2id is the better function and needs a runtime dependency; two of this
 * project's four slots are reserved for exactly that. When it arrives it is a second arm in
 * `deriveWrappingKey` and a second shape in `VaultKdf` — a file written by this build keeps its
 * `scrypt` parameters and keeps opening, and a re-wrap on the next master-password change moves it
 * across. Nothing about the sealed document changes, which is why the document format was settled
 * first.
 */

/**
 * The derivation, named so a future one has somewhere to be.
 *
 * A single-member union today. An unknown value in a file is refused rather than guessed at: a
 * *newer* build's algorithm read by an *older* one must fail visibly, because the alternative is
 * deriving nonsense and reporting "wrong master password" to a user whose password is right.
 */
export type VaultKdfAlgorithm = 'scrypt'

export interface VaultKdf {
  readonly algorithm: VaultKdfAlgorithm
  /** Cost parameter; memory is `128 · n · r` bytes. */
  readonly n: number
  readonly r: number
  readonly p: number
  /** Base64, `VAULT_SALT_BYTES` long. Fresh on every wrap, so changing the password re-salts. */
  readonly salt: string
}

/**
 * scrypt's cost, as `reveal.ts` specifies it: N = 2¹⁷, r = 8, p = 1.
 *
 * Roughly 128 MB and half a second per attempt on current hardware, which is the entire point — it
 * is the number that turns "read the file and run a word list" into weeks. `p = 1` because scrypt's
 * parallelism multiplies work without multiplying memory, and memory is the part an attacker with a
 * graphics card finds expensive.
 */
export const VAULT_SCRYPT_COST = { n: 131_072, r: 8, p: 1 } as const

export const VAULT_SALT_BYTES = 16

/** The shape `wrapVaultKey` may be asked to use. See its `cost` parameter for the one caveat. */
export interface ScryptCost {
  readonly n: number
  readonly r: number
  readonly p: number
}

/**
 * A key file exists and cannot be turned into a key.
 *
 * Reported, never repaired, for the reason `KeyMaterialUnreadableError` gives: generating a
 * replacement would "fix" the browser and make every stored credential permanently unreadable — a
 * factory reset wearing the costume of a successful launch. Restoring the keychain entry, or the
 * profile backup, is a recovery the user can still perform. Overwriting the key is not.
 *
 * Unlike the local-data key, this one does **not** stop the browser from starting. A vault that
 * cannot be opened is a vault that is locked; the rest of the profile is behind a different key and
 * is unaffected. That asymmetry is the second dividend of the key being separate.
 */
export class VaultKeyUnreadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultKeyUnreadableError'
  }
}

/** The key file is behind a master password and none was supplied. */
export class MasterPasswordRequiredError extends Error {
  constructor() {
    super('the password vault is protected by a master password')
    this.name = 'MasterPasswordRequiredError'
  }
}

/**
 * The supplied master password did not open the payload.
 *
 * Indistinguishable, by construction, from a payload that was tampered with: both are a failed GCM
 * tag. Reported as a wrong password because that is overwhelmingly what it is, and because the
 * alternative message — "your vault may have been modified" — would be alarming and usually false.
 * The tamper case is separately unlikely wherever a key store exists, since the payload is inside
 * its wrapping.
 *
 * The message names nothing. Neither the candidate nor its length appears here, in a log, or in any
 * reply that crosses IPC.
 */
export class WrongMasterPasswordError extends Error {
  constructor() {
    super('the master password did not open the password vault')
    this.name = 'WrongMasterPasswordError'
  }
}

export interface VaultKeyFile {
  readonly version: 1
  /** True when `payload` is wrapped by the platform key store. */
  readonly keystore: boolean
  /** `null` when no master password guards the key. */
  readonly kdf: VaultKdf | null
  readonly payload: string
}

/** What the page is told about this file. Derived, so it cannot disagree with the bytes. */
export function vaultKeyProtectionOf(file: VaultKeyFile): VaultKeyProtection {
  return vaultKeyProtection({ keystore: file.keystore, masterPassword: file.kdf !== null })
}

/** Fresh key material for a new vault. */
export function newVaultKey(): Uint8Array {
  return randomBytes(DOCUMENT_KEY_BYTES)
}

/**
 * Reads `passwords.key`, or `null` when there is none.
 *
 * `null` means *first run* and nothing else. A file that exists but cannot be understood throws,
 * because the one thing that must not happen is a second key being generated over a document the
 * first key sealed — which is what returning `null` for a damaged file would cause on the very next
 * line of the caller.
 *
 * @throws VaultKeyUnreadableError for a file that is not this format
 */
export async function readVaultKeyFile(keyFilePath: string): Promise<VaultKeyFile | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(keyFilePath)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    // A file that cannot be examined is not an absent one, and the difference decides whether a new
    // key is created. Guessing "absent" here is the one wrong answer.
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new VaultKeyUnreadableError(`${keyFilePath} is not readable as JSON: ${String(error)}`)
  }
  const file = asVaultKeyFile(parsed)
  if (file === null) {
    throw new VaultKeyUnreadableError(`${keyFilePath} is not a password vault key file`)
  }
  return file
}

/**
 * Hand-written validation rather than a zod schema.
 *
 * `crypto/` has no validation dependency and this shape is four fields; pulling zod in here to check
 * them would make the module that holds the key depend on the module that parses documents. The
 * checks are exhaustive because the alternative is a `NaN` reaching `scrypt`, where it becomes an
 * error about memory limits.
 */
function asVaultKeyFile(value: unknown): VaultKeyFile | null {
  if (typeof value !== 'object' || value === null) return null
  const record: Record<string, unknown> = value as Record<string, unknown>
  if (record['version'] !== 1) return null
  if (typeof record['keystore'] !== 'boolean') return null
  if (typeof record['payload'] !== 'string' || record['payload'] === '') return null
  const rawKdf = record['kdf']
  if (rawKdf === null) {
    return { version: 1, keystore: record['keystore'], kdf: null, payload: record['payload'] }
  }
  const kdf = asVaultKdf(rawKdf)
  if (kdf === null) return null
  return { version: 1, keystore: record['keystore'], kdf, payload: record['payload'] }
}

function asVaultKdf(value: unknown): VaultKdf | null {
  if (typeof value !== 'object' || value === null) return null
  const record: Record<string, unknown> = value as Record<string, unknown>
  if (record['algorithm'] !== 'scrypt') return null
  const { n, r, p } = record
  if (!isPositiveInteger(n) || !isPositiveInteger(r) || !isPositiveInteger(p)) return null
  const salt = record['salt']
  if (typeof salt !== 'string') return null
  // The length is checked on the decoded bytes rather than on the text: `Buffer.from` skips whatever
  // is not base64 instead of failing, so a truncated salt would otherwise derive a key from fewer
  // bytes than the format promises and nothing would say so.
  if (Buffer.from(salt, 'base64').length !== VAULT_SALT_BYTES) return null
  return { algorithm: 'scrypt', n, r, p, salt }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Writes the key file, atomically.
 *
 * Write-then-rename and mode 0600, as for every other file here. A crash between the two leaves no
 * key file where there was none — a first run again — and the *previous* file where there was one,
 * which matters far more: this is the file whose loss costs the vault.
 */
export async function writeVaultKeyFile(keyFilePath: string, file: VaultKeyFile): Promise<void> {
  await mkdir(dirname(keyFilePath), { recursive: true })
  const temp = `${keyFilePath}.tmp`
  await writeFile(temp, JSON.stringify(file), { mode: 0o600 })
  await rename(temp, keyFilePath)
}

/**
 * Removes the key file and any half-written temporary beside it.
 *
 * Only ever called together with the document it protects — see `RESET_VAULT_CONFIRMATION`. Removing
 * one without the other leaves either a sealed document nothing can open or a key for nothing.
 */
export async function deleteVaultKeyFile(keyFilePath: string): Promise<void> {
  await rm(keyFilePath, { force: true })
  await rm(`${keyFilePath}.tmp`, { force: true })
}

export interface WrapVaultKeyOptions {
  readonly key: Uint8Array
  /** Electron's own object satisfies this; a test supplies a key store that misbehaves. */
  readonly safeStorage: SafeStorageLike
  /** `null` for no master password. */
  readonly masterPassword: string | null
  /**
   * Cost override, and the one seam in this file that could weaken it.
   *
   * It exists because a test that exercised the real parameters would spend half a second per
   * assertion, and a derivation nobody tests is worse than a parameter that can be lowered in a
   * test. It is safe because *nothing in the application passes it*: `PasswordVault` — the only
   * production caller — has no such parameter to forward, so there is no path from a setting, a
   * file or an IPC payload to this argument. A test pins `VAULT_SCRYPT_COST` to the specified
   * values, and another exercises the default end to end.
   */
  readonly cost?: ScryptCost
}

/**
 * Wraps a vault key for storage.
 *
 * The key store is used when it is available and skipped when it is not, rather than refused: a
 * desktop with no keyring is a real configuration, and a vault behind a master password alone is
 * better protected than one behind a key store alone. What the caller must not do is *silently*
 * accept the `plain` case, and it does not — the protection level travels to the page.
 */
export async function wrapVaultKey(options: WrapVaultKeyOptions): Promise<VaultKeyFile> {
  if (options.key.length !== DOCUMENT_KEY_BYTES) {
    throw new VaultKeyUnreadableError(
      `a vault key must be ${DOCUMENT_KEY_BYTES} bytes, got ${options.key.length}`
    )
  }

  let kdf: VaultKdf | null = null
  let inner: Uint8Array = options.key
  if (options.masterPassword !== null) {
    const cost = options.cost ?? VAULT_SCRYPT_COST
    kdf = {
      algorithm: 'scrypt',
      n: cost.n,
      r: cost.r,
      p: cost.p,
      salt: randomBytes(VAULT_SALT_BYTES).toString('base64')
    }
    inner = sealDocument(await deriveWrappingKey(options.masterPassword, kdf), options.key)
  }

  const innerText = Buffer.from(inner).toString('base64')
  // Asked once, here, rather than remembered from startup: a key store can appear between launches,
  // and the file has to record what was actually used rather than what was available earlier.
  const keystore = options.safeStorage.isEncryptionAvailable()
  const payload = keystore
    ? options.safeStorage.encryptString(innerText).toString('base64')
    : innerText

  return { version: 1, keystore, kdf, payload }
}

export interface OpenVaultKeyOptions {
  readonly file: VaultKeyFile
  readonly safeStorage: SafeStorageLike
  /** `null` when the caller has none to offer; throws `MasterPasswordRequiredError` if one is needed. */
  readonly masterPassword: string | null
}

/**
 * Unwraps a vault key, or says why it could not.
 *
 * The order of the failures is the order of the layers, so the caller learns which one stopped it:
 * a missing key store is not a wrong password, and telling a user to try their password again when
 * their keychain is gone would send them looking in the wrong place for ever.
 *
 * @throws MasterPasswordRequiredError when the file is master-protected and none was given
 * @throws WrongMasterPasswordError    when the derived key did not open the payload
 * @throws VaultKeyUnreadableError     when the key store cannot help, or the bytes are wrong
 */
export async function openVaultKey(options: OpenVaultKeyOptions): Promise<Uint8Array> {
  const { file } = options
  if (file.kdf !== null && options.masterPassword === null) {
    throw new MasterPasswordRequiredError()
  }

  let innerText: string
  if (file.keystore) {
    if (!options.safeStorage.isEncryptionAvailable()) {
      throw new VaultKeyUnreadableError(
        'the password vault key was wrapped by the operating system key store, which is not available now'
      )
    }
    try {
      innerText = options.safeStorage.decryptString(Buffer.from(file.payload, 'base64'))
    } catch (error) {
      // `String` rather than a check for `Error`: whatever a key store throws, this message only has
      // to name it, and a branch for the other shape would be one nothing can produce.
      throw new VaultKeyUnreadableError(
        `the password vault key could not be unwrapped by the key store: ${String(error)}`
      )
    }
  } else {
    innerText = file.payload
  }

  const inner = Buffer.from(innerText, 'base64')
  if (file.kdf === null) return checkedKey(inner)

  if (!isSealedDocument(inner)) {
    // Not a wrong password: the bytes are not an envelope at all, so no password could open them.
    // Distinguished because the two point at different recoveries.
    throw new VaultKeyUnreadableError(
      'the password vault key file claims a master password but holds no sealed key'
    )
  }
  // `masterPassword` is non-null here — the guard at the top of the function is the only way past —
  // but the compiler cannot see through it, and `??` is honest about that without inventing a case:
  // an empty string would fail the tag check exactly as a wrong password does.
  const wrapping = await deriveWrappingKey(options.masterPassword ?? '', file.kdf)
  let key: Uint8Array
  try {
    key = openDocument(wrapping, inner)
  } catch {
    throw new WrongMasterPasswordError()
  }
  return checkedKey(key)
}

/**
 * The one place the key's length is checked coming out of the file.
 *
 * Without it a truncated file would yield a short key and `createCipheriv` would complain, from
 * inside a flush, about something that sounds like a disk problem.
 */
function checkedKey(key: Uint8Array): Uint8Array {
  if (key.length !== DOCUMENT_KEY_BYTES) {
    throw new VaultKeyUnreadableError(
      `the password vault key file holds ${key.length} bytes of key material, expected ${DOCUMENT_KEY_BYTES}`
    )
  }
  return key
}

/**
 * The master password, stretched into a key.
 *
 * `scrypt` and not `scryptSync`, and that is not a style choice: the synchronous form would occupy
 * the main process's own thread for half a second, which freezes every window, every tab's
 * compositing and the menu bar. The asynchronous form runs on libuv's pool. Half a second of "the
 * whole browser stopped" is exactly how a security feature earns a reputation for being broken.
 *
 * `maxmem` is passed explicitly and is the trap in this API. Node's default ceiling is 32 MB and
 * these parameters need `128 · n · r` = 128 MB, so the call fails with a message about memory rather
 * than about parameters — and the obvious "fix" is to lower `n`, which is the one thing that must
 * not happen.
 *
 * ## Why the call itself is inside a `try`, and not only its callback
 *
 * Node validates scrypt's cost parameters **synchronously**, while it is constructing the job, and
 * *throws* rather than calling back: a non-power-of-two `N` raises
 * `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, as does a fractional cost or a `p`/`r` pair needing more than
 * `maxmem`. Only a genuine allocation failure ever reaches the callback.
 *
 * That matters because `asVaultKdf` accepts any positive integer for `n` — it validates the shape of the
 * file, not the arithmetic — so a hand-edited or corrupted `passwords.key` with `n: 3` is a file this
 * module will happily try to derive from. Thrown from inside the promise executor, the raw Node error
 * became the promise's rejection, so `openVaultKey` broke the `@throws` contract it documents:
 * `PasswordVault.unlock` rethrows anything that is not one of this file's own errors, and the unlock
 * crossed IPC as an unexpected error instead of settling as the `unreadable` outcome the design
 * specifies — a page waiting on a promise that rejected with a Node error code.
 *
 * Wrapped here rather than fixed by rejecting an odd `n` in `asVaultKdf`, because the two are not
 * equivalent: the ceiling and the `p`/`r` product fail the same way and have no equivalent shape check,
 * so a guard in the validator would close one door of three. Both arms produce the same error for the
 * same reason, which is what the caller's recovery is written against.
 */
async function deriveWrappingKey(masterPassword: string, kdf: VaultKdf): Promise<Uint8Array> {
  const salt = Buffer.from(kdf.salt, 'base64')
  const maxmem = 128 * kdf.n * kdf.r + 1024 * 1024
  return new Promise<Uint8Array>((resolve, reject) => {
    const failed = (message: string): void => {
      // The message is Node's and names parameters, never the candidate.
      reject(new VaultKeyUnreadableError(`the master password could not be stretched: ${message}`))
    }
    try {
      scrypt(
        masterPassword,
        salt,
        DOCUMENT_KEY_BYTES,
        { N: kdf.n, r: kdf.r, p: kdf.p, maxmem },
        (error, derived) => {
          if (error !== null) {
            failed(error.message)
            return
          }
          resolve(derived)
        }
      )
    } catch (error) {
      /*
        The synchronous arm: refused parameters, before any work was scheduled. See above.

        `String(error)` rather than a narrowing to `Error` and a second arm for anything else. The
        alternative reads as more careful and is worse here: the other arm is unreachable — Node throws
        an `Error` — so it would be a branch no test can cover, in a directory this project holds at
        100 %, and the honest ways out of that are both bad (a test that fakes `node:crypto` to prove a
        `String()` call, or a lowered threshold).
      */
      failed(String(error))
    }
  })
}
