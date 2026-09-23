import type { IpcMainInvokeEvent } from 'electron'
import type { DownloadEntry, DownloadState } from '@shared/downloads/model.js'
import { summarizeWindowDownloads, type DownloadButtonSummary } from '@shared/downloads/summary.js'
import type { EventPayload, InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { DownloadViewer } from '../downloads/DownloadManager.js'

/**
 * The `downloads:*` channels, and the two events that go with them.
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
 * ## The button's summary
 *
 * The second push, and a different one. The downloads page is sent the list; the chrome UI is sent
 * `downloads:summaryChanged` — whether the button is there, how far the window's running downloads
 * have got, and one outcome worth a mark — and never the list, which names what somebody downloaded.
 * It is computed from the same snapshot in the same pass, so the button and the page cannot describe
 * two different moments, and sent only when it changed: a progress tick that moves nothing the button
 * draws is not worth a message. The exception is a presentation of the downloads panel, which always
 * sends — see `DownloadHandlerWindows.onDownloadsPanelPresented`.
 *
 * Because it is sent only on a change, it has a pull beside it: `downloads:summary` answers with the
 * summary as it stands, for a chrome UI that mounts or reloads after a download began and would
 * otherwise have nothing to draw until the next change.
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
  | 'downloads:summary'

/**
 * The nine channels, derived from the shared contract rather than restated.
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
  /** The downloads started in this window during this run; what the button counts (KTD7). */
  idsStartedIn(windowId: number): ReadonlySet<string>
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
  /** To this window's chrome UI, the way `window:stateChanged` travels. */
  emit(channel: 'downloads:summaryChanged', payload: EventPayload<'downloads:summaryChanged'>): void
  /**
   * When this window last presented its downloads panel, or `null` if it never has.
   *
   * The controller's record rather than this file's: presenting is something the window does, and the
   * time is gone with the window without anybody having to forget it.
   */
  readonly downloadsPanelPresentedAt: number | null
}

/** The window registry, as far as this file needs one. */
export interface DownloadHandlerWindows {
  /**
   * Every open window. The registry hands out one object per window for its whole life, which is what
   * lets the per-window memory below be keyed on it and go when the window does.
   */
  readonly downloadWindows: readonly DownloadHandlerWindow[]
  /**
   * A window has just presented its downloads panel — first time, or again with fresh rows.
   *
   * The button is owed a summary *then*, not at the next download event: presenting is what marks the
   * window's outcomes as seen (KTD6), and a mark that stayed until something else happened to download
   * would be a mark for something the user has just looked at. Sent even when the summary did not
   * change, re-presentations of the same panel included, so a chrome UI that has missed one cannot be
   * left behind by the de-duplication.
   */
  onDownloadsPanelPresented(listener: (window: DownloadHandlerWindow) => void): void
}

export interface DownloadHandlerDeps {
  /** `handle` from `ipc/router.ts`. See `DownloadHandle` for why it is passed rather than imported. */
  readonly handle: DownloadHandle
  readonly downloads: DownloadHandlerManager
  readonly windows: DownloadHandlerWindows
  /** The clock a state change is stamped with. `Date.now`, the manager's own, unless a test says. */
  readonly now?: () => number
}

/**
 * What this file remembers about one window, for its button.
 *
 * Only ids, states and times — no name, no address — and only for downloads the window started that
 * are still in its list. Held in a `WeakMap` on the window's object, so it is dropped with the window
 * rather than by a teardown somebody has to remember to call.
 */
interface ButtonMemory {
  /** Per id, the state it was last seen in and when that state was first seen. */
  readonly states: Map<string, { readonly state: DownloadState; readonly since: number }>
  /** What the chrome UI was last sent, so an unchanged summary is not sent again. */
  last: DownloadButtonSummary
}

/** What a chrome UI shows before it has been told anything: no button. */
const NOTHING_SENT: DownloadButtonSummary = { visible: false, activity: null, marker: null }

function sameSummary(left: DownloadButtonSummary, right: DownloadButtonSummary): boolean {
  if (left.visible !== right.visible || left.marker !== right.marker) return false
  if (left.activity === null || right.activity === null) return left.activity === right.activity
  if (left.activity.kind !== right.activity.kind) return false
  return (
    left.activity.kind !== 'fraction' ||
    right.activity.kind !== 'fraction' ||
    left.activity.fraction === right.activity.fraction
  )
}

