import { describe, expect, it } from 'vitest'
import {
  chromiumVisitOf,
  firefoxVisitOf,
  planHistoryImport,
  type ImportedVisit
} from '@shared/import/visits.js'
import { MAX_HISTORY_ENTRIES, type HistoryVisit } from '@shared/history/model.js'

/**
 * Taking another browser's history into this one (U24, R39).
 *
 * The cap of ten thousand entries holds for the whole history, and the import only fills the room
 * that is left: it says beforehand how many do not fit, and it never displaces an entry of the own
 * history to make room. Addresses already in the history become one entry with the visit counts
 * summed, and a visit dated after "now" is dropped.
 */

const NOW = Date.UTC(2026, 8, 24, 12)
const MINUTE = 60_000

function own(index: number, url = `https://own.example/${index}`): HistoryVisit {
  const at = NOW - (index + 1) * MINUTE
  return { url, title: `Own ${index}`, firstVisitedAt: at, lastVisitedAt: at, visitCount: 1 }
}

function imported(index: number, overrides: Partial<ImportedVisit> = {}): ImportedVisit {
  const at = NOW - (index + 1) * MINUTE - 30_000
  return {
    url: `https://imported.example/${index}`,
    title: `Imported ${index}`,
    visitCount: 2,
    firstVisitedAt: at - MINUTE,
    lastVisitedAt: at,
    ...overrides
  }
}

describe('planning a history import', () => {
  it('fills only the free room: 9,000 own and 5,000 imported adds 1,000 and keeps all 9,000', () => {
    const mine = Array.from({ length: 9_000 }, (_unused, index) => own(index))
    const theirs = Array.from({ length: 5_000 }, (_unused, index) => imported(index))
    const plan = planHistoryImport(mine, theirs, NOW)
    expect(plan.counts).toEqual({ added: 1_000, merged: 0, dropped: 4_000, skipped: 0 })
    expect(plan.visits).toHaveLength(MAX_HISTORY_ENTRIES)
    const kept = new Set(plan.visits.map((visit) => visit.url))
    for (const visit of mine) expect(kept.has(visit.url)).toBe(true)
    // The most recent of the imported ones are the ones that fit.
    expect(kept.has('https://imported.example/0')).toBe(true)
    expect(kept.has('https://imported.example/999')).toBe(true)
    expect(kept.has('https://imported.example/1000')).toBe(false)
  })

  it('adds nothing to a full history, and says how many were left out', () => {
    const mine = Array.from({ length: MAX_HISTORY_ENTRIES }, (_unused, index) => own(index))
    const plan = planHistoryImport(mine, [imported(0), imported(1)], NOW)
    expect(plan.counts).toEqual({ added: 0, merged: 0, dropped: 2, skipped: 0 })
    expect(plan.visits).toEqual(mine)
  })

  it('merges an address it already has into one entry with the visit counts summed', () => {
    const mine = [{ ...own(5, 'https://same.example/page'), visitCount: 3 }]
    const plan = planHistoryImport(
      mine,
      [
        imported(1, { url: 'https://same.example/page#section', visitCount: 4, title: 'Theirs' }),
        imported(9, { url: 'https://same.example/page?utm_source=x', visitCount: 1 })
      ],
      NOW
    )
    expect(plan.counts).toEqual({ added: 0, merged: 1, dropped: 0, skipped: 0 })
    expect(plan.visits).toHaveLength(1)
    const [entry] = plan.visits
    expect(entry?.visitCount).toBe(8)
    // Its own title wins; the earliest first visit and the latest last visit are kept.
    expect(entry?.title).toBe('Own 5')
    expect(entry?.lastVisitedAt).toBe(imported(1).lastVisitedAt)
    expect(entry?.firstVisitedAt).toBe(imported(9).firstVisitedAt)
  })

  it('merges into the room it does not need: a merge does not count against the cap', () => {
    const mine = Array.from({ length: MAX_HISTORY_ENTRIES }, (_unused, index) => own(index))
    const plan = planHistoryImport(mine, [imported(0, { url: mine[42]!.url })], NOW)
    expect(plan.counts).toEqual({ added: 0, merged: 1, dropped: 0, skipped: 0 })
    expect(plan.visits).toHaveLength(MAX_HISTORY_ENTRIES)
  })

  it('drops a visit dated after now', () => {
    const plan = planHistoryImport(
      [],
      [imported(0), imported(1, { lastVisitedAt: NOW + 1, firstVisitedAt: NOW - 1 })],
      NOW
    )
    expect(plan.counts).toEqual({ added: 1, merged: 0, dropped: 0, skipped: 1 })
    expect(plan.visits.map((visit) => visit.url)).toEqual(['https://imported.example/0'])
  })

  it('skips what the history does not keep, and a visit without a time', () => {
    const plan = planHistoryImport(
      [],
      [
        imported(0, { url: 'chrome://settings/' }),
        imported(1, { url: 'javascript:alert(1)' }),
        imported(2, { url: '' }),
        imported(3, { lastVisitedAt: null })
      ],
      NOW
    )
    expect(plan.counts).toEqual({ added: 0, merged: 0, dropped: 0, skipped: 4 })
    expect(plan.visits).toEqual([])
  })

  it('makes one entry of an address the other browser kept twice', () => {
    const plan = planHistoryImport(
      [],
      [
        imported(3, { url: 'https://twice.example/', title: '', visitCount: 1 }),
        imported(1, { url: 'https://twice.example/#a', title: 'Newer', visitCount: 2 }),
        imported(2, { url: 'https://twice.example/#b', title: 'Older', visitCount: 3 })
      ],
      NOW
    )
    expect(plan.counts.added).toBe(1)
    expect(plan.visits).toEqual([
      {
        url: 'https://twice.example/',
        title: 'Newer',
        visitCount: 6,
        firstVisitedAt: imported(3).firstVisitedAt,
        lastVisitedAt: imported(1).lastVisitedAt
      }
    ])
  })

  it('takes the imported title when its own is still empty, and cleans it', () => {
    const plan = planHistoryImport(
      [{ ...own(0, 'https://untitled.example/'), title: '' }],
      [imported(1, { url: 'https://untitled.example/', title: '  A\n title  ' })],
      NOW
    )
    expect(plan.visits[0]?.title).toBe('A title')
  })

  it('reads a missing first visit as the last, a first after the last as the last', () => {
    const plan = planHistoryImport(
      [],
      [
        imported(0, { firstVisitedAt: null }),
        imported(1, { firstVisitedAt: NOW, lastVisitedAt: NOW - MINUTE })
      ],
      NOW
    )
    for (const visit of plan.visits) expect(visit.firstVisitedAt).toBe(visit.lastVisitedAt)
  })

  it('counts a visit at least once, and whole visits only', () => {
    const plan = planHistoryImport(
      [],
      [
        imported(0, { visitCount: 0 }),
        imported(1, { visitCount: 2.7 }),
        imported(2, { visitCount: Number.NaN })
      ],
      NOW
    )
    expect(plan.visits.map((visit) => visit.visitCount)).toEqual([1, 2, 1])
  })

  it('keeps the list most recent first, merged entries moved to where they now belong', () => {
    const mine = [own(0), own(10, 'https://moves.example/')]
    const plan = planHistoryImport(mine, [imported(0, { url: 'https://moves.example/' })], NOW)
    expect(plan.visits.map((visit) => visit.url)).toEqual([
      'https://own.example/0',
      'https://moves.example/'
    ])
    const later = planHistoryImport(
      mine,
      [{ ...imported(0, { url: 'https://moves.example/' }), lastVisitedAt: NOW }],
      NOW
    )
    expect(later.visits.map((visit) => visit.url)).toEqual([
      'https://moves.example/',
      'https://own.example/0'
    ])
  })
})

