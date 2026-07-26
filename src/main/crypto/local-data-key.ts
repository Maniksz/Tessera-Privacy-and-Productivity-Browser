import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DOCUMENT_KEY_BYTES } from './envelope.js'

/**
 * The key that every local document is encrypted with, and where it lives.
 *
 * The key is generated here and stored in the profile directory, but only after
 * the operating system's key store has wrapped it — Keychain on macOS, DPAPI on
 * Windows, libsecret or KWallet on Linux. So the file next to the data is useless
 * on its own, and nothing has to ask the user for a password on every start.
 *
 * A master password would be stronger still, because it survives an attacker who
 * is already logged in as the user. It is not here because it needs a UI to be
 * entered into, and shipping the file format first means adding one later does not
 * require rewriting the documents. The wrapped key file is the place that decision
 * will slot into: one more layer over the same 32 bytes.
 */

/**
 * The slice of Electron's `safeStorage` this module uses.
 *
 * Electron's own object satisfies it structurally, so the main process passes
 * `safeStorage` straight in and nothing here imports Electron. That is the point:
 * a test supplies a fake key store and exercises the real code paths, including
 * the ones that only happen when a key store misbehaves — which is exactly what
 * mocking the module would have made unreachable.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** No key store to protect a key with. The caller decides what that means. */
export class KeystoreUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeystoreUnavailableError'
  }
}

/**
 * A key file exists but did not survive unwrapping.
 *
 * Reported rather than repaired. Generating a replacement would "fix" startup and
 * make every existing document permanently unreadable — a factory reset wearing
 * the costume of a successful launch. Restoring the key store, or the profile
 * backup, is a recovery the user can still perform; overwriting the key is not.
 */
export class KeyMaterialUnreadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyMaterialUnreadableError'
  }
}

export interface LocalDataKeyOptions {
  safeStorage: SafeStorageLike
  /** Wrapped key material. Sits in the profile directory beside the documents it protects. */
  keyFilePath: string
}

/** True when this profile has been protected before, whether or not it can be right now. */
export async function localDataKeyExists(keyFilePath: string): Promise<boolean> {
  try {
    await stat(keyFilePath)
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false
    // A key file that cannot be examined is not an absent one, and the difference
    // decides whether unencrypted storage is acceptable. Guessing "absent" here
    // would be the one wrong answer.
    throw error
  }
}

/**
 * Returns this profile's document key, creating it on first run.
 *
 * @throws KeystoreUnavailableError   when the platform has no key store
 * @throws KeyMaterialUnreadableError when the stored key cannot be unwrapped
 */
export async function loadOrCreateLocalDataKey(options: LocalDataKeyOptions): Promise<Uint8Array> {
  if (!options.safeStorage.isEncryptionAvailable()) {
    throw new KeystoreUnavailableError(
      'the operating system key store is not available, so a key cannot be protected'
    )
  }

  const stored = await readFileOrNull(options.keyFilePath)
  if (stored === null) return createLocalDataKey(options)

  let material: string
  try {
    material = options.safeStorage.decryptString(stored)
  } catch (error) {
    // `String` rather than a check for `Error`: whatever a key store throws, this
    // message only has to name it, and a branch for the other shape would be one
    // nothing can produce.
    throw new KeyMaterialUnreadableError(
      `${options.keyFilePath} could not be unwrapped by the key store: ${String(error)}`
    )
  }

  // Base64 because `safeStorage` wraps strings, not bytes. `Buffer.from` skips
  // anything that is not base64 instead of failing, so the length check below is
  // the real validation — without it, a truncated file would yield a short key and
  // `createCipheriv` would complain about something unrelated.
  const key = Buffer.from(material, 'base64')
  if (key.length !== DOCUMENT_KEY_BYTES) {
    throw new KeyMaterialUnreadableError(
      `${options.keyFilePath} holds ${key.length} bytes of key material, expected ${DOCUMENT_KEY_BYTES}`
    )
  }
  return key
}

async function createLocalDataKey(options: LocalDataKeyOptions): Promise<Uint8Array> {
  const key = randomBytes(DOCUMENT_KEY_BYTES)
  const wrapped = options.safeStorage.encryptString(key.toString('base64'))

  await mkdir(dirname(options.keyFilePath), { recursive: true })
  // Write-then-rename, as for every other file here: a crash between the two
  // leaves no key file at all, which is a first run again, rather than a truncated
  // one that would look like corruption for ever.
  const temp = `${options.keyFilePath}.tmp`
  await writeFile(temp, wrapped, { mode: 0o600 })
  await rename(temp, options.keyFilePath)
  return key
}

async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    // Anything else — a directory in the way, no permission — is not "first run",
    // and treating it as one would create a second key over unreadable data.
    throw error
  }
}
