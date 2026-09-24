import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BaseWindow, MenuItemConstructorOptions } from 'electron'
import {
  CLEAR_NOW_PRESETS,
  MenuActions,
  installMenuActions,
  type ActionWindow,
  type MenuActionDeps,
  type MessageBox
} from '@main/menu/menu-actions.js'
import { buildApplicationMenu, type MenuDeps } from '@main/menu/appMenu.js'
import { menuLabel } from '@main/menu/menu-text.js'
import { BookmarkStore } from '@main/data/BookmarkStore.js'
import { DownloadStore } from '@main/data/DownloadStore.js'
import { HistoryStore } from '@main/data/HistoryStore.js'
import type { ClearableCache, ClearingSession, OpenStores } from '@main/data/clear-data.js'
import { httpsExemptionsFor } from '@main/privacy/https-exemptions.js'
import type { InventoryPath } from '@shared/data/inventory.js'
import type { Platform } from '@shared/model.js'

// Hoisted above the imports, as in `menu-text.test.ts`: the template is what Electron would be given.
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: unknown) => template,
    setApplicationMenu: () => undefined
  },
  app: { name: 'Tessera' }
}))

/**
 * The three menu actions that run in the core (KTD6): Strg+D, "Clear Browsing Data…" and "Delete
 * Everything and Quit".
 *
 * Each used to be an emit to the focused window's chrome, which had no case for any of them. So each is
 * tested here for what it does and for the one situation that emit could never handle — no window of
 * ours focused (R16): the menu bar on macOS with another application in front, a shortcut arriving
 * while a dialogue has the focus.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

interface FakeWindow extends ActionWindow {
  readonly name: string
  readonly window: BaseWindow
  closedTabsForgotten: number
}

function fakeWindow(
  name: string,
  options: { privateMode?: boolean; url?: string | null; title?: string } = {}
): FakeWindow {
  const url = options.url === undefined ? `https://${name}.example/` : options.url
  return {
    name,
    privateMode: options.privateMode ?? false,
    window: { name } as unknown as BaseWindow,
    closedTabsForgotten: 0,
    activeTab: () =>
      url === null ? undefined : { toState: () => ({ url, title: options.title ?? name }) },
    forgetClosedTabs(): void {
      this.closedTabsForgotten += 1
    }
  }
}

/** A session that writes down every clearing call, under a name so two can be told apart. */
function fakeSession(name: string, log: string[]): ClearingSession {
  const record = (call: string): Promise<void> => {
    log.push(`${name}.${call}`)
    return Promise.resolve()
  }
  return {
    clearStorageData: () => record('clearStorageData'),
    clearCache: () => record('clearCache'),
    clearData: () => record('clearData'),
    clearCodeCaches: () => record('clearCodeCaches'),
    clearHostResolverCache: () => record('clearHostResolverCache'),
    clearAuthCache: () => record('clearAuthCache')
  }
}

