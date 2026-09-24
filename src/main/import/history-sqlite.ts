import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ImportReport } from '@shared/bookmarks/import.js'
import type { ImportRefusal } from '@shared/import/model.js'
import { firefoxBookmarkRowOf, mapFirefoxBookmarks } from '@shared/import/firefox-places.js'
import { chromiumVisitOf, firefoxVisitOf, type ImportedVisit } from '@shared/import/visits.js'

/**
 * Reading another browser's SQLite files — Chrome's `History`, Firefox's `places.sqlite` — without
 * touching them and without a native dependency (U24, KTD19).
 *
 * ## A copy, opened read-only
 *
 * The file is copied with its `-wal` and `-shm` into a fresh directory (`mkdtemp`, so `0700` and a
 * name nobody can guess), opened there with `readOnly`, read, closed, and the directory removed in
 * `finally` — after a success and after a failure alike. The other browser's file is never opened,
 * so nothing here can take a lock it holds or leave one behind; and a running Firefox's last minutes
 * are in its `-wal`, which is why that is copied too. A hot rollback journal is not: a read-only
 * connection could not roll it back, and the main file without it is the state before the write.
 *
 * ## What goes wrong, in words the page can say
 *
 * - `missing` — the file is gone (the browser was uninstalled since the list was drawn).
 * - `locked` — the copy was refused because the browser holds the file open (Windows does that to a
 *   running Chrome's `History`), or SQLite reports it busy. The page asks to close the browser.
 * - `unreadable` — anything else: not a database, damaged, a schema this reader does not know.
 *
 * ## Integers as bigints
 *
 * `readBigInts`, because a Chrome timestamp of today is past `Number.MAX_SAFE_INTEGER` and the driver
 * refuses to hand one out as a number. The epoch helpers take the bigints as they come.
 *
 * `node:sqlite` is Node's own (Electron 43 ships Node 24), kept external by the main build, and loaded
 * on the first import rather than at startup.
 */

/** Most rows read from one history, most recent first. The rest are counted, not read. */
export const MAX_IMPORTED_VISITS = 50_000

/** Most rows read from `moz_bookmarks`; five times the bookmark cap. */
const MAX_BOOKMARK_ROWS = 50_000

export type ReadOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Exclude<ImportRefusal, 'read-only' | 'full'> }

export interface HistoryRead {
  readonly visits: ImportedVisit[]
  /** Rows past `MAX_IMPORTED_VISITS`, which the import counts as left out. */
  readonly unread: number
}

export interface CopyOptions {
  /** Where the temporary copy is made. The system's temporary directory unless a test says. */
  readonly tempRoot?: string
  /** The copy itself; replaced in a test to be refused as a running browser refuses it. */
  readonly copy?: (from: string, to: string) => Promise<void>
  /** `MAX_IMPORTED_VISITS` unless a test says. */
  readonly limit?: number
}

const CHROMIUM_HISTORY = {
  rows: `SELECT url, title, visit_count AS visitCount, last_visit_time AS last,
      (SELECT MIN(visit_time) FROM visits WHERE visits.url = urls.id) AS first
    FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?`,
  total: 'SELECT COUNT(*) AS total FROM urls WHERE hidden = 0'
}

const FIREFOX_HISTORY = {
  rows: `SELECT url, title, visit_count AS visitCount, last_visit_date AS last,
      (SELECT MIN(visit_date) FROM moz_historyvisits WHERE place_id = moz_places.id) AS first
    FROM moz_places WHERE hidden = 0 AND last_visit_date IS NOT NULL
    ORDER BY last_visit_date DESC LIMIT ?`,
  total: 'SELECT COUNT(*) AS total FROM moz_places WHERE hidden = 0 AND last_visit_date IS NOT NULL'
}

const FIREFOX_BOOKMARKS = `SELECT b.id AS id, b.parent AS parent, b.type AS type,
    b.position AS position, b.title AS title, b.dateAdded AS dateAdded, b.guid AS guid, p.url AS url
  FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk LIMIT ?`

/** Chrome's, Edge's or Chromium's `History`. */
export function readChromiumHistory(
  file: string,
  options: CopyOptions = {}
): Promise<ReadOutcome<HistoryRead>> {
  return withCopy(file, options, (db) => history(db, CHROMIUM_HISTORY, chromiumVisitOf, options))
}

/** Firefox's `places.sqlite`, for its history. */
export function readFirefoxHistory(
  file: string,
  options: CopyOptions = {}
): Promise<ReadOutcome<HistoryRead>> {
  return withCopy(file, options, (db) => history(db, FIREFOX_HISTORY, firefoxVisitOf, options))
}

/** Firefox's `places.sqlite`, for its bookmarks; see `firefox-places.ts` for where they go. */
export function readFirefoxBookmarks(
  file: string,
  options: CopyOptions = {}
): Promise<ReadOutcome<ImportReport>> {
  return withCopy(file, options, (db) => {
    const rows = db.prepare(FIREFOX_BOOKMARKS).all(MAX_BOOKMARK_ROWS)
    return mapFirefoxBookmarks(rows.flatMap((row) => firefoxBookmarkRowOf(row) ?? []))
  })
}

function history(
  db: DatabaseSync,
  queries: { rows: string; total: string },
  visitOf: (row: Record<string, unknown>) => ImportedVisit,
  options: CopyOptions
): HistoryRead {
  const limit = options.limit ?? MAX_IMPORTED_VISITS
  const visits = db.prepare(queries.rows).all(limit).map(visitOf)
  // `COUNT(*)` always answers one row.
  const { total } = db.prepare(queries.total).get() as { total: bigint }
  return { visits, unread: Math.max(0, Number(total) - visits.length) }
}

async function withCopy<T>(
  file: string,
  options: CopyOptions,
  read: (db: DatabaseSync) => T
): Promise<ReadOutcome<T>> {
  const copy = options.copy ?? ((from: string, to: string) => copyFile(from, to))
  const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'tessera-import-'))
  try {
    const target = join(dir, 'copy.sqlite')
    await copy(file, target)
    for (const suffix of ['-wal', '-shm']) {
      await copy(file + suffix, target + suffix).catch((error: unknown) => {
        // A database without a write-ahead log has neither file, and that is the usual case.
        if (codeOf(error) !== 'ENOENT') throw error
      })
    }
    // Loaded here, not at startup: nothing else needs it, and a build without it refuses one import.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(target, { readOnly: true, readBigInts: true })
    try {
      return { ok: true, value: read(db) }
    } finally {
      db.close()
    }
  } catch (error) {
    return { ok: false, reason: refusalOf(error) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null
}

/** SQLITE_BUSY and SQLITE_LOCKED, with their extended codes folded in. */
const SQLITE_BUSY_CODES = [5, 6]

/** What a failed read means to the page. The JSON `Bookmarks` file is read with the same answer. */
export function refusalOf(error: unknown): 'missing' | 'locked' | 'unreadable' {
  const code = codeOf(error)
  if (code === 'ENOENT') return 'missing'
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'locked'
  const sqlite = typeof error === 'object' && error !== null ? (error as { errcode?: unknown }) : {}
  if (typeof sqlite.errcode === 'number' && SQLITE_BUSY_CODES.includes(sqlite.errcode & 0xff)) {
    return 'locked'
  }
  return 'unreadable'
}
