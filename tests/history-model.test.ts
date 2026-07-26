import { describe, expect, it } from 'vitest'
import {
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_TITLE_LENGTH,
  MAX_HISTORY_URL_LENGTH,
  discardingHistoryRecorder,
  emptyHistoryDocument,
  historyUrlOf,
  noteTitle,
  queryHistory,
  recordVisit,
  removeDomain,
  removeRange,
  removeVisit,
  repairHistory,
  type HistoryVisit
} from '@shared/history/model.js'

/**
 * The pure history operations.
 *
 * Every timestamp here is supplied, never read from the clock: a test that calls
 * `Date.now()` passes or fails depending on when it runs, and the ordering rules are
 * precisely what would break under that.
 *
 * The edges covered are the ones that decide whether the data survives — a repeat
 * visit that must not become a second entry, a clock that went backwards, a file
 * already past the cap — rather than the happy path a person would describe.
 */

const T0 = 1_700_000_000_000

function visit(overrides: Partial<HistoryVisit> = {}): HistoryVisit {
  return {
    url: 'https://example.com/',
    title: 'Example',
    firstVisitedAt: T0,
    lastVisitedAt: T0,
    visitCount: 1,
    ...overrides
  }
}

/** `count` entries, most recent first, as the write path keeps them. */
function bulk(count: number): HistoryVisit[] {
  return Array.from({ length: count }, (_unused, index) =>
    visit({
      url: `https://example.com/page-${index}`,
      firstVisitedAt: T0 + count - index,
      lastVisitedAt: T0 + count - index
    })
  )
}

describe('emptyHistoryDocument', () => {
  it('starts at version 1 with nothing in it', () => {
    expect(emptyHistoryDocument()).toEqual({ version: 1, visits: [] })
  })
})

describe('historyUrlOf', () => {
  it('keeps an http address, normalised by the URL parser', () => {
    expect(historyUrlOf('https://example.com')).toBe('https://example.com/')
    expect(historyUrlOf('http://example.com/a?b=1')).toBe('http://example.com/a?b=1')
  })

  it('records local files, which are pages a user returns to', () => {
    expect(historyUrlOf('file:///home/me/notes.html')).toBe('file:///home/me/notes.html')
  })

  it('drops the fragment, which names a place inside a page rather than a page', () => {
    expect(historyUrlOf('https://example.com/doc#chapter-2')).toBe('https://example.com/doc')
  })

  it('strips tracking parameters, so two campaign links are one entry', () => {
    expect(historyUrlOf('https://example.com/a?utm_source=news&id=7')).toBe(
      'https://example.com/a?id=7'
    )
  })

  it('refuses the browser own pages', () => {
    // An entry for "History" inside the history is noise, and the menu already gets
    // the user there.
    expect(historyUrlOf('tessera://history')).toBeNull()
    expect(historyUrlOf('tessera://start')).toBeNull()
  })

  it('refuses addresses that are not places', () => {
    expect(historyUrlOf('about:blank')).toBeNull()
    expect(historyUrlOf('data:text/html,<p>hi</p>')).toBeNull()
    expect(historyUrlOf('javascript:alert(1)')).toBeNull()
  })

  it('refuses what it cannot parse', () => {
    expect(historyUrlOf('')).toBeNull()
    expect(historyUrlOf('not a url at all')).toBeNull()
  })

  it('refuses an address too long to be useful', () => {
    // Truncating would store something that no longer resolves, so it is skipped.
    const long = `https://example.com/${'x'.repeat(MAX_HISTORY_URL_LENGTH)}`
    expect(long.length).toBeGreaterThan(MAX_HISTORY_URL_LENGTH)
    expect(historyUrlOf(long)).toBeNull()
    expect(historyUrlOf(`https://example.com/${'x'.repeat(100)}`)).not.toBeNull()
  })
})

