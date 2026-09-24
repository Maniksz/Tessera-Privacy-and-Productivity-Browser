import type * as NodeCrypto from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
  `scrypt` spied through, so "refused before the KDF runs" is a count rather than a claim. Everything
  else is Node's own.
*/
const scryptCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof NodeCrypto>()
  return {
    ...original,
    scrypt: (...args: Parameters<typeof original.scrypt>) => {
      scryptCalls.count += 1
      return original.scrypt(...args)
    }
  }
})

const {
  BACKUP_SCRYPT_COST,
  BackupRefusedError,
  MAX_ARCHIVE_BYTES,
  MAX_BACKUP_FILE_BYTES,
  openBackup,
  readBackupFile,
  readBackupHeader,
  sealBackup
} = await import('@main/backup/format.js')
const { VAULT_SCRYPT_COST } = await import('@main/crypto/vault-key.js')

/**
 * The backup file (KTD17): a versioned header in the clear, bound as AAD, then one AES-256-GCM
 * ciphertext of the compressed archive under a key scrypt stretched from the passphrase.
 *
 * Every test here is about something a hostile or damaged file must not get: memory by way of the
 * KDF's parameters, plaintext before the tag is checked, an archive that inflates without bound, or a
 * header changed without the tag noticing. Cost: `CHEAP` everywhere but the one end-to-end test, via
 * the same seam `wrapVaultKey` has.
 */

const CHEAP = { n: 16, r: 8, p: 1 } as const
const PASSPHRASE = 'a long enough passphrase'

const payload = new TextEncoder().encode(JSON.stringify({ hello: 'world', list: [1, 2, 3] }))

async function sealed(overrides: Partial<Parameters<typeof sealBackup>[0]> = {}): Promise<Buffer> {
  return Buffer.from(
    await sealBackup({
      passphrase: PASSPHRASE,
      appVersion: '0.21.0-ALPHA',
      documents: { bookmarksFile: 1 },
      payload,
      cost: CHEAP,
      ...overrides
    })
  )
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(BackupRefusedError)
    return (error as InstanceType<typeof BackupRefusedError>).reason
  }
  throw new Error('expected a refusal')
}

function refusalOf(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(BackupRefusedError)
    return (error as InstanceType<typeof BackupRefusedError>).reason
  }
  throw new Error('expected a refusal')
}

/** The header's bytes and where the ciphertext begins, read the way the format lays them out. */
function layout(bytes: Buffer): { magic: number; headerStart: number; headerEnd: number } {
  const magic = bytes.indexOf(0x0a) + 1
  const length = bytes.readUInt32BE(magic)
  return { magic, headerStart: magic + 4, headerEnd: magic + 4 + length }
}

