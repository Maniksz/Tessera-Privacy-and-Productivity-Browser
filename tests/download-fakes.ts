import type {
  DownloadItemLike,
  DownloadSession,
  DownloadSource
} from '@main/downloads/DownloadManager.js'
import type { DownloadEntry } from '@shared/downloads/model.js'

/**
 * A `DownloadItem` and a `Session` as plain objects, for the manager's tests and the download scenarios.
 *
 * Shared rather than written twice because both have to agree with Chromium on the one sequence that
 * matters — the state moves first, then `done` fires — and two copies of a fake are two chances to get
 * that order wrong in only one of them.
 *
 * Every call an item receives is written down in order. That is what lets a test say "cancelled before
 * its listeners were taken off", which is a claim about sequence rather than about the end state.
 */

type ItemState = ReturnType<DownloadItemLike['getState']>
type ItemEvent = 'updated' | 'done'

export class FakeItem implements DownloadItemLike {
  readonly calls: string[] = []
  state: ItemState = 'progressing'
  paused = false
  resumable = true
  received = 0
  savePath = ''
  readonly #listeners = new Map<ItemEvent, Set<() => void>>()

  constructor(
    readonly url: string,
    readonly total = 1_000
  ) {}

  getURL(): string {
    return this.url
  }
  getFilename(): string {
    return ''
  }
  getMimeType(): string {
    return 'application/octet-stream'
  }
  getContentDisposition(): string {
    return ''
  }
  getTotalBytes(): number {
    return this.total
  }
  getReceivedBytes(): number {
    return this.received
  }
  getState(): ItemState {
    return this.state
  }
  getSavePath(): string {
    return this.savePath
  }
  isPaused(): boolean {
    return this.paused
  }
  canResume(): boolean {
    return this.resumable
  }
  setSavePath(path: string): void {
    this.savePath = path
  }
  pause(): void {
    this.calls.push('pause')
    this.paused = true
  }
  resume(): void {
    this.calls.push('resume')
    this.paused = false
  }
  cancel(): void {
    this.calls.push('cancel')
  }
  on(event: ItemEvent, listener: () => void): void {
    const listeners = this.#listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(event, listeners)
  }
  removeListener(event: ItemEvent, listener: () => void): void {
    this.calls.push(`removeListener:${event}`)
    this.#listeners.get(event)?.delete(listener)
  }

  get listenerCount(): number {
    return [...this.#listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0)
  }

  emit(event: ItemEvent): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener()
  }

  /** What Chromium does when a transfer ends: the state moves, then `done` fires. */
  end(state: 'completed' | 'cancelled' | 'interrupted'): void {
    this.state = state
    if (state === 'completed') this.received = this.total
    this.emit('done')
  }
}

type WillDownload = (
  event: unknown,
  item: DownloadItemLike,
  source: DownloadSource | undefined
) => void

export class FakeSession implements DownloadSession {
  #listener: WillDownload | null = null

  on(_event: 'will-download', listener: WillDownload): void {
    this.#listener = listener
  }

  /**
   * Starts a download on this session.
   *
   * `source` is the web contents Electron names as having started it, by id. Omitted for the case
   * Electron's own types do not admit and a download still produces: one with no page behind it.
   */
  download(item: FakeItem, source?: number): FakeItem {
    if (this.#listener === null) throw new Error('nothing attached to this session')
    this.#listener({}, item, source === undefined ? undefined : { id: source })
    return item
  }
}

/**
 * One row of a window's download list, as the core would hand it out.
 *
 * Shared for the fakes' own reason: every test that needs a row needs every field of one, and a copy of
 * the shape per file is a copy per file to update when a field is added. The defaults are an unremarkable
 * download partway through; a test says what it depends on through `overrides`, which win over everything
 * here, the id included.
 */
export function downloadEntry(id: string, overrides: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    id,
    url: `https://files.example/${id}.zip`,
    fileName: `${id}.zip`,
    savePath: `/downloads/${id}.zip`,
    mimeType: 'application/zip',
    totalBytes: 1000,
    receivedBytes: 400,
    state: 'progressing',
    startedAt: 1_700_000_000_000,
    endedAt: null,
    interruptReason: '',
    onDisk: false,
    canPause: true,
    ...overrides
  }
}
