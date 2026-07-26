// Types only, so this module still runs under plain Node in a test — the seams below are what
// the manager actually talks to.
import type { DownloadItem, Session } from 'electron'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { downloadFileNameFor } from '@shared/downloads/filename.js'
import {
  isTerminalDownloadState,
  recordFor,
  type DownloadEntry,
  type DownloadPatch,
  type DownloadRecord,
  type DownloadRecorder,
  type DownloadState,
  type StartedDownload
} from '@shared/downloads/model.js'
import type { BrowsingMode } from '../data/HistoryStore.js'
import { resolveSavePath } from './target-path.js'

/**
 * The Electron-bound half of downloads: subscribing to `will-download`, deciding where each
 * file goes, and turning a `DownloadItem`'s events into records.
 *
 * ## Why `setSavePath` has to be decided synchronously
 *
 * The single most surprising constraint in this feature. Electron's own words: *"If user
 * doesn't set the save path via the API, Electron will use the original routine to determine
 * the save path; this usually prompts a save dialog."* The API is only available inside the
 * `will-download` callback — so the moment the handler returns without having set a path,
 * the native Save dialogue appears.
 *
 * That makes the decision synchronous, which is why `resolveSavePath` probes the disk with a
 * synchronous `exists` rather than a promise. An `await` there compiles, reads perfectly
 * well, and produces a browser that shows a save dialogue for every download while
 * `downloads.askForEachFile` is off — with no error anywhere to explain it.
 *
 * ## Why progress does not reach the store, and barely reaches the renderer
 *
 * `updated` fires several times a second per download. Two consequences, handled separately:
 *
 *   - **The store** learns about a download when it starts and when its *state* changes.
 *     Persisting byte counts would re-serialise and re-encrypt the whole document on every
 *     chunk.
 *   - **The renderer** gets a coalesced event: a trailing timer at
 *     `progressIntervalMs`, so a hundred updates become four a second. A state change — done,
 *     paused, interrupted — bypasses the timer and is emitted at once, because a finished
 *     download that takes a quarter of a second to *look* finished reads as a stuck one. The
 *     same split the tab strip makes between "position moved" and "a tab appeared".
 *
 * ## Why timestamps come from our clock and not from the item
 *
 * `DownloadItem.getStartTime()` reports *seconds* since the epoch, while everything else in
 * this codebase is milliseconds. Reading it directly would file every download in January
 * 1970 and sort the whole list wrongly — the same unit trap as `ADD_DATE` in an imported
 * bookmark file. Taking the time from the injected clock avoids the question and keeps a
 * download's timestamp comparable with a history entry's.
 */

/**
 * The part of Electron's `DownloadItem` this feature uses.
 *
 * Structural on purpose, so a test drives a download with a dozen plain functions and
 * Electron is never loaded. The assignment at the bottom of this file is what keeps that
 * honest — it stops compiling if Electron's item stops satisfying the shape.
 *
 * The event listeners deliberately take no arguments. Electron passes the new state as the
 * second one, but `item.getState()` and `item.isPaused()` answer the same question and are
 * the item's own view rather than a snapshot from when the event was queued. One source of
 * truth, and a fake in a test does not have to reproduce Electron's argument list.
 */
export interface DownloadItemLike {
  getURL(): string
  getFilename(): string
  getMimeType(): string
  getContentDisposition(): string
  getTotalBytes(): number
  getReceivedBytes(): number
  getState(): 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  getSavePath(): string
  isPaused(): boolean
  canResume(): boolean
  setSavePath(path: string): void
  pause(): void
  resume(): void
  cancel(): void
  /*
    One signature over the union rather than an overload per event.

    Two overloads with identical parameter types say nothing the union does not, and the linter is right that
    they only look more precise. Electron's own `DownloadItem` is wider than this; the narrowing to two names is
    the point, and it survives.
  */
  on(event: 'updated' | 'done', listener: () => void): void
  removeListener(event: 'updated' | 'done', listener: () => void): void
}

/** The part of Electron's `Session` this feature uses. */
export interface DownloadSession {
  on(event: 'will-download', listener: (event: unknown, item: DownloadItemLike) => void): void
}

/** What the manager needs from the store. `DownloadStore` satisfies it. */
export interface DownloadBook {
  list(): DownloadRecord[]
  find(id: string): DownloadRecord | undefined
  remove(id: string): number
  clear(): number
  recorderFor(mode: BrowsingMode): DownloadRecorder
}

