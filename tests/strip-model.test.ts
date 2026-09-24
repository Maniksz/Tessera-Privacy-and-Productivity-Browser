import { describe, expect, it } from 'vitest'
import {
  focusTabOf,
  nextStripEntry,
  stripEntries,
  stripEntryOf,
  stripItems,
  stripOrder,
  type StripArrangement,
  type StripItem
} from '@shared/strip/model.js'
import { contiguousOrder, type TabGroup } from '@shared/tabgroups/model.js'

/**
 * The strip model (U5, KTD6): which order the strip has and which entries it draws, from tabs, groups
 * and tiled views together.
 *
 * What goes wrong in the product when a rule here is wrong:
 *
 *   - **A tiled view that is not one run** draws its entry twice, or draws one member of it as a loose
 *     tab between strangers — the "three tabs numbered 1, 2, 3" the plan exists to remove (R1).
 *   - **A tiled view that leaves its group's run** splits the group into two brackets, and folding the
 *     group then hides half of what the user put in it (R11).
 *   - **A chip that counts tabs** says "3" for a folded group holding one tiled view of two pages and
 *     one tab, where the strip will draw two entries once it opens (R11).
 *   - **Positions or Ctrl+Tab that count tabs** land on the second member of a tiled view as if it
 *     were its own entry (R13).
 */

function group(overrides: Partial<TabGroup> & { id: string; tabIds: string[] }): TabGroup {
  return { name: '', color: 'blue', collapsed: false, createdAt: 1, ...overrides }
}

function split(id: string, tabIds: string[], activeTabId: string | null = null): StripArrangement {
  return { id, tabIds, activeTabId: activeTabId ?? tabIds[0] ?? null }
}

/** A compact reading of the sequence, so an assertion says what someone would see. */
function shape(items: readonly StripItem[]): string[] {
  return items.map((item) => {
    const at = item.kind !== 'group' && item.position !== null ? `(${item.position})` : ''
    switch (item.kind) {
      case 'group':
        return `[${item.group.id}${item.hiddenCount > 0 ? `x${item.hiddenCount}` : ''}]`
      case 'tab':
        return `${item.tabId}${at}`
      case 'split':
        return `{${item.arrangementId}:${item.tabIds.join('|')}}${at}`
    }
  })
}

