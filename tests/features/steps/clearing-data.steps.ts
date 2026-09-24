import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import type { BaseWindow } from 'electron'
import { ArrangementStore } from '@main/data/ArrangementStore.js'
import { BookmarkStore } from '@main/data/BookmarkStore.js'
import { DownloadStore } from '@main/data/DownloadStore.js'
import { HistoryStore } from '@main/data/HistoryStore.js'
import { PermissionStore } from '@main/data/PermissionStore.js'
import { SessionStore } from '@main/data/SessionStore.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import { catchUpPendingClears, type ClearingSession } from '@main/data/clear-data.js'
import {
  installMenuActions,
  type ActionWindow,
  type MenuActions,
  type MessageBox
} from '@main/menu/menu-actions.js'
import { pendingClearText } from '@main/shutdown.js'
import { PANIC_CATEGORIES, type InventoryPath } from '@shared/data/inventory.js'
import type { RestoreSettings } from '@shared/session/restore.js'
import { scope } from './world.js'

/**
 * Steps for `clearing-data.feature`.
 *
 * The real actions over real stores in a temporary profile, wired by `installMenuActions` exactly as
 * `index.ts` wires them. What Electron would be — the windows, the two sessions, the native dialog, the
 * quit — are plain objects that write down what was asked of them. "Tessera starts again" is what
 * `index.ts` does first: the catch-up on the files, then the stores, then the session's plan.
 */

interface Window extends ActionWindow {
  readonly window: BaseWindow
}

interface ClearingWorld {
  readonly path: (name: InventoryPath) => string
  readonly history: HistoryStore
  readonly stopped: Array<{ abandon(): Promise<void> }>
  readonly downloads: DownloadStore
  bookmarks: BookmarkStore
  /** Most recently focused first. */
  windows: Window[]
  readonly sessions: { readonly normal: ClearingSession; readonly private: ClearingSession }
  /** Every call the sessions got, as `normal.clearCache` and the like, and `quit`. */
  readonly calls: string[]
  readonly notices: MessageBox[]
  /** The label pressed in the next dialogue; its cancel button when none. */
  answer: string | null
  newerBookmarks: string | null
  restart: { restored: boolean; visits: number; bookmarks: number } | null
}

const KEY = 'clearingDataWorld'

const RESTORE: RestoreSettings = {
  wantsRestore: true,
  afterCrash: true,
  restoreLayout: true,
  defaultLayout: '1x1'
}

function world(state: unknown): ClearingWorld {
  const held = scope(state).scratch[KEY]
  if (held === undefined) throw new Error('this scenario has no profile; add the Background')
  return held as ClearingWorld
}

function recordingSession(name: string, calls: string[]): ClearingSession {
  const record = (call: string) => (): Promise<void> => {
    calls.push(`${name}.${call}`)
    return Promise.resolve()
  }
  return {
    clearStorageData: record('clearStorageData'),
    clearCache: record('clearCache'),
    clearData: record('clearData'),
    clearCodeCaches: record('clearCodeCaches'),
    clearHostResolverCache: record('clearHostResolverCache'),
    clearAuthCache: record('clearAuthCache')
  }
}

function window(url: string, privateMode: boolean): Window {
  return {
    privateMode,
    window: Object.create(null) as BaseWindow,
    activeTab: () => ({ toState: () => ({ url, title: 'Work' }) }),
    forgetClosedTabs: () => undefined
  }
}

function actions(state: unknown): MenuActions<Window, ClearingSession> {
  const current = world(state)
  return installMenuActions<Window, ClearingSession>({
    windows: {
      byRecentFocus: current.windows,
      sessionOf: (open) => (open.privateMode ? current.sessions.private : current.sessions.normal),
      closeAll: () => current.calls.push('closeAll')
    },
    electron: {
      dialog: {
        showMessageBox: ((_parent: unknown, box: MessageBox) => {
          current.notices.push(box)
          const pressed = current.answer === null ? -1 : box.buttons.indexOf(current.answer)
          return Promise.resolve({ response: pressed < 0 ? box.cancelId : pressed })
        }) as never
      },
      defaultSession: current.sessions.normal,
      quit: () => current.calls.push('quit')
    },
    bookmarks: current.bookmarks,
    stores: {
      history: current.history,
      downloads: current.downloads,
      favicons: {
        seal: () => undefined,
        clear: () => Promise.resolve(0),
        discardCopies: () => Promise.resolve()
      },
      thumbnails: {
        seal: () => undefined,
        clear: () => Promise.resolve(0),
        discardCopies: () => Promise.resolve()
      }
    },
    stopped: current.stopped,
    downloads: { cancelUnfinished: () => [] },
    media: { forgetAll: () => undefined },
    locale: () => 'en',
    path: current.path
  })
}

