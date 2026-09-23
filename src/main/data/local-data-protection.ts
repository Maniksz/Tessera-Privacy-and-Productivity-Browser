import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { classifyKeystore, type KeystoreStrength } from '../crypto/keystore-strength.js'
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
 *
 * `keystore` is what the key store behind that decision is worth, carried out so
 * the password vault can tell its page the same thing without asking again. See
 * `keystore-strength.ts`.
 */
export type LocalDataProtection =
  | {
      readonly mode: 'os-keystore'
      readonly codec: DocumentCodec
      readonly keystore: Exclude<KeystoreStrength, 'none'>
    }
  | {
      readonly mode: 'unencrypted'
      readonly codec: DocumentCodec
      readonly reason: string
      readonly keystore: Exclude<KeystoreStrength, 'os'>
    }

export interface LocalDataProtectionOptions {
  /** Electron's `safeStorage` satisfies this; a test supplies a fake key store instead. */
  safeStorage: SafeStorageLike
  /** `process.platform`. Decides whether the key store's Linux backend is asked about at all. */
  platform: NodeJS.Platform
  keyFilePath: string
  /** Where the "your data is not encrypted" notice is written, and removed from again. */
  noticeFilePath: string
}

const UNENCRYPTED_REASON = 'the operating system key store reported that encryption is unavailable'

const WEAK_REASON =
  "the operating system key store is Chromium's basic text store, which wraps keys with a key built into the browser"

/**
 * Decides how local documents are protected, and refuses to be quiet about it.
 *
 * Three outcomes, and the second and third are the decisions worth arguing about
 * (a weak key store adds two more, after these):
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
 * A weak key store — Linux's basic text, see `keystore-strength.ts` — answers
 * "available" and protects nothing, so taken at its word it would have been
 * outcome 1 and encryption for show. It is instead:
 *
 *  4. Weak, and nothing has ever been encrypted — outcome 3, with its own reason.
 *     No key is made, so no later start has to honour a key that was never safe.
 *
 *  5. Weak, and this profile has been encrypted before — encrypted as before, with
 *     the notice. Its documents are ciphertext and the key store still unwraps the
 *     key, so going plain would lose them. The key is not re-wrapped either way:
 *     a profile that later started without its keyring would be locked out.
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
  const keystore = classifyKeystore(options.safeStorage, options.platform)
  if (keystore === 'os') {
    const key = await loadOrCreateLocalDataKey({
      safeStorage: options.safeStorage,
      keyFilePath: options.keyFilePath
    })
    // `force` covers the usual case, where there is no notice to withdraw.
    await rm(options.noticeFilePath, { force: true })
    return { mode: 'os-keystore', codec: createEncryptedDocumentCodec(key), keystore }
  }

  const protectedBefore = await localDataKeyExists(options.keyFilePath)
  if (keystore === 'weak') {
    if (protectedBefore) {
      const key = await loadOrCreateLocalDataKey({
        safeStorage: options.safeStorage,
        keyFilePath: options.keyFilePath
      })
      await writeNotice(options.noticeFilePath, 'weak-encrypted')
      console.warn(
        `[data] ${WEAK_REASON}; local documents stay encrypted, but their key is not protected. See ${options.noticeFilePath}`
      )
      return { mode: 'os-keystore', codec: createEncryptedDocumentCodec(key), keystore }
    }
    await writeNotice(options.noticeFilePath, 'weak')
    console.warn(
      `[data] ${WEAK_REASON}; local documents are stored unencrypted. See ${options.noticeFilePath}`
    )
    return { mode: 'unencrypted', codec: plainJsonDocumentCodec, reason: WEAK_REASON, keystore }
  }

  if (protectedBefore) {
    throw new KeystoreUnavailableError(
      `${UNENCRYPTED_REASON}, but ${options.keyFilePath} exists — the documents in this profile are encrypted and cannot be read without it`
    )
  }

  await writeNotice(options.noticeFilePath, 'none')
  console.warn(
    `[data] ${UNENCRYPTED_REASON}; local documents are stored unencrypted. See ${options.noticeFilePath}`
  )
  return {
    mode: 'unencrypted',
    codec: plainJsonDocumentCodec,
    reason: UNENCRYPTED_REASON,
    keystore
  }
}

/** Which notice: no key store, a weak one over plain files, or a weak one over encrypted files. */
type NoticeKind = 'none' | 'weak' | 'weak-encrypted'