describe('stripOrder', () => {
  it('gathers a tiled view into one run at its first member', () => {
    // The plan's first scenario: X, A1, Y, A2 with A = [A1, A2].
    expect(stripOrder(['X', 'A1', 'Y', 'A2'], [], [split('A', ['A1', 'A2'])])).toEqual([
      'X',
      'A1',
      'A2',
      'Y'
    ])
  })

  it('puts the run in tile order, not in the order the tabs happened to be in', () => {
    // The first member in the strip decides where the run stands; the tiles decide its inside.
    expect(stripOrder(['A2', 'X', 'A1'], [], [split('A', ['A1', 'A2'])])).toEqual(['A1', 'A2', 'X'])
  })

  it('is the group order when there is no tiled view', () => {
    const groups = [group({ id: 'g', tabIds: ['t3', 't1'] })]
    const order = ['t1', 't2', 't3']
    expect(stripOrder(order, groups, [])).toEqual(contiguousOrder(order, groups))
  })

  it('nests a tiled view inside its group run', () => {
    /*
      KTD6: the group is the outer run, the tiled view a run inside it. The group stands at its
      earliest member (A1, before X) and lists its members in its own order, which puts G's loose tab
      first — and the view's run stands at the first of its members in that order.
    */
    const groups = [group({ id: 'G', tabIds: ['g1', 'A1', 'A2'] })]
    expect(stripOrder(['A1', 'X', 'g1', 'A2'], groups, [split('A', ['A1', 'A2'])])).toEqual([
      'g1',
      'A1',
      'A2',
      'X'
    ])
  })

  it('pulls members together inside a group even when the group lists another tab between them', () => {
    const groups = [group({ id: 'G', tabIds: ['A1', 'g1', 'A2'] })]
    expect(stripOrder(['A1', 'g1', 'A2'], groups, [split('A', ['A1', 'A2'])])).toEqual([
      'A1',
      'A2',
      'g1'
    ])
  })

  it('pulls a loose view together across a group that stands between its members', () => {
    // Moving a loose tab past a group is harmless: it joins nothing and leaves nothing.
    const groups = [group({ id: 'G', tabIds: ['g1'] })]
    expect(stripOrder(['A1', 'g1', 'A2'], groups, [split('A', ['A1', 'A2'])])).toEqual([
      'A1',
      'A2',
      'g1'
    ])
  })

  it('never takes a member out of another group to join the run', () => {
    /*
      A view whose members sit in two groups breaks R10, and the group side repairs that (U8, KTD15).
      Until it does, the group run is the stronger rule: pulling A2 out of H would split H into two
      brackets. So A2 stays in H's run, and the view's run holds what its first member's group holds.
    */
    const groups = [group({ id: 'G', tabIds: ['A1'] }), group({ id: 'H', tabIds: ['h1', 'A2'] })]
    expect(stripOrder(['A1', 'h1', 'A2'], groups, [split('A', ['A1', 'A2'])])).toEqual([
      'A1',
      'h1',
      'A2'
    ])
  })

  it('leaves out members this window does not have', () => {
    // A member that closed a moment ago, with the view's summary not yet updated: nothing conjured.
    expect(stripOrder(['A1', 'X', 'A3'], [], [split('A', ['A1', 'gone', 'A3'])])).toEqual([
      'A1',
      'A3',
      'X'
    ])
  })

  it('gives a tab claimed by two views to the first', () => {
    // A tab sits in at most one view (R4); a summary that says otherwise must not draw it twice.
    const views = [split('A', ['A1', 'shared']), split('B', ['shared', 'B2'])]
    expect(stripOrder(['A1', 'B2', 'shared'], [], views)).toEqual(['A1', 'shared', 'B2'])
    // Also when the second view is reached first: it does not take the tab on its way past.
    expect(stripOrder(['B2', 'A1', 'shared'], [], views)).toEqual(['B2', 'A1', 'shared'])
  })

  it('draws a tab listed twice in a view once', () => {
    expect(stripOrder(['A1', 'A2'], [], [split('A', ['A1', 'A2', 'A1'])])).toEqual(['A1', 'A2'])
  })

  it('ignores a view none of whose members are here', () => {
    expect(stripOrder(['X'], [], [split('A', ['gone1', 'gone2'])])).toEqual(['X'])
  })

  it('is a permutation of the tabs, duplicates dropped', () => {
    const groups = [group({ id: 'G', tabIds: ['t2', 't5'] })]
    const views = [split('A', ['t4', 't1']), split('B', ['t6', 't3'])]
    const order = ['t1', 't2', 't3', 't1', 't4', 't5', 't6']
    expect([...stripOrder(order, groups, views)].sort()).toEqual([
      't1',
      't2',
      't3',
      't4',
      't5',
      't6'
    ])
  })

  it('gives the same answer when applied to its own answer', () => {
    // The core writes this order back as the window's (`#settle`); a second pass must not move a tab.
    const groups = [group({ id: 'G', tabIds: ['t5', 't2', 't3'] })]
    const views = [split('A', ['t3', 't2']), split('B', ['t6', 't1'])]
    const once = stripOrder(['t1', 't2', 't3', 't4', 't5', 't6'], groups, views)
    expect(stripOrder(once, groups, views)).toEqual(once)
  })

  it('handles an empty strip', () => {
    expect(
      stripOrder([], [group({ id: 'G', tabIds: ['t1'] })], [split('A', ['t1', 't2'])])
    ).toEqual([])
  })
})

