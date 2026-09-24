import { app, BaseWindow, dialog, safeStorage } from 'electron'
import type { Locale } from '@shared/i18n/catalog.js'
import { BackupService } from '../backup/backup-service.js'
import { applyStagedRestore, type ApplyOutcome } from '../backup/stage-restore.js'
import { readBackupFile } from '../backup/format.js'
import { writeFileAtomically } from '../data/atomic-write.js'
import type { LocalDataProtection } from '../data/local-data-protection.js'
import { inventoryPath } from '../paths.js'
import { fallbackLabel, settingTextFor } from '../settings/settings-text.js'
import type { SettingsStore } from '../settings/SettingsStore.js'
import type { FlushRegistry } from '../shutdown.js'
import { handle } from './router.js'

/**
 * The backup's four channels, and the Electron they need (U23).
 *
 * Every decision is `BackupService`'s, which is free of Electron and tested; what is here is the two
 * dialogs, the version, the key store and the file at each end — the part only a running browser has,
 * which is why this file sits with `handlers.ts` outside the coverage measure. The page sends a
 * passphrase and a choice; the path is chosen in the dialog the core opens, and the file is read and
 * written here, never sent.
 */

/** The flushes a backup waits for, by the names `index.ts` registers them under. */
const FLUSHED_FIRST = [
  'settings',
  'quicklinks',
  'history',
  'bookmarks',
  'passwords',
  'user-rules',
  'permissions',
  'workspaces'
]

const EXTENSION = 'tessera-backup'

/**
 * Puts the restore the last run staged in place: at startup, after the catch-up and protection and
 * before any store opens (KTD7). Here only for the version and the path table; see `stage-restore.ts`.
 */
export function applyRestoreAtStart(protection: LocalDataProtection): Promise<ApplyOutcome> {
  return applyStagedRestore({
    path: inventoryPath,
    codec: protection.codec,
    appVersion: app.getVersion()
  })
}

/**
 * Registers the channels. Before `registerIpcHandlers`, whose last act checks every one is.
 *
 * `live` is asked when a request comes, not now: the settings store may be gone during a quit, and the
 * language may have changed since. The dialogs are modal to whichever window is focused when they
 * open, which is the settings page's.
 */
export function installBackup(
  protection: LocalDataProtection,
  flushOnExit: FlushRegistry,
  live: () => { readonly settings: SettingsStore | null; readonly locale: Locale }
): void {
  const sources = { path: inventoryPath, codec: protection.codec, safeStorage }
  const filters = [{ name: 'Tessera backup', extensions: [EXTENSION] }]
  const parent = (): BaseWindow => BaseWindow.getFocusedWindow() ?? (undefined as never)
  const service = new BackupService({
    appVersion: app.getVersion(),
    sources,
    staging: { ...sources, appVersion: app.getVersion() },
    flush: async () => {
      const due = flushOnExit.entries().filter((entry) => FLUSHED_FIRST.includes(entry.name))
      await Promise.all(due.map((entry) => entry.flush()))
    },
    chooseSaveTarget: async () => {
      const day = new Date().toISOString().slice(0, 10)
      const chosen = await dialog.showSaveDialog(parent(), {
        defaultPath: `tessera-${day}.${EXTENSION}`,
        filters
      })
      return chosen.canceled || chosen.filePath === '' ? null : chosen.filePath
    },
    chooseBackupFile: async () => {
      const chosen = await dialog.showOpenDialog(parent(), { properties: ['openFile'], filters })
      return chosen.canceled ? null : (chosen.filePaths[0] ?? null)
    },
    writeBackup: (path, bytes) => writeFileAtomically(path, bytes, { mode: 0o600 }),
    readBackup: (path) => readBackupFile(path),
    currentSettings: () => live().settings?.snapshot() ?? {},
    labelOf: (key) => settingTextFor(live().locale, key)?.label ?? fallbackLabel(key)
  })
  handle('backup:status', () => service.status())
  handle('backup:create', ({ passphrase }) => service.create({ passphrase }))
  handle('backup:openRestore', ({ passphrase }) => service.openRestore({ passphrase }))
  handle('backup:stageRestore', ({ token, items, settings: confirmed }) =>
    service.stage({ token, items, settings: confirmed })
  )
}
