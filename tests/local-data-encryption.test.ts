import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { SafeStorage } from 'electron'
import {
  DOCUMENT_KEY_BYTES,
  isSealedDocument,
  openDocument,
  sealDocument
} from '@main/crypto/envelope.js'
import {
  KeyMaterialUnreadableError,
  KeystoreUnavailableError,
  loadOrCreateLocalDataKey,
  localDataKeyExists,
  type SafeStorageLike
} from '@main/crypto/local-data-key.js'
import { createEncryptedDocumentCodec } from '@main/data/encrypted-codec.js'
import { openLocalDataProtection } from '@main/data/local-data-protection.js'
import { JsonStore, UnreadableDocumentError } from '@main/data/JsonStore.js'
import { QuickLinkStore } from '@main/data/QuickLinkStore.js'

/**
 * Encrypted local storage (spec 3).
 *
 * The interesting tests here are the ones about failure, because that is where the
 * requirement is either met or quietly broken: a file that cannot be decrypted must
 * fail loudly instead of looking like a reset, a missing key store must be reported
 * instead of downgrading in silence, and a nonce must never be written twice.
 *
 * Nothing mocks Electron. `safeStorage` enters as an injected interface, so the fake
 * key store below can misbehave in the specific ways a real one does — refuse to
 * decrypt another machine's data, be absent altogether — and the production code
 * under test is the real one.
 */

const docSchema = z.object({ version: z.literal(1), items: z.array(z.string()) })
type Doc = z.output<typeof docSchema>
const fallback = (): Doc => ({ version: 1, items: [] })

const KEY_A = Buffer.alloc(DOCUMENT_KEY_BYTES, 1)
const KEY_B = Buffer.alloc(DOCUMENT_KEY_BYTES, 2)

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tessera-crypto-'))
}

async function tempPath(name = 'doc.json'): Promise<string> {
  return join(await tempDir(), name)
}

/**
 * A key store that behaves like the platform ones in the ways that matter.
 *
 * `brand` stands for "which machine's keychain": ciphertext from one brand cannot be
 * read by another, which is exactly the failure a copied profile or a reinstalled OS
 * produces.
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

/** Edits one byte in place, the way an attacker with write access to the profile would. */
function flipByte(bytes: Buffer, index: number): Buffer {
  bytes.writeUInt8(bytes.readUInt8(index) ^ 0xff, index)
  return bytes
}

async function openStore(filePath: string, key: Uint8Array): Promise<JsonStore<Doc>> {
  return JsonStore.open<Doc>({
    filePath,
    schema: docSchema,
    fallback,
    debounceMs: 0,
    codec: createEncryptedDocumentCodec(key)
  })
}

