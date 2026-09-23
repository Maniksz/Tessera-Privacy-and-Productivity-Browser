import type { IpcMainInvokeEvent } from 'electron'
import type { DownloadEntry, DownloadState } from '@shared/downloads/model.js'
import {
  NO_DOWNLOAD_BUTTON,
  summarizeWindowDownloads,
  type DownloadButtonSummary
} from '@shared/downloads/summary.js'
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
  /** Per id a closing window handed this one, when that id was last seen on a panel. */
  handedOnSeenAt(windowId: number): ReadonlyMap<string, number>
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
  /**
   * Re-presents the window's downloads panel with these rows, if the panel is its current surface.
   *
   * Handed every change, the window deciding whether anything is on screen to update — the rule is the
   * window's (`BrowserWindowController.refreshDownloadsPanel`), and a window whose panel is closed does
   * nothing with it.
   */
  refreshDownloadsPanel(entries: readonly DownloadEntry[]): void
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
  /**
   * Removes the stored list's backup, quarantine and temporary copies. A closure over the store rather
   * than a method on the manager, because the copies are the file's business and the manager's is the
   * live transfers. See `DownloadStore.discardCopies`.
   */
  readonly discardCopies: () => Promise<void>
}

/**
 * When each download entered the state it is in, as far as this file has seen.
 *
 * Only ids, states and times — no name, no address. Kept per *session* rather than per window,
 * because the rows a window lists depend on its session alone, so every window of a session would
 * stamp the same times anyway — and because a window's downloads outlive it. A normal window that
 * closes hands its downloads to another window of the same session, and that window has to know
 * when a paused download paused: a pause has no end time of its own, and the successor's first look
 * is always later than the closed window's panel, which would mark a pause that panel had shown.
 *
 * Held in a `WeakMap` on the session's object, so a private session's times go with its partition
 * rather than by a teardown somebody has to remember to call.
 */
type StateTimes = Map<string, { readonly state: DownloadState; readonly since: number }>

/**
 * What this file remembers about one window, for its button: what its chrome UI was last sent, so an
 * unchanged summary is not sent again. Held in a `WeakMap` on the window's object, like the state
 * times on the session's.
 */
interface ButtonMemory {
  last: DownloadButtonSummary
}

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
  const { handle, downloads, windows, discardCopies } = deps
  const now = deps.now ?? Date.now
  const memory = new WeakMap<DownloadHandlerWindow, ButtonMemory>()
  const stateTimes = new WeakMap<DownloadViewer['session'], StateTimes>()

  /*
    The session's state times, brought up to date with these rows.

    The state times are why this keeps memory at all. A paused record has no time of its own —
    `endedAt` belongs to terminal states — so the summary would have to take the start for the pause,
    and a download begun before the panel was presented and paused after it would count as seen. This
    runs on every coalesced change, and `DownloadManager` never coalesces a state change away, so the
    first pass that sees a new state is within a tick of it happening: that pass stamps it.

    Every row, not only the ones this window started: the times are the session's (see `StateTimes`),
    and the rows are the session's whole list, which is also what makes forgetting a row that is gone
    exact. Idempotent for the same rows — a state already remembered keeps its time — which is what
    lets the change loop below stamp before it re-presents the panel and the summary stamp again
    after, and lets every window of a session run it in turn.
  */
  const rememberStates = (
    window: DownloadHandlerWindow,
    entries: readonly DownloadEntry[]
  ): StateTimes => {
    const { session } = window.viewer
    let times = stateTimes.get(session)
    if (times === undefined) {
      times = new Map()
      stateTimes.set(session, times)
    }
    const stillListed = new Set<string>()
    for (const entry of entries) {
      stillListed.add(entry.id)
      if (times.get(entry.id)?.state !== entry.state) {
        times.set(entry.id, { state: entry.state, since: now() })
      }
    }
    // Forgotten with its row, so a cleared list leaves nothing behind here either.
    for (const id of times.keys()) {
      if (!stillListed.has(id)) times.delete(id)
    }
    return times
  }

  /** What a window's chrome UI was last sent; no button before it has been told anything. */
  const buttonMemory = (window: DownloadHandlerWindow): ButtonMemory => {
    let remembered = memory.get(window)
    if (remembered === undefined) {
      remembered = { last: NO_DOWNLOAD_BUTTON }
      memory.set(window, remembered)
    }
    return remembered
  }

  /** The button's summary for one window, as it stands, with the state times brought up to date. */
  const currentSummary = (
    window: DownloadHandlerWindow,
    entries: readonly DownloadEntry[]
  ): DownloadButtonSummary => {
    const { windowId } = window.viewer
    const times = rememberStates(window, entries)
    const since = new Map([...times].map(([id, seen]) => [id, seen.since]))
    return summarizeWindowDownloads(
      entries,
      downloads.idsStartedIn(windowId),
      window.downloadsPanelPresentedAt,
      since,
      downloads.handedOnSeenAt(windowId)
    )
  }

  /** The summary pushed to the window's chrome UI, if it changed or if `always`. */
  const publishSummary = (
    window: DownloadHandlerWindow,
    entries: readonly DownloadEntry[],
    always: boolean
  ): void => {
    const summary = currentSummary(window, entries)
    const remembered = buttonMemory(window)
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
    return currentSummary(window, downloads.snapshot(window.viewer))
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
  /*
    The copies go too, and before the answer: an older state of the list in a `.v1.bak` or an
    `.unreadable` would keep what the user just cleared. A failed removal rejects the call.
  */
  handle('downloads:clear', async (_payload, event) => {
    const removed = downloads.clear(sender(event))
    await discardCopies()
    return { removed }
  })

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
    /*
      One snapshot per session, not per window. What `snapshot` answers depends on the viewer's session
      alone — the stored list, plus the live rows that arrived on that session — so every window of the
      shared default session would otherwise rebuild the same list. Local to one firing, so nothing
      outlives the moment it describes; and safe to share because nothing below edits the array or
      its rows.
    */
    const bySession = new Map<DownloadViewer['session'], DownloadEntry[]>()
    for (const window of windows.downloadWindows) {
      // One snapshot for all three, so the page, the panel and the button describe the same moment.
      let entries = bySession.get(window.viewer.session)
      if (entries === undefined) {
        entries = downloads.snapshot(window.viewer)
        bySession.set(window.viewer.session, entries)
      }
      window.emitToInternalPages('downloads:changed', {
        downloads: entries,
        privateWindow: window.viewer.mode === 'private'
      })
      /*
        The panel before the button. A panel that is up and re-presented counts as looked at, which
        sends the button its summary at once (`onDownloadsPanelPresented`); the de-duplicated publish
        below then has nothing new to say, rather than sending a mark the panel has just cleared.

        But the state times before the panel. Re-presenting stamps the presentation with the clock,
        and the summary it triggers would only then stamp a new state with a second reading. A pause
        has no end time to fall back on, so a millisecond between the two would leave the pause the
        panel is showing later than the showing, and marked until the panel is next opened. Stamped
        first, every state time is no later than the presentation that shows it.
      */
      rememberStates(window, entries)
      window.refreshDownloadsPanel(entries)
      publishSummary(window, entries, false)
    }
  })

  // Registered once for the process, like the subscription above, and for the same reason.
  windows.onDownloadsPanelPresented((window) => {
    publishSummary(window, downloads.snapshot(window.viewer), true)
  })
}
