import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM envelopes for documents on disk (spec 3: all local data encrypted).
 *
 * Deliberately free of file access, of key handling and of Electron: given a key
 * and bytes it returns bytes. That is what makes every failure below testable by
 * causing it rather than by mocking a platform.
 *
 * GCM rather than CBC because an unauthenticated ciphertext is a file that anyone
 * with write access to the profile directory can edit into a *different* valid
 * document — flipping a boolean in an encrypted settings file is a bit-flip at a
 * known offset. The tag turns that into a read failure. Each seal draws a fresh
 * nonce: reusing one under the same key leaks the XOR of the two plaintexts and
 * makes those forgeries trivial, so the nonce is never derived from the content or
 * from a counter that a restore-from-backup could rewind.
 */

/**
 * Format marker, followed by one version byte.
 *
 * Two jobs. It tells a sealed file from a plain-text one, which is how migration
 * of the pre-encryption files works without a separate marker on the side — JSON
 * starts with `{`, never with this. And the version byte gives a future algorithm
 * change somewhere to be, instead of leaving unreadable files with no explanation.
 */
const MAGIC = Buffer.from('OBENC', 'ascii')
const VERSION_BYTE = Buffer.of(1)
const HEADER = Buffer.concat([MAGIC, VERSION_BYTE])

/** GCM's native nonce length. Any other size makes the mode derive one, slower and for nothing. */
const IV_BYTES = 12
const TAG_BYTES = 16

/** Layout: header, nonce, tag, ciphertext. The tag is fixed-length, so it can precede the payload. */
const PREFIX_BYTES = HEADER.length + IV_BYTES + TAG_BYTES

/** AES-256. Stated here so key handling and sealing cannot disagree about it. */
export const DOCUMENT_KEY_BYTES = 32

/** True for bytes this module wrote; false for anything else, including plain JSON. */
export function isSealedDocument(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER.length && MAGIC.equals(bytes.subarray(0, MAGIC.length))
}

/**
 * Seals a document. `key` must be `DOCUMENT_KEY_BYTES` long; a wrong length is
 * rejected by `node:crypto` itself, and the codec checks it once at construction
 * so the message names the cause.
 */
export function sealDocument(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  // The header is authenticated but not encrypted, so downgrading the version
  // byte to point at a weaker format fails the tag check instead of working.
  cipher.setAAD(HEADER)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([HEADER, iv, cipher.getAuthTag(), ciphertext])
}

/**
 * Opens a sealed document, or throws.
 *
 * Every rejection here means the same thing to a caller — these bytes cannot be
 * turned back into a document — so the messages differ only to make a support
 * question answerable.
 */
export function openDocument(key: Uint8Array, envelope: Uint8Array): Uint8Array {
  if (!isSealedDocument(envelope)) {
    throw new Error('not an tessera encrypted document')
  }
  const version = envelope.subarray(MAGIC.length, HEADER.length)
  if (!VERSION_BYTE.equals(version)) {
    throw new Error(`unsupported encrypted document version ${version.join('')}`)
  }
  if (envelope.length < PREFIX_BYTES) {
    throw new Error('encrypted document is truncated')
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    envelope.subarray(HEADER.length, HEADER.length + IV_BYTES)
  )
  decipher.setAAD(envelope.subarray(0, HEADER.length))
  decipher.setAuthTag(envelope.subarray(HEADER.length + IV_BYTES, PREFIX_BYTES))
  // `final()` is what verifies the tag. Returning `update()` alone would hand back
  // unauthenticated plaintext — the classic way to use GCM and get none of it.
  return Buffer.concat([decipher.update(envelope.subarray(PREFIX_BYTES)), decipher.final()])
}
