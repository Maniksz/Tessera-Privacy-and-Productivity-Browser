import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  KeystoreUnavailableError,
  loadOrCreateLocalDataKey,
  localDataKeyExists,
  type SafeStorageLike
} from '../crypto/local-data-key.js'
import { createEncryptedDocumentCodec } from './encrypted-codec.js'
import { plainJsonDocumentCodec, type DocumentCodec } from './JsonStore.js'

/**
 * How this profile's documents are protected, and the codec that does it.
 *
 * One decision, made once at startup and handed to every store, so the browser
 * cannot end up with an encrypted quick-links file next to a readable settings one.
 */
export type LocalDataProtection =
  | { readonly mode: 'os-keystore'; readonly codec: DocumentCodec }
  | { readonly mode: 'unencrypted'; readonly codec: DocumentCodec; readonly reason: string }

export interface LocalDataProtectionOptions {
  /** Electron's `safeStorage` satisfies this; a test supplies a fake key store instead. */
  safeStorage: SafeStorageLike
  keyFilePath: string
  /** Where the "your data is not encrypted" notice is written, and removed from again. */
  noticeFilePath: string
}

const UNENCRYPTED_REASON = 'the operating system key store reported that encryption is unavailable'

/**
 * Decides how local documents are protected, and refuses to be quiet about it.
 *
 * Three outcomes, and the second and third are the decisions worth arguing about:
 *
 *  1. A key store is available — documents are encrypted. The normal case on
 *     macOS, Windows, and Linux with a keyring service running.
 *
 *  2. No key store, and this profile has been encrypted before — startup fails.
 *     The files on disk are ciphertext. Continuing in plain text would either fail
 *     to read them or overwrite them with defaults, and both of those look to the
 *     user like the browser lost their settings. A refusal they can act on — unlock
 *     the keyring, restore the keychain entry, then start again — is worth more than
 *     a launch that quietly discards data. This is the same reasoning as
 *     `UnreadableDocumentError`, one level up.
 *
 *  3. No key store, and nothing has ever been encrypted — plain text, loudly.
 *     A Linux desktop without libsecret or KWallet is a real configuration, and a
 *     browser that will not start there is not private, only unavailable. So it
 *     runs — and says so twice. The returned `mode` carries the fact into the
 *     application, and a notice file is written into the profile directory beside
 *     the readable data, because a console warning is something no user ever sees.
 *     The notice is deleted again the moment a key store appears, so it cannot
 *     become a stale warning about a problem that is over.
 *
 * What this will not do is invent protection: a key derived from the machine id, or
 * kept in a file next to the documents, encrypts them against nobody while
 * reporting "encrypted" to the user. Silence and pretence are the two failure modes
 * here, and both are worse than mode 3.
 *
 * @throws KeystoreUnavailableError   outcome 2 above
 * @throws KeyMaterialUnreadableError when a key file exists but cannot be unwrapped
 */
export async function openLocalDataProtection(
  options: LocalDataProtectionOptions
): Promise<LocalDataProtection> {
  if (options.safeStorage.isEncryptionAvailable()) {
    const key = await loadOrCreateLocalDataKey({
      safeStorage: options.safeStorage,
      keyFilePath: options.keyFilePath
    })
    // `force` covers the usual case, where there is no notice to withdraw.
    await rm(options.noticeFilePath, { force: true })
    return { mode: 'os-keystore', codec: createEncryptedDocumentCodec(key) }
  }

  if (await localDataKeyExists(options.keyFilePath)) {
    throw new KeystoreUnavailableError(
      `${UNENCRYPTED_REASON}, but ${options.keyFilePath} exists — the documents in this profile are encrypted and cannot be read without it`
    )
  }

  await writeUnencryptedNotice(options.noticeFilePath)
  console.warn(
    `[data] ${UNENCRYPTED_REASON}; local documents are stored unencrypted. See ${options.noticeFilePath}`
  )
  return { mode: 'unencrypted', codec: plainJsonDocumentCodec, reason: UNENCRYPTED_REASON }
}

/**
 * Writes the notice in both supported languages rather than the chosen one.
 *
 * The language preference lives in the settings file, and this runs at the exact
 * moment reading files is in question — so guessing a locale here would be a guess
 * about the very thing that is broken. Two short paragraphs cost nothing.
 */
async function writeUnencryptedNotice(noticeFilePath: string): Promise<void> {
  const text = `tessera: local data is NOT encrypted
=======================================

${UNENCRYPTED_REASON}. Without it there is nowhere to keep an encryption key that
is safe from anyone who can read this folder, so the files here — settings, quick
links, the list of extensions — are stored as readable text.

To fix it, install and unlock a keyring service (gnome-keyring or KWallet on
Linux) and start tessera again. The next start encrypts the existing files and
deletes this notice by itself.

tessera: lokale Daten sind NICHT verschlüsselt
================================================

Der Schlüsselbund des Betriebssystems ist nicht verfügbar. Damit gibt es keinen
Ort für einen Schlüssel, der vor jedem geschützt ist, der diesen Ordner lesen
kann — die Dateien hier (Einstellungen, Quick Links, Erweiterungen) liegen daher
als lesbarer Text.

Abhilfe: einen Schlüsselbund-Dienst installieren und entsperren (unter Linux
gnome-keyring oder KWallet), dann tessera neu starten. Der nächste Start
verschlüsselt die vorhandenen Dateien und löscht diesen Hinweis von selbst.
`
  await mkdir(dirname(noticeFilePath), { recursive: true })
  await writeFile(noticeFilePath, text, { mode: 0o600 })
}
