import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readChromiumHistory,
  readFirefoxBookmarks,
  readFirefoxHistory
} from '@main/import/history-sqlite.js'
import { HistoryStore } from '@main/data/HistoryStore.js'
import { ReadOnlyStoreError } from '@main/data/JsonStore.js'
import type { HistoryVisit } from '@shared/history/model.js'

/**
 * Another browser's history, read from a real SQLite file built here with `node:sqlite` (U24, KTD19).
 *
 * Each read copies the file with its `-wal` and `-shm` into a fresh temporary directory, opens the copy
 * read-only and removes the directory again — after a failure as after a success, which is asserted
 * on the directory the copies go to. The import into the history store is driven through the store,
 * so the cap, the merge and the future-dated visit are what the file on disk ends up holding.
 */

const NOW = Date.UTC(2026, 8, 24, 12)
const MINUTE = 60_000
const WEBKIT_OFFSET = 11_644_473_600_000_000n

const webkit = (ms: number): bigint => BigInt(ms) * 1000n + WEBKIT_OFFSET
const prtime = (ms: number): bigint => BigInt(ms) * 1000n

let dir: string
let temp: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tessera-import-test-'))
  temp = mkdtempSync(join(tmpdir(), 'tessera-import-temp-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(temp, { recursive: true, force: true })
})

function chromeHistory(
  rows: Array<{ url: string; title?: string; count?: number; visits: number[]; hidden?: 1 }>
): string {
  const file = join(dir, 'History')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER,
    last_visit_time INTEGER, hidden INTEGER DEFAULT 0);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);`)
  const url = db.prepare(
    'INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)'
  )
  const visit = db.prepare('INSERT INTO visits (url, visit_time) VALUES (?, ?)')
  for (const row of rows) {
    const { lastInsertRowid } = url.run(
      row.url,
      row.title ?? '',
      row.count ?? row.visits.length,
      webkit(Math.max(...row.visits)),
      row.hidden ?? 0
    )
    for (const at of row.visits) visit.run(lastInsertRowid, webkit(at))
  }
  db.close()
  return file
}

/** A `places.sqlite` in WAL mode. Left open when asked, as a running Firefox leaves it. */
function firefoxPlaces(
  places: Array<{
    url: string
    title?: string
    count?: number
    last: number | null
    first?: number
  }>,
  options: { keepOpen?: boolean } = {}
): { file: string; db: DatabaseSync } {
  const file = join(dir, 'places.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER,
      hidden INTEGER DEFAULT 0, last_visit_date INTEGER);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER,
      position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT);`)
  const place = db.prepare(
    'INSERT INTO moz_places (url, title, visit_count, last_visit_date) VALUES (?, ?, ?, ?)'
  )
  const visit = db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date) VALUES (?, ?)')
  db.exec('BEGIN')
  for (const row of places) {
    const last = row.last === null ? null : prtime(row.last)
    const { lastInsertRowid } = place.run(row.url, row.title ?? null, row.count ?? 1, last)
    if (row.first !== undefined) visit.run(lastInsertRowid, prtime(row.first))
    if (row.last !== null) visit.run(lastInsertRowid, prtime(row.last))
  }
  db.exec('COMMIT')
  if (!options.keepOpen) db.close()
  return { file, db }
}

function ownHistory(visits: HistoryVisit[], version = 1): string {
  const file = join(dir, 'history.json')
  writeFileSync(file, JSON.stringify({ version, visits }))
  return file
}

function own(index: number, url = `https://own.example/${index}`, visitCount = 1): HistoryVisit {
  const at = NOW - (index + 1) * MINUTE
  return { url, title: `Own ${index}`, firstVisitedAt: at, lastVisitedAt: at, visitCount }
}

function leftInTemp(): string[] {
  return readdirSync(temp)
}

describe('reading a Chrome history', () => {
  it('reads each address with Chrome’s times, its first visit and its count, the hidden left out', async () => {
    const file = chromeHistory([
      { url: 'https://a.example/', title: 'A', visits: [NOW - 3 * MINUTE, NOW - MINUTE] },
      { url: 'https://hidden.example/', visits: [NOW], hidden: 1 }
    ])
    const read = await readChromiumHistory(file, { tempRoot: temp })
    expect(read).toEqual({
      ok: true,
      value: {
        visits: [
          {
            url: 'https://a.example/',
            title: 'A',
            visitCount: 2,
            firstVisitedAt: NOW - 3 * MINUTE,
            lastVisitedAt: NOW - MINUTE
          }
        ],
        unread: 0
      }
    })
    expect(leftInTemp()).toEqual([])
  })

  it('reads the most recent rows up to the limit and counts the rest as unread', async () => {
    const file = chromeHistory(
      [1, 2, 3].map((index) => ({
        url: `https://n.example/${index}`,
        visits: [NOW - index * MINUTE]
      }))
    )
    const read = await readChromiumHistory(file, { tempRoot: temp, limit: 2 })
    expect(read.ok && read.value.visits.map((visit) => visit.url)).toEqual([
      'https://n.example/1',
      'https://n.example/2'
    ])
    expect(read.ok && read.value.unread).toBe(1)
  })
})

