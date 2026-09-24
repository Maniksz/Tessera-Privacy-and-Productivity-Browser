import { describe, expect, it } from 'vitest'
import {
  MIN_ARRANGED_TILES,
  arrangementIsCurrent,
  arrangementIsProtected,
  arrangementOfTab,
  arrangementsEndedBy,
  cloneArrangements,
  createArrangement,
  defaultArrangementView,
  emptyArrangementDocument,
  forgetArrangement,
  forgetArrangementsOfTabs,
  reconcileArrangements,
  removeTabFromArrangements,
  repairArrangements,
  retainTabs,
  seatedTabs,
  updateArrangement,
  type Arrangement,
  type ArrangementDocument,
  type ArrangementDraft,
  type WindowTabs
} from '@shared/arrangements/model.js'
import {
  activeTabOf,
  arrangementHolding,
  arrangementSummaries,
  arrangementViewIsCurrent,
  restorableArrangement,
  settleRestoredScreen,
  windowCloseForgetsArrangements
} from '@shared/arrangements/screen.js'
import {
  arrangementDocumentSchema,
  arrangementSchema,
  arrangementsChangedSchema
} from '@shared/arrangements/schema.js'
import { DEFAULT_FRACTIONS } from '@shared/split/layout.js'

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
 *   - R4, a tab sits in at most one recording, and changing one keeps its id;
 *   - R16, a recording whose tabs belong to another window is neither offered nor changed, and
 *     nothing makes room by throwing a recording away — there is no cap any more (KTD3).
 */

const T0 = 1_700_000_000_000

/** What a tile's sound is before anybody touches it. */
const LOUD = { muted: false, volume: 1 }

/** A `2x2` recording, which is the shape most of these cases need, with the view it starts with. */
function arrangement(
  id: string,
  seats: Array<string | null>,
  overrides: Partial<Arrangement> = {}
): Arrangement {
  return {
    id,
    layoutId: '2x2',
    seats,
    activeTile: 0,
    fractions: { ...DEFAULT_FRACTIONS['2x2'] },
    tileAudio: [{ ...LOUD }, { ...LOUD }, { ...LOUD }, { ...LOUD }],
    recordedAt: T0,
    ...overrides
  }
}

function draft(
  id: string,
  seats: Array<string | null>,
  overrides: Partial<ArrangementDraft> = {}
): ArrangementDraft {
  return { id, layoutId: '2x2', seats, recordedAt: T0 + 1, ...overrides }
}

/** The calling window, as `createArrangement` and `arrangementOfTab` see it. */
function windowWith(liveTabIds: string[], hiddenTabIds: string[] = []): WindowTabs {
  return { liveTabIds, hiddenTabIds }
}

describe('the empty document', () => {
  it('starts at version 2 with nothing recorded', () => {
    expect(emptyArrangementDocument()).toEqual({ version: 2, arrangements: [] })
  })
})

describe('reading seats', () => {
  it('names the seated tabs in tile order and skips the empty tiles', () => {
    expect(seatedTabs(['a', null, 'b', null])).toEqual(['a', 'b'])
  })
})

describe('defaultArrangementView', () => {
  it('starts on the first tile, with the layout default dividers and every tile loud', () => {
    expect(defaultArrangementView('1+2')).toEqual({
      activeTile: 0,
      fractions: { v: 0.6, hRight: 0.5 },
      tileAudio: [LOUD, LOUD, LOUD]
    })
  })

  it('hands out a fresh view each time, so no recording shares one', () => {
    const first = defaultArrangementView('1x2')
    first.fractions['v'] = 0.9
    first.tileAudio[0]!.muted = true
    expect(defaultArrangementView('1x2')).toEqual({
      activeTile: 0,
      fractions: { v: 0.5 },
      tileAudio: [LOUD, LOUD]
    })
  })
})