describe('document envelope', () => {
  const plaintext = new TextEncoder().encode('{"secret":"totally-visible-in-plain-json"}')

  it('round-trips a document', () => {
    const sealed = sealDocument(KEY_A, plaintext)
    expect(Buffer.from(openDocument(KEY_A, sealed))).toEqual(Buffer.from(plaintext))
  })

  it('leaves none of the plaintext in the sealed bytes', () => {
    const sealed = Buffer.from(sealDocument(KEY_A, plaintext))
    expect(sealed.includes(Buffer.from('secret'))).toBe(false)
  })

  it('draws a fresh nonce for every seal', () => {
    // Nonce reuse under one key leaks the XOR of two plaintexts and makes forging a
    // document at a known offset easy — for a settings file, flipping one boolean.
    // Sealing identical input repeatedly is the only way to see it happen.
    const nonces = new Set<string>()
    for (let attempt = 0; attempt < 64; attempt += 1) {
      nonces.add(Buffer.from(sealDocument(KEY_A, plaintext)).subarray(6, 18).toString('hex'))
    }
    expect(nonces.size).toBe(64)
  })

  it('produces different bytes for the same document every time', () => {
    const first = Buffer.from(sealDocument(KEY_A, plaintext))
    const second = Buffer.from(sealDocument(KEY_A, plaintext))
    expect(first.equals(second)).toBe(false)
  })

  it('refuses a flipped ciphertext byte', () => {
    const sealed = Buffer.from(sealDocument(KEY_A, plaintext))
    expect(() => openDocument(KEY_A, flipByte(sealed, sealed.length - 1))).toThrow()
  })

  it('refuses a flipped authentication tag', () => {
    const sealed = Buffer.from(sealDocument(KEY_A, plaintext))
    // Tag region: header (6) plus nonce (12).
    expect(() => openDocument(KEY_A, flipByte(sealed, 20))).toThrow()
  })

  it('refuses a header edited to claim another format version', () => {
    // The header is authenticated, so pointing the version byte at a format with
    // weaker rules cannot be made to work.
    const sealed = Buffer.from(sealDocument(KEY_A, plaintext))
    sealed[5] = 9
    expect(() => openDocument(KEY_A, sealed)).toThrow(/version 9/)
  })

  it('refuses a truncated envelope', () => {
    const sealed = Buffer.from(sealDocument(KEY_A, plaintext))
    expect(() => openDocument(KEY_A, sealed.subarray(0, 20))).toThrow(/truncated/)
  })

  it('refuses bytes that are not an envelope at all', () => {
    expect(() => openDocument(KEY_A, new TextEncoder().encode('{"version":1}'))).toThrow(
      /not an tessera encrypted document/
    )
  })

  it('refuses the wrong key', () => {
    const sealed = sealDocument(KEY_A, plaintext)
    expect(() => openDocument(KEY_B, sealed)).toThrow()
  })

  it('recognises its own output and nothing else', () => {
    expect(isSealedDocument(sealDocument(KEY_A, plaintext))).toBe(true)
    // Plain JSON starts with a brace, which is how migration tells the two apart.
    expect(isSealedDocument(new TextEncoder().encode('{"version":1}'))).toBe(false)
    expect(isSealedDocument(new Uint8Array(0))).toBe(false)
    expect(isSealedDocument(new TextEncoder().encode('OBE'))).toBe(false)
  })
})

describe('encrypted document codec', () => {
  it('round-trips a document', async () => {
    const codec = createEncryptedDocumentCodec(KEY_A)
    const bytes = await codec.encode({ version: 1, items: ['a'] })
    expect(await codec.decode(bytes)).toEqual({ version: 1, items: ['a'] })
  })

  it('rejects a key of the wrong length instead of failing at the next write', () => {
    expect(() => createEncryptedDocumentCodec(Buffer.alloc(16))).toThrow(/32 bytes, got 16/)
  })

  it('reads a plain-text file so it can be migrated', async () => {
    const codec = createEncryptedDocumentCodec(KEY_A)
    const plain = new TextEncoder().encode(JSON.stringify({ version: 1, items: ['old'] }))
    expect(await codec.decode(plain)).toEqual({ version: 1, items: ['old'] })
    expect(codec.isStaleEncoding?.(plain)).toBe(true)
  })

  it('calls its own output current', async () => {
    const codec = createEncryptedDocumentCodec(KEY_A)
    expect(codec.isStaleEncoding?.(await codec.encode({ version: 1 }))).toBe(false)
  })

  it('treats a corrupt plain-text file as an ordinary corrupt file', () => {
    // No key is involved, so nothing is being hidden: this keeps the recoverable
    // failure rather than the hard one that stops the browser starting.
    const codec = createEncryptedDocumentCodec(KEY_A)
    const corrupt = new TextEncoder().encode('{ not json')
    expect(() => codec.decode(corrupt)).toThrow()
    try {
      codec.decode(corrupt)
    } catch (error) {
      expect(error).not.toBeInstanceOf(UnreadableDocumentError)
    }
  })

  it('reports a ciphertext it cannot open as an unreadable document', async () => {
    const sealedWithAnotherKey = await createEncryptedDocumentCodec(KEY_A).encode({ version: 1 })
    expect(() => createEncryptedDocumentCodec(KEY_B).decode(sealedWithAnotherKey)).toThrow(
      UnreadableDocumentError
    )
  })
})