describe('reading a Firefox profile', () => {
  it('reads what is still in the write-ahead log of a Firefox that is running', async () => {
    const { file, db } = firefoxPlaces(
      [
        {
          url: 'https://f.example/',
          title: 'F',
          count: 3,
          last: NOW - MINUTE,
          first: NOW - 9 * MINUTE
        }
      ],
      { keepOpen: true }
    )
    try {
      const read = await readFirefoxHistory(file, { tempRoot: temp })
      expect(read).toEqual({
        ok: true,
        value: {
          visits: [
            {
              url: 'https://f.example/',
              title: 'F',
              visitCount: 3,
              firstVisitedAt: NOW - 9 * MINUTE,
              lastVisitedAt: NOW - MINUTE
            }
          ],
          unread: 0
        }
      })
    } finally {
      db.close()
    }
    expect(leftInTemp()).toEqual([])
  })

  it('reads the bookmarks from the same file', async () => {
    const { file, db } = firefoxPlaces([{ url: 'https://bm.example/', last: null }], {
      keepOpen: true
    })
    db.exec(`INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES
      (1, 2, NULL, 0, 0, '', 0, 'root________'),
      (2, 2, NULL, 1, 0, 'unfiled', 0, 'unfiled_____'),
      (3, 1, 1, 2, 0, 'Bookmarked', 1726000000000000, 'x'),
      (4, 1, NULL, 2, 1, 'No place', 0, 'y'),
      (5, 1, 1, 'nope', 2, 'Bad row', 0, 'z')`)
    db.close()
    const read = await readFirefoxBookmarks(file, { tempRoot: temp })
    expect(read).toEqual({
      ok: true,
      value: {
        nodes: [
          {
            kind: 'bookmark',
            title: 'Bookmarked',
            url: 'https://bm.example/',
            addedAt: 1_726_000_000_000,
            children: [],
            onToolbar: false
          }
        ],
        skipped: 1
      }
    })
    expect(leftInTemp()).toEqual([])
  })

  it('skips a place Firefox never visited', async () => {
    const { file } = firefoxPlaces([{ url: 'https://never.example/', last: null }])
    const read = await readFirefoxHistory(file)
    expect(read).toEqual({ ok: true, value: { visits: [], unread: 0 } })
  })
})

describe('what goes wrong, and that the copy goes in every case', () => {
  it('answers missing for a file that is gone', async () => {
    expect(await readFirefoxHistory(join(dir, 'gone.sqlite'), { tempRoot: temp })).toEqual({
      ok: false,
      reason: 'missing'
    })
    expect(leftInTemp()).toEqual([])
  })

  it('answers unreadable for a file that is not a database, or not the one expected', async () => {
    const junk = join(dir, 'junk.sqlite')
    writeFileSync(junk, 'not a database at all, and long enough to be read as a header')
    expect(await readChromiumHistory(junk, { tempRoot: temp })).toEqual({
      ok: false,
      reason: 'unreadable'
    })
    // A Firefox file handed to the Chrome reader: a database, but without `urls`.
    const { file } = firefoxPlaces([])
    expect(await readChromiumHistory(file, { tempRoot: temp })).toEqual({
      ok: false,
      reason: 'unreadable'
    })
    expect(leftInTemp()).toEqual([])
  })

  it('answers locked when the browser holds the file, so the page can ask to close it', async () => {
    const file = chromeHistory([{ url: 'https://a.example/', visits: [NOW] }])
    for (const refusal of [
      Object.assign(new Error('busy'), { code: 'EBUSY' }),
      Object.assign(new Error('perm'), { code: 'EPERM' }),
      Object.assign(new Error('access'), { code: 'EACCES' }),
      Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }),
      Object.assign(new Error('busy recovery'), { code: 'ERR_SQLITE_ERROR', errcode: 261 }),
      Object.assign(new Error('table locked'), { code: 'ERR_SQLITE_ERROR', errcode: 6 })
    ]) {
      const read = await readChromiumHistory(file, {
        tempRoot: temp,
        copy: () => Promise.reject(refusal)
      })
      expect(read, refusal.message).toEqual({ ok: false, reason: 'locked' })
    }
    expect(leftInTemp()).toEqual([])
  })

  it('answers locked when only the write-ahead log is held, and unreadable for anything odd', async () => {
    const file = chromeHistory([{ url: 'https://a.example/', visits: [NOW] }])
    const walHeld = (from: string, to: string): Promise<void> =>
      from.endsWith('-wal')
        ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
        : copyFile(from, to)
    expect(await readChromiumHistory(file, { tempRoot: temp, copy: walHeld })).toEqual({
      ok: false,
      reason: 'locked'
    })
    for (const odd of ['a string', null, Object.assign(new Error('x'), { errcode: 'x' })]) {
      const read = await readChromiumHistory(file, {
        tempRoot: temp,
        // Not an Error on purpose: what a copy throws is whatever the file system throws.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        copy: () => Promise.reject(odd)
      })
      expect(read).toEqual({ ok: false, reason: 'unreadable' })
    }
    expect(leftInTemp()).toEqual([])
  })
})