describe('createArrangement: what is worth recording', () => {
  it('refuses an arrangement seating fewer than MIN_ARRANGED_TILES tabs', () => {
    expect(MIN_ARRANGED_TILES).toBe(2)
    const next = createArrangement([], draft('r1', ['a', null, null, null]), windowWith(['a']))
    expect(next).toEqual([])
  })

  it('refuses seats that do not fill exactly the tiles of their layout', () => {
    const next = createArrangement(
      [],
      draft('r1', ['a', 'b'], { layoutId: '2x2' }),
      windowWith(['a', 'b'])
    )
    expect(next).toEqual([])
  })

  it('refuses the same tab in two tiles', () => {
    const next = createArrangement([], draft('r1', ['a', 'a', null, null]), windowWith(['a']))
    expect(next).toEqual([])
  })

  it('refuses a draft seating a tab the calling window does not own', () => {
    const next = createArrangement([], draft('r1', ['a', 'b', null, null]), windowWith(['a']))
    expect(next).toEqual([])
  })

  it('records an arrangement the window owns in full, with the view it starts with', () => {
    const next = createArrangement(
      [],
      draft('r1', ['a', 'b', null, null]),
      windowWith(['a', 'b', 'c'])
    )
    expect(next).toEqual([arrangement('r1', ['a', 'b', null, null], { recordedAt: T0 + 1 })])
  })

  it('keeps the view a draft brings, fitted to its layout', () => {
    const [created] = createArrangement(
      [],
      draft('r1', ['a', 'b'], {
        layoutId: '1x2',
        activeTile: 1,
        fractions: { v: 0.3, h: 0.7 },
        tileAudio: [{ muted: true, volume: 0.4 }]
      }),
      windowWith(['a', 'b'])
    )
    expect(created).toMatchObject({
      activeTile: 1,
      fractions: { v: 0.3 },
      tileAudio: [{ muted: true, volume: 0.4 }, LOUD]
    })
  })

  it('pulls an active tile the layout does not have back onto one it does', () => {
    const [created] = createArrangement(
      [],
      draft('r1', ['a', 'b'], { layoutId: '1x2', activeTile: 7 }),
      windowWith(['a', 'b'])
    )
    expect(created?.activeTile).toBe(1)
  })

  it('hands back seats and a view no caller still holds', () => {
    const seats: Array<string | null> = ['a', 'b', null, null]
    const tileAudio = [{ muted: true, volume: 1 }]
    const [recorded] = createArrangement(
      [],
      draft('r1', seats, { tileAudio }),
      windowWith(['a', 'b'])
    )
    seats[0] = 'stolen'
    tileAudio[0]!.muted = false
    expect(recorded?.seats).toEqual(['a', 'b', null, null])
    expect(recorded?.tileAudio[0]?.muted).toBe(true)
  })
})

describe('createArrangement: a tab belongs to at most one (R4, KTD2)', () => {
  const previous = arrangement('r1', ['a', 'b', null, null])

  it('refuses tabs that already sit in another recording, and changes nothing', () => {
    const next = createArrangement(
      [previous],
      draft('r2', ['a', 'c', null, null]),
      windowWith(['a', 'b', 'c'])
    )
    expect(next).toEqual([previous])
  })

  it('refuses them even while the other recording is hidden by a collapsed group', () => {
    const next = createArrangement(
      [previous],
      draft('r2', ['a', 'c', null, null]),
      windowWith(['a', 'b', 'c'], ['b'])
    )
    expect(next.map((entry) => entry.id)).toEqual(['r1'])
  })

  it('refuses an id another recording already has', () => {
    const next = createArrangement(
      [previous],
      draft('r1', ['c', 'd', null, null]),
      windowWith(['a', 'b', 'c', 'd'])
    )
    expect(next).toEqual([previous])
  })

  it('records beside a recording that shares no tab', () => {
    const next = createArrangement(
      [previous],
      draft('r2', ['c', 'd', null, null]),
      windowWith(['a', 'b', 'c', 'd'])
    )
    expect(next.map((entry) => entry.id)).toEqual(['r1', 'r2'])
  })

  it('evicts nothing, however many recordings a window holds (R16, KTD3)', () => {
    let held: Arrangement[] = []
    const live: string[] = []
    for (let index = 0; index < 40; index += 1) {
      live.push(`t${index}a`, `t${index}b`)
      held = createArrangement(
        held,
        draft(`r${index}`, [`t${index}a`, `t${index}b`, null, null], { recordedAt: T0 + index }),
        windowWith(live)
      )
    }
    expect(held).toHaveLength(40)
    expect(held[0]?.id).toBe('r0')
  })
})

