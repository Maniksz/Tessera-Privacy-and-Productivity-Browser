import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DownloadStore } from '@main/data/DownloadStore.js'
import {
  DownloadManager,
  type DownloadSession,
  type DownloadSource,
  type DownloadViewer
} from '@main/downloads/DownloadManager.js'
import type { ForeignTransferRequest } from '@main/downloads/foreign-transfer.js'
import type { BrowsingMode } from '@main/data/HistoryStore.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import { summarizeWindowDownloads } from '@shared/downloads/summary.js'
import { FakeItem, FakeSession } from './download-fakes.js'

/**
 * The download manager, driven with plain objects in place of Electron's.
 *
 * Against the real `DownloadStore` on a temporary file rather than a fake book, because two of the
 * claims here are about the store: a private download must never reach it, and a finished normal
 * download must be answered from it once the live copy has gone.
 *
 * The first block pins what the manager did before downloads belonged to a window, so the change that
 * gave them one can be seen not to have moved anything else. The second is that change.
 */

const T0 = 1_700_000_000_000

const temporaryStores: DownloadStore[] = []

afterEach(async () => {
  await Promise.all(temporaryStores.splice(0).map((store) => store.flush()))
})

interface ResolverCall {
  source: DownloadSource | undefined
  session: DownloadSession
}

async function fixture(options: { windowFor?: (call: ResolverCall) => number | undefined } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-download-manager-'))
  let step = 0
  const now = (): number => {
    step += 1
    return T0 + step * 1_000
  }
  const store = await DownloadStore.open({
    filePath: join(dir, 'downloads.json'),
    debounceMs: 0,
    now
  })
  temporaryStores.push(store)

  const onDisk = new Set<string>()
  const shellCalls: string[] = []
  const resolverCalls: ResolverCall[] = []
  const windowFor = options.windowFor
  const manager = new DownloadManager({
    store,
    getSettings: () => defaultSettings(),
    defaultDirectory: () => '/downloads',
    fileExists: (path) => onDisk.has(path),
    shell: {
      openPath: (path) => {
        shellCalls.push(`open:${path}`)
        return Promise.resolve('')
      },
      showItemInFolder: (path) => {
        shellCalls.push(`reveal:${path}`)
      }
    },
    ...(windowFor === undefined
      ? {}
      : {
          windowFor: (source: DownloadSource | undefined, session: DownloadSession) => {
            resolverCalls.push({ source, session })
            return windowFor({ source, session })
          }
        }),
    now,
    progressIntervalMs: 0
  })
  return { manager, store, onDisk, shellCalls, resolverCalls }
}

/** One window as the manager sees it, with its session attached under its mode. */
function windowOf(
  manager: DownloadManager,
  windowId: number,
  mode: BrowsingMode,
  session = new FakeSession()
): DownloadViewer & { session: FakeSession } {
  manager.attach(session, mode)
  return { windowId, mode, session }
}

function urls(manager: DownloadManager, viewer: DownloadViewer): string[] {
  return manager.snapshot(viewer).map((entry) => entry.url)
}

function idOf(manager: DownloadManager, viewer: DownloadViewer, url: string): string {
  const found = manager.snapshot(viewer).find((entry) => entry.url === url)
  if (found === undefined) throw new Error(`no download from ${url}`)
  return found.id
}

