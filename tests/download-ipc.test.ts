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
import type { BrowsingMode } from '@main/data/HistoryStore.js'

/**
 * The `downloads:*` handler bodies.
 *
 * Reachable by a test because `registerDownloadHandlers` is handed its registrar rather than
 * importing `ipc/router.ts`, which pulls in `ipcMain` and therefore only exists inside a running
 * Electron process. The two things worth asserting here are the two that are decisions rather than
 * forwards: which list a window is shown, and who the change event reaches with which flag.
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

function fakeManager(options: { byMode?: Partial<Record<BrowsingMode, DownloadEntry[]>> } = {}) {
  const calls: string[] = []
  const listeners = new Set<() => void>()
  const byMode = options.byMode ?? {}
  const manager: FakeManager = {
    calls,
    fire: () => {
      for (const listener of listeners) listener()
    },
    list: (mode) => {
      calls.push(`list:${mode}`)
      return byMode[mode] ?? []
    },
    snapshot: (mode) => {
      calls.push(`snapshot:${mode}`)
      return byMode[mode] ?? []
    },
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
    clear: () => {
      calls.push('clear')
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

function fakeWindow(privateMode: boolean): FakeWindow {
  const pushed: EventPayload<'downloads:changed'>[] = []
  return {
    privateMode,
    pushed,
    emitToInternalPages: (_channel, payload) => {
      pushed.push(payload)
    }
  }
}

/** No handler here reads the event beyond handing it to `windows.resolve`. */
const NO_EVENT = undefined as unknown as IpcMainInvokeEvent

type AnyHandler = (payload: never, event: IpcMainInvokeEvent) => unknown

function harness(options: {
  manager: FakeManager
  windows: FakeWindow[]
  /** False for the case where the sender belongs to no window at all. */
  resolves?: boolean
}) {
  const handlers = new Map<string, AnyHandler>()
  const handle: DownloadHandle = (channel, handler) => {
    handlers.set(channel, handler)
  }

  registerDownloadHandlers({
    handle,
    downloads: options.manager,
    windows: {
      resolve: () => (options.resolves === false ? undefined : options.windows[0]),
      get controllers() {
        return options.windows
      }
    }
  })

  return {
    channels: [...handlers.keys()],
    // Wrapped in a promise the way `ipcMain.handle` does it: a handler that throws has to arrive as
    // a rejection, because that is what the renderer sees.
    invoke: (channel: string, payload?: unknown): Promise<unknown> =>
      Promise.resolve().then(() => {
        const handler = handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(payload as never, NO_EVENT)
      })
  }
}

describe('downloads IPC', () => {
  it('registers all eight channels', () => {
    const { channels } = harness({ manager: fakeManager(), windows: [fakeWindow(false)] })
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

  it('lists what a normal window may see, freshly probed', async () => {
    const manager = fakeManager({ byMode: { normal: [entry('a')] } })
    const { invoke } = harness({ manager, windows: [fakeWindow(false)] })

    expect(await invoke('downloads:list')).toEqual({
      downloads: [entry('a')],
      privateWindow: false
    })
    // `list`, not `snapshot`: the pull path pays for the truth. See `DownloadManager`.
    expect(manager.calls).toEqual(['list:normal'])
  })

  it('tells a private window that it is private, and asks for the private list', async () => {
    const manager = fakeManager({ byMode: { private: [entry('p')] } })
    const { invoke } = harness({ manager, windows: [fakeWindow(true)] })

    expect(await invoke('downloads:list')).toEqual({
      downloads: [entry('p')],
      privateWindow: true
    })
    expect(manager.calls).toEqual(['list:private'])
  })

  it('refuses rather than answering with an empty list when there is no window', async () => {
    const { invoke } = harness({ manager: fakeManager(), windows: [], resolves: false })
    // "You have downloaded nothing" and "there is no window for you" are different statements, and
    // a page shown the first would draw an empty list for as long as it stayed open.
    await expect(invoke('downloads:list')).rejects.toThrow(/No window/)
  })

  it('reports whether pause, resume and cancel did anything', async () => {
    const manager = fakeManager()
    const { invoke } = harness({ manager, windows: [fakeWindow(false)] })

    expect(await invoke('downloads:pause', { id: 'live' })).toEqual({ changed: true })
    // The refusal a resume has to be able to give: without server range support Electron would
    // discard what has arrived and start again.
    expect(await invoke('downloads:resume', { id: 'finished' })).toEqual({ changed: false })
    expect(await invoke('downloads:cancel', { id: 'live' })).toEqual({ changed: true })
    expect(manager.calls).toEqual(['pause:live', 'resume:finished', 'cancel:live'])
  })

  it('answers false for a file that has gone rather than handing it to the shell', async () => {
    const manager = fakeManager()
    const { invoke } = harness({ manager, windows: [fakeWindow(false)] })

    expect(await invoke('downloads:open', { id: 'gone' })).toEqual({ opened: false })
    expect(await invoke('downloads:reveal', { id: 'gone' })).toEqual({ revealed: false })
    expect(await invoke('downloads:open', { id: 'here' })).toEqual({ opened: true })
  })

  it('forgets one row and every finished row', async () => {
    const manager = fakeManager()
    const { invoke } = harness({ manager, windows: [fakeWindow(false)] })

    expect(await invoke('downloads:remove', { id: 'gone' })).toEqual({ removed: false })
    expect(await invoke('downloads:remove', { id: 'a' })).toEqual({ removed: true })
    expect(await invoke('downloads:clear')).toEqual({ removed: 3 })
  })

  it('pushes each window its own list, with its own privacy flag', () => {
    const normal = fakeWindow(false)
    const priv = fakeWindow(true)
    const manager = fakeManager({ byMode: { normal: [entry('a')], private: [entry('p')] } })
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
    expect(manager.calls).toEqual(['snapshot:normal', 'snapshot:private'])
  })
})