describe('updateArrangement: the same recording, changed (KTD1)', () => {
  const held = arrangement('r1', ['a', 'b', null, null])

  it('keeps the id through a new layout and seating, and sets the active tile', () => {
    const [updated] = updateArrangement(
      [held],
      'r1',
      { layoutId: '1+2', seats: ['a', 'c', 'b'], activeTile: 2 },
      windowWith(['a', 'b', 'c'])
    )
    expect(updated).toEqual({
      id: 'r1',
      layoutId: '1+2',
      seats: ['a', 'c', 'b'],
      activeTile: 2,
      // The divider both layouts share keeps its place, as `SplitController.setLayout` keeps it.
      fractions: { v: 0.5, hRight: 0.5 },
      tileAudio: [LOUD, LOUD, LOUD],
      recordedAt: T0
    })
  })

  it('writes the view alone, even while a collapsed group is hiding the tabs (R11)', () => {
    const [updated] = updateArrangement(
      [held],
      'r1',
      { fractions: { v: 0.25 }, tileAudio: [LOUD, { muted: true, volume: 1 }] },
      windowWith(['a', 'b'], ['a', 'b'])
    )
    expect(updated).toMatchObject({
      seats: ['a', 'b', null, null],
      fractions: { v: 0.25, h: 0.5 },
      tileAudio: [LOUD, { muted: true, volume: 1 }, LOUD, LOUD]
    })
  })

  it('refuses a seating with a tab that sits in another recording', () => {
    const other = arrangement('r2', ['c', 'd', null, null])
    const next = updateArrangement(
      [held, other],
      'r1',
      { seats: ['a', 'b', 'c', null] },
      windowWith(['a', 'b', 'c', 'd'])
    )
    expect(next).toEqual([held, other])
  })

  it('refuses a seating that is no arrangement any more, rather than dropping the recording', () => {
    const next = updateArrangement(
      [held],
      'r1',
      { seats: ['a', null, null, null] },
      windowWith(['a', 'b'])
    )
    expect(next).toEqual([held])
  })

  it('refuses a new layout without the seating that fits it', () => {
    const next = updateArrangement([held], 'r1', { layoutId: '1x2' }, windowWith(['a', 'b']))
    expect(next).toEqual([held])
  })

  it("refuses to touch another window's recording (R16)", () => {
    const next = updateArrangement([held], 'r1', { activeTile: 1 }, windowWith(['a']))
    expect(next).toEqual([held])
  })

  it('refuses to seat a tab the calling window does not own', () => {
    const next = updateArrangement(
      [held],
      'r1',
      { seats: ['a', 'b', 'x', null] },
      windowWith(['a', 'b'])
    )
    expect(next).toEqual([held])
  })

  it('is a no-op for an id nothing holds', () => {
    expect(updateArrangement([held], 'nope', { activeTile: 1 }, windowWith(['a', 'b']))).toEqual([
      held
    ])
  })

  it('leaves the other recordings as they were', () => {
    const other = arrangement('r2', ['c', 'd', null, null])
    const next = updateArrangement(
      [held, other],
      'r1',
      { activeTile: 1 },
      windowWith(['a', 'b', 'c', 'd'])
    )
    expect(next).toEqual([{ ...held, activeTile: 1 }, other])
  })
})

describe('removeTabFromArrangements: a member closes', () => {
  it('empties its tile and keeps a recording that still seats enough tabs', () => {
    const held = [arrangement('r1', ['a', 'b', 'c', null])]
    expect(removeTabFromArrangements(held, 'b')).toEqual([
      arrangement('r1', ['a', null, 'c', null])
    ])
  })

  it('drops a recording that falls below MIN_ARRANGED_TILES', () => {
    const held = [arrangement('r1', ['a', 'b', null, null])]
    expect(removeTabFromArrangements(held, 'a')).toEqual([])
  })

  it('hands back a view no caller still holds', () => {
    const held = [arrangement('r1', ['a', 'b', 'c', null])]
    const [kept] = removeTabFromArrangements(held, 'b')
    kept!.tileAudio[0]!.muted = true
    kept!.fractions['v'] = 0.9
    expect(held[0]).toEqual(arrangement('r1', ['a', 'b', 'c', null]))
  })

  it('leaves every recording alone for a tab none of them seats', () => {
    const held = [arrangement('r1', ['a', 'b', null, null])]
    expect(removeTabFromArrangements(held, 'z')).toEqual(held)
  })
})

describe('forgetArrangementsOfTabs: a window goes (KTD3)', () => {
  it('drops every recording that seats one of the tabs, and only those', () => {
    const held = [
      arrangement('r1', ['a', 'b', null, null]),
      arrangement('r2', ['c', 'd', null, null]),
      arrangement('r3', ['e', 'f', null, null])
    ]
    expect(forgetArrangementsOfTabs(held, ['b', 'e']).map((entry) => entry.id)).toEqual(['r2'])
  })
})

