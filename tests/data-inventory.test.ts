import { describe, expect, it } from 'vitest'
import {
  DATA_INVENTORY,
  EVERY_CLEARED_CATEGORY,
  EXIT_CHOOSABLE,
  NEVER_BACKED_UP,
  NOW_CHOOSABLE,
  OUTSIDE_INVENTORY,
  PANIC_CATEGORIES,
  chromiumOf,
  dueForPanic,
  dueNow,
  dueOnExit,
  filesOf,
  rowOf,
  type DataCategory
} from '@shared/data/inventory.js'
import { settingDefinitions } from '@shared/settings/definitions.js'
import { BACKUP_DOCUMENTS, VAULT_FILES } from '@shared/backup/model.js'

/**
 * The data inventory (KTD7): one table that says what each category of data is made of, and which
 * of the ways out — clearing now, clearing on exit, panic, backup — reaches it.
 *
 * Three deletion paths and a backup read it, so the damage these guard against is two of them
 * disagreeing: a history cleared on exit whose thumbnails stay, a panic that forgets the downloads
 * list, a backup that carries the cookies. Where a row is decided by the plan's table, the test
 * spells the decision out rather than re-deriving it from the module.
 */

const categories = (): DataCategory[] => DATA_INVENTORY.map((row) => row.category)

describe('the inventory', () => {
  it('has one row per category, in the order of the plan’s table', () => {
    expect(categories()).toEqual([
      'history',
      'downloads',
      'cookies',
      'networkTraces',
      'storage',
      'cache',
      'session',
      'permissions',
      'inMemory',
      'profile',
      'vault'
    ])
  })

  it('files the favicons, the thumbnails and the closed tabs under history', () => {
    const history = rowOf('history')
    expect(history.files).toEqual(['historyFile', 'faviconCacheDir', 'thumbnailCacheDir'])
    expect(history.memory).toEqual(['closed-tabs'])
  })

  it('keeps the downloaded files out of the downloads list’s sources', () => {
    // The list is what goes; the files are wherever the user saved them, and they stay.
    expect(rowOf('downloads').files).toEqual(['downloadsFile'])
    expect(OUTSIDE_INVENTORY.map((entry) => entry.name)).toContain('defaultDownloadsDir')
  })

  it('reaches the network traces with the cookies and never on their own', () => {
    const network = rowOf('networkTraces')
    expect(network.clearNow).toBe('withCookies')
    expect(network.onExit).toBe('withCookies')
    expect(network.chromium).toEqual(['everything', 'codeCaches', 'hostResolverCache', 'authCache'])
    expect(rowOf('inMemory').onExit).toBe('withCookies')
  })

  it('puts session, tab groups and arrangements in the session row, which only panic reaches', () => {
    const session = rowOf('session')
    expect(session.files).toEqual(['sessionStateFile', 'tabGroupsFile', 'arrangementsFile'])
    expect([session.clearNow, session.onExit, session.panic]).toEqual(['no', 'no', true])
  })

  it('lets panic take the browsing traces and leave the profile and the vault', () => {
    expect(PANIC_CATEGORIES).toEqual([
      'history',
      'downloads',
      'cookies',
      'networkTraces',
      'storage',
      'cache',
      'session',
      'permissions',
      'inMemory'
    ])
    expect(rowOf('profile').panic).toBe(false)
    expect(rowOf('vault').panic).toBe(false)
    // Workspaces are made by hand (U21), so they are the profile's and panic leaves them.
    expect(rowOf('profile').files).toContain('workspacesFile')
  })

  it('backs up what the user made and only that, and the vault only under the master password', () => {
    const backup = Object.fromEntries(DATA_INVENTORY.map((row) => [row.category, row.backup]))
    expect(backup).toEqual({
      history: 'yes',
      downloads: 'no',
      cookies: 'no',
      networkTraces: 'no',
      storage: 'no',
      cache: 'no',
      session: 'no',
      permissions: 'yes',
      inMemory: 'no',
      profile: 'yes',
      vault: 'withMasterPassword'
    })
  })

  it('names the keys, the flags, both notes and the caches as never backed up', () => {
    expect(NEVER_BACKED_UP.files).toEqual(
      expect.arrayContaining([
        'localDataKeyFile',
        'startupFlagsFile',
        'windowPlacementFile',
        'extensionsFile',
        'pendingClearFile',
        'panicPendingFile',
        'filterListCacheDir'
      ])
    )
    expect(NEVER_BACKED_UP.other).toContain('chromium-caches')
  })

  it('makes the backup’s documents exactly the backup column’s files, without their directories (U23)', () => {
    /*
      The hook for workspaces (U21): a file added to a `yes` row fails here until the backup carries
      it, and `DOCUMENT_VERSIONS` then asks for its version at compile time.
    */
    const column = DATA_INVENTORY.filter((row) => row.backup === 'yes')
      .flatMap((row) => row.files)
      .filter((name) => !name.endsWith('Dir'))
    expect([...BACKUP_DOCUMENTS]).toEqual(column)
    expect([...VAULT_FILES]).toEqual(rowOf('vault').files)
    expect(rowOf('vault').backup).toBe('withMasterPassword')
    // The restore's commit mark names items, never contents, and is no backup's business.
    expect(NEVER_BACKED_UP.files).toContain('restoreManifestFile')
  })

  it('files every path in exactly one place', () => {
    const everywhere = [
      ...DATA_INVENTORY.flatMap((row) => row.files),
      ...NEVER_BACKED_UP.files,
      ...OUTSIDE_INVENTORY.map((entry) => entry.name)
    ]
    expect(new Set(everywhere).size).toBe(everywhere.length)
  })

  it('throws for a category it does not have, rather than answering with nothing', () => {
    expect(() => rowOf('formData' as DataCategory)).toThrow(/formData/)
  })
})

