import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import type { DownloadEntry } from '@shared/downloads/model.js'
import type { EventPayload } from '@shared/ipc/contract.js'
import {
  registerDownloadHandlers,
  type DownloadHandle,
  type DownloadHandlerManager,
  type DownloadHandlerWindow
} from '@main/ipc/download-handlers.js'

/**
 * The `downloads:*` handler bodies.
 *
 * Reachable by a test because `registerDownloadHandlers` is handed its registrar rather than
 * importing `ipc/router.ts`, which pulls in `ipcMain` and therefore only exists inside a running
 * Electron process. The things worth asserting here are the ones that are decisions rather than
 * forwards: which window a request came from, which list that window is shown, which rows it may act
 * on, and who the change event reaches with which flag.
 */

const T0 = 1_700_000_000_000

function entry(id: string, overrides: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    id,
    url: `https://example.com/${id}.zip`,
    fileName: `${id}.zip`,
    savePath: `/tmp/${id}.zip`,
    mimeType: 'application/zip',
    totalBytes: 100,
    receivedBytes: 100,
    state: 'completed',
    startedAt: T0,
    endedAt: T0 + 1,
    interruptReason: '',
    onDisk: true,
    canPause: false,
    ...overrides
  }
}

interface FakeManager extends DownloadHandlerManager {
  readonly calls: string[]
  fire(): void
}

/**
 * A manager that answers by window, and says which ids each window can see.
 *
 * `visible` stands in for the manager's own rule — the session filter `DownloadManager.canSee` applies,
 * tested with the manager. What is asserted here is that the handlers ask it, and ask it for the window
 * the request really came from, before anything reaches the manager's actions.
 */
