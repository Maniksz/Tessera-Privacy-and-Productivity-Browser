import { rename, rm } from 'node:fs/promises'
import type { InventoryPath } from '@shared/data/inventory.js'
import {
  BACKUP_DOCUMENTS,
  RESTORE_ITEMS,
  VAULT_FILES,
  type RestoreItem,
  type SettingToConfirm,
  type VaultInBackup
} from '@shared/backup/model.js'
import {
  backupArchiveSchema,
  restoreManifestSchema,
  type BackupArchive
} from '@shared/backup/schema.js'
import {
  SETTINGS_KEYS,
  isSecurityRelevant,
  isSettingsKey,
  type SettingsKey
} from '@shared/settings/definitions.js'
import { isSealedDocument } from '../crypto/envelope.js'
import type { SafeStorageLike } from '../crypto/local-data-key.js'
import {
  VAULT_SALT_BYTES,
  VAULT_SCRYPT_COST,
  wrapMasterOnlyVaultKey,
  type ScryptCost
} from '../crypto/vault-key.js'
import { writeFileAtomically } from '../data/atomic-write.js'
import type { DocumentCodec } from '../data/JsonStore.js'
import { safetyCopyOf, stagedCopyOf } from '../data/quarantine.js'
import { compareVersions } from '../updates/version.js'
import { readIfPresent, readableVersion } from './documents.js'
import { BackupRefusedError } from './format.js'

/**
 * Restoring a backup (R38, KTD18): checked, confirmed, staged now, applied at the next start.
 *
 * ## Why at the next start
 *
 * The stores are open while the browser runs, and each writes its file on its own schedule: a
 * document replaced under an open store is overwritten again by its next flush, or worse, merged
 * with it. So the restore only lays the documents out, and `applyStagedRestore` puts them in place
 * during the next start — after the catch-up of both notes and before any store opens (KTD7), so the
 * load pipeline checks each one like any other file (migration, schema, quarantine).
 *
 * ## Where things go
 *
 * Only to `path(name)` for a name in `BACKUP_DOCUMENTS` or the vault's two files, the inventory's
 * table. The archive's schema admits no other name, and nothing here ever reads a path out of it, so
 * an entry called `../local-data.key` has nowhere to land (KTD18). Each document is staged beside its
 * target as `stagedCopyOf(target)` and the target's contents go to `safetyCopyOf(target)` when it is
 * replaced — both copies of the file in `quarantine.ts`'s sense, so clearing, panic and a vault reset
 * take them with the data. `restoreManifestFile` is the commit mark, written last and removed last.
 *
 * ## Crashes
 *
 * - While staging: no manifest yet, and a staging without one is discarded at the next start.
 * - While applying: the manifest is still there, and applying again skips what already moved — a
 *   document whose staged copy is gone is done — so the next start finishes the rest. The vault's
 *   key and document are one item and move one after the other; a crash between them is finished by
 *   the next start before the vault is opened, and a document that fails to move takes its key's
 *   move back with it, so the start that goes on with the restore kept opens the old pair.
 * - A manifest from a newer version is refused and the staging kept, for that version to finish.
 *
 * ## What the person confirms
 *
 * Permissions and filter rules, as items (`CONFIRMED_ITEMS`), and every security-relevant setting
 * whose value differs, one by one. A setting not confirmed is taken out before the document is
 * sealed; applying lays the staged settings over the current file, so it keeps the value in force.
 */

export interface RestoreDeps {
  /** `inventoryPath` in `paths.ts`: the only source of any path written here. */
  readonly path: (name: InventoryPath) => string
  /** This profile's codec. */
  readonly codec: DocumentCodec
  /** This build's version, against which a staged manifest's is compared. */
  readonly appVersion: string
}

export interface StagingDeps extends RestoreDeps {
  /** Puts this machine's key-store layer back over the vault key (KTD17). */
  readonly safeStorage: SafeStorageLike
  /** The vault scrypt a backup may carry. Test seam, as `SealBackupOptions.cost` is. */
  readonly allowedVaultCost?: ScryptCost
}