describe('recordVisit', () => {
  it('records a first visit with a count of one', () => {
    const visits = recordVisit([], { url: 'https://example.com', title: 'Example' }, { now: T0 })
    expect(visits).toEqual([
      {
        url: 'https://example.com/',
        title: 'Example',
        firstVisitedAt: T0,
        lastVisitedAt: T0,
        visitCount: 1
      }
    ])
  })

  it('accepts a visit with no title yet', () => {
    const visits = recordVisit([], { url: 'https://example.com' }, { now: T0 })
    expect(visits.map((entry) => entry.title)).toEqual([''])
  })

  it('collapses whitespace in a title and cuts it to the limit', () => {
    // Newlines, tabs and the non-breaking space a page put in its own title, which is
    // where whitespace in a title actually comes from.
    const messy = `  News\n\tof the\u00a0day ${'y'.repeat(400)}`
    const visits = recordVisit([], { url: 'https://example.com', title: messy }, { now: T0 })
    const [entry] = visits
    expect(entry?.title.length).toBe(MAX_HISTORY_TITLE_LENGTH)
    expect(entry?.title.startsWith('News of the day y')).toBe(true)
  })

  it('advances the existing entry on a repeat visit instead of adding one', () => {
    const first = recordVisit([], { url: 'https://example.com', title: 'Example' }, { now: T0 })
    const second = recordVisit(
      first,
      { url: 'https://example.com/', title: 'Example' },
      {
        now: T0 + 5_000
      }
    )

    expect(second.length).toBe(1)
    expect(second).toEqual([
      {
        url: 'https://example.com/',
        title: 'Example',
        firstVisitedAt: T0,
        lastVisitedAt: T0 + 5_000,
        visitCount: 2
      }
    ])
  })

  it('treats two campaign links to the same page as the same visit', () => {
    const first = recordVisit([], { url: 'https://example.com/a?utm_source=one' }, { now: T0 })
    const second = recordVisit(
      first,
      { url: 'https://example.com/a?utm_source=two' },
      { now: T0 + 1 }
    )
    expect(second.map((entry) => entry.visitCount)).toEqual([2])
  })

  it('keeps the known title when a repeat visit reports none', () => {
    const first = recordVisit([], { url: 'https://example.com', title: 'Example' }, { now: T0 })
    const second = recordVisit(first, { url: 'https://example.com' }, { now: T0 + 1 })
    expect(second.map((entry) => entry.title)).toEqual(['Example'])
  })

  it('takes a new title when a repeat visit reports one', () => {
    const first = recordVisit([], { url: 'https://example.com', title: 'Old' }, { now: T0 })
    const second = recordVisit(first, { url: 'https://example.com', title: 'New' }, { now: T0 + 1 })
    expect(second.map((entry) => entry.title)).toEqual(['New'])
  })

  it('records nothing for an address history does not keep', () => {
    const existing = [visit()]
    expect(recordVisit(existing, { url: 'about:blank' }, { now: T0 + 1 })).toEqual(existing)
  })

  it('puts the most recent visit first', () => {
    let visits = recordVisit([], { url: 'https://a.example/' }, { now: T0 })
    visits = recordVisit(visits, { url: 'https://b.example/' }, { now: T0 + 10 })
    visits = recordVisit(visits, { url: 'https://c.example/' }, { now: T0 + 20 })
    expect(visits.map((entry) => entry.url)).toEqual([
      'https://c.example/',
      'https://b.example/',
      'https://a.example/'
    ])

    // A revisit is a move to the front, not a duplicate.
    visits = recordVisit(visits, { url: 'https://a.example/' }, { now: T0 + 30 })
    expect(visits.map((entry) => entry.url)).toEqual([
      'https://a.example/',
      'https://c.example/',
      'https://b.example/'
    ])
  })

  it('places a visit correctly when the clock went backwards', () => {
    // An NTP correction or a resumed laptop is enough. Assuming the front would put an
    // older visit at the top and make pruning drop the wrong entry.
    let visits = recordVisit([], { url: 'https://new.example/' }, { now: T0 + 100 })
    visits = recordVisit(visits, { url: 'https://old.example/' }, { now: T0 })
    expect(visits.map((entry) => entry.url)).toEqual([
      'https://new.example/',
      'https://old.example/'
    ])
  })

  it('prunes the least recently visited when the cap is reached', () => {
    const full = bulk(MAX_HISTORY_ENTRIES)
    const oldest = full.at(-1)
    expect(oldest?.url).toBe(`https://example.com/page-${MAX_HISTORY_ENTRIES - 1}`)

    const visits = recordVisit(full, { url: 'https://fresh.example/' }, { now: T0 + 1_000_000 })

    expect(visits.length).toBe(MAX_HISTORY_ENTRIES)
    expect(visits.at(0)?.url).toBe('https://fresh.example/')
    expect(visits.some((entry) => entry.url === oldest?.url)).toBe(false)
  })

  it('does not prune when a repeat visit keeps the count the same', () => {
    const full = bulk(MAX_HISTORY_ENTRIES)
    const revisited = full.at(-1)?.url ?? ''
    const visits = recordVisit(full, { url: revisited }, { now: T0 + 1_000_000 })

    expect(visits.length).toBe(MAX_HISTORY_ENTRIES)
    expect(visits.at(0)?.url).toBe(revisited)
  })
})