/**
 * Opening a file and showing it in its folder.
 *
 * A seam rather than an `electron` import, for the usual reason: a test must be able to
 * assert that a missing file is *not* handed to the operating system, and that assertion
 * cannot involve actually opening one.
 */
export interface DownloadShell {
  /** Electron's contract: an empty string means success, anything else is the reason. */
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}

export interface DownloadManagerOptions {
  store: DownloadBook
  getSettings: () => SettingsSnapshot
  /** `app.getPath('downloads')`, read per download so the setting stays live. */
  defaultDirectory: () => string
  /** Synchronous by necessity — see the note on `setSavePath` above. */
  fileExists: (path: string) => boolean
  shell: DownloadShell
  now?: () => number
  progressIntervalMs?: number
}

/** How long progress reports are coalesced for. Four updates a second reads as smooth. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 250

interface LiveDownload {
  record: DownloadRecord
  item: DownloadItemLike
  /** Which kind of window started it. A private one is never written down. */
  mode: BrowsingMode
  session: DownloadSession
  dispose: () => void
}

export class DownloadManager {
  readonly #options: DownloadManagerOptions
  readonly #now: () => number
  readonly #progressIntervalMs: number
  readonly #live = new Map<string, LiveDownload>()
  /** The recorder each live download was started with, so its updates go to the same place. */
  readonly #recorders = new Map<string, DownloadRecorder>()
  readonly #attached = new WeakSet<DownloadSession>()
  readonly #listeners = new Set<() => void>()
  /**
   * Memoised answers to "is that file still there", keyed by path.
   *
   * Needed because a snapshot is built on every coalesced emission, and probing a thousand
   * paths four times a second would be absurd. `refresh()` empties it, and that is what the
   * pull path — a person opening the page — does first, so what somebody looks at is freshly
   * probed while what is pushed at them reuses an answer from a moment ago.
   */
  readonly #present = new Map<string, boolean>()
  #pendingEmit: ReturnType<typeof setTimeout> | null = null
  #counter = 0

  constructor(options: DownloadManagerOptions) {
    this.#options = options
    this.#now = options.now ?? (() => Date.now())
    this.#progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS
  }