/** Every file a restore can write, which is every file whose staged copy a new staging clears. */
const RESTORABLE_FILES: readonly InventoryPath[] = [...BACKUP_DOCUMENTS, ...VAULT_FILES]

// --- reading the archive -------------------------------------------------------------------------

function base64Bytes(text: string): Buffer {
  return Buffer.from(text, 'base64')
}

/** A stored document's `version`, whatever the document turned out to be. */
function versionField(document: unknown): unknown {
  return typeof document === 'object' && document !== null
    ? (document as Record<string, unknown>)['version']
    : undefined
}

/**
 * The archive, checked: a known shape, no document newer than this build reads, and a vault whose
 * scrypt is exactly the allowed one — it runs at the next unlock, so a restored key file must not be
 * able to ask for more than the vault ever asks for.
 *
 * @throws BackupRefusedError `not-a-backup` or `newer`
 */
export function readArchive(
  payload: Uint8Array,
  allowedVaultCost: ScryptCost = VAULT_SCRYPT_COST
): BackupArchive {
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(payload))
  } catch {
    throw new BackupRefusedError('not-a-backup')
  }
  const parsed = backupArchiveSchema.safeParse(raw)
  if (!parsed.success) throw new BackupRefusedError('not-a-backup')
  const archive = parsed.data
  for (const name of BACKUP_DOCUMENTS) {
    const document = archive.documents[name]
    if (document === undefined || name === 'settingsFile') continue
    const version = versionField(document)
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      throw new BackupRefusedError('not-a-backup')
    }
    if (!readableVersion(name, version)) throw new BackupRefusedError('newer')
  }
  const { vault } = archive
  if (vault.included) {
    const allowed =
      vault.kdf.n === allowedVaultCost.n &&
      vault.kdf.r === allowedVaultCost.r &&
      vault.kdf.p === allowedVaultCost.p &&
      base64Bytes(vault.kdf.salt).length === VAULT_SALT_BYTES &&
      isSealedDocument(base64Bytes(vault.sealedKey)) &&
      isSealedDocument(base64Bytes(vault.document))
    if (!allowed) throw new BackupRefusedError('not-a-backup')
  }
  return archive
}

/** What the archive holds, in `RESTORE_ITEMS` order. */
export function itemsOf(archive: BackupArchive): RestoreItem[] {
  return RESTORE_ITEMS.filter((item) =>
    item === 'vault' ? archive.vault.included : archive.documents[item] !== undefined
  )
}

export function vaultOf(archive: BackupArchive): VaultInBackup {
  return archive.vault.included ? 'included' : archive.vault.reason
}

function settingsObjectOf(document: unknown): Record<string, unknown> {
  return typeof document === 'object' && document !== null && !Array.isArray(document)
    ? (document as Record<string, unknown>)
    : {}
}

/** Compared as the JSON they are stored as; settings values are JSON by construction. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The security-relevant settings whose value in the backup differs from the one in force, for the
 * person to confirm one by one. A key the backup does not set, or sets to the current value, needs
 * nothing from them.
 */
export function settingsToConfirm(
  archive: BackupArchive,
  current: Readonly<Record<string, unknown>>,
  labelOf: (key: SettingsKey) => string
): SettingToConfirm[] {
  const stored = settingsObjectOf(archive.documents.settingsFile)
  return SETTINGS_KEYS.filter(
    (key) =>
      isSecurityRelevant(key) && Object.hasOwn(stored, key) && !sameValue(stored[key], current[key])
  ).map((key) => ({ key, label: labelOf(key), value: JSON.stringify(stored[key]) }))
}

/**
 * The settings document as it is staged: the keys this build knows, less every security-relevant one
 * the person did not confirm. Nothing unknown is carried, because nothing unknown can be judged.
 */
export function settingsForRestore(
  document: unknown,
  confirmed: readonly string[]
): Record<string, unknown> {
  const stored = settingsObjectOf(document)
  return Object.fromEntries(
    Object.entries(stored).filter(
      ([key]) => isSettingsKey(key) && (!isSecurityRelevant(key) || confirmed.includes(key))
    )
  )
}

