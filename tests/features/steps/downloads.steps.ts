import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { DownloadStore } from '@main/data/DownloadStore.js'
import { DownloadManager, type DownloadViewer } from '@main/downloads/DownloadManager.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import { MAX_DOWNLOAD_FILE_NAME_LENGTH, downloadFileNameFor } from '@shared/downloads/filename.js'
import {
  canOpenDownload,
  downloadFraction,
  fileWentMissing,
  isActiveDownload,
  isDownloadState,
  type DownloadEntry,
  type DownloadRecord,
  type DownloadRecorder
} from '@shared/downloads/model.js'
import type { IpcMainInvokeEvent } from 'electron'
import {
  registerDownloadHandlers,
  type DownloadHandle,
  type DownloadHandlerWindow
} from '@main/ipc/download-handlers.js'
import {
  downloadsPanelPresentation,
  downloadsPanelUpdate,
  type OverlayState
} from '@shared/overlay/surface.js'
import { FakeItem, FakeSession } from '../../download-fakes.js'
import { scope, tempFile } from './world.js'

/**
 * Steps for `downloads.feature`.
 *
 * Three parts, and they are separate on purpose.
 *
 * The naming steps call `downloadFileNameFor` and nothing else, because that function is the
 * one choke point every candidate name passes through — a scenario that went via a download
 * manager would be testing the plumbing around the decision rather than the decision.
 *
 * The list steps drive the real `DownloadStore` against a temporary file. That matters for
 * two scenarios in particular: a private window has to be handed its recorder by the store
 * (`recorderFor`), or "a private window records nothing" would be a claim about a stub, and
 * "a download still running when the browser closed" is only true if the record makes the
 * round trip through the file and back through `repairDownloads`.
 *
 * Whether the *file* is still on disk is stated by the scenario. The probe itself belongs to
 * `DownloadManager`, which needs a real filesystem and a real download; what is decided here
 * is what a row does with the answer.
 *
 * The window steps are the exception that proves the split: which window sees which download
 * is decided *only* in `DownloadManager`, by session, so those scenarios drive the real manager
 * over the real store — with Electron's items and sessions replaced by the plain objects the
 * manager's own tests use, and a window's close modelled as the two calls the registry makes.
 */

interface DataTable {
  hashes(): Array<Record<string, string>>
}

const NOW = 1_700_000_000_000

async function openList(state: unknown): Promise<void> {
  const current = scope(state)
  const filePath =
    (current.scratch['downloadFile'] as string | undefined) ??
    tempFile('downloads', 'downloads.json')
  current.scratch['downloadFile'] = filePath
  const store = await DownloadStore.open({
    filePath,
    now: () => NOW,
    debounceMs: 0
  })
  current.scratch['downloadStore'] = store
  current.downloads = store.list()
}

function store(state: unknown): DownloadStore {
  const existing = scope(state).scratch['downloadStore']
  if (!(existing instanceof DownloadStore)) {
    throw new Error('this scenario has no download list; add a Given for it')
  }
  return existing
}

/**
 * The writer for this scenario's window.
 *
 * Obtained from the store rather than chosen here, which is the whole point: a private window
 * is handed an object with no reference to the store, so there is nothing for a forgotten
 * check to leak into.
 */
function recorder(state: unknown): DownloadRecorder {
  return store(state).recorderFor(scope(state).privateWindow ? 'private' : 'normal')
}

function refresh(state: unknown): void {
  scope(state).downloads = store(state).list()
}

function rowFor(state: unknown, fileName: string): DownloadRecord {
  const found = scope(state).downloads.find((record) => record.fileName === fileName)
  if (found === undefined) {
    throw new Error(
      `no download called "${fileName}"; have: ${scope(state)
        .downloads.map((record) => record.fileName)
        .join(', ')}`
    )
  }
  return found
}

/**
 * A row as the page sees it: the stored record plus the two things that are never stored. A stored row
 * has no transfer behind it in this process, so it cannot pause.
 */
function entryFor(state: unknown, fileName: string): DownloadEntry {
  return {
    ...rowFor(state, fileName),
    onDisk: scope(state).filesOnDisk.has(fileName),
    canPause: false
  }
}