describe('DownloadManager, as it stood before downloads had windows', () => {
  it('files a normal download and shows it to both kinds of window', async () => {
    const { manager, store } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const priv = windowOf(manager, 2, 'private')

    normal.session.download(new FakeItem('https://files.example/a.zip'))

    expect(store.list().map((record) => record.url)).toEqual(['https://files.example/a.zip'])
    expect(urls(manager, normal)).toEqual(['https://files.example/a.zip'])
    // The stored list is the profile's own history, and reading it from a private window reveals
    // nothing to anybody else.
    expect(urls(manager, priv)).toEqual(['https://files.example/a.zip'])
  })

  it('keeps a private download out of the store and out of a normal window', async () => {
    const { manager, store } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const priv = windowOf(manager, 2, 'private')

    priv.session.download(new FakeItem('https://files.example/p.zip'))

    expect(store.list()).toEqual([])
    expect(urls(manager, normal)).toEqual([])
    expect(urls(manager, priv)).toEqual(['https://files.example/p.zip'])
  })

  it('writes the save path synchronously, inside the event', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')

    const item = normal.session.download(new FakeItem('https://files.example/report.pdf'))

    expect(item.savePath).toBe(join('/downloads', 'report.pdf'))
  })

  it('pauses once and resumes only what can be resumed', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const item = normal.session.download(new FakeItem('https://files.example/a.zip'))
    const id = idOf(manager, normal, item.url)

    expect(manager.pause(id)).toBe(true)
    expect(manager.pause(id)).toBe(false)
    expect(manager.snapshot(normal)[0]?.state).toBe('paused')

    item.resumable = false
    expect(manager.resume(id)).toBe(false)
    item.resumable = true
    expect(manager.resume(id)).toBe(true)
    expect(item.calls).toEqual(['pause', 'resume'])
  })

  it('cancels through the item and waits for Chromium to say so', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const item = normal.session.download(new FakeItem('https://files.example/a.zip'))
    const id = idOf(manager, normal, item.url)

    expect(manager.cancel(id)).toBe(true)
    expect(item.calls).toEqual(['cancel'])
    expect(manager.snapshot(normal)[0]?.state).toBe('progressing')

    item.end('cancelled')
    expect(manager.snapshot(normal)[0]?.state).toBe('cancelled')
    expect(manager.cancel(id)).toBe(false)
  })

  it('answers a finished normal download from the store, and keeps a private one in memory', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const priv = windowOf(manager, 2, 'private')

    const stored = normal.session.download(new FakeItem('https://files.example/a.zip'))
    const kept = priv.session.download(new FakeItem('https://files.example/p.zip'))
    stored.end('completed')
    kept.end('completed')

    expect(manager.liveCount).toBe(1)
    expect(stored.listenerCount).toBe(0)
    expect(kept.listenerCount).toBe(0)
    expect(urls(manager, priv)).toEqual([
      'https://files.example/p.zip',
      'https://files.example/a.zip'
    ])
  })

  it('opens only a completed file that is still there', async () => {
    const { manager, onDisk, shellCalls } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const item = normal.session.download(new FakeItem('https://files.example/a.zip'))
    const id = idOf(manager, normal, item.url)

    expect(await manager.open(id)).toBe(false)
    item.end('completed')
    expect(await manager.open(id)).toBe(false)
    onDisk.add(item.savePath)
    expect(await manager.open(id)).toBe(true)
    expect(manager.reveal(id)).toBe(true)
    expect(shellCalls).toEqual([`open:${item.savePath}`, `reveal:${item.savePath}`])
  })

  it('clears finished rows and leaves a running one', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    normal.session.download(new FakeItem('https://files.example/done.zip')).end('completed')
    normal.session.download(new FakeItem('https://files.example/running.zip'))

    expect(manager.clear(normal)).toBe(1)
    expect(urls(manager, normal)).toEqual(['https://files.example/running.zip'])
  })

  it('drops a released session from memory and takes its listeners off', async () => {
    const { manager } = await fixture()
    const priv = windowOf(manager, 2, 'private')
    const item = priv.session.download(new FakeItem('https://files.example/p.zip'))

    manager.releaseSession(priv.session)

    expect(manager.liveCount).toBe(0)
    expect(item.listenerCount).toBe(0)
    expect(urls(manager, priv)).toEqual([])
  })
})