/** The same file with a different header, the length field kept in step and the tag left as it was. */
function withHeader(bytes: Buffer, change: (header: Record<string, unknown>) => unknown): Buffer {
  const { magic, headerStart, headerEnd } = layout(bytes)
  const header = JSON.parse(bytes.subarray(headerStart, headerEnd).toString('utf8')) as Record<
    string,
    unknown
  >
  const text = Buffer.from(JSON.stringify(change(header)), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(text.length)
  return Buffer.concat([bytes.subarray(0, magic), length, text, bytes.subarray(headerEnd)])
}

beforeEach(() => {
  scryptCalls.count = 0
})

describe('the parameters that ship', () => {
  it('stretches the passphrase exactly as the vault stretches the master password', () => {
    expect(BACKUP_SCRYPT_COST).toEqual(VAULT_SCRYPT_COST)
    expect(BACKUP_SCRYPT_COST).toEqual({ n: 131_072, r: 8, p: 1 })
  })

  it('bounds the file and the archive', () => {
    expect(MAX_BACKUP_FILE_BYTES).toBe(256 * 1024 * 1024)
    expect(MAX_ARCHIVE_BYTES).toBe(512 * 1024 * 1024)
  })

  it('round-trips at the real cost, with no seam in the way', async () => {
    const bytes = await sealBackup({
      passphrase: PASSPHRASE,
      appVersion: '0.21.0-ALPHA',
      documents: {},
      payload
    })
    const opened = await openBackup({ bytes, passphrase: PASSPHRASE })
    expect(Buffer.from(opened.payload).equals(Buffer.from(payload))).toBe(true)
    expect(opened.header.kdf).toMatchObject({ algorithm: 'scrypt', n: 131_072, r: 8, p: 1 })
  }, 20_000)
})

describe('a backup and its passphrase', () => {
  it('round-trips the payload and carries its header in the clear', async () => {
    const bytes = await sealed()
    expect(bytes.subarray(0, 15).toString('ascii')).toBe('TESSERA-BACKUP\n')
    const opened = await openBackup({ bytes, passphrase: PASSPHRASE, allowedCost: CHEAP })
    expect(Buffer.from(opened.payload).toString('utf8')).toBe(Buffer.from(payload).toString('utf8'))
    expect(opened.header).toMatchObject({
      format: 1,
      appVersion: '0.21.0-ALPHA',
      documents: { bookmarksFile: 1 },
      kdf: { algorithm: 'scrypt', n: 16, r: 8, p: 1 }
    })
    expect(Buffer.from(opened.header.kdf.salt, 'base64')).toHaveLength(16)
    expect(Buffer.from(opened.header.iv, 'base64')).toHaveLength(12)
  })

  it('compresses before it encrypts, so the ciphertext is smaller than the text', async () => {
    const repetitive = new TextEncoder().encode('history '.repeat(10_000))
    const bytes = await sealed({ payload: repetitive })
    expect(bytes.length).toBeLessThan(repetitive.length / 10)
  })

  it('draws a fresh salt and nonce every time, so the same data twice is two different files', async () => {
    const first = await sealed()
    const second = await sealed()
    const a = readBackupHeader(first, CHEAP)
    const b = readBackupHeader(second, CHEAP)
    expect(a.header.kdf.salt).not.toBe(b.header.kdf.salt)
    expect(a.header.iv).not.toBe(b.header.iv)
    expect(first.subarray(a.headerEnd).equals(second.subarray(b.headerEnd))).toBe(false)
  })

  it('reports a wrong passphrase as a wrong passphrase or a damaged file, and gives nothing back', async () => {
    const bytes = await sealed()
    expect(
      await refusal(
        openBackup({ bytes, passphrase: 'not the passphrase at all', allowedCost: CHEAP })
      )
    ).toBe('wrong-passphrase-or-damaged')
  })

  it('lets final() fail for one changed byte in the header, before anything is inflated', async () => {
    const bytes = await sealed()
    const tampered = withHeader(bytes, (header) => ({ ...header, appVersion: '0.21.0-ALPHB' }))
    expect(
      await refusal(openBackup({ bytes: tampered, passphrase: PASSPHRASE, allowedCost: CHEAP }))
    ).toBe('wrong-passphrase-or-damaged')
  })

  it('lets final() fail for one changed byte of ciphertext or tag', async () => {
    const bytes = await sealed()
    const { headerEnd } = layout(bytes)
    for (const at of [headerEnd, bytes.length - 1]) {
      const tampered = Buffer.from(bytes)
      tampered[at] = (tampered[at] ?? 0) ^ 0x01
      expect(
        await refusal(openBackup({ bytes: tampered, passphrase: PASSPHRASE, allowedCost: CHEAP }))
      ).toBe('wrong-passphrase-or-damaged')
    }
  })

  it('asks admit() after the parameters and before the KDF, and stops when it refuses', async () => {
    const bytes = await sealed()
    const admit = vi.fn(() => 'newer' as const)
    expect(
      await refusal(openBackup({ bytes, passphrase: PASSPHRASE, allowedCost: CHEAP, admit }))
    ).toBe('newer')
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ appVersion: '0.21.0-ALPHA' }))
    expect(scryptCalls.count).toBe(1) // the seal's own derivation, and nothing after it
  })

  it('opens when admit() lets it through', async () => {
    const bytes = await sealed()
    const opened = await openBackup({
      bytes,
      passphrase: PASSPHRASE,
      allowedCost: CHEAP,
      admit: () => null
    })
    expect(opened.header.documents).toEqual({ bookmarksFile: 1 })
  })
})