function nameFrom(state: unknown, sources: { url: string; contentDisposition?: string }): void {
  scope(state).downloadName = downloadFileNameFor({
    url: sources.url,
    ...(sources.contentDisposition === undefined
      ? {}
      : { contentDisposition: sources.contentDisposition })
  })
}

function writtenName(state: unknown): string {
  const name = scope(state).downloadName
  if (name === null) throw new Error('no download was named in this scenario')
  return name
}

/** The windows of a scenario that has them, by the names the feature gives them. */
interface WindowWorld {
  manager: DownloadManager
  windows: Map<string, DownloadViewer & { session: FakeSession }>
  items: Map<string, FakeItem>
}

function windowWorld(state: unknown): WindowWorld {
  const existing = scope(state).scratch['downloadWindows'] as WindowWorld | undefined
  if (existing === undefined) throw new Error('this scenario has no windows; add a Given for them')
  return existing
}

function openWindow(state: unknown, name: string): DownloadViewer & { session: FakeSession } {
  const found = windowWorld(state).windows.get(name)
  if (found === undefined) throw new Error(`no open window called "${name}"`)
  return found
}

function listedIn(state: unknown, viewer: DownloadViewer): string[] {
  return windowWorld(state)
    .manager.snapshot(viewer)
    .map((entry) => entry.fileName)
}

/**
 * One window with its downloads page open and its panel on the overlay layer, for the scenario where an
 * action in one view has to show in the other.
 *
 * The manager and the `downloads:*` handlers are the real ones, so the cancel travels the way a click
 * does: a request from the overlay's web contents, checked against the window's list, handed to the
 * manager, answered by Chromium through `done`, and pushed. The window is the part that needs Electron,
 * so it is a plain object — and its panel follows the controller's own rule for re-presenting, which is
 * `downloadsPanelUpdate`, rather than a copy of it.
 */
interface PanelWorld {
  manager: DownloadManager
  session: FakeSession
  handlers: Map<string, (payload: never, event: IpcMainInvokeEvent) => unknown>
  items: Map<string, FakeItem>
  /** Every list the page in the tab was pushed, in order. */
  pagePushes: DownloadEntry[][]
  /** What the window's overlay layer shows. */
  overlay: OverlayState
}

/** The window's web contents, by role: its chrome UI, its overlay layer, and the tab with the page. */
const CHROME_ID = 1
const OVERLAY_ID = 2
const PAGE_TAB_ID = 11

function panelWorld(state: unknown): PanelWorld {
  const existing = scope(state).scratch['downloadPanel'] as PanelWorld | undefined
  if (existing === undefined)
    throw new Error('this scenario has no window with a panel; add a Given')
  return existing
}

// --- given -------------------------------------------------------------------

Given('a window with the downloads page open in one of its tabs', async (state: unknown) => {
  await openList(state)
  const session = new FakeSession()
  const manager = new DownloadManager({
    store: store(state),
    getSettings: () => defaultSettings(),
    defaultDirectory: () => '/downloads',
    fileExists: () => false,
    shell: { openPath: () => Promise.resolve(''), showItemInFolder: () => {} },
    windowFor: (source) => (source === undefined ? undefined : 1),
    now: () => NOW,
    progressIntervalMs: 0
  })
  manager.attach(session, 'normal')

  const world: PanelWorld = {
    manager,
    session,
    handlers: new Map(),
    items: new Map(),
    pagePushes: [],
    overlay: null
  }
  const window: DownloadHandlerWindow = {
    viewer: { windowId: 1, mode: 'normal', session },
    sends: (webContentsId) => [CHROME_ID, OVERLAY_ID, PAGE_TAB_ID].includes(webContentsId),
    emitToInternalPages: (_channel, payload) => {
      world.pagePushes.push(payload.downloads)
    },
    emit: () => {},
    downloadsPanelPresentedAt: null,
    refreshDownloadsPanel: (entries) => {
      world.overlay = downloadsPanelUpdate(world.overlay, entries) ?? world.overlay
    }
  }
  const handle: DownloadHandle = (channel, handler) => {
    world.handlers.set(channel, handler)
  }
  registerDownloadHandlers({
    handle,
    downloads: manager,
    windows: { downloadWindows: [window], onDownloadsPanelPresented: () => {} },
    discardCopies: () => Promise.resolve()
  })
  scope(state).scratch['downloadPanel'] = world
})

