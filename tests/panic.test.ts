import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Panic, type PanicDeps } from '@main/data/panic.js'
import {
  catchUpPendingClears,
  clearOnExit,
  exitNoteAt,
  noteFileAt,
  type ClearableCache,
  type ClearingFiles,
  type ClearingSession
} from '@main/data/clear-data.js'
import { ArrangementStore } from '@main/data/ArrangementStore.js'
import { BookmarkStore } from '@main/data/BookmarkStore.js'
import { DownloadStore } from '@main/data/DownloadStore.js'
import { HistoryStore } from '@main/data/HistoryStore.js'
import { PermissionStore } from '@main/data/PermissionStore.js'
import { SessionStore } from '@main/data/SessionStore.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import { removeCopiesOf } from '@main/data/quarantine.js'
import { DownloadManager } from '@main/downloads/DownloadManager.js'
import { ShutdownSequence, pendingClearText, type After } from '@main/shutdown.js'
import { PANIC_CATEGORIES, type InventoryPath } from '@shared/data/inventory.js'
import type { CapturedWindow } from '@shared/session/model.js'
import type { RestoreSettings } from '@shared/session/restore.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import { FakeItem, FakeSession } from './download-fakes.js'

/**
 * "Delete Everything and Quit" (R15, KTD7): one confirmation, then a fixed order.
 *
 * The note first, so a crash anywhere after it still owes the next start the whole panic; the
 * downloads next, so nothing is still writing a file; then every store of a panic category is stopped
 * for good and its files go with every copy, so no flush on the way out — the session's least of all —
 * can write an open window back; then the quit, and the note last, only once nothing was left behind.
 * Real stores on real files wherever the claim is about the disk, because that is where a trace would be.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

/** The file names `paths.ts` gives, in one temporary profile; the caches in a directory beside it. */
const FILE_NAMES: Partial<Record<InventoryPath, string>> = {
  historyFile: 'history.json',
  downloadsFile: 'downloads.json',
  sessionStateFile: 'session.json',
  tabGroupsFile: 'tab-groups.json',
  arrangementsFile: 'arrangements.json',
  permissionsFile: 'permissions.json',
  bookmarksFile: 'bookmarks.json',
  quickLinksFile: 'quicklinks.json',
  settingsFile: 'settings.json',
  userRulesFile: 'user-rules.json',
  passwordsFile: 'passwords.json',
  passwordVaultKeyFile: 'passwords.key',
  pendingClearFile: 'clear-on-exit-pending.json',
  panicPendingFile: 'panic-pending.json',
  faviconCacheDir: join('cache', 'favicons'),
  thumbnailCacheDir: join('cache', 'thumbnails')
}

interface Profile {
  readonly dir: string
  readonly path: (name: InventoryPath) => string
}

async function profile(): Promise<Profile> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-panic-'))
  return { dir, path: (name) => join(dir, FILE_NAMES[name] ?? name) }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A session that writes down every clearing call. */
function fakeSession(): { session: ClearingSession; calls: string[] } {
  const calls: string[] = []
  const record = (name: string, detail?: unknown): Promise<void> => {
    calls.push(detail === undefined ? name : `${name}:${JSON.stringify(detail)}`)
    return Promise.resolve()
  }
  return {
    calls,
    session: {
      clearStorageData: (options) => record('clearStorageData', options),
      clearCache: () => record('clearCache'),
      clearData: (options) => record('clearData', options),
      clearCodeCaches: (options) => record('clearCodeCaches', options),
      clearHostResolverCache: () => record('clearHostResolverCache'),
      clearAuthCache: () => record('clearAuthCache')
    }
  }
}

/** A cache store that records what was done to it; favicons and thumbnails. */
function fakeCache(name: string, order: string[]): ClearableCache {
  return {
    seal: () => order.push(`${name}.seal`),
    clear: () => {
      order.push(`${name}.clear`)
      return Promise.resolve(0)
    },
    discardCopies: () => {
      order.push(`${name}.discardCopies`)
      return Promise.resolve()
    }
  }
}

/** A timer that never fires: every sequence here settles long before its deadline. */
const never: After = () => () => undefined

const RESTORE: RestoreSettings = {
  wantsRestore: true,
  afterCrash: true,
  restoreLayout: true,
  defaultLayout: '1x1'
}

