import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isSealedDocument } from '@main/crypto/envelope.js'
import type { SafeStorageLike } from '@main/crypto/local-data-key.js'
import {
  VAULT_SCRYPT_COST,
  newVaultKey,
  readVaultKeyFile,
  wrapVaultKey,
  writeVaultKeyFile
} from '@main/crypto/vault-key.js'
import { createEncryptedDocumentCodec } from '@main/data/encrypted-codec.js'
import {
  UnreadableDocumentError,
  plainJsonDocumentCodec,
  type DocumentCodec
} from '@main/data/JsonStore.js'
import { PasswordVault } from '@main/passwords/PasswordVault.js'
import { createVaultDocumentCodec } from '@main/passwords/vault-codec.js'
import { discardingPasswordWriter, type PasswordDocument } from '@shared/passwords/model.js'
import {
  RESET_VAULT_CONFIRMATION,
  VAULT_IDLE_SWEEP_MS,
  VAULT_IDLE_TIMEOUT_MS
} from '@shared/passwords/vault.js'

/**
 * The lock around the password vault: when the key is held, when it is dropped, and what the vault
 * answers while it is gone.
 *
 * Each group below names the damage it is here to prevent, because none of these is a matter of taste:
 *
 *   - **A locked vault answers `[]`, `null`, `'none'` and `discardingPasswordWriter` because there is
 *     no store, not because a filter said so.** A reintroduced "filtered view of a sealed document"
 *     would be a locked vault that still reads out of one — which is the whole of the feature.
 *   - **Turning the master password on rewrites `passwords.key` and nothing else.** If that were false,
 *     switching it on would re-encrypt every credential and could fail halfway, so the operation the
 *     user performs to protect their vault would be the operation that loses it.
 *   - **`lock()` flushes before it zeroes the key.** The other order seals the pending document under
 *     thirty-two zero bytes, and the next unlock finds a vault no password can open.
 *   - **A read does not extend the idle lease.** `list()` is called on every focus of a password field
 *     and a page can cause a focus whenever it likes, so a read that counted would let any site hold
 *     the vault open for ever with a loop.
 *   - **A damaged key file leaves the browser starting normally with a locked vault, and is never
 *     replaced.** Generating a new key would make every stored credential permanently unreadable while
 *     looking like a clean launch.
 *   - **`resetVault` deletes the document before the key.** Interrupted the other way round it leaves a
 *     sealed document with no key: an error at every start, for ever, with no way out except the
 *     operation that just failed.
 *
 * Nothing mocks Electron or the filesystem. `safeStorage` enters as an injected interface, so the fake
 * key store below can misbehave the way a real one does — refuse another machine's data, disappear
 * mid-session — while the code under test is the production code.
 */

const T0 = 1_700_000_000_000
const SITE = 'https://example.com/login'
const SECRET = 'the-stored-password'
const MASTER = 'a-master-password'
const NEXT_MASTER = 'another-master-word'

/**
 * scrypt at a cost a test can afford, written *into the seeded key file*.
 *
 * `openVaultKey` derives with the parameters the file records, so a vault opening a file seeded like
 * this runs its own real code path — only cheaply. The seam is `wrapVaultKey`'s `cost` argument, which
 * exists for exactly this and which nothing in the application can reach: `PasswordVault` has no such
 * parameter to forward. So the tests that go through `setMasterPassword` pay the real half-second per
 * derivation, and they are deliberately few — one of them asserts that the cost really is the
 * specified one.
 */
const CHEAP_KDF = { n: 1024, r: 8, p: 1 } as const

interface Profile {
  readonly dir: string
  readonly keyFilePath: string
  readonly documentPath: string
}

async function profile(): Promise<Profile> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-vault-'))
  return { dir, keyFilePath: join(dir, 'passwords.key'), documentPath: join(dir, 'passwords.json') }
}

/** Somewhere for `copyTo` to write, which must not be the profile it is copying out of. */
async function keepDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tessera-vault-keep-'))
}

interface FakeKeystore extends SafeStorageLike {
  /** Flipped mid-test: a keyring really can go away while the browser is running. */
  readonly state: { available: boolean }
}

/**
 * A key store that behaves like the platform ones in the way that matters.
 *
 * `brand` stands for "which machine's keychain": ciphertext from one brand cannot be read by another,
 * which is what a copied profile or a reinstalled operating system produces.
 */
function fakeKeystore(options: { brand?: string } = {}): FakeKeystore {
  const brand = Buffer.from(options.brand ?? 'keychain-a', 'utf8')
  const state = { available: true }
  return {
    state,
    isEncryptionAvailable: () => state.available,
    encryptString: (plainText: string) => Buffer.concat([brand, Buffer.from(plainText, 'utf8')]),
    decryptString: (encrypted: Buffer) => {
      if (!brand.equals(encrypted.subarray(0, brand.length))) {
        throw new Error('this data was not encrypted by this key store')
      }
      return encrypted.subarray(brand.length).toString('utf8')
    }
  }
}

interface Clock {
  readonly now: () => number
  readonly set: (at: number) => void
}

function clockAt(start: number): Clock {
  let current = start
  return {
    now: () => current,
    set: (at: number) => {
      current = at
    }
  }
}