function fakeCache(name: string, log: string[]): ClearableCache {
  return {
    seal: () => log.push(`${name}.seal`),
    clear: () => {
      log.push(`${name}.clear`)
      return Promise.resolve(0)
    },
    discardCopies: () => Promise.resolve()
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tessera-menu-actions-'))
}

interface Harness {
  actions: MenuActions<FakeWindow, ClearingSession>
  deps: MenuActionDeps<FakeWindow, ClearingSession>
  asked: Array<{ window: FakeWindow | undefined; box: MessageBox }>
  log: string[]
  bookmarks: BookmarkStore
  history: HistoryStore
  panics: number
  forgotten: ClearingSession[]
  sessions: { normal: ClearingSession; private: ClearingSession }
}

/**
 * The actions over two windows, the more recently focused first, neither of them focused now.
 *
 * `answer` is what the person presses in whatever dialogue comes up, by its label.
 */
async function harness(
  options: {
    windows?: FakeWindow[]
    answer?: (box: MessageBox) => string
    bookmarks?: BookmarkStore
  } = {}
): Promise<Harness> {
  const dir = await tempDir()
  const log: string[] = []
  const sessions = { normal: fakeSession('default', log), private: fakeSession('private', log) }
  const windows = options.windows ?? [fakeWindow('recent'), fakeWindow('older')]
  const bookmarks =
    options.bookmarks ??
    (await BookmarkStore.open({ filePath: join(dir, 'bookmarks.json'), debounceMs: 0 }))
  const history = await HistoryStore.open({ filePath: join(dir, 'history.json'), debounceMs: 0 })
  const downloads = await DownloadStore.open({
    filePath: join(dir, 'downloads.json'),
    debounceMs: 0
  })
  history.recorderFor('normal').recordVisit({ url: 'https://visited.example/' })
  const stores: OpenStores = {
    history,
    downloads,
    favicons: fakeCache('favicons', log),
    thumbnails: fakeCache('thumbnails', log)
  }
  const asked: Harness['asked'] = []
  const forgotten: ClearingSession[] = []
  const state = { panics: 0 }
  const deps: MenuActionDeps<FakeWindow, ClearingSession> = {
    windows: {
      byRecentFocus: windows,
      sessionOf: (window) => (window.privateMode ? sessions.private : sessions.normal)
    },
    defaultSession: sessions.normal,
    bookmarks,
    stores,
    forgetSession: (session) => forgotten.push(session),
    ask: (window, box) => {
      asked.push({ window, box })
      const label = options.answer?.(box) ?? box.buttons[box.cancelId]!
      return Promise.resolve(box.buttons.indexOf(label))
    },
    locale: () => 'en',
    panic: {
      run: () => {
        state.panics += 1
        return Promise.resolve('complete')
      },
      whenIdle: () => Promise.resolve()
    }
  }
  const actions = new MenuActions(deps)
  return {
    actions,
    deps,
    asked,
    log,
    bookmarks,
    history,
    get panics() {
      return state.panics
    },
    forgotten,
    sessions
  }
}

const en = (key: Parameters<typeof menuLabel>[1]): string => menuLabel('en', key)

describe('Strg+D', () => {
  it('bookmarks the active page of the window focused last, with no window focused now (R16)', async () => {
    const { actions, bookmarks, asked } = await harness()

    await actions.addBookmark()

    expect(bookmarks.isBookmarked('https://recent.example/')).toBe(true)
    expect(bookmarks.isBookmarked('https://older.example/')).toBe(false)
    const [created] = bookmarks.query({ text: 'recent.example' })
    expect(created).toMatchObject({ title: 'recent', url: 'https://recent.example/' })
    expect(asked).toEqual([])
  })

  it('does not bookmark a page that is saved already', async () => {
    const { actions, bookmarks } = await harness()
    await actions.addBookmark()
    await actions.addBookmark()
    expect(bookmarks.forUrl('https://recent.example/')).toHaveLength(1)
  })

  it('bookmarks the address a failed page was going to, which is what the tab reports', async () => {
    // A tab whose load failed (U9) still reports where it was going, not the error page.
    const failed = fakeWindow('failed', { url: 'https://unreachable.example/page', title: '' })
    const { actions, bookmarks } = await harness({ windows: [failed] })
    await actions.addBookmark()
    expect(bookmarks.isBookmarked('https://unreachable.example/page')).toBe(true)
  })

  it('says so in a native notice when the bookmarks file is read-only, and throws nothing (R13)', async () => {
    const dir = await tempDir()
    const filePath = join(dir, 'bookmarks.json')
    // Written by a newer version: shown, and every write refused for this run.
    const newer = JSON.stringify({ version: 99, nodes: [] })
    await writeFile(filePath, newer)
    const readOnly = await BookmarkStore.open({ filePath, debounceMs: 0 })
    const { actions, asked } = await harness({ bookmarks: readOnly })

    await expect(actions.addBookmark()).resolves.toBeUndefined()

    expect(asked).toHaveLength(1)
    expect(asked[0]?.window?.name).toBe('recent')
    expect(asked[0]?.box).toMatchObject({
      type: 'warning',
      message: en('bookmarks.readOnly.message'),
      buttons: [en('bookmarks.readOnly.ok')]
    })
    expect(asked[0]?.box.detail).toContain('newer version')
    expect(await readFile(filePath, 'utf8')).toBe(newer)
  })

  it('logs, rather than throws, any other refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refusing = await harness({
      bookmarks: {
        isBookmarked: () => false,
        create: () => {
          throw new Error('the limit')
        }
      } as unknown as BookmarkStore
    })

    await expect(refusing.actions.addBookmark()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect(refusing.asked).toEqual([])
  })

  it('does nothing without a window, a tab or an address a bookmark can hold', async () => {
    for (const windows of [
      [],
      [fakeWindow('empty', { url: null })],
      [fakeWindow('blank', { url: '' })]
    ]) {
      const { actions, bookmarks, asked } = await harness({ windows })
      await actions.addBookmark()
      expect(bookmarks.query({}).filter((node) => node.kind === 'bookmark')).toEqual([])
      expect(asked).toEqual([])
    }
  })
})