describe('rows of the other browsers’ history', () => {
  it('reads a Chrome row: WebKit times, counts as bigints', () => {
    expect(
      chromiumVisitOf({
        url: 'https://c.example/',
        title: 'C',
        visitCount: 3n,
        first: 13345678901234567n,
        last: 13345678901234567n
      })
    ).toEqual({
      url: 'https://c.example/',
      title: 'C',
      visitCount: 3,
      firstVisitedAt: 1_701_205_301_234,
      lastVisitedAt: 1_701_205_301_234
    })
  })

  it('reads a Firefox row: PRTime, and what may be null', () => {
    expect(
      firefoxVisitOf({
        url: 'https://f.example/',
        title: null,
        visitCount: 1n,
        first: null,
        last: 1_726_000_000_000_000n
      })
    ).toEqual({
      url: 'https://f.example/',
      title: '',
      visitCount: 1,
      firstVisitedAt: null,
      lastVisitedAt: 1_726_000_000_000
    })
  })

  it('reads a row of the wrong shape as one the plan skips', () => {
    const visit = firefoxVisitOf({ url: 5, title: 5, visitCount: 'x', last: 'x' })
    expect(visit).toEqual({
      url: '',
      title: '',
      visitCount: 1,
      firstVisitedAt: null,
      lastVisitedAt: null
    })
    expect(planHistoryImport([], [visit], NOW).counts.skipped).toBe(1)
    expect(firefoxVisitOf({ url: 'https://n.example/', visitCount: 4 }).visitCount).toBe(4)
  })
})