/**
 * Yields until a lock that a sweep started has finished.
 *
 * `sweepIdle` deliberately does not await `lock()` — a timer callback has nobody to await it — so the
 * flush it performs and the listeners it notifies land after the call returns. Waiting on the
 * notification rather than on a duration keeps this out of the wall clock: if the lock never completes
 * the test times out and says so, which is the honest failure.
 */
async function whenNotified(notifications: readonly unknown[]): Promise<void> {
  while (notifications.length === 0) {
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        resolve()
      })
    })
  }
}

interface OpenOptions {
  readonly profile?: Profile
  readonly safeStorage?: SafeStorageLike
  readonly previousCodec?: DocumentCodec | null
  readonly now?: () => number
  readonly idleTimeoutMs?: number
  readonly debounceMs?: number
}

interface Fixture extends Profile {
  readonly vault: PasswordVault
}

/**
 * A vault over a real temporary directory, with no idle timer of its own.
 *
 * `idleSweepMs: 0` starts no timer, so nothing here leaves a handle behind and the idle path is driven
 * by `sweepIdle()` against an injected clock instead of by waiting. The identifiers restart at `pw-1`
 * for every vault, so a test can name the credential it just created.
 */
async function openVault(options: OpenOptions = {}): Promise<Fixture> {
  const where = options.profile ?? (await profile())
  let created = 0
  const vault = await PasswordVault.open({
    keyFilePath: where.keyFilePath,
    documentPath: where.documentPath,
    safeStorage: options.safeStorage ?? fakeKeystore(),
    previousCodec: options.previousCodec ?? null,
    // Absent rather than `undefined` where a test wants the production default; see the two tests
    // that assert `status().idleTimeoutMs` and the credential's own timestamps.
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    idleSweepMs: 0,
    generateId: () => {
      created += 1
      return `pw-${created}`
    },
    // No coalescing by default: the assertions read the file straight after a write.
    debounceMs: options.debounceMs ?? 0
  })
  return { ...where, vault }
}

/** A profile whose key file is already behind a master password. See `CHEAP_KDF`. */
async function seedMasterProtected(options: {
  readonly profile: Profile
  readonly safeStorage: SafeStorageLike
  readonly masterPassword: string
}): Promise<void> {
  const file = await wrapVaultKey({
    key: newVaultKey(),
    safeStorage: options.safeStorage,
    masterPassword: options.masterPassword,
    cost: CHEAP_KDF
  })
  await writeVaultKeyFile(options.profile.keyFilePath, file)
}

/** What a vault written by an earlier build holds, for the migration and the recovery tests. */
function seededDocument(): PasswordDocument {
  return {
    version: 1,
    credentials: [
      {
        id: 'pw-seeded',
        origin: 'https://example.com',
        username: 'alice',
        password: SECRET,
        createdAt: T0,
        updatedAt: T0,
        lastUsedAt: null
      }
    ],
    neverSaved: []
  }
}

async function writeDocument(
  path: string,
  codec: DocumentCodec,
  document: PasswordDocument
): Promise<void> {
  await writeFile(path, await codec.encode(document))
}

