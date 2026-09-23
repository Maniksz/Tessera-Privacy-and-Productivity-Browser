import type { IpcMainInvokeEvent } from 'electron'
import type { DownloadEntry } from '@shared/downloads/model.js'
import type { EventPayload, InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { DownloadViewer } from '../downloads/DownloadManager.js'

/**
 * The `downloads:*` channels, and the one event that goes with them.
 *
 * ## Why these are not in `handlers.ts`
 *
 * The same reason the media channels are not: `ipc/router.ts` imports `ipcMain`, so anything that
 * imports it can only run inside a live Electron process — which is why `handlers.ts` has no unit
 * tests at all. Taking the registrar as an argument turns these bodies into ordinary functions a
 * test can call.
 *
 * That matters here because three of them are decisions rather than forwards:
 *
 *   - **Which window is asking** is decided from the sender alone. The chrome UI and the overlay
 *     are known by their own web contents, a downloads page by the tab it is in, and a sender that
 *     is none of those is refused. There is deliberately no fallback to the focused window, which is
 *     what `WindowRegistry.resolve` offers: the downloads page of a normal window, asking while a
 *     private window is in front, would have been handed the private window's downloads.
 *   - **Which list that window may see** depends on its session. A private window is shown the
 *     stored list *and* its own live downloads, and no window is shown another private window's.
 *     Every action is checked against the same rule before the manager hears of it, opening and
 *     revealing included — an id is a name for a row, not permission to touch it.
 *   - **The push is per window**, and for the same reason. `privateWindow` is a fact about the
 *     receiver, not about the list, so one broadcast of one payload would tell a normal window it
 *     was private, or the reverse — and the page uses that flag to explain why a finished private
 *     download leaves no row behind.
 *
 * ## Pull versus push
 *
 * `downloads:list` re-probes the disk; the pushed snapshot reuses answers from a moment ago. The
 * split is deliberate and lives in `DownloadManager`: a stat call per row is worth it when somebody
 * clicks, and absurd four times a second.
 */

export type DownloadInvokeChannel =
  | 'downloads:list'
  | 'downloads:open'
  | 'downloads:reveal'
  | 'downloads:remove'
  | 'downloads:clear'
  | 'downloads:pause'
  | 'downloads:resume'
  | 'downloads:cancel'

/**
 * The eight channels, derived from the shared contract rather than restated.
 *
 * `InvokeHandlerArg` is not simply the request type — it normalises a `void` request and carries the
 * contract's own inference — so a hand-written twin compiles and is then assignable to nothing at
 * the call site that hands `handle` over. The same lesson `media-handlers.ts` records.
 */
type DownloadChannelContract = {
  [C in DownloadInvokeChannel]: {
    request: InvokeHandlerArg<C>
    response: InvokeResponse<C>
  }
}

/** The shape of `ipc/router.ts`'s `handle`, narrowed to these channels. */
export type DownloadHandle = <C extends DownloadInvokeChannel>(
  channel: C,
  handler: (
    payload: DownloadChannelContract[C]['request'],
    event: IpcMainInvokeEvent
  ) => Promise<DownloadChannelContract[C]['response']> | DownloadChannelContract[C]['response']
) => void

/** What these handlers need from the manager. `DownloadManager` satisfies it. */
export interface DownloadHandlerManager {
  /** Freshly probed. The path a click takes. */
  list(viewer: DownloadViewer): DownloadEntry[]
  /** From what is already known, for the pushed event. */
  snapshot(viewer: DownloadViewer): DownloadEntry[]
  /** Whether `id` is a row of this window's list — what every action below is checked against. */
  canSee(viewer: DownloadViewer, id: string): boolean
  pause(id: string): boolean
  resume(id: string): boolean
  cancel(id: string): boolean
  remove(id: string): boolean
  clear(viewer: DownloadViewer): number
  open(id: string): Promise<boolean>
  reveal(id: string): boolean
  onChange(listener: () => void): () => void
}

/** One window, as `WindowRegistry.downloadWindows` presents it. */
export interface DownloadHandlerWindow {
  /** Who this window is to the manager: its id, its kind and its session. */
  readonly viewer: DownloadViewer
  /** True when the web contents is this window's chrome UI, its overlay, or one of its tabs. */
  sends(webContentsId: number): boolean
  emitToInternalPages(
    channel: 'downloads:changed',
    payload: EventPayload<'downloads:changed'>
  ): void
}

/** The window registry, as far as this file needs one. */
export interface DownloadHandlerWindows {
  readonly downloadWindows: readonly DownloadHandlerWindow[]
}

export interface DownloadHandlerDeps {
  /** `handle` from `ipc/router.ts`. See `DownloadHandle` for why it is passed rather than imported. */
  readonly handle: DownloadHandle
  readonly downloads: DownloadHandlerManager
  readonly windows: DownloadHandlerWindows
}

export function registerDownloadHandlers(deps: DownloadHandlerDeps): void {
  const { handle, downloads, windows } = deps

  /**
   * The window this request came from, and nothing else.
   *
   * Throws rather than answering with an empty list. "There is no window for you" and "you have
   * downloaded nothing" are different statements, and only the first one tells a page to stop
   * drawing an empty list for as long as the user leaves it open. An action from nowhere is
   * refused the same way rather than being run as though some window had asked.
   */
  const sender = (event: IpcMainInvokeEvent): DownloadViewer => {
    const window = windows.downloadWindows.find((candidate) => candidate.sends(event.sender.id))
    if (window === undefined) throw new Error('No window for this request')
    return window.viewer
  }

  /** The sender's window, if that window's list holds the row. */
  const mayTouch = (event: IpcMainInvokeEvent, id: string): boolean =>
    downloads.canSee(sender(event), id)

  handle('downloads:list', (_payload, event) => {
    const viewer = sender(event)
    return { downloads: downloads.list(viewer), privateWindow: viewer.mode === 'private' }
  })

  /*
    Resolved against the sending window's list, and answered "nothing changed" for a row outside it.

    Within that list the stored rows stay reachable from a private window. Acting on the stored list
    from a private window is the same judgement `HistoryStore` and `DownloadStore` already document for
    deletion: a private window must contribute nothing, not be unable to manage what is there. What it
    may not reach is another private window's rows, which it cannot see and so cannot have been given.
  */
  handle('downloads:pause', ({ id }, event) => ({
    changed: mayTouch(event, id) && downloads.pause(id)
  }))
  handle('downloads:resume', ({ id }, event) => ({
    changed: mayTouch(event, id) && downloads.resume(id)
  }))
  handle('downloads:cancel', ({ id }, event) => ({
    changed: mayTouch(event, id) && downloads.cancel(id)
  }))
  handle('downloads:remove', ({ id }, event) => ({
    removed: mayTouch(event, id) && downloads.remove(id)
  }))
  handle('downloads:clear', (_payload, event) => ({ removed: downloads.clear(sender(event)) }))

  /*
    The authoritative presence checks, both of them.

    `onDisk` on a row is a hint probed when the list was read; between that and this click the file
    can have gone. Both of these re-probe and answer `false`, which is what lets the page say "that
    file is no longer there" instead of the operating system raising a dialogue naming a path.
  */
  handle('downloads:open', async ({ id }, event) => ({
    opened: mayTouch(event, id) && (await downloads.open(id))
  }))
  handle('downloads:reveal', ({ id }, event) => ({
    revealed: mayTouch(event, id) && downloads.reveal(id)
  }))

  /*
    One subscription for the process, fanned out per window.

    The unsubscribe is dropped on purpose: handlers are registered once for the life of the process,
    so there is no teardown for it to belong to. The same choice `registerMediaHandlers` makes, for
    the same reason.
  */
  downloads.onChange(() => {
    for (const window of windows.downloadWindows) {
      window.emitToInternalPages('downloads:changed', {
        downloads: downloads.snapshot(window.viewer),
        privateWindow: window.viewer.mode === 'private'
      })
    }
  })
}
