/**
 * Downloads — what `tessera://downloads` lists.
 *
 * ## Why this file has no zod import
 *
 * The downloads page is a renderer, so every value import here lands in a bundle the user
 * waits for. The persistence schema therefore lives with the store, in
 * `src/main/data/DownloadStore.ts`, and an architecture test keeps validation libraries out
 * of anything this file can reach. See
 * `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`.
 *
 * ## Why downloads are a different kind of thing from bookmarks
 *
 * A bookmark is a list the user edits. A download is an *event over time*: it starts because
 * a page did something, it progresses, it can be paused, and it ends — in success, in
 * cancellation, or in failure. Almost every design decision here follows from that:
 *
 *   - **State is a closed set with terminal members.** `isTerminalDownloadState` is the
 *     predicate that decides whether pause and cancel are even offered, and it exists as a
 *     function rather than as three comparisons at each call site.
 *   - **Progress is not persisted.** A record is written when a download starts and when it
 *     ends; the bytes-so-far live in memory, because writing them would rewrite and
 *     re-encrypt the whole document several times a second for the length of the download.
 *     `DownloadManager` explains the coalescing that goes with it.
 *   - **Presence on disk is never stored.** See `DownloadEntry`.
 */

export const DOWNLOAD_STATES = [
  'progressing',
  'paused',
  'completed',
  'cancelled',
  'interrupted'
] as const
export type DownloadState = (typeof DOWNLOAD_STATES)[number]

/**
 * States from which nothing more will happen on its own.
 *
 * `paused` is deliberately *not* terminal: a paused download is still a download, still has
 * a partial file on disk, and can be resumed. Treating it as finished is how a resume button
 * disappears from the one row that needs it.
 */
export const TERMINAL_DOWNLOAD_STATES: readonly DownloadState[] = [
  'completed',
  'cancelled',
  'interrupted'
]

const terminalSet: ReadonlySet<string> = new Set(TERMINAL_DOWNLOAD_STATES)

export function isTerminalDownloadState(state: DownloadState): boolean {
  return terminalSet.has(state)
}

export function isDownloadState(value: unknown): value is DownloadState {
  return typeof value === 'string' && (DOWNLOAD_STATES as readonly string[]).includes(value)
}

/**
 * Records kept at most, oldest first to go.
 *
 * The same write-cost reasoning as the history cap: the store rewrites and re-encrypts the
 * whole document on every flush. A thousand downloads is a long history of files for one
 * profile, and dropping the oldest is right here where it would be wrong for bookmarks — a
 * download record's value decays, a bookmark's does not.
 */
export const MAX_DOWNLOAD_RECORDS = 1000

/** Longest address kept. Beyond this the record is still kept, with the address truncated. */
export const MAX_DOWNLOAD_URL_LENGTH = 2048

/**
 * One download, as it is stored.
 *
 * `totalBytes` is `0` rather than `null` when the server sent no `Content-Length`, because
 * that is what Electron reports and inventing a second spelling for "unknown" would mean
 * translating at the boundary. `downloadFraction` is the one place that has to know.
 */
export interface DownloadRecord {
  /** Unique for the life of the profile, and the identity used by every operation. */
  id: string
  url: string
  /** Already sanitised by `safeDownloadFileName` before it ever reaches here. */
  fileName: string
  /** Absolute, and inside the configured directory — see `resolveSavePath`. */
  savePath: string
  mimeType: string
  /** `0` when the server declared no length. */
  totalBytes: number
  receivedBytes: number
  state: DownloadState
  startedAt: number
  /** `null` while the download is still going. */
  endedAt: number | null
  /**
   * Why it stopped, when it stopped badly. Empty otherwise.
   *
   * A string rather than an enum: the reasons come from Chromium and the list grows between
   * versions. An unrecognised reason shown verbatim is more use to somebody diagnosing a
   * failed download than "unknown error".
   */
  interruptReason: string
}

export interface DownloadDocument {
  version: 1
  /** Most recently started first. Storage order is the only record of that ordering. */
  downloads: DownloadRecord[]
}

export function emptyDownloadDocument(): DownloadDocument {
  return { version: 1, downloads: [] }
}

