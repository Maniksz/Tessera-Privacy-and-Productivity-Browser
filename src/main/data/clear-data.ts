import { readFile, rm } from 'node:fs/promises'
import type { Session } from 'electron'
import {
  EVERY_CLEARED_CATEGORY,
  PANIC_CATEGORIES,
  chromiumOf,
  dueForPanic,
  dueOnExit,
  filesOf,
  type DataCategory,
  type InventoryPath
} from '@shared/data/inventory.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { ExitNote, catchUpPendingClear, type After, type NoteFile } from '../shutdown.js'
import { writeFileAtomically } from './atomic-write.js'
import { removeCopiesOf } from './quarantine.js'

/**
 * Clearing browsing data by category, as the inventory describes it (KTD7).
 *
 * ## Two roads to the same result
 *
 * On the way out the stores are open, and the file is theirs: deleting it from under them would be
 * undone by their next flush. So each store is sealed first — as `SessionStore.seal()` is, so a visit
 * arriving while the quit waits cannot write a trace back — then emptied, then has its copies removed,
 * and the flush that follows writes the empty document.
 *
 * At the next start after a crash nothing is open yet, and that is the point of catching up there:
 * the files are removed with their copies before any store reads them, so there is nothing for a
 * store to load. Chromium's part is the same on both roads, through the session.
 *
 * ## What is not here
 *
 * Deciding what a category contains — that is the inventory's — and deciding when the note is kept
 * or removed, which is `shutdown.ts`'s. Stores, the session, the file system and the paths are all
 * handed in, so every rule here is testable without Electron.
 */

/** The part of an Electron session a clearing uses. */
export type ClearingSession = Pick<
  Session,
  | 'clearStorageData'
  | 'clearCache'
  | 'clearData'
  | 'clearCodeCaches'
  | 'clearHostResolverCache'
  | 'clearAuthCache'
>

type StorageType = NonNullable<
  NonNullable<Parameters<Session['clearStorageData']>[0]>['storages']
>[number]

const SITE_STORAGE: readonly StorageType[] = [
  'localstorage',
  'indexdb',
  'serviceworkers',
  'cachestorage',
  'filesystem',
  'shadercache'
]

/**
 * Asks Chromium for what these categories keep there.
 *
 * `everything` is unfiltered, and so takes site storage and the cache along with the network state
 * it is for. It is issued only when those go anyway — which is the default choice and the fallback
 * for an unreadable note — so choosing only the cookies never costs anybody their site storage. The
 * rest of the network traces are targeted and go with the cookies alone.
 */
export async function clearChromium(
  session: ClearingSession,
  due: readonly DataCategory[]
): Promise<void> {
  const operations = chromiumOf(due)
  const storages: StorageType[] = []
  if (operations.includes('cookies')) storages.push('cookies')
  if (operations.includes('siteStorage')) storages.push(...SITE_STORAGE)

  const work: Array<Promise<void>> = []
  if (storages.length > 0) work.push(session.clearStorageData({ storages }))
  if (operations.includes('httpCache')) work.push(session.clearCache())
  const unfiltered = operations.includes('siteStorage') && operations.includes('httpCache')
  if (operations.includes('everything') && unfiltered) work.push(session.clearData())
  if (operations.includes('codeCaches')) work.push(session.clearCodeCaches({}))
  if (operations.includes('hostResolverCache')) work.push(session.clearHostResolverCache())
  if (operations.includes('authCache')) work.push(session.clearAuthCache())
  await Promise.all(work)
}

// --- on the way out: the stores are open ------------------------------------------------------

/** History or the downloads list, as clearing on exit needs it. */
export interface ClearableList {
  seal(): void
  clear(): number
  discardCopies(): Promise<void>
}

/** The favicon or the thumbnail cache, whose clearing removes files and so is asynchronous. */
export interface ClearableCache {
  seal(): void
  clear(): Promise<number>
  discardCopies(): Promise<void>
}

/** The stores clearing on exit empties; `null` for one a quit during startup never opened. */
export interface OpenStores {
  readonly history: ClearableList | null
  readonly downloads: ClearableList | null
  readonly favicons: ClearableCache | null
  readonly thumbnails: ClearableCache | null
}

export interface OpenClearing {
  readonly session: ClearingSession
  readonly stores: OpenStores
}

/** A store a category needs; its absence fails the clearing, which keeps the note. */
function required<T>(store: T | null, name: string): T {
  if (store === null)
    throw new Error(`The ${name} store is not open; clearing is left to the next start`)
  return store
}

async function clearOpenStores(due: readonly DataCategory[], stores: OpenStores): Promise<void> {
  if (due.includes('history')) {
    const history = required(stores.history, 'history')
    const favicons = required(stores.favicons, 'favicons')
    const thumbnails = required(stores.thumbnails, 'thumbnails')
    history.seal()
    favicons.seal()
    thumbnails.seal()
    history.clear()
    await Promise.all([favicons.clear(), thumbnails.clear()])
    await Promise.all([
      history.discardCopies(),
      favicons.discardCopies(),
      thumbnails.discardCopies()
    ])
  }
  if (due.includes('downloads')) {
    const downloads = required(stores.downloads, 'downloads')
    downloads.seal()
    // Keeps what is still running: see `DownloadStore.clear`.
    downloads.clear()
    await downloads.discardCopies()
  }
}

