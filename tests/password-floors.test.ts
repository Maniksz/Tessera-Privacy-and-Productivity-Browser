import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SafeStorageLike } from '@main/crypto/local-data-key.js'
import { newVaultKey, wrapVaultKey, writeVaultKeyFile } from '@main/crypto/vault-key.js'
import { PasswordVault } from '@main/passwords/PasswordVault.js'
import { decideFill } from '@shared/passwords/fill-policy.js'
import {
  saveCredential,
  updateCredential,
  type PasswordCredential
} from '@shared/passwords/model.js'
import { RESET_VAULT_CONFIRMATION } from '@shared/passwords/vault.js'
import { asFillAnswer, asFillOffer, asFormDescriptor } from '@shared/passwords/wire.js'

/**
 * The branches the password floors in `vitest.config.ts` demanded and no other suite reached.
 *
 * Collected here rather than spread over the files they belong to because each is the *other* arm
 * of a rule those files already test — the refusal next to the acceptance, the rethrow next to the
 * translated error — and every one of them is a way the vault or the autofill could quietly go
 * wrong: a key store that fails in a way nobody translated, an entry whose stored origin no longer
 * parses, a renderer that sends a field as `null`. Each test says which of those it is.
 */

const T0 = 1_700_000_000_000
const SITE = 'https://example.com/login'
const SECRET = 'the-stored-password'
const MASTER = 'a-master-password'
/** See `tests/password-vault.test.ts`: the file records its cost, so a test can afford to derive. */
const CHEAP_KDF = { n: 1024, r: 8, p: 1 } as const

// --- the vault -------------------------------------------------------------------------------------

interface BrokenKeystore extends SafeStorageLike {
  /**
   * Flipped mid-test. `broken` makes `isEncryptionAvailable` *throw*, which is not "unavailable": it
   * is the platform binding failing in a way no rule in `vault-key.ts` translates.
   */
  readonly state: { broken: boolean }
}

