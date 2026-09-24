import type { InventoryPath } from '@shared/data/inventory.js'
import { BACKUP_DOCUMENTS, type VaultInBackup } from '@shared/backup/model.js'
import type { BackupArchive } from '@shared/backup/schema.js'
import type { SafeStorageLike } from '../crypto/local-data-key.js'
import {
  masterOnlyVaultKey,
  readVaultKeyFile,
  type MasterOnlyVaultKey,
  type ScryptCost
} from '../crypto/vault-key.js'
import type { DocumentCodec } from '../data/JsonStore.js'
import { DOCUMENT_VERSIONS, SETTINGS_DOCUMENT_VERSION, readIfPresent } from './documents.js'
import { sealBackup } from './format.js'

/**
 * Making a backup (R36, R37): what goes in, read the way the stores wrote it.
 *
 * ## Through the running codec
 *
 * Every document is opened with this profile's codec and carried as the JSON it decodes to, not as
 * the bytes on disk. Those bytes are sealed under `local-data.key`, which is wrapped by this machine's
 * key store and so opens nowhere else (KTD17); the backup is sealed under the passphrase instead, and
 * the restore seals each document again under the codec of the profile it lands in. The caller flushes
 * the stores first, so the files are what the stores hold.
 *
 * ## The vault
 *
 * Carried only when a master password guards it, and then only under the master password: the key
 * store's layer comes off `passwords.key` and the master password's stays (`masterOnlyVaultKey`).
 * `passwords.json` travels as the ciphertext it is, sealed under the vault key, which this module
 * never holds. Without a master password the vault stays out and the reason travels to the page.
 *
 * ## What never goes in
 *
 * Anything not in `BACKUP_DOCUMENTS` or the vault — the keys, the startup flags, the window placement,
 * the extensions list, both notes, the caches — because nothing here reads a path by any other name.
 */

export interface BackupSources {
  /** `inventoryPath` in `paths.ts`. */
  readonly path: (name: InventoryPath) => string
  /** The profile's codec, as the stores were handed it. */
  readonly codec: DocumentCodec
  readonly safeStorage: SafeStorageLike
}

export interface CollectedBackup {
  readonly archive: BackupArchive
  /** The version of every document inside, for the header. */
  readonly documents: Readonly<Record<string, number>>
  readonly vault: VaultInBackup
}

/**
 * The version a stored document says it is. Settings have none; every other store writes a positive
 * whole number, and a document without one is not something the restore could check, so the backup
 * refuses to be made rather than carry it.
 */
function versionOf(name: string, document: unknown): number {
  if (name === 'settingsFile') return SETTINGS_DOCUMENT_VERSION
  const version = (document as { version?: unknown } | null)?.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`${name} has no version the backup could record`)
  }
  return version
}

type VaultEntry = BackupArchive['vault']

interface CollectedVault {
  readonly entry: VaultEntry
  readonly vault: VaultInBackup
}

const left = (reason: Exclude<VaultInBackup, 'included'>): CollectedVault => ({
  entry: { included: false, reason },
  vault: reason
})

/** The vault's key under the master password alone, or why the vault stays out. */
async function masterOnlyKey(
  sources: BackupSources
): Promise<MasterOnlyVaultKey | Exclude<VaultInBackup, 'included'>> {
  let file
  try {
    file = await readVaultKeyFile(sources.path('passwordVaultKeyFile'))
  } catch {
    // Damaged, newer, or not readable at all: nothing a backup can carry the vault behind.
    return 'unreadable'
  }
  if (file === null) return 'no-vault'
  if (file.kdf === null) return 'no-master-password'
  try {
    return masterOnlyVaultKey(file, sources.safeStorage)
  } catch {
    return 'unreadable'
  }
}

/** What a backup made now would do with the vault; the page says it before anything is made. */
export async function vaultInBackup(sources: BackupSources): Promise<VaultInBackup> {
  const key = await masterOnlyKey(sources)
  return typeof key === 'string' ? key : 'included'
}

async function collectVault(sources: BackupSources): Promise<CollectedVault> {
  const key = await masterOnlyKey(sources)
  if (typeof key === 'string') return left(key)
  const document = await readIfPresent(sources.path('passwordsFile'))
  // A key and no document is a vault nothing was ever saved in.
  if (document === null) return left('no-vault')
  return {
    entry: {
      included: true,
      kdf: key.kdf,
      sealedKey: key.sealed,
      document: Buffer.from(document).toString('base64')
    },
    vault: 'included'
  }
}

/** Reads every document of the backup column, and the vault when it may come. */
export async function collectBackup(sources: BackupSources, now: number): Promise<CollectedBackup> {
  const [decoded, { entry, vault }] = await Promise.all([
    Promise.all(
      BACKUP_DOCUMENTS.map(async (name) => {
        const bytes = await readIfPresent(sources.path(name))
        return bytes === null ? null : { name, document: await sources.codec.decode(bytes) }
      })
    ),
    collectVault(sources)
  ])
  // Assembled in `BACKUP_DOCUMENTS` order, whatever order the reads finished in.
  const documents: Record<string, unknown> = {}
  const versions: Record<string, number> = {}
  for (const read of decoded) {
    if (read === null) continue
    versions[read.name] = versionOf(read.name, read.document)
    documents[read.name] = read.document
  }
  if (entry.included) versions['passwordsFile'] = DOCUMENT_VERSIONS.passwordsFile
  return {
    archive: { format: 1, createdAt: now, documents, vault: entry },
    documents: versions,
    vault
  }
}

export interface CreateBackupOptions {
  readonly passphrase: string
  readonly appVersion: string
  readonly now: number
  readonly sources: BackupSources
  /** Test seam for the passphrase's scrypt; see `SealBackupOptions.cost`. */
  readonly cost?: ScryptCost
}

export interface CreatedBackup {
  readonly bytes: Uint8Array
  readonly vault: VaultInBackup
}

/** The whole file: collected, serialised, compressed, sealed. Writing it is the caller's. */
export async function createBackup(options: CreateBackupOptions): Promise<CreatedBackup> {
  const collected = await collectBackup(options.sources, options.now)
  const bytes = await sealBackup({
    passphrase: options.passphrase,
    appVersion: options.appVersion,
    documents: collected.documents,
    payload: new TextEncoder().encode(JSON.stringify(collected.archive)),
    ...(options.cost === undefined ? {} : { cost: options.cost })
  })
  return { bytes, vault: collected.vault }
}