/**
 * A record plus the one thing that must never be written down.
 *
 * ## Why `onDisk` is derived at read time
 *
 * A download completes, and three weeks later the user deletes the file. Nothing tells the
 * browser. A stored flag would say the file is there — so the list would offer "Open", the
 * user would click it, and the operating system would report a missing file in a dialogue
 * that names a path rather than explaining anything.
 *
 * So presence is probed when somebody looks, and it is *not* part of the document. Exactly
 * the reasoning `quickLinkCardSchema` gives for keeping picture addresses out of the stored
 * shape: a derived value that can only ever be wrong does not belong in a file.
 *
 * ## Why the probe is a hint and the open is authoritative
 *
 * Between any probe and the click that follows it, the file can vanish. That race cannot be
 * closed and it would be dishonest to pretend otherwise, so the design names which check is
 * which: this one decides what the row *looks* like, and `downloads:open` checks again and
 * reports failure. A page that only had the first check would show a working button for a
 * file that is gone; one that only had the second would show no state at all.
 */
export interface DownloadEntry extends DownloadRecord {
  /** Probed when the list was read. Never stored. */
  onDisk: boolean
}

/** True when the row may offer "Open" and "Show in folder". */
export function canOpenDownload(entry: DownloadEntry): boolean {
  return entry.state === 'completed' && entry.onDisk
}

/**
 * True when the file a *finished* download produced is not there any more.
 *
 * Distinct from `!onDisk`, which is also true of a cancelled download that never wrote
 * anything. Only this case deserves the "file was moved or deleted" note; saying it about a
 * download the user cancelled themselves would be nonsense.
 */
export function fileWentMissing(entry: DownloadEntry): boolean {
  return entry.state === 'completed' && !entry.onDisk
}

/** True while pause, resume or cancel can still do something. */
export function isActiveDownload(record: DownloadRecord): boolean {
  return !isTerminalDownloadState(record.state)
}

/**
 * How far along, from 0 to 1, or `null` when the total is unknown.
 *
 * `null` rather than 0, because the two mean different things to a progress bar: unknown has
 * to be drawn as an indeterminate bar, and drawing it as 0 % would show a bar that never
 * moves for the whole download. A declared total smaller than what has already arrived —
 * servers do send that — is clamped, so the bar cannot overrun its track.
 */
export function downloadFraction(record: DownloadRecord): number | null {
  if (record.totalBytes <= 0) return null
  return Math.min(1, record.receivedBytes / record.totalBytes)
}

/** Where a download came from, for the row's second line. Empty for an unparseable address. */
export function downloadSourceHost(record: DownloadRecord): string {
  try {
    return new URL(record.url).host
  } catch {
    return ''
  }
}

// --- writes ------------------------------------------------------------------

/** Everything known when a download begins. */
export interface StartedDownload {
  id: string
  url: string
  fileName: string
  savePath: string
  mimeType: string
  totalBytes: number
  startedAt: number
}

/** What changed when a download ended, or was paused, or advanced past a milestone. */
export interface DownloadPatch {
  state?: DownloadState
  receivedBytes?: number
  totalBytes?: number
  /** Chromium can move the path after the fact when the user picks one in the dialogue. */
  savePath?: string
  fileName?: string
  endedAt?: number | null
  interruptReason?: string
}

/**
 * The write side of the download list, and the only one a caller ever gets handed.
 *
 * A private window is given `discardingDownloadRecorder` instead of one bound to the store,
 * so "a download in a private window leaves no record" is a property of the object the
 * window holds rather than a check every call site has to remember. See
 * `DownloadStore.recorderFor`.
 */
export interface DownloadRecorder {
  start(started: StartedDownload): void
  update(id: string, patch: DownloadPatch): void
  /** So the manager can tell whether a row it is tracking exists in the list at all. */
  remembers(id: string): boolean
}

/**
 * A recorder that keeps nothing, for private windows.
 *
 * It holds no reference to any store, which is the whole point: forgetting a `privateMode`
 * check cannot leak a download, because there is nothing here to leak it into. `remembers`
 * answers false for the same reason — a private download is not in the list, and code that
 * asks must get the truthful answer rather than one that makes it look filed.
 */
export const discardingDownloadRecorder: DownloadRecorder = {
  start: (_started: StartedDownload) => {},
  update: (_id: string, _patch: DownloadPatch) => {},
  remembers: (_id: string) => false
}

export function recordFor(started: StartedDownload): DownloadRecord {
  return {
    id: started.id,
    url: started.url.slice(0, MAX_DOWNLOAD_URL_LENGTH),
    fileName: started.fileName,
    savePath: started.savePath,
    mimeType: started.mimeType,
    totalBytes: Math.max(0, Math.trunc(started.totalBytes)),
    receivedBytes: 0,
    state: 'progressing',
    startedAt: started.startedAt,
    endedAt: null,
    interruptReason: ''
  }
}