describe('importing into the history store', () => {
  it('adds 1,000 of 5,000 to a history of 9,000 once confirmed, and keeps all 9,000', async () => {
    const mine = Array.from({ length: 9_000 }, (_unused, index) => own(index))
    const history = await HistoryStore.open({ filePath: ownHistory(mine), now: () => NOW })
    const { file } = firefoxPlaces(
      Array.from({ length: 5_000 }, (_unused, index) => ({
        url: `https://imported.example/${index}`,
        last: NOW - index * MINUTE - 30_000
      }))
    )
    const read = await readFirefoxHistory(file, { tempRoot: temp })
    if (!read.ok) throw new Error(read.reason)

    // Told before: 1,000 fit, 4,000 do not. Nothing is written by asking.
    expect(history.previewImport(read.value.visits)).toEqual({
      added: 1_000,
      merged: 0,
      dropped: 4_000,
      skipped: 0
    })
    expect(history.query()).toHaveLength(9_000)

    expect(history.importVisits(read.value.visits)).toEqual({
      added: 1_000,
      merged: 0,
      dropped: 4_000,
      skipped: 0
    })
    const after = history.query()
    expect(after).toHaveLength(10_000)
    const urls = new Set(after.map((visit) => visit.url))
    expect(mine.every((visit) => urls.has(visit.url))).toBe(true)
  })

  it('drops a visit after now, and makes one entry of the same address with the counts summed', async () => {
    const history = await HistoryStore.open({
      filePath: ownHistory([own(0, 'https://same.example/', 2)]),
      now: () => NOW
    })
    const { file } = firefoxPlaces([
      { url: 'https://same.example/', count: 3, last: NOW - 5 * MINUTE },
      { url: 'https://future.example/', last: NOW + 60 * MINUTE }
    ])
    const read = await readFirefoxHistory(file, { tempRoot: temp })
    if (!read.ok) throw new Error(read.reason)
    expect(history.importVisits(read.value.visits)).toEqual({
      added: 0,
      merged: 1,
      dropped: 0,
      skipped: 1
    })
    expect(history.query()).toEqual([
      {
        url: 'https://same.example/',
        title: 'Own 0',
        firstVisitedAt: NOW - 5 * MINUTE,
        lastVisitedAt: NOW - MINUTE,
        visitCount: 5
      }
    ])
  })

  it('refuses an import into a history that is read-only in this run', async () => {
    // A newer version's file: the store keeps it untouched and writes nothing in this run.
    const history = await HistoryStore.open({
      filePath: ownHistory([own(0)], 2),
      now: () => NOW
    })
    expect(history.readOnly).toBe(true)
    expect(() =>
      history.importVisits([
        {
          url: 'https://x.example/',
          title: '',
          visitCount: 1,
          firstVisitedAt: NOW,
          lastVisitedAt: NOW
        }
      ])
    ).toThrow(ReadOnlyStoreError)
  })

  it('refuses one after the history was sealed for clearing on exit', async () => {
    const history = await HistoryStore.open({ filePath: ownHistory([]), now: () => NOW })
    expect(history.readOnly).toBe(false)
    history.seal()
    expect(history.readOnly).toBe(true)
    expect(() => history.importVisits([])).toThrow(ReadOnlyStoreError)
  })
})