describe('a vault on a fresh profile', () => {
  it('makes a key of its own on first run and opens the document with it', async () => {
    const before = Date.now()
    const { vault, keyFilePath, documentPath } = await openVault()

    expect(vault.status()).toEqual({
      protection: 'keystore',
      unlocked: true,
      unreadable: false,
      // Not a setting: a value whose only effect is to weaken the one bound the lock provides.
      idleTimeoutMs: VAULT_IDLE_TIMEOUT_MS
    })
    // No master password on first run, because there is nobody to ask at startup and a browser that
    // demanded one before it would run is one people turn off.
    expect((await readVaultKeyFile(keyFilePath))?.kdf).toBeNull()

    expect(vault.create({ url: SITE, username: 'alice', password: SECRET })).toBe('created')
    await vault.flush()

    // Through the vault's own codec, so the credential is not sitting in the profile directory in
    // readable form beside the key that protects it.
    const bytes = await readFile(documentPath)
    expect(isSealedDocument(bytes)).toBe(true)
    expect(bytes.includes(Buffer.from(SECRET))).toBe(false)

    // No clock was injected, so this is the real one — the only place `Date.now()` is the subject.
    const [entry] = vault.list()
    expect(entry?.createdAt).toBeGreaterThanOrEqual(before)
    expect(entry?.createdAt).toBeLessThanOrEqual(Date.now())
  })

  it('offers no master password to verify and none to remove', async () => {
    const { vault } = await openVault()

    // `false` rather than "there is none". The channel answers one word, and telling the two apart
    // would hand a caller a way to ask whether this profile has a master password at all.
    expect(await vault.verifyMasterPassword(MASTER)).toBe(false)
    expect(await vault.setMasterPassword({ current: null, next: null })).toBe('not-protected')
    // Refused by the length floor before any derivation is paid for.
    expect(await vault.setMasterPassword({ current: null, next: 'short' })).toBe('rejected')
    expect(vault.status().protection).toBe('keystore')
  })

  it('records, edits, removes and forgets while it is open', async () => {
    const { vault } = await openVault()
    const seen: number[] = []
    vault.onChange((summaries) => seen.push(summaries.length))

    const writer = vault.writerFor('normal')
    expect(writer).not.toBe(discardingPasswordWriter)
    expect(writer.save({ url: SITE, username: 'alice', password: SECRET })).toBe('created')
    expect(vault.count()).toBe(1)
    expect(vault.compareStored(SITE, 'alice', SECRET)).toBe('same-password')
    expect(vault.compareStored(SITE, 'alice', 'not-the-stored-one')).toBe('different-password')
    expect(vault.secretOf('pw-1')).toBe(SECRET)

    vault.update('pw-1', { username: 'alice@example.com' })
    expect(vault.summaryOf('pw-1')?.username).toBe('alice@example.com')

    writer.neverSaveFor('https://never.example/signin')
    expect(vault.neverSavedOrigins()).toEqual(['https://never.example'])
    vault.forgetNeverSaved('https://never.example/signin')
    expect(vault.neverSavedOrigins()).toEqual([])

    expect(vault.remove('pw-1')).toBe(true)
    // False the second time, so a caller can report what happened rather than what it asked for.
    expect(vault.remove('pw-1')).toBe(false)

    // Six changes, in order. The last is the removal of an id that has gone: the document is
    // rewritten unchanged, which is why there are two zeroes rather than one.
    expect(seen).toEqual([1, 1, 1, 1, 0, 0])
  })

  it('imports an export the user chose without letting it overwrite a stored password', async () => {
    const { vault } = await openVault()
    expect(vault.create({ url: SITE, username: 'alice', password: SECRET })).toBe('created')

    const result = vault.importChromeCsv(
      [
        'name,url,username,password,note',
        'Example,https://example.com/login,alice,a-stale-export,',
        'Other,https://other.example/in,bob,bobs-password,a recovery code',
        'Bad,javascript:alert(1),eve,eves-password,'
      ].join('\n')
    )

    expect(result?.imported).toBe(1)
    // The vault wins. A file found in a downloads folder is usually the older of the two, and the
    // other rule fails silently and totally: the working password replaced by a stale one.
    expect(result?.duplicatesConflicting).toBe(1)
    expect(result?.conflicts).toEqual([{ origin: 'https://example.com', username: 'alice' }])
    // Counted, because a user whose notes held a recovery code needs to hear that it did not come.
    expect(result?.notesDropped).toBe(1)
    expect(result?.refusal).toBeNull()

    expect(vault.secretOf('pw-1')).toBe(SECRET)
    expect(vault.count()).toBe(2)
  })
})

describe('a locked vault', () => {
  it('has no store at all, so every answer is the empty one', async () => {
    const { vault, ...where } = await openVault()
    expect(vault.create({ url: SITE, username: 'alice', password: SECRET })).toBe('created')
    vault.writerFor('normal').neverSaveFor('https://never.example/signin')
    await vault.flush()

    await vault.lock()

    expect(vault.isUnlocked()).toBe(false)
    expect(vault.status()).toEqual({
      protection: 'keystore',
      unlocked: false,
      unreadable: false,
      idleTimeoutMs: VAULT_IDLE_TIMEOUT_MS
    })

    // Each of these is a fact about the state rather than a policy applied to it: there is no store
    // to read from, so there is nothing to accidentally read from.
    expect(vault.list()).toEqual([])
    expect(vault.neverSavedOrigins()).toEqual([])
    expect(vault.count()).toBe(0)
    expect(vault.secretOf('pw-1')).toBeNull()
    expect(vault.summaryOf('pw-1')).toBeNull()
    expect(vault.compareStored(SITE, 'alice', SECRET)).toBe('none')
    expect(vault.create({ url: SITE, username: 'bob', password: 'another' })).toBe('rejected')
    expect(vault.remove('pw-1')).toBe(false)
    // An object with no reference to any store cannot leak into one.
    expect(vault.writerFor('normal')).toBe(discardingPasswordWriter)
    expect(
      vault.importChromeCsv('name,url,username,password,note\nX,https://x.example/,x,y,')
    ).toBeNull()

    // Subscribing is legal and yields nothing; the caller learns the state from `status()`.
    const seen: number[] = []
    const unsubscribe = vault.onChange((summaries) => seen.push(summaries.length))
    vault.update('pw-1', { username: 'mallory' })
    vault.forgetNeverSaved('https://never.example/signin')
    await vault.flush()
    expect(seen).toEqual([])
    unsubscribe()

    /*
      And the document is still on disk with everything in it. Without this the whole test would pass
      against a vault that had thrown its contents away on locking, which is the one failure that
      would look identical from the inside and be unrecoverable from the outside.
    */
    const { vault: reopened } = await openVault({ profile: where })
    expect(reopened.list().map((entry) => entry.origin)).toEqual(['https://example.com'])
    expect(reopened.neverSavedOrigins()).toEqual(['https://never.example'])
    expect(reopened.secretOf('pw-1')).toBe(SECRET)
  })

  it('reopens without asking anybody when there is no master password', async () => {
    const { vault } = await openVault()
    await vault.lock()

    // The candidate is irrelevant: there is no master password, so there is nothing it could be
    // wrong about, and the outcome says so instead of pretending a check happened.
    expect(await vault.unlock('anything at all')).toBe('not-protected')
    expect(vault.isUnlocked()).toBe(true)
    // Asked again while already open, which is what a second window's prompt would do.
    expect(await vault.unlock('anything at all')).toBe('not-protected')
  })

  it('runs every lock listener even when one throws, and finishes the lock', async () => {
    /*
      The listener that exists for this is autofill's: it drops a credential held in memory while the
      save bar is up. A throw from an earlier listener that skipped it would leave a "locked" vault
      with a password still in the process, which is the opposite of what the word means.
    */
    const { vault } = await openVault()
    const ran: string[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vault.onLock(() => {
        ran.push('first')
        throw new Error('a lock listener with a bug in it')
      })
      const unsubscribe = vault.onLock(() => ran.push('second'))

      await vault.lock()

      expect(ran).toEqual(['first', 'second'])
      expect(vault.isUnlocked()).toBe(false)
      expect(errors).toHaveBeenCalled()

      unsubscribe()
      ran.length = 0
      // Locking an already-locked vault is legal, and still tells whoever is subscribed.
      await vault.lock()
      expect(ran).toEqual(['first'])
    } finally {
      errors.mockRestore()
    }
  })
})

