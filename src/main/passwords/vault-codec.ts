import { isSealedDocument, openDocument, sealDocument } from '../crypto/envelope.js'
import {
  UnreadableDocumentError,
  plainJsonDocumentCodec,
  type DocumentCodec
} from '../data/JsonStore.js'

/**
 * The codec that moves `passwords.json` onto the vault's own key, once, at startup.
 *
 * ## The migration this exists for
 *
 * Before this change the vault went through `LocalDataProtection.codec` — the same key as history,
 * settings, favicons and everything else. Giving the vault a key of its own means the file on disk is
 * sealed by the *old* key on the first start of the new build, and there is exactly one honest way to
 * handle that: read it with either key, write it with only the new one.
 *
 * The asymmetry is the safety property, and it is worth stating precisely. **Two keys can open the
 * file; one key can produce it.** `isStaleEncoding` reports true for anything the vault key did not
 * seal, so `JsonStore` rewrites the document during `open` — awaited, before anything reads it — and
 * from that moment the local-data key cannot open `passwords.json` again. The window in which both
 * work is one startup wide and closes by itself.
 *
 * What this deliberately does **not** do is raise the protection level. A vault key wrapped by the
 * OS key store is exactly as strong as a local-data key wrapped by the OS key store: both unwrap for
 * whoever is logged in. Raising it needs a master password, which only the user can choose, so the
 * honest move is to say so on the passwords page rather than to imply an upgrade happened here. The
 * migration buys separation — an idle lock, a forgotten master password and a vault reset now cost
 * the credentials and nothing else — and separation is what makes the master password affordable.
 *
 * ## Why the trial decryption is not a weakness
 *
 * Trying one key and falling back to another sounds like the "either layer opens it" mistake
 * `crypto/vault-key.ts` warns about, and it is not the same thing: both keys here are *ours*, both
 * are wrapped by the same key store, and an attacker holding one holds the other. Nothing is widened.
 * The trial is unambiguous because GCM authenticates: a wrong key is a failed tag, never a plausible
 * document.
 */

export interface VaultDocumentCodecOptions {
  readonly vaultKey: Uint8Array
  /**
   * The codec the document was sealed with before the vault had a key.
   *
   * `null` on a profile that never had one — a fresh installation — where a file that the vault key
   * cannot open is simply unreadable and must be reported as such rather than replaced.
   */
  readonly previous: DocumentCodec | null
}

export function createVaultDocumentCodec(options: VaultDocumentCodecOptions): DocumentCodec {
  const openWithVaultKey = (bytes: Uint8Array): Uint8Array | null => {
    if (!isSealedDocument(bytes)) return null
    try {
      return openDocument(options.vaultKey, bytes)
    } catch {
      // A failed tag, a truncated envelope, an unsupported version. All mean the same thing to the
      // caller — this key is not the one — and the caller's next move is the same for all three.
      return null
    }
  }

  return {
    encode: (data) => sealDocument(options.vaultKey, new TextEncoder().encode(JSON.stringify(data))),

    decode: (bytes) => {
      const plaintext = openWithVaultKey(bytes)
      if (plaintext !== null) {
        return JSON.parse(new TextDecoder().decode(plaintext)) as unknown
      }

      if (options.previous !== null) {
        /*
          The old key, and only for reading.

          Whatever the previous codec throws is let out: for the encrypted one that is
          `UnreadableDocumentError`, which is precisely the signal `JsonStore` must not turn into
          defaults — a vault that is still *there* behind a key this process could not get hold of
          must not be overwritten with an empty one on the next flush.
        */
        return options.previous.decode(bytes)
      }

      if (!isSealedDocument(bytes)) {
        // A document from before any encryption existed. Read as it was written and rewritten sealed
        // by the migration below, exactly as `encrypted-codec.ts` does for every other store.
        return plainJsonDocumentCodec.decode(bytes)
      }

      throw new UnreadableDocumentError(
        'the password vault could not be decrypted with this profile’s vault key'
      )
    },

    /**
     * True for anything this key did not seal.
     *
     * Recomputed rather than remembered from the `decode` a moment earlier. A memo would be correct
     * for `JsonStore.open`'s current call order and would become wrong the day that order changed,
     * with the symptom being a vault left under the old key and nothing saying so. One extra AES-GCM
     * pass over a small file, once per start, buys a property that does not depend on a call order in
     * another file.
     */
    isStaleEncoding: (bytes) => openWithVaultKey(bytes) === null
  }
}