describe('reconcileArrangements: one start-up pass over groups (KTD15)', () => {
  it('drops a recording whose tabs reach across a group boundary', () => {
    const held = [arrangement('r1', ['a', 'b', null, null])]
    expect(reconcileArrangements(held, [['a'], ['b']])).toEqual([])
  })

  it('drops a recording that is half in a group and half outside', () => {
    const held = [arrangement('r1', ['a', 'b', null, null])]
    expect(reconcileArrangements(held, [['a', 'x']])).toEqual([])
  })

  it('keeps a recording that lies in one group, or in none', () => {
    const held = [
      arrangement('r1', ['a', 'b', null, null]),
      arrangement('r2', ['c', 'd', null, null])
    ]
    expect(reconcileArrangements(held, [['a', 'b', 'z']])).toEqual(held)
  })

  it('keeps only the newer of two recordings sharing a tab', () => {
    const older = arrangement('r1', ['a', 'b', null, null], { recordedAt: T0 })
    const newer = arrangement('r2', ['b', 'c', null, null], { recordedAt: T0 + 5 })
    expect(reconcileArrangements([newer, older], []).map((entry) => entry.id)).toEqual(['r2'])
  })

  it('keeps the later entry of two sharing a tab and a timestamp', () => {
    const first = arrangement('r1', ['a', 'b', null, null])
    const second = arrangement('r2', ['b', 'c', null, null])
    expect(reconcileArrangements([first, second], []).map((entry) => entry.id)).toEqual(['r2'])
  })

  it('keeps a recording inside a collapsed group, and a second pass changes nothing', () => {
    // A collapsed group is still a set of tab ids here: the model has no word for collapsing.
    const inside = arrangement('r1', ['a', 'b', null, null])
    const across = arrangement('r2', ['c', 'x', null, null])
    const once = reconcileArrangements([inside, across], [['a', 'b', 'c']])
    expect(once).toEqual([inside])
    expect(reconcileArrangements(once, [['a', 'b', 'c']])).toEqual(once)
  })
})

