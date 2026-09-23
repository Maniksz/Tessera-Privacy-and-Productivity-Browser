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
import type { DownloadSession } from '@main/downloads/DownloadManager.js'

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
  } = {}
) {
  const calls: string[] = []
  const listeners = new Set<() => void>()
  const byWindow = options.byWindow ?? {}
  const visible = options.visible ?? {}
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
}

const NO_SESSION: DownloadSession = { on: () => {} }

/**
 * One window: its id, its kind, and the web contents that speak for it.
 *
 * The chrome UI's id is the window id, and each tab's is the window id times ten plus its position — so
 * window 1's tabs are 11 and 12. Only a convention of this file, but it keeps every sender id below
 * readable as "which window, and was it a page".
 */
function fakeWindow(windowId: number, privateMode: boolean): FakeWindow {
  const pushed: EventPayload<'downloads:changed'>[] = []
  const contents = [windowId, windowId * 10 + 1, windowId * 10 + 2]
  return {
    viewer: { windowId, mode: privateMode ? 'private' : 'normal', session: NO_SESSION },
    pushed,
    sends: (webContentsId) => contents.includes(webContentsId),
    emitToInternalPages: (_channel, payload) => {
      pushed.push(payload)
    }
  }
}

type AnyHandler = (payload: never, event: IpcMainInvokeEvent) => unknown

function harness(options: { manager: FakeManager; windows: FakeWindow[] }) {
  const handlers = new Map<string, AnyHandler>()
  const handle: DownloadHandle = (channel, handler) => {
    handlers.set(channel, handler)
  }

  registerDownloadHandlers({
    handle,
    downloads: options.manager,
    windows: {
      get downloadWindows() {
        return options.windows
      }
    }
  })

  return {
    channels: [...handlers.keys()],
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
  it('registers all eight channels', () => {
    const { channels } = harness({ manager: fakeManager(), windows: [fakeWindow(1, false)] })
    expect(channels.sort()).toEqual([
      'downloads:cancel',
      'downloads:clear',
      'downloads:list',
      'downloads:open',
      'downloads:pause',
      'downloads:remove',
      'downloads:resume',
      'downloads:reveal'
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
})