Given(
  'a profile with a visit to {string}, ten open tabs and three bookmarks',
  async (state: unknown, visited: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-clearing-'))
    const path = (name: InventoryPath): string => join(dir, name)
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
    session.recorderFor('normal').record({
      layout: '1x1',
      fractions: {},
      activeTile: 0,
      tabs: Array.from({ length: 10 }, (_, index) => ({
        id: `tab-${String(index)}`,
        url: `https://site${String(index)}.example/`,
        pendingInput: null,
        title: `Site ${String(index)}`,
        pinned: false,
        tileIndex: index === 0 ? 0 : null,
        zoomPercent: 100
      }))
    })
    history.recorderFor('normal').recordVisit({ url: visited })
    for (const site of ['a', 'b', 'c']) {
      bookmarks.create({ kind: 'bookmark', title: site, url: `https://${site}.example/` })
    }
    await Promise.all([session.flush(), history.flush(), bookmarks.flush()])

    const calls: string[] = []
    const held: ClearingWorld = {
      path,
      history,
      stopped: [session, tabGroups, arrangements, permissions],
      downloads,
      bookmarks,
      windows: [],
      sessions: {
        normal: recordingSession('normal', calls),
        private: recordingSession('private', calls)
      },
      calls,
      notices: [],
      answer: null,
      newerBookmarks: null,
      restart: null
    }
    scope(state).scratch[KEY] = held
  }
)

Given(
  'a normal window on {string} focused last, and no window focused now',
  (state: unknown, url: string) => {
    // No `focused()` anywhere: the actions only ever ask for the order windows were focused in.
    world(state).windows = [window(url, false)]
  }
)

Given('a private window focused last', (state: unknown) => {
  const current = world(state)
  current.windows = [window('https://private.example/', true), ...current.windows]
})

Given('the bookmarks file was written by a newer version of Tessera', async (state: unknown) => {
  const current = world(state)
  const text = JSON.stringify({ version: 99, nodes: [] })
  await writeFile(current.path('bookmarksFile'), text)
  current.bookmarks = await BookmarkStore.open({ filePath: current.path('bookmarksFile') })
  current.newerBookmarks = text
})

Given('a panic that crashed right after writing its note', async (state: unknown) => {
  await writeFile(world(state).path('panicPendingFile'), pendingClearText(PANIC_CATEGORIES))
})

When('I press Strg+D', async (state: unknown) => {
  await actions(state).addBookmark()
})

When('I clear browsing data choosing {string}', async (state: unknown, label: string) => {
  world(state).answer = label
  await actions(state).clearData()
})

When('I choose "Delete Everything and Quit" and confirm it', async (state: unknown) => {
  world(state).answer = 'Delete and Quit'
  const menu = actions(state)
  await menu.panic()
  await menu.whenIdle()
})

When('I choose "Delete Everything and Quit" and cancel it', async (state: unknown) => {
  world(state).answer = null
  await actions(state).panic()
})

When('Tessera starts again', async (state: unknown) => {
  const current = world(state)
  await catchUpPendingClears({
    session: recordingSession('next', []),
    path: current.path,
    after: () => () => undefined
  })
  const session = await SessionStore.open({ filePath: current.path('sessionStateFile') })
  const history = await HistoryStore.open({ filePath: current.path('historyFile') })
  const bookmarks = await BookmarkStore.open({ filePath: current.path('bookmarksFile') })
  current.restart = {
    restored: (await session.beginRun(RESTORE)).kind === 'restore',
    visits: history.query().length,
    bookmarks: bookmarks.query({}).filter((node) => node.kind === 'bookmark').length
  }
})

Then('{string} is bookmarked', (state: unknown, url: string) => {
  expect(world(state).bookmarks.isBookmarked(url)).toBe(true)
})

Then('{string} is bookmarked once', (state: unknown, url: string) => {
  expect(world(state).bookmarks.forUrl(url)).toHaveLength(1)
})

Then('a notice says {string}', (state: unknown, message: string) => {
  expect(world(state).notices.map((box) => box.message)).toEqual([message])
})

Then('the bookmarks file is as the newer version wrote it', async (state: unknown) => {
  const current = world(state)
  expect(await readFile(current.path('bookmarksFile'), 'utf8')).toBe(current.newerBookmarks)
})

Then('the history still holds {string}', (state: unknown, url: string) => {
  expect(
    world(state)
      .history.query()
      .map((visit) => visit.url)
  ).toContain(url)
})

Then('only the cache of the normal session was cleared', (state: unknown) => {
  expect(world(state).calls).toEqual(['normal.clearCache'])
})

Then('the normal session was not touched', (state: unknown) => {
  const { calls } = world(state)
  expect(calls.filter((call) => call.startsWith('normal.'))).toEqual([])
  expect(calls).toContain('private.clearData')
})

Then('Tessera quits', (state: unknown) => {
  expect(world(state).calls).toContain('quit')
})

Then('Tessera is still running', (state: unknown) => {
  expect(world(state).calls).not.toContain('quit')
})

Then('the history is empty', (state: unknown) => {
  expect(world(state).restart?.visits).toBe(0)
})

Then('no tab comes back', (state: unknown) => {
  expect(world(state).restart?.restored).toBe(false)
})

Then('the three bookmarks are still there', (state: unknown) => {
  expect(world(state).restart?.bookmarks).toBe(3)
})