describe('the master password', () => {
  it('is set, changed and removed without one byte of the document moving', async () => {
    /*
      The whole reason the vault has a key of its own. Turning the master password on re-wraps
      `passwords.key` and re-encrypts nothing, so it cannot fail halfway and cannot lose a credential
      — and this is the test the source says pins it.
    */
    const { vault, keyFilePath, documentPath } = await openVault()
    expect(vault.create({ url: SITE, username: 'alice', password: SECRET })).toBe('created')
    await vault.flush()
    const sealed = await readFile(documentPath)

    expect(await vault.setMasterPassword({ current: null, next: MASTER })).toBe('set')
    expect(vault.status().protection).toBe('keystore+master')
    // Setting one is a change to the key file, not a lock.
    expect(vault.isUnlocked()).toBe(true)
    expect(await vault.unlock('never looked at')).toBe('unlocked')
    expect((await readFile(documentPath)).equals(sealed), 'the document was rewritten').toBe(true)

    // The specified cost, because `PasswordVault` has no parameter that could lower it and nothing
    // in the application reaches the one `wrapVaultKey` offers a test.
    expect((await readVaultKeyFile(keyFilePath))?.kdf).toMatchObject({
      algorithm: 'scrypt',
      ...VAULT_SCRYPT_COST
    })

    expect(await vault.setMasterPassword({ current: MASTER, next: NEXT_MASTER })).toBe('changed')
    expect((await readFile(documentPath)).equals(sealed)).toBe(true)

    expect(await vault.setMasterPassword({ current: NEXT_MASTER, next: null })).toBe('removed')
    expect(vault.status().protection).toBe('keystore')
    expect((await readFile(documentPath)).equals(sealed)).toBe(true)

    // "Not touched" has to mean the credential still opens, not merely that the bytes match.
    expect(vault.secretOf('pw-1')).toBe(SECRET)
  })

  it('refuses a change it cannot prove the current password for, and leaves the key file alone', async () => {
    const where = await profile()
    const safeStorage = fakeKeystore()
    await seedMasterProtected({ profile: where, safeStorage, masterPassword: MASTER })
    const { vault } = await openVault({ profile: where, safeStorage })
    expect(await vault.unlock(MASTER)).toBe('unlocked')
    const before = await readFile(where.keyFilePath)

    // `current: null` is only accepted when there is none, so this is a wrong answer and not a
    // missing one — splitting the three transitions apart is how that check gets forgotten.
    expect(await vault.setMasterPassword({ current: null, next: NEXT_MASTER })).toBe(
      'wrong-password'
    )
    expect(await vault.setMasterPassword({ current: 'not-the-master', next: NEXT_MASTER })).toBe(
      'wrong-password'
    )

    // A key store that has gone is not a wrong password: the user's word is still right and no
    // amount of retyping will help, so the answer points at the lock rather than at them.
    safeStorage.state.available = false
    expect(await vault.setMasterPassword({ current: MASTER, next: NEXT_MASTER })).toBe('locked')
    safeStorage.state.available = true

    await vault.lock()
    expect(await vault.setMasterPassword({ current: MASTER, next: NEXT_MASTER })).toBe('locked')
    expect((await readFile(where.keyFilePath)).equals(before)).toBe(true)
  })

  it('verifies a candidate by opening the key file with it, and changes nothing either way', async () => {
    const where = await profile()
    const safeStorage = fakeKeystore()
    await seedMasterProtected({ profile: where, safeStorage, masterPassword: MASTER })
    const { vault } = await openVault({ profile: where, safeStorage })

    expect(await vault.verifyMasterPassword(MASTER)).toBe(true)
    // The proof is dropped rather than used, so there is never a second live copy of the vault key
    // in the process — and an early refusal is never a substitute for the real check.
    expect(vault.isUnlocked()).toBe(false)
    expect(await vault.verifyMasterPassword('not-the-master')).toBe(false)

    // `false` for a key file that cannot be opened at all, too. Distinguishing "wrong" from
    // "damaged" here would only give a caller a way to ask which, on a channel answering one word.
    const { vault: elsewhere } = await openVault({
      profile: where,
      safeStorage: fakeKeystore({ brand: 'another-machine' })
    })
    expect(await elsewhere.verifyMasterPassword(MASTER)).toBe(false)
  })

  it('unlocks a profile whose key is behind a master password, and refuses a wrong word', async () => {
    const where = await profile()
    const safeStorage = fakeKeystore()
    await seedMasterProtected({ profile: where, safeStorage, masterPassword: MASTER })
    const { vault } = await openVault({ profile: where, safeStorage })

    // A master password means locked, full stop: nothing at startup tries to open it, because the
    // only thing that could is the user.
    expect(vault.status()).toEqual({
      protection: 'keystore+master',
      unlocked: false,
      unreadable: false,
      idleTimeoutMs: VAULT_IDLE_TIMEOUT_MS
    })

    expect(await vault.unlock('not-the-master')).toBe('wrong-password')
    expect(vault.isUnlocked()).toBe(false)
    // A wrong attempt is not damage: it is told apart from `unreadable`, so the next right one works.
    expect(await vault.unlock(MASTER)).toBe('unlocked')
    expect(vault.status().unlocked).toBe(true)
  })

  it('flushes the document before it drops the key, so a pending write is not sealed under zeroes', async () => {
    /*
      The order in `lock` is: store reference first, flush second, key last. Zeroing before the flush
      would encrypt the vault under thirty-two zero bytes and lose it, and the symptom would be a
      vault that unlocked yesterday and cannot be opened today. A debounced write is left in flight on
      purpose, so the flush has something to do.
    */
    const where = await profile()
    const safeStorage = fakeKeystore()
    await seedMasterProtected({ profile: where, safeStorage, masterPassword: MASTER })
    const { vault } = await openVault({ profile: where, safeStorage, debounceMs: 60_000 })
    expect(await vault.unlock(MASTER)).toBe('unlocked')
    expect(vault.create({ url: SITE, username: 'alice', password: SECRET })).toBe('created')
    // Nothing on disk yet, so the write inside `lock` is the one that puts it there.
    await expect(readFile(where.documentPath)).rejects.toThrow(/ENOENT/)

    await vault.lock()

    expect(isSealedDocument(await readFile(where.documentPath))).toBe(true)
    expect(await vault.unlock(MASTER)).toBe('unlocked')
    expect(vault.secretOf('pw-1')).toBe(SECRET)
  })
})

