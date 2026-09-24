import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  catchUpPendingClears,
  clearChromium,
  clearFilesOf,
  clearOnExit,
  exitNoteAt,
  noteFileAt,
  watchExitNote,
  type ClearingSession,
  type OpenStores
} from '@main/data/clear-data.js'
import { DownloadStore } from '@main/data/DownloadStore.js'
import { FaviconStore } from '@main/data/FaviconStore.js'
import { HistoryStore } from '@main/data/HistoryStore.js'
import { ThumbnailStore, type CapturedImage } from '@main/data/ThumbnailStore.js'
import { pendingClearText, type After } from '@main/shutdown.js'
import type { InventoryPath } from '@shared/data/inventory.js'
import type { StartedDownload } from '@shared/downloads/model.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * Clearing by category (KTD7), on both of its roads.
 *
 * On the way out the stores are open: each is sealed, emptied and has its copies removed, so the
 * flush that follows writes an empty file and nothing arrives late to fill it again. At the next
 * start after a crash they are not open yet: the catch-up works on the files, before any store reads
 * them. The damage each group is here to prevent is named in it — a history that survives in a
 * `.v1.bak`, a visit that lands after the clearing, a damaged note that deletes a history the user
 * wanted kept.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

/** A session that records every clearing call, in order, and can be told to refuse one. */
function fakeSession(refuse: string | null = null): { session: ClearingSession; calls: string[] } {
  const calls: string[] = []
  const record = (name: string, detail?: unknown) => (): Promise<void> => {
    calls.push(detail === undefined ? name : `${name}:${JSON.stringify(detail)}`)
    return refuse === name ? Promise.reject(new Error(`${name} refused`)) : Promise.resolve()
  }
  const session: ClearingSession = {
    clearStorageData: (options) => record('clearStorageData', options)(),
    clearCache: () => record('clearCache')(),
    clearData: (options) => record('clearData', options)(),
    clearCodeCaches: (options) => record('clearCodeCaches', options)(),
    clearHostResolverCache: () => record('clearHostResolverCache')(),
    clearAuthCache: () => record('clearAuthCache')()
  }
  return { session, calls }
}

/** A timer that never fires: every catch-up here settles long before thirty seconds. */
const never: After = () => () => undefined

