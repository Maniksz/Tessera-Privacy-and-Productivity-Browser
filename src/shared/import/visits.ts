import {
  MAX_HISTORY_ENTRIES,
  cleanHistoryTitle,
  historyUrlOf,
  type HistoryVisit
} from '../history/model.js'
import { chromeTimeToMs, firefoxTimeToMs } from './epochs.js'
import type { HistoryImportCounts } from './model.js'

/**
 * Another browser's history, taken into this one (U24, R39).
 *
 * ## The cap holds for the whole history
 *
 * `MAX_HISTORY_ENTRIES` bounds the file, and an import is no reason to lift it. So the import fills
 * only the room that is left, most recent first, and what does not fit is counted and told *before*
 * anything is written — the same plan answers the preview and the import. It never displaces an entry
 * of the own history: pruning the least recent entries, as a new visit does, would let a
 * five-thousand-row import silently erase a year of this browser's history.
 *
 * ## One entry per address, as everywhere else
 *
 * Addresses go through `historyUrlOf`, so the fragment and tracking parameters are gone and an
 * address the history does not keep (`chrome://`, `about:`, `javascript:`) is skipped. Rows that end
 * up at one address — in the other browser's history, or in this one's — become one entry: the visit
 * counts summed, the earliest first visit, the latest last visit, the own title unless it is empty. A
 * merge takes no room, so it happens even when the history is full.
 *
 * A visit dated after "now" is skipped. It is a clock that was wrong in the other browser, and taken
 * as it stands it would stay at the top of this history until the day it names.
 */

/** One row of the other browser's history, in this browser's milliseconds. */
export interface ImportedVisit {
  readonly url: string
  readonly title: string
  readonly visitCount: number
  /** The earliest visit the other browser still knows of; `null` when it keeps none. */
  readonly firstVisitedAt: number | null
  readonly lastVisitedAt: number | null
}

export interface HistoryImportPlan {
  /** The whole history after the import, most recent first. */
  readonly visits: HistoryVisit[]
  readonly counts: HistoryImportCounts
}

function countOf(value: unknown): number {
  const count = typeof value === 'bigint' ? Number(value) : value
  return typeof count === 'number' && Number.isFinite(count) ? Math.max(1, Math.trunc(count)) : 1
}

function visitOf(
  raw: Readonly<Record<string, unknown>>,
  toMs: (value: unknown) => number | null
): ImportedVisit {
  return {
    url: typeof raw['url'] === 'string' ? raw['url'] : '',
    title: typeof raw['title'] === 'string' ? raw['title'] : '',
    visitCount: countOf(raw['visitCount']),
    firstVisitedAt: toMs(raw['first']),
    lastVisitedAt: toMs(raw['last'])
  }
}

/** A row of Chrome's, Edge's or Chromium's `urls`: WebKit microseconds. */
export function chromiumVisitOf(raw: Readonly<Record<string, unknown>>): ImportedVisit {
  return visitOf(raw, chromeTimeToMs)
}

/** A row of Firefox's `moz_places`: PRTime. */
export function firefoxVisitOf(raw: Readonly<Record<string, unknown>>): ImportedVisit {
  return visitOf(raw, firefoxTimeToMs)
}

function byRecency(left: HistoryVisit, right: HistoryVisit): number {
  return right.lastVisitedAt - left.lastVisitedAt
}

/**
 * The history after an import, and what the import does.
 *
 * `own` is the store's list, which `repairHistory` keeps at one entry per address and under the cap.
 */
export function planHistoryImport(
  own: readonly HistoryVisit[],
  imported: readonly ImportedVisit[],
  now: number
): HistoryImportPlan {
  let skipped = 0
  /** The imported rows by address, merged; the title of the most recent row that had one. */
  const theirs = new Map<string, HistoryVisit>()
  for (const visit of imported) {
    const url = historyUrlOf(visit.url)
    const last = visit.lastVisitedAt
    if (url === null || last === null || last > now) {
      skipped += 1
      continue
    }
    const first = Math.min(visit.firstVisitedAt ?? last, last)
    const entry: HistoryVisit = {
      url,
      title: cleanHistoryTitle(visit.title),
      firstVisitedAt: first,
      lastVisitedAt: last,
      visitCount: countOf(visit.visitCount)
    }
    const known = theirs.get(url)
    if (known === undefined) theirs.set(url, entry)
    else if (entry.lastVisitedAt > known.lastVisitedAt) theirs.set(url, merged(entry, known))
    else theirs.set(url, merged(known, entry))
  }

  let merges = 0
  const next = own.map((visit) => {
    const match = theirs.get(visit.url)
    if (match === undefined) return visit
    theirs.delete(visit.url)
    merges += 1
    return merged(visit, match)
  })

  const candidates = [...theirs.values()].sort(byRecency)
  const room = Math.max(0, MAX_HISTORY_ENTRIES - own.length)
  const added = candidates.slice(0, room)
  return {
    visits: [...next, ...added].sort(byRecency),
    counts: {
      added: added.length,
      merged: merges,
      dropped: candidates.length - added.length,
      skipped
    }
  }
}

/**
 * Two entries for one address as one. `kept`'s title wins unless it is empty, which is the own entry
 * against an imported one, and the more recent row against an older one of the same import.
 */
function merged(kept: HistoryVisit, other: HistoryVisit): HistoryVisit {
  return {
    url: kept.url,
    title: kept.title !== '' ? kept.title : other.title,
    firstVisitedAt: Math.min(kept.firstVisitedAt, other.firstVisitedAt),
    lastVisitedAt: Math.max(kept.lastVisitedAt, other.lastVisitedAt),
    visitCount: kept.visitCount + other.visitCount
  }
}
