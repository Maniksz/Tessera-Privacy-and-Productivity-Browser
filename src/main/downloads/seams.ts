import type { BrowsingMode } from '../data/HistoryStore.js'
import type { DownloadRecord, DownloadRecorder } from '@shared/downloads/model.js'

/*
  The seams `DownloadManager` talks through, and nothing else.

  Types only, so a test builds each of them from plain objects and Electron is never loaded; the
  compile-time proof that Electron's own objects satisfy the two Electron-shaped ones stays at the
  bottom of `DownloadManager.ts`, beside the imports it needs. Re-exported from there, so a caller
  keeps naming the manager's module.
*/

/**
 * The part of Electron's `DownloadItem` this feature uses.
 *
 * Structural on purpose, so a test drives a download with a dozen plain functions and
 * Electron is never loaded. The assignment at the bottom of `DownloadManager.ts` is what
 * keeps that honest — it stops compiling if Electron's item stops satisfying the shape.
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

/**
 * The web contents Electron names as having started a download — a tab's page, usually.
 *
 * Only its id, which is all the window registry needs to find the tab and so the window. Optional in
 * the listener although Electron's types say otherwise: a download with no page behind it still
 * arrives, and the fallback for it is decided by the resolver rather than by a crash here.
 */
export interface DownloadSource {
  readonly id: number
}

/** The part of Electron's `Session` this feature uses. */
export interface DownloadSession {
  on(
    event: 'will-download',
    listener: (event: unknown, item: DownloadItemLike, source: DownloadSource | undefined) => void
  ): void
}

/**
 * The window asking what it may see, as the manager needs to know it.
 *
 * The session, not the mode, is what decides which live rows belong to it. A private session is a
 * fresh partition per window, so "private" names every private window at once, and filtering on it
 * showed each private window the downloads of every other.
 */
export interface DownloadViewer {
  /** `BrowserWindow.id`; see `DownloadOwnership` for why it is never written down. */
  readonly windowId: number
  readonly mode: BrowsingMode
  readonly session: DownloadSession
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
