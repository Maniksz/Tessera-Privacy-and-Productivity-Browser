import type * as NodeCrypto from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOCUMENT_KEY_BYTES, isSealedDocument } from '@main/crypto/envelope.js'
import type { SafeStorageLike } from '@main/crypto/local-data-key.js'
import {
  MasterPasswordRequiredError,
  VAULT_SALT_BYTES,
  VAULT_SCRYPT_COST,
  VaultKeyUnreadableError,
  WrongMasterPasswordError,
  deleteVaultKeyFile,
  newVaultKey,
  openVaultKey,
  readVaultKeyFile,
  vaultKeyProtectionOf,
  wrapVaultKey,
  writeVaultKeyFile,
  type OpenVaultKeyOptions,
  type ScryptCost,
  type VaultKeyFile
} from '@main/crypto/vault-key.js'

/**
 * `passwords.key`: the vault's own key, and what it costs to get any of this wrong.
 *
 * Three things break in the product if the rules below are not held.
 *
 * A file that *either* layer could open on its own is the failure this file exists to catch. The
 * attacker a master password stops — malware running as the logged-in user, a person at an unlocked
 * laptop, a restored profile beside an exported keychain — already has the key store, because every
 * platform key store unwraps for whoever is logged in without asking. So a key store *or* master
 * password file protects nobody while reporting `keystore+master` to the page, and no round-trip test
 * would notice: both arrangements round-trip. The nesting test asserts the composition directly.
 *
 * A damaged file read as an absent one costs the whole vault. `readVaultKeyFile` returns `null` for
 * *first run* and nothing else, because the caller's very next line generates a key — over the
 * document the previous key sealed. Every rejected shape here is therefore a shape that must throw
 * rather than answer `null`, and the one non-ENOENT read failure must travel out untouched.
 *
 * The order of the failures in `openVaultKey` is the user's recovery. "Type your master password",
 * "your keychain is gone", "no password will help this file" and "that password was wrong" are four
 * different actions, and a case where two of them apply at once is the only way to see that the code
 * reports the right one. Several tests below deliberately break two layers and assert which is named.
 *
 * Cost: every wrap here passes `CHEAP`, the override that exists precisely so a suite is not half a
 * second per assertion. One test pins `VAULT_SCRYPT_COST` and one exercises the default end to end,
 * so the parameter that ships is measured exactly once.
 */

/** Low enough to be free, and still a real scrypt call with a real salt. */
const CHEAP: ScryptCost = { n: 16, r: 8, p: 1 }

const MASTER = 'correct-horse-battery-staple'
const NOT_THE_MASTER = 'four-words-but-the-wrong-four'

const createdDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-vault-key-'))
  createdDirs.push(dir)
  return dir
}

async function keyPath(name = 'passwords.key'): Promise<string> {
  return join(await tempDir(), name)
}