async function profile(): Promise<{ dir: string; path: (name: InventoryPath) => string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-clear-data-'))
  return { dir, path: (name) => join(dir, name) }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A cache store that records what was done to it; stands in for favicons and thumbnails. */
function fakeCache(name: string, order: string[]): NonNullable<OpenStores['favicons']> {
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

function started(id: string, savePath: string): StartedDownload {
  return {
    id,
    url: `https://example.com/${id}.bin`,
    fileName: `${id}.bin`,
    savePath,
    mimeType: 'application/octet-stream',
    totalBytes: 10,
    startedAt: 1
  }
}

describe('clearing on exit, with the stores open', () => {
  it('empties history and the downloads list, removes their copies and leaves the files alone', async () => {
    const { dir } = await profile()
    const historyFile = join(dir, 'history.json')
    const downloadsFile = join(dir, 'downloads.json')
    const history = await HistoryStore.open({ filePath: historyFile, debounceMs: 0 })
    const downloads = await DownloadStore.open({ filePath: downloadsFile, debounceMs: 0 })
    history.recorderFor('normal').recordVisit({ url: 'https://visited.example/' })
    const saved = join(dir, 'saved.bin')
    await writeFile(saved, 'the download itself')
    downloads.recorderFor('normal').start(started('done', saved))
    downloads.recorderFor('normal').update('done', { state: 'completed' })
    await Promise.all([history.flush(), downloads.flush()])
    // Last month's migration and last week's damaged file: both are older states of the same data.
    await writeFile(`${historyFile}.v1.bak`, '{"visits":[{"url":"https://old.example/"}]}')
    await writeFile(`${downloadsFile}.unreadable`, 'garbage')
    const order: string[] = []
    const { session, calls } = fakeSession()

    await clearOnExit(['history', 'downloads'], {
      session,
      stores: {
        history,
        downloads,
        favicons: fakeCache('favicons', order),
        thumbnails: fakeCache('thumbnails', order)
      }
    })
    await Promise.all([history.flush(), downloads.flush()])

    expect(history.query()).toEqual([])
    expect(downloads.list()).toEqual([])
    expect((await readdir(dir)).sort()).toEqual(['downloads.json', 'history.json', 'saved.bin'])
    expect(await readFile(saved, 'utf8')).toBe('the download itself')
    // The icons and pictures are history too (KTD7): sealed, emptied and their copies gone.
    expect(order).toEqual([
      'favicons.seal',
      'thumbnails.seal',
      'favicons.clear',
      'thumbnails.clear',
      'favicons.discardCopies',
      'thumbnails.discardCopies'
    ])
    // Neither category is Chromium's.
    expect(calls).toEqual([])
  })

  it('keeps a download that is still running in the list', async () => {
    const { dir } = await profile()
    const downloads = await DownloadStore.open({
      filePath: join(dir, 'downloads.json'),
      debounceMs: 0
    })
    const recorder = downloads.recorderFor('normal')
    recorder.start(started('running', join(dir, 'running.bin')))
    recorder.start(started('finished', join(dir, 'finished.bin')))
    recorder.update('finished', { state: 'completed' })

    await clearOnExit(['downloads'], {
      session: fakeSession().session,
      stores: { history: null, downloads, favicons: null, thumbnails: null }
    })

    expect(downloads.list().map((record) => record.id)).toEqual(['running'])
  })

  it('does not let a visit that arrives after the seal into the emptied history', async () => {
    const { dir } = await profile()
    const historyFile = join(dir, 'history.json')
    const history = await HistoryStore.open({ filePath: historyFile, debounceMs: 0 })
    // Taken before the quit, as every window holds its recorder from the moment it opened.
    const recorder = history.recorderFor('normal')
    recorder.recordVisit({ url: 'https://before.example/' })
    const order: string[] = []

    await clearOnExit(['history'], {
      session: fakeSession().session,
      stores: {
        history,
        downloads: null,
        favicons: fakeCache('favicons', order),
        thumbnails: fakeCache('thumbnails', order)
      }
    })
    recorder.recordVisit({ url: 'https://late.example/' })
    recorder.noteTitle({ url: 'https://late.example/', title: 'Late' })
    await history.flush()

    expect(history.query()).toEqual([])
    const reopened = await HistoryStore.open({ filePath: historyFile })
    expect(reopened.query()).toEqual([])
  })

  it('seals a downloads list before it clears it, so a download starting now is not recorded', async () => {
    const { dir } = await profile()
    const downloads = await DownloadStore.open({
      filePath: join(dir, 'downloads.json'),
      debounceMs: 0
    })
    const recorder = downloads.recorderFor('normal')

    await clearOnExit(['downloads'], {
      session: fakeSession().session,
      stores: { history: null, downloads, favicons: null, thumbnails: null }
    })
    recorder.start(started('late', join(dir, 'late.bin')))

    expect(downloads.list()).toEqual([])
  })

  it('fails when a store it has to clear is not open, so the note stays for the next start', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stores: OpenStores = { history: null, downloads: null, favicons: null, thumbnails: null }

    await expect(
      clearOnExit(['history'], { session: fakeSession().session, stores })
    ).rejects.toThrow(/history/)
    await expect(
      clearOnExit(['downloads'], { session: fakeSession().session, stores })
    ).rejects.toThrow(/downloads/)
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('touches no store for the Chromium categories alone', async () => {
    const { session, calls } = fakeSession()
    const stores: OpenStores = { history: null, downloads: null, favicons: null, thumbnails: null }

    await clearOnExit(['cache'], { session, stores })

    expect(calls).toEqual(['clearCache'])
  })
})

describe('the Chromium side of a clearing', () => {
  it('clears the cookies with the network traces that can go without touching anything else', async () => {
    const { session, calls } = fakeSession()
    await clearChromium(session, ['cookies', 'networkTraces', 'inMemory'])
    expect(calls).toEqual([
      'clearStorageData:{"storages":["cookies"]}',
      'clearCodeCaches:{}',
      'clearHostResolverCache',
      'clearAuthCache'
    ])
  })

  it('clears everything, unfiltered, only when cookies, site storage and cache all go', async () => {
    const { session, calls } = fakeSession()
    await clearChromium(session, ['cookies', 'networkTraces', 'storage', 'cache'])
    expect(calls).toEqual([
      'clearStorageData:{"storages":["cookies","localstorage","indexdb","serviceworkers","cachestorage","filesystem","shadercache"]}',
      'clearCache',
      'clearData',
      'clearCodeCaches:{}',
      'clearHostResolverCache',
      'clearAuthCache'
    ])
  })

  it('clears site storage on its own', async () => {
    const { session, calls } = fakeSession()
    await clearChromium(session, ['storage'])
    expect(calls).toEqual([
      'clearStorageData:{"storages":["localstorage","indexdb","serviceworkers","cachestorage","filesystem","shadercache"]}'
    ])
  })

  it('asks Chromium for nothing when no category of its own is due', async () => {
    const { session, calls } = fakeSession()
    await clearChromium(session, ['history', 'downloads', 'session'])
    expect(calls).toEqual([])
  })
})

describe('clearing on the files, before the stores open', () => {
  it('removes each file with its copies and each directory whole, and nothing of other categories', async () => {
    const { dir, path } = await profile()
    await writeFile(path('historyFile'), '{}')
    await writeFile(`${path('historyFile')}.v1.bak`, '{}')
    await writeFile(`${path('historyFile')}.unreadable.2`, '{}')
    await mkdir(path('faviconCacheDir'))
    await writeFile(join(path('faviconCacheDir'), 'index.json'), '{}')
    await mkdir(path('thumbnailCacheDir'))
    await writeFile(path('downloadsFile'), '{}')
    await writeFile(path('bookmarksFile'), '{}')
    const { session, calls } = fakeSession()

    await clearFilesOf(['history'], { session, path })

    expect((await readdir(dir)).sort()).toEqual(['bookmarksFile', 'downloadsFile'])
    expect(calls).toEqual([])
  })

  it('succeeds when the files are already gone', async () => {
    const { path } = await profile()
    await expect(
      clearFilesOf(['history', 'downloads'], { session: fakeSession().session, path })
    ).resolves.toBeUndefined()
  })
})

describe('the catch-up at the next start', () => {
  it('empties history, its copies, icons and pictures after a hard end, before the store opens (AE5)', async () => {
    const { dir, path } = await profile()
    const before = await HistoryStore.open({ filePath: path('historyFile'), debounceMs: 0 })
    before.recorderFor('normal').recordVisit({ url: 'https://visited.example/' })
    await before.flush()
    await writeFile(`${path('historyFile')}.v1.bak`, '{}')
    await mkdir(path('faviconCacheDir'))
    await writeFile(join(path('faviconCacheDir'), 'example.com.png'), 'icon')
    await mkdir(path('thumbnailCacheDir'))
    await writeFile(path('downloadsFile'), '{"kept":true}')
    // What the run armed at its start and never got to remove: the process was killed.
    await writeFile(path('pendingClearFile'), pendingClearText(['history']))
    const { session } = fakeSession()

    await catchUpPendingClears({ session, path, after: never })

    expect((await readdir(dir)).sort()).toEqual(['downloadsFile'])
    const after = await HistoryStore.open({ filePath: path('historyFile') })
    expect(after.query()).toEqual([])
  })

  it('reads an unreadable exit note as cookies, site storage and cache — and nothing of the profile', async () => {
    const { path } = await profile()
    for (const name of ['historyFile', 'downloadsFile', 'sessionStateFile'] as const) {
      await writeFile(path(name), '{}')
    }
    await writeFile(path('pendingClearFile'), 'not json at all')
    const { session, calls } = fakeSession()

    await catchUpPendingClears({ session, path, after: never })

    expect(await exists(path('historyFile'))).toBe(true)
    expect(await exists(path('downloadsFile'))).toBe(true)
    expect(await exists(path('sessionStateFile'))).toBe(true)
    expect(calls).toContain('clearCache')
    expect(calls).toContain('clearData')
    expect(calls[0]).toMatch(/^clearStorageData:.*"cookies".*"localstorage"/)
    expect(await exists(path('pendingClearFile'))).toBe(false)
  })

  it('does what a panic note names, leaves the profile, and does not touch the exit note', async () => {
    const { path } = await profile()
    for (const name of [
      'sessionStateFile',
      'tabGroupsFile',
      'permissionsFile',
      'bookmarksFile',
      'passwordsFile'
    ] as const) {
      await writeFile(path(name), '{}')
    }
    await writeFile(path('panicPendingFile'), pendingClearText(['session', 'permissions']))
    const { session, calls } = fakeSession()

    await catchUpPendingClears({ session, path, after: never })

    expect(await exists(path('sessionStateFile'))).toBe(false)
    expect(await exists(path('tabGroupsFile'))).toBe(false)
    expect(await exists(path('permissionsFile'))).toBe(false)
    expect(await exists(path('bookmarksFile'))).toBe(true)
    expect(await exists(path('passwordsFile'))).toBe(true)
    expect(await exists(path('panicPendingFile'))).toBe(false)
    expect(calls).toEqual([])
  })

  it('reads an unreadable panic note as the whole panic', async () => {
    const { path } = await profile()
    await writeFile(path('sessionStateFile'), '{}')
    await writeFile(path('historyFile'), '{}')
    await writeFile(path('bookmarksFile'), '{}')
    await writeFile(path('panicPendingFile'), '[]')
    const { session, calls } = fakeSession()

    await catchUpPendingClears({ session, path, after: never })

    expect(await exists(path('sessionStateFile'))).toBe(false)
    expect(await exists(path('historyFile'))).toBe(false)
    expect(await exists(path('bookmarksFile'))).toBe(true)
    expect(calls).toContain('clearData')
  })

  it('does nothing when neither note is there', async () => {
    const { path } = await profile()
    const { session, calls } = fakeSession()
    await catchUpPendingClears({ session, path, after: never })
    expect(calls).toEqual([])
  })

  it('keeps a note whose clearing failed, says so, and lets the start go on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { path } = await profile()
    await writeFile(path('pendingClearFile'), pendingClearText(['cache']))
    const { session } = fakeSession('clearCache')

    await catchUpPendingClears({ session, path, after: never })

    expect(await exists(path('pendingClearFile'))).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/did not finish/))
  })

  it('says so when a note cannot even be read, and lets the start go on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { path } = await profile()
    // A directory where the note should be: reading it fails with something other than "not there".
    await mkdir(path('pendingClearFile'))

    await expect(
      catchUpPendingClears({ session: fakeSession().session, path, after: never })
    ).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/could not be handled/),
      expect.anything()
    )
  })
})