describe('JsonStore under encryption', () => {
  it('writes nothing readable to disk', async () => {
    const filePath = await tempPath()
    const store = await openStore(filePath, KEY_A)
    store.update((doc) => ({ ...doc, items: ['a-visited-site.example'] }))
    await store.flush()

    const bytes = await readFile(filePath)
    expect(bytes.includes(Buffer.from('a-visited-site.example'))).toBe(false)
    expect(() => {
      JSON.parse(bytes.toString('utf8'))
    }).toThrow()
  })

  it('reads back what it wrote on the next start', async () => {
    const filePath = await tempPath()
    const first = await openStore(filePath, KEY_A)
    first.update((doc) => ({ ...doc, items: ['a', 'b'] }))
    await first.flush()

    const second = await openStore(filePath, KEY_A)
    expect(second.get().items).toEqual(['a', 'b'])
    expect(second.diagnostics.recoveredFromInvalidFile).toBe(false)
    expect(second.diagnostics.migratedEncodingOnLoad).toBe(false)
  })

  it('never writes the same bytes twice for the same document', async () => {
    const filePath = await tempPath()
    const store = await openStore(filePath, KEY_A)
    store.update((doc) => ({ ...doc, items: ['a'] }))
    await store.flush()
    const first = await readFile(filePath)
    await store.flush()
    const second = await readFile(filePath)

    // Same document, different file: the nonce is per write, not per document.
    expect(first.equals(second)).toBe(false)
  })

  it('migrates an existing plain-text file at startup without losing it', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 1, items: ['from-before-encryption'] }))

    const store = await openStore(filePath, KEY_A)
    expect(store.get().items).toEqual(['from-before-encryption'])
    expect(store.diagnostics.migratedEncodingOnLoad).toBe(true)

    // The readable file is gone by the time `open` resolves, not on the user's next
    // change — otherwise a profile nobody edits stays readable for ever.
    const bytes = await readFile(filePath)
    expect(isSealedDocument(bytes)).toBe(true)
    const reopened = await openStore(filePath, KEY_A)
    expect(reopened.get().items).toEqual(['from-before-encryption'])
  })

  it('fails to open a file sealed with a different key, and leaves it untouched', async () => {
    const filePath = await tempPath()
    const store = await openStore(filePath, KEY_A)
    store.update((doc) => ({ ...doc, items: ['still-here'] }))
    await store.flush()
    const before = await readFile(filePath)

    // A keychain entry lost with an OS reinstall looks exactly like this.
    await expect(openStore(filePath, KEY_B)).rejects.toThrow(UnreadableDocumentError)
    expect((await readFile(filePath)).equals(before)).toBe(true)
  })

  it('fails to open a file whose ciphertext was edited', async () => {
    const filePath = await tempPath()
    const store = await openStore(filePath, KEY_A)
    store.update((doc) => ({ ...doc, items: ['a'] }))
    await store.flush()

    const bytes = await readFile(filePath)
    await writeFile(filePath, flipByte(bytes, bytes.length - 1))

    await expect(openStore(filePath, KEY_A)).rejects.toThrow(UnreadableDocumentError)
  })
})

