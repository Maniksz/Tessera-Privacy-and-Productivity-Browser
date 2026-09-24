import { describe, expect, it } from 'vitest'
import {
  MAX_ARRANGEMENTS,
  MIN_ARRANGED_TILES,
  arrangementIsCurrent,
  arrangementIsProtected,
  arrangementOfTab,
  cloneArrangements,
  emptyArrangementDocument,
  forgetArrangement,
  recordArrangement,
  repairArrangements,
  retainTabs,
  seatedTabs,
  type Arrangement,
  type ArrangementDocument,
  type ArrangementDraft,
  type WindowTabs
} from '@shared/arrangements/model.js'
import { arrangementDocumentSchema, arrangementSchema } from '@shared/arrangements/schema.js'

/**
 * The arrangement rules.
 *
 * Every function under test is pure, so these tests need neither a window nor a clock:
 * ids and timestamps are handed in, and the two facts an arrangement cannot know about
 * itself — which tabs the calling window owns and which of them the strip is currently
 * hiding — arrive as sets on every call. That is the whole point of the module, and it
 * is what makes the three protections it owes the plan testable at all:
 *
 *   - R14, a recording with a hidden tab is not offered to a click;
 *   - R15, a recording with a hidden tab is not evicted to make room;
 *   - R16, a recording whose tabs belong to another window is neither.
 */

const T0 = 1_700_000_000_000

/** A `2x2` recording, which is the shape most of these cases need. */
function arrangement(
  id: string,
  seats: Array<string | null>,
  overrides: Partial<Arrangement> = {}
): Arrangement {
  return { id, layoutId: '2x2', seats, recordedAt: T0, ...overrides }
}

function draft(
  id: string,
  seats: Array<string | null>,
  overrides: Partial<ArrangementDraft> = {}
): ArrangementDraft {
  return { id, layoutId: '2x2', seats, recordedAt: T0 + 1, ...overrides }
}

/** The calling window, as `recordArrangement` and `arrangementOfTab` see it. */
function windowWith(liveTabIds: string[], hiddenTabIds: string[] = []): WindowTabs {
  return { liveTabIds, hiddenTabIds }
}

describe('the empty document', () => {
  it('starts at version 1 with nothing recorded', () => {
    expect(emptyArrangementDocument()).toEqual({ version: 1, arrangements: [] })
  })
})

describe('reading seats', () => {
  it('names the seated tabs in tile order and skips the empty tiles', () => {
    expect(seatedTabs(['a', null, 'b', null])).toEqual(['a', 'b'])
  })
})

describe('recordArrangement: what is worth recording', () => {
  it('refuses an arrangement seating fewer than MIN_ARRANGED_TILES tabs', () => {
    expect(MIN_ARRANGED_TILES).toBe(2)
    const next = recordArrangement([], draft('r1', ['a', null, null, null]), windowWith(['a']))
    expect(next).toEqual([])
  })

  it('refuses seats that do not fill exactly the tiles of their layout', () => {
    const next = recordArrangement(
      [],
      draft('r1', ['a', 'b'], { layoutId: '2x2' }),
      windowWith(['a', 'b'])
    )
    expect(next).toEqual([])
  })

  it('refuses the same tab in two tiles', () => {
    const next = recordArrangement([], draft('r1', ['a', 'a', null, null]), windowWith(['a']))
    expect(next).toEqual([])
  })

  it('refuses a draft seating a tab the calling window does not own', () => {
    const next = recordArrangement([], draft('r1', ['a', 'b', null, null]), windowWith(['a']))
    expect(next).toEqual([])
  })

  it('records an arrangement the window owns in full', () => {
    const next = recordArrangement(
      [],
      draft('r1', ['a', 'b', null, null]),
      windowWith(['a', 'b', 'c'])
    )
    expect(next).toEqual([
      { id: 'r1', layoutId: '2x2', seats: ['a', 'b', null, null], recordedAt: T0 + 1 }
    ])
  })

  it('hands back seats no caller still holds', () => {
    const seats: Array<string | null> = ['a', 'b', null, null]
    const [recorded] = recordArrangement([], draft('r1', seats), windowWith(['a', 'b']))
    seats[0] = 'stolen'
    expect(recorded?.seats).toEqual(['a', 'b', null, null])
  })
})

describe('recordArrangement: superseding', () => {
  const previous = arrangement('r1', ['a', 'b', null, null])

  it('replaces an overlapping recording none of whose tabs is hidden', () => {
    const next = recordArrangement(
      [previous],
      draft('r2', ['a', 'c', null, null]),
      windowWith(['a', 'b', 'c'])
    )
    expect(next.map((entry) => entry.id)).toEqual(['r2'])
  })

  it('leaves an overlapping recording alone as soon as one of its tabs is hidden', () => {
    const next = recordArrangement(
      [previous],
      draft('r2', ['a', 'c', null, null]),
      windowWith(['a', 'b', 'c'], ['b'])
    )
    expect(next.map((entry) => entry.id)).toEqual(['r1', 'r2'])
  })

  it('leaves a recording that shares no tab alone', () => {
    const next = recordArrangement(
      [previous],
      draft('r2', ['c', 'd', null, null]),
      windowWith(['a', 'b', 'c', 'd'])
    )
    expect(next.map((entry) => entry.id)).toEqual(['r1', 'r2'])
  })
})