  /**
   * Subscribes to one session's downloads.
   *
   * The mode is bound here, once per session, and never again — the same discipline
   * `WindowRegistry` applies to history, favicons and thumbnails. A private session is a
   * fresh in-memory partition per window, so it can never be the one already attached under
   * `normal`; the guard exists for the shared default session, which several windows prepare.
   */
  attach(session: DownloadSession, mode: BrowsingMode): void {
    if (this.#attached.has(session)) return
    this.#attached.add(session)
    const recorder = this.#options.store.recorderFor(mode)
    session.on('will-download', (_event, item) => {
      this.#begin(item, session, mode, recorder)
    })
  }

  /**
   * Everything a window of this kind may see, freshly probed.
   *
   * The probe cache is emptied first: this is the path a person's click takes, and it is the
   * one place where paying for the truth is obviously worth it.
   */
  list(mode: BrowsingMode): DownloadEntry[] {
    this.#present.clear()
    return this.snapshot(mode)
  }

  /**
   * The same list, from what is already known.
   *
   * A private window's own downloads appear here and nowhere else: they exist only in
   * `#live`, so a normal window's snapshot cannot include them however the list is filtered.
   * The stored list *is* shown to a private window, deliberately — reading the profile's own
   * download history from a private window reveals nothing to anybody else, while writing to
   * it would. The rule stays "a private window contributes nothing", not "a private window
   * sees nothing".
   */
  snapshot(mode: BrowsingMode): DownloadEntry[] {
    const stored = this.#options.store.list()
    const storedIds = new Set(stored.map((record) => record.id))

    const merged = [
      // The live copy wins for a record the store also holds: it carries the byte count that
      // was deliberately never written down.
      ...stored.map((record) => this.#live.get(record.id)?.record ?? record),
      ...[...this.#live.values()]
        .filter((live) => live.mode === mode && !storedIds.has(live.record.id))
        .map((live) => live.record)
    ]

    return merged
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((record) => this.#entryFor(record))
  }

  /** Called when a download starts, ends, is paused, or advances. Coalesced; see the header. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  pause(id: string): boolean {
    const live = this.#live.get(id)
    if (live === undefined || live.item.isPaused()) return false
    live.item.pause()
    this.#note(live, { state: 'paused' })
    return true
  }

  /**
   * Resumes a paused download.
   *
   * `canResume` is consulted rather than assumed. Electron is explicit that resuming without
   * server support for range requests *"will dismiss previously received bytes and restart
   * the download from the beginning"* — so a resume button that silently restarted a
   * nine-tenths-finished file would be worse than one that reports it cannot.
   */
  resume(id: string): boolean {
    const live = this.#live.get(id)
    if (live === undefined || !live.item.isPaused() || !live.item.canResume()) return false
    live.item.resume()
    this.#note(live, { state: 'progressing' })
    return true
  }

  cancel(id: string): boolean {
    const live = this.#live.get(id)
    if (live === undefined) return false
    // The state is not written here: Electron answers with a `done` event whose
    // `getState()` is authoritative, and guessing ahead of it would let the two disagree if
    // the download happened to finish in the same tick.
    live.item.cancel()
    return true
  }

  /**
   * Forgets a row, cancelling the download first if it is still running.
   *
   * Cancelling rather than refusing: the button says "remove this from the list", and a row
   * that disappeared while its file kept being written would leave a download nothing in the
   * interface admits to and nothing can stop. The file a *completed* download produced is
   * left alone — removing a record is not deleting somebody's file.
   */
  remove(id: string): boolean {
    const live = this.#live.get(id)
    if (live !== undefined) {
      live.item.cancel()
      live.dispose()
      this.#live.delete(id)
    }
    const removed = this.#options.store.remove(id)
    this.#emitNow()
    return removed > 0 || live !== undefined
  }

  /** Forgets every finished row. Anything running stays; see `DownloadStore.clear`. */
  clear(): number {
    for (const [id, live] of [...this.#live]) {
      if (isTerminalDownloadState(live.record.state)) {
        live.dispose()
        this.#live.delete(id)
      }
    }
    const removed = this.#options.store.clear()
    this.#emitNow()
    return removed
  }

  /**
   * Opens a completed download, or reports that it cannot be opened.
   *
   * Probed again here, ignoring the memo. This is the authoritative check: between the
   * snapshot that drew the row and this click the file can have been deleted, and the honest
   * answer then is `false` plus a refreshed list — not a native error dialogue naming a path.
   */
  async open(id: string): Promise<boolean> {
    const record = this.#recordFor(id)
    if (record?.state !== 'completed') return false
    if (!this.#probe(record.savePath)) {
      this.#emitNow()
      return false
    }
    const failure = await this.#options.shell.openPath(record.savePath)
    return failure === ''
  }

  /** Shows the file in its folder. Same authoritative re-probe as `open`. */
  reveal(id: string): boolean {
    const record = this.#recordFor(id)
    if (record === undefined) return false
    if (!this.#probe(record.savePath)) {
      this.#emitNow()
      return false
    }
    this.#options.shell.showItemInFolder(record.savePath)
    return true
  }

  /**
   * Drops everything a session's downloads left in memory.
   *
   * The last piece of "a private window leaves no record": the store never saw those
   * downloads, but the manager did, and a `#live` entry that outlived its window would keep a
   * private download's address and file name in the process for as long as the browser ran.
   * Called when a window closes, beside the session's storage being cleared.
   */
  releaseSession(session: DownloadSession): void {
    for (const [id, live] of [...this.#live]) {
      if (live.session !== session) continue
      live.dispose()
      this.#live.delete(id)
    }
    this.#emitNow()
  }

  /** How many downloads are being tracked in memory. For tests and diagnostics. */
  get liveCount(): number {
    return this.#live.size
  }

  #begin(
    item: DownloadItemLike,
    session: DownloadSession,
    mode: BrowsingMode,
    recorder: DownloadRecorder
  ): void {
    this.#counter += 1
    const id = `dl-${this.#now().toString(36)}-${this.#counter.toString(36)}`

    /*
      Every name a server can influence goes through one function, and this is the call.

      Chromium's own suggestion is offered first because it has already reconciled the header
      with the address — but it is not trusted, which is the whole point: `downloadFileNameFor`
      sanitises whichever candidate wins.
    */
    const fileName = downloadFileNameFor({
      suggested: item.getFilename(),
      contentDisposition: item.getContentDisposition(),
      url: item.getURL()
    })

    const settings = this.#options.getSettings()
    const askForEachFile = settings['downloads.askForEachFile']

    let savePath = ''
    if (!askForEachFile) {
      const resolved = resolveSavePath(
        {
          directory: settings['downloads.directory'],
          fallbackDirectory: this.#options.defaultDirectory(),
          fileName
        },
        { exists: this.#options.fileExists }
      )
      if (resolved === null) {
        /*
          No safe path: the directory rejected every candidate, or the join would have left
          it.

          Cancelled rather than falling back to the save dialogue. A dialogue here would ask
          the user to confirm a download whose name we have just decided we cannot write, and
          whichever path they picked would bypass the check that refused.
        */
        item.cancel()
        return
      }
      savePath = resolved
      // Synchronously, inside the `will-download` handler. See the header: an `await` before
      // this line is a save dialogue the user did not ask for.
      item.setSavePath(savePath)
    }

    const started: StartedDownload = {
      id,
      url: item.getURL(),
      fileName,
      // Empty while the user is still choosing in the dialogue; filled from the item on the
      // first update, which is the earliest moment Electron knows.
      savePath,
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      startedAt: this.#now()
    }
    const record = recordFor(started)

    const onUpdated = (): void => {
      this.#advance(id)
    }
    const onDone = (): void => {
      this.#finish(id)
    }
    /*
      Widened to a plain emitter so both subscriptions and both removals read the same.

      Every subscription gets a way back off (spec 6): a `DownloadItem` outlives its download
      only until the last reference goes, and a listener left on one would keep both alive.
      `dispose` is called from `#finish`, from `remove`, and from `releaseSession`.
    */
    const emitter = item
    emitter.on('updated', onUpdated)
    emitter.on('done', onDone)
    const dispose = (): void => {
      emitter.removeListener('updated', onUpdated)
      emitter.removeListener('done', onDone)
    }

    this.#live.set(id, { record, item, mode, session, dispose })
    this.#recorders.set(id, recorder)
    // A private window's recorder discards. That is the whole mechanism: there is no branch
    // here that decides whether to write, because the object handed over already decided.
    recorder.start(started)
    this.#emitNow()
  }

  #advance(id: string): void {
    const live = this.#live.get(id)
    if (live === undefined) return

    const state = this.#stateOf(live.item, 'updated')
    const changed = state !== live.record.state
    this.#note(
      live,
      {
        state,
        receivedBytes: live.item.getReceivedBytes(),
        totalBytes: live.item.getTotalBytes(),
        // The dialogue path only learns its path here, once the user has chosen. Never
        // overwritten with an empty one, which is what the item reports before the choice.
        ...(live.item.getSavePath() === '' ? {} : { savePath: live.item.getSavePath() })
      },
      // A state change is news; bytes are not. See the header for why the two are emitted
      // differently.
      changed ? 'now' : 'soon'
    )
  }

  #finish(id: string): void {
    const live = this.#live.get(id)
    if (live === undefined) return

    const state = this.#stateOf(live.item, 'done')
    const savePath = live.item.getSavePath()
    this.#note(
      live,
      {
        state,
        receivedBytes: live.item.getReceivedBytes(),
        totalBytes: live.item.getTotalBytes(),
        ...(savePath === '' ? {} : { savePath })
      },
      'now'
    )
    /*
      `interruptReason` is deliberately left as it was, which is empty.

      Electron's `DownloadItem` exposes no reason for an interruption — there is no
      `getInterruptReason` — so there is nothing truthful to put here. The model says why that
      matters: inventing a message would make an unexplained failure look like a diagnosed one.
      The field exists for the day Electron reports one, and for records written by a build
      that can.
    */
    // A file that has just arrived must not be reported missing because the answer from
    // before it existed is still memoised.
    this.#present.delete(savePath)
    this.#present.delete(live.record.savePath)
    live.dispose()
    /*
      The live entry stays for a *private* download and goes for a stored one.

      A stored record already holds everything the finished download was, so keeping the live
      copy would mean two answers to one id. A private download has no stored copy at all —
      dropping it here would make the row vanish the instant it finished, which is exactly
      when the user wants to open it. It goes with the window, in `releaseSession`.
    */
    if (live.mode === 'private') {
      this.#live.set(id, { ...live, dispose: () => {} })
    } else {
      this.#live.delete(id)
    }
    this.#recorders.delete(id)
  }

  /**
   * Electron's four states, plus the two it does not report as states at all.
   *
   * **Paused is a flag, not a state.** A paused download still answers `progressing`, so a row
   * built from `getState()` alone would say "in progress" beside a byte count that never
   * moves — the most confusing thing this list could show.
   *
   * **`interrupted` means two different things depending on which event carried it.** From
   * `updated` it means interrupted *and resumable*; from `done` it means interrupted and
   * finished. Taking it as terminal in the first case is a silent bug: the download can still
   * be resumed, but the row would show no resume button, the live entry would be treated as
   * finished, and the partial file would sit on disk with nothing offering to continue it.
   * Electron's own documentation draws this distinction and nothing else does, which is why it
   * is written down here rather than trusted to be remembered.
   */
  #stateOf(item: DownloadItemLike, phase: 'updated' | 'done'): DownloadState {
    const state = item.getState()
    if (phase === 'done') return state
    if (state === 'interrupted') return 'paused'
    if (state === 'progressing' && item.isPaused()) return 'paused'
    return state
  }

  /** Applies a patch to the live copy, to the store, and then tells whoever is listening. */
  #note(live: LiveDownload, patch: DownloadPatch, when: 'now' | 'soon' = 'now'): void {
    const next: DownloadRecord = {
      ...live.record,
      ...patch,
      state: patch.state ?? live.record.state,
      endedAt:
        patch.endedAt !== undefined
          ? patch.endedAt
          : isTerminalDownloadState(patch.state ?? live.record.state)
            ? (live.record.endedAt ?? this.#now())
            : live.record.endedAt
    }
    this.#live.set(next.id, { ...live, record: next })

    /*
      Only state changes reach the store; byte counts do not.

      This is the line that keeps a download from rewriting and re-encrypting the whole
      document on every chunk. The final byte count is carried by the terminal patch, which is
      a state change and therefore does get written.
    */
    if (patch.state !== undefined && patch.state !== live.record.state) {
      this.#recorders.get(next.id)?.update(next.id, patch)
    }

    if (when === 'now') this.#emitNow()
    else this.#emitSoon()
  }

  #recordFor(id: string): DownloadRecord | undefined {
    return this.#live.get(id)?.record ?? this.#options.store.find(id)
  }