describe('the idle lock', () => {
  it('never closes a vault that has no master password, however long nobody touches it', async () => {
    // There is nothing to lock it back to — reopening asks nobody for anything — so a timer that
    // closed it would cost the user their autofill for as long as the reopen took and buy nothing.
    const clock = clockAt(T0)
    const { vault } = await openVault({ now: clock.now, idleTimeoutMs: 60_000 })

    clock.set(T0 + 365 * 24 * 3_600_000)
    vault.sweepIdle()

    expect(vault.isUnlocked()).toBe(true)
  })

  it('counts a secret handed out as use and a listing as none', async () => {
    /*
      The security property. `list()` is called by autofill on every focus of a password field, and a
      page can cause a focus whenever it likes — so if a read extended the lease, a loop on any site
      would hold the vault open indefinitely and the timeout would be a promise the browser cannot
      keep on a page it does not control.
    */
    const where = await profile()
    const safeStorage = fakeKeystore()
    await seedMasterProtected({ profile: where, safeStorage, masterPassword: MASTER })
    const clock = clockAt(T0)
    const { vault } = await openVault({
      profile: where,
      safeStorage,
      now: clock.now,
      idleTimeoutMs: 60_000
    })
    const locks: number[] = []
    vault.onLock(() => locks.push(clock.now()))

    expect(await vault.unlock(MASTER)).toBe('unlocked')
    expect(vault.create({ url: SITE, username: 'alice', password: SECRET })).toBe('created')

    // A secret actually handed out. Autofill reaches this only after the core itself saw a real input
    // event, so it is the user doing something.
    clock.set(T0 + 30_000)
    expect(vault.secretOf('pw-1')).toBe(SECRET)

    clock.set(T0 + 61_000)
    vault.sweepIdle()
    expect(vault.isUnlocked(), 'the reveal at +30 s did not extend the lease').toBe(true)
    // Neither of these is a user act: a listing, and an id that is not there to reveal.
    expect(vault.list()).toHaveLength(1)
    expect(vault.secretOf('pw-nothing')).toBeNull()

    clock.set(T0 + 91_000)
    vault.sweepIdle()
    await whenNotified(locks)

    expect(vault.isUnlocked()).toBe(false)
    // Measured from the reveal at +30 s, not from the reads at +61 s.
    expect(locks).toEqual([T0 + 91_000])
    // And a sweep of a vault that is already closed does nothing at all.
    vault.sweepIdle()
    expect(locks).toEqual([T0 + 91_000])
  })

  it('runs the check on a timer of its own and gives the handle back on dispose', async () => {
    /*
      A timer rather than a check on the next read, because the promise is that the key *is gone*
      after the timeout — a key still in memory that would be refused if asked is exactly what a crash
      dump or a `/proc/self/mem` read picks up.
    */
    const where = await profile()
    const safeStorage = fakeKeystore()
    await seedMasterProtected({ profile: where, safeStorage, masterPassword: MASTER })
    const clock = clockAt(T0)
    const scheduled = vi.spyOn(globalThis, 'setInterval')
    const stopped = vi.spyOn(globalThis, 'clearInterval')
    try {
      const vault = await PasswordVault.open({
        keyFilePath: where.keyFilePath,
        documentPath: where.documentPath,
        safeStorage,
        previousCodec: null,
        now: clock.now,
        idleTimeoutMs: 60_000,
        debounceMs: 0
      })

      // At the interval `shared/passwords/vault.ts` names, rather than one of its own.
      const [scheduledSweep] = scheduled.mock.calls.filter(
        (call) => call[1] === VAULT_IDLE_SWEEP_MS
      )
      expect(scheduledSweep, 'the vault scheduled no idle sweep').toBeDefined()

      const dropped: string[] = []
      vault.onLock(() => dropped.push('key'))
      expect(await vault.unlock(MASTER)).toBe('unlocked')
      clock.set(T0 + 61_000)
      // The timer's own callback, so what is asserted is the thing the interval will call.
      scheduledSweep?.[0]()
      await whenNotified(dropped)
      expect(vault.isUnlocked()).toBe(false)

      const beforeDispose = stopped.mock.calls.length
      vault.dispose()
      expect(stopped.mock.calls.length - beforeDispose).toBe(1)
      // Idempotent: shutdown can reach it after a test already has.
      vault.dispose()
      expect(stopped.mock.calls.length - beforeDispose).toBe(1)
    } finally {
      scheduled.mockRestore()
      stopped.mockRestore()
    }
  })
})