describe('the exit note on disk', () => {
  it('reads a missing note as none, and writes and removes it', async () => {
    const { path } = await profile()
    const file = noteFileAt(() => path('pendingClearFile'))

    expect(await file.read()).toBeNull()
    await file.write('text')
    expect(await file.read()).toBe('text')
    await file.remove()
    expect(await file.read()).toBeNull()
  })

  it('is armed from the settings at the start and follows them during the run', async () => {
    const { path } = await profile()
    const note = exitNoteAt(path)
    let snapshot: SettingsSnapshot = {
      ...defaultSettings(),
      'clearData.onExit': true,
      'clearData.onExitCategories': ['history']
    }
    const listeners: Array<(change: { snapshot: SettingsSnapshot }) => void> = []
    const settings = {
      snapshot: () => snapshot,
      onChange: (listener: (change: { snapshot: SettingsSnapshot }) => void) => {
        listeners.push(listener)
        return () => undefined
      }
    }

    await watchExitNote(note, settings)
    expect(await readFile(path('pendingClearFile'), 'utf8')).toBe(pendingClearText(['history']))

    snapshot = { ...snapshot, 'clearData.onExitCategories': ['downloads'] }
    for (const listener of listeners) listener({ snapshot })
    await vi.waitFor(async () => {
      expect(await readFile(path('pendingClearFile'), 'utf8')).toBe(pendingClearText(['downloads']))
    })

    snapshot = { ...snapshot, 'clearData.onExit': false }
    for (const listener of listeners) listener({ snapshot })
    await vi.waitFor(async () => {
      expect(await exists(path('pendingClearFile'))).toBe(false)
    })
  })

  it('warns rather than refusing to start when the note cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { path } = await profile()
    // The note's own path is a directory, so neither writing nor removing it can succeed.
    await mkdir(path('pendingClearFile'))
    await writeFile(join(path('pendingClearFile'), 'blocker'), '')
    const note = exitNoteAt(path)
    const listeners: Array<(change: { snapshot: SettingsSnapshot }) => void> = []
    const snapshot: SettingsSnapshot = { ...defaultSettings(), 'clearData.onExit': true }

    await watchExitNote(note, {
      snapshot: () => snapshot,
      onChange: (listener) => {
        listeners.push(listener)
        return () => undefined
      }
    })
    for (const listener of listeners)
      listener({ snapshot: { ...snapshot, 'clearData.onExit': false } })

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(2)
    })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/clear-on-exit/), expect.anything())
  })
})

