import type { IpcMainInvokeEvent } from 'electron'
import type { DownloadEntry } from '@shared/downloads/model.js'
import type { EventPayload, InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { BrowsingMode } from '../data/HistoryStore.js'

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
 * That matters here because two of them are decisions rather than forwards:
 *
 *   - **Which list a window may see** depends on whether the window is private. A private window is
 *     shown the stored list *and* its own live downloads; a normal window is never shown a private
 *     one. The manager holds both halves and the mode picks between them, so the mode has to be
 *     resolved from the sender and cannot be taken from the request.
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
  list(mode: BrowsingMode): DownloadEntry[]
  /** From what is already known, for the pushed event. */
  snapshot(mode: BrowsingMode): DownloadEntry[]
  pause(id: string): boolean
  resume(id: string): boolean
  cancel(id: string): boolean
  remove(id: string): boolean
  clear(): number
  open(id: string): Promise<boolean>
  reveal(id: string): boolean
  onChange(listener: () => void): () => void
}

/** One window. `BrowserWindowController` satisfies this. */
export interface DownloadHandlerWindow {
  readonly privateMode: boolean
  emitToInternalPages(
    channel: 'downloads:changed',
    payload: EventPayload<'downloads:changed'>
  ): void
}

/** The window registry, as far as this file needs one. */
export interface DownloadHandlerWindows {
  resolve(event: IpcMainInvokeEvent): DownloadHandlerWindow | undefined
  readonly controllers: readonly DownloadHandlerWindow[]
}

export interface DownloadHandlerDeps {
  /** `handle` from `ipc/router.ts`. See `DownloadHandle` for why it is passed rather than imported. */
  readonly handle: DownloadHandle
  readonly downloads: DownloadHandlerManager
  readonly windows: DownloadHandlerWindows
}

/**
 * Which kind of window this is, as the stores name it.
 *
 * One function rather than the ternary written at each of the two call sites: the two would
 * eventually disagree, and the way they would disagree is a private window being handed the mode
 * that writes to disk.
 */
function modeOf(window: DownloadHandlerWindow): BrowsingMode {
  return window.privateMode ? 'private' : 'normal'
}

export function registerDownloadHandlers(deps: DownloadHandlerDeps): void {
  const { handle, downloads, windows } = deps

  /**
   * The window this request is about.
   *
   * Throws rather than answering with an empty list. "There is no window for you" and "you have
   * downloaded nothing" are different statements, and only the first one tells a page to stop
   * drawing an empty list for as long as the user leaves it open.
   */
  const sender = (event: IpcMainInvokeEvent): DownloadHandlerWindow => {
    const window = windows.resolve(event)
    if (window === undefined) throw new Error('No window for this request')
    return window
  }

  handle('downloads:list', (_payload, event) => {
    const window = sender(event)
    return { downloads: downloads.list(modeOf(window)), privateWindow: window.privateMode }
  })

  /*
    Not resolved against the sending window, and that is deliberate rather than an omission.

    An id names a row in one list the profile keeps, and the page that can see the row is the page
    that got the id from `downloads:list`. Acting on the stored list from a private window is the
    same judgement `HistoryStore` and `DownloadStore` already document for deletion: a private
    window must contribute nothing, not be unable to manage what is there.
  */
  handle('downloads:pause', ({ id }) => ({ changed: downloads.pause(id) }))
  handle('downloads:resume', ({ id }) => ({ changed: downloads.resume(id) }))
  handle('downloads:cancel', ({ id }) => ({ changed: downloads.cancel(id) }))
  handle('downloads:remove', ({ id }) => ({ removed: downloads.remove(id) }))
  handle('downloads:clear', () => ({ removed: downloads.clear() }))

  /*
    The authoritative presence checks, both of them.

    `onDisk` on a row is a hint probed when the list was read; between that and this click the file
    can have gone. Both of these re-probe and answer `false`, which is what lets the page say "that
    file is no longer there" instead of the operating system raising a dialogue naming a path.
  */
  handle('downloads:open', async ({ id }) => ({ opened: await downloads.open(id) }))
  handle('downloads:reveal', ({ id }) => ({ revealed: downloads.reveal(id) }))

  /*
    One subscription for the process, fanned out per window.

    The unsubscribe is dropped on purpose: handlers are registered once for the life of the process,
    so there is no teardown for it to belong to. The same choice `registerMediaHandlers` makes, for
    the same reason.
  */
  downloads.onChange(() => {
    for (const window of windows.controllers) {
      window.emitToInternalPages('downloads:changed', {
        downloads: downloads.snapshot(modeOf(window)),
        privateWindow: window.privateMode
      })
    }
  })
}