describe('noteTitle', () => {
  it('fills in a title that arrived after the visit', () => {
    const visits = noteTitle([visit({ title: '' })], {
      url: 'https://example.com/',
      title: '  Example\nDomain  '
    })
    expect(visits.map((entry) => entry.title)).toEqual(['Example Domain'])
  })

  it('counts no visit and moves no timestamp', () => {
    const before = visit({ title: '', visitCount: 3, lastVisitedAt: T0 + 7 })
    const [after] = noteTitle([before], { url: before.url, title: 'Example' })
    expect(after).toEqual({ ...before, title: 'Example' })
  })

  it('finds the entry through a fragment the caller still has', () => {
    const visits = noteTitle([visit({ title: '' })], {
      url: 'https://example.com/#top',
      title: 'Example'
    })
    expect(visits.map((entry) => entry.title)).toEqual(['Example'])
  })

  it('ignores an empty title rather than erasing the known one', () => {
    const existing = [visit({ title: 'Example' })]
    expect(noteTitle(existing, { url: existing[0]!.url, title: '   ' })).toEqual(existing)
  })

  it('ignores an address that is not in the history', () => {
    const existing = [visit()]
    expect(noteTitle(existing, { url: 'https://other.example/', title: 'Other' })).toEqual(existing)
  })

  it('ignores an address history does not keep', () => {
    const existing = [visit()]
    expect(noteTitle(existing, { url: 'about:blank', title: 'Blank' })).toEqual(existing)
  })
})