/*
  The cases the group-only sequence of the former `src/shared/tabgroups/strip.ts` was held to, held
  here against this model. That file and its test went once the tab bar read this one (U7); these
  keep every boundary it had tested.
*/
describe('stripItems for tabs and groups', () => {
  it('is just the tabs in an ungrouped strip, with no group and no position', () => {
    const items = stripItems(['t1', 't2'], [])
    expect(shape(items)).toEqual(['t1', 't2'])
    expect(items[0]).toEqual({ kind: 'tab', tabId: 't1', group: null, position: null })
  })

  it('handles an empty strip', () => {
    expect(stripItems([], [])).toEqual([])
  })

  it('puts a chip before the first member, also at the very start of the strip', () => {
    const G = group({ id: 'G', tabIds: ['t2', 't3'] })
    expect(shape(stripItems(['t1', 't2', 't3'], [G]))).toEqual([
      't1',
      '[G]',
      't2(first)',
      't3(last)'
    ])
    const H = group({ id: 'H', tabIds: ['t1'] })
    expect(shape(stripItems(['t1', 't2'], [H]))).toEqual(['[H]', 't1(only)', 't2'])
  })

  it('marks the middle of a longer group', () => {
    const G = group({ id: 'G', tabIds: ['t1', 't2', 't3'] })
    expect(shape(stripItems(['t1', 't2', 't3'], [G]))).toEqual([
      '[G]',
      't1(first)',
      't2(middle)',
      't3(last)'
    ])
  })

  it('emits one chip per group when two groups touch', () => {
    const groups = [group({ id: 'G', tabIds: ['t1'] }), group({ id: 'H', tabIds: ['t2'] })]
    expect(shape(stripItems(['t1', 't2'], groups))).toEqual(['[G]', 't1(only)', '[H]', 't2(only)'])
  })

  it('draws a folded group as its chip alone, counting what it hides, and keeps its neighbours', () => {
    const G = group({ id: 'G', tabIds: ['t2', 't3'], collapsed: true })
    const items = stripItems(['t1', 't2', 't3', 't4'], [G])
    expect(shape(items)).toEqual(['t1', '[Gx2]', 't4'])
  })

  it('reports no hidden count while a group is open', () => {
    const [chip] = stripItems(['t1'], [group({ id: 'G', tabIds: ['t1'] })])
    expect(chip).toMatchObject({ kind: 'group', hiddenCount: 0 })
  })

  it('never drops a tab, whatever the groups claim', () => {
    const G = group({ id: 'G', tabIds: ['gone', 't2'] })
    expect(shape(stripItems(['t1', 't2'], [G]))).toEqual(['t1', '[G]', 't2(only)'])
  })
})