/** A window with `count` tabs, as a window would hand it to its session slot. */
function windowWithTabs(count: number): CapturedWindow {
  return {
    layout: '1x1',
    fractions: {},
    activeTile: 0,
    tabs: Array.from({ length: count }, (_, index) => ({
      id: `tab-${String(index)}`,
      url: `https://site${String(index)}.example/`,
      pendingInput: null,
      title: `Site ${String(index)}`,
      pinned: false,
      tileIndex: index === 0 ? 0 : null,
      zoomPercent: 100
    }))
  }
}

interface OpenProfile {
  readonly session: SessionStore
  readonly tabGroups: TabGroupStore
  readonly arrangements: ArrangementStore
  readonly permissions: PermissionStore
  readonly history: HistoryStore
  readonly downloads: DownloadStore
  readonly bookmarks: BookmarkStore
}

/** Every store panic stops, opened on the profile as the browser opens them, with a visit and ten tabs. */
async function openProfile(profileDir: Profile): Promise<OpenProfile> {
  const { path } = profileDir
  const session = await SessionStore.open({ filePath: path('sessionStateFile'), debounceMs: 0 })
  const tabGroups = await TabGroupStore.open({ filePath: path('tabGroupsFile'), debounceMs: 0 })
  const arrangements = await ArrangementStore.open({
    filePath: path('arrangementsFile'),
    debounceMs: 0
  })
  const permissions = await PermissionStore.open({
    filePath: path('permissionsFile'),
    debounceMs: 0
  })
  const history = await HistoryStore.open({ filePath: path('historyFile'), debounceMs: 0 })
  const downloads = await DownloadStore.open({ filePath: path('downloadsFile'), debounceMs: 0 })
  const bookmarks = await BookmarkStore.open({ filePath: path('bookmarksFile'), debounceMs: 0 })

  await session.beginRun(RESTORE)
  session.recorderFor('normal').record(windowWithTabs(10))
  tabGroups.create({ tabIds: ['tab-1', 'tab-2'], name: 'Reading' })
  history.recorderFor('normal').recordVisit({ url: 'https://visited.example/' })
  for (const site of ['a', 'b', 'c']) {
    bookmarks.create({ kind: 'bookmark', title: site, url: `https://${site}.example/` })
  }
  await Promise.all(
    [session, tabGroups, arrangements, permissions, history, downloads, bookmarks].map((store) =>
      store.flush()
    )
  )
  return { session, tabGroups, arrangements, permissions, history, downloads, bookmarks }
}

function panicFor(
  profileDir: Profile,
  open: OpenProfile,
  overrides: Partial<PanicDeps> = {}
): { panic: Panic; order: string[]; calls: string[] } {
  const order: string[] = []
  const { session, calls } = fakeSession()
  const panic = new Panic({
    note: noteFileAt(() => profileDir.path('panicPendingFile')),
    downloads: { cancelUnfinished: () => [] },
    stores: [
      open.session,
      open.tabGroups,
      open.arrangements,
      open.permissions,
      open.history,
      open.downloads
    ],
    caches: [fakeCache('favicons', order), fakeCache('thumbnails', order)],
    closeWindows: () => order.push('closeWindows'),
    clearing: { session, path: profileDir.path },
    quit: () => order.push('quit'),
    ...overrides
  })
  return { panic, order, calls }
}

/** The next start, as `index.ts` runs it: the catch-up on the files, then the stores. */
async function restart(profileDir: Profile): Promise<{ calls: string[] }> {
  const { session, calls } = fakeSession()
  await catchUpPendingClears({ session, path: profileDir.path, after: never })
  return { calls }
}