describe('Clear Browsing Data…', () => {
  const press = (key: Parameters<typeof menuLabel>[1]) => (): string => en(key)

  it('asks in the window focused last, lists the categories, and says downloaded files stay', async () => {
    const { actions, asked, log } = await harness()
    await actions.clearData()

    expect(asked).toHaveLength(1)
    const { window, box } = asked[0]!
    expect(window?.name).toBe('recent')
    expect(box.buttons).toEqual([
      en('clearData.everything'),
      en('clearData.keepHistory'),
      en('clearData.cacheOnly'),
      en('clearData.cancel')
    ])
    expect(box).toMatchObject({
      type: 'question',
      message: en('clearData.message'),
      cancelId: 3,
      defaultId: 3,
      noLink: true
    })
    expect(box.detail).toContain('Downloaded files stay')
    // Cancelled: nothing went.
    expect(log).toEqual([])
  })

  it('with only the cache chosen, keeps the history and empties Chromium’s cache', async () => {
    const { actions, history, log, forgotten } = await harness({
      answer: press('clearData.cacheOnly')
    })
    await actions.clearData()

    expect(history.query().map((visit) => visit.url)).toEqual(['https://visited.example/'])
    expect(log).toEqual(['default.clearCache'])
    expect(forgotten).toEqual([])
  })

  it('clears everything in the normal session, the network traces and what is kept in memory with it', async () => {
    const windows = [fakeWindow('recent'), fakeWindow('other')]
    const { actions, history, log, forgotten, sessions } = await harness({
      windows,
      answer: press('clearData.everything')
    })
    await actions.clearData()

    expect(history.query()).toEqual([])
    expect(log).toEqual(
      expect.arrayContaining([
        'favicons.clear',
        'thumbnails.clear',
        'default.clearStorageData',
        'default.clearCache',
        'default.clearData',
        'default.clearCodeCaches',
        'default.clearHostResolverCache',
        'default.clearAuthCache'
      ])
    )
    // A clearing now does not seal: the browser goes on recording.
    expect(log).not.toContain('favicons.seal')
    expect(forgotten).toEqual([sessions.normal])
    // History is the profile's, so every normal window's closed tabs go with it.
    expect(windows.map((window) => window.closedTabsForgotten)).toEqual([1, 1])
  })

  it('keeps the history when asked to, and still clears the cookies unfiltered', async () => {
    const { actions, history, log } = await harness({ answer: press('clearData.keepHistory') })
    await actions.clearData()
    expect(history.query()).toHaveLength(1)
    expect(log).toContain('default.clearData')
    expect(log).not.toContain('favicons.clear')
  })

  it('in a private window clears that partition only and leaves the normal session alone', async () => {
    const privateWindow = fakeWindow('private', { privateMode: true })
    const normalWindow = fakeWindow('normal')
    const { actions, history, log, forgotten, sessions, asked } = await harness({
      windows: [privateWindow, normalWindow],
      answer: press('clearData.everything')
    })
    await actions.clearData()

    expect(asked[0]?.box.detail).toContain('this private window')
    expect(log.filter((call) => call.startsWith('default.'))).toEqual([])
    expect(log).toContain('private.clearData')
    expect(log).not.toContain('favicons.clear')
    expect(history.query()).toHaveLength(1)
    expect(forgotten).toEqual([sessions.private])
    expect(privateWindow.closedTabsForgotten).toBe(1)
    expect(normalWindow.closedTabsForgotten).toBe(0)
  })

  it('clears the normal profile when no window is open at all', async () => {
    const { actions, asked, log } = await harness({
      windows: [],
      answer: press('clearData.cacheOnly')
    })
    await actions.clearData()
    expect(asked[0]?.window).toBeUndefined()
    expect(log).toEqual(['default.clearCache'])
  })

  it('logs, rather than throws, a clearing that fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { actions, sessions } = await harness({ answer: press('clearData.cacheOnly') })
    vi.spyOn(sessions.normal, 'clearCache').mockRejectedValue(new Error('busy'))
    await expect(actions.clearData()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
  })

  it('offers presets drawn from the inventory, each clearing only what clearing now may choose', () => {
    expect(CLEAR_NOW_PRESETS.map((preset) => preset.label)).toEqual([
      'clearData.everything',
      'clearData.keepHistory',
      'clearData.cacheOnly'
    ])
    expect(CLEAR_NOW_PRESETS[0]?.categories).toEqual([
      'history',
      'downloads',
      'cookies',
      'storage',
      'cache'
    ])
  })
})