describe('stripItems with tiled views', () => {
  it('draws a tiled view as one entry, at the second place for X, A1, Y, A2', () => {
    const items = stripItems(['X', 'A1', 'Y', 'A2'], [], [split('A', ['A1', 'A2'], 'A2')])
    expect(shape(items)).toEqual(['X', '{A:A1|A2}', 'Y'])
    expect(items[1]).toEqual({
      kind: 'split',
      arrangementId: 'A',
      tabIds: ['A1', 'A2'],
      activeTabId: 'A2',
      group: null,
      position: null
    })
  })

  it('draws the members in tile order', () => {
    const items = stripItems(['A2', 'A1'], [], [split('A', ['A1', 'A2'])])
    expect(shape(items)).toEqual(['{A:A1|A2}'])
  })

  it('draws a view in a group inside the group run, after a loose group tab before it', () => {
    // The plan's second scenario: G chip, G tab, entry A — one run.
    const G = group({ id: 'G', tabIds: ['g1', 'A1', 'A2'] })
    const items = stripItems(['g1', 'A1', 'A2', 'X'], [G], [split('A', ['A1', 'A2'])])
    expect(shape(items)).toEqual(['[G]', 'g1(first)', '{A:A1|A2}(last)', 'X'])
    expect(items[2]).toMatchObject({ kind: 'split', group: G, position: 'last' })
  })

  it('counts positions in the group by entries, not by tabs', () => {
    // Four tabs, three entries: the middle one is the view, and the band has one middle, not two.
    const G = group({ id: 'G', tabIds: ['g1', 'A1', 'A2', 'g2'] })
    const items = stripItems(['g1', 'A1', 'A2', 'g2'], [G], [split('A', ['A1', 'A2'])])
    expect(shape(items)).toEqual(['[G]', 'g1(first)', '{A:A1|A2}(middle)', 'g2(last)'])
  })

  it('marks a view that is the whole group as its only entry', () => {
    const G = group({ id: 'G', tabIds: ['A1', 'A2'] })
    const items = stripItems(['A1', 'A2'], [G], [split('A', ['A1', 'A2'])])
    expect(shape(items)).toEqual(['[G]', '{A:A1|A2}(only)'])
  })

  it('counts a folded group by entries: a view and a tab are two', () => {
    // The plan's third scenario, and R11/AE6: the chip counts a tiled view as one.
    const G = group({ id: 'G', tabIds: ['A1', 'A2', 'g1'], collapsed: true })
    const items = stripItems(['A1', 'A2', 'g1', 'X'], [G], [split('A', ['A1', 'A2'])])
    expect(shape(items)).toEqual(['[Gx2]', 'X'])
    expect(items[0]).toEqual({ kind: 'group', group: G, hiddenCount: 2 })
  })

  it('does not count a member the window does not have', () => {
    // The chip used to count the group's whole membership, stale ids included; it counts what the
    // strip would draw now, which is the number the user will see appear.
    const G = group({ id: 'G', tabIds: ['gone', 't1'], collapsed: true })
    expect(shape(stripItems(['t1'], [G], []))).toEqual(['[Gx1]'])
  })

  it('shows only the members that are there when one has closed', () => {
    // The plan's last scenario: the close raced the summary. The entry shrinks, nothing throws.
    const items = stripItems(['A1', 'A3'], [], [split('A', ['A1', 'A2', 'A3'], 'A3')])
    expect(items).toEqual([
      {
        kind: 'split',
        arrangementId: 'A',
        tabIds: ['A1', 'A3'],
        activeTabId: 'A3',
        group: null,
        position: null
      }
    ])
  })

  it('titles the entry with its first member when the active one has gone', () => {
    const items = stripItems(['A2', 'A3'], [], [split('A', ['A2', 'A3', 'A1'], 'A1')])
    expect(items[0]).toMatchObject({ kind: 'split', activeTabId: 'A2' })
  })

  it('titles the entry with its first member when the view names no active tab', () => {
    const items = stripItems(
      ['A2', 'A1'],
      [],
      [{ id: 'A', tabIds: ['A1', 'A2'], activeTabId: null }]
    )
    expect(items[0]).toMatchObject({ kind: 'split', activeTabId: 'A1' })
  })

  it('keeps an entry for a view with one member left', () => {
    // The core ends a view of fewer than two; until its summary says so, the page is still drawn.
    expect(shape(stripItems(['A1'], [], [split('A', ['A1', 'A2'])]))).toEqual(['{A:A1}'])
  })

  it('draws no entry for a view none of whose members are here', () => {
    expect(shape(stripItems(['X'], [], [split('A', ['gone'])]))).toEqual(['X'])
  })

  it('draws a member held in another group as a tab of that group, and one entry for the view', () => {
    // The broken-R10 case from `stripOrder`: one entry, never two with the same id.
    const G = group({ id: 'G', tabIds: ['A1'] })
    const H = group({ id: 'H', tabIds: ['h1', 'A2'] })
    const items = stripItems(['A1', 'h1', 'A2'], [G, H], [split('A', ['A1', 'A2'])])
    expect(shape(items)).toEqual(['[G]', '{A:A1}(only)', '[H]', 'h1(first)', 'A2(last)'])
  })

  it('draws a loose member that follows the entry of a grouped view as a loose tab', () => {
    const G = group({ id: 'G', tabIds: ['A1'] })
    const items = stripItems(['A1', 'X', 'A2'], [G], [split('A', ['A1', 'A2'])])
    expect(shape(items)).toEqual(['[G]', '{A:A1}(only)', 'X', 'A2'])
  })

  it('draws two views side by side as two entries', () => {
    const items = stripItems(
      ['A1', 'A2', 'B1', 'B2'],
      [],
      [split('A', ['A1', 'A2']), split('B', ['B1', 'B2'])]
    )
    expect(shape(items)).toEqual(['{A:A1|A2}', '{B:B1|B2}'])
  })

  it('gives a tab two groups claim to the first, as the group order does', () => {
    // A document that slipped past repair: the chip and the order must agree about who owns `t1`.
    const G = group({ id: 'G', tabIds: ['t1'] })
    const H = group({ id: 'H', tabIds: ['t1', 't2'] })
    expect(shape(stripItems(['t1', 't2'], [G, H], []))).toEqual([
      '[G]',
      't1(only)',
      '[H]',
      't2(only)'
    ])
  })

  it('gathers a group the order had in two places', () => {
    // The order is settled before it is drawn, so a split group gets one chip rather than two.
    const G = group({ id: 'G', tabIds: ['t1', 't3'] })
    expect(shape(stripItems(['t1', 't2', 't3'], [G], []))).toEqual([
      '[G]',
      't1(first)',
      't3(last)',
      't2'
    ])
  })
})