describe('local data key', () => {
  it('creates a key on first run and wraps it through the key store', async () => {
    const keyFilePath = await tempPath('local-data.key')
    const key = await loadOrCreateLocalDataKey({ safeStorage: fakeKeystore(), keyFilePath })

    expect(key).toHaveLength(DOCUMENT_KEY_BYTES)
    // The key on disk went through the key store; the raw bytes are not in the file.
    const stored = await readFile(keyFilePath)
    expect(stored.subarray(0, 10).toString('utf8')).toBe('keychain-a')
    expect(stored.includes(Buffer.from(key))).toBe(false)
  })

  it('creates the key file readable only by its owner', async () => {
    const keyFilePath = await tempPath('local-data.key')
    await loadOrCreateLocalDataKey({ safeStorage: fakeKeystore(), keyFilePath })
    const info = await stat(keyFilePath)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('returns the same key on the next start', async () => {
    const keyFilePath = await tempPath('local-data.key')
    const safeStorage = fakeKeystore()
    const first = await loadOrCreateLocalDataKey({ safeStorage, keyFilePath })
    const second = await loadOrCreateLocalDataKey({ safeStorage, keyFilePath })
    expect(Buffer.from(second).toString('hex')).toBe(Buffer.from(first).toString('hex'))
  })

  it('refuses to invent a key when there is no key store', async () => {
    const keyFilePath = await tempPath('local-data.key')
    await expect(
      loadOrCreateLocalDataKey({ safeStorage: fakeKeystore({ available: false }), keyFilePath })
    ).rejects.toThrow(KeystoreUnavailableError)
    // And writes nothing, so the next start with a working key store is a first run.
    expect(await localDataKeyExists(keyFilePath)).toBe(false)
  })

  it('reports a key another key store wrapped, rather than replacing it', async () => {
    const keyFilePath = await tempPath('local-data.key')
    await loadOrCreateLocalDataKey({
      safeStorage: fakeKeystore({ brand: 'other-machine' }),
      keyFilePath
    })
    const before = await readFile(keyFilePath)

    // Replacing the key here would make every existing document unreadable for ever
    // while the browser reported a clean start.
    await expect(
      loadOrCreateLocalDataKey({ safeStorage: fakeKeystore(), keyFilePath })
    ).rejects.toThrow(KeyMaterialUnreadableError)
    expect((await readFile(keyFilePath)).equals(before)).toBe(true)
  })

  it('reports key material of the wrong length', async () => {
    const keyFilePath = await tempPath('local-data.key')
    const safeStorage = fakeKeystore()
    // A half-written or hand-edited key file: unwraps cleanly, is not a key.
    await writeFile(keyFilePath, safeStorage.encryptString(Buffer.alloc(8).toString('base64')))

    await expect(loadOrCreateLocalDataKey({ safeStorage, keyFilePath })).rejects.toThrow(
      /8 bytes of key material/
    )
  })

  it('propagates a read failure that is not a missing file', async () => {
    // A directory where the key file belongs is not a first run, and treating it as
    // one would create a second key over data the first one encrypted.
    const keyFilePath = join(await tempDir(), 'local-data.key')
    await mkdir(keyFilePath)
    await expect(
      loadOrCreateLocalDataKey({ safeStorage: fakeKeystore(), keyFilePath })
    ).rejects.toThrow(/EISDIR/)
  })

  it('knows whether a profile has ever been protected', async () => {
    const keyFilePath = await tempPath('local-data.key')
    expect(await localDataKeyExists(keyFilePath)).toBe(false)
    await loadOrCreateLocalDataKey({ safeStorage: fakeKeystore(), keyFilePath })
    expect(await localDataKeyExists(keyFilePath)).toBe(true)
  })

  it('does not read an unexaminable path as an absent key', async () => {
    const file = await tempPath('not-a-directory')
    await writeFile(file, 'x')
    // ENOTDIR, not ENOENT: the difference decides whether plain text is acceptable.
    await expect(localDataKeyExists(join(file, 'local-data.key'))).rejects.toThrow(/ENOTDIR/)
  })

  it('takes Electron own safeStorage as a key store', () => {
    /**
     * The assertion that matters here is the type annotation, checked by
     * `pnpm typecheck`: the main process passes `safeStorage` in unmodified, and if
     * Electron's signatures drift this has to fail in a test run rather than at
     * startup on one platform. Kept as a type, not an import of the module, because
     * `electron` cannot be loaded outside a browser process at all.
     */
    const asKeyStore: (storage: SafeStorage) => SafeStorageLike = (storage) => storage
    expect(asKeyStore).toBeTypeOf('function')
  })
})

describe('local data protection', () => {
  async function paths(): Promise<{ keyFilePath: string; noticeFilePath: string }> {
    const dir = await tempDir()
    return {
      keyFilePath: join(dir, 'local-data.key'),
      noticeFilePath: join(dir, 'LOCAL-DATA-NOT-ENCRYPTED.txt')
    }
  }

  it('encrypts when the key store is available', async () => {
    const where = await paths()
    const protection = await openLocalDataProtection({ safeStorage: fakeKeystore(), ...where })

    expect(protection.mode).toBe('os-keystore')
    expect(isSealedDocument(await protection.codec.encode({ version: 1 }))).toBe(true)
    expect(await localDataKeyExists(where.keyFilePath)).toBe(true)
  })

  it('withdraws an earlier notice once a key store appears', async () => {
    const where = await paths()
    await mkdir(join(where.noticeFilePath, '..'), { recursive: true })
    await writeFile(where.noticeFilePath, 'from a run without a key store')

    await openLocalDataProtection({ safeStorage: fakeKeystore(), ...where })
    // A warning that outlives the problem is a warning people learn to ignore.
    await expect(readFile(where.noticeFilePath)).rejects.toThrow(/ENOENT/)
  })

  it('runs unencrypted on a fresh profile with no key store, and says so', async () => {
    const where = await paths()
    const warnings: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warnings.push(String(line))
    })
    const protection = await openLocalDataProtection({
      safeStorage: fakeKeystore({ available: false }),
      ...where
    })
    warn.mockRestore()

    expect(protection.mode).toBe('unencrypted')
    expect(isSealedDocument(await protection.codec.encode({ version: 1 }))).toBe(false)
    expect(warnings.join('\n')).toMatch(/unencrypted/)

    // The channel a user actually finds: a file next to the readable data.
    const notice = await readFile(where.noticeFilePath, 'utf8')
    expect(notice).toMatch(/NOT encrypted/)
    expect(notice).toMatch(/NICHT verschlüsselt/)
    expect(notice).toMatch(/gnome-keyring/)
  })

  it('refuses to downgrade a profile that was already encrypted', async () => {
    const where = await paths()
    await loadOrCreateLocalDataKey({ safeStorage: fakeKeystore(), keyFilePath: where.keyFilePath })

    // Plain text here would either fail to read the existing documents or overwrite
    // them with defaults, and both look like the browser lost the user's data.
    await expect(
      openLocalDataProtection({ safeStorage: fakeKeystore({ available: false }), ...where })
    ).rejects.toThrow(KeystoreUnavailableError)
    await expect(readFile(where.noticeFilePath)).rejects.toThrow(/ENOENT/)
  })

  it('reports an unusable key file instead of starting from defaults', async () => {
    const where = await paths()
    await loadOrCreateLocalDataKey({
      safeStorage: fakeKeystore({ brand: 'other-machine' }),
      keyFilePath: where.keyFilePath
    })
    await expect(
      openLocalDataProtection({ safeStorage: fakeKeystore(), ...where })
    ).rejects.toThrow(KeyMaterialUnreadableError)
  })

  it('protects a real store end to end', async () => {
    // Quick links through the same seam a caller uses, to show that nothing beyond
    // the codec has to know about any of this.
    const dir = await tempDir()
    const filePath = join(dir, 'quicklinks.json')
    const protection = await openLocalDataProtection({
      safeStorage: fakeKeystore(),
      keyFilePath: join(dir, 'local-data.key'),
      noticeFilePath: join(dir, 'LOCAL-DATA-NOT-ENCRYPTED.txt')
    })

    const links = await QuickLinkStore.open({ filePath, codec: protection.codec, debounceMs: 0 })
    links.create({ kind: 'link', title: 'Private', url: 'diary.example' })
    await links.flush()

    expect((await readFile(filePath)).includes(Buffer.from('diary.example'))).toBe(false)
    const reopened = await QuickLinkStore.open({ filePath, codec: protection.codec, debounceMs: 0 })
    expect(reopened.list()[0]?.url).toBe('https://diary.example')
  })
})