describe('Delete Everything and Quit', () => {
  it('asks once and does nothing when the answer is no', async () => {
    const h = await harness()
    await h.actions.panic()
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]?.box).toMatchObject({
      type: 'warning',
      message: en('panic.message'),
      buttons: [en('panic.confirm'), en('panic.cancel')],
      cancelId: 1,
      defaultId: 1
    })
    // What stays is said as plainly as what goes.
    expect(h.asked[0]?.box.detail).toContain('Bookmarks')
    expect(h.panics).toBe(0)
  })

  it('runs the panic after one confirmation, with no window focused', async () => {
    const h = await harness({ answer: () => en('panic.confirm') })
    await h.actions.panic()
    expect(h.asked).toHaveLength(1)
    expect(h.panics).toBe(1)
    await expect(h.actions.whenIdle()).resolves.toBeUndefined()
  })

  it('logs, rather than throws, a dialogue that fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { deps } = await harness()
    const failing = new MenuActions<FakeWindow, ClearingSession>({
      ...deps,
      locale: () => 'de',
      ask: () => Promise.reject(new Error('no dialogue'))
    })
    await expect(failing.panic()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
  })
})

describe('the application menu', () => {
  /** Every item in a template, submenus flattened. */
  function itemsOf(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    return items.flatMap((item) => [
      item,
      ...(Array.isArray(item.submenu) ? itemsOf(item.submenu) : [])
    ])
  }

  it('calls the three actions from its own handlers, with no window focused', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as Platform[]) {
      const called: string[] = []
      const record = (name: string) => (): Promise<void> => {
        called.push(name)
        return Promise.resolve()
      }
      const deps = {
        // No window focused, none open: `focused()?.emit` would have gone nowhere.
        windows: { focused: () => undefined, controllers: [] },
        settings: { get: () => ({}) },
        locale: 'en',
        platform,
        checkForUpdates: () => undefined,
        actions: {
          addBookmark: record('addBookmark'),
          clearData: record('clearData'),
          panic: record('panic')
        }
      } as unknown as MenuDeps
      const items = itemsOf(buildApplicationMenu(deps) as unknown as MenuItemConstructorOptions[])
      for (const label of [
        'Bookmark This Page',
        'Clear Browsing Data…',
        'Delete Everything and Quit'
      ]) {
        const item = items.find((entry) => entry.label === label)
        const click = item?.click as (() => void) | undefined
        click?.()
      }
      expect(called, platform).toEqual(['addBookmark', 'clearData', 'panic'])
    }
  })

  it('fills from browser chrome with its own key on every platform (autofill U7)', () => {
    const keys: Record<Platform, string> = {
      darwin: 'Command+Shift+K',
      linux: 'Control+Shift+K',
      win32: 'Control+Shift+K'
    }
    for (const platform of ['darwin', 'linux', 'win32'] as Platform[]) {
      const window = { id: 'focused window' }
      const fills: unknown[] = []
      const deps = {
        windows: { focused: () => window, controllers: [window] },
        settings: { get: () => ({}) },
        locale: 'en',
        platform,
        checkForUpdates: () => undefined,
        actions: {},
        autofill: {
          fillActiveTab: (target: unknown, anchor: unknown) => fills.push([target, anchor])
        }
      } as unknown as MenuDeps
      const items = itemsOf(buildApplicationMenu(deps) as unknown as MenuItemConstructorOptions[])
      const item = items.find((entry) => entry.label === 'Fill In Saved Password')

      expect(item?.accelerator, platform).toBe(keys[platform])
      ;(item?.click as (() => void) | undefined)?.()
      // The focused window, and no anchor: the list hangs from the field, as a badge's would.
      expect(fills, platform).toEqual([[window, null]])
    }
  })
})

