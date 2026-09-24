import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { deflateRaw, inflateRaw } from 'node:zlib'
import type { BackupRefusal } from '@shared/backup/model.js'
import { backupHeaderSchema, type BackupHeader } from '@shared/backup/schema.js'
import { DOCUMENT_KEY_BYTES } from '../crypto/envelope.js'
import { VAULT_SCRYPT_COST, type ScryptCost } from '../crypto/vault-key.js'

/**
 * The backup file (KTD17): one file, a versioned header in the clear, one AES-256-GCM ciphertext.
 *
 * ```
 *   MAGIC "TESSERA-BACKUP\n" | u32 BE header length | header (JSON) | ciphertext | tag (16)
 *   AAD        = everything before the ciphertext
 *   ciphertext = AES-256-GCM( scrypt(passphrase, header.kdf), header.iv, deflateRaw(archive) )
 * ```
 *
 * ## Why the checks run in this order
 *
 * The header decides how the KDF runs, and the KDF runs before the tag can say whether the header is
 * authentic. So everything a hostile header could turn into a cost is refused from the header alone,
 * in the clear, before any work: the file's size, the header's size, a format this build does not
 * know, and above all the scrypt parameters — which must be *exactly* the allowlist, because
 * `N = 2^30` is 128 GiB of memory asked for by a file somebody sent. Then `admit`, the caller's
 * refusal of a newer version, which costs nothing either. Only then the KDF, then the cipher.
 *
 * The plaintext is used after `final()` and never before it: `update()` alone would hand back bytes
 * nobody has authenticated, which is the classic way to use GCM and get none of it. Inflating comes
 * after that, with a ceiling on what it may produce, because an authentic archive can still be a
 * decompression bomb if it was made to be one.
 *
 * One pass, one nonce: compressed, then encrypted in a single `update`/`final`. No blocks with a
 * nonce each, so there is no nonce scheme to get wrong and no block to reorder.
 *
 * ## What it is not
 *
 * The documents' own format. The archive is bytes here; `create-backup.ts` builds it and
 * `stage-restore.ts` reads it. Not `OBENC` either: that envelope is sealed under a key held on this
 * machine, and this one is sealed under a passphrase and carried off it, so the two are told apart by
 * their first bytes rather than by guessing.
 */

const MAGIC = Buffer.from('TESSERA-BACKUP\n', 'ascii')
const LENGTH_BYTES = 4
const IV_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16

/** Far more than a header needs, and small enough to parse before anything is trusted. */
const MAX_HEADER_BYTES = 16 * 1024

/** A profile's worth of history and bookmarks compresses to a fraction of this. */
export const MAX_BACKUP_FILE_BYTES = 256 * 1024 * 1024

/** What an archive may inflate to; past it, inflating stops rather than filling memory. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

/**
 * The passphrase's cost: the vault's, N = 2^17, r = 8, p = 1 (KTD17).
 *
 * The same number and not a copy of it, so a backup is exactly as hard to guess as the master
 * password it may carry the vault behind. Argon2id would be better and is not in Electron 43, whose
 * Node is built against BoringSSL; see `crypto/vault-key.ts` for where it goes when it arrives.
 */
export const BACKUP_SCRYPT_COST: ScryptCost = VAULT_SCRYPT_COST

export class BackupRefusedError extends Error {
  constructor(readonly reason: BackupRefusal) {
    super(`backup refused: ${reason}`)
    this.name = 'BackupRefusedError'
  }
}

export interface BackupLimits {
  readonly fileBytes?: number
  readonly archiveBytes?: number
}

const deflate = promisify(deflateRaw)
const inflate = promisify(inflateRaw)
const derive = promisify(scrypt) as (
  password: string,
  salt: Uint8Array,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>

export interface SealBackupOptions {
  readonly passphrase: string
  readonly appVersion: string
  /** The version of every document inside, by name. */
  readonly documents: Readonly<Record<string, number>>
  /** The archive, as bytes. */
  readonly payload: Uint8Array
  /**
   * Cost override for tests, as `wrapVaultKey` has one and on the same terms: nothing in the
   * application passes it, and a test pins `BACKUP_SCRYPT_COST` and runs the default once.
   */
  readonly cost?: ScryptCost
}

/** Compresses, derives, encrypts; the result is the whole file. */
export async function sealBackup(options: SealBackupOptions): Promise<Uint8Array> {
  const cost = options.cost ?? BACKUP_SCRYPT_COST
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const header: BackupHeader = {
    format: 1,
    appVersion: options.appVersion,
    documents: { ...options.documents },
    kdf: { algorithm: 'scrypt', ...cost, salt: salt.toString('base64') },
    iv: iv.toString('base64')
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  const length = Buffer.alloc(LENGTH_BYTES)
  length.writeUInt32BE(headerBytes.length)
  const aad = Buffer.concat([MAGIC, length, headerBytes])

  const compressed = await deflate(options.payload)
  const key = await stretch(options.passphrase, salt, cost)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()])
  return Buffer.concat([aad, ciphertext, cipher.getAuthTag()])
}

export interface ReadHeader {
  readonly header: BackupHeader
  /** Where the ciphertext begins; everything before it is the AAD. */
  readonly headerEnd: number
}

