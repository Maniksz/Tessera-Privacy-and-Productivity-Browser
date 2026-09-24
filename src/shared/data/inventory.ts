/**
 * The data inventory (KTD7): what each category of data is made of, and which way out reaches it.
 *
 * ## Why one table
 *
 * Four things delete or carry data — clearing now, clearing on exit, panic, and the backup — and each
 * used to decide for itself what "history" meant. That is how a clearing ends up emptying the history
 * file while the thumbnails of every page in it stay in the cache, or a backup carries the cookies.
 * Here each category names its files (by the function in `src/main/paths.ts` that locates them),
 * what Chromium keeps for it, and what lives only in memory; and every one of the four reads the
 * same row. The architecture test fails for a path in `paths.ts` that has no row, so a new file
 * cannot be forgotten by all four at once.
 *
 * ## What is not here
 *
 * Paths, Electron, the file system. Names stand in for the functions, so this module is pure and
 * the renderer could read it; `paths.ts` resolves the names, `src/main/data/clear-data.ts` acts.
 */

/**
 * The functions in `src/main/paths.ts` that locate data this inventory accounts for.
 *
 * Spelled out rather than derived, so a row that names a function `paths.ts` does not have is a
 * compile error there (`inventoryPath` is typed against this list) instead of a silent no-op here.
 */
export type InventoryPath =
  | 'historyFile'
  | 'faviconCacheDir'
  | 'thumbnailCacheDir'
  | 'downloadsFile'
  | 'sessionStateFile'
  | 'tabGroupsFile'
  | 'arrangementsFile'
  | 'permissionsFile'
  | 'bookmarksFile'
  | 'quickLinksFile'
  | 'settingsFile'
  | 'userRulesFile'
  | 'passwordsFile'
  | 'passwordVaultKeyFile'
  | 'localDataKeyFile'
  | 'unencryptedDataNoticeFile'
  | 'startupFlagsFile'
  | 'windowPlacementFile'
  | 'extensionsFile'
  | 'pendingClearFile'
  | 'panicPendingFile'
  | 'filterListCacheDir'
  | 'publicSuffixDir'

export type DataCategory =
  | 'history'
  | 'downloads'
  | 'cookies'
  | 'networkTraces'
  | 'storage'
  | 'cache'
  | 'session'
  | 'permissions'
  | 'inMemory'
  | 'profile'
  | 'vault'

/**
 * What Chromium is asked to do for a category.
 *
 * `everything` is `session.clearData()` without a type filter: the only call that reaches the
 * network state Chromium keeps on disk — `Network Persistent State`, `TransportSecurity`, Reporting
 * and NEL. Being unfiltered, it also takes site storage and the cache, which is why the clearing
 * issues it only when those go as well (see `clearChromium`).
 */
export type ChromiumOperation =
  | 'cookies'
  | 'siteStorage'
  | 'httpCache'
  | 'everything'
  | 'codeCaches'
  | 'hostResolverCache'
  | 'authCache'

/** Whether a way out reaches a category: by the user's choice, along with the cookies, or not. */
export type Reach = 'choosable' | 'withCookies' | 'no'

export type BackupRule = 'yes' | 'no' | 'withMasterPassword'

export interface InventoryRow {
  readonly category: DataCategory
  /** Files and directories, by the `paths.ts` function that locates them; copies go with a file. */
  readonly files: readonly InventoryPath[]
  readonly chromium: readonly ChromiumOperation[]
  /** What exists only while the browser runs; a quit takes it, a clearing now has to. */
  readonly memory: readonly string[]
  readonly clearNow: Reach
  readonly onExit: Reach
  readonly panic: boolean
  readonly backup: BackupRule
}

const row = (
  category: DataCategory,
  sources: Pick<InventoryRow, 'files' | 'chromium' | 'memory'>,
  reach: Pick<InventoryRow, 'clearNow' | 'onExit' | 'panic' | 'backup'>
): InventoryRow => ({ category, ...sources, ...reach })

const none = { files: [], chromium: [], memory: [] } as const
const traces = { clearNow: 'choosable', onExit: 'choosable', panic: true, backup: 'no' } as const
const withCookies = { clearNow: 'withCookies', onExit: 'withCookies', panic: true } as const

/** The plan's table, row for row, in its order. */
export const DATA_INVENTORY: readonly InventoryRow[] = [
  row(
    'history',
    {
      // The icons and pictures are of pages visited, so they are history, not cache.
      files: ['historyFile', 'faviconCacheDir', 'thumbnailCacheDir'],
      chromium: [],
      memory: ['closed-tabs']
    },
    { ...traces, backup: 'yes' }
  ),
  // The list, not the files: those are wherever the user saved them, and they stay.
  row('downloads', { ...none, files: ['downloadsFile'] }, traces),
  row('cookies', { ...none, chromium: ['cookies'] }, traces),
  row(
    'networkTraces',
    { ...none, chromium: ['everything', 'codeCaches', 'hostResolverCache', 'authCache'] },
    { ...withCookies, backup: 'no' }
  ),
  row('storage', { ...none, chromium: ['siteStorage'] }, traces),
  row('cache', { ...none, chromium: ['httpCache'] }, traces),
  row(
    'session',
    { ...none, files: ['sessionStateFile', 'tabGroupsFile', 'arrangementsFile'] },
    { clearNow: 'no', onExit: 'no', panic: true, backup: 'no' }
  ),
  row(
    'permissions',
    { ...none, files: ['permissionsFile'] },
    { clearNow: 'no', onExit: 'no', panic: true, backup: 'yes' }
  ),
  row(
    'inMemory',
    { ...none, memory: ['media-finds', 'https-exceptions'] },
    { ...withCookies, backup: 'no' }
  ),
  row(
    'profile',
    // Workspaces join this row when they get a file (U21).
    { ...none, files: ['bookmarksFile', 'quickLinksFile', 'settingsFile', 'userRulesFile'] },
    { clearNow: 'no', onExit: 'no', panic: false, backup: 'yes' }
  ),
  row(
    'vault',
    { ...none, files: ['passwordsFile', 'passwordVaultKeyFile'] },
    { clearNow: 'no', onExit: 'no', panic: false, backup: 'withMasterPassword' }
  )
]

