import {
  DOCUMENT_KEY_BYTES,
  isSealedDocument,
  openDocument,
  sealDocument
} from '../crypto/envelope.js'
import { UnreadableDocumentError, plainJsonDocumentCodec, type DocumentCodec } from './JsonStore.js'

/**
 * The `DocumentCodec` that satisfies spec 3: JSON in, sealed bytes out.
 *
 * Every store that already goes through `JsonStore` — quick links, extensions, and
 * the history, bookmarks and downloads still to come — becomes encrypted by being
 * handed this instead of the plain codec. Nothing else changes, which is the whole
 * reason the seam exists.
 */
export function createEncryptedDocumentCodec(key: Uint8Array): DocumentCodec {
  if (key.length !== DOCUMENT_KEY_BYTES) {
    // Checked once here rather than on every write, and named: `createCipheriv`
    // would otherwise report "invalid key length" from deep inside a flush, where
    // it looks like a disk problem.
    throw new Error(`a document key must be ${DOCUMENT_KEY_BYTES} bytes, got ${key.length}`)
  }

  return {
    // No indentation, unlike the plain codec: that exists so a user can read and
    // hand-edit the file, and neither is possible through a cipher. The bytes are
    // copied twice more on the way out, so the smaller form is also the cheaper one.
    encode: (data) => sealDocument(key, new TextEncoder().encode(JSON.stringify(data))),

    decode: (bytes) => {
      if (!isSealedDocument(bytes)) {
        /**
         * Migration of a file written before encryption existed.
         *
         * Read it exactly as it was written, and let `isStaleEncoding` tell
         * `JsonStore` to write it back sealed. Invalid JSON here stays an ordinary
         * corrupt file — it gets the ordinary fallback rather than the hard failure
         * below, because nothing is being hidden behind a missing key.
         */
        return plainJsonDocumentCodec.decode(bytes)
      }

      let plaintext: Uint8Array
      try {
        plaintext = openDocument(key, bytes)
      } catch (error) {
        // The one case that must not degrade into defaults. See
        // `UnreadableDocumentError` for why. `String` and no `instanceof` check:
        // every throw from `openDocument` is an `Error`, so the other arm would be
        // a branch no input can reach.
        throw new UnreadableDocumentError(
          `the stored document could not be decrypted: ${String(error)}`
        )
      }
      return JSON.parse(new TextDecoder().decode(plaintext)) as unknown
    },

    isStaleEncoding: (bytes) => !isSealedDocument(bytes)
  }
}