afterEach(async () => {
  // Real key material on a real disk. A leftover directory of it is the thing this module is for.
  const dirs = createdDirs.splice(0)
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * A key store that behaves like the platform ones in the ways that matter.
 *
 * `brand` stands for "which machine's keychain": ciphertext from one brand cannot be read by another,
 * which is the failure a copied profile or a reinstalled operating system actually produces. It is
 * used here instead of a store that throws unconditionally, so what the test causes is a situation
 * rather than a stub.
 */
function fakeKeystore(options: { available?: boolean; brand?: string } = {}): SafeStorageLike {
  const available = options.available ?? true
  const brand = Buffer.from(options.brand ?? 'keychain-a', 'utf8')
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.concat([brand, Buffer.from(plainText, 'utf8')]),
    decryptString: (encrypted) => {
      if (!brand.equals(encrypted.subarray(0, brand.length))) {
        throw new Error('this data was not encrypted by this key store')
      }
      return encrypted.subarray(brand.length).toString('utf8')
    }
  }
}

async function wrapCheaply(options: {
  readonly key: Uint8Array
  readonly safeStorage: SafeStorageLike
  readonly masterPassword: string | null
}): Promise<VaultKeyFile> {
  return wrapVaultKey({ ...options, cost: CHEAP })
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** The bytes the file's `payload` field carries, before either layer is removed. */
function payloadBytes(file: VaultKeyFile): Buffer {
  return Buffer.from(file.payload, 'base64')
}

const VALID_SALT = Buffer.alloc(VAULT_SALT_BYTES, 7).toString('base64')

/** A kdf block a reader must accept, so an override can make exactly one field wrong. */
const VALID_KDF = { algorithm: 'scrypt', n: 16, r: 8, p: 1, salt: VALID_SALT }

/** A file a reader must accept, for the same reason. */
const VALID_FILE = { version: 1, keystore: false, kdf: null, payload: 'AAAA' }

describe('the protection a key file describes', () => {
  it('derives all four states from the bytes, so the page cannot be told something else', async () => {
    const key = newVaultKey()
    const both = await wrapCheaply({ key, safeStorage: fakeKeystore(), masterPassword: MASTER })
    const masterOnly = await wrapCheaply({
      key,
      safeStorage: fakeKeystore({ available: false }),
      masterPassword: MASTER
    })
    const keystoreOnly = await wrapCheaply({
      key,
      safeStorage: fakeKeystore(),
      masterPassword: null
    })
    const plain = await wrapCheaply({
      key,
      safeStorage: fakeKeystore({ available: false }),
      masterPassword: null
    })

    expect(vaultKeyProtectionOf(both)).toBe('keystore+master')
    expect(vaultKeyProtectionOf(masterOnly)).toBe('master')
    expect(vaultKeyProtectionOf(keystoreOnly)).toBe('keystore')
    expect(vaultKeyProtectionOf(plain)).toBe('plain')
  })

  it('records the key store that was there at the wrap, not the one that was asked for', async () => {
    // A key store can appear or vanish between launches, so the flag has to be an observation
    // rather than a setting. A file claiming `keystore: true` with an unwrapped payload would be
    // reported to the user as protected and would open for anyone.
    const key = newVaultKey()
    const withoutStore = await wrapCheaply({
      key,
      safeStorage: fakeKeystore({ available: false }),
      masterPassword: null
    })
    expect(withoutStore.keystore).toBe(false)
    expect(hex(payloadBytes(withoutStore))).toBe(hex(key))
  })
})

describe('a fresh vault key', () => {
  it('is as long as the envelope that will seal the document with it', () => {
    expect(newVaultKey()).toHaveLength(DOCUMENT_KEY_BYTES)
  })

  it('is different every time, so two profiles never share one', () => {
    const drawn = new Set<string>()
    for (let attempt = 0; attempt < 32; attempt += 1) drawn.add(hex(newVaultKey()))
    expect(drawn.size).toBe(32)
  })
})

describe('wrapping a vault key', () => {
  it('refuses a key that is not a document key, rather than failing at the next write', async () => {
    // `createCipheriv` would otherwise reject it much later, from inside a flush, with a message
    // that sounds like a disk problem.
    await expect(
      wrapCheaply({ key: Buffer.alloc(16), safeStorage: fakeKeystore(), masterPassword: null })
    ).rejects.toThrow(/must be 32 bytes, got 16/)
  })

  it('leaves none of the key in a file the key store wrapped', async () => {
    const key = newVaultKey()
    const file = await wrapCheaply({ key, safeStorage: fakeKeystore(), masterPassword: null })
    expect(file.keystore).toBe(true)
    expect(file.kdf).toBeNull()
    expect(payloadBytes(file).includes(Buffer.from(key))).toBe(false)
  })

  it('seals the key inside an envelope once a master password is set', async () => {
    // No key store at all here, which is the Linux-without-a-keyring case: the seal is the only
    // thing between the profile directory and the vault, so it has to be an envelope and not the
    // key with a salt written next to it.
    const key = newVaultKey()
    const file = await wrapCheaply({
      key,
      safeStorage: fakeKeystore({ available: false }),
      masterPassword: MASTER
    })
    expect(isSealedDocument(payloadBytes(file))).toBe(true)
    expect(payloadBytes(file).includes(Buffer.from(key))).toBe(false)
    expect(payloadBytes(file).includes(Buffer.from(MASTER, 'utf8'))).toBe(false)
  })

  it('draws a fresh salt for every wrap, so changing the password re-salts', async () => {
    const key = newVaultKey()
    const salts = new Set<string>()
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const file = await wrapCheaply({ key, safeStorage: fakeKeystore(), masterPassword: MASTER })
      expect(Buffer.from(file.kdf?.salt ?? '', 'base64')).toHaveLength(VAULT_SALT_BYTES)
      salts.add(file.kdf?.salt ?? '')
    }
    // A reused salt would let one precomputed table serve every profile, which is the entire job
    // of the salt and the one part of the KDF an attacker gets to see.
    expect(salts.size).toBe(8)
  })

  it('writes down the cost it used, so a later build can still open the file', async () => {
    const file = await wrapCheaply({
      key: newVaultKey(),
      safeStorage: fakeKeystore(),
      masterPassword: MASTER
    })
    expect(file.kdf?.algorithm).toBe('scrypt')
    expect(file.kdf?.n).toBe(CHEAP.n)
    expect(file.kdf?.r).toBe(CHEAP.r)
    expect(file.kdf?.p).toBe(CHEAP.p)
  })
})

describe('the two layers over the key', () => {
  it('nests the key store around the master password, so a file needs both', async () => {
    /*
      The most consequential test in the file. `keystore+master` has to mean *both*, and a file
      either layer could open on its own would round-trip exactly like this one — so a round trip
      cannot tell them apart. What is asserted instead is the shape of each layer in turn.
    */
    const key = newVaultKey()
    const store = fakeKeystore()
    const file = await wrapCheaply({ key, safeStorage: store, masterPassword: MASTER })

    // Outer layer removed by hand: what the key store hands back is not the key, it is an envelope.
    const inner = Buffer.from(store.decryptString(payloadBytes(file)), 'base64')
    expect(isSealedDocument(inner), 'the key store unwrapped straight to the key').toBe(true)
    expect(inner.includes(Buffer.from(key))).toBe(false)

    // And that envelope still needs the master password — the inner layer is real, not decoration.
    const stripped: VaultKeyFile = {
      version: 1,
      keystore: false,
      kdf: file.kdf,
      payload: inner.toString('base64')
    }
    expect(
      hex(await openVaultKey({ file: stripped, safeStorage: store, masterPassword: MASTER }))
    ).toBe(hex(key))
    await expect(
      openVaultKey({ file: stripped, safeStorage: store, masterPassword: NOT_THE_MASTER })
    ).rejects.toThrow(WrongMasterPasswordError)

    // Neither half opens the real file alone: another machine's keychain fails at the outer layer,
    // and this machine's keychain with the wrong password fails at the inner one.
    await expect(
      openVaultKey({
        file,
        safeStorage: fakeKeystore({ brand: 'another-machine' }),
        masterPassword: MASTER
      })
    ).rejects.toThrow(VaultKeyUnreadableError)
    await expect(
      openVaultKey({ file, safeStorage: store, masterPassword: NOT_THE_MASTER })
    ).rejects.toThrow(WrongMasterPasswordError)
  })

  it('gives the same key back for each of the four protections', async () => {
    const key = newVaultKey()
    const available = fakeKeystore()
    const missing = fakeKeystore({ available: false })

    for (const [label, safeStorage, masterPassword] of [
      ['keystore+master', available, MASTER],
      ['master', missing, MASTER],
      ['keystore', available, null],
      ['plain', missing, null]
    ] as const) {
      const file = await wrapCheaply({ key, safeStorage, masterPassword })
      expect(hex(await openVaultKey({ file, safeStorage, masterPassword })), label).toBe(hex(key))
    }
  })
})

describe('opening a vault key that cannot be opened', () => {
  it('asks for the master password before it looks for the key store', async () => {
    /*
      Both layers are broken in this call: the file is master-protected with no password offered,
      *and* the key store that wrapped it is gone. The order of the two checks decides which of two
      unrelated instructions the user gets, and only a case where both apply can see it.
    */
    const file = await wrapCheaply({
      key: newVaultKey(),
      safeStorage: fakeKeystore(),
      masterPassword: MASTER
    })
    await expect(
      openVaultKey({
        file,
        safeStorage: fakeKeystore({ available: false }),
        masterPassword: null
      })
    ).rejects.toThrow(MasterPasswordRequiredError)
  })

  it('names the missing key store rather than blaming the password', async () => {
    // Same trick the other way round: the password offered here is wrong as well. Telling this
    // user to try their password again would send them looking in the wrong place for ever.
    const file = await wrapCheaply({
      key: newVaultKey(),
      safeStorage: fakeKeystore(),
      masterPassword: MASTER
    })
    await expect(
      openVaultKey({
        file,
        safeStorage: fakeKeystore({ available: false }),
        masterPassword: NOT_THE_MASTER
      })
    ).rejects.toThrow(/key store, which is not available now/)
  })

  it('repeats what the key store said when it refused to unwrap', async () => {
    // A profile restored on another machine, or an operating system reinstalled over the keychain.
    // The store's own words are the only clue a support question has to go on.
    const file = await wrapCheaply({
      key: newVaultKey(),
      safeStorage: fakeKeystore(),
      masterPassword: NOT_THE_MASTER
    })
    await expect(
      openVaultKey({
        file,
        safeStorage: fakeKeystore({ brand: 'another-machine' }),
        masterPassword: NOT_THE_MASTER
      })
    ).rejects.toThrow(/could not be unwrapped by the key store: .*not encrypted by this key store/)
  })

  it('tells a file with no envelope in it from a wrong password', async () => {
    /*
      A file that claims a master password but holds bare bytes. No password opens it, so reporting
      a wrong one would leave the user typing for ever; the distinction is what lets the vault say
      "unreadable" instead of "try again".
    */
    const file: VaultKeyFile = {
      version: 1,
      keystore: false,
      kdf: { algorithm: 'scrypt', ...CHEAP, salt: VALID_SALT },
      payload: Buffer.from(newVaultKey()).toString('base64')
    }
    const opening = openVaultKey({ file, safeStorage: fakeKeystore(), masterPassword: MASTER })
    await expect(opening).rejects.toThrow(/claims a master password but holds no sealed key/)
    await expect(opening).rejects.not.toBeInstanceOf(WrongMasterPasswordError)
  })

  it('says a password was wrong without naming it', async () => {
    // The message travels: it is caught, turned into an outcome word, and logged on the way. The
    // candidate must not be in it, in a log line, or in any reply that crosses IPC.
    const file = await wrapCheaply({
      key: newVaultKey(),
      safeStorage: fakeKeystore(),
      masterPassword: MASTER
    })
    try {
      await openVaultKey({ file, safeStorage: fakeKeystore(), masterPassword: NOT_THE_MASTER })
      expect.unreachable('the wrong master password opened the vault')
    } catch (error) {
      expect(error).toBeInstanceOf(WrongMasterPasswordError)
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain(NOT_THE_MASTER)
      expect(message).not.toContain(MASTER)
      expect(message).not.toContain(String(NOT_THE_MASTER.length))
    }
  })

  it('fails closed for a caller that hands over no master password at all', async () => {
    /*
      `masterPassword` is `string | null`, and the guard at the top of `openVaultKey` refuses `null` —
      so a *missing* one is a case the type system is the only thing preventing, which is exactly why
      the fallback in the derivation is worth an assertion. `undefined` slips past a `=== null` check,
      and the fallback makes it an empty password rather than a `TypeError` inside `scrypt` or, worse,
      a derivation from whatever `undefined` stringifies to. An empty password fails the tag like any
      other wrong one: the vault stays shut instead of opening for nobody.
    */
    const safeStorage = fakeKeystore({ available: false })
    const file = await wrapCheaply({ key: newVaultKey(), safeStorage, masterPassword: MASTER })
    const withoutOne: Record<string, unknown> = { file, safeStorage }

    await expect(openVaultKey(withoutOne as unknown as OpenVaultKeyOptions)).rejects.toThrow(
      WrongMasterPasswordError
    )
  })

  it('does not open the payload for a cost somebody lowered in the file', async () => {
    /*
      The KDF parameters are plain, unauthenticated JSON, so anyone who can write into the profile
      directory can edit them. What that buys them is asserted here: a lowered `n` derives a
      *different* key, the GCM tag fails, and the vault stays shut. A denial of service available to
      anyone who could also simply delete the file — and specifically not a way to make the owner's
      correct password open the existing payload, which is the only thing a downgrade would be worth.
    */
    const key = newVaultKey()
    const safeStorage = fakeKeystore({ available: false })
    const file = await wrapCheaply({ key, safeStorage, masterPassword: MASTER })
    const lowered: VaultKeyFile = { ...file, kdf: { ...file.kdf!, n: CHEAP.n / 2 } }

    await expect(
      openVaultKey({ file: lowered, safeStorage, masterPassword: MASTER })
    ).rejects.toThrow(WrongMasterPasswordError)
    // The untouched file still opens with the same password, so the refusal is about the parameter
    // and not about the password having stopped working.
    expect(hex(await openVaultKey({ file, safeStorage, masterPassword: MASTER }))).toBe(hex(key))
  })

  it('refuses key material of the wrong length coming out of the file', async () => {
    // A truncated or hand-edited payload. Without this check the short key reaches `createCipheriv`
    // and fails from inside a flush, about something that sounds like a disk fault.
    const file: VaultKeyFile = {
      version: 1,
      keystore: false,
      kdf: null,
      payload: Buffer.alloc(8).toString('base64')
    }
    await expect(
      openVaultKey({ file, safeStorage: fakeKeystore(), masterPassword: null })
    ).rejects.toThrow(/holds 8 bytes of key material, expected 32/)
  })
})

describe('reading the key file', () => {
  it('calls a missing file a first run, and nothing else', async () => {
    expect(await readVaultKeyFile(await keyPath())).toBeNull()
  })

  it('lets a read failure that is not a missing file through untouched', async () => {
    // A directory where the key file belongs. Answering `null` here would make the caller generate
    // a second key over the document the first one sealed — the one outcome with no recovery.
    const path = await keyPath()
    await mkdir(path)
    await expect(readVaultKeyFile(path)).rejects.toThrow(/EISDIR/)
  })

  it('refuses a file that is not JSON at all', async () => {
    const path = await keyPath()
    await writeFile(path, 'not json, and not a first run either', 'utf8')
    await expect(readVaultKeyFile(path)).rejects.toThrow(VaultKeyUnreadableError)
    await expect(readVaultKeyFile(path)).rejects.toThrow(/not readable as JSON/)
  })

  it('refuses every shape that is not this format', async () => {
    const path = join(await tempDir(), 'passwords.key')
    for (const [label, value] of [
      ['a number where the file should be', 42],
      ['the JSON null', null],
      ['a version this build does not know', { ...VALID_FILE, version: 2 }],
      ['a keystore flag that is not a boolean', { ...VALID_FILE, keystore: 'yes' }],
      ['a payload that is not text', { ...VALID_FILE, payload: 42 }],
      ['an empty payload', { ...VALID_FILE, payload: '' }],
      ['a kdf that is not an object', { ...VALID_FILE, kdf: 5 }],
      // A newer build's algorithm must fail visibly here. Guessing scrypt would derive nonsense
      // and report "wrong master password" to a user whose password is right.
      [
        'an algorithm from a newer build',
        { ...VALID_FILE, kdf: { ...VALID_KDF, algorithm: 'argon2id' } }
      ],
      // Each of these reaches `scrypt` as a memory-limit error if it is not refused here, which
      // reads as a machine problem rather than as a damaged file.
      ['a cost written as text', { ...VALID_FILE, kdf: { ...VALID_KDF, n: '16' } }],
      ['a fractional cost', { ...VALID_FILE, kdf: { ...VALID_KDF, n: 16.5 } }],
      ['a cost of zero', { ...VALID_FILE, kdf: { ...VALID_KDF, n: 0 } }],
      ['a negative block size', { ...VALID_FILE, kdf: { ...VALID_KDF, r: -8 } }],
      ['a fractional parallelism', { ...VALID_FILE, kdf: { ...VALID_KDF, p: 1.5 } }],
      ['a parallelism that is not a number', { ...VALID_FILE, kdf: { ...VALID_KDF, p: null } }],
      ['a salt that is not text', { ...VALID_FILE, kdf: { ...VALID_KDF, salt: 42 } }]
    ] as const) {
      await writeFile(path, JSON.stringify(value), 'utf8')
      await expect(readVaultKeyFile(path), label).rejects.toThrow(VaultKeyUnreadableError)
    }
  })

  it('measures the salt in decoded bytes, not in characters', async () => {
    /*
      `Buffer.from(text, 'base64')` skips whatever is not base64 instead of failing, so a check on
      the text would pass a truncated salt through and the derivation would quietly use fewer bytes
      than the format promises. Nothing anywhere would say so.
    */
    const path = join(await tempDir(), 'passwords.key')
    const fileWithSalt = (salt: string): unknown => ({
      ...VALID_FILE,
      kdf: { ...VALID_KDF, salt }
    })

    for (const [label, salt] of [
      ['half a salt', Buffer.alloc(VAULT_SALT_BYTES / 2).toString('base64')],
      ['a byte too many', Buffer.alloc(VAULT_SALT_BYTES + 1).toString('base64')],
      ['characters that decode to nothing at all', '!!!!!!!!!!!!!!!!!!!!!!']
    ] as const) {
      await writeFile(path, JSON.stringify(fileWithSalt(salt)), 'utf8')
      await expect(readVaultKeyFile(path), label).rejects.toThrow(VaultKeyUnreadableError)
    }

    // And the right number of bytes is accepted, so this is a rule about length rather than a rule
    // that refuses everything.
    await writeFile(path, JSON.stringify(fileWithSalt(VALID_SALT)), 'utf8')
    expect((await readVaultKeyFile(path))?.kdf?.salt).toBe(VALID_SALT)
  })

  it('reads back what it wrote, with and without a kdf', async () => {
    const key = newVaultKey()
    for (const masterPassword of [MASTER, null]) {
      const path = await keyPath()
      const file = await wrapCheaply({ key, safeStorage: fakeKeystore(), masterPassword })
      await writeVaultKeyFile(path, file)
      const read = await readVaultKeyFile(path)
      expect(read).toEqual(file)
      // And the key survives the trip through JSON, which is the only reason the file exists.
      expect(
        hex(await openVaultKey({ file: read!, safeStorage: fakeKeystore(), masterPassword }))
      ).toBe(hex(key))
    }
  })
})

describe('writing and deleting the key file', () => {
  it('creates the directory it was pointed at, readable only by its owner', async () => {
    const path = join(await tempDir(), 'profile', 'passwords.key')
    const file = await wrapCheaply({
      key: newVaultKey(),
      safeStorage: fakeKeystore(),
      masterPassword: null
    })
    await writeVaultKeyFile(path, file)

    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('leaves no temporary file behind once the rename is done', async () => {
    // Write-then-rename is what makes a crash mid-write leave the *previous* key in place. A
    // temporary left beside it would be mistaken for one on the next start.
    const path = await keyPath()
    await writeVaultKeyFile(
      path,
      await wrapCheaply({
        key: newVaultKey(),
        safeStorage: fakeKeystore(),
        masterPassword: null
      })
    )
    await expect(stat(`${path}.tmp`)).rejects.toThrow(/ENOENT/)
  })

  it('removes the key and the half-written temporary beside it', async () => {
    // Only ever called together with the document it protects. A temporary surviving the reset
    // would be read as a key file on the next start, over a document that is already gone.
    const path = await keyPath()
    await writeVaultKeyFile(
      path,
      await wrapCheaply({
        key: newVaultKey(),
        safeStorage: fakeKeystore(),
        masterPassword: null
      })
    )
    await writeFile(`${path}.tmp`, 'interrupted', 'utf8')

    await deleteVaultKeyFile(path)
    await expect(stat(path)).rejects.toThrow(/ENOENT/)
    await expect(stat(`${path}.tmp`)).rejects.toThrow(/ENOENT/)
    expect(await readVaultKeyFile(path)).toBeNull()
  })

  it('is quiet about a key file that is already gone', async () => {
    // A reset after a reset, or a profile that never had a vault. Neither is an error.
    await expect(deleteVaultKeyFile(await keyPath())).resolves.toBeUndefined()
  })
})

describe('the cost that ships', () => {
  it('is the one the design specifies', () => {
    // N = 2¹⁷, r = 8, p = 1. Lowering any of these is what turns "weeks with a word list" back
    // into an afternoon, and nothing in the application may pass the override that would do it.
    expect(VAULT_SCRYPT_COST).toEqual({ n: 131_072, r: 8, p: 1 })
    expect(VAULT_SCRYPT_COST.n).toBe(2 ** 17)
    // 128 · n · r, the memory the derivation needs. Node's own ceiling is 32 MB, which is why
    // `maxmem` has to be passed explicitly: without it the call fails with a message about memory
    // and the obvious "fix" is to lower `n`.
    expect(128 * VAULT_SCRYPT_COST.n * VAULT_SCRYPT_COST.r).toBe(128 * 1024 * 1024)
    expect(VAULT_SALT_BYTES).toBe(16)
  })

  it('wraps and opens a real key at the real cost when no override is given', async () => {
    /*
      The only place the shipping parameters run end to end, and the reason the override exists: two
      derivations at N = 2¹⁷ cost a few hundred milliseconds, and every other test in this file
      would have paid it. Without this one, nothing would notice `wrapVaultKey` defaulting to
      something cheaper — the file would still round-trip, and the vault would be a word list away.
    */
    const key = newVaultKey()
    const safeStorage = fakeKeystore()
    const file = await wrapVaultKey({ key, safeStorage, masterPassword: MASTER })

    expect(file.kdf?.n).toBe(VAULT_SCRYPT_COST.n)
    expect(file.kdf?.r).toBe(VAULT_SCRYPT_COST.r)
    expect(file.kdf?.p).toBe(VAULT_SCRYPT_COST.p)
    expect(hex(await openVaultKey({ file, safeStorage, masterPassword: MASTER }))).toBe(hex(key))
  })
})

describe('a derivation that fails inside scrypt', () => {
  it('turns parameters scrypt refuses into an unreadable key file, not a raw Node error', async () => {
    /*
      The regression test for a defect that reached IPC, and it needs no shim at all.

      Node validates scrypt's cost **synchronously**, while constructing the job, and *throws* rather
      than calling back — `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` for a non-power-of-two `N`. That throw used
      to happen inside the promise executor, so it became the promise's rejection unchanged, and
      `openVaultKey` silently broke the `@throws` contract in its own docblock.

      What that cost in the product: `asVaultKdf` validates the *shape* of `kdf`, not the arithmetic, so
      any positive integer `n` is accepted from the file — a corrupted or hand-edited `passwords.key` with
      `n: 3` is a file this module will try to derive from. `PasswordVault.unlock` rethrows anything that
      is not one of this module's own errors, so instead of settling as `unreadable` — "no password will
      help, and nothing will overwrite your vault to make the browser start" — the unlock rejected across
      IPC with a Node error code, and the passwords page got an untranslated failure where it has a panel
      written for exactly this state.
    */
    const safeStorage = fakeKeystore({ available: false })
    const sealed = await wrapVaultKey({
      key: newVaultKey(),
      safeStorage,
      masterPassword: MASTER,
      cost: CHEAP
    })
    const [kdf] = [sealed.kdf].filter((value) => value !== null)
    expect(kdf, 'a master-protected wrap must record its parameters').toBeDefined()
    // Three is a positive integer and not a power of two, so it passes the file's validation and fails
    // OpenSSL's. The payload is a genuine envelope, so the derivation is reached rather than refused
    // earlier as "claims a master password but holds no sealed key".
    const broken = { ...sealed, kdf: { ...kdf!, n: 3 } }

    await expect(
      openVaultKey({ file: broken, safeStorage, masterPassword: MASTER })
    ).rejects.toBeInstanceOf(VaultKeyUnreadableError)

    let thrown: unknown = null
    try {
      await openVaultKey({ file: broken, safeStorage, masterPassword: MASTER })
    } catch (error) {
      thrown = error
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    expect(message).toMatch(/the master password could not be stretched: /)
    expect(message).not.toContain(MASTER)
  })

  /*
    The other arm, and the one no input can reach — which is why it is exercised through a shim.

    `deriveWrappingKey` also handles an error arriving at `scrypt`'s *callback*. Now that the synchronous
    refusal above is caught where it happens, the only failure the real function delivers to the callback
    is OpenSSL's 128 MB allocation losing, which a test cannot cause without exhausting the machine.

    So the shim below leaves `scrypt` entirely alone except for *where* it reports: a real refusal, from
    the real function, delivered through the callback its own signature documents. What is asserted is
    still this module's decision — that such a report becomes a `VaultKeyUnreadableError` naming Node's
    parameters and never the candidate — and the shim is confined to this one test by `doMock` plus a
    fresh import, so nothing above runs against it.
  */
  it('reports it as an unreadable key file, naming the parameters and not the password', async () => {
    vi.resetModules()
    vi.doMock('node:crypto', async () => {
      const actual = await vi.importActual<typeof NodeCrypto>('node:crypto')
      return {
        ...actual,
        scrypt: (
          password: string,
          salt: Buffer,
          keylen: number,
          options: NodeCrypto.ScryptOptions,
          callback: (error: Error | null, derived: Buffer) => void
        ) => {
          try {
            actual.scrypt(password, salt, keylen, options, callback)
          } catch (error) {
            callback(error as Error, Buffer.alloc(0))
          }
        }
      }
    })

    try {
      const vaultKey = await import('@main/crypto/vault-key.js')
      const safeStorage = fakeKeystore({ available: false })
      const sealed = await vaultKey.wrapVaultKey({
        key: newVaultKey(),
        safeStorage,
        masterPassword: MASTER,
        cost: CHEAP
      })
      // A cost no scrypt will accept, over a payload that is a genuine envelope — so the derivation
      // is reached rather than refused earlier as "no sealed key".
      const broken = { ...sealed, kdf: { ...sealed.kdf!, n: 3 } }

      let thrown: unknown = null
      try {
        await vaultKey.openVaultKey({ file: broken, safeStorage, masterPassword: MASTER })
      } catch (error) {
        thrown = error
      }
      expect(thrown, 'a key was derived from parameters scrypt rejects').toBeInstanceOf(
        vaultKey.VaultKeyUnreadableError
      )
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      expect(message).toMatch(/the master password could not be stretched: /)
      expect(message).toMatch(/scrypt/i)
      expect(message).not.toContain(MASTER)
    } finally {
      vi.doUnmock('node:crypto')
      vi.resetModules()
    }
  })
})