describe('the order panic works in', () => {
  it('writes the note, stops downloads, stops and empties the stores, quits, and removes the note last', async () => {
    const order: string[] = []
    const noteText: string[] = []
    const { session, calls } = fakeSession()
    const stopped = (name: string) => ({
      abandon: () => {
        order.push(`${name}.abandon`)
        return Promise.resolve()
      }
    })
    const files: ClearingFiles = {
      removeFile: (path) => {
        order.push(`removeFile:${path}`)
        return Promise.resolve()
      },
      removeDirectory: (path) => {
        order.push(`removeDirectory:${path}`)
        return Promise.resolve()
      },
      removeCopiesOf: () => Promise.resolve()
    }
    const panic = new Panic({
      note: {
        read: () => Promise.resolve(null),
        write: (text) => {
          noteText.push(text)
          order.push('note.write')
          return Promise.resolve()
        },
        remove: () => {
          order.push('note.remove')
          return Promise.resolve()
        }
      },
      downloads: {
        cancelUnfinished: () => {
          order.push('downloads.cancel')
          return ['/downloads/clip.mp4.part']
        }
      },
      stores: [stopped('session'), stopped('history')],
      caches: [fakeCache('favicons', order)],
      closeWindows: () => order.push('closeWindows'),
      clearing: { session, path: (name) => `/profile/${name}`, files },
      quit: () => order.push('quit')
    })

    await expect(panic.run()).resolves.toBe('complete')

    // Everything panic will delete, in the format both notes share.
    expect(noteText).toEqual([pendingClearText(PANIC_CATEGORIES)])
    const at = (entry: string): number => order.indexOf(entry)
    expect(at('note.write')).toBe(0)
    expect(order[1]).toBe('downloads.cancel')
    expect(order[2]).toBe('removeFile:/downloads/clip.mp4.part')
    expect(at('session.abandon')).toBeGreaterThan(at('downloads.cancel'))
    expect(at('favicons.seal')).toBeGreaterThan(at('history.abandon'))
    expect(at('closeWindows')).toBeGreaterThan(at('favicons.discardCopies'))
    expect(at('removeFile:/profile/sessionStateFile')).toBeGreaterThan(at('closeWindows'))
    expect(at('removeDirectory:/profile/faviconCacheDir')).toBeGreaterThan(at('closeWindows'))
    expect(at('quit')).toBeGreaterThan(at('removeFile:/profile/permissionsFile'))
    expect(order.at(-1)).toBe('note.remove')
    expect(at('note.remove')).toBeGreaterThan(at('quit'))
    // The profile is not in the list at all.
    expect(order.filter((entry) => /bookmarks|passwords|quickLinks|settings/.test(entry))).toEqual(
      []
    )
    // Chromium's part is the whole of it, unfiltered, with every network trace.
    expect(calls).toContain('clearData')
    expect(calls).toEqual(
      expect.arrayContaining([
        'clearCodeCaches:{}',
        'clearHostResolverCache',
        'clearAuthCache',
        'clearCache'
      ])
    )
  })

  it('answers a second press while it runs with the first run, and lets the shutdown wait for it', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    let quits = 0
    const { panic } = panicFor(dir, open, { quit: () => (quits += 1) })

    // Nothing running: the shutdown's wait is over at once.
    await expect(panic.whenIdle()).resolves.toBeUndefined()
    const first = panic.run()
    const second = panic.run()
    expect(second).toBe(first)
    await panic.whenIdle()
    await expect(first).resolves.toBe('complete')
    expect(quits).toBe(1)
  })
})