describe('queryHistory', () => {
  const visits: HistoryVisit[] = [
    visit({ url: 'https://news.example/world', title: 'World news', lastVisitedAt: T0 + 300 }),
    visit({ url: 'https://docs.example/api', title: 'API reference', lastVisitedAt: T0 + 200 }),
    visit({ url: 'https://shop.example/cart', title: 'Your basket', lastVisitedAt: T0 + 100 })
  ]

  it('returns everything, most recent first, for an empty query', () => {
    expect(queryHistory(visits, {}).map((entry) => entry.url)).toEqual([
      'https://news.example/world',
      'https://docs.example/api',
      'https://shop.example/cart'
    ])
  })

  it('matches a fragment of the address', () => {
    expect(queryHistory(visits, { text: 'docs' }).map((entry) => entry.title)).toEqual([
      'API reference'
    ])
  })

  it('matches a fragment of the title, ignoring case', () => {
    expect(queryHistory(visits, { text: 'BASKET' }).map((entry) => entry.url)).toEqual([
      'https://shop.example/cart'
    ])
  })

  it('finds nothing for a fragment that appears in neither', () => {
    expect(queryHistory(visits, { text: 'zzz' })).toEqual([])
  })

  it('treats blank text as no filter', () => {
    expect(queryHistory(visits, { text: '   ' }).length).toBe(3)
  })

  it('sorts by recency whatever order it was handed', () => {
    // Storage order is normally the truth, but a hand-edited file is not, and the
    // answer must not depend on that.
    const scrambled = [visits[2]!, visits[0]!, visits[1]!]
    expect(queryHistory(scrambled, {}).map((entry) => entry.lastVisitedAt)).toEqual([
      T0 + 300,
      T0 + 200,
      T0 + 100
    ])
  })

  it('bounds a range at both ends, inclusively', () => {
    expect(
      queryHistory(visits, { from: T0 + 100, to: T0 + 200 }).map((entry) => entry.url)
    ).toEqual(['https://docs.example/api', 'https://shop.example/cart'])
  })

  it('takes an open-ended range from one side', () => {
    expect(queryHistory(visits, { from: T0 + 250 }).length).toBe(1)
    expect(queryHistory(visits, { to: T0 + 150 }).length).toBe(1)
  })

  it('caps the result at the limit', () => {
    expect(queryHistory(visits, { limit: 2 }).map((entry) => entry.url)).toEqual([
      'https://news.example/world',
      'https://docs.example/api'
    ])
  })

  it('returns nothing for a limit of zero or less', () => {
    expect(queryHistory(visits, { limit: 0 })).toEqual([])
    expect(queryHistory(visits, { limit: -5 })).toEqual([])
  })

  it('truncates a fractional limit rather than rounding up', () => {
    expect(queryHistory(visits, { limit: 1.9 }).length).toBe(1)
  })

  it('combines text, range and limit', () => {
    // What the address bar will ask for: a fragment, recent only, a handful.
    const result = queryHistory(visits, { text: 'example', from: T0 + 150, limit: 1 })
    expect(result.map((entry) => entry.url)).toEqual(['https://news.example/world'])
  })
})

describe('removeVisit', () => {
  const visits = [visit({ url: 'https://a.example/' }), visit({ url: 'https://b.example/' })]

  it('removes the named entry and nothing else', () => {
    expect(removeVisit(visits, 'https://a.example/').map((entry) => entry.url)).toEqual([
      'https://b.example/'
    ])
  })

  it('accepts the live address of a page, fragment and campaign parameters included', () => {
    expect(removeVisit(visits, 'https://a.example?utm_source=x#top').length).toBe(1)
  })

  it('leaves the list alone for an address it never stored', () => {
    expect(removeVisit(visits, 'https://c.example/')).toEqual(visits)
  })

  it('leaves the list alone for an address it could not have stored', () => {
    expect(removeVisit(visits, 'about:blank')).toEqual(visits)
  })
})

describe('removeDomain', () => {
  const visits = [
    visit({ url: 'https://www.example.com/one' }),
    visit({ url: 'https://blog.example.com/two' }),
    visit({ url: 'https://example.com/three' }),
    visit({ url: 'https://other.org/four' }),
    visit({ url: 'file:///home/me/notes.html' })
  ]

  it('removes every host under the registrable domain', () => {
    // A per-host rule would leave the user believing the site was gone while half of
    // it stayed.
    expect(removeDomain(visits, 'example.com').map((entry) => entry.url)).toEqual([
      'https://other.org/four',
      'file:///home/me/notes.html'
    ])
  })

  it('accepts a full address as well as a bare domain', () => {
    expect(removeDomain(visits, 'https://blog.example.com/two').length).toBe(2)
  })

  it('gets a multi-label public suffix right', () => {
    const uk = [visit({ url: 'https://www.bbc.co.uk/news' }), visit({ url: 'https://evil.co.uk/' })]
    expect(removeDomain(uk, 'bbc.co.uk').map((entry) => entry.url)).toEqual(['https://evil.co.uk/'])
  })

  it('leaves the list alone when there is no domain to match', () => {
    expect(removeDomain(visits, '')).toEqual(visits)
  })
})