describe('DownloadManager, per window', () => {
  it('files a download under the window the resolver names for its web contents', async () => {
    // Tab 41 lives in window 1; the rule that says so is the registry's and is tested with it.
    const { manager, resolverCalls } = await fixture({
      windowFor: ({ source }) => (source?.id === 41 ? 1 : undefined)
    })
    const normal = windowOf(manager, 1, 'normal')

    normal.session.download(new FakeItem('https://files.example/a.zip'), 41)
    const id = idOf(manager, normal, 'https://files.example/a.zip')

    expect(resolverCalls).toEqual([{ source: { id: 41 }, session: normal.session }])
    expect([...manager.idsStartedIn(1)]).toEqual([id])
    expect([...manager.idsStartedIn(2)]).toEqual([])
  })

  it('hands the resolver no web contents when Electron names none', async () => {
    const { manager, resolverCalls } = await fixture({ windowFor: () => 1 })
    const normal = windowOf(manager, 1, 'normal')

    normal.session.download(new FakeItem('https://files.example/a.zip'))

    expect(resolverCalls).toEqual([{ source: undefined, session: normal.session }])
    expect(manager.idsStartedIn(1).size).toBe(1)
  })

  it('lists a download no window claims, without filing it under any', async () => {
    const { manager } = await fixture({ windowFor: () => undefined })
    const normal = windowOf(manager, 1, 'normal')

    normal.session.download(new FakeItem('https://files.example/a.zip'), 41)

    expect(urls(manager, normal)).toEqual(['https://files.example/a.zip'])
    expect(manager.idsStartedIn(1).size).toBe(0)
    expect(manager.windowsWithDownloads).toBe(0)
  })

  it('shows one private window its own downloads and no other window them (AE5)', async () => {
    const { manager } = await fixture({ windowFor: ({ source }) => source?.id })
    const normal = windowOf(manager, 1, 'normal')
    const first = windowOf(manager, 2, 'private')
    const second = windowOf(manager, 3, 'private')

    first.session.download(new FakeItem('https://files.example/p.zip'), 2)

    expect(urls(manager, first)).toEqual(['https://files.example/p.zip'])
    expect(urls(manager, second)).toEqual([])
    expect(urls(manager, normal)).toEqual([])
  })

  it('still shows a private window the stored history', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const priv = windowOf(manager, 2, 'private')
    normal.session.download(new FakeItem('https://files.example/a.zip')).end('completed')
    priv.session.download(new FakeItem('https://files.example/p.zip'))

    expect(urls(manager, priv)).toEqual([
      'https://files.example/p.zip',
      'https://files.example/a.zip'
    ])
  })

  it('reports a finished private download as finished', async () => {
    const { manager } = await fixture()
    const priv = windowOf(manager, 2, 'private')

    priv.session.download(new FakeItem('https://files.example/p.zip')).end('completed')

    /*
      The live copy is all a private download has, so it is the row. Kept with the record it had
      *before* the terminal patch, it would read "in progress" for as long as the window stayed open —
      with no way to open the file it had just finished writing, and never clearable.
    */
    expect(manager.snapshot(priv).map((entry) => entry.state)).toEqual(['completed'])
  })

  it('says whether a window may see a row', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const first = windowOf(manager, 2, 'private')
    const second = windowOf(manager, 3, 'private')
    normal.session.download(new FakeItem('https://files.example/a.zip'))
    first.session.download(new FakeItem('https://files.example/p.zip'))
    const stored = idOf(manager, normal, 'https://files.example/a.zip')
    const own = idOf(manager, first, 'https://files.example/p.zip')

    expect(manager.canSee(normal, stored)).toBe(true)
    expect(manager.canSee(first, stored)).toBe(true)
    expect(manager.canSee(first, own)).toBe(true)
    expect(manager.canSee(second, own)).toBe(false)
    expect(manager.canSee(normal, own)).toBe(false)
    expect(manager.canSee(normal, 'dl-invented')).toBe(false)
  })

  it('clears from a private window its own finished rows and the stored ones, never another private window’s', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const first = windowOf(manager, 2, 'private')
    const second = windowOf(manager, 3, 'private')
    normal.session.download(new FakeItem('https://files.example/a.zip')).end('completed')
    first.session.download(new FakeItem('https://files.example/mine.zip')).end('completed')
    first.session.download(new FakeItem('https://files.example/mine-running.zip'))
    second.session.download(new FakeItem('https://files.example/theirs.zip')).end('completed')

    manager.clear(first)

    expect(urls(manager, first)).toEqual(['https://files.example/mine-running.zip'])
    expect(urls(manager, second)).toEqual(['https://files.example/theirs.zip'])
  })

  it('leaves every private window’s rows alone when a normal window clears', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const priv = windowOf(manager, 2, 'private')
    priv.session.download(new FakeItem('https://files.example/p.zip')).end('completed')

    manager.clear(normal)

    expect(urls(manager, priv)).toEqual(['https://files.example/p.zip'])
  })

  it('keeps a normal download filed under its window after it ends', async () => {
    const { manager } = await fixture({ windowFor: () => 1 })
    const normal = windowOf(manager, 1, 'normal')

    normal.session.download(new FakeItem('https://files.example/a.zip')).end('completed')

    expect(manager.liveCount).toBe(0)
    expect([...manager.idsStartedIn(1)]).toEqual([
      idOf(manager, normal, 'https://files.example/a.zip')
    ])
  })

  it('forgets a window’s claim on a row that is removed or cleared, and keeps it on one still running', async () => {
    const { manager } = await fixture({ windowFor: () => 1 })
    const normal = windowOf(manager, 1, 'normal')
    normal.session.download(new FakeItem('https://files.example/removed.zip'))
    normal.session.download(new FakeItem('https://files.example/cleared.zip')).end('completed')
    normal.session.download(new FakeItem('https://files.example/running.zip'))
    const running = idOf(manager, normal, 'https://files.example/running.zip')

    manager.remove(idOf(manager, normal, 'https://files.example/removed.zip'))
    manager.clear(normal)

    expect([...manager.idsStartedIn(1)]).toEqual([running])
  })

  it('cancels every unfinished download of a closing private window before taking its listeners off', async () => {
    const { manager, shellCalls } = await fixture({ windowFor: () => 2 })
    const priv = windowOf(manager, 2, 'private')
    const running = priv.session.download(new FakeItem('https://files.example/running.zip'))
    const paused = priv.session.download(new FakeItem('https://files.example/paused.zip'))
    const finished = priv.session.download(new FakeItem('https://files.example/finished.zip'))
    manager.pause(idOf(manager, priv, paused.url))
    finished.end('completed')

    manager.releaseSession(priv.session)
    manager.releaseWindow(2, undefined)

    expect(running.calls).toEqual(['cancel', 'removeListener:updated', 'removeListener:done'])
    expect(paused.calls).toEqual([
      'pause',
      'cancel',
      'removeListener:updated',
      'removeListener:done'
    ])
    // Already over, so there is nothing to stop — and its listeners went when it ended.
    expect(finished.calls).not.toContain('cancel')
    expect(manager.liveCount).toBe(0)
    expect(urls(manager, priv)).toEqual([])
    // The partial file is Chromium's to remove on `cancel`. Nothing here is handed a path, and the
    // save path in particular can name a file that was already there.
    expect(shellCalls).toEqual([])
    expect(manager.windowsWithDownloads).toBe(0)
  })

  it('hands a closing normal window’s downloads to the window focused before it, and lets them run', async () => {
    const { manager } = await fixture({ windowFor: ({ source }) => source?.id })
    const first = windowOf(manager, 1, 'normal')
    const second = windowOf(manager, 2, 'normal', first.session)
    const item = first.session.download(new FakeItem('https://files.example/a.zip'), 1)
    const id = idOf(manager, first, item.url)

    manager.releaseWindow(1, 2)

    expect(item.calls).toEqual([])
    expect(item.listenerCount).toBe(2)
    expect([...manager.idsStartedIn(2)]).toEqual([id])
    expect(manager.idsStartedIn(1).size).toBe(0)
    expect(urls(manager, second)).toEqual([item.url])
  })

  it('leaves a closing normal window’s downloads unclaimed when no other window is open', async () => {
    const { manager } = await fixture({ windowFor: () => 1 })
    const normal = windowOf(manager, 1, 'normal')
    const item = normal.session.download(new FakeItem('https://files.example/a.zip'))

    manager.releaseWindow(1, undefined)

    expect(manager.windowsWithDownloads).toBe(0)
    expect(item.listenerCount).toBe(2)
    expect(manager.liveCount).toBe(1)
  })

  it('tells its listeners when a window’s downloads change hands', async () => {
    const { manager } = await fixture({ windowFor: () => 1 })
    const normal = windowOf(manager, 1, 'normal')
    normal.session.download(new FakeItem('https://files.example/a.zip'))
    let heard = 0
    manager.onChange(() => {
      heard += 1
    })

    manager.releaseWindow(1, 2)

    expect(heard).toBe(1)
  })
})

