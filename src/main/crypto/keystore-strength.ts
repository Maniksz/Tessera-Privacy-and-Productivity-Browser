import type { SafeStorageLike } from './local-data-key.js'

/**
 * How much the key store behind `safeStorage` protects on this run.
 *
 * ## Why "available" is not the answer
 *
 * On Linux, Chromium picks a backend at startup: libsecret or KWallet when the desktop has a keyring,
 * and otherwise `basic_text`, which wraps with a key built into Chromium itself. `isEncryptionAvailable()`
 * answers `true` for that one too. So everything that asked only that question called a profile
 * encrypted whose key anyone who can read the folder can unwrap. The same pretence
 * `local-data-protection.ts` refuses to invent, handed to it by the platform.
 *
 *   - `os` — a key store that holds its secret somewhere this folder does not: Keychain, DPAPI, a
 *     Linux keyring.
 *   - `weak` — a key store that answers but protects nothing. Linux's `basic_text`, and any backend
 *     this build cannot vouch for.
 *   - `none` — no key store at all.
 *
 * ## Why the answer is not written down
 *
 * This is a fact about the run, not about the files. `passwords.key` keeps its `keystore` flag as
 * "a key store wrapped this", which stays true, and every existing file opens as before. Re-wrapping a
 * key when the answer changes is deliberately not done: a profile that later starts without its keyring
 * would then be locked out of a key it could read yesterday. The pages read this value instead.
 */
export type KeystoreStrength = 'os' | 'weak' | 'none'

/**
 * Linux backends that keep their secret in a keyring the user unlocks, rather than in the binary.
 *
 * An allowlist, so a name this build has never seen counts as weak. A later Chromium may add a
 * backend, and a page about credentials must not round its guarantee up on a name nobody here has
 * checked. `unknown`, which Electron answers before `ready`, lands on the same side: after `ready` it
 * names nothing at all.
 */
const LINUX_KEYRING_BACKENDS: ReadonlySet<string> = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6'
])

/**
 * Classifies `safeStorage` for this run. Call it after `ready`, which is when Linux has chosen.
 *
 * The backend is asked on Linux only. Elsewhere there is nothing to choose between and the method is
 * documented as Linux-only, so its answer there would be a guess about a question that does not exist.
 */
export function classifyKeystore(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform
): KeystoreStrength {
  if (!safeStorage.isEncryptionAvailable()) return 'none'
  if (platform !== 'linux') return 'os'
  // A key store that cannot name its backend is one this build cannot vouch for either.
  const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
  return LINUX_KEYRING_BACKENDS.has(backend) ? 'os' : 'weak'
}