describe('recordArrangement: the cap', () => {
  /** `count` recordings, each over two tabs of its own, oldest first. */
  function filledStore(count: number): Arrangement[] {
    return Array.from({ length: count }, (_, index) =>
      arrangement(`r${index}`, [`t${index}a`, `t${index}b`, null, null], { recordedAt: T0 + index })
    )
  }

  function everyTabOf(arrangements: readonly Arrangement[]): string[] {
    return arrangements.flatMap((entry) => seatedTabs(entry.seats))
  }

  it('evicts the oldest evictable recording when the store is full', () => {
    const store = filledStore(MAX_ARRANGEMENTS)
    const next = recordArrangement(
      store,
      draft('fresh', ['x', 'y', null, null]),
      windowWith([...everyTabOf(store), 'x', 'y'])
    )
    expect(next).toHaveLength(MAX_ARRANGEMENTS)
    expect(next.map((entry) => entry.id)).not.toContain('r0')
    expect(next.map((entry) => entry.id)).toContain('fresh')
  })

  it('evicts down to the cap when a loaded store somehow sits above it', () => {
    const store = filledStore(MAX_ARRANGEMENTS + 2)
    const next = recordArrangement(
      store,
      draft('fresh', ['x', 'y', null, null]),
      windowWith([...everyTabOf(store), 'x', 'y'])
    )
    expect(next).toHaveLength(MAX_ARRANGEMENTS)
    expect(next.map((entry) => entry.id)).toEqual(expect.not.arrayContaining(['r0', 'r1', 'r2']))
  })

  it('records nothing rather than sacrificing a protected recording', () => {
    const store = filledStore(MAX_ARRANGEMENTS)
    const hidden = store.map((entry) => `${entry.id.replace('r', 't')}a`)
    const next = recordArrangement(
      store,
      draft('fresh', ['x', 'y', null, null]),
      windowWith([...everyTabOf(store), 'x', 'y'], hidden)
    )
    expect(next.map((entry) => entry.id)).toEqual(store.map((entry) => entry.id))
  })
})

describe('R16: an arrangement acts only in its own window', () => {
  const foreign = arrangement('other-window', ['p', 'q', null, null])

  it('evicts nothing whose tabs lie outside the calling window', () => {
    const store = [
      foreign,
      ...Array.from({ length: MAX_ARRANGEMENTS - 1 }, (_, index) =>
        arrangement(`r${index}`, [`t${index}a`, `t${index}b`, null, null], {
          recordedAt: T0 + 1 + index
        })
      )
    ]
    const live = store.slice(1).flatMap((entry) => seatedTabs(entry.seats))
    const next = recordArrangement(
      store,
      draft('fresh', ['x', 'y', null, null]),
      windowWith([...live, 'x', 'y'])
    )
    expect(next.map((entry) => entry.id)).toContain('other-window')
    expect(next.map((entry) => entry.id)).not.toContain('r0')
  })

  it('does not offer a foreign recording to a click', () => {
    expect(arrangementOfTab([foreign], 'p', windowWith(['a', 'b']))).toBeUndefined()
  })

  it('does not supersede a foreign recording that shares a tab id', () => {
    const next = recordArrangement(
      [foreign],
      draft('fresh', ['p', 'x', null, null]),
      windowWith(['p', 'x'])
    )
    expect(next.map((entry) => entry.id)).toEqual(['other-window', 'fresh'])
  })
})

describe('arrangementOfTab', () => {
  const store = [
    arrangement('r1', ['a', 'b', null, null]),
    arrangement('r2', ['c', 'd', null, null])
  ]

  it('finds the recording that seats the tab', () => {
    expect(arrangementOfTab(store, 'd', windowWith(['a', 'b', 'c', 'd']))?.id).toBe('r2')
  })

  it('answers nothing for a tab no recording seats', () => {
    expect(arrangementOfTab(store, 'z', windowWith(['a', 'b', 'c', 'd', 'z']))).toBeUndefined()
  })

  it('answers nothing while one of the recording tabs is hidden (R14)', () => {
    expect(arrangementOfTab(store, 'a', windowWith(['a', 'b', 'c', 'd'], ['b']))).toBeUndefined()
  })
})

describe('arrangementIsProtected', () => {
  it('is true while any seated tab is hidden and false once none is', () => {
    const entry = arrangement('r1', ['a', 'b', null, null])
    expect(arrangementIsProtected(entry, ['b'])).toBe(true)
    expect(arrangementIsProtected(entry, ['z'])).toBe(false)
  })
})