/**
 * A transfer from outside Chromium — the media downloader is the first — as its producer would hand it
 * over: a target the producer already chose, a cancel that aborts its own work, and no pause unless it
 * says so.
 */
function transferIn(
  manager: DownloadManager,
  viewer: DownloadViewer,
  overrides: Partial<ForeignTransferRequest> = {}
) {
  const calls: string[] = []
  const transfer = manager.track({
    windowId: viewer.windowId,
    session: viewer.session,
    url: 'https://media.example/watch',
    fileName: 'clip.mp4',
    targetPath: join('/downloads', 'clip.mp4'),
    cancel: () => {
      calls.push('cancel')
    },
    ...overrides
  })
  return { transfer, calls }
}

describe('DownloadManager, transfers that did not come from Chromium', () => {
  it('lists a transfer and files it under the window that started it', async () => {
    const { manager, store } = await fixture()
    const normal = windowOf(manager, 1, 'normal')

    const { transfer } = transferIn(manager, normal)
    transfer?.progress({ receivedBytes: 250, totalBytes: 1_000 })

    expect(transfer?.id).toMatch(/^dl-/)
    const [entry] = manager.snapshot(normal)
    expect(entry).toMatchObject({
      id: transfer?.id,
      fileName: 'clip.mp4',
      savePath: join('/downloads', 'clip.mp4'),
      state: 'progressing',
      receivedBytes: 250,
      totalBytes: 1_000
    })
    expect([...manager.idsStartedIn(1)]).toEqual([transfer?.id])
    expect(
      summarizeWindowDownloads(manager.snapshot(normal), manager.idsStartedIn(1), null)
    ).toEqual({
      visible: true,
      activity: { kind: 'fraction', fraction: 0.25 },
      marker: null
    })
    // Written down like any normal download, and in the same namespace as Chromium's.
    expect(store.list().map((record) => record.id)).toEqual([transfer?.id])
    normal.session.download(new FakeItem('https://files.example/a.zip'))
    expect(new Set(manager.snapshot(normal).map((row) => row.id)).size).toBe(2)
  })

  it('shows an unknown total as activity without a share', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')

    const { transfer } = transferIn(manager, normal)
    // What the media downloader reports for a segmented stream.
    transfer?.progress({ receivedBytes: 4_096, totalBytes: null })

    expect(manager.snapshot(normal)[0]).toMatchObject({ receivedBytes: 4_096, totalBytes: 0 })
    expect(
      summarizeWindowDownloads(manager.snapshot(normal), manager.idsStartedIn(1), null).activity
    ).toEqual({ kind: 'indeterminate' })
  })

  it('cancels through the callback and reads as cancelled at once', async () => {
    const { manager, store } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const { transfer, calls } = transferIn(manager, normal)
    const id = transfer?.id ?? ''

    expect(manager.cancel(id)).toBe(true)

    expect(calls).toEqual(['cancel'])
    expect(manager.snapshot(normal)[0]?.state).toBe('cancelled')
    expect(store.find(id)?.state).toBe('cancelled')
    expect(manager.cancel(id)).toBe(false)
    // The producer's own abort reports late, as an aborted fetch does; the row stays what it was.
    transfer?.fail()
    expect(manager.snapshot(normal)[0]?.state).toBe('cancelled')
  })

  it('does nothing when asked to pause a transfer that cannot pause', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const { transfer, calls } = transferIn(manager, normal)
    const id = transfer?.id ?? ''

    expect(manager.pause(id)).toBe(false)
    expect(manager.resume(id)).toBe(false)
    expect(manager.snapshot(normal)[0]?.state).toBe('progressing')
    expect(calls).toEqual([])
  })

  it('pauses and resumes a transfer that says it can', async () => {
    const { manager } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const pausing: string[] = []
    const { transfer } = transferIn(manager, normal, {
      pausing: { pause: () => pausing.push('pause'), resume: () => pausing.push('resume') }
    })
    const id = transfer?.id ?? ''

    expect(manager.pause(id)).toBe(true)
    expect(manager.pause(id)).toBe(false)
    expect(manager.snapshot(normal)[0]?.state).toBe('paused')
    expect(manager.resume(id)).toBe(true)
    expect(manager.snapshot(normal)[0]?.state).toBe('progressing')
    expect(pausing).toEqual(['pause', 'resume'])
  })

  it('finishes as the producer says, and ignores anything after', async () => {
    const { manager, store, onDisk } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const done = transferIn(manager, normal).transfer
    const failed = transferIn(manager, normal, {
      fileName: 'other.mp4',
      targetPath: join('/downloads', 'other.mp4')
    }).transfer

    done?.progress({ receivedBytes: 1_000, totalBytes: 1_000 })
    done?.complete()
    failed?.fail()
    done?.progress({ receivedBytes: 5, totalBytes: 1_000 })

    expect(store.find(done?.id ?? '')?.state).toBe('completed')
    expect(store.find(failed?.id ?? '')?.state).toBe('interrupted')
    expect(manager.snapshot(normal).find((row) => row.id === done?.id)?.receivedBytes).toBe(1_000)
    expect(manager.liveCount).toBe(0)
    onDisk.add(join('/downloads', 'clip.mp4'))
    expect(await manager.open(done?.id ?? '')).toBe(true)
  })

  it('keeps a private transfer out of the store and ends it with its window', async () => {
    const { manager, store } = await fixture()
    const normal = windowOf(manager, 1, 'normal')
    const priv = windowOf(manager, 2, 'private')
    const other = windowOf(manager, 3, 'private')

    const running = transferIn(manager, priv)
    const finished = transferIn(manager, priv, {
      fileName: 'other.mp4',
      targetPath: join('/downloads', 'other.mp4')
    })
    finished.transfer?.complete()

    expect(store.list()).toEqual([])
    expect(
      manager
        .snapshot(priv)
        .map((row) => row.state)
        .sort()
    ).toEqual(['completed', 'progressing'])
    expect(urls(manager, other)).toEqual([])
    expect(urls(manager, normal)).toEqual([])
    expect(manager.idsStartedIn(2).size).toBe(2)

    manager.releaseSession(priv.session)
    manager.releaseWindow(2, undefined)

    expect(running.calls).toEqual(['cancel'])
    expect(finished.calls).toEqual([])
    expect(manager.liveCount).toBe(0)
    expect(urls(manager, priv)).toEqual([])
    expect(manager.windowsWithDownloads).toBe(0)
    expect(store.list()).toEqual([])
  })

  it.each([
    ['a relative target', { targetPath: 'clip.mp4' }],
    ['a target that is not normalised', { targetPath: '/downloads/x/../clip.mp4' }],
    ['a target name the sanitiser would change', { targetPath: join('/downloads', '.clip.mp4') }],
    ['a file name the sanitiser would change', { fileName: 'a/../clip.mp4' }]
  ])('refuses %s, and never lists it', async (_label, overrides) => {
    const { manager, store } = await fixture()
    const normal = windowOf(manager, 1, 'normal')

    const { transfer } = transferIn(manager, normal, overrides)

    expect(transfer).toBeNull()
    expect(manager.snapshot(normal)).toEqual([])
    expect(store.list()).toEqual([])
    expect(manager.idsStartedIn(1).size).toBe(0)
  })

  it('refuses a transfer on a session nothing attached, whose mode nobody bound', async () => {
    const { manager, store } = await fixture()
    const stray: DownloadViewer = { windowId: 1, mode: 'normal', session: new FakeSession() }

    expect(transferIn(manager, stray).transfer).toBeNull()
    expect(manager.snapshot(stray)).toEqual([])
    expect(store.list()).toEqual([])
  })
})