/**
 * Adds a download to the front of the list, dropping the oldest past the cap.
 *
 * The front, unconditionally, unlike `recordVisit`'s searched insertion. A download's
 * `startedAt` comes from a single clock read in one process at the moment it began, so the
 * newest really is the newest — where a history entry's timestamp can move backwards when
 * the system clock is corrected.
 */
export function addDownload(
  downloads: readonly DownloadRecord[],
  record: DownloadRecord
): DownloadRecord[] {
  return [record, ...downloads.filter((existing) => existing.id !== record.id)].slice(
    0,
    MAX_DOWNLOAD_RECORDS
  )
}

/**
 * Applies a patch to one record.
 *
 * An id that names nothing yields the list unchanged rather than an error: a `done` event
 * for a download the user has already removed from the list is ordinary, not a fault. The
 * same judgement `noteTitle` makes about a title arriving after its entry was cleared.
 */
export function patchDownload(
  downloads: readonly DownloadRecord[],
  id: string,
  patch: DownloadPatch
): DownloadRecord[] {
  return downloads.map((record) => (record.id === id ? applyPatch(record, patch) : record))
}

function applyPatch(record: DownloadRecord, patch: DownloadPatch): DownloadRecord {
  const state = patch.state ?? record.state
  return {
    ...record,
    state,
    receivedBytes: Math.max(0, Math.trunc(patch.receivedBytes ?? record.receivedBytes)),
    totalBytes: Math.max(0, Math.trunc(patch.totalBytes ?? record.totalBytes)),
    savePath: patch.savePath ?? record.savePath,
    fileName: patch.fileName ?? record.fileName,
    /*
      A terminal state always carries an end time, even when the caller forgot one.

      Without this a download could sit in the list as "completed" with `endedAt: null`, and
      every consumer would then need its own opinion about what to display — which is how one
      view shows a date and another shows nothing for the same row.
    */
    endedAt:
      patch.endedAt !== undefined
        ? patch.endedAt
        : isTerminalDownloadState(state)
          ? (record.endedAt ?? record.startedAt)
          : record.endedAt,
    interruptReason: patch.interruptReason ?? record.interruptReason
  }
}

export function removeDownload(
  downloads: readonly DownloadRecord[],
  id: string
): DownloadRecord[] {
  return downloads.filter((record) => record.id !== id)
}

/**
 * Forgets every *finished* download, leaving anything still running.
 *
 * What "clear the list" has to mean: removing the record of a download in flight would leave
 * a file being written that nothing in the interface admits to, with no way to cancel it.
 */
export function clearFinishedDownloads(
  downloads: readonly DownloadRecord[]
): DownloadRecord[] {
  return downloads.filter((record) => isActiveDownload(record))
}

// --- repair ------------------------------------------------------------------

/**
 * Makes a loaded document obey the invariants the write path maintains.
 *
 * The interesting one, and the reason this function is not merely a sort:
 *
 * **A record loaded as `progressing` or `paused` becomes `interrupted`.** The process that
 * was writing that file is gone — that is what "loaded from disk at startup" means. Leaving
 * the state alone would put a row in the list with a progress bar that never moves and a
 * cancel button wired to a `DownloadItem` that does not exist, for ever. Marking it
 * interrupted is the only honest reading, and it is also what makes the partial `.crdownload`
 * file on disk explicable to the user.
 *
 * The rest is ordinary hygiene: duplicate ids drop, the newest-first order the write path
 * relies on is restored, and the cap is enforced here rather than by the schema — a
 * validation failure discards the whole document, and "more download records than expected"
 * must not cost the user their whole list.
 */
export function repairDownloads(downloads: readonly DownloadRecord[]): DownloadRecord[] {
  const byId = new Map<string, DownloadRecord>()
  for (const record of downloads) {
    if (byId.has(record.id)) continue
    byId.set(record.id, isActiveDownload(record) ? interrupt(record) : record)
  }
  return [...byId.values()]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, MAX_DOWNLOAD_RECORDS)
}

function interrupt(record: DownloadRecord): DownloadRecord {
  return {
    ...record,
    state: 'interrupted',
    endedAt: record.endedAt ?? record.startedAt,
    /*
      An empty reason rather than a made-up one.

      The interface distinguishes "interrupted, and here is what the network said" from
      "interrupted, and nothing knows why" — and a browser that closed mid-download is
      genuinely the second. Inventing a message here would make an unexplained failure look
      like a diagnosed one.
    */
    interruptReason: record.interruptReason
  }
}