describe('what is refused before the KDF runs', () => {
  it('refuses N = 2^30 without deriving anything', async () => {
    const bytes = withHeader(await sealed(), (header) => ({
      ...header,
      kdf: { ...(header['kdf'] as object), n: 2 ** 30 }
    }))
    scryptCalls.count = 0
    expect(await refusal(openBackup({ bytes, passphrase: PASSPHRASE, allowedCost: CHEAP }))).toBe(
      'not-a-backup'
    )
    expect(scryptCalls.count).toBe(0)
  })

  it('refuses the real cost when the allowlist is another, and every single parameter off by one', async () => {
    const original = await sealed()
    const kdf = (header: Record<string, unknown>): Record<string, unknown> =>
      header['kdf'] as Record<string, unknown>
    const variants = [
      (h: Record<string, unknown>) => ({ ...h, kdf: { ...kdf(h), r: 9 } }),
      (h: Record<string, unknown>) => ({ ...h, kdf: { ...kdf(h), p: 2 } }),
      (h: Record<string, unknown>) => ({ ...h, kdf: { ...kdf(h), n: 32 } }),
      (h: Record<string, unknown>) => ({ ...h, kdf: { ...kdf(h), algorithm: 'argon2id' } }),
      (h: Record<string, unknown>) => ({ ...h, kdf: { ...kdf(h), memory: 1 } }),
      (h: Record<string, unknown>) => ({ ...h, kdf: { ...kdf(h), salt: 'AAAA' } }),
      (h: Record<string, unknown>) => ({ ...h, iv: 'AAAA' }),
      (h: Record<string, unknown>) => ({ ...h, extra: true })
    ]
    scryptCalls.count = 0
    for (const change of variants) {
      const bytes = withHeader(original, change)
      expect(await refusal(openBackup({ bytes, passphrase: PASSPHRASE, allowedCost: CHEAP }))).toBe(
        'not-a-backup'
      )
    }
    expect(scryptCalls.count).toBe(0)
    // The default allowlist is the real cost, which a cheap file does not meet.
    expect(await refusal(openBackup({ bytes: original, passphrase: PASSPHRASE }))).toBe(
      'not-a-backup'
    )
    expect(scryptCalls.count).toBe(0)
  })

  it('refuses what is not a backup: another magic, a short file, a header that runs past the end', () => {
    expect(refusalOf(() => readBackupHeader(Buffer.from('{"version":1}'), CHEAP))).toBe(
      'not-a-backup'
    )
    expect(refusalOf(() => readBackupHeader(Buffer.from('TESSERA-BACKUP\n'), CHEAP))).toBe(
      'not-a-backup'
    )
    const runsPast = Buffer.concat([Buffer.from('TESSERA-BACKUP\n'), Buffer.from([0, 0, 1, 0])])
    expect(refusalOf(() => readBackupHeader(runsPast, CHEAP))).toBe('not-a-backup')
    const huge = Buffer.concat([
      Buffer.from('TESSERA-BACKUP\n'),
      Buffer.from([0, 1, 0, 0]),
      Buffer.alloc(65_536 + 32)
    ])
    expect(refusalOf(() => readBackupHeader(huge, CHEAP))).toBe('not-a-backup')
  })

  it('refuses a header that is not JSON, and one without a tag after it', async () => {
    const bytes = await sealed()
    const { magic, headerStart, headerEnd } = layout(bytes)
    const notJson = Buffer.from(bytes)
    notJson[headerStart] = 0x21 // '!' instead of '{'
    expect(refusalOf(() => readBackupHeader(notJson, CHEAP))).toBe('not-a-backup')
    const noTag = bytes.subarray(0, headerEnd + 8)
    expect(refusalOf(() => readBackupHeader(noTag, CHEAP))).toBe('not-a-backup')
    expect(magic).toBe(15)
  })

  it('calls a later format newer, not damaged', async () => {
    const bytes = withHeader(await sealed(), (header) => ({ ...header, format: 2, other: 'x' }))
    expect(refusalOf(() => readBackupHeader(bytes, CHEAP))).toBe('newer')
    const nonsense = withHeader(await sealed(), (header) => ({ ...header, format: 'two' }))
    expect(refusalOf(() => readBackupHeader(nonsense, CHEAP))).toBe('not-a-backup')
    const array = withHeader(await sealed(), () => [1])
    expect(refusalOf(() => readBackupHeader(array, CHEAP))).toBe('not-a-backup')
    const empty = withHeader(await sealed(), () => null)
    expect(refusalOf(() => readBackupHeader(empty, CHEAP))).toBe('not-a-backup')
  })

  it('refuses bytes over the file limit without reading the header', async () => {
    const bytes = await sealed()
    expect(
      await refusal(
        openBackup({
          bytes,
          passphrase: PASSPHRASE,
          allowedCost: CHEAP,
          limits: { fileBytes: bytes.length - 1 }
        })
      )
    ).toBe('too-large')
    expect(scryptCalls.count).toBe(1)
  })
})

