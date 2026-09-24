import type { InventoryPath } from '../data/inventory.js'

/**
 * The encrypted backup and the restore at the next start (U23, R36–R38), as both sides see it.
 *
 * Pure and free of zod, so the settings page can import it at runtime; the wire schemas are in
 * `schema.ts` beside it, which only the core and the contract read.
 *
 * ## What a backup carries
 *
 * The documents of the inventory's backup column (`src/shared/data/inventory.ts`): the files of the
 * rows marked `yes`, without their directories — the favicon and thumbnail caches are history's, and
 * can be taken again by visiting — and the vault only when a master password guards it (R37). Each is
 * named by the `paths.ts` function that locates it, and that name is the whole of what an archive
 * entry may say about where it goes: the restore resolves it through the inventory, never through a
 * path in the file (KTD18). Tab groups are not here; they hang on the tab ids of one run (R36).
 *
 * Workspaces join `BACKUP_DOCUMENTS` when U21 gives them a file in the profile row. The inventory test
 * that derives this list from the backup column fails until they do, and `DOCUMENT_VERSIONS` in
 * `src/main/backup/documents.ts` is then a compile error until their version is named.
 */
export const BACKUP_DOCUMENTS = [
  'historyFile',
  'permissionsFile',
  'bookmarksFile',
  'quickLinksFile',
  'settingsFile',
  'userRulesFile'
] as const satisfies readonly InventoryPath[]

export type BackupDocument = (typeof BACKUP_DOCUMENTS)[number]

/** The vault's two files, which only ever move together (KTD18). */
export const VAULT_FILES = [
  'passwordsFile',
  'passwordVaultKeyFile'
] as const satisfies readonly InventoryPath[]

/** One thing a restore can put back: a document, or the vault as a whole. */
export type RestoreItem = BackupDocument | 'vault'

export const RESTORE_ITEMS: readonly RestoreItem[] = [...BACKUP_DOCUMENTS, 'vault']

/**
 * What is restored only once the user ticks it (R38): site permissions grant a site the camera or the
 * location, and filter rules decide what is blocked, so a backup somebody else prepared could use
 * either. Security-relevant settings are confirmed one by one; see `SECURITY_RELEVANT_SETTINGS`.
 */
export const CONFIRMED_ITEMS: readonly RestoreItem[] = ['permissionsFile', 'userRulesFile']

/** Q2: at least twelve characters, typed twice on the page. The core checks the length again. */
export const MIN_PASSPHRASE_LENGTH = 12

/** A bound on what crosses IPC; nobody types more, and scrypt is handed nothing unbounded. */
export const MAX_PASSPHRASE_LENGTH = 1024

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Counted in characters a person typed, not in UTF-16 units: an emoji is one, not two. */
export function passphraseLongEnough(passphrase: string): boolean {
  return Array.from(graphemes.segment(passphrase)).length >= MIN_PASSPHRASE_LENGTH
}

/**
 * Whether the vault is in a backup, and when not, why — the reason is shown before and after (U23).
 *
 * `unreadable` is a vault whose key file this run cannot take the key store's layer off — the key store
 * is not there, or the file is damaged or newer — so not even the master password's layer can be
 * carried. `no-vault` is a profile without one.
 */
export const VAULT_IN_BACKUP = ['included', 'no-master-password', 'unreadable', 'no-vault'] as const

export type VaultInBackup = (typeof VAULT_IN_BACKUP)[number]

/**
 * Why a backup was not opened. One sentence each on the page.
 *
 * `wrong-passphrase-or-damaged` is one reason on purpose: a wrong passphrase and a changed byte are
 * both a failed tag, and nothing can tell them apart.
 */
export const BACKUP_REFUSALS = [
  'not-a-backup',
  'too-large',
  'wrong-passphrase-or-damaged',
  'newer',
  'passphrase-too-short'
] as const

export type BackupRefusal = (typeof BACKUP_REFUSALS)[number]

export interface BackupStatus {
  readonly vault: VaultInBackup
  /** A restore is staged and waits for the next start. */
  readonly pendingRestore: boolean
}

export type CreateBackupOutcome =
  | { readonly outcome: 'saved'; readonly vault: VaultInBackup }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'refused'; readonly reason: 'passphrase-too-short' }
  | { readonly outcome: 'failed' }

/** A security-relevant setting whose value in the backup differs from the one in force. */
export interface SettingToConfirm {
  readonly key: string
  readonly label: string
  /** The value the backup would set, as text, so the person can judge it (a proxy address, say). */
  readonly value: string
}

/**
 * What a decrypted backup holds, before anything is staged (R38: preview, then confirmation).
 *
 * `token` names the decrypted archive the core keeps for the answer; the page never holds the data.
 */
export interface RestorePreview {
  readonly token: string
  readonly createdAt: number
  readonly appVersion: string
  /** What the backup has, in `RESTORE_ITEMS` order; the vault only when it is included. */
  readonly items: readonly RestoreItem[]
  readonly vault: VaultInBackup
  readonly settings: readonly SettingToConfirm[]
}

export type OpenRestoreOutcome =
  | { readonly outcome: 'preview'; readonly preview: RestorePreview }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'refused'; readonly reason: BackupRefusal }
  | { readonly outcome: 'failed' }

export interface StageRestoreRequest {
  readonly token: string
  readonly items: readonly RestoreItem[]
  /** The security-relevant settings the person ticked; every other one keeps its current value. */
  readonly settings: readonly string[]
}

export type StageRestoreOutcome =
  { readonly outcome: 'staged' } | { readonly outcome: 'expired' } | { readonly outcome: 'failed' }