/**
 * The header, and nothing else, with every check that needs no key: magic, sizes, format, schema,
 * and the KDF parameters against `allowed` exactly. No KDF runs here.
 */
export function readBackupHeader(bytes: Uint8Array, allowed: ScryptCost): ReadHeader {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const lengthAt = MAGIC.length
  if (view.length < lengthAt + LENGTH_BYTES || !MAGIC.equals(view.subarray(0, lengthAt))) {
    throw new BackupRefusedError('not-a-backup')
  }
  const length = view.readUInt32BE(lengthAt)
  const headerStart = lengthAt + LENGTH_BYTES
  const headerEnd = headerStart + length
  if (length > MAX_HEADER_BYTES || headerEnd + TAG_BYTES > view.length) {
    throw new BackupRefusedError('not-a-backup')
  }

  let raw: unknown
  try {
    raw = JSON.parse(view.subarray(headerStart, headerEnd).toString('utf8'))
  } catch {
    throw new BackupRefusedError('not-a-backup')
  }
  // A later format may have changed every other field, so only its number is looked at.
  const format = (raw as { format?: unknown } | null)?.format
  if (typeof format === 'number' && Number.isInteger(format) && format > 1) {
    throw new BackupRefusedError('newer')
  }
  const parsed = backupHeaderSchema.safeParse(raw)
  if (!parsed.success) throw new BackupRefusedError('not-a-backup')
  const header = parsed.data
  const { kdf } = header
  if (
    kdf.n !== allowed.n ||
    kdf.r !== allowed.r ||
    kdf.p !== allowed.p ||
    Buffer.from(kdf.salt, 'base64').length !== SALT_BYTES ||
    Buffer.from(header.iv, 'base64').length !== IV_BYTES
  ) {
    throw new BackupRefusedError('not-a-backup')
  }
  return { header, headerEnd }
}

export interface OpenBackupOptions {
  readonly bytes: Uint8Array
  readonly passphrase: string
  /** The one set of KDF parameters a file may state. Test seam; see `SealBackupOptions.cost`. */
  readonly allowedCost?: ScryptCost
  /** A refusal from the header alone, before the KDF: a newer app or document version. */
  readonly admit?: (header: BackupHeader) => BackupRefusal | null
  readonly limits?: BackupLimits
}

export interface OpenedBackup {
  readonly header: BackupHeader
  /** The inflated archive, authenticated. */
  readonly payload: Uint8Array
}

/** Opens a backup, or throws `BackupRefusedError` with the reason. See the module docblock. */
export async function openBackup(options: OpenBackupOptions): Promise<OpenedBackup> {
  const { bytes } = options
  if (bytes.length > (options.limits?.fileBytes ?? MAX_BACKUP_FILE_BYTES)) {
    throw new BackupRefusedError('too-large')
  }
  const cost = options.allowedCost ?? BACKUP_SCRYPT_COST
  const { header, headerEnd } = readBackupHeader(bytes, cost)
  const refused = options.admit?.(header) ?? null
  if (refused !== null) throw new BackupRefusedError(refused)

  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const key = await stretch(options.passphrase, Buffer.from(header.kdf.salt, 'base64'), cost)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  decipher.setAAD(view.subarray(0, headerEnd))
  decipher.setAuthTag(view.subarray(view.length - TAG_BYTES))
  let compressed: Buffer
  try {
    compressed = Buffer.concat([
      decipher.update(view.subarray(headerEnd, view.length - TAG_BYTES)),
      decipher.final()
    ])
  } catch {
    throw new BackupRefusedError('wrong-passphrase-or-damaged')
  }

  try {
    const payload = await inflate(compressed, {
      maxOutputLength: options.limits?.archiveBytes ?? MAX_ARCHIVE_BYTES
    })
    return { header, payload }
  } catch (error) {
    // `ERR_BUFFER_TOO_LARGE` is the ceiling; anything else is a stream that is not deflate.
    const tooLarge = (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
    throw new BackupRefusedError(tooLarge ? 'too-large' : 'wrong-passphrase-or-damaged')
  }
}

/**
 * Reads a backup file, refusing one over the limit from its size, before a byte is read.
 *
 * Something that is not a file — a directory, a device — is not a backup either.
 */
export async function readBackupFile(path: string, limits: BackupLimits = {}): Promise<Uint8Array> {
  const info = await stat(path)
  if (!info.isFile()) throw new BackupRefusedError('not-a-backup')
  if (info.size > (limits.fileBytes ?? MAX_BACKUP_FILE_BYTES)) {
    throw new BackupRefusedError('too-large')
  }
  return readFile(path)
}

/**
 * The passphrase, stretched. Asynchronous, on libuv's pool, for the reason `vault-key.ts` gives:
 * half a second on the main thread freezes every window. `maxmem` is set from the parameters, which
 * the allowlist has already fixed, so it can never be talked into more than the shipped cost.
 */
function stretch(passphrase: string, salt: Uint8Array, cost: ScryptCost): Promise<Buffer> {
  const maxmem = 128 * cost.n * cost.r + 1024 * 1024
  return derive(passphrase, salt, DOCUMENT_KEY_BYTES, { N: cost.n, r: cost.r, p: cost.p, maxmem })
}