/**
 * What no backup carries and no category owns: keys bound to this machine, files derived from
 * others, both notes, and what can be downloaded again.
 */
export const NEVER_BACKED_UP: {
  readonly files: readonly InventoryPath[]
  readonly other: readonly string[]
} = {
  files: [
    'localDataKeyFile',
    'unencryptedDataNoticeFile',
    'startupFlagsFile',
    'windowPlacementFile',
    'extensionsFile',
    'pendingClearFile',
    'panicPendingFile',
    'filterListCacheDir',
    'publicSuffixDir'
  ],
  other: ['chromium-caches']
}

/** Path functions in `paths.ts` that locate no data of this profile, and why. */
export const OUTSIDE_INVENTORY: ReadonlyArray<{ readonly name: string; readonly reason: string }> =
  [
    {
      name: 'userDataDir',
      reason: 'the root the profile files are placed in, not a file of its own'
    },
    { name: 'cacheDir', reason: 'the root Chromium and the caches are placed in' },
    { name: 'defaultDownloadsDir', reason: 'the user’s own folder; downloaded files stay' },
    { name: 'preloadFile', reason: 'part of the application, not of the profile' }
  ]

/**
 * What an exit note that cannot be read is taken to ask for: the three Chromium categories, which
 * is what clearing on exit could do before it knew history and downloads.
 *
 * Not the full list on purpose (KTD7). A damaged note must never delete a history the user wanted
 * kept; history and downloads are cleared only from a note that says so.
 */
export const EVERY_CLEARED_CATEGORY = ['cookies', 'storage', 'cache'] as const

export function rowOf(category: DataCategory): InventoryRow {
  const found = DATA_INVENTORY.find((entry) => entry.category === category)
  if (found === undefined) throw new Error(`No inventory row for ${category}`)
  return found
}

/** The categories the user can choose to clear on exit — what `clearData.onExitCategories` offers. */
export const EXIT_CHOOSABLE: readonly DataCategory[] = DATA_INVENTORY.filter(
  (entry) => entry.onExit === 'choosable'
).map((entry) => entry.category)

/** Everything panic takes: the browsing traces, never the profile or the vault. */
export const PANIC_CATEGORIES: readonly DataCategory[] = DATA_INVENTORY.filter(
  (entry) => entry.panic
).map((entry) => entry.category)

/** The categories "Clear Browsing Data…" lets the user choose, in inventory order. */
export const NOW_CHOOSABLE: readonly DataCategory[] = DATA_INVENTORY.filter(
  (entry) => entry.clearNow === 'choosable'
).map((entry) => entry.category)

/** What one way out reaches for the categories chosen: the chosen it can reach, and what goes with the cookies. */
function dueBy(way: 'clearNow' | 'onExit', chosen: readonly string[]): DataCategory[] {
  const cookies = chosen.includes('cookies')
  return DATA_INVENTORY.filter(
    (entry) =>
      (entry[way] === 'choosable' && chosen.includes(entry.category)) ||
      (entry[way] === 'withCookies' && cookies)
  ).map((entry) => entry.category)
}

/**
 * What clearing on exit reaches for the categories a user chose: those among them exit can reach,
 * plus what goes with the cookies. In inventory order; names it does not know are ignored, which
 * is what an old note naming `formData` needs.
 */
export function dueOnExit(chosen: readonly string[]): DataCategory[] {
  return dueBy('onExit', chosen)
}

/** The same for clearing now: never the session or the permissions, which only panic takes. */
export function dueNow(chosen: readonly string[]): DataCategory[] {
  return dueBy('clearNow', chosen)
}

/** What a panic note reaches: the panic categories it names, and nothing it does not. */
export function dueForPanic(noted: readonly string[]): DataCategory[] {
  return PANIC_CATEGORIES.filter((category) => noted.includes(category))
}

function inOrder<T>(
  categories: readonly DataCategory[],
  pick: (entry: InventoryRow) => readonly T[]
): T[] {
  const parts = DATA_INVENTORY.filter((entry) => categories.includes(entry.category)).flatMap(pick)
  return [...new Set(parts)]
}

/** The files and directories of these categories, in inventory order. */
export function filesOf(categories: readonly DataCategory[]): InventoryPath[] {
  return inOrder(categories, (entry) => entry.files)
}

/** What Chromium is asked to do for these categories, in inventory order, each once. */
export function chromiumOf(categories: readonly DataCategory[]): ChromiumOperation[] {
  return inOrder(categories, (entry) => entry.chromium)
}