describe('what clearing on exit reaches', () => {
  it('offers exactly what the setting offers, and form data is gone from both', () => {
    const offered = settingDefinitions['clearData.onExitCategories'].schema
    // Parsing every member proves the setting accepts them; the set comparison proves nothing else.
    expect(offered.parse([...EXIT_CHOOSABLE])).toEqual([...EXIT_CHOOSABLE])
    expect([...EXIT_CHOOSABLE].sort()).toEqual([
      'cache',
      'cookies',
      'downloads',
      'history',
      'storage'
    ])
    expect(EXIT_CHOOSABLE).not.toContain('formData')
  })

  it('adds the network traces and the in-memory finds when the cookies go', () => {
    expect(dueOnExit(['cookies'])).toEqual(['cookies', 'networkTraces', 'inMemory'])
  })

  it('reaches history and downloads only when they were chosen', () => {
    expect(dueOnExit(['cache'])).toEqual(['cache'])
    expect(dueOnExit(['downloads', 'history'])).toEqual(['history', 'downloads'])
  })

  it('ignores names it does not know and categories exit cannot reach', () => {
    expect(dueOnExit(['formData', 'session', 'vault', 'networkTraces', 'storage'])).toEqual([
      'storage'
    ])
    expect(dueOnExit([])).toEqual([])
  })

  it('falls back to cookies, site storage and cache — never history, downloads or the session', () => {
    expect(EVERY_CLEARED_CATEGORY).toEqual(['cookies', 'storage', 'cache'])
    const due = dueOnExit(EVERY_CLEARED_CATEGORY)
    expect(due).not.toContain('history')
    expect(due).not.toContain('downloads')
    expect(due).not.toContain('session')
  })
})

describe('what clearing now reaches', () => {
  it('offers the same five categories as clearing on exit, in inventory order', () => {
    expect(NOW_CHOOSABLE).toEqual(['history', 'downloads', 'cookies', 'storage', 'cache'])
  })

  it('takes the network traces and the in-memory finds with the cookies, and never the session', () => {
    expect(dueNow(['cookies'])).toEqual(['cookies', 'networkTraces', 'inMemory'])
    expect(dueNow(['cache', 'session', 'permissions', 'inMemory'])).toEqual(['cache'])
    expect(dueNow([])).toEqual([])
  })
})

describe('what a panic note reaches', () => {
  it('takes what the note names among the panic categories and nothing else', () => {
    expect(dueForPanic(['session', 'profile', 'vault', 'bogus', 'history'])).toEqual([
      'history',
      'session'
    ])
  })
})

describe('the parts of a category', () => {
  it('lists the files of several categories in inventory order', () => {
    expect(filesOf(['downloads', 'history'])).toEqual([
      'historyFile',
      'faviconCacheDir',
      'thumbnailCacheDir',
      'downloadsFile'
    ])
    expect(filesOf(['cookies'])).toEqual([])
  })

  it('lists the Chromium operations of several categories, each once', () => {
    expect(chromiumOf(['cache', 'cookies', 'storage'])).toEqual([
      'cookies',
      'siteStorage',
      'httpCache'
    ])
    expect(chromiumOf(['history'])).toEqual([])
  })
})