describe('arrangementIsCurrent', () => {
  const entry = arrangement('r1', ['a', 'b', null, null])

  it('is true for the same layout and the same seating', () => {
    expect(arrangementIsCurrent(entry, '2x2', ['a', 'b', null, null])).toBe(true)
  })

  it('is false for a different layout', () => {
    expect(arrangementIsCurrent(entry, '1x4', ['a', 'b', null, null])).toBe(false)
  })

  it('is false when the same tabs sit in swapped tiles', () => {
    expect(arrangementIsCurrent(entry, '2x2', ['b', 'a', null, null])).toBe(false)
  })

  it('is false when a seated tab is missing from the window', () => {
    expect(arrangementIsCurrent(entry, '2x2', ['a', null, null, null])).toBe(false)
  })

  it('is false when the seating has a different number of tiles', () => {
    expect(arrangementIsCurrent(entry, '2x2', ['a', 'b', null, null, null])).toBe(false)
  })
})

describe('forgetArrangement', () => {
  it('drops the named recording and leaves the rest', () => {
    const store = [
      arrangement('r1', ['a', 'b', null, null]),
      arrangement('r2', ['c', 'd', null, null])
    ]
    expect(forgetArrangement(store, 'r1').map((entry) => entry.id)).toEqual(['r2'])
  })

  it('is a no-op for an id nothing holds', () => {
    const store = [arrangement('r1', ['a', 'b', null, null])]
    expect(forgetArrangement(store, 'nope').map((entry) => entry.id)).toEqual(['r1'])
  })
})

describe('retainTabs', () => {
  it('empties the tiles of tabs that did not come back', () => {
    const store = [arrangement('r1', ['a', 'b', 'c', null])]
    expect(retainTabs(store, ['a', 'c'])).toEqual([
      { id: 'r1', layoutId: '2x2', seats: ['a', null, 'c', null], recordedAt: T0 }
    ])
  })

  it('discards a recording that falls below MIN_ARRANGED_TILES', () => {
    const store = [arrangement('r1', ['a', 'b', null, null])]
    expect(retainTabs(store, ['a'])).toEqual([])
  })
})

describe('repairArrangements', () => {
  it('keeps a document that already obeys the rules', () => {
    const store = [arrangement('r1', ['a', 'b', null, null])]
    expect(repairArrangements(store)).toEqual(store)
  })

  it('drops a seating whose length is not the tile count of its layout', () => {
    expect(repairArrangements([arrangement('r1', ['a', 'b', null])])).toEqual([])
  })

  it('drops a recording seating one tab in two tiles', () => {
    expect(repairArrangements([arrangement('r1', ['a', 'a', 'b', null])])).toEqual([])
  })

  it('drops a recording with too few seated tabs', () => {
    expect(repairArrangements([arrangement('r1', ['a', null, null, null])])).toEqual([])
  })

  it('drops the later of two recordings claiming one id', () => {
    const store = [
      arrangement('r1', ['a', 'b', null, null]),
      arrangement('r1', ['c', 'd', null, null])
    ]
    expect(repairArrangements(store).map((entry) => seatedTabs(entry.seats))).toEqual([['a', 'b']])
  })

  it('cuts a document down to MAX_ARRANGEMENTS', () => {
    const store = Array.from({ length: MAX_ARRANGEMENTS + 3 }, (_, index) =>
      arrangement(`r${index}`, [`t${index}a`, `t${index}b`, null, null])
    )
    expect(repairArrangements(store)).toHaveLength(MAX_ARRANGEMENTS)
  })
})

describe('cloneArrangements', () => {
  it('copies the seats, so a stored recording is never an array a caller holds', () => {
    const store = [arrangement('r1', ['a', 'b', null, null])]
    const copy = cloneArrangements(store)
    copy[0]?.seats.splice(0, 1)
    expect(store[0]?.seats).toEqual(['a', 'b', null, null])
  })
})

describe('the storage schema', () => {
  it('accepts a document the model produced and hands it back unchanged', () => {
    const document: ArrangementDocument = {
      version: 1,
      arrangements: [arrangement('r1', ['a', 'b', null, null])]
    }
    expect(arrangementDocumentSchema.parse(document)).toEqual(document)
  })

  it('heals a nonsense timestamp rather than losing every recording', () => {
    const parsed = arrangementSchema.parse({
      id: 'r1',
      layoutId: '2x2',
      seats: ['a', 'b', null, null],
      recordedAt: 'yesterday'
    })
    expect(parsed.recordedAt).toBe(0)
  })

  it('heals an unknown layout id, which is a value and not an identity', () => {
    const parsed = arrangementSchema.parse({
      id: 'r1',
      layoutId: '3x3',
      seats: ['a', 'b', null, null],
      recordedAt: T0
    })
    expect(parsed.layoutId).toBe('1x1')
  })

  it('heals a seat that is not a tab id into an empty tile', () => {
    const parsed = arrangementSchema.parse({
      id: 'r1',
      layoutId: '2x2',
      seats: ['a', 'b', 17, null],
      recordedAt: T0
    })
    expect(parsed.seats).toEqual(['a', 'b', null, null])
  })

  it('rejects a recording whose identity is not a string', () => {
    expect(
      arrangementSchema.safeParse({
        id: 7,
        layoutId: '2x2',
        seats: ['a', 'b', null, null],
        recordedAt: T0
      }).success
    ).toBe(false)
  })

  it('rejects a document of another version', () => {
    expect(arrangementDocumentSchema.safeParse({ version: 2, arrangements: [] }).success).toBe(
      false
    )
  })
})