function fakeManager(
  options: {
    byWindow?: Record<number, DownloadEntry[]>
    visible?: Record<number, readonly string[]>
    /** Which ids each window started — `DownloadManager.idsStartedIn`. None, unless said. */
    startedIn?: Record<number, readonly string[]>
  } = {}
) {
  const calls: string[] = []
  const listeners = new Set<() => void>()
  const byWindow = options.byWindow ?? {}
  const visible = options.visible ?? {}
  const startedIn = options.startedIn ?? {}
  const manager: FakeManager = {
    calls,
    fire: () => {
      for (const listener of listeners) listener()
    },
    list: (viewer) => {
      calls.push(`list:${viewer.windowId}`)
      return byWindow[viewer.windowId] ?? []
    },
    snapshot: (viewer) => {
      calls.push(`snapshot:${viewer.windowId}`)
      return byWindow[viewer.windowId] ?? []
    },
    idsStartedIn: (windowId) => new Set(startedIn[windowId] ?? []),
    canSee: (viewer, id) =>
      (visible[viewer.windowId] ?? ['live', 'finished', 'here', 'gone', 'a']).includes(id),
    pause: (id) => {
      calls.push(`pause:${id}`)
      return id === 'live'
    },
    resume: (id) => {
      calls.push(`resume:${id}`)
      return id === 'live'
    },
    cancel: (id) => {
      calls.push(`cancel:${id}`)
      return id === 'live'
    },
    remove: (id) => {
      calls.push(`remove:${id}`)
      return id !== 'gone'
    },
    clear: (viewer) => {
      calls.push(`clear:${viewer.windowId}`)
      return 3
    },
    open: (id) => {
      calls.push(`open:${id}`)
      return Promise.resolve(id !== 'gone')
    },
    reveal: (id) => {
      calls.push(`reveal:${id}`)
      return id !== 'gone'
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return manager
}

interface FakeWindow extends DownloadHandlerWindow {
  readonly pushed: EventPayload<'downloads:changed'>[]
  /** What reached this window's chrome UI: the button's summaries, in order. */
  readonly chrome: EventPayload<'downloads:summaryChanged'>[]
  /** Stands in for the controller's own record; set by `present` below. */
  downloadsPanelPresentedAt: number | null
  /** Every set of rows the window was handed for its panel, in order; `refreshDownloadsPanel`. */
  readonly panel: Array<readonly DownloadEntry[]>
}

/**
 * One window: its id, its kind, and the web contents that speak for it.
 *
 * The chrome UI's id is the window id, and each tab's is the window id times ten plus its position — so
 * window 1's tabs are 11 and 12. Only a convention of this file, but it keeps every sender id below
 * readable as "which window, and was it a page".
 */
function fakeWindow(windowId: number, privateMode: boolean): FakeWindow {
  const pushed: EventPayload<'downloads:changed'>[] = []
  const chrome: EventPayload<'downloads:summaryChanged'>[] = []
  const panel: Array<readonly DownloadEntry[]> = []
  const contents = [windowId, windowId * 10 + 1, windowId * 10 + 2]
  return {
    // A session per window, as the registry gives each private window its own partition.
    viewer: { windowId, mode: privateMode ? 'private' : 'normal', session: { on: () => {} } },
    pushed,
    chrome,
    downloadsPanelPresentedAt: null,
    sends: (webContentsId) => contents.includes(webContentsId),
    emitToInternalPages: (_channel, payload) => {
      pushed.push(payload)
    },
    emit: (_channel, payload) => {
      chrome.push(payload)
    },
    panel,
    refreshDownloadsPanel: (entries) => {
      panel.push(entries)
    }
  }
}

type AnyHandler = (payload: never, event: IpcMainInvokeEvent) => unknown

function harness(options: {
  manager: FakeManager
  windows: FakeWindow[]
  clock?: { now: number }
}) {
  const handlers = new Map<string, AnyHandler>()
  const handle: DownloadHandle = (channel, handler) => {
    handlers.set(channel, handler)
  }
  const presented = new Set<(window: DownloadHandlerWindow) => void>()
  const clock = options.clock ?? { now: T0 }

  registerDownloadHandlers({
    handle,
    downloads: options.manager,
    windows: {
      get downloadWindows() {
        return options.windows
      },
      onDownloadsPanelPresented: (listener) => {
        presented.add(listener)
      }
    },
    now: () => clock.now
  })

  return {
    channels: [...handlers.keys()],
    /**
     * The window presented its downloads panel at `at`, as `BrowserWindowController` reports it: the
     * controller records the time, then the registry tells whoever listens.
     */
    present: (window: FakeWindow, at: number): void => {
      window.downloadsPanelPresentedAt = at
      for (const listener of presented) listener(window)
    },
    /**
     * A request from one web contents, the downloads page of window 1 unless said otherwise.
     *
     * Wrapped in a promise the way `ipcMain.handle` does it: a handler that throws has to arrive as a
     * rejection, because that is what the renderer sees.
     */
    invoke: (channel: string, payload?: unknown, senderId = 11): Promise<unknown> =>
      Promise.resolve().then(() => {
        const handler = handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        const event = { sender: { id: senderId } } as unknown as IpcMainInvokeEvent
        return handler(payload as never, event)
      })
  }
}

describe('downloads IPC', () => {
  it('registers all nine channels', () => {
    const { channels } = harness({ manager: fakeManager(), windows: [fakeWindow(1, false)] })
    expect(channels.sort()).toEqual([
      'downloads:cancel',
      'downloads:clear',
      'downloads:list',
      'downloads:open',
      'downloads:pause',
      'downloads:remove',
      'downloads:resume',
      'downloads:reveal',
      'downloads:summary'
    ])
  })

  it('lists what the sending window may see, freshly probed', async () => {
    const manager = fakeManager({ byWindow: { 1: [entry('a')] } })
    const { invoke } = harness({ manager, windows: [fakeWindow(1, false)] })

    expect(await invoke('downloads:list')).toEqual({
      downloads: [entry('a')],
      privateWindow: false
    })
    // `list`, not `snapshot`: the pull path pays for the truth. See `DownloadManager`.
    expect(manager.calls).toEqual(['list:1'])
  })

  it('tells a private window that it is private, and asks for that window’s list', async () => {
    const manager = fakeManager({ byWindow: { 2: [entry('p')] } })
    const { invoke } = harness({ manager, windows: [fakeWindow(2, true)] })

    expect(await invoke('downloads:list', undefined, 21)).toEqual({
      downloads: [entry('p')],
      privateWindow: true
    })
    expect(manager.calls).toEqual(['list:2'])
  })

  it('answers the downloads page of a normal window with its own list while a private window is in front', async () => {
    const manager = fakeManager({ byWindow: { 1: [entry('a')], 2: [entry('p')] } })
    /*
      The private window comes first, which is where "the focused window" and "the first window" would
      both find it. The request is from tab 12 of window 1, and that is the only fact allowed to decide:
      a fallback to either would hand a normal window's page a private window's downloads.
    */
    const { invoke } = harness({ manager, windows: [fakeWindow(2, true), fakeWindow(1, false)] })

    expect(await invoke('downloads:list', undefined, 12)).toEqual({
      downloads: [entry('a')],
      privateWindow: false
    })
  })

  it('refuses rather than answering when the sender belongs to no window', async () => {
    const manager = fakeManager()
    const { invoke } = harness({ manager, windows: [fakeWindow(1, false)] })
    // "You have downloaded nothing" and "there is no window for you" are different statements, and
    // a page shown the first would draw an empty list for as long as it stayed open.
    await expect(invoke('downloads:list', undefined, 99)).rejects.toThrow(/No window/)
    // And an action from nowhere does not fall through to the manager as if a window had asked.
    await expect(invoke('downloads:cancel', { id: 'live' }, 99)).rejects.toThrow(/No window/)
    await expect(invoke('downloads:clear', undefined, 99)).rejects.toThrow(/No window/)
    expect(manager.calls).toEqual([])
  })

  it('reports whether pause, resume and cancel did anything', async () => {
    const manager = fakeManager()
    const { invoke } = harness({ manager, windows: [fakeWindow(1, false)] })

    expect(await invoke('downloads:pause', { id: 'live' })).toEqual({ changed: true })
    // The refusal a resume has to be able to give: without server range support Electron would
    // discard what has arrived and start again.
    expect(await invoke('downloads:resume', { id: 'finished' })).toEqual({ changed: false })
    expect(await invoke('downloads:cancel', { id: 'live' })).toEqual({ changed: true })
    expect(manager.calls).toEqual(['pause:live', 'resume:finished', 'cancel:live'])
  })

  it('does nothing to a row the sending window cannot see, and says so', async () => {
    // Window 2 is a private window running `theirs`; window 1 cannot see it and names it anyway.
    const manager = fakeManager({ visible: { 1: ['mine'], 2: ['theirs'] } })
    const { invoke } = harness({ manager, windows: [fakeWindow(1, false), fakeWindow(2, true)] })

    expect(await invoke('downloads:pause', { id: 'theirs' })).toEqual({ changed: false })
    expect(await invoke('downloads:resume', { id: 'theirs' })).toEqual({ changed: false })
    expect(await invoke('downloads:cancel', { id: 'theirs' })).toEqual({ changed: false })
    expect(await invoke('downloads:remove', { id: 'theirs' })).toEqual({ removed: false })
    expect(manager.calls).toEqual([])
  })

  it('hands the shell nothing for a row the sending window cannot see', async () => {
    const manager = fakeManager({ visible: { 1: ['mine'], 2: ['theirs'] } })
    const { invoke } = harness({ manager, windows: [fakeWindow(1, false), fakeWindow(2, true)] })

    expect(await invoke('downloads:open', { id: 'theirs' })).toEqual({ opened: false })
    expect(await invoke('downloads:reveal', { id: 'theirs' })).toEqual({ revealed: false })
    // The manager is where the shell is called, so not reaching it is not reaching the shell.
    expect(manager.calls).toEqual([])
  })

  it('answers false for a file that has gone rather than handing it to the shell', async () => {
    const manager = fakeManager()
    const { invoke } = harness({ manager, windows: [fakeWindow(1, false)] })

    expect(await invoke('downloads:open', { id: 'gone' })).toEqual({ opened: false })
    expect(await invoke('downloads:reveal', { id: 'gone' })).toEqual({ revealed: false })
    expect(await invoke('downloads:open', { id: 'here' })).toEqual({ opened: true })
  })

  it('forgets one row, and every finished row the sending window can see', async () => {
    const manager = fakeManager()
    const { invoke } = harness({ manager, windows: [fakeWindow(1, false), fakeWindow(2, true)] })

    expect(await invoke('downloads:remove', { id: 'gone' })).toEqual({ removed: false })
    expect(await invoke('downloads:remove', { id: 'a' })).toEqual({ removed: true })
    expect(await invoke('downloads:clear', undefined, 21)).toEqual({ removed: 3 })
    // Cleared as window 2, which is what keeps one private window's clear out of another's list.
    expect(manager.calls).toEqual(['remove:gone', 'remove:a', 'clear:2'])
  })

  it('pushes each window its own list, with its own privacy flag', () => {
    const normal = fakeWindow(1, false)
    const priv = fakeWindow(2, true)
    const manager = fakeManager({ byWindow: { 1: [entry('a')], 2: [entry('p')] } })
    harness({ manager, windows: [normal, priv] })

    manager.fire()

    /*
      One payload per window rather than one broadcast.

      `privateWindow` is a fact about the receiver, so a single shared payload would tell one of
      these two windows that it was the other kind — and the page uses that flag to explain why a
      finished private download leaves no row behind.
    */
    expect(normal.pushed).toEqual([{ downloads: [entry('a')], privateWindow: false }])
    expect(priv.pushed).toEqual([{ downloads: [entry('p')], privateWindow: true }])
    // `snapshot`, not `list`: the pushed path reuses probes, four times a second.
    expect(manager.calls).toEqual(['snapshot:1', 'snapshot:2'])
  })

  it('hands each window’s panel the very rows its page is pushed (R9)', () => {
    /*
      The window decides whether a panel is up to take them (`BrowserWindowController.refreshDownloadsPanel`);
      what is decided here is that it is offered the same snapshot as the page, per window, on every change —
      so the panel and the page cannot show one download in two states.
    */
    const normal = fakeWindow(1, false)
    const priv = fakeWindow(2, true)
    const manager = fakeManager({ byWindow: { 1: [entry('a')], 2: [entry('p')] } })
    harness({ manager, windows: [normal, priv] })

    manager.fire()

    expect(normal.panel).toEqual([normal.pushed[0]?.downloads])
    expect(priv.panel).toEqual([priv.pushed[0]?.downloads])
    expect(priv.panel[0]).toBe(priv.pushed[0]?.downloads)
  })
})

describe('the download button summary', () => {
  const QUIET = { visible: true, activity: null, marker: null }

  it('reaches only the window the download started in, and shows it', () => {
    const a = fakeWindow(1, false)
    const b = fakeWindow(3, false)
    // Both normal windows list the running download; only window 1 started it.
    const running = entry('a', { state: 'progressing', receivedBytes: 25, endedAt: null })
    const manager = fakeManager({
      byWindow: { 1: [running], 3: [running] },
      startedIn: { 1: ['a'] }
    })
    harness({ manager, windows: [a, b] })

    manager.fire()

    expect(a.chrome).toEqual([
      { visible: true, activity: { kind: 'fraction', fraction: 0.25 }, marker: null }
    ])
    // Not even a "hidden": a window that has shown nothing has nothing to take back.
    expect(b.chrome).toEqual([])
  })

  it('sends nothing for a tick that leaves the summary as it was', () => {
    const a = fakeWindow(1, false)
    const byWindow = { 1: [entry('a', { state: 'progressing', totalBytes: 0, endedAt: null })] }
    const manager = fakeManager({ byWindow, startedIn: { 1: ['a'] } })
    harness({ manager, windows: [a] })

    manager.fire()
    // More bytes, still no declared size: the button draws the same activity either way.
    byWindow[1] = [
      entry('a', { state: 'progressing', totalBytes: 0, receivedBytes: 500, endedAt: null })
    ]
    manager.fire()

    expect(a.chrome).toEqual([{ visible: true, activity: { kind: 'indeterminate' }, marker: null }])
  })

  it('sends the progress again when it has moved', () => {
    const a = fakeWindow(1, false)
    const byWindow = { 1: [entry('a', { state: 'progressing', receivedBytes: 10, endedAt: null })] }
    const manager = fakeManager({ byWindow, startedIn: { 1: ['a'] } })
    harness({ manager, windows: [a] })

    manager.fire()
    byWindow[1] = [entry('a', { state: 'progressing', receivedBytes: 60, endedAt: null })]
    manager.fire()

    expect(a.chrome.map((summary) => summary.activity)).toEqual([
      { kind: 'fraction', fraction: 0.1 },
      { kind: 'fraction', fraction: 0.6 }
    ])
  })

  it('carries no file name and no address', () => {
    const a = fakeWindow(1, false)
    const manager = fakeManager({
      byWindow: { 1: [entry('secret-report', { state: 'interrupted' })] },
      startedIn: { 1: ['secret-report'] }
    })
    harness({ manager, windows: [a] })

    manager.fire()

    expect(a.chrome).toHaveLength(1)
    expect(Object.keys(a.chrome[0] ?? {}).sort()).toEqual(['activity', 'marker', 'visible'])
    const wire = JSON.stringify(a.chrome)
    expect(wire).not.toContain('secret-report')
    expect(wire).not.toContain('example.com')
    expect(wire).not.toContain('/tmp/')
  })

  it('gives a private window a summary of its own downloads only', () => {
    const normal = fakeWindow(1, false)
    const priv = fakeWindow(2, true)
    // The stored list reaches the private window's page too, deliberately — but not its button.
    const stored = entry('n', { state: 'completed' })
    const own = entry('p', { state: 'progressing', totalBytes: 0, receivedBytes: 5, endedAt: null })
    const manager = fakeManager({
      byWindow: { 1: [stored], 2: [stored, own] },
      startedIn: { 1: ['n'], 2: ['p'] }
    })
    harness({ manager, windows: [normal, priv] })

    manager.fire()

    expect(priv.chrome).toEqual([
      { visible: true, activity: { kind: 'indeterminate' }, marker: null }
    ])
    expect(normal.chrome).toEqual([{ visible: true, activity: null, marker: 'completed' }])
  })

  it('marks a normal download that finished as completed', () => {
    const a = fakeWindow(1, false)
    const byWindow = { 1: [entry('a', { state: 'progressing', receivedBytes: 50, endedAt: null })] }
    const manager = fakeManager({ byWindow, startedIn: { 1: ['a'] } })
    harness({ manager, windows: [a] })

    manager.fire()
    byWindow[1] = [entry('a', { state: 'completed', endedAt: T0 + 10 })]
    manager.fire()

    expect(a.chrome.at(-1)).toEqual({ visible: true, activity: null, marker: 'completed' })
  })

  it('takes the button away when the list no longer holds anything the window started', () => {
    const a = fakeWindow(1, false)
    const byWindow: Record<number, DownloadEntry[]> = { 1: [entry('a')] }
    const manager = fakeManager({ byWindow, startedIn: { 1: ['a'] } })
    harness({ manager, windows: [a] })

    manager.fire()
    byWindow[1] = []
    manager.fire()

    expect(a.chrome).toEqual([
      { visible: true, activity: null, marker: 'completed' },
      { visible: false, activity: null, marker: null }
    ])
  })

  it('drops the mark as soon as the panel is presented, with no download event in between', () => {
    const a = fakeWindow(1, false)
    const manager = fakeManager({
      byWindow: { 1: [entry('a', { state: 'completed', endedAt: T0 + 1 })] },
      startedIn: { 1: ['a'] }
    })
    const { present } = harness({ manager, windows: [a] })

    manager.fire()
    present(a, T0 + 5)

    expect(a.chrome).toEqual([{ visible: true, activity: null, marker: 'completed' }, QUIET])
  })

  it('sends the summary on every presentation, a re-presentation of the same panel included', () => {
    const a = fakeWindow(1, false)
    const manager = fakeManager({
      byWindow: { 1: [entry('a', { state: 'completed', endedAt: T0 + 1 })] },
      startedIn: { 1: ['a'] }
    })
    const { present } = harness({ manager, windows: [a] })

    present(a, T0 + 5)
    present(a, T0 + 6)

    // Unchanged, and sent anyway: a presentation is the moment the button is owed an answer.
    expect(a.chrome).toEqual([QUIET, QUIET])
  })

  it('leaves no mark after the panel closes on a download that finished while it was open', () => {
    const clock = { now: T0 }
    const a = fakeWindow(1, false)
    const byWindow = { 1: [entry('a', { state: 'progressing', receivedBytes: 50, endedAt: null })] }
    const manager = fakeManager({ byWindow, startedIn: { 1: ['a'] } })
    const { present } = harness({ manager, windows: [a], clock })

    manager.fire()
    present(a, T0 + 1)
    /*
      It finishes with the panel up. The core re-presents the open panel with the fresh rows, as it
      does for every change — and each presentation is a sighting. Closing sends nothing, so what the
      button shows afterwards is whatever the last presentation left it.
    */
    clock.now = T0 + 2
    byWindow[1] = [entry('a', { state: 'completed', endedAt: T0 + 2 })]
    manager.fire()
    present(a, T0 + 2)

    expect(a.chrome.at(-1)).toEqual(QUIET)
  })

  it('marks a pause that came after the last presentation, though the download began before it', () => {
    const clock = { now: T0 }
    const a = fakeWindow(1, false)
    const byWindow = {
      1: [entry('a', { state: 'progressing', startedAt: T0, receivedBytes: 50, endedAt: null })]
    }
    const manager = fakeManager({ byWindow, startedIn: { 1: ['a'] } })
    const { present } = harness({ manager, windows: [a], clock })

    manager.fire()
    present(a, T0 + 5)
    // A paused record keeps `endedAt: null`; its start alone would say the panel had shown this.
    clock.now = T0 + 10
    byWindow[1] = [entry('a', { state: 'paused', startedAt: T0, receivedBytes: 50, endedAt: null })]
    manager.fire()

    expect(a.chrome.at(-1)).toEqual({ visible: true, activity: null, marker: 'paused' })
  })

  it('counts a pause the panel was presented after as seen', () => {
    const clock = { now: T0 }
    const a = fakeWindow(1, false)
    const byWindow = {
      1: [entry('a', { state: 'progressing', receivedBytes: 50, endedAt: null })]
    }
    const manager = fakeManager({ byWindow, startedIn: { 1: ['a'] } })
    const { present } = harness({ manager, windows: [a], clock })

    manager.fire()
    clock.now = T0 + 3
    byWindow[1] = [entry('a', { state: 'paused', receivedBytes: 50, endedAt: null })]
    manager.fire()
    // Later ticks while it stays paused do not move the moment it paused.
    clock.now = T0 + 20
    manager.fire()
    present(a, T0 + 10)

    expect(a.chrome.at(-1)).toEqual(QUIET)
  })

  /*
    The pull that goes with the push, the way `window:getState` goes with `window:stateChanged`.

    Nothing is pushed until the summary first changes, so a chrome UI that mounts — or reloads — after
    a download began would show no button at all until the next tick happened to move the ring. Sender
    id 1 is window 1's chrome UI in this file's convention.
  */
  it('answers the chrome UI with its window’s summary before anything was pushed', async () => {
    const a = fakeWindow(1, false)
    const running = entry('a', { state: 'progressing', receivedBytes: 25, endedAt: null })
    const manager = fakeManager({ byWindow: { 1: [running] }, startedIn: { 1: ['a'] } })
    const { invoke } = harness({ manager, windows: [a] })

    expect(await invoke('downloads:summary', undefined, 1)).toEqual({
      visible: true,
      activity: { kind: 'fraction', fraction: 0.25 },
      marker: null
    })
    // From what is known, not re-probed: the button draws no row, so it needs no stat call.
    expect(manager.calls).toEqual(['snapshot:1'])
    expect(a.chrome).toEqual([])
  })

  it('answers with no button for a window that has started nothing', async () => {
    const manager = fakeManager({ byWindow: { 1: [entry('a')] } })
    const { invoke } = harness({ manager, windows: [fakeWindow(1, false)] })

    expect(await invoke('downloads:summary', undefined, 1)).toEqual({
      visible: false,
      activity: null,
      marker: null
    })
  })

  it('answers a private window with its own downloads, whoever is in front', async () => {
    const normal = fakeWindow(1, false)
    const priv = fakeWindow(2, true)
    const own = entry('p', { state: 'progressing', totalBytes: 0, receivedBytes: 5, endedAt: null })
    const manager = fakeManager({
      byWindow: { 1: [entry('n')], 2: [entry('n'), own] },
      startedIn: { 1: ['n'], 2: ['p'] }
    })
    const { invoke } = harness({ manager, windows: [priv, normal] })

    expect(await invoke('downloads:summary', undefined, 1)).toEqual({
      visible: true,
      activity: null,
      marker: 'completed'
    })
    expect(await invoke('downloads:summary', undefined, 2)).toEqual({
      visible: true,
      activity: { kind: 'indeterminate' },
      marker: null
    })
  })

  it('refuses a pull from a sender that belongs to no window', async () => {
    const manager = fakeManager()
    const { invoke } = harness({ manager, windows: [fakeWindow(1, false)] })
    await expect(invoke('downloads:summary', undefined, 99)).rejects.toThrow(/No window/)
  })

  it('does not let a pull stand in for the push that follows it', async () => {
    /*
      The pull answers whoever asked, and the window's overlay may ask as well as its chrome UI. So it
      must not count as "sent" for the de-duplication: the chrome UI would otherwise miss a change it
      was never told about, because somebody else had been.
    */
    const a = fakeWindow(1, false)
    const manager = fakeManager({
      byWindow: { 1: [entry('a', { state: 'interrupted' })] },
      startedIn: { 1: ['a'] }
    })
    const { invoke } = harness({ manager, windows: [a] })

    await invoke('downloads:summary', undefined, 1)
    manager.fire()

    expect(a.chrome).toEqual([{ visible: true, activity: null, marker: 'failed' }])
  })
})
