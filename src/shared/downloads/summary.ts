import type { DownloadRecord, DownloadState } from './model.js'

/**
 * What the toolbar's download button says, for one window.
 *
 * Zod-free and Electron-free for the reason `model.ts` gives: the result is computed in the
 * core but its shape is read by the chrome UI, and anything the renderer can reach must not
 * drag a validation library into its bundle. It is also a pure function of its three inputs,
 * so every row of the decision table below is a unit test rather than a walk through the app.
 *
 * ## Why the window's own downloads, not the list
 *
 * The list a window's downloads page shows is the profile's stored history plus whatever is
 * running. The button is not about that history: a window opened this morning must not light
 * up because of a file that failed last week, and a private window must not show progress
 * for a download another window started. So the caller passes the ids of the downloads that
 * were started *in this window*, and only those entries count. What the panel lists is a
 * different question with a different answer (KTD7); this function does not decide it.
 *
 * Those ids are remembered for the window's session, but they only count while the list
 * still holds an entry for them. That is what makes "clearing the list hides the button"
 * true without a second signal: clearing drops the finished records, and a button whose
 * every download has left the list has nothing left to say.
 *
 * ## The one statement the button has room for (KTD6)
 *
 * | In this window                                        | The button shows          |
 * |-------------------------------------------------------|---------------------------|
 * | nothing started, or none of it still in the list      | nothing — it is hidden    |
 * | something running, every size known                   | received over total       |
 * | something running with no declared size               | activity without a share  |
 * | nothing running, an unseen failure                    | failed                    |
 * | nothing running, no unseen failure, an unseen pause   | paused                    |
 * | nothing running, only unseen completions              | completed                 |
 * | nothing running, everything seen or cancelled         | a quiet button, no marker |
 *
 * Progress outranks every outcome because it is the only thing still changing; the outcomes
 * rank by how much they need the user — a failure has to be retried, a pause has to be
 * resumed, a completion merely waits to be opened. A cancellation is never an outcome worth
 * marking: the user did it themselves, and a button that reported it back to them as a
 * problem would be scolding them for using it.
 *
 * "Running" means `progressing`. A paused download is not running — it is the table's own
 * "paused" row — so its bytes stay out of the running total; a ring that counted a stalled
 * file would never reach full while the one that is actually moving finishes.
 *
 * ## What "seen" means
 *
 * Presenting the panel marks every outcome of the window as seen, and the caller records when
 * that happened and passes it as `lastPresentedAt`. An outcome is unseen when it happened
 * after that moment, or when the panel has never been presented in this window. An outcome at
 * the very millisecond of presenting counts as seen: the panel showed the list as it stood.
 *
 * **A pause has no time of its own.** The record keeps `startedAt` and, for a terminal state,
 * `endedAt`; a pause is not terminal, so `endedAt` stays `null` and nothing records when the
 * pause happened. The start stands in for it — the latest moment the record can vouch for.
 * The consequence, stated rather than hidden: a download that began before the panel was last
 * presented and paused only afterwards counts as seen, and the button stays quiet about it. It
 * errs towards silence, which is the direction this browser prefers, and the row on the panel
 * and on the downloads page still says "Paused". Closing the gap needs the time of the last
 * state change on the record, which is a change to the record, not to this function.
 */

/** An outcome worth a mark on the button, heaviest first. Cancelled has none, on purpose. */
export const DOWNLOAD_MARKERS = ['failed', 'paused', 'completed'] as const
export type DownloadMarker = (typeof DOWNLOAD_MARKERS)[number]

/**
 * How far along what is running is.
 *
 * `indeterminate` rather than a fraction of `0` or `null` for the reason `downloadFraction`
 * gives: unknown has to be drawn as activity, and a ring stuck at 0 % is the picture of a
 * stalled download.
 */
export type DownloadActivity = { kind: 'fraction'; fraction: number } | { kind: 'indeterminate' }

export interface DownloadButtonSummary {
  visible: boolean
  /** `null` when nothing in the window is running. */
  activity: DownloadActivity | null
  /** `null` while something runs, and when every outcome has been seen or was a cancellation. */
  marker: DownloadMarker | null
}

const HIDDEN: DownloadButtonSummary = { visible: false, activity: null, marker: null }

/**
 * Summarises the downloads a window started, for its toolbar button.
 *
 * @param entries The list as the core holds it; order does not matter.
 * @param startedHere Ids of the downloads started in this window during its session.
 * @param lastPresentedAt When this window last presented the downloads panel, or `null`.
 */
export function summarizeWindowDownloads(
  entries: readonly DownloadRecord[],
  startedHere: ReadonlySet<string>,
  lastPresentedAt: number | null
): DownloadButtonSummary {
  const mine = entries.filter((entry) => startedHere.has(entry.id))
  if (mine.length === 0) return HIDDEN

  const running = mine.filter((entry) => entry.state === 'progressing')
  if (running.length > 0) return { visible: true, activity: activityOf(running), marker: null }

  const unseen = mine.filter(
    (entry) => lastPresentedAt === null || outcomeTime(entry) > lastPresentedAt
  )
  return { visible: true, activity: null, marker: heaviestMarker(unseen) }
}

/**
 * One fraction over all running downloads, weighted by size.
 *
 * Bytes over bytes rather than the mean of each download's fraction: a finished 10-byte file
 * beside an untouched 90-byte one is a tenth of the way, not half. Each download is clamped to
 * its declared total first — servers do under-declare — so one overrun cannot carry the ring
 * past full or make the others look further along than they are.
 */
function activityOf(running: readonly DownloadRecord[]): DownloadActivity {
  if (running.some((entry) => entry.totalBytes <= 0)) return { kind: 'indeterminate' }
  let received = 0
  let total = 0
  for (const entry of running) {
    received += Math.min(entry.receivedBytes, entry.totalBytes)
    total += entry.totalBytes
  }
  return { kind: 'fraction', fraction: received / total }
}

/** When the entry reached the state it is in, as near as the record can say. */
function outcomeTime(entry: DownloadRecord): number {
  return entry.endedAt ?? entry.startedAt
}

/**
 * The mark each state earns once it is unseen. A record rather than a `switch`, so a state
 * added to `DOWNLOAD_STATES` fails the build here until somebody decides what it shows.
 */
const MARKER_OF: Readonly<Record<DownloadState, DownloadMarker | null>> = {
  interrupted: 'failed',
  paused: 'paused',
  completed: 'completed',
  cancelled: null,
  // Unreachable from `summarizeWindowDownloads`, which answers with progress first.
  progressing: null
}

function heaviestMarker(unseen: readonly DownloadRecord[]): DownloadMarker | null {
  const present = new Set(unseen.map((entry) => MARKER_OF[entry.state]))
  return DOWNLOAD_MARKERS.find((marker) => present.has(marker)) ?? null
}