describe('what panic deletes and what it keeps', () => {
  it('leaves no history, cookies or tabs after a restart, and the three bookmarks where they were (AE4)', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    // What panic must not touch, byte for byte.
    const kept: Array<[InventoryPath, string]> = [
      ['passwordsFile', '{"vault":"sealed"}'],
      ['passwordVaultKeyFile', 'key'],
      ['quickLinksFile', '{"links":[]}'],
      ['settingsFile', '{"version":1}'],
      ['userRulesFile', '{"rules":[]}']
    ]
    for (const [name, text] of kept) await writeFile(dir.path(name), text)
    const bookmarksBefore = await readFile(dir.path('bookmarksFile'), 'utf8')
    const { panic, calls } = panicFor(dir, open)

    await expect(panic.run()).resolves.toBe('complete')
    // Cookies are Chromium's, and go through the session.
    expect(
      calls.some((call) => call.startsWith('clearStorageData:') && call.includes('cookies'))
    ).toBe(true)
    await restart(dir)

    const history = await HistoryStore.open({ filePath: dir.path('historyFile') })
    expect(history.query()).toEqual([])
    const session = await SessionStore.open({ filePath: dir.path('sessionStateFile') })
    expect((await session.beginRun(RESTORE)).kind).not.toBe('restore')
    const bookmarks = await BookmarkStore.open({ filePath: dir.path('bookmarksFile') })
    expect(bookmarks.query({}).filter((node) => node.kind === 'bookmark')).toHaveLength(3)
    expect(await readFile(dir.path('bookmarksFile'), 'utf8')).toBe(bookmarksBefore)
    for (const [name, text] of kept) expect(await readFile(dir.path(name), 'utf8')).toBe(text)
  })

  it('leaves neither session.json nor tab-groups.json.v1.bak, nor any other copy', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    // The migration backup from U2 and a damaged session set aside: both are older sessions.
    await writeFile(`${dir.path('tabGroupsFile')}.v1.bak`, '{"version":1,"groups":[]}')
    await writeFile(`${dir.path('sessionStateFile')}.unreadable`, 'garbage')
    await writeFile(`${dir.path('historyFile')}.v1.bak`, '{"visits":[]}')
    await mkdir(dir.path('faviconCacheDir'), { recursive: true })
    await writeFile(join(dir.path('faviconCacheDir'), 'visited.example'), 'icon')
    const { panic } = panicFor(dir, open)

    await panic.run()
    await restart(dir)

    const left = await readdir(dir.dir)
    expect(
      left.filter((name) =>
        /^(session|tab-groups|history|arrangements|permissions|downloads)\b/.test(name)
      )
    ).toEqual([])
    expect(await exists(dir.path('faviconCacheDir'))).toBe(false)
    expect(await exists(dir.path('panicPendingFile'))).toBe(false)
    expect(left).toContain('bookmarks.json')
  })

  it('lets no store write its file back once panic has stopped it — the session least of all', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    const recorder = open.session.recorderFor('normal')
    const { panic } = panicFor(dir, open)

    await panic.run()
    // What the windows closing and the shutdown's flushes would do next.
    recorder.record(windowWithTabs(3))
    recorder.close()
    open.tabGroups.create({ tabIds: ['late'], name: 'Late' })
    open.history.recorderFor('normal').recordVisit({ url: 'https://late.example/' })
    open.downloads.recorderFor('normal').start({
      id: 'late',
      url: 'https://late.example/file.bin',
      fileName: 'file.bin',
      savePath: join(dir.dir, 'file.bin'),
      mimeType: 'application/octet-stream',
      totalBytes: 1,
      startedAt: 1
    })
    await Promise.all(
      [open.session, open.tabGroups, open.arrangements, open.permissions, open.history].map(
        (store) => store.flush()
      )
    )
    await open.downloads.flush()

    for (const name of [
      'sessionStateFile',
      'tabGroupsFile',
      'arrangementsFile',
      'permissionsFile',
      'historyFile',
      'downloadsFile'
    ] as const) {
      expect(await exists(dir.path(name)), name).toBe(false)
    }
  })
})