describe('a vault that cannot be opened', () => {
  it('starts normally and locked when the key file is damaged, and never replaces it', async () => {
    /*
      Generating a replacement key would "fix" the launch and make every stored credential
      permanently unreadable — a factory reset in the costume of a successful start. `unreadable` is
      what the page renders on, and it means "no master password will help" rather than "type it
      again": restoring the keychain entry or the profile backup is a recovery the user can still
      perform, and overwriting the key is not.
    */
    const where = await profile()
    await writeFile(where.keyFilePath, 'this is not a vault key file')
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { vault } = await openVault({ profile: where })

      expect(vault.status()).toEqual({
        // Derived with no readable file at all, so the level is what a new vault would get; the page
        // ignores it and renders on `unreadable`.
        protection: 'keystore',
        unlocked: false,
        unreadable: true,
        idleTimeoutMs: VAULT_IDLE_TIMEOUT_MS
      })
      expect(await readFile(where.keyFilePath, 'utf8')).toBe('this is not a vault key file')
      expect(await vault.unlock(MASTER)).toBe('unreadable')
      expect(await vault.verifyMasterPassword(MASTER)).toBe(false)
      expect(warnings).toHaveBeenCalled()
    } finally {
      warnings.mockRestore()
    }
  })

  it('stays locked when the key store that wrapped the key is gone', async () => {
    const where = await profile()
    const { vault: first } = await openVault({ profile: where })
    expect(first.isUnlocked()).toBe(true)

    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A profile restored on another machine, or an operating system reinstalled under it.
      const { vault } = await openVault({
        profile: where,
        safeStorage: fakeKeystore({ brand: 'another-machine' })
      })

      expect(vault.status()).toEqual({
        // Read off the file, so what the page is told cannot disagree with the bytes.
        protection: 'keystore',
        unlocked: false,
        unreadable: true,
        idleTimeoutMs: VAULT_IDLE_TIMEOUT_MS
      })
      expect(await vault.unlock(MASTER)).toBe('unreadable')
    } finally {
      warnings.mockRestore()
    }
  })

  it('says no password will help when the key store goes away mid-session', async () => {
    /*
      The two wrappings compose rather than alternate, so without the key store the master password
      cannot reach the payload it wraps — and the user's word is still the right one. Reported as
      `unreadable` rather than as a wrong password, because telling somebody to try their password
      again when their keychain has gone sends them looking in the wrong place for ever.
    */
    const where = await profile()
    const safeStorage = fakeKeystore()
    await seedMasterProtected({ profile: where, safeStorage, masterPassword: MASTER })
    const { vault } = await openVault({ profile: where, safeStorage })
    expect(vault.status().unreadable).toBe(false)

    safeStorage.state.available = false

    expect(await vault.unlock(MASTER)).toBe('unreadable')
    // Remembered, so the lock panel stops offering a prompt that cannot work.
    expect(vault.status().unreadable).toBe(true)
  })

  it('stays locked rather than replacing a document its key cannot open', async () => {
    /*
      The one failure `JsonStore` refuses to recover from, and the difference is what the two mean: an
      unparseable file is a document that is gone, and defaults lose nothing. An undecryptable one is a
      document that is still *there* behind a key this process could not get hold of, and starting from
      defaults would replace it on the next write — a recoverable vault made unrecoverable by the
      recovery. `resetVault` is the way out for a user who has genuinely lost the key.
    */
    const where = await profile()
    const safeStorage = fakeKeystore()
    await seedMasterProtected({ profile: where, safeStorage, masterPassword: MASTER })
    // Sealed by a key that is not the one this profile's key file holds.
    await writeDocument(
      where.documentPath,
      createEncryptedDocumentCodec(newVaultKey()),
      seededDocument()
    )
    const bytes = await readFile(where.documentPath)

    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { vault } = await openVault({ profile: where, safeStorage })
      // The key file opens with the right word; it is the document that cannot be read, and the
      // outcome says so rather than reporting a wrong password.
      expect(await vault.unlock(MASTER)).toBe('unreadable')
      expect(vault.status().unreadable).toBe(true)
      expect(vault.isUnlocked()).toBe(false)
    } finally {
      warnings.mockRestore()
    }

    expect((await readFile(where.documentPath)).equals(bytes), 'the vault was overwritten').toBe(
      true
    )
  })

  it('lets a broken profile out instead of reporting a locked vault', async () => {
    // A directory in the way, no permission on the profile: those are not "locked", they are a
    // profile that cannot be used, and carrying on would create a second key over a sealed document.
    const where = await profile()
    await mkdir(where.keyFilePath)
    await expect(openVault({ profile: where })).rejects.toThrow(/EISDIR/)
  })
})