describe('stripEntries', () => {
  it('is what the strip draws, chips and folded members left out', () => {
    const open = group({ id: 'G', tabIds: ['g1'] })
    const folded = group({ id: 'F', tabIds: ['f1', 'f2'], collapsed: true })
    const items = stripItems(
      ['X', 'g1', 'A1', 'A2', 'f1', 'f2'],
      [open, folded],
      [split('A', ['A1', 'A2'])]
    )
    expect(shape(stripEntries(items))).toEqual(['X', 'g1(only)', '{A:A1|A2}'])
  })
})

describe('stripEntryOf', () => {
  const G = group({ id: 'G', tabIds: ['g1'] })
  const F = group({ id: 'F', tabIds: ['f1'], collapsed: true })
  const items = stripItems(['X', 'A1', 'A2', 'g1', 'f1'], [G, F], [split('A', ['A1', 'A2'], 'A1')])

  it("finds a tiled view's entry through any of its members", () => {
    // The plan's fifth scenario: the active tab is A2, which is not the entry's title tab.
    expect(stripEntryOf(items, 'A2')).toMatchObject({ kind: 'split', arrangementId: 'A' })
    expect(stripEntryOf(items, 'A1')).toBe(stripEntryOf(items, 'A2'))
  })

  it('finds a tab entry for a tab', () => {
    expect(stripEntryOf(items, 'X')).toMatchObject({ kind: 'tab', tabId: 'X' })
    expect(stripEntryOf(items, 'g1')).toMatchObject({ kind: 'tab', tabId: 'g1', group: G })
  })

  it('finds nothing for a tab a folded group hides, or one that is not here', () => {
    expect(stripEntryOf(items, 'f1')).toBeNull()
    expect(stripEntryOf(items, 'nobody')).toBeNull()
    expect(stripEntryOf(items, null)).toBeNull()
  })
})

describe('focusTabOf', () => {
  it('is the tab itself for a tab, and the active member for a tiled view', () => {
    const [tab, view] = stripEntries(
      stripItems(['X', 'A1', 'A2'], [], [split('A', ['A1', 'A2'], 'A2')])
    )
    expect(focusTabOf(tab!)).toBe('X')
    expect(focusTabOf(view!)).toBe('A2')
  })
})

describe('nextStripEntry, for Ctrl+Tab', () => {
  const G = group({ id: 'G', tabIds: ['f1'], collapsed: true })
  // Drawn: X, {A}, f's chip (not an entry), Y.
  const items = stripItems(['X', 'A1', 'A2', 'f1', 'Y'], [G], [split('A', ['A1', 'A2'])])
  const next = (active: string | null): string | null => {
    const entry = nextStripEntry(items, active, 1)
    return entry === null ? null : shape([entry])[0]!
  }
  const previous = (active: string | null): string | null => {
    const entry = nextStripEntry(items, active, -1)
    return entry === null ? null : shape([entry])[0]!
  }

  it('steps over a tiled view as one entry', () => {
    expect(next('X')).toBe('{A:A1|A2}')
    // From either member: the view is the entry the user is on, so the next is the next entry.
    expect(next('A1')).toBe('Y')
    expect(next('A2')).toBe('Y')
  })

  it('steps back the same way', () => {
    expect(previous('Y')).toBe('{A:A1|A2}')
    expect(previous('A2')).toBe('X')
  })

  it('never lands on a tab a folded group hides', () => {
    expect(next('A1')).not.toBe('f1')
    expect(previous('Y')).not.toBe('f1')
  })

  it('wraps round at both ends', () => {
    expect(next('Y')).toBe('X')
    expect(previous('X')).toBe('Y')
  })

  it('starts from an end when the active tab has no entry', () => {
    // A hidden or unknown active tab: forwards is the first entry, backwards the last.
    expect(next('f1')).toBe('X')
    expect(previous('f1')).toBe('Y')
    expect(next(null)).toBe('X')
    expect(previous(null)).toBe('Y')
  })

  it('stays on the only entry there is', () => {
    const lone = stripItems(['A1', 'A2'], [], [split('A', ['A1', 'A2'])])
    expect(nextStripEntry(lone, 'A1', 1)).toBe(lone[0])
    expect(nextStripEntry(lone, 'A1', -1)).toBe(lone[0])
  })

  it('finds nothing in a strip that draws nothing', () => {
    expect(nextStripEntry([], 'X', 1)).toBeNull()
    expect(nextStripEntry([], null, -1)).toBeNull()
    const folded = stripItems(['f1'], [G], [])
    expect(nextStripEntry(folded, 'f1', 1)).toBeNull()
  })
})