describe('removeRange', () => {
  const visits = [
    visit({ url: 'https://c.example/', lastVisitedAt: T0 + 300 }),
    visit({ url: 'https://b.example/', lastVisitedAt: T0 + 200 }),
    visit({ url: 'https://a.example/', lastVisitedAt: T0 + 100 })
  ]

  it('removes what falls inside the window, bounds included', () => {
    expect(removeRange(visits, T0 + 100, T0 + 200).map((entry) => entry.url)).toEqual([
      'https://c.example/'
    ])
  })

  it('keeps what falls outside it', () => {
    expect(removeRange(visits, T0 + 400, T0 + 500)).toEqual(visits)
  })

  it('removes an entry first visited before the window but last visited inside it', () => {
    // Deliberately over-deletes: leaving something behind because it was also visited
    // earlier would defeat the point of clearing a window of history.
    const older = [visit({ firstVisitedAt: T0, lastVisitedAt: T0 + 500, visitCount: 9 })]
    expect(removeRange(older, T0 + 400, T0 + 600)).toEqual([])
  })

  it('clears everything for an unbounded window', () => {
    expect(removeRange(visits, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)).toEqual([])
  })
})

describe('repairHistory', () => {
  it('merges duplicate addresses instead of dropping one', () => {
    const visits = repairHistory([
      visit({
        url: 'https://example.com/',
        title: '',
        firstVisitedAt: T0 + 50,
        lastVisitedAt: T0 + 50,
        visitCount: 2
      }),
      visit({
        url: 'https://example.com/',
        title: 'Example',
        firstVisitedAt: T0,
        lastVisitedAt: T0 + 10,
        visitCount: 3
      })
    ])

    expect(visits).toEqual([
      {
        url: 'https://example.com/',
        // The title survives from whichever copy had one.
        title: 'Example',
        firstVisitedAt: T0,
        lastVisitedAt: T0 + 50,
        visitCount: 5
      }
    ])
  })

  it('keeps the title of the first copy when both have one', () => {
    const visits = repairHistory([
      visit({ url: 'https://example.com/', title: 'Kept' }),
      visit({ url: 'https://example.com/', title: 'Dropped' })
    ])
    expect(visits.map((entry) => entry.title)).toEqual(['Kept'])
  })

  it('puts an out-of-order document back into recency order', () => {
    const visits = repairHistory([
      visit({ url: 'https://a.example/', lastVisitedAt: T0 + 1 }),
      visit({ url: 'https://b.example/', lastVisitedAt: T0 + 9 })
    ])
    expect(visits.map((entry) => entry.url)).toEqual(['https://b.example/', 'https://a.example/'])
  })

  it('trims a document that grew past the cap rather than rejecting it', () => {
    const visits = repairHistory(bulk(MAX_HISTORY_ENTRIES + 5))
    expect(visits.length).toBe(MAX_HISTORY_ENTRIES)
    expect(visits.at(0)?.url).toBe('https://example.com/page-0')
  })

  it('leaves an address it would not record today in place', () => {
    // Narrowing the recordable schemes later must not silently delete what is already
    // stored; that would be data loss dressed up as a cleanup.
    const stored = [visit({ url: 'tessera://start' })]
    expect(repairHistory(stored)).toEqual(stored)
  })

  it('leaves an already correct document as it is', () => {
    const stored = [
      visit({ url: 'https://b.example/', lastVisitedAt: T0 + 9 }),
      visit({ url: 'https://a.example/', lastVisitedAt: T0 + 1 })
    ]
    expect(repairHistory(stored)).toEqual(stored)
  })
})

describe('discardingHistoryRecorder', () => {
  it('accepts both calls and keeps nothing', () => {
    // The recorder a private window is handed. It holds no store, so there is nothing
    // to assert about except that calling it is safe — which is the whole design.
    expect(() => {
      discardingHistoryRecorder.recordVisit({ url: 'https://secret.example/', title: 'Secret' })
      discardingHistoryRecorder.noteTitle({ url: 'https://secret.example/', title: 'Secret' })
    }).not.toThrow()
  })
})