describe('installMenuActions', () => {
  interface ProfileStore {
    abandon(): Promise<void>
  }

  async function installed() {
    const dir = await tempDir()
    const log: string[] = []
    const defaultSession = fakeSession('default', log)
    const privateSession = fakeSession('private', log)
    const normal = fakeWindow('normal')
    const privateWindow = fakeWindow('private', { privateMode: true })
    const dialogs: Array<{ parent: unknown; box: MessageBox }> = []
    const history = await HistoryStore.open({ filePath: join(dir, 'history.json'), debounceMs: 0 })
    const downloads = await DownloadStore.open({
      filePath: join(dir, 'downloads.json'),
      debounceMs: 0
    })
    const stopped = (name: string): ProfileStore => ({
      abandon: () => {
        log.push(`${name}.abandon`)
        return Promise.resolve()
      }
    })
    const released: unknown[] = []
    let windowOrder: FakeWindow[] = [privateWindow, normal]
    const actions = installMenuActions({
      windows: {
        get byRecentFocus() {
          return windowOrder
        },
        sessionOf: (window: FakeWindow) => (window.privateMode ? privateSession : defaultSession),
        closeAll: () => log.push('closeAll')
      },
      electron: {
        dialog: {
          // Electron's two signatures, with a parent window or with the options alone; the person
          // presses the first button, which is "everything" or "delete and quit".
          showMessageBox: ((parent: unknown, box?: MessageBox) => {
            const options = (box ?? parent) as MessageBox
            dialogs.push({ parent: box === undefined ? undefined : parent, box: options })
            return Promise.resolve({ response: 0, checkboxChecked: false })
          }) as never
        },
        defaultSession,
        quit: () => log.push('quit')
      },
      bookmarks: await BookmarkStore.open({ filePath: join(dir, 'bookmarks.json') }),
      stores: {
        history,
        downloads,
        favicons: fakeCache('favicons', log),
        thumbnails: fakeCache('thumbnails', log)
      },
      stopped: ['session', 'tabGroups', 'arrangements', 'permissions'].map(stopped),
      downloads: { cancelUnfinished: () => [] },
      media: {
        forgetAll: (session?: ClearingSession) => {
          if (session === undefined) log.push('media.forgetAll')
          else released.push(session)
        }
      },
      locale: () => 'en',
      path: (name: InventoryPath) => join(dir, name)
    })
    return {
      actions,
      log,
      dialogs,
      released,
      defaultSession,
      privateSession,
      normal,
      privateWindow,
      setOrder: (order: FakeWindow[]) => {
        windowOrder = order
      },
      dir
    }
  }

  it('asks on the window, forgets that session’s HTTPS exceptions and media finds with the cookies', async () => {
    const h = await installed()
    httpsExemptionsFor(h.privateSession).add('http://printer.lan/')

    // The first button is "everything".
    await h.actions.clearData()

    expect(h.dialogs[0]?.parent).toBe(h.privateWindow.window)
    expect(
      httpsExemptionsFor(h.privateSession).exempts({
        url: 'http://printer.lan/',
        resourceType: 'mainFrame',
        documentUrl: null
      })
    ).toBe(false)
    expect(h.released).toEqual([h.privateSession])
    expect(h.log).toContain('private.clearData')
  })

  it('asks without a parent when no window is open', async () => {
    const h = await installed()
    h.setOrder([])
    await h.actions.clearData()
    expect(h.dialogs[0]?.parent).toBeUndefined()
    expect(h.log).toContain('default.clearData')
  })

  it('wires the panic to every store, the windows, the default session and the quit', async () => {
    const h = await installed()
    await h.actions.panic()
    await h.actions.whenIdle()

    for (const step of [
      'session.abandon',
      'tabGroups.abandon',
      'arrangements.abandon',
      'permissions.abandon',
      'favicons.seal',
      'media.forgetAll',
      'closeAll',
      'default.clearData',
      'quit'
    ]) {
      expect(h.log, step).toContain(step)
    }
    expect(h.log.indexOf('closeAll')).toBeLessThan(h.log.indexOf('default.clearData'))
  })
})