describe('inflating, after final() and never before', () => {
  it('stops an archive that would inflate past the limit', async () => {
    const big = new Uint8Array(2 * 1024 * 1024) // zeros, which compress to almost nothing
    const bytes = await sealed({ payload: big })
    expect(bytes.length).toBeLessThan(64 * 1024)
    expect(
      await refusal(
        openBackup({
          bytes,
          passphrase: PASSPHRASE,
          allowedCost: CHEAP,
          limits: { archiveBytes: 1024 * 1024 }
        })
      )
    ).toBe('too-large')
    const opened = await openBackup({
      bytes,
      passphrase: PASSPHRASE,
      allowedCost: CHEAP,
      limits: { archiveBytes: 2 * 1024 * 1024 }
    })
    expect(opened.payload).toHaveLength(2 * 1024 * 1024)
  })

  it('reports an authentic ciphertext that is not deflate as damaged', async () => {
    const { createCipheriv, randomBytes, scryptSync } =
      await vi.importActual<typeof NodeCrypto>('node:crypto')
    // A file sealed correctly around bytes that are not a deflate stream: the tag passes, inflate fails.
    const original = await sealed()
    const { headerStart, headerEnd } = layout(original)
    const header = JSON.parse(original.subarray(headerStart, headerEnd).toString('utf8')) as {
      kdf: { salt: string }
      iv: string
    }
    const key = scryptSync(PASSPHRASE, Buffer.from(header.kdf.salt, 'base64'), 32, {
      N: 16,
      r: 8,
      p: 1
    })
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
    cipher.setAAD(original.subarray(0, headerEnd))
    const body = Buffer.concat([cipher.update(randomBytes(64)), cipher.final()])
    const forged = Buffer.concat([original.subarray(0, headerEnd), body, cipher.getAuthTag()])
    expect(
      await refusal(openBackup({ bytes: forged, passphrase: PASSPHRASE, allowedCost: CHEAP }))
    ).toBe('wrong-passphrase-or-damaged')
    expect(deflateRawSync(Buffer.from('x')).length).toBeGreaterThan(0)
  })
})

describe('reading a backup from disk', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tessera-backup-format-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads a file under the limit', async () => {
    const path = join(dir, 'a.tessera-backup')
    const bytes = await sealed()
    await writeFile(path, bytes)
    expect(Buffer.from(await readBackupFile(path)).equals(bytes)).toBe(true)
  })

  it('refuses a file over the limit from its size alone, before reading it', async () => {
    const path = join(dir, 'big.tessera-backup')
    await writeFile(path, Buffer.alloc(2048))
    expect(await refusal(readBackupFile(path, { fileBytes: 1024 }))).toBe('too-large')
  })

  it('refuses a directory as not a backup', async () => {
    expect(await refusal(readBackupFile(dir))).toBe('not-a-backup')
  })
})