describe('a panic that does not finish', () => {
  it('keeps the note when a file is locked, deletes the rest, still quits, and the next start finishes it', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const locked = dir.path('sessionStateFile')
    const files: ClearingFiles = {
      removeFile: async (path) => {
        if (path === locked)
          throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
        const { rm } = await import('node:fs/promises')
        await rm(path, { force: true })
      },
      removeDirectory: async (path) => {
        const { rm } = await import('node:fs/promises')
        await rm(path, { recursive: true, force: true })
      },
      removeCopiesOf: (path) => removeCopiesOf(path)
    }
    const { session } = fakeSession()
    const { panic, order } = panicFor(dir, open, { clearing: { session, path: dir.path, files } })

    await expect(panic.run()).resolves.toBe('incomplete')
    expect(order).toContain('quit')
    expect(await exists(dir.path('panicPendingFile'))).toBe(true)
    expect(await exists(locked)).toBe(true)
    // One locked file does not keep the others: the history is gone already.
    expect(await exists(dir.path('historyFile'))).toBe(false)

    await restart(dir)
    expect(await exists(locked)).toBe(false)
    expect(await exists(dir.path('panicPendingFile'))).toBe(false)
  })

  it('restores no tab after a crash in the middle of it, with restoreAfterCrash on', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    // The note is written and the crash comes before the session file went.
    await writeFile(dir.path('panicPendingFile'), pendingClearText(PANIC_CATEGORIES))
    // The control: without the note this very file would be restored after the crash.
    const control = await profile()
    await writeFile(
      control.path('sessionStateFile'),
      await readFile(dir.path('sessionStateFile'), 'utf8')
    )
    const unpanicked = await SessionStore.open({ filePath: control.path('sessionStateFile') })
    expect((await unpanicked.beginRun(RESTORE)).kind).toBe('restore')
    void open

    await restart(dir)

    expect(await exists(dir.path('sessionStateFile'))).toBe(false)
    const session = await SessionStore.open({ filePath: dir.path('sessionStateFile') })
    expect((await session.beginRun(RESTORE)).kind).not.toBe('restore')
  })

  it('keeps its note through a clearing on exit that succeeds', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const exitNote = exitNoteAt(dir.path)
    await exitNote.arm(true, ['cookies'])
    expect(await exists(dir.path('pendingClearFile'))).toBe(true)
    const { session } = fakeSession()
    const { panic } = panicFor(dir, open, {
      // The permissions file is held by another process.
      clearing: {
        session,
        path: dir.path,
        files: {
          removeFile: (path) =>
            path === dir.path('permissionsFile')
              ? Promise.reject(new Error('EPERM'))
              : import('node:fs/promises').then(({ rm }) => rm(path, { force: true })),
          removeDirectory: (path) =>
            import('node:fs/promises').then(({ rm }) => rm(path, { recursive: true, force: true })),
          removeCopiesOf: (path) => removeCopiesOf(path)
        }
      }
    })
    const finished = new Promise<void>((resolve) => {
      const sequence = new ShutdownSequence({ after: never, finish: () => resolve() })
      void panic.run()
      sequence.beforeQuit(() => ({
        clear: exitNote.clearing((categories) =>
          clearOnExit(categories, {
            session,
            stores: { history: null, downloads: null, favicons: null, thumbnails: null }
          })
        ),
        flushes: [{ name: 'panic', flush: () => panic.whenIdle() }]
      }))
    })
    await finished

    expect(await exists(dir.path('pendingClearFile'))).toBe(false)
    expect(await exists(dir.path('panicPendingFile'))).toBe(true)
  })

  it('still deletes and quits when the note cannot be written, and does not claim to be complete', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const removed: string[] = []
    const { panic, order } = panicFor(dir, open, {
      note: {
        read: () => Promise.resolve(null),
        write: () => Promise.reject(new Error('EROFS')),
        remove: () => {
          removed.push('note')
          return Promise.resolve()
        }
      }
    })

    await expect(panic.run()).resolves.toBe('incomplete')
    expect(order).toContain('quit')
    expect(await exists(dir.path('historyFile'))).toBe(false)
    expect(removed).toEqual([])
  })

  it('reports itself incomplete when the note cannot be removed at the end', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const note = noteFileAt(() => dir.path('panicPendingFile'))
    const { panic } = panicFor(dir, open, {
      note: { ...note, remove: () => Promise.reject(new Error('EACCES')) }
    })

    // The note stays, so the next start repeats a panic that was in fact complete: the safe error.
    await expect(panic.run()).resolves.toBe('incomplete')
    expect(await exists(dir.path('panicPendingFile'))).toBe(true)
    expect(error).toHaveBeenCalledWith(
      '[panic] removing the note failed; the next start finishes it:',
      expect.any(Error)
    )
  })

  it('still quits when closing the windows throws', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let quit = false
    const { panic } = panicFor(dir, open, {
      closeWindows: () => {
        throw new Error('a window would not go')
      },
      quit: () => (quit = true)
    })

    await expect(panic.run()).resolves.toBe('incomplete')
    expect(quit).toBe(true)
    expect(await exists(dir.path('panicPendingFile'))).toBe(true)
  })
})

describe('downloads at panic', () => {
  it('cancels every download still running and removes the partial file of its own transfers', async () => {
    const dir = await profile()
    const open = await openProfile(dir)
    const manager = new DownloadManager({
      store: open.downloads,
      getSettings: () => defaultSettings(),
      defaultDirectory: () => dir.dir,
      fileExists: () => false,
      shell: { openPath: () => Promise.resolve(''), showItemInFolder: () => undefined }
    })
    const browserSession = new FakeSession()
    manager.attach(browserSession, 'normal')
    const running = browserSession.download(new FakeItem('https://example.com/big.iso'))
    const finished = browserSession.download(new FakeItem('https://example.com/done.bin'))
    finished.end('completed')
    const target = join(dir.dir, 'clip.mp4')
    await writeFile(`${target}.part`, 'half a film')
    // Somebody's own file of that name stays: only the partial is Tessera's.
    await writeFile(target, 'an older clip the user kept')
    const aborted: string[] = []
    manager.track({
      windowId: 1,
      session: browserSession,
      fileName: 'clip.mp4',
      targetPath: target,
      cancel: () => aborted.push('clip')
    })
    const { panic } = panicFor(dir, open, { downloads: manager })

    await expect(panic.run()).resolves.toBe('complete')

    expect(running.calls).toContain('cancel')
    expect(finished.calls).not.toContain('cancel')
    expect(aborted).toEqual(['clip'])
    expect(await exists(`${target}.part`)).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('an older clip the user kept')
  })
})