/**
 * What a quit clears for the categories the note owes, with the stores open.
 *
 * Said here as well as failing, because the sequence records only that the clearing failed, not why.
 */
export async function clearOnExit(
  categories: readonly string[],
  { session, stores }: OpenClearing
): Promise<void> {
  const due = dueOnExit(categories)
  try {
    await clearOpenStores(due, stores)
    await clearChromium(session, due)
  } catch (error) {
    console.error('[shutdown] clearing on exit failed:', error)
    throw error
  }
}

// --- at the next start: the stores are closed -------------------------------------------------

/** Removing from the disk, as the catch-up needs it. Every one succeeds for what is already gone. */
export interface ClearingFiles {
  readonly removeFile: (path: string) => Promise<void>
  readonly removeDirectory: (path: string) => Promise<void>
  readonly removeCopiesOf: (path: string) => Promise<void>
}

const nodeClearingFiles: ClearingFiles = {
  removeFile: (path) => rm(path, { force: true }),
  removeDirectory: (path) => rm(path, { recursive: true, force: true }),
  removeCopiesOf: (path) => removeCopiesOf(path)
}

export interface FileClearing {
  readonly session: ClearingSession
  /** Where an inventory path is; `inventoryPath` in `paths.ts`. */
  readonly path: (name: InventoryPath) => string
  readonly files?: ClearingFiles
}

/** Removes these categories' files with their copies and their directories whole, then Chromium's part. */
export async function clearFilesOf(
  due: readonly DataCategory[],
  { session, path, files = nodeClearingFiles }: FileClearing
): Promise<void> {
  for (const name of filesOf(due)) {
    const target = path(name)
    if (name.endsWith('Dir')) {
      await files.removeDirectory(target)
      continue
    }
    await files.removeFile(target)
    await files.removeCopiesOf(target)
  }
  await clearChromium(session, due)
}

/** A note on disk: missing reads as `null`; written owner-only and atomically. */
export function noteFileAt(path: () => string): NoteFile {
  return {
    read: () =>
      readFile(path(), 'utf8').catch((error: unknown) => {
        if ((error as { code?: string }).code === 'ENOENT') return null
        throw error
      }),
    write: (text) => writeFileAtomically(path(), text, { mode: 0o600 }),
    remove: () => rm(path(), { force: true })
  }
}

export interface StartupClearing extends FileClearing {
  readonly after: After
}

/**
 * Both notes, on the files, before protection, settings or any store opens (KTD7).
 *
 * Before the settings on purpose: the note is what the user asked for when it was written, and a
 * setting read now would be this run's answer to a question the last one already settled. The panic
 * note first, because it is the larger promise; each keeps its note when its clearing does not
 * finish, and neither ever refuses the start.
 */
export async function catchUpPendingClears(deps: StartupClearing): Promise<void> {
  const notes = [
    {
      name: 'panic',
      file: noteFileAt(() => deps.path('panicPendingFile')),
      fallback: PANIC_CATEGORIES,
      due: dueForPanic
    },
    {
      name: 'clear-on-exit',
      file: noteFileAt(() => deps.path('pendingClearFile')),
      fallback: EVERY_CLEARED_CATEGORY,
      due: dueOnExit
    }
  ]
  for (const note of notes) {
    await catchUpPendingClear({
      read: note.file.read,
      clear: (categories) => clearFilesOf(note.due(categories), deps),
      forget: note.file.remove,
      fallback: note.fallback,
      after: deps.after
    })
      .then((outcome) => {
        if (outcome === 'still-pending') {
          console.warn(`[${note.name}] the clearing from the last run did not finish again; kept`)
        }
      })
      .catch((error: unknown) => {
        console.warn(
          `[${note.name}] the note from the last run could not be handled:`,
          String(error)
        )
      })
  }
}

// --- while the browser runs --------------------------------------------------------------------

/** The exit note of this profile, with the fallback an unreadable one is merged as. */
export function exitNoteAt(path: (name: InventoryPath) => string): ExitNote {
  return new ExitNote(
    noteFileAt(() => path('pendingClearFile')),
    EVERY_CLEARED_CATEGORY
  )
}

/** The two settings the note follows, as `SettingsStore` offers them. */
export interface ExitNoteSettings {
  snapshot(): SettingsSnapshot
  onChange(listener: (change: { readonly snapshot: SettingsSnapshot }) => void): () => void
}

/**
 * Arms the note from the settings and keeps it in step with them (KTD7).
 *
 * A note that cannot be written is said out loud and does not stop the start: the clearing on exit
 * still runs at the quit; what is lost is only the catch-up after a crash.
 */
export async function watchExitNote(note: ExitNote, settings: ExitNoteSettings): Promise<void> {
  const warn = (error: unknown): void => {
    console.warn('[clear-on-exit] the note could not be written:', String(error))
  }
  settings.onChange(({ snapshot }) => {
    note.want(snapshot['clearData.onExit'], snapshot['clearData.onExitCategories']).catch(warn)
  })
  const now = settings.snapshot()
  await note.arm(now['clearData.onExit'], now['clearData.onExitCategories']).catch(warn)
}
