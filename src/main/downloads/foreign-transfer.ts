import { basename, isAbsolute, normalize } from 'node:path'
import { safeDownloadFileName } from '@shared/downloads/filename.js'
import {
  isActiveDownload,
  isTerminalDownloadState,
  type DownloadRecord
} from '@shared/downloads/model.js'
import type { DownloadItemLike, DownloadSession } from './DownloadManager.js'

/**
 * Transfers that did not come through Chromium's `will-download`, made to look like one that did.
 *
 * ## Why an item of our own rather than a second kind of live entry
 *
 * Everything the manager does with a download — the coalesced progress, the per-mode recorder, the
 * window claim, cancelling it with its private window, keeping a finished private row until the window
 * goes — is written against `DownloadItemLike`. A transfer that satisfies the same shape inherits every
 * one of those rules instead of a parallel copy of each, and a copy is where the two kinds would start
 * to disagree about, say, whether a private row survives its own completion. So the difference lives
 * here, in one class, and the manager's only branch on it is `canPause`.
 *
 * The first producer is `MediaDownloader`: `progress` accepts its `DownloadProgress` report as it
 * stands, and `cancel` is its `AbortController.abort`.
 *
 * ## Why cancelling ends the row at once
 *
 * A Chromium item is cancelled and then *tells* the manager, through `done`, because Chromium owns the
 * state. Here the manager owns it: the producer was asked to stop, and whatever it reports afterwards —
 * an aborted fetch typically surfaces as a failure a moment later — describes the stop we asked for, not
 * a new outcome. So the row reads "cancelled" straight away, and every report after an ending is
 * ignored. The partial file is the producer's to remove when it aborts; the manager never deletes by
 * path, for the reason `DownloadManager.releaseSession` gives.
 */

/** A report of how far a transfer is. `MediaDownloader`'s `DownloadProgress` satisfies it. */
export interface ForeignTransferProgress {
  readonly receivedBytes: number
  /** `null` when unknown, as for a segmented stream; recorded as the model's `0`. */
  readonly totalBytes: number | null
}

/**
 * Pausing, for a producer that can do it.
 *
 * Present or absent rather than a flag beside two optional callbacks, so "can pause" cannot be claimed
 * without the means to do it. Absent, pause and resume on the manager answer `false` and change nothing.
 */
export interface ForeignTransferPausing {
  pause(): void
  resume(): void
}

export interface ForeignTransferRequest {
  /** `BrowserWindow.id` of the window it was started from; its button shows it. */
  readonly windowId: number
  /** Which session it belongs to. Must be attached: the mode comes from that binding, never from here. */
  readonly session: DownloadSession
  /** Where it came from, for the row's second line. Empty when there is nothing to say. */
  readonly url?: string
  readonly mimeType?: string
  /** What the row calls the file. Must already be what `safeDownloadFileName` would make of it. */
  readonly fileName: string
  /** Absolute, normalised, and named as the sanitiser would name it; see `acceptsForeignTarget`. */
  readonly targetPath: string
  /** Stops the transfer and removes whatever partial file it wrote. */
  readonly cancel: () => void
  readonly pausing?: ForeignTransferPausing
}

/** What the producer holds while its transfer runs. Every call after an ending is ignored. */
export interface ForeignTransfer {
  /** The row's id, in the same namespace as Chromium's downloads. */
  readonly id: string
  readonly progress: (report: ForeignTransferProgress) => void
  readonly complete: () => void
  readonly fail: () => void
}

/**
 * Whether the record could carry this transfer truthfully.
 *
 * `DownloadRecord` promises an absolute `savePath` and a `fileName` the sanitiser has already passed.
 * A Chromium download gets both from `resolveSavePath`; a foreign one arrives with them chosen, so they
 * are checked instead — and refused rather than repaired, because a repaired name would no longer be
 * the file the producer is writing, and "Open" would then open something else or nothing.
 *
 * Not checked: that the target sits inside the configured directory. The producer chose the directory,
 * and the Chromium path with "ask where to save" does not hold that line either.
 */
export function acceptsForeignTarget(request: ForeignTransferRequest): boolean {
  const { targetPath, fileName } = request
  if (!isAbsolute(targetPath) || normalize(targetPath) !== targetPath) return false
  const onDisk = basename(targetPath)
  return safeDownloadFileName(onDisk) === onDisk && safeDownloadFileName(fileName) === fileName
}

