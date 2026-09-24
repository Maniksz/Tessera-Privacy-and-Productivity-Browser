import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerImportHandlers, type ImportHandle } from '@main/ipc/import-handlers.js'
import { currentMachine } from '@main/import/profiles.js'
import { BookmarkStore } from '@main/data/BookmarkStore.js'
import { HistoryStore } from '@main/data/HistoryStore.js'
import { QuickLinkStore } from '@main/data/QuickLinkStore.js'
import { MAX_IMPORT_LENGTH } from '@shared/bookmarks/import.js'
import { BOOKMARK_BAR_ID, BOOKMARK_OTHER_ID, childrenOf } from '@shared/bookmarks/model.js'
import type { HistoryVisit } from '@shared/history/model.js'
import { MAX_HISTORY_ENTRIES } from '@shared/history/model.js'
import { IMPORT_BROWSERS, IMPORT_REFUSALS } from '@shared/import/model.js'
import { importInvokeContract } from '@shared/import/schema.js'

/**
 * The import's seven channels (U24, R39, Q3), driven through the registrar against real stores and a
 * temporary home that holds a Chrome and a Firefox profile made of real files.
 *
 * Every answer is also parsed with the channel's response schema, so what is pinned here is what the
 * page receives. The page names a profile by id only; an id the core did not list is `missing`.
 */

/*
  The home `currentMachine` finds, for the one test that leaves the machine to the default: a stubbed
  `HOME` would not reach `os.homedir()` from a worker thread, and the real one is somebody's profile.
*/
const machineHome = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return { ...original, homedir: () => machineHome.path || original.homedir() }
})

const NOW = Date.UTC(2026, 8, 24, 12)
const MINUTE = 60_000
const WEBKIT_OFFSET = 11_644_473_600_000_000n

type Handler = (payload: unknown, event: IpcMainInvokeEvent) => unknown

let home: string
let temp: string
let data: string
let handlers: Map<string, Handler>
let opened: string[]
let stores: { history: HistoryStore; bookmarks: BookmarkStore; quickLinks: QuickLinkStore }

const chromeDir = (): string => join(home, '.config/google-chrome/Default')
const firefoxDir = (): string => join(home, '.mozilla/firefox/p.default')

function chromeBookmarks(children: unknown[]): void {
  mkdirSync(chromeDir(), { recursive: true })
  writeFileSync(
    join(chromeDir(), 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children },
        other: {
          type: 'folder',
          children: [{ type: 'url', name: 'Other', url: 'https://other.example/' }]
        }
      }
    })
  )
}

function chromeHistory(urls: Array<{ url: string; at: number }>): void {
  mkdirSync(chromeDir(), { recursive: true })
  const db = new DatabaseSync(join(chromeDir(), 'History'))
  db.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER,
    last_visit_time INTEGER, hidden INTEGER DEFAULT 0);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);`)
  const insert = db.prepare(
    'INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, 1, ?)'
  )
  for (const { url, at } of urls) insert.run(url, '', BigInt(at) * 1000n + WEBKIT_OFFSET)
  db.close()
}

function firefoxProfile(): void {
  mkdirSync(firefoxDir(), { recursive: true })
  writeFileSync(
    join(home, '.mozilla/firefox/profiles.ini'),
    '[Profile0]\nName=default-release\nPath=p.default\n'
  )
  const db = new DatabaseSync(join(firefoxDir(), 'places.sqlite'))
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT,
      visit_count INTEGER, hidden INTEGER DEFAULT 0, last_visit_date INTEGER);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER,
      position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT);
    INSERT INTO moz_places VALUES (1, 'https://fx.example/', 'Fx', 2, 0, ${(NOW - MINUTE) * 1000});
    INSERT INTO moz_bookmarks VALUES
      (1, 2, NULL, 0, 0, '', 0, 'root________'),
      (2, 2, NULL, 1, 0, 'toolbar', 0, 'toolbar_____'),
      (3, 1, 1, 2, 0, 'Fx', 0, 'a');`)
  db.close()
}