describe('keeping a copy before a reset', () => {
  it('copies the sealed document and its key, and says how many it wrote', async () => {
    /*
      `PasswordApi` refuses to discard anything when this answers zero, so the count is load-bearing
      rather than informational. The document alone is unopenable — the key that seals it lives in
      `passwords.key` — so a copy of one without the other would be worth nothing at all.
    */
    const { vault } = await openVault({ debounceMs: 60_000 })
    expect(vault.create({ url: SITE, username: 'alice', password: SECRET })).toBe('created')
    const keep = await keepDirectory()

    expect(await vault.copyTo(keep)).toBe(2)

    // The only definition of "kept" worth anything: the copy opens. It also shows the flush happened
    // first — the write above was still sitting in a sixty-second debounce timer.
    const { vault: restored } = await openVault({
      profile: {
        dir: keep,
        keyFilePath: join(keep, 'passwords.key'),
        documentPath: join(keep, 'passwords.json')
      }
    })
    expect(restored.secretOf('pw-1')).toBe(SECRET)
  })

  it('counts only the files that are there', async () => {
    const where = await profile()
    const safeStorage = fakeKeystore()
    await seedMasterProtected({ profile: where, safeStorage, masterPassword: MASTER })
    // The state `resetVault` is actually reached from: a vault nobody can open. This one has never
    // been open at all, so it has no document to keep — which is not an error, and the caller must
    // read the count rather than assume two.
    const { vault } = await openVault({ profile: where, safeStorage })
    const keep = await keepDirectory()

    expect(await vault.copyTo(keep)).toBe(1)

    // And the key file can be the thing that went missing in the first place.
    await rm(where.keyFilePath)
    expect(await vault.copyTo(keep)).toBe(0)
  })

  it('lets a failure that is not a missing file out', async () => {
    // No permission and a full disk are the real cases; all of them mean the copy did not happen,
    // and a copy that silently did not happen is the one failure this whole operation exists to
    // prevent.
    const { vault } = await openVault()
    const keep = await keepDirectory()
    await mkdir(join(keep, 'passwords.json'))

    await expect(vault.copyTo(keep)).rejects.toThrow(/EISDIR/)
  })
})

describe('resetting the vault', () => {
  it('refuses a wrong confirmation token and deletes nothing', async () => {
    // So an empty or mistaken invoke cannot destroy a vault.
    const { vault, keyFilePath, documentPath } = await openVault()
    expect(vault.create({ url: SITE, username: 'alice', password: SECRET })).toBe('created')
    await vault.flush()
    const key = await readFile(keyFilePath)
    const document = await readFile(documentPath)

    expect(await vault.resetVault('')).toBe(false)
    expect(await vault.resetVault(`${RESET_VAULT_CONFIRMATION}-please`)).toBe(false)

    expect((await readFile(keyFilePath)).equals(key)).toBe(true)
    expect((await readFile(documentPath)).equals(document)).toBe(true)
    expect(vault.isUnlocked()).toBe(true)
    expect(vault.list()).toHaveLength(1)
  })

  it('destroys the document, its temporary and the key, then opens an empty vault', async () => {
    const { vault, keyFilePath, documentPath } = await openVault()
    expect(vault.create({ url: SITE, username: 'alice', password: SECRET })).toBe('created')
    await vault.flush()
    // What a crash mid-write leaves behind: a file full of credentials that a "delete everything"
    // which ignored it would have left in the profile directory.
    await writeFile(`${documentPath}.tmp`, await readFile(documentPath))
    const keyBefore = await readFile(keyFilePath)

    const ran: string[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vault.onLock(() => {
        throw new Error('a lock listener with a bug in it')
      })
      vault.onLock(() => ran.push('told'))

      expect(await vault.resetVault(RESET_VAULT_CONFIRMATION)).toBe(true)

      // Whoever was holding a credential in memory hears about it, bad listener or not.
      expect(ran).toEqual(['told'])
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }

    await expect(readFile(documentPath)).rejects.toThrow(/ENOENT/)
    await expect(readFile(`${documentPath}.tmp`)).rejects.toThrow(/ENOENT/)
    // A new key, so a surviving copy of the old document stays as unopenable as it was.
    expect((await readFile(keyFilePath)).equals(keyBefore)).toBe(false)

    expect(vault.status()).toEqual({
      protection: 'keystore',
      unlocked: true,
      unreadable: false,
      idleTimeoutMs: VAULT_IDLE_TIMEOUT_MS
    })
    expect(vault.list()).toEqual([])
    // Usable rather than wedged: this is a user starting again, not a user giving up.
    expect(vault.create({ url: SITE, username: 'bob', password: 'a-new-one' })).toBe('created')
  })

  it('leaves the key file alone when the document cannot be deleted', async () => {
    /*
      The document goes first, and the order is the whole argument. Interrupted after the first
      deletion the profile has a key with no document, which the store reads as an empty vault and is
      harmless. The other order leaves a sealed document with no key — `UnreadableDocumentError` at
      every start, for ever, with no way out except the operation that just failed.

      A directory where the document belongs stands in for any deletion that fails, and is the only
      way to observe from outside which of the two files goes first.
    */
    const where = await profile()
    await mkdir(where.documentPath)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { vault } = await openVault({ profile: where })

      await expect(vault.resetVault(RESET_VAULT_CONFIRMATION)).rejects.toThrow(/EISDIR/)

      expect(await readVaultKeyFile(where.keyFilePath), 'the key was deleted first').not.toBeNull()
      // Left closed rather than half-open, and no password will help until the reset can finish.
      expect(vault.status()).toEqual({
        protection: 'keystore',
        unlocked: false,
        unreadable: false,
        idleTimeoutMs: VAULT_IDLE_TIMEOUT_MS
      })
      expect(await vault.unlock(MASTER)).toBe('unreadable')
    } finally {
      warnings.mockRestore()
    }
  })
})