interface NoticeOpening {
  readonly en: string
  readonly de: string
}

/** The first paragraph of the notice in each language, per kind. The fix is shared. */
const NOTICE_OPENINGS: Readonly<Record<NoticeKind, NoticeOpening>> = {
  none: {
    en: `tessera: local data is NOT encrypted
=======================================

${UNENCRYPTED_REASON}. Without it there is nowhere to keep an encryption key that
is safe from anyone who can read this folder, so the files here — settings, quick
links, the list of extensions — are stored as readable text.`,
    de: `tessera: lokale Daten sind NICHT verschlüsselt
================================================

Der Schlüsselbund des Betriebssystems ist nicht verfügbar. Damit gibt es keinen
Ort für einen Schlüssel, der vor jedem geschützt ist, der diesen Ordner lesen
kann — die Dateien hier (Einstellungen, Quick Links, Erweiterungen) liegen daher
als lesbarer Text.`
  },
  weak: {
    en: `tessera: local data is NOT encrypted
=======================================

${WEAK_REASON}. A key kept there is safe from nobody who can read this folder, so
the files here — settings, quick links, the list of extensions — are stored as
readable text rather than encrypted for show.`,
    de: `tessera: lokale Daten sind NICHT verschlüsselt
================================================

Der Schlüsselspeicher ist Chromiums „basic text“, der Schlüssel mit einem im
Browser eingebauten Schlüssel umschließt. Ein Schlüssel dort ist vor niemandem
geschützt, der diesen Ordner lesen kann — die Dateien hier (Einstellungen, Quick
Links, Erweiterungen) liegen daher als lesbarer Text statt zum Schein verschlüsselt.`
  },
  'weak-encrypted': {
    en: `tessera: local data is NOT protected by a key store
=====================================================

${WEAK_REASON}. The files here are encrypted and stay so, to remain readable, but
anyone who can read this folder can unwrap the key that opens them.`,
    de: `tessera: lokale Daten sind NICHT durch einen Schlüsselspeicher geschützt
==========================================================================

Der Schlüsselspeicher ist Chromiums „basic text“, der Schlüssel mit einem im
Browser eingebauten Schlüssel umschließt. Die Dateien hier sind verschlüsselt und
bleiben es, damit sie lesbar bleiben — aber wer diesen Ordner lesen kann, kann den
Schlüssel auspacken, der sie öffnet.`
  }
}

/**
 * Writes the notice in both supported languages rather than the chosen one.
 *
 * The language preference lives in the settings file, and this runs at the exact
 * moment reading files is in question — so guessing a locale here would be a guess
 * about the very thing that is broken. Two short paragraphs cost nothing.
 *
 * The fix is the same for all three kinds. For an encrypted profile under basic text
 * it withdraws the notice rather than re-wrapping the key, which this module never
 * does; the sentence about the next start says only what that start will do.
 */
async function writeNotice(noticeFilePath: string, kind: NoticeKind): Promise<void> {
  const opening = NOTICE_OPENINGS[kind]
  const text = `${opening.en}

To fix it, install and unlock a keyring service (gnome-keyring or KWallet on
Linux), do not pass --password-store=basic, and start tessera again. The next
start encrypts files that are still readable and deletes this notice by itself.

${opening.de}

Abhilfe: einen Schlüsselbund-Dienst installieren und entsperren (unter Linux
gnome-keyring oder KWallet), nicht mit --password-store=basic starten, dann
tessera neu starten. Der nächste Start verschlüsselt noch lesbare Dateien und
löscht diesen Hinweis von selbst.
`
  await mkdir(dirname(noticeFilePath), { recursive: true })
  await writeFile(noticeFilePath, text, { mode: 0o600 })
}