Given('{string} is downloading in that window', (state: unknown, url: string) => {
  const world = panelWorld(state)
  const item = world.session.download(new FakeItem(url), PAGE_TAB_ID)
  world.items.set(downloadFileNameFor({ url }), item)
})

Given("the window's downloads panel is open", (state: unknown) => {
  const world = panelWorld(state)
  // As the controller builds it when the chrome UI asks: the window's list, freshly probed.
  world.overlay = downloadsPanelPresentation(
    { x: 1300, y: 44, width: 32, height: 28 },
    world.manager.list({ windowId: 1, mode: 'normal', session: world.session })
  )
})

Given('a normal window and two private windows', async (state: unknown) => {
  await openList(state)
  const manager = new DownloadManager({
    store: store(state),
    getSettings: () => defaultSettings(),
    defaultDirectory: () => '/downloads',
    fileExists: () => false,
    shell: { openPath: () => Promise.resolve(''), showItemInFolder: () => {} },
    // Each window's tab is named by the window's own id here, so the resolver is the identity.
    windowFor: (source) => source?.id,
    now: () => NOW,
    progressIntervalMs: 0
  })
  const windows = new Map<string, DownloadViewer & { session: FakeSession }>()
  const add = (name: string, windowId: number, mode: 'normal' | 'private'): void => {
    const session = new FakeSession()
    manager.attach(session, mode)
    windows.set(name, { windowId, mode, session })
  }
  add('normal', 1, 'normal')
  add('first private', 2, 'private')
  add('second private', 3, 'private')
  const world: WindowWorld = { manager, windows, items: new Map() }
  scope(state).scratch['downloadWindows'] = world
})

Given('a download list', async (state: unknown) => {
  await openList(state)
})

Given('a private window', (state: unknown) => {
  scope(state).privateWindow = true
})

Given('a download list holding:', async (state: unknown, table: DataTable) => {
  await openList(state)
  const writer = recorder(state)
  for (const [index, row] of table.hashes().entries()) {
    const fileName = (row['file'] ?? '').trim()
    const state_ = (row['state'] ?? '').trim()
    if (!isDownloadState(state_)) throw new Error(`not a download state: ${state_}`)
    const id = `download-${index + 1}`
    writer.start({
      id,
      url: (row['address'] ?? '').trim(),
      fileName,
      savePath: `/downloads/${fileName}`,
      mimeType: 'application/octet-stream',
      totalBytes: Number(row['total'] ?? '0'),
      startedAt: NOW
    })
    writer.update(id, {
      state: state_,
      receivedBytes: Number(row['received'] ?? '0'),
      totalBytes: Number(row['total'] ?? '0')
    })
    if ((row['on disk'] ?? '').trim() === 'yes') scope(state).filesOnDisk.add(fileName)
  }
  refresh(state)
})

// --- when: the name a download is written under ------------------------------

When(
  'a download arrives from {string} with the header {string}',
  (state: unknown, url: string, header: string) => {
    nameFrom(state, { url, contentDisposition: header })
  }
)

When(
  'a download arrives from {string} with this header:',
  (state: unknown, url: string, header: string) => {
    nameFrom(state, { url, contentDisposition: header })
  }
)

When(
  'a download arrives from {string} with a filename that hides its extension behind a right-to-left override',
  (state: unknown, url: string) => {
    /*
      U+202E renders the tail of the name reversed, so this is drawn as `invoiceexe.png` by
      every list that shows it — while the operating system still opens it as a program. The
      character is written here rather than in the feature file because an invisible character
      in a specification is a specification nobody can review.
    */
    nameFrom(state, { url, contentDisposition: 'attachment; filename=invoice‮gnp.exe' })
  }
)