describe('the caches clearing history seals', () => {
  /*
    The windows stay open while a quit waits, so a page can finish loading between the clearing and
    the flush. A sealed cache fetches, photographs and writes nothing more — including what was
    already on its way when the seal came.
  */
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const icon = (): Response => new Response(PNG, { headers: { 'content-type': 'image/png' } })

  it('lets a sealed favicon cache ask for nothing and write nothing', async () => {
    const { dir } = await profile()
    const requests: string[] = []
    const favicons = await FaviconStore.open({
      directory: join(dir, 'favicons'),
      fetch: (url) => {
        requests.push(url)
        return Promise.resolve(icon())
      },
      debounceMs: 0
    })

    favicons.seal()
    const outcome = await favicons
      .cacheFor('normal')
      .ensure('https://late.example/', ['https://late.example/favicon.png'])

    expect(outcome).toEqual({ kind: 'rejected', reason: 'write-failed' })
    expect(requests).toEqual([])
    expect(favicons.list()).toEqual([])
  })

  it('drops an icon that arrives after the seal', async () => {
    const { dir } = await profile()
    let answer!: (response: Response) => void
    const favicons = await FaviconStore.open({
      directory: join(dir, 'favicons'),
      fetch: () =>
        new Promise<Response>((resolve) => {
          answer = resolve
        }),
      debounceMs: 0
    })

    const pending = favicons
      .cacheFor('normal')
      .ensure('https://late.example/', ['https://late.example/favicon.png'])
    await vi.waitFor(() => {
      expect(answer).toBeTypeOf('function')
    })
    favicons.seal()
    answer(icon())

    expect(await pending).toEqual({ kind: 'rejected', reason: 'write-failed' })
    expect(favicons.list()).toEqual([])
    const directory = join(dir, 'favicons')
    const written = (await exists(directory)) ? await readdir(directory) : []
    expect(written.filter((name) => name !== 'index.json')).toEqual([])
  })

  it('lets a sealed thumbnail cache photograph nothing', async () => {
    const { dir } = await profile()
    let photographed = 0
    const picture: CapturedImage = {
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 500 }),
      crop: () => picture,
      resize: () => picture,
      toJPEG: () => new Uint8Array([0xff, 0xd8, 0xff])
    }
    const thumbnails = await ThumbnailStore.open({
      directory: join(dir, 'thumbnails'),
      capture: () => {
        photographed += 1
        return Promise.resolve(picture)
      },
      debounceMs: 0
    })
    const capturer = thumbnails.capturerFor('normal')

    thumbnails.seal()

    expect(capturer.shouldCapture('https://late.example/')).toBe(false)
    expect(await capturer.capture({ url: 'https://late.example/', title: '', viewId: 1 })).toEqual({
      kind: 'rejected',
      reason: 'discarded'
    })
    expect(photographed).toBe(0)
    expect(thumbnails.list()).toEqual([])
  })

  it('removes the copies of both indexes', async () => {
    const { dir } = await profile()
    const favicons = await FaviconStore.open({
      directory: join(dir, 'favicons'),
      fetch: () => Promise.resolve(icon()),
      debounceMs: 0
    })
    const thumbnails = await ThumbnailStore.open({
      directory: join(dir, 'thumbnails'),
      capture: () => Promise.resolve(null),
      debounceMs: 0
    })
    await mkdir(join(dir, 'favicons'), { recursive: true })
    await mkdir(join(dir, 'thumbnails'), { recursive: true })
    await writeFile(join(dir, 'favicons', 'index.json.unreadable'), 'old icons')
    await writeFile(join(dir, 'thumbnails', 'index.json.v1.bak'), 'old pictures')

    await Promise.all([favicons.discardCopies(), thumbnails.discardCopies()])

    expect(await readdir(join(dir, 'favicons'))).not.toContain('index.json.unreadable')
    expect(await readdir(join(dir, 'thumbnails'))).not.toContain('index.json.v1.bak')
  })
})