export function registerDownloadHandlers(deps: DownloadHandlerDeps): void {
  const { handle, downloads, windows } = deps
  const now = deps.now ?? Date.now
  const memory = new WeakMap<DownloadHandlerWindow, ButtonMemory>()

  /*
    The button's summary for one window, as it stands, with the state times brought up to date.

    The state times are why this keeps memory at all. A paused record has no time of its own —
    `endedAt` belongs to terminal states — so the summary would have to take the start for the pause,
    and a download begun before the panel was presented and paused after it would count as seen. This
    runs on every coalesced change, and `DownloadManager` never coalesces a state change away, so the
    first pass that sees a new state is within a tick of it happening: that pass stamps it.
  */
  const currentSummary = (
    window: DownloadHandlerWindow,
    entries: readonly DownloadEntry[]
  ): { summary: DownloadButtonSummary; remembered: ButtonMemory } => {
    let remembered = memory.get(window)
    if (remembered === undefined) {
      remembered = { states: new Map(), last: NOTHING_SENT }
      memory.set(window, remembered)
    }
    const startedHere = downloads.idsStartedIn(window.viewer.windowId)

    const stillListed = new Set<string>()
    for (const entry of entries) {
      if (!startedHere.has(entry.id)) continue
      stillListed.add(entry.id)
      if (remembered.states.get(entry.id)?.state !== entry.state) {
        remembered.states.set(entry.id, { state: entry.state, since: now() })
      }
    }
    // Forgotten with its row, so a cleared list leaves nothing behind here either.
    for (const id of remembered.states.keys()) {
      if (!stillListed.has(id)) remembered.states.delete(id)
    }

    const since = new Map([...remembered.states].map(([id, seen]) => [id, seen.since]))
    const summary = summarizeWindowDownloads(
      entries,
      startedHere,
      window.downloadsPanelPresentedAt,
      since
    )
    return { summary, remembered }
  }

  /** The summary pushed to the window's chrome UI, if it changed or if `always`. */
  const publishSummary = (
    window: DownloadHandlerWindow,
    entries: readonly DownloadEntry[],
    always: boolean
  ): void => {
    const { summary, remembered } = currentSummary(window, entries)
    if (!always && sameSummary(summary, remembered.last)) return
    remembered.last = summary
    window.emit('downloads:summaryChanged', summary)
  }

  /**
   * The window this request came from, and nothing else.
   *
   * Throws rather than answering with an empty list. "There is no window for you" and "you have
   * downloaded nothing" are different statements, and only the first one tells a page to stop
   * drawing an empty list for as long as the user leaves it open. An action from nowhere is
   * refused the same way rather than being run as though some window had asked.
   */
  const senderWindow = (event: IpcMainInvokeEvent): DownloadHandlerWindow => {
    const window = windows.downloadWindows.find((candidate) => candidate.sends(event.sender.id))
    if (window === undefined) throw new Error('No window for this request')
    return window
  }
  const sender = (event: IpcMainInvokeEvent): DownloadViewer => senderWindow(event).viewer

  /** The sender's window, if that window's list holds the row. */
  const mayTouch = (event: IpcMainInvokeEvent, id: string): boolean =>
    downloads.canSee(sender(event), id)

  handle('downloads:list', (_payload, event) => {
    const viewer = sender(event)
    return { downloads: downloads.list(viewer), privateWindow: viewer.mode === 'private' }
  })

  /*
    The button's first picture, from the same snapshot a push would use — the button draws no row, so
    there is nothing a fresh probe could change about it.

    It leaves `last` alone on purpose. That field is what the window's chrome UI was *pushed*, and the
    asker here need not be the chrome UI: the window's overlay resolves to the same window. Recording
    this answer as sent would let the de-duplication swallow the next change for a chrome UI that had
    never heard of this one. The cost is at most one push repeating what a pull just said.
  */
  handle('downloads:summary', (_payload, event) => {
    const window = senderWindow(event)
    return currentSummary(window, downloads.snapshot(window.viewer)).summary
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
      // One snapshot for both pushes, so the page and the button describe the same moment.
      const entries = downloads.snapshot(window.viewer)
      window.emitToInternalPages('downloads:changed', {
        downloads: entries,
        privateWindow: window.viewer.mode === 'private'
      })
      publishSummary(window, entries, false)
    }
  })

  // Registered once for the process, like the subscription above, and for the same reason.
  windows.onDownloadsPanelPresented((window) => {
    publishSummary(window, downloads.snapshot(window.viewer), true)
  })
}
