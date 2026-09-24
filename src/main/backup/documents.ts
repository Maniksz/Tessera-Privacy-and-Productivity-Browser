import type { BackupDocument, BackupRefusal } from '@shared/backup/model.js'
import type { BackupHeader } from '@shared/backup/schema.js'
import { BOOKMARK_MIGRATIONS } from '../data/BookmarkStore.js'
import { HISTORY_MIGRATIONS } from '../data/HistoryStore.js'
import { PASSWORD_MIGRATIONS } from '../data/PasswordStore.js'
import { PERMISSION_MIGRATIONS } from '../data/PermissionStore.js'
import { QUICK_LINK_MIGRATIONS } from '../data/QuickLinkStore.js'
import { USER_RULE_MIGRATIONS } from '../data/UserRuleStore.js'
import { WORKSPACE_MIGRATIONS } from '../data/WorkspaceStore.js'
import { currentVersionOf } from '../data/store-load.js'
import { compareVersions, parseVersion } from '../updates/version.js'

/**
 * Which version of each document this build writes, and what a backup may therefore bring (AE8).
 *
 * Read off each store's own migration chain rather than written down again, so a store that moves to
 * version 2 moves this with it. A backup naming a later version — or a document this build does not
 * know at all, which is a later build's — is refused before the KDF runs, and nothing is staged.
 */

/**
 * The settings file has no version of its own: it is one object of keys, each checked by its own
 * schema as it is loaded, and a key this build does not know is kept aside rather than refused. So
 * it is version 1 for as long as that is how it is read.
 */
export const SETTINGS_DOCUMENT_VERSION = 1

/**
 * Every document a backup carries, and the vault's.
 *
 * A `Record` over `BackupDocument`, so a document added to the backup (as workspaces were, with U21)
 * is a compile error here until its version is named.
 */
export const DOCUMENT_VERSIONS: Readonly<Record<BackupDocument | 'passwordsFile', number>> = {
  historyFile: currentVersionOf(HISTORY_MIGRATIONS),
  permissionsFile: currentVersionOf(PERMISSION_MIGRATIONS),
  bookmarksFile: currentVersionOf(BOOKMARK_MIGRATIONS),
  quickLinksFile: currentVersionOf(QUICK_LINK_MIGRATIONS),
  settingsFile: SETTINGS_DOCUMENT_VERSION,
  userRulesFile: currentVersionOf(USER_RULE_MIGRATIONS),
  workspacesFile: currentVersionOf(WORKSPACE_MIGRATIONS),
  passwordsFile: currentVersionOf(PASSWORD_MIGRATIONS)
}

/** True for a document of a version this build can read: its own or an older one. */
export function readableVersion(name: string, version: number): boolean {
  // `hasOwn`, so a name such as `toString` is a document nobody knows rather than a prototype's.
  if (!Object.hasOwn(DOCUMENT_VERSIONS, name)) return false
  return version <= (DOCUMENT_VERSIONS as Readonly<Record<string, number>>)[name]!
}

/**
 * The header's answer, before a key is derived: a backup from a newer app, or with a document this
 * build does not know or cannot read, is `newer`; an app version that is not one is not a backup.
 */
export function admitBackup(header: BackupHeader, appVersion: string): BackupRefusal | null {
  if (parseVersion(header.appVersion) === null) return 'not-a-backup'
  if (compareVersions(header.appVersion, appVersion) > 0) return 'newer'
  const newer = Object.entries(header.documents).some(
    ([name, version]) => !readableVersion(name, version)
  )
  return newer ? 'newer' : null
}