  #entryFor(record: DownloadRecord): DownloadEntry {
    return { ...record, onDisk: this.#lookUp(record) }
  }

  /**
   * Whether the file is there, memoised.
   *
   * Only a completed download is probed at all: a cancelled or interrupted one has no file to
   * find, and `fileWentMissing` in the model already distinguishes the two cases for the
   * interface. Probing them anyway would be a stat call per row for an answer nothing reads.
   */
  #lookUp(record: DownloadRecord): boolean {
    if (record.state !== 'completed') return false
    if (record.savePath === '') return false
    const remembered = this.#present.get(record.savePath)
    if (remembered !== undefined) return remembered
    return this.#probe(record.savePath)
  }

  #probe(path: string): boolean {
    if (path === '') return false
    const found = this.#options.fileExists(path)
    this.#present.set(path, found)
    return found
  }

  #emitSoon(): void {
    if (this.#pendingEmit !== null) return
    this.#pendingEmit = setTimeout(() => {
      this.#pendingEmit = null
      this.#fire()
    }, this.#progressIntervalMs)
  }

  #emitNow(): void {
    if (this.#pendingEmit !== null) {
      clearTimeout(this.#pendingEmit)
      this.#pendingEmit = null
    }
    this.#fire()
  }

  #fire(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error) {
        // One bad listener must not stop the others, exactly as in `JsonStore.update`.
        console.error('[downloads] listener threw:', error)
      }
    }
  }
}

/*
  Electron really does satisfy the two seams above.

  This is what makes a structural seam trustworthy rather than hopeful: a test can drive the
  manager with plain objects, and if Electron's `DownloadItem` ever stops matching — a method
  renamed, an event dropped — the build fails here instead of at runtime in a shipped
  browser. The same guard `MediaSessions` puts under its session seam.
*/
const _electronItemIsADownloadItem: DownloadItemLike = null as unknown as DownloadItem
const _electronSessionIsADownloadSession: DownloadSession = null as unknown as Session
void _electronItemIsADownloadItem
void _electronSessionIsADownloadSession