async function openStores(ownVisits: HistoryVisit[] = [], historyVersion = 1): Promise<void> {
  const historyFile = join(data, 'history.json')
  writeFileSync(historyFile, JSON.stringify({ version: historyVersion, visits: ownVisits }))
  let id = 0
  stores = {
    history: await HistoryStore.open({ filePath: historyFile, now: () => NOW }),
    bookmarks: await BookmarkStore.open({
      filePath: join(data, 'bookmarks.json'),
      generateId: () => `b${(id += 1)}`,
      now: () => NOW
    }),
    quickLinks: await QuickLinkStore.open({ filePath: join(data, 'quicklinks.json') })
  }
  handlers = new Map()
  opened = []
  const handle: ImportHandle = (channel, handler) => {
    handlers.set(channel, handler as Handler)
  }
  registerImportHandlers({
    handle,
    windows: {
      controllerForWebContents: (webContentsId) =>
        webContentsId === 7 ? { createTab: ({ url }) => opened.push(url) } : undefined
    },
    ...stores,
    locale: () => 'en',
    machine: { ...currentMachine(), platform: 'linux', env: {}, home },
    copy: { tempRoot: temp }
  })
}

async function call(channel: keyof typeof importInvokeContract, payload?: unknown, sender = 7) {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} is not registered`)
  const answer = await handler(payload, { sender: { id: sender } } as unknown as IpcMainInvokeEvent)
  // What the page receives: the answer, as the contract parses it.
  return importInvokeContract[channel].response.parse(answer) as never
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tessera-import-home-'))
  temp = mkdtempSync(join(tmpdir(), 'tessera-import-temp-'))
  data = mkdtempSync(join(tmpdir(), 'tessera-import-data-'))
})

afterEach(async () => {
  await Promise.all(Object.values(stores).map((store) => store.flush()))
  for (const dir of [home, temp, data]) rmSync(dir, { recursive: true, force: true })
})

describe('the profiles on offer', () => {
  it('lists what is there, and nothing of a browser that is not installed', async () => {
    chromeBookmarks([])
    firefoxProfile()
    await openStores()
    expect(await call('import:sources')).toEqual([
      {
        id: 'chrome:Default',
        browser: 'chrome',
        profile: 'Default',
        bookmarks: true,
        history: false
      },
      {
        id: 'firefox:p.default',
        browser: 'firefox',
        profile: 'default-release',
        bookmarks: true,
        history: true
      }
    ])
    expect(IMPORT_BROWSERS).toContain('edge')
  })

  it('lists nothing on a machine without any of them', async () => {
    await openStores()
    expect(await call('import:sources')).toEqual([])
  })

  it('looks at this machine when not told otherwise', async () => {
    await openStores()
    machineHome.path = home
    vi.stubEnv('XDG_CONFIG_HOME', undefined)
    vi.stubEnv('LOCALAPPDATA', undefined)
    vi.stubEnv('APPDATA', undefined)
    try {
      registerImportHandlers({
        handle: (channel, handler) => handlers.set(channel, handler as Handler),
        windows: { controllerForWebContents: () => undefined },
        ...stores,
        locale: () => 'en'
      })
      expect(await call('import:sources')).toEqual([])
    } finally {
      machineHome.path = ''
      vi.unstubAllEnvs()
    }
  })
})

describe('bookmarks', () => {
  it('takes Chrome’s bar onto the bar and the rest into “Imported bookmarks”, once', async () => {
    chromeBookmarks([
      { type: 'url', name: 'News', url: 'https://news.example/' },
      { type: 'url', name: 'Evil', url: 'javascript:alert(1)' }
    ])
    await openStores()
    expect(await call('import:bookmarks', { source: 'chrome:Default' })).toEqual({
      outcome: 'imported',
      imported: 3,
      skipped: 1,
      duplicates: 0
    })
    const nodes = stores.bookmarks.list()
    expect(childrenOf(nodes, BOOKMARK_BAR_ID).map((node) => node.title)).toEqual(['News'])
    expect(childrenOf(nodes, BOOKMARK_OTHER_ID).map((node) => node.title)).toEqual([
      'Imported bookmarks'
    ])

    // The second import finds everything already there.
    expect(await call('import:bookmarks', { source: 'chrome:Default' })).toEqual({
      outcome: 'imported',
      imported: 0,
      skipped: 1,
      duplicates: 2
    })
    expect(stores.bookmarks.list()).toEqual(nodes)
  })

  it('adds nothing twice across browsers: one folder, one bar, matched by address', async () => {
    chromeBookmarks([{ type: 'url', name: 'Synced', url: 'https://fx.example/' }])
    firefoxProfile()
    await openStores()
    await call('import:bookmarks', { source: 'chrome:Default' })
    expect(await call('import:bookmarks', { source: 'firefox:p.default' })).toEqual({
      outcome: 'imported',
      imported: 0,
      skipped: 0,
      duplicates: 1
    })
  })

  it('reads Firefox’s bookmarks from places.sqlite and leaves no copy behind', async () => {
    firefoxProfile()
    await openStores()
    expect(await call('import:bookmarks', { source: 'firefox:p.default' })).toEqual({
      outcome: 'imported',
      imported: 1,
      skipped: 0,
      duplicates: 0
    })
    expect(childrenOf(stores.bookmarks.list(), BOOKMARK_BAR_ID).map((node) => node.url)).toEqual([
      'https://fx.example/'
    ])
    expect(readdirSync(temp)).toEqual([])
  })

  it('answers missing for an id it did not list, and for a profile without bookmarks', async () => {
    chromeHistory([])
    await openStores()
    expect(await call('import:bookmarks', { source: '/etc/passwd' })).toEqual({
      outcome: 'refused',
      reason: 'missing'
    })
    expect(await call('import:bookmarks', { source: 'chrome:Default' })).toEqual({
      outcome: 'refused',
      reason: 'missing'
    })
  })

  it('answers unreadable for a file that is not Chrome’s, or too large to be read', async () => {
    mkdirSync(chromeDir(), { recursive: true })
    writeFileSync(join(chromeDir(), 'Bookmarks'), 'not json')
    await openStores()
    expect(await call('import:bookmarks', { source: 'chrome:Default' })).toEqual({
      outcome: 'refused',
      reason: 'unreadable'
    })
    writeFileSync(join(chromeDir(), 'Bookmarks'), Buffer.alloc(MAX_IMPORT_LENGTH + 1, 32))
    expect(await call('import:bookmarks', { source: 'chrome:Default' })).toEqual({
      outcome: 'refused',
      reason: 'unreadable'
    })
  })

  it('answers unreadable, not a crash, for a folder named Bookmarks and a damaged places', async () => {
    mkdirSync(join(chromeDir(), 'Bookmarks'), { recursive: true })
    mkdirSync(firefoxDir(), { recursive: true })
    writeFileSync(join(home, '.mozilla/firefox/profiles.ini'), '[Profile0]\nPath=p.default\n')
    writeFileSync(join(firefoxDir(), 'places.sqlite'), 'damaged')
    await openStores()
    // A directory where the file should be reads as EISDIR: unreadable, not a crash.
    expect(await call('import:bookmarks', { source: 'chrome:Default' })).toEqual({
      outcome: 'refused',
      reason: 'unreadable'
    })
    expect(await call('import:bookmarks', { source: 'firefox:p.default' })).toEqual({
      outcome: 'refused',
      reason: 'unreadable'
    })
  })

  it('refuses into bookmarks that are read-only in this run, or full', async () => {
    chromeBookmarks([{ type: 'url', url: 'https://x.example/' }])
    writeFileSync(join(data, 'bookmarks.json'), JSON.stringify({ version: 99, nodes: [] }))
    await openStores()
    expect(await call('import:bookmarks', { source: 'chrome:Default' })).toEqual({
      outcome: 'refused',
      reason: 'read-only'
    })
    rmSync(join(data, 'bookmarks.json'))
    const nodes = Array.from({ length: 10_000 }, (_unused, index) => ({
      id: `n${index}`,
      kind: 'bookmark',
      title: 't',
      url: `https://full.example/${index}`,
      parentId: BOOKMARK_OTHER_ID,
      createdAt: NOW
    }))
    writeFileSync(join(data, 'bookmarks.json'), JSON.stringify({ version: 1, nodes }))
    await openStores()
    expect(await call('import:bookmarks', { source: 'chrome:Default' })).toEqual({
      outcome: 'refused',
      reason: 'full'
    })
  })
})