When(
  'a download arrives from {string} with a filename of {int} characters ending in {string}',
  (state: unknown, url: string, length: number, extension: string) => {
    const stem = 'a'.repeat(Math.max(0, length - extension.length))
    nameFrom(state, { url, contentDisposition: `attachment; filename=${stem}${extension}` })
  }
)

// --- when: the list ----------------------------------------------------------

When('a download of {string} starts', (state: unknown, url: string) => {
  const fileName = downloadFileNameFor({ url })
  recorder(state).start({
    id: 'download-1',
    url,
    fileName,
    savePath: `/downloads/${fileName}`,
    mimeType: 'application/octet-stream',
    totalBytes: 4_000_000,
    startedAt: NOW
  })
  scope(state).scratch['startedId'] = 'download-1'
  refresh(state)
})

When(
  '{string} is downloaded in the {word} private window',
  (state: unknown, url: string, which: string) => {
    const window = openWindow(state, `${which} private`)
    const item = window.session.download(new FakeItem(url), window.windowId)
    windowWorld(state).items.set(downloadFileNameFor({ url }), item)
  }
)

When(
  'the {word} private window is closed while the download is still running',
  (state: unknown, which: string) => {
    const world = windowWorld(state)
    const name = `${which} private`
    const window = openWindow(state, name)
    // The registry's two calls on a private window's close, in its order.
    world.manager.releaseSession(window.session)
    world.manager.releaseWindow(window.windowId, undefined)
    world.windows.delete(name)
  }
)

When('the browser is closed and started again', async (state: unknown) => {
  // Flush first, then reopen the same file: the interesting behaviour is what `repairDownloads`
  // makes of a record whose writer is gone, and an in-memory copy would prove nothing about it.
  await store(state).flush()
  await openList(state)
})

When('I clear the download list', (state: unknown) => {
  store(state).clear()
  refresh(state)
})

When('{string} is cancelled from the panel', async (state: unknown, fileName: string) => {
  const world = panelWorld(state)
  const cancel = world.handlers.get('downloads:cancel')
  const row = world.overlay?.kind === 'downloads-panel' ? world.overlay.downloads : []
  const id = row.find((entry) => entry.fileName === fileName)?.id
  if (cancel === undefined || id === undefined) throw new Error(`the panel shows no "${fileName}"`)
  // From the overlay's web contents, which is where the panel's button is.
  const event = { sender: { id: OVERLAY_ID } } as unknown as IpcMainInvokeEvent
  const request = { id }
  expect(await cancel(request as never, event)).toEqual({ changed: true })
  // And Chromium answers as it does: the state moves, then `done` fires.
  world.items.get(fileName)?.end('cancelled')
})

// --- then: the name ----------------------------------------------------------

Then('it is written as {string}', (state: unknown, name: string) => {
  expect(writtenName(state)).toBe(name)
})

Then('the name ends in {string}', (state: unknown, extension: string) => {
  // The extension is what decides which application opens the file, so it is what survives
  // truncation — and what a bidirectional override must not be able to disguise.
  expect(writtenName(state).endsWith(extension)).toBe(true)
})

Then('the name is at most {int} characters', (state: unknown, length: number) => {
  expect(length).toBe(MAX_DOWNLOAD_FILE_NAME_LENGTH)
  expect(writtenName(state).length).toBeLessThanOrEqual(length)
})

// --- then: windows -----------------------------------------------------------

Then(
  'the {word} private window lists {string}',
  (state: unknown, which: string, fileName: string) => {
    expect(listedIn(state, openWindow(state, `${which} private`))).toContain(fileName)
  }
)

Then(
  'the {word} private window does not list {string}',
  (state: unknown, which: string, fileName: string) => {
    expect(listedIn(state, openWindow(state, `${which} private`))).not.toContain(fileName)
  }
)

Then('the normal window does not list {string}', (state: unknown, fileName: string) => {
  expect(listedIn(state, openWindow(state, 'normal'))).not.toContain(fileName)
})

Then('no open window lists {string}', (state: unknown, fileName: string) => {
  const open = [...windowWorld(state).windows.values()]
  expect(open.length).toBeGreaterThan(0)
  for (const window of open) expect(listedIn(state, window)).not.toContain(fileName)
})