// --- staging -------------------------------------------------------------------------------------

export interface RestoreChoice {
  readonly items: readonly RestoreItem[]
  /** The security-relevant settings confirmed. */
  readonly settings: readonly string[]
}

/** The files one chosen item stages, and their bytes: sealed with this profile's codec where ours. */
async function stagedFilesOf(
  item: RestoreItem,
  archive: BackupArchive,
  choice: RestoreChoice,
  deps: StagingDeps
): Promise<Array<readonly [InventoryPath, Uint8Array]>> {
  const { vault } = archive
  if (item === 'vault') {
    if (!vault.included) return []
    const file = wrapMasterOnlyVaultKey(
      { kdf: vault.kdf, sealed: vault.sealedKey },
      deps.safeStorage
    )
    return [
      ['passwordVaultKeyFile', new TextEncoder().encode(JSON.stringify(file))],
      ['passwordsFile', base64Bytes(vault.document)]
    ]
  }
  const document = archive.documents[item]
  if (document === undefined) return []
  const staged = item === 'settingsFile' ? settingsForRestore(document, choice.settings) : document
  return [[item, await deps.codec.encode(staged)]]
}

/**
 * Lays out the chosen items beside their files and writes the manifest last (KTD18).
 *
 * The previous manifest goes first and every earlier staged copy with it, so a staging interrupted
 * here can never be completed by the manifest of another one. An item the backup does not have is
 * not staged, and a confirmed item is staged only when chosen — which is what choosing means.
 */
export async function stageRestore(
  archive: BackupArchive,
  choice: RestoreChoice,
  deps: StagingDeps
): Promise<RestoreItem[]> {
  await rm(deps.path('restoreManifestFile'), { force: true })
  await Promise.all(
    RESTORABLE_FILES.map((name) => rm(stagedCopyOf(deps.path(name)), { force: true }))
  )

  const items: RestoreItem[] = []
  for (const item of RESTORE_ITEMS.filter((candidate) => choice.items.includes(candidate))) {
    const files = await stagedFilesOf(item, archive, choice, deps)
    for (const [name, bytes] of files) {
      await writeFileAtomically(stagedCopyOf(deps.path(name)), bytes, { mode: 0o600 })
    }
    if (files.length > 0) items.push(item)
  }
  const manifest = { format: 1, appVersion: deps.appVersion, items }
  await writeFileAtomically(deps.path('restoreManifestFile'), await deps.codec.encode(manifest), {
    mode: 0o600
  })
  return items
}

/** Whether a restore waits for the next start. */
export async function pendingRestore(path: RestoreDeps['path']): Promise<boolean> {
  return (await readIfPresent(path('restoreManifestFile'))) !== null
}

// --- applying, at the next start -----------------------------------------------------------------

/**
 * What the start found: nothing staged; a staging without a manifest, discarded; a restore put in
 * place; or a staging kept — from a newer version, unreadable now, or stopped by a file that could
 * not be moved, which the next start tries again.
 */
export type ApplyOutcome = 'none' | 'discarded' | 'applied' | 'kept'

/** Removes one file, answering whether it was there. Any failure but its absence is let out. */
async function removeIfPresent(file: string): Promise<boolean> {
  try {
    await rm(file)
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false
    throw error
  }
}

/** Removes every staged copy, answering whether there was one. */
async function discardStaged(path: RestoreDeps['path']): Promise<boolean> {
  const removed = await Promise.all(
    RESTORABLE_FILES.map((name) => removeIfPresent(stagedCopyOf(path(name))))
  )
  return removed.includes(true)
}

/**
 * The staged settings laid over the current ones: what was not staged — an unconfirmed security
 * setting, a key the backup did not have — keeps the value in force. Written back into the staged
 * copy before the move, so applying again after a crash lays the same object over the same file.
 */