type ItemState = ReturnType<DownloadItemLike['getState']>
type ItemEvent = 'updated' | 'done'

/** The foreign transfer as the manager sees it — a `DownloadItemLike` it can drive like any other. */
export class ForeignDownloadItem implements DownloadItemLike {
  readonly #request: ForeignTransferRequest
  readonly #listeners = new Map<ItemEvent, Set<() => void>>()
  #state: ItemState = 'progressing'
  #paused = false
  #received = 0
  #total = 0

  constructor(request: ForeignTransferRequest) {
    this.#request = request
  }

  get canPause(): boolean {
    return this.#request.pausing !== undefined
  }

  /** The producer's side of this item, under the id the manager gave it. */
  handle(id: string): ForeignTransfer {
    return {
      id,
      progress: (report) => {
        if (this.#ended) return
        this.#received = Math.max(0, report.receivedBytes)
        this.#total = Math.max(0, report.totalBytes ?? 0)
        this.#emit('updated')
      },
      complete: () => {
        this.#end('completed')
      },
      fail: () => {
        this.#end('interrupted')
      }
    }
  }

  getURL(): string {
    return this.#request.url ?? ''
  }
  getFilename(): string {
    return this.#request.fileName
  }
  getMimeType(): string {
    return this.#request.mimeType ?? ''
  }
  getContentDisposition(): string {
    return ''
  }
  getTotalBytes(): number {
    return this.#total
  }
  getReceivedBytes(): number {
    return this.#received
  }
  getState(): ItemState {
    return this.#state
  }
  getSavePath(): string {
    return this.#request.targetPath
  }
  isPaused(): boolean {
    return this.#paused
  }
  canResume(): boolean {
    return this.canPause && this.#paused && !this.#ended
  }
  setSavePath(_path: string): void {
    // Never called for this item, and ignored if it were: the producer chose the path.
  }

  pause(): void {
    if (this.#ended || this.#paused || this.#request.pausing === undefined) return
    this.#request.pausing.pause()
    this.#paused = true
  }

  resume(): void {
    if (!this.canResume()) return
    this.#request.pausing?.resume()
    this.#paused = false
  }

  cancel(): void {
    if (this.#ended) return
    try {
      this.#request.cancel()
    } catch (error) {
      // Still ended: a throwing producer must not stop `releaseSession` cancelling the rest.
      console.error('[downloads] a foreign transfer failed to cancel:', error)
    }
    this.#end('cancelled')
  }

  on(event: ItemEvent, listener: () => void): void {
    const listeners = this.#listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(event, listeners)
  }

  removeListener(event: ItemEvent, listener: () => void): void {
    this.#listeners.get(event)?.delete(listener)
  }

  get #ended(): boolean {
    return isTerminalDownloadState(this.#state)
  }

  /** The order Chromium keeps and the manager relies on: the state moves, then `done` fires. */
  #end(state: 'completed' | 'cancelled' | 'interrupted'): void {
    if (this.#ended) return
    this.#state = state
    this.#paused = false
    this.#emit('done')
  }

  #emit(event: ItemEvent): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener()
  }
}

/** False only for a foreign transfer whose producer cannot pause. Chromium's items always can. */
export function canPause(item: DownloadItemLike): boolean {
  return !(item instanceof ForeignDownloadItem) || item.canPause
}

/**
 * `DownloadEntry.canPause` for a row: it has not ended, and its live transfer, if it still has one, can
 * pause.
 *
 * The state is asked as well as the transfer, because the two part company for a moment. The manager
 * announces an ending before it lets go of the transfer, so the push that says "cancelled" is read while
 * the live entry is still there — and a private download keeps its live entry until its window closes.
 * Either way the row has finished, and a finished row has nothing to pause.
 *
 * Here rather than in the manager so the manager's one use of it stays a single line — and because this
 * file already owns the only reason the answer is ever "no" for a running row.
 */
export function rowCanPause(record: DownloadRecord, item: DownloadItemLike | undefined): boolean {
  return isActiveDownload(record) && item !== undefined && canPause(item)
}