describe('history', () => {
  const own = (index: number): HistoryVisit => {
    const at = NOW - (index + 1) * MINUTE
    return {
      url: `https://own.example/${index}`,
      title: '',
      firstVisitedAt: at,
      lastVisitedAt: at,
      visitCount: 1
    }
  }

  it('tells first how many fit, writes nothing then, and imports on confirmation', async () => {
    chromeHistory(
      Array.from({ length: 5 }, (_unused, index) => ({
        url: `https://c.example/${index}`,
        at: NOW - index * MINUTE - 30_000
      }))
    )
    await openStores(
      Array.from({ length: MAX_HISTORY_ENTRIES - 2 }, (_unused, index) => own(index))
    )
    const counts = { added: 2, merged: 0, dropped: 3, skipped: 0 }
    expect(await call('import:previewHistory', { source: 'chrome:Default' })).toEqual({
      outcome: 'preview',
      counts
    })
    expect(stores.history.query()).toHaveLength(MAX_HISTORY_ENTRIES - 2)
    expect(await call('import:offer')).toEqual({ show: true })

    expect(await call('import:history', { source: 'chrome:Default' })).toEqual({
      outcome: 'imported',
      counts
    })
    expect(stores.history.query()).toHaveLength(MAX_HISTORY_ENTRIES)
    // An import that went through closes the start page's card.
    expect(await call('import:offer')).toEqual({ show: false })
    expect(readdirSync(temp)).toEqual([])
  })

  it('counts the rows past the reading limit as left out', async () => {
    firefoxProfile()
    await openStores()
    registerImportHandlers({
      handle: (channel, handler) => handlers.set(channel, handler as Handler),
      windows: { controllerForWebContents: () => undefined },
      ...stores,
      locale: () => 'de',
      machine: { ...currentMachine(), platform: 'linux', env: {}, home },
      copy: { tempRoot: temp, limit: 0 }
    })
    expect(await call('import:previewHistory', { source: 'firefox:p.default' })).toEqual({
      outcome: 'preview',
      counts: { added: 0, merged: 0, dropped: 1, skipped: 0 }
    })
  })

  it('refuses a history that is read-only in this run, before reading anything', async () => {
    firefoxProfile()
    await openStores([], 2)
    for (const channel of ['import:previewHistory', 'import:history'] as const) {
      expect(await call(channel, { source: 'firefox:p.default' })).toEqual({
        outcome: 'refused',
        reason: 'read-only'
      })
    }
  })

  it('answers missing and unreadable without a crash', async () => {
    chromeBookmarks([])
    mkdirSync(firefoxDir(), { recursive: true })
    writeFileSync(join(home, '.mozilla/firefox/profiles.ini'), '[Profile0]\nPath=p.default\n')
    writeFileSync(join(firefoxDir(), 'places.sqlite'), 'damaged')
    await openStores()
    for (const channel of ['import:previewHistory', 'import:history'] as const) {
      expect(await call(channel, { source: 'chrome:Default' })).toEqual({
        outcome: 'refused',
        reason: 'missing'
      })
      expect(await call(channel, { source: 'nobody' })).toEqual({
        outcome: 'refused',
        reason: 'missing'
      })
      expect(await call(channel, { source: 'firefox:p.default' })).toEqual({
        outcome: 'refused',
        reason: 'unreadable'
      })
    }
    expect(IMPORT_REFUSALS).toContain('locked')
    expect(readdirSync(temp)).toEqual([])
  })
})

describe('the start page’s card (Q3)', () => {
  it('is shown until it is closed once, and stays closed after a restart', async () => {
    await openStores()
    expect(await call('import:offer')).toEqual({ show: true })
    expect(await call('import:closeOffer')).toEqual({ ok: true })
    expect(await call('import:closeOffer')).toEqual({ ok: true })
    expect(await call('import:offer')).toEqual({ show: false })
    await stores.quickLinks.flush()
    const reopened = await QuickLinkStore.open({ filePath: join(data, 'quicklinks.json') })
    expect(reopened.importOfferClosed).toBe(true)
    expect(reopened.list()).toEqual([])
  })

  it('opens the settings page’s import section beside the page that asked, and nowhere else', async () => {
    await openStores()
    expect(await call('import:openSettings')).toEqual({ ok: true })
    expect(await call('import:openSettings', undefined, 99)).toEqual({ ok: true })
    expect(opened).toEqual(['tessera://settings#import'])
  })
})