function keystore(): BrokenKeystore {
  const state = { broken: false }
  return {
    state,
    isEncryptionAvailable: () => {
      if (state.broken) throw new TypeError('the key store binding went away')
      return true
    },
    encryptString: (plainText: string) => Buffer.from(`ks:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').slice('ks:'.length)
  }
}

async function profile(): Promise<{ keyFilePath: string; documentPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-vault-floors-'))
  return { keyFilePath: join(dir, 'passwords.key'), documentPath: join(dir, 'passwords.json') }
}

/**
 * A vault on the options the application passes, bar the idle timer.
 *
 * No `debounceMs`, `now` or `generateId`: those are the production defaults, and the one suite that
 * otherwise never runs them is this one. `idleSweepMs: 0` starts no timer, so no test leaves one.
 */
async function open(
  where: { keyFilePath: string; documentPath: string },
  safeStorage: SafeStorageLike
): Promise<PasswordVault> {
  return PasswordVault.open({ ...where, safeStorage, previousCodec: null, idleSweepMs: 0 })
}

async function seedMasterProtected(
  where: { keyFilePath: string },
  safeStorage: SafeStorageLike
): Promise<void> {
  const file = await wrapVaultKey({
    key: newVaultKey(),
    safeStorage,
    masterPassword: MASTER,
    cost: CHEAP_KDF
  })
  await writeVaultKeyFile(where.keyFilePath, file)
}

describe('a key store that fails in a way nobody translated', () => {
  /*
    `WrongMasterPasswordError` and `VaultKeyUnreadableError` are answers — "locked", "wrong", "false" —
    and each call site turns them into one. Anything else is not about the vault at all, and flattening
    it into "wrong password" would send the user retyping a correct password against a broken binding.
    So each of the four sites lets it out, and each is asserted here, because a catch-all that swallowed
    it would look exactly like the vault working.
  */

  it('lets it out of opening the vault at startup', async () => {
    const where = await profile()
    const safeStorage = keystore()
    // A first run writes a key file wrapped by the key store, which the second start has to ask.
    await open(where, safeStorage)
    safeStorage.state.broken = true

    await expect(open(where, safeStorage)).rejects.toThrow('the key store binding went away')
  })

  it('lets it out of an unlock', async () => {
    const where = await profile()
    const safeStorage = keystore()
    await seedMasterProtected(where, safeStorage)
    const vault = await open(where, safeStorage)
    safeStorage.state.broken = true

    await expect(vault.unlock(MASTER)).rejects.toThrow('the key store binding went away')
    expect(vault.isUnlocked()).toBe(false)
  })

  it('lets it out of checking the current master password', async () => {
    const where = await profile()
    const safeStorage = keystore()
    await seedMasterProtected(where, safeStorage)
    const vault = await open(where, safeStorage)
    safeStorage.state.broken = true

    await expect(vault.verifyMasterPassword(MASTER)).rejects.toThrow(
      'the key store binding went away'
    )
  })

  it('lets it out of changing the master password, and leaves the vault open', async () => {
    const where = await profile()
    const safeStorage = keystore()
    await seedMasterProtected(where, safeStorage)
    const vault = await open(where, safeStorage)
    expect(await vault.unlock(MASTER)).toBe('unlocked')
    safeStorage.state.broken = true

    await expect(vault.setMasterPassword({ current: MASTER, next: null })).rejects.toThrow(
      'the key store binding went away'
    )
    expect(vault.isUnlocked()).toBe(true)
  })
})

describe('the vault on its production defaults', () => {
  it('keeps what was saved with no debounce named, once it is locked', async () => {
    // The application passes no `debounceMs`; every other suite does. Locking flushes, so what was
    // saved must be there when the same profile is opened again.
    const where = await profile()
    const safeStorage = keystore()
    const vault = await open(where, safeStorage)
    expect(vault.writerFor('normal').save({ url: SITE, username: 'alice', password: SECRET })).toBe(
      'created'
    )
    await vault.lock()

    const reopened = await open(where, safeStorage)
    expect(reopened.list().map((summary) => summary.username)).toEqual(['alice'])
  })

  it('resets a vault that is locked behind a master password, with no key to drop', async () => {
    // The forgotten-password case: nothing is unlocked, so there is no key in memory to zero, and the
    // reset must still end in an open, empty vault rather than trip over the missing key.
    const where = await profile()
    const safeStorage = keystore()
    await seedMasterProtected(where, safeStorage)
    const vault = await open(where, safeStorage)
    expect(vault.isUnlocked()).toBe(false)

    expect(await vault.resetVault(RESET_VAULT_CONFIRMATION)).toBe(true)
    expect(vault.isUnlocked()).toBe(true)
    expect(vault.list()).toEqual([])
  })
})

// --- the fill rules ----------------------------------------------------------------------------------

describe('a stored origin that no longer parses', () => {
  it('is refused as an unsupported scheme, not filled and not blamed on the page', () => {
    // `repairPasswords` keeps an entry it cannot read rather than deleting a credential, so the fill
    // rule is where it has to stop — and "different site" would send whoever reads it looking for a
    // page that does not exist.
    const decision = decideFill(
      {
        frameUrl: 'https://accounts.example.com/login',
        topLevelUrl: 'https://accounts.example.com/login',
        isTopLevelFrame: true,
        formAction: '/session',
        lastGestureAt: T0 - 100,
        now: T0,
        hasFillablePasswordField: true
      },
      { origin: 'not an origin at all' }
    )

    expect(decision).toEqual({ allowed: false, reason: 'unsupported-scheme' })
  })
})

// --- the model ---------------------------------------------------------------------------------------

function credential(overrides: Partial<PasswordCredential> & { id: string }): PasswordCredential {
  return {
    origin: 'https://example.com',
    username: 'alice',
    password: 'secret',
    createdAt: T0,
    updatedAt: T0,
    lastUsedAt: null,
    ...overrides
  }
}

describe('changing one entry among several', () => {
  it('updates the account that signed in again and leaves every other entry as it was', () => {
    const other = credential({ id: 'b', origin: 'https://other.example', username: 'bob' })
    const result = saveCredential(
      [credential({ id: 'a' }), other],
      { url: SITE, username: 'alice', password: 'rotated' },
      { now: T0 + 5, newId: () => 'never-used' }
    )

    expect(result.outcome).toBe('updated')
    expect(result.credentials.find((entry) => entry.id === 'a')?.password).toBe('rotated')
    expect(result.credentials.find((entry) => entry.id === 'b')).toBe(other)
  })

  it('edits only the password when only the password is given, keeping the username', () => {
    const [edited] = updateCredential(
      [credential({ id: 'a', username: 'Alice' })],
      'a',
      { password: 'rotated' },
      { now: T0 + 5 }
    )

    expect(edited).toMatchObject({ username: 'Alice', password: 'rotated', updatedAt: T0 + 5 })
  })
})

// --- the wire ----------------------------------------------------------------------------------------

const FIELD = {
  type: 'password',
  name: 'pw',
  id: 'pw',
  autocomplete: 'current-password',
  visible: true,
  editable: true,
  hasValue: false
}
const CHROME = { styles: '', title: 'Sign in to example.com', noUsernameLabel: 'No username' }

describe('a renderer that sends something other than the shape', () => {
  it('drops a form report in which one control is not an object', () => {
    // One malformed control invalidates the whole report: the roles are derived from the shape, and
    // a form with a hole in it is a form whose shape the core would be guessing at.
    expect(asFormDescriptor({ action: null, fields: [FIELD] })).not.toBeNull()
    expect(asFormDescriptor({ action: null, fields: [FIELD, null] })).toBeNull()
  })

  it('drops a fill offer whose chrome is missing a word, or whose entry is not an object', () => {
    const entries = [{ id: 'pw-1', username: 'alice' }]
    expect(asFillOffer({ chrome: CHROME, entries })).toEqual({ chrome: CHROME, entries })
    expect(asFillOffer({ chrome: { ...CHROME, styles: 1 }, entries })).toBeNull()
    expect(asFillOffer({ chrome: { ...CHROME, title: null }, entries })).toBeNull()
    expect(asFillOffer({ chrome: { ...CHROME, noUsernameLabel: undefined }, entries })).toBeNull()
    expect(asFillOffer({ chrome: CHROME, entries: ['pw-1'] })).toBeNull()
  })

  it('drops a fill answer that is not an object, or whose username or password is not text', () => {
    expect(asFillAnswer({ username: 'alice', password: SECRET })).toEqual({
      username: 'alice',
      password: SECRET
    })
    expect(asFillAnswer(SECRET)).toBeNull()
    expect(asFillAnswer(null)).toBeNull()
    expect(asFillAnswer({ username: null, password: SECRET })).toBeNull()
    expect(asFillAnswer({ username: 'alice', password: 42 })).toBeNull()
  })
})
