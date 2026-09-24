import { randomBytes } from 'node:crypto'
import {
  passphraseLongEnough,
  type BackupStatus,
  type CreateBackupOutcome,
  type OpenRestoreOutcome,
  type StageRestoreOutcome,
  type StageRestoreRequest
} from '@shared/backup/model.js'
import type { BackupArchive } from '@shared/backup/schema.js'
import type { SettingsKey } from '@shared/settings/definitions.js'
import type { ScryptCost } from '../crypto/vault-key.js'
import { createBackup, vaultInBackup, type BackupSources } from './create-backup.js'
import { admitBackup } from './documents.js'
import { BackupRefusedError, openBackup } from './format.js'
import {
  itemsOf,
  pendingRestore,
  readArchive,
  settingsToConfirm,
  stageRestore,
  vaultOf,
  type StagingDeps
} from './stage-restore.js'

/**
 * What the settings page's four backup channels do, free of Electron (U23).
 *
 * The dialogs, the file system at the two ends and the stores' flush are handed in, so the order the
 * page's requests obey — the passphrase's length before any dialog, the flush before any read, the
 * refusal before anything is kept — is a test rather than a claim. `ipc/backup-handlers.ts` wires it.
 *
 * ## One decrypted backup at a time
 *
 * Opening a backup decrypts it here and answers a preview with a token; the archive stays in the core
 * until the page stages it or opens another. The page never holds a document, and a token from an
 * earlier preview — or one it made up — stages nothing.
 */

export interface BackupServiceDeps {
  readonly appVersion: string
  readonly sources: BackupSources
  readonly staging: StagingDeps
  /** Writes out what the stores hold, so the files read are current. */
  readonly flush: () => Promise<void>
  /** The save dialog; `null` when it was cancelled. */
  readonly chooseSaveTarget: () => Promise<string | null>
  /** The open dialog; `null` when it was cancelled. */
  readonly chooseBackupFile: () => Promise<string | null>
  /** Atomically, owner-only. */
  readonly writeBackup: (path: string, bytes: Uint8Array) => Promise<void>
  /** `readBackupFile`: refuses by size before reading. */
  readonly readBackup: (path: string) => Promise<Uint8Array>
  /** The settings in force, for what a restore would change. */
  readonly currentSettings: () => Readonly<Record<string, unknown>>
  readonly labelOf: (key: SettingsKey) => string
  readonly now?: () => number
  readonly newToken?: () => string
  /** Test seam for both scrypt runs; see `SealBackupOptions.cost`. */
  readonly cost?: ScryptCost
}

interface Pending {
  readonly token: string
  readonly archive: BackupArchive
}

export class BackupService {
  readonly #deps: BackupServiceDeps
  #pending: Pending | null = null

  constructor(deps: BackupServiceDeps) {
    this.#deps = deps
  }

  async status(): Promise<BackupStatus> {
    const [vault, pending] = await Promise.all([
      vaultInBackup(this.#deps.sources),
      pendingRestore(this.#deps.staging.path)
    ])
    return { vault, pendingRestore: pending }
  }

  async create(request: { passphrase: string }): Promise<CreateBackupOutcome> {
    if (!passphraseLongEnough(request.passphrase)) {
      return { outcome: 'refused', reason: 'passphrase-too-short' }
    }
    const target = await this.#deps.chooseSaveTarget()
    if (target === null) return { outcome: 'cancelled' }
    try {
      await this.#deps.flush()
      const created = await createBackup({
        passphrase: request.passphrase,
        appVersion: this.#deps.appVersion,
        now: (this.#deps.now ?? Date.now)(),
        sources: this.#deps.sources,
        ...(this.#deps.cost === undefined ? {} : { cost: this.#deps.cost })
      })
      await this.#deps.writeBackup(target, created.bytes)
      return { outcome: 'saved', vault: created.vault }
    } catch (error) {
      this.#log('the backup could not be made', error)
      return { outcome: 'failed' }
    }
  }

  async openRestore(request: { passphrase: string }): Promise<OpenRestoreOutcome> {
    // A backup's passphrase was twelve characters when it was made; a shorter one opens nothing.
    if (!passphraseLongEnough(request.passphrase)) {
      return { outcome: 'refused', reason: 'passphrase-too-short' }
    }
    const path = await this.#deps.chooseBackupFile()
    if (path === null) return { outcome: 'cancelled' }
    // Whatever was open before is dropped now, so a refusal below leaves nothing to stage.
    this.#pending = null
    try {
      const bytes = await this.#deps.readBackup(path)
      const { appVersion } = this.#deps
      const opened = await openBackup({
        bytes,
        passphrase: request.passphrase,
        admit: (header) => admitBackup(header, appVersion),
        ...(this.#deps.cost === undefined ? {} : { allowedCost: this.#deps.cost })
      })
      const archive = readArchive(opened.payload, this.#deps.staging.allowedVaultCost)
      const token = (this.#deps.newToken ?? (() => randomBytes(16).toString('hex')))()
      this.#pending = { token, archive }
      return {
        outcome: 'preview',
        preview: {
          token,
          createdAt: archive.createdAt,
          appVersion: opened.header.appVersion,
          items: itemsOf(archive),
          vault: vaultOf(archive),
          settings: settingsToConfirm(archive, this.#deps.currentSettings(), this.#deps.labelOf)
        }
      }
    } catch (error) {
      if (error instanceof BackupRefusedError) return { outcome: 'refused', reason: error.reason }
      this.#log('the backup could not be read', error)
      return { outcome: 'failed' }
    }
  }

  async stage(request: StageRestoreRequest): Promise<StageRestoreOutcome> {
    const pending = this.#pending
    if (pending?.token !== request.token) return { outcome: 'expired' }
    this.#pending = null
    try {
      await stageRestore(
        pending.archive,
        { items: request.items, settings: request.settings },
        this.#deps.staging
      )
      return { outcome: 'staged' }
    } catch (error) {
      this.#log('the restore could not be staged', error)
      return { outcome: 'failed' }
    }
  }

  /** The cause goes to the log and not to the page, which is told only that it did not work. */
  #log(message: string, error: unknown): void {
    console.error(`[backup] ${message}:`, error)
  }
}