describe('the migration onto the vault’s own key', () => {
  const vaultKey = newVaultKey()
  const localDataKey = newVaultKey()

  it('opens what it sealed and calls its own encoding current', async () => {
    const codec = createVaultDocumentCodec({ vaultKey, previous: null })
    const bytes = await codec.encode(seededDocument())

    expect(codec.decode(bytes)).toEqual(seededDocument())
    expect(codec.isStaleEncoding?.(bytes)).toBe(false)
  })

  it('reads a document the previous key sealed and calls its encoding stale', async () => {
    /*
      Two keys can open the file; one key can produce it. `isStaleEncoding` reports true for anything
      the vault key did not seal, so `JsonStore` rewrites the document during `open` — and the window
      in which the local-data key still works is one startup wide and closes by itself.
    */
    const previous = createEncryptedDocumentCodec(localDataKey)
    const codec = createVaultDocumentCodec({ vaultKey, previous })
    const old = await previous.encode(seededDocument())

    expect(codec.decode(old)).toEqual(seededDocument())
    expect(codec.isStaleEncoding?.(old)).toBe(true)
    // Recomputed rather than remembered from the decode a moment earlier, so the property does not
    // depend on a call order in another file.
    expect(codec.isStaleEncoding?.(await codec.encode(seededDocument()))).toBe(false)
  })

  it('reads a plain document from before any encryption existed', async () => {
    const plain = await plainJsonDocumentCodec.encode(seededDocument())
    const codec = createVaultDocumentCodec({ vaultKey, previous: null })

    expect(codec.decode(plain)).toEqual(seededDocument())
    expect(codec.isStaleEncoding?.(plain)).toBe(true)
  })

  it('refuses a sealed document no key here opens, rather than reading it as an empty vault', async () => {
    // `UnreadableDocumentError` is the one signal `JsonStore` must not turn into defaults: a vault
    // that is still there behind a key this process could not get must not be overwritten.
    const strangers = await createEncryptedDocumentCodec(newVaultKey()).encode(seededDocument())

    expect(() => createVaultDocumentCodec({ vaultKey, previous: null }).decode(strangers)).toThrow(
      UnreadableDocumentError
    )
    // With a previous codec the refusal is that codec's own, and it is the same error for the same
    // reason — whatever the previous one throws is let out rather than swallowed.
    const previous = createEncryptedDocumentCodec(localDataKey)
    expect(() => createVaultDocumentCodec({ vaultKey, previous }).decode(strangers)).toThrow(
      UnreadableDocumentError
    )
  })

  it('moves a vault off the local-data key on one start, and off it for good', async () => {
    const where = await profile()
    const previous = createEncryptedDocumentCodec(localDataKey)
    await writeDocument(where.documentPath, previous, seededDocument())

    const { vault } = await openVault({ profile: where, previousCodec: previous })
    expect(vault.secretOf('pw-seeded')).toBe(SECRET)

    // Rewritten during `open`, awaited, before anything read it — so from here the local-data key
    // cannot open `passwords.json` again, which is what makes the separation real rather than
    // intended: an idle lock, a forgotten master password and a reset now cost the credentials only.
    const rewritten = await readFile(where.documentPath)
    expect(() => previous.decode(rewritten)).toThrow(UnreadableDocumentError)

    // And the next start needs no previous codec at all.
    const { vault: next } = await openVault({ profile: where, previousCodec: null })
    expect(next.secretOf('pw-seeded')).toBe(SECRET)
  })
})