async function mergedSettings(
  current: Uint8Array | null,
  staged: Uint8Array,
  codec: DocumentCodec
): Promise<Uint8Array> {
  const now = current === null ? {} : settingsObjectOf(await codec.decode(current))
  const restored = settingsObjectOf(await codec.decode(staged))
  return codec.encode({ ...now, ...restored })
}

/**
 * What one file's apply did: nothing, because its staged copy was gone and it had moved already; put
 * a file where there was none; or replaced one, whose contents are now its safety copy.
 */
type FileApplied = 'moved-already' | 'placed' | 'replaced'

/** One file: its safety copy, then the move. A file whose staged copy is gone has moved already. */
async function applyFile(name: InventoryPath, deps: RestoreDeps): Promise<FileApplied> {
  const target = deps.path(name)
  const staged = stagedCopyOf(target)
  const stagedNow = await readIfPresent(staged)
  if (stagedNow === null) return 'moved-already'
  const current = await readIfPresent(target)
  if (current !== null) {
    await writeFileAtomically(safetyCopyOf(target), current, { mode: 0o600 })
  }
  if (name === 'settingsFile') {
    const merged = await mergedSettings(current, stagedNow, deps.codec)
    await writeFileAtomically(staged, merged, { mode: 0o600 })
  }
  await rename(staged, target)
  return current === null ? 'placed' : 'replaced'
}

/**
 * Takes one file's move back: the restored file goes back to its staged copy, for the next start to
 * move again, and the safety copy back onto the file. Both renames within one directory, and in that
 * order, so a failure halfway leaves the file absent rather than lost: the restored one is staged
 * again and the old one still in its safety copy.
 */
async function undoFile(
  name: InventoryPath,
  applied: FileApplied,
  deps: RestoreDeps
): Promise<void> {
  const target = deps.path(name)
  await rename(target, stagedCopyOf(target))
  if (applied === 'replaced') await rename(safetyCopyOf(target), target)
}

/**
 * The vault's key, then its document, all or nothing within this start. The key is only readable
 * with its own document, and a thrown move keeps the staging but not the start — the vault opens
 * right after — so a document that fails to move sends its key back: the old key with the old
 * document now, and both staged again for the next start. A key moved by an earlier, crashed start
 * is not taken back; the crash note in the module comment covers that one.
 */
async function applyVault(deps: RestoreDeps): Promise<void> {
  const key = await applyFile('passwordVaultKeyFile', deps)
  try {
    await applyFile('passwordsFile', deps)
  } catch (error) {
    if (key !== 'moved-already') await undoFile('passwordVaultKeyFile', key, deps)
    throw error
  }
}

async function apply(deps: RestoreDeps): Promise<ApplyOutcome> {
  const manifestPath = deps.path('restoreManifestFile')
  const bytes = await readIfPresent(manifestPath)
  if (bytes === null) return (await discardStaged(deps.path)) ? 'discarded' : 'none'

  const parsed = restoreManifestSchema.safeParse(await deps.codec.decode(bytes))
  if (!parsed.success) {
    console.warn('[restore] the staged restore has a manifest this version cannot read; kept')
    return 'kept'
  }
  if (compareVersions(parsed.data.appVersion, deps.appVersion) > 0) {
    console.warn('[restore] the staged restore is from a newer version; kept for it to finish')
    return 'kept'
  }
  for (const item of parsed.data.items) {
    if (item === 'vault') await applyVault(deps)
    else await applyFile(item, deps)
  }
  await rm(manifestPath, { force: true })
  return 'applied'
}

/**
 * Puts a staged restore in place. Called once, at startup, after the catch-up and before any store
 * opens (KTD7), and never a reason to refuse the start: whatever goes wrong keeps the staging and the
 * manifest, and the next start tries again.
 */
export async function applyStagedRestore(deps: RestoreDeps): Promise<ApplyOutcome> {
  try {
    return await apply(deps)
  } catch (error) {
    console.warn('[restore] the staged restore could not be applied; kept:', String(error))
    return 'kept'
  }
}