Then('the download of {string} was stopped', (state: unknown, fileName: string) => {
  const item = windowWorld(state).items.get(fileName)
  if (item === undefined) throw new Error(`nothing was downloaded as "${fileName}"`)
  // Stopped, and only then let go of: a transfer whose listeners went first would go on writing
  // where nobody could see it.
  expect(item.calls).toEqual(['cancel', 'removeListener:updated', 'removeListener:done'])
})

Then('the browser keeps nothing of it in memory', (state: unknown) => {
  const { manager } = windowWorld(state)
  expect(manager.liveCount).toBe(0)
  expect(manager.windowsWithDownloads).toBe(0)
})

// --- then: the panel and the page ----------------------------------------------

Then('the downloads page shows {string} as cancelled', (state: unknown, fileName: string) => {
  const latest = panelWorld(state).pagePushes.at(-1) ?? []
  expect(latest.find((entry) => entry.fileName === fileName)?.state).toBe('cancelled')
})

Then('the panel shows {string} as cancelled', (state: unknown, fileName: string) => {
  const overlay = panelWorld(state).overlay
  if (overlay?.kind !== 'downloads-panel') throw new Error('the panel is not up any more')
  const row = overlay.downloads.find((entry) => entry.fileName === fileName)
  expect(row?.state).toBe('cancelled')
  // Finished, so there is no transfer left to pause.
  expect(row?.canPause).toBe(false)
})

// --- then: the list ----------------------------------------------------------

Then('the download list is empty', (state: unknown) => {
  expect(scope(state).downloads).toEqual([])
})

Then('the browser does not claim to know that download', (state: unknown) => {
  const id = scope(state).scratch['startedId']
  expect(recorder(state).remembers(typeof id === 'string' ? id : '')).toBe(false)
})

Then('the download list holds {int} download', (state: unknown, count: number) => {
  expect(scope(state).downloads).toHaveLength(count)
})

Then('the download list holds {int} downloads', (state: unknown, count: number) => {
  expect(scope(state).downloads).toHaveLength(count)
})

Then('the row for {string} offers no way to open it', (state: unknown, fileName: string) => {
  expect(canOpenDownload(entryFor(state, fileName))).toBe(false)
})

Then('the row for {string} can be opened', (state: unknown, fileName: string) => {
  expect(canOpenDownload(entryFor(state, fileName))).toBe(true)
})

Then(
  'the row for {string} says the file was moved or deleted',
  (state: unknown, fileName: string) => {
    expect(fileWentMissing(entryFor(state, fileName))).toBe(true)
  }
)

Then(
  'the row for {string} says nothing about a missing file',
  (state: unknown, fileName: string) => {
    // A download the user cancelled never wrote a file; telling them it was moved is nonsense.
    expect(fileWentMissing(entryFor(state, fileName))).toBe(false)
  }
)

Then('the row for {string} is interrupted', (state: unknown, fileName: string) => {
  expect(rowFor(state, fileName).state).toBe('interrupted')
})

Then('the row for {string} gives no reason it made up', (state: unknown, fileName: string) => {
  // A browser that closed mid-download genuinely does not know why; a made-up message would
  // make an unexplained failure look like a diagnosed one.
  expect(rowFor(state, fileName).interruptReason).toBe('')
})

Then('the row for {string} is still running', (state: unknown, fileName: string) => {
  expect(isActiveDownload(rowFor(state, fileName))).toBe(true)
})

Then(
  'the row for {string} can still be paused, resumed or cancelled',
  (state: unknown, fileName: string) => {
    // A paused download still has a partial file and can be resumed; treating it as finished
    // is how the resume button disappears from the one row that needs it.
    expect(isActiveDownload(rowFor(state, fileName))).toBe(true)
  }
)

Then(
  'the progress for {string} is unknown rather than nought',
  (state: unknown, fileName: string) => {
    // Nought would draw a bar that never moves for the whole download.
    expect(downloadFraction(rowFor(state, fileName))).toBeNull()
  }
)

Then(
  'the progress for {string} is full rather than past full',
  (state: unknown, fileName: string) => {
    expect(downloadFraction(rowFor(state, fileName))).toBe(1)
  }
)