describe('R16: an arrangement acts only in its own window', () => {
  const foreign = arrangement('other-window', ['p', 'q', null, null])

  it('does not offer a foreign recording to a click', () => {
    expect(arrangementOfTab([foreign], 'p', windowWith(['a', 'b']))).toBeUndefined()
  })

  it('leaves a foreign recording standing beside a new one', () => {
    const next = createArrangement(
      [foreign],
      draft('fresh', ['x', 'y', null, null]),
      windowWith(['x', 'y'])
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

describe('arrangementsEndedBy: choosing the single layout', () => {
  it('ends the recording of the tiling on screen', () => {
    const held = [arrangement('r1', ['a', 'b', 'c', 'd'])]
    const ended = arrangementsEndedBy(held, ['a', 'b', 'c', 'd'], windowWith(['a', 'b', 'c', 'd']))
    expect(ended.map((entry) => entry.id)).toEqual(['r1'])
  })

  it('ends an older recording of the same tabs the last settle has not superseded yet', () => {
    // A drag and the menu in one turn of the loop: the recording is of the seating before the drag.
    const held = [arrangement('r1', ['a', 'b', null, null])]
    const ended = arrangementsEndedBy(held, ['a', 'c', null, null], windowWith(['a', 'b', 'c']))
    expect(ended.map((entry) => entry.id)).toEqual(['r1'])
  })

  it('spares a tiling put away earlier that shares no tab with the one on screen', () => {
    // A new tab took the window from a|b; choosing "single" for that tab is not a word about a|b.
    const held = [arrangement('r1', ['a', 'b', null, null])]
    expect(arrangementsEndedBy(held, ['fresh'], windowWith(['a', 'b', 'fresh']))).toEqual([])
  })

  it('spares a recording a collapsed group still needs (R15)', () => {
    const held = [arrangement('r1', ['a', 'b', null, null])]
    expect(arrangementsEndedBy(held, ['a', null], windowWith(['a', 'b'], ['b']))).toEqual([])
  })

  it("spares another window's recording (R16)", () => {
    const held = [arrangement('r1', ['a', 'elsewhere', null, null])]
    expect(arrangementsEndedBy(held, ['a', 'b'], windowWith(['a', 'b']))).toEqual([])
  })

  it('hands out copies, so forgetting through them cannot reach the document', () => {
    const held = [arrangement('r1', ['a', 'b', null, null])]
    const [ended] = arrangementsEndedBy(held, ['a', 'b'], windowWith(['a', 'b']))
    ended?.seats.splice(0, 1)
    expect(held[0]?.seats).toEqual(['a', 'b', null, null])
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
    expect(retainTabs(store, ['a', 'c'])).toEqual([arrangement('r1', ['a', null, 'c', null])])
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

  it('keeps every recording of a long document, because there is no cap to cut to (KTD3)', () => {
    const store = Array.from({ length: 40 }, (_, index) =>
      arrangement(`r${index}`, [`t${index}a`, `t${index}b`, null, null])
    )
    expect(repairArrangements(store)).toEqual(store)
  })

  it('fits a view that does not match its layout back onto it', () => {
    const [repaired] = repairArrangements([
      arrangement('r1', ['a', 'b'], {
        layoutId: '1x2',
        activeTile: 3,
        fractions: { h: 0.2 },
        tileAudio: [LOUD, LOUD, LOUD, { muted: true, volume: 0 }]
      })
    ])
    expect(repaired).toMatchObject({
      activeTile: 1,
      fractions: { v: 0.5 },
      tileAudio: [LOUD, LOUD]
    })
  })

  it('puts a nonsense active tile back on the first one', () => {
    const [repaired] = repairArrangements([
      arrangement('r1', ['a', 'b', null, null], { activeTile: Number.NaN })
    ])
    expect(repaired?.activeTile).toBe(0)
  })
})

describe('cloneArrangements', () => {
  it('copies the seats, so a stored recording is never an array a caller holds', () => {
    const store = [arrangement('r1', ['a', 'b', null, null])]
    const copy = cloneArrangements(store)
    copy[0]?.seats.splice(0, 1)
    expect(store[0]?.seats).toEqual(['a', 'b', null, null])
  })

  it('copies the view as deep, dividers and every tile of sound', () => {
    const store = [arrangement('r1', ['a', 'b', null, null])]
    const copy = cloneArrangements(store)
    copy[0]!.fractions['v'] = 0.9
    copy[0]!.tileAudio[0]!.muted = true
    expect(store[0]).toEqual(arrangement('r1', ['a', 'b', null, null]))
  })
})

describe('the storage schema', () => {
  it('accepts a document the model produced and hands it back unchanged', () => {
    const document: ArrangementDocument = {
      version: 2,
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

  it('heals a view a recording lacks rather than losing the recording', () => {
    // The fields version 2 added. The migration writes them, and this is the net under it: a file
    // cut short or edited by hand still loads, and `repairArrangements` fits the rest to the layout.
    const parsed = arrangementSchema.parse({
      id: 'r1',
      layoutId: '2x2',
      seats: ['a', 'b', null, null],
      recordedAt: T0
    })
    expect(parsed).toMatchObject({ activeTile: 0, fractions: {}, tileAudio: [] })
  })

  it('heals a nonsense view value by value', () => {
    const parsed = arrangementSchema.parse({
      id: 'r1',
      layoutId: '2x2',
      seats: ['a', 'b', null, null],
      activeTile: -2,
      fractions: 'wide',
      tileAudio: [
        { muted: true, volume: 0.5 },
        { muted: 'loud', volume: 9 }
      ],
      recordedAt: T0
    })
    expect(parsed).toMatchObject({
      activeTile: 0,
      fractions: {},
      tileAudio: [{ muted: true, volume: 0.5 }, LOUD]
    })
  })

  it('rejects a document of another version', () => {
    // Version 1 is not "another version" on disk — the store migrates it before this runs.
    for (const version of [1, 3]) {
      expect(arrangementDocumentSchema.safeParse({ version, arrangements: [] }).success).toBe(false)
    }
  })
})

describe('arrangementHolding: the visible tiling a window adopts (U2)', () => {
  const held = arrangement('r1', ['a', 'b', 'c', null])

  it('answers the one arrangement that holds every tab on screen', () => {
    expect(
      arrangementHolding([held], ['b', 'a', null, null], windowWith(['a', 'b', 'c']))?.id
    ).toBe('r1')
  })

  it('answers nothing when a tab on screen sits in no arrangement', () => {
    expect(
      arrangementHolding([held], ['a', 'x', null, null], windowWith(['a', 'b', 'c', 'x']))
    ).toBeUndefined()
  })

  it('answers nothing when the tab on screen first sits in no arrangement', () => {
    expect(
      arrangementHolding([held], ['x', 'a', null, null], windowWith(['a', 'b', 'c', 'x']))
    ).toBeUndefined()
  })

  it('answers nothing for an empty screen', () => {
    expect(arrangementHolding([held], [null, null, null, null], windowWith(['a']))).toBeUndefined()
  })

  it("answers nothing for another window's arrangement (R16)", () => {
    expect(
      arrangementHolding([held], ['a', 'b', null, null], windowWith(['a', 'b']))
    ).toBeUndefined()
  })
})

describe('arrangementViewIsCurrent: the gate on writing the view', () => {
  const held = arrangement('r1', ['a', 'b', null, null], {
    activeTile: 1,
    fractions: { v: 0.3, h: 0.5 },
    tileAudio: [LOUD, { muted: true, volume: 1 }, LOUD, LOUD]
  })
  const view = {
    activeTile: 1,
    fractions: { v: 0.3, h: 0.5 },
    tileAudio: [LOUD, { muted: true, volume: 1 }, LOUD, LOUD]
  }

  it('is true for the view the arrangement already holds', () => {
    expect(arrangementViewIsCurrent(held, view)).toBe(true)
  })

  it('reads the view as the store would write it, so a settled view stays settled', () => {
    // A divider the layout does not have and a missing tile's sound are what `updateArrangement`
    // drops and fills; comparing the raw value would make every round write again.
    expect(
      arrangementViewIsCurrent(held, {
        ...view,
        fractions: { v: 0.3, h: 0.5, stray: 0.9 },
        tileAudio: [LOUD, { muted: true, volume: 1 }]
      })
    ).toBe(true)
  })

  it('is false for another active tile', () => {
    expect(arrangementViewIsCurrent(held, { ...view, activeTile: 0 })).toBe(false)
  })

  it('is false for an arrangement that holds no sound for a tile', () => {
    expect(arrangementViewIsCurrent({ ...held, tileAudio: [] }, view)).toBe(false)
  })

  it('is false for a moved divider', () => {
    expect(arrangementViewIsCurrent(held, { ...view, fractions: { v: 0.6, h: 0.5 } })).toBe(false)
  })

  it("is false for a tile's sound, muted or turned down", () => {
    expect(arrangementViewIsCurrent(held, { ...view, tileAudio: [LOUD, LOUD, LOUD, LOUD] })).toBe(
      false
    )
    expect(
      arrangementViewIsCurrent(held, {
        ...view,
        tileAudio: [LOUD, { muted: true, volume: 0.5 }, LOUD, LOUD]
      })
    ).toBe(false)
  })
})

describe('activeTabOf', () => {
  it('names the tab in the active tile', () => {
    expect(activeTabOf(arrangement('r1', ['a', 'b', null, null], { activeTile: 1 }))).toBe('b')
  })

  it('falls back to the first seated tab when the active tile is empty', () => {
    expect(activeTabOf(arrangement('r1', [null, null, 'c', 'd'], { activeTile: 1 }))).toBe('c')
  })

  it('names nothing for a seating with nobody in it', () => {
    expect(activeTabOf(arrangement('r1', [null, null, null, null]))).toBeNull()
  })
})

describe('restorableArrangement: bringing one back by id (R4)', () => {
  const held = arrangement('r1', ['a', 'b', null, null])

  it('answers the arrangement with that id', () => {
    expect(restorableArrangement([held], 'r1', windowWith(['a', 'b']))?.id).toBe('r1')
  })

  it('answers nothing for an id nothing holds', () => {
    expect(restorableArrangement([held], 'r2', windowWith(['a', 'b']))).toBeUndefined()
  })

  it('answers nothing while one of its tabs is hidden, or belongs to another window', () => {
    expect(restorableArrangement([held], 'r1', windowWith(['a', 'b'], ['b']))).toBeUndefined()
    expect(restorableArrangement([held], 'r1', windowWith(['a']))).toBeUndefined()
  })
})

describe('settleRestoredScreen: one entry after a restart (KTD3)', () => {
  const shown = ['a', 'b', null, null]
  const live = windowWith(['a', 'b', 'c', 'd'])

  it('keeps the arrangement the slot names, and forgets any other sharing a tab with the screen', () => {
    const named = arrangement('r1', ['a', 'b', 'c', null])
    const stale = arrangement('r2', ['b', 'd', null, null])
    expect(settleRestoredScreen([named, stale], '2x2', shown, 'r1', live)).toEqual({
      liveId: 'r1',
      forget: ['r2']
    })
  })

  it('adopts the arrangement whose seats match the screen for a slot without an id', () => {
    const matching = arrangement('r1', ['a', 'b', null, null])
    const overlapping = arrangement('r2', ['c', 'a', null, null])
    expect(settleRestoredScreen([overlapping, matching], '2x2', shown, null, live)).toEqual({
      liveId: 'r1',
      forget: ['r2']
    })
  })

  it('falls back to the matching seats when the named arrangement did not come back', () => {
    const matching = arrangement('r1', ['a', 'b', null, null])
    expect(settleRestoredScreen([matching], '2x2', shown, 'gone', live)).toEqual({
      liveId: 'r1',
      forget: []
    })
  })

  it('names no arrangement when none fits, and clears the way for the next settle', () => {
    const overlapping = arrangement('r2', ['a', 'c', null, null])
    expect(settleRestoredScreen([overlapping], '2x2', shown, null, live)).toEqual({
      liveId: null,
      forget: ['r2']
    })
  })

  it('leaves every arrangement alone while the screen shows one page (restoreLayoutOnStart off)', () => {
    const held = arrangement('r1', ['a', 'b', null, null])
    expect(settleRestoredScreen([held], '1x1', ['c'], 'r1', live)).toEqual({
      liveId: null,
      forget: []
    })
  })

  it("leaves another window's and a disjoint arrangement alone", () => {
    const foreign = arrangement('r3', ['a', 'z', null, null])
    const disjoint = arrangement('r4', ['c', 'd', null, null])
    expect(settleRestoredScreen([foreign, disjoint], '2x2', shown, null, live)).toEqual({
      liveId: null,
      forget: []
    })
  })
})

describe('arrangementSummaries: what the strip is told (KTD5)', () => {
  const visible = arrangement('r1', ['a', null, 'b', null], { activeTile: 2 })
  const putAway = arrangement('r2', ['c', 'd', null, null], { layoutId: '2x2' })
  const foreign = arrangement('r3', ['x', 'y', null, null])

  it("lists this window's arrangements, members in tile order, and marks the visible one", () => {
    expect(
      arrangementSummaries([visible, putAway, foreign], windowWith(['a', 'b', 'c', 'd']), 'r1')
    ).toEqual([
      {
        id: 'r1',
        layoutId: '2x2',
        tabIds: ['a', 'b'],
        activeTile: 2,
        activeTabId: 'b',
        visible: true
      },
      {
        id: 'r2',
        layoutId: '2x2',
        tabIds: ['c', 'd'],
        activeTile: 0,
        activeTabId: 'c',
        visible: false
      }
    ])
  })

  it('marks none visible while the window shows a single page', () => {
    const summaries = arrangementSummaries([visible], windowWith(['a', 'b']), null)
    expect(summaries.map((summary) => summary.visible)).toEqual([false])
  })

  it('is what the event schema accepts', () => {
    const arrangements = arrangementSummaries([visible], windowWith(['a', 'b']), 'r1')
    expect(arrangementsChangedSchema.parse({ arrangements })).toEqual({ arrangements })
  })
})

describe('windowCloseForgetsArrangements: the rule forgetWindow keeps for slots (KTD3)', () => {
  const normal = { privateMode: false }
  const privateWindow = { privateMode: true }

  it('forgets when another ordinary window stays open', () => {
    expect(windowCloseForgetsArrangements(normal, [normal], false)).toBe(true)
  })

  it('keeps them when the last ordinary window closes, for the restart', () => {
    expect(windowCloseForgetsArrangements(normal, [], false)).toBe(false)
    expect(windowCloseForgetsArrangements(normal, [privateWindow], false)).toBe(false)
  })

  it('keeps them while the browser is shutting down and every window closes', () => {
    expect(windowCloseForgetsArrangements(normal, [normal], true)).toBe(false)
  })

  it('has nothing to forget for a private window, whose book was never the file', () => {
    expect(windowCloseForgetsArrangements(privateWindow, [normal], false)).toBe(false)
  })
})
