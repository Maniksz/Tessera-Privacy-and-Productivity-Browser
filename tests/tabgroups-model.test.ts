import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EmptyTabGroupError,
  MAX_TAB_GROUPS,
  MAX_TAB_GROUP_NAME_LENGTH,
  TabGroupLimitError,
  TabGroupNotFoundError,
  addGroup,
  addTabToGroup,
  contiguousOrder,
  dissolveGroup,
  emptyTabGroupDocument,
  findGroup,
  groupOfTab,
  isContiguous,
  isTabHidden,
  newTabGroup,
  nextTabGroupColor,
  recolorGroup,
  removeTabFromGroup,
  renameGroup,
  repairGroups,
  retainTabs,
  setGroupCollapsed,
  tabsHiddenByCollapse,
  visibleTabOrder,
  type TabGroup
} from '@shared/tabgroups/model.js'
import {
  FALLBACK_TAB_GROUP_COLOR,
  TAB_GROUP_COLORS,
  tabGroupColorToken,
  tabGroupColorVariable,
  type TabGroupColor
} from '@shared/tabgroups/palette.js'

/**
 * The tab-group rules.
 *
 * Every function here is pure, so these tests need no clock and no filesystem: ids and
 * timestamps are handed in, which is the point of `CreateContext`. What is being
 * checked is the set of invariants the tab strip and the split layout both rely on —
 * one tab in at most one group, no tab twice in a group, no group with nothing in it,
 * and a group that occupies a single run of the strip.
 */

const T0 = 1_700_000_000_000

/** A group built directly, for the cases where going through `newTabGroup` would only
 * add noise. Defaults are the ones `newTabGroup` produces. */
function group(id: string, tabIds: string[], overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: '',
    color: 'blue',
    collapsed: false,
    tabIds,
    createdAt: T0,
    ...overrides
  }
}

function make(
  groups: readonly TabGroup[],
  input: { tabIds: string[]; name?: string; color?: TabGroupColor },
  id = 'g-new'
): TabGroup[] {
  return addGroup(groups, newTabGroup(groups, input, { id, now: T0 }))
}

function ids(groups: readonly TabGroup[]): string[] {
  return groups.map((entry) => entry.id)
}

describe('what the tab strip is allowed to import', () => {
  /*
    This began as a stand-in and is now narrower, on purpose.

    It used to require *every* file in the directory to be dependency-free and zod-free, because the
    tab strip did not import any of them yet and the day it did must not be the day the UI bundle grew
    half a megabyte. The strip imports them now, so the real rule — the transitive one in
    `architecture.test.ts`, which follows value imports from `src/renderer` and forbids zod anywhere
    it reaches — covers this directory properly.

    What remains here is the part that rule cannot state: *which* files are the renderer-facing ones.
    `schema.ts` holds the wire schema and must stay out of the strip's reach, exactly as
    `quicklinks/schema.ts` does; the other three are fair game and must stay cheap.
  */
  const directory = join(process.cwd(), 'src/shared/tabgroups')

  /** The files the tab strip may import. `schema.ts` is deliberately absent. */
  const RENDERER_FACING = ['model.ts', 'palette.ts', 'strip.ts']

  it('keeps the renderer-facing files inside their own directory', () => {
    // A dependency here is a dependency in the UI bundle. Staying within the directory is stricter
    // than needed and cheap to keep, and it makes an accidental `@main/` import impossible.
    for (const name of RENDERER_FACING) {
      const text = readFileSync(join(directory, name), 'utf8')
      const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
      for (const specifier of specifiers) {
        expect(specifier, `${name} imports ${specifier ?? ''}`).toMatch(/^\.\//)
      }
    }
  })

  it('names zod in the wire schema and nowhere else', () => {
    // Asserted in both directions. That `schema.ts` *does* use zod is the point of it existing
    // separately, and a test that only checked the absence would pass if the schema went away.
    for (const name of RENDERER_FACING) {
      expect(readFileSync(join(directory, name), 'utf8'), name).not.toMatch(/from 'zod'/)
    }
    expect(readFileSync(join(directory, 'schema.ts'), 'utf8')).toMatch(/from 'zod'/)
  })

  it('lists every file in the directory as one or the other', () => {
    // So a fourth renderer-facing module cannot be added and silently escape both rules above.
    const onDisk = readdirSync(directory).sort()
    expect(onDisk).toEqual([...RENDERER_FACING, 'schema.ts'].sort())
  })
})

describe('the colour palette', () => {
  it('offers eight distinct named slots', () => {
    expect(new Set(TAB_GROUP_COLORS).size).toBe(TAB_GROUP_COLORS.length)
    expect(TAB_GROUP_COLORS.length).toBe(8)
  })

  it('leaves purple out, because purple marks a private window', () => {
    // `--accent-private` is purple and means "this window keeps nothing". A group
    // tinted like that signal is the confusion spec 4 exists to prevent.
    expect(TAB_GROUP_COLORS as readonly string[]).not.toContain('purple')
  })

  it('allocates from the front and keeps grey for last', () => {
    // Allocation order, not just membership: the first group a user makes is blue, and
    // grey — the "no colour in particular" slot — is reached only when the rest are used.
    expect(TAB_GROUP_COLORS[0]).toBe('blue')
    expect(TAB_GROUP_COLORS.at(-1)).toBe('grey')
    expect(FALLBACK_TAB_GROUP_COLOR).toBe('grey')
  })

  it('maps every slot to a custom property and a reference to it', () => {
    for (const color of TAB_GROUP_COLORS) {
      expect(tabGroupColorVariable(color)).toBe(`--tab-group-${color}`)
      expect(tabGroupColorToken(color)).toBe(`var(--tab-group-${color})`)
    }
  })

  it('names no colour value anywhere in the model', () => {
    // The whole reason the palette is names: a hex here would be whichever theme
    // happened to be active, baked into stored user data.
    const sources = [TAB_GROUP_COLORS.join(' '), TAB_GROUP_COLORS.map(tabGroupColorToken).join(' ')]
    for (const text of sources) expect(text).not.toMatch(/#[0-9a-f]{3,8}/i)
  })

  it('picks the first unused slot for a new group', () => {
    expect(nextTabGroupColor([])).toBe('blue')
    expect(nextTabGroupColor([group('a', ['t1'], { color: 'blue' })])).toBe('cyan')
    expect(
      nextTabGroupColor([
        group('a', ['t1'], { color: 'blue' }),
        group('b', ['t2'], { color: 'green' })
      ])
    ).toBe('cyan')
  })

  it('starts over once every slot is in use', () => {
    const all = TAB_GROUP_COLORS.map((color, index) => group(`g${index}`, [`t${index}`], { color }))
    expect(nextTabGroupColor(all)).toBe('blue')
  })
})

describe('creating a group', () => {
  it('takes its id and timestamp from the caller', () => {
    const created = newTabGroup([], { tabIds: ['t1', 't2'] }, { id: 'g1', now: T0 })
    expect(created).toEqual({
      id: 'g1',
      name: '',
      color: 'blue',
      collapsed: false,
      tabIds: ['t1', 't2'],
      createdAt: T0
    })
  })

  it('accepts an explicit colour', () => {
    const created = newTabGroup([], { tabIds: ['t1'], color: 'red' }, { id: 'g1', now: T0 })
    expect(created.color).toBe('red')
  })

  it('collapses whitespace in the name and cuts it to the limit', () => {
    const created = newTabGroup(
      [],
      { tabIds: ['t1'], name: `  Steuer\n  erklärung  ${'x'.repeat(80)}` },
      { id: 'g1', now: T0 }
    )
    expect(created.name.length).toBe(MAX_TAB_GROUP_NAME_LENGTH)
    expect(created.name.startsWith('Steuer erklärung x')).toBe(true)
  })

  it('deduplicates the tabs it is formed from', () => {
    const created = newTabGroup([], { tabIds: ['t1', 't2', 't1'] }, { id: 'g1', now: T0 })
    expect(created.tabIds).toEqual(['t1', 't2'])
  })

  it('refuses a group with no tabs', () => {
    expect(() => newTabGroup([], { tabIds: [] }, { id: 'g1', now: T0 })).toThrow(EmptyTabGroupError)
  })

  it('refuses when the cap is reached', () => {
    const many = Array.from({ length: MAX_TAB_GROUPS }, (_, index) =>
      group(`g${index}`, [`t${index}`])
    )
    expect(() => newTabGroup(many, { tabIds: ['x'] }, { id: 'over', now: T0 })).toThrow(
      TabGroupLimitError
    )
  })

  it('places the group and finds it again', () => {
    const groups = make([], { tabIds: ['t1'] }, 'g1')
    expect(findGroup(groups, 'g1')?.tabIds).toEqual(['t1'])
    expect(findGroup(groups, 'nope')).toBeUndefined()
  })

  it('takes its members away from the group that held them', () => {
    const existing = [group('old', ['t1', 't2'])]
    const groups = make(existing, { tabIds: ['t2'] }, 'new')
    expect(findGroup(groups, 'old')?.tabIds).toEqual(['t1'])
    expect(findGroup(groups, 'new')?.tabIds).toEqual(['t2'])
  })

  it('dissolves a group whose last tab it took', () => {
    const groups = make([group('old', ['t1'])], { tabIds: ['t1'] }, 'new')
    expect(ids(groups)).toEqual(['new'])
  })

  it('replaces rather than duplicates a group with the same id', () => {
    const first = make([], { tabIds: ['t1'] }, 'g1')
    const again = addGroup(first, group('g1', ['t2'], { name: 'second' }))
    expect(ids(again)).toEqual(['g1'])
    expect(findGroup(again, 'g1')?.tabIds).toEqual(['t2'])
  })

  it('starts the document empty', () => {
    expect(emptyTabGroupDocument()).toEqual({ version: 1, groups: [] })
  })
})

describe('renaming, recolouring and dissolving', () => {
  const groups = [group('a', ['t1']), group('b', ['t2']), group('c', ['t3'])]

  it('renames in place, without moving the group', () => {
    const next = renameGroup(groups, 'b', '  Work  ')
    expect(ids(next)).toEqual(['a', 'b', 'c'])
    expect(findGroup(next, 'b')?.name).toBe('Work')
  })

  it('cuts a renamed group to the length limit', () => {
    const next = renameGroup(groups, 'a', 'y'.repeat(200))
    expect(findGroup(next, 'a')?.name.length).toBe(MAX_TAB_GROUP_NAME_LENGTH)
  })

  it('changes a colour without touching anything else', () => {
    const next = recolorGroup(groups, 'c', 'pink')
    expect(findGroup(next, 'c')).toEqual({ ...group('c', ['t3']), color: 'pink' })
  })

  it('dissolves a group and leaves its tabs alone', () => {
    const next = dissolveGroup(groups, 'b')
    expect(ids(next)).toEqual(['a', 'c'])
    // Nothing here can close a tab: the ids simply stop being mentioned.
    expect(groupOfTab(next, 't2')).toBeUndefined()
  })

  it('reports a group it does not have', () => {
    expect(() => renameGroup(groups, 'zz', 'x')).toThrow(TabGroupNotFoundError)
    expect(() => recolorGroup(groups, 'zz', 'red')).toThrow(TabGroupNotFoundError)
    expect(() => setGroupCollapsed(groups, 'zz', true)).toThrow(TabGroupNotFoundError)
    expect(() => dissolveGroup(groups, 'zz')).toThrow(TabGroupNotFoundError)
  })

  it('leaves the list it was given untouched', () => {
    const original = [group('a', ['t1'])]
    renameGroup(original, 'a', 'changed')
    addTabToGroup(original, 'a', 't9')
    expect(original[0]!.name).toBe('')
    expect(original[0]!.tabIds).toEqual(['t1'])
  })
})

describe('adding a tab to a group', () => {
  it('appends when no position is given', () => {
    const next = addTabToGroup([group('a', ['t1', 't2'])], 'a', 't3')
    expect(findGroup(next, 'a')?.tabIds).toEqual(['t1', 't2', 't3'])
  })

  it('inserts at the position asked for', () => {
    const next = addTabToGroup([group('a', ['t1', 't2'])], 'a', 't3', 1)
    expect(findGroup(next, 'a')?.tabIds).toEqual(['t1', 't3', 't2'])
  })

  it('clamps a position outside the group', () => {
    const start = [group('a', ['t1', 't2'])]
    expect(findGroup(addTabToGroup(start, 'a', 't3', -5), 'a')?.tabIds).toEqual(['t3', 't1', 't2'])
    expect(findGroup(addTabToGroup(start, 'a', 't3', 99), 'a')?.tabIds).toEqual(['t1', 't2', 't3'])
    expect(findGroup(addTabToGroup(start, 'a', 't3', Number.NaN), 'a')?.tabIds).toEqual([
      't3',
      't1',
      't2'
    ])
  })

  it('never holds the same tab twice', () => {
    const once = addTabToGroup([group('a', ['t1'])], 'a', 't2')
    const twice = addTabToGroup(once, 'a', 't2', 0)
    expect(findGroup(twice, 'a')?.tabIds).toEqual(['t2', 't1'])
  })

  it('changes nothing when the tab is already a member and no position was asked for', () => {
    const start = [group('a', ['t1', 't2'])]
    expect(addTabToGroup(start, 'a', 't1')).toEqual(start)
  })

  it('repositions a member when a position is asked for', () => {
    const next = addTabToGroup([group('a', ['t1', 't2', 't3'])], 'a', 't3', 0)
    expect(findGroup(next, 'a')?.tabIds).toEqual(['t3', 't1', 't2'])
  })

  it('survives repositioning the only member of a group', () => {
    // The trap this guards: stripping the tab from every group first would empty the
    // target, and the no-empty-group rule would then dissolve the group being reordered.
    const next = addTabToGroup([group('a', ['t1'])], 'a', 't1', 0)
    expect(ids(next)).toEqual(['a'])
    expect(findGroup(next, 'a')?.tabIds).toEqual(['t1'])
  })

  it('moves the tab out of the group that held it', () => {
    const next = addTabToGroup([group('a', ['t1', 't2']), group('b', ['t3'])], 'b', 't1')
    expect(findGroup(next, 'a')?.tabIds).toEqual(['t2'])
    expect(findGroup(next, 'b')?.tabIds).toEqual(['t3', 't1'])
  })

  it('dissolves the group whose last tab moved away', () => {
    const next = addTabToGroup([group('a', ['t1']), group('b', ['t2'])], 'b', 't1')
    expect(ids(next)).toEqual(['b'])
    expect(findGroup(next, 'b')?.tabIds).toEqual(['t2', 't1'])
  })

  it('keeps a tab in at most one group', () => {
    const next = addTabToGroup([group('a', ['t1', 't9']), group('b', ['t2'])], 'b', 't1')
    expect(next.filter((entry) => entry.tabIds.includes('t1'))).toHaveLength(1)
    expect(groupOfTab(next, 't1')?.id).toBe('b')
  })

  it('reports a group it does not have', () => {
    expect(() => addTabToGroup([group('a', ['t1'])], 'zz', 't1')).toThrow(TabGroupNotFoundError)
  })
})

describe('a tab leaving a group', () => {
  it('removes the member and keeps the group', () => {
    const next = removeTabFromGroup([group('a', ['t1', 't2'])], 't1')
    expect(findGroup(next, 'a')?.tabIds).toEqual(['t2'])
  })

  it('dissolves the group when the last tab leaves', () => {
    // An empty group is a ghost in the strip: nothing to draw a bracket around, no way
    // to rename it, no way to drop into it.
    const next = removeTabFromGroup([group('a', ['t1']), group('b', ['t2'])], 't1')
    expect(ids(next)).toEqual(['b'])
  })

  it('changes nothing for a tab that is in no group', () => {
    const start = [group('a', ['t1'])]
    expect(removeTabFromGroup(start, 'stranger')).toEqual(start)
  })

  it('is also the path a closed tab takes', () => {
    // Closing a tab is "it leaves its group" plus "it is gone", so the close path cannot
    // leave a ghost either — and it does not have to know whether the tab was grouped.
    const closedLast = removeTabFromGroup([group('a', ['t1'])], 't1')
    expect(closedLast).toEqual([])
  })

  it('finds the owner of a tab, and nothing for an ungrouped one', () => {
    const groups = [group('a', ['t1']), group('b', ['t2'])]
    expect(groupOfTab(groups, 't2')?.id).toBe('b')
    expect(groupOfTab(groups, 't7')).toBeUndefined()
  })
})

describe('the contiguity rule', () => {
  it('pulls a scattered group together where its first member sits', () => {
    // The group stays put and the joining tab is drawn to it, rather than the group
    // jumping to wherever the tab happened to be.
    const groups = [group('a', ['t1', 't4'])]
    expect(contiguousOrder(['t1', 't2', 't3', 't4'], groups)).toEqual(['t1', 't4', 't2', 't3'])
  })

  it('lays members out in the group’s own order, not the strip’s', () => {
    const groups = [group('a', ['t4', 't1'])]
    expect(contiguousOrder(['t1', 't2', 't4'], groups)).toEqual(['t4', 't1', 't2'])
  })

  it('keeps the relative order of everything ungrouped', () => {
    const groups = [group('a', ['t2'])]
    expect(contiguousOrder(['t1', 't2', 't3'], groups)).toEqual(['t1', 't2', 't3'])
  })

  it('makes runs out of two interleaved groups', () => {
    const groups = [group('a', ['t1', 't3']), group('b', ['t2', 't4'])]
    expect(contiguousOrder(['t1', 't2', 't3', 't4'], groups)).toEqual(['t1', 't3', 't2', 't4'])
  })

  it('never conjures a member the window does not have', () => {
    // A group whose other tabs live in another window, or a stale id from the file.
    const groups = [group('a', ['t1', 'elsewhere'])]
    expect(contiguousOrder(['t1', 't2'], groups)).toEqual(['t1', 't2'])
  })

  it('drops a duplicate in the order it was given', () => {
    expect(contiguousOrder(['t1', 't1', 't2'], [])).toEqual(['t1', 't2'])
  })

  it('is idempotent', () => {
    const groups = [group('a', ['t1', 't4']), group('b', ['t2'])]
    const once = contiguousOrder(['t1', 't2', 't3', 't4'], groups)
    expect(contiguousOrder(once, groups)).toEqual(once)
  })

  it('recognises an order that already obeys the rule', () => {
    const groups = [group('a', ['t1', 't2']), group('b', ['t4'])]
    expect(isContiguous(['t1', 't2', 't3', 't4'], groups)).toBe(true)
    expect(isContiguous(['t3', 't1', 't2', 't4'], groups)).toBe(true)
  })

  it('recognises a split group', () => {
    const groups = [group('a', ['t1', 't3'])]
    expect(isContiguous(['t1', 't2', 't3'], groups)).toBe(false)
  })

  it('accepts a run whose members are in another order than the group lists them', () => {
    // Contiguity is about adjacency only; normalising the order inside a run is
    // `contiguousOrder`'s job, and calling that a violation would make the core reorder
    // the strip on every broadcast.
    const groups = [group('a', ['t1', 't2'])]
    expect(isContiguous(['t2', 't1'], groups)).toBe(true)
  })

  it('accepts an order with no groups at all', () => {
    expect(isContiguous(['t1', 't2'], [])).toBe(true)
    expect(contiguousOrder([], [group('a', ['t1'])])).toEqual([])
  })

  it('ignores a group that claims a tab a later group already holds', () => {
    // First claim wins, the same rule `groupOfTab` and `repairGroups` use, so a
    // document that slipped past repair still produces one answer rather than two.
    const groups = [group('a', ['t1']), group('b', ['t1', 't2'])]
    expect(contiguousOrder(['t1', 't2'], groups)).toEqual(['t1', 't2'])
    expect(isContiguous(['t1', 't2'], groups)).toBe(true)
  })
})

describe('collapsing and expanding', () => {
  const collapsed = [group('a', ['t1', 't2'], { collapsed: true }), group('b', ['t3'])]

  it('collapses and expands a group', () => {
    const expanded = setGroupCollapsed(collapsed, 'a', false)
    expect(findGroup(expanded, 'a')?.collapsed).toBe(false)
    expect(findGroup(setGroupCollapsed(expanded, 'a', true), 'a')?.collapsed).toBe(true)
  })

  it('names the tabs that must give up their tile', () => {
    // Spec 2's rule, applied here: a tab the strip is not showing must hold no tile, and
    // it is detached rather than closed. The core unassigns exactly these.
    expect(tabsHiddenByCollapse(collapsed)).toEqual(['t1', 't2'])
    expect(tabsHiddenByCollapse([group('b', ['t3'])])).toEqual([])
  })

  it('answers per tab whether it may hold a tile', () => {
    expect(isTabHidden(collapsed, 't1')).toBe(true)
    expect(isTabHidden(collapsed, 't3')).toBe(false)
    expect(isTabHidden(collapsed, 'ungrouped')).toBe(false)
  })

  it('leaves a collapsed group’s tabs out of what the strip renders', () => {
    expect(visibleTabOrder(['t1', 't2', 't3', 't4'], collapsed)).toEqual(['t3', 't4'])
  })

  it('brings them back on expanding, in the same places', () => {
    const order = ['t1', 't2', 't3', 't4']
    const expanded = setGroupCollapsed(collapsed, 'a', false)
    expect(visibleTabOrder(order, expanded)).toEqual(contiguousOrder(order, expanded))
    expect(visibleTabOrder(order, expanded)).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('keeps the tabs in the group while it is collapsed', () => {
    // Collapsing is a display state, not a lifecycle event: nothing leaves the group and
    // nothing is closed.
    expect(findGroup(collapsed, 'a')?.tabIds).toEqual(['t1', 't2'])
  })

  it('still applies the contiguity rule to a collapsed group', () => {
    const scattered = [group('a', ['t1', 't3'], { collapsed: true })]
    expect(visibleTabOrder(['t1', 't2', 't3'], scattered)).toEqual(['t2'])
  })
})

describe('reconciling a loaded document with the tabs a window has', () => {
  it('keeps only the members that came back', () => {
    const groups = [group('a', ['t1', 't2', 't3'])]
    expect(retainTabs(groups, ['t3', 't1'])[0]?.tabIds).toEqual(['t1', 't3'])
  })

  it('dissolves a group none of whose tabs came back', () => {
    const groups = [group('a', ['t1']), group('b', ['t2'])]
    expect(ids(retainTabs(groups, ['t2']))).toEqual(['b'])
  })

  it('drops everything on a cold start, because tab ids start over', () => {
    // `nextTabId` counts from `tab-1` again on every launch, so a stored membership of
    // `['tab-1']` would otherwise capture whatever the next launch opens first.
    expect(retainTabs([group('a', ['tab-1'])], [])).toEqual([])
  })
})

describe('repairing a document that was written by something else', () => {
  it('leaves a healthy document alone', () => {
    const groups = [group('a', ['t1', 't2']), group('b', ['t3'])]
    expect(repairGroups(groups)).toEqual(groups)
  })

  it('drops a second group claiming an id the first one has', () => {
    const repaired = repairGroups([group('a', ['t1']), group('a', ['t2'])])
    expect(ids(repaired)).toEqual(['a'])
    expect(repaired[0]?.tabIds).toEqual(['t1'])
  })

  it('gives a tab claimed twice to the group that claimed it first', () => {
    const repaired = repairGroups([group('a', ['t1']), group('b', ['t1', 't2'])])
    expect(repaired.map((entry) => entry.tabIds)).toEqual([['t1'], ['t2']])
  })

  it('drops a group left with nothing after that', () => {
    const repaired = repairGroups([group('a', ['t1']), group('b', ['t1'])])
    expect(ids(repaired)).toEqual(['a'])
  })

  it('drops a tab listed twice in one group', () => {
    expect(repairGroups([group('a', ['t1', 't1', 't2'])])[0]?.tabIds).toEqual(['t1', 't2'])
  })

  it('drops a group with no tabs at all', () => {
    expect(ids(repairGroups([group('a', []), group('b', ['t1'])]))).toEqual(['b'])
  })

  it('trims a name longer than the limit instead of rejecting the file', () => {
    const repaired = repairGroups([group('a', ['t1'], { name: ' z'.repeat(120) })])
    expect(repaired[0]?.name.length).toBe(MAX_TAB_GROUP_NAME_LENGTH)
  })

  it('trims a file with more groups than the cap instead of losing all of them', () => {
    const tooMany = Array.from({ length: MAX_TAB_GROUPS + 5 }, (_, index) =>
      group(`g${index}`, [`t${index}`])
    )
    const repaired = repairGroups(tooMany)
    expect(repaired).toHaveLength(MAX_TAB_GROUPS)
    expect(repaired[0]?.id).toBe('g0')
  })

  it('produces a document every rule then holds for', () => {
    const messy = [
      group('a', ['t1', 't1']),
      group('a', ['t9']),
      group('b', ['t1', 't2']),
      group('c', [])
    ]
    const repaired = repairGroups(messy)
    for (const entry of repaired) {
      expect(entry.tabIds.length).toBeGreaterThan(0)
      expect(new Set(entry.tabIds).size).toBe(entry.tabIds.length)
    }
    expect(new Set(ids(repaired)).size).toBe(repaired.length)
    const allTabs = repaired.flatMap((entry) => entry.tabIds)
    expect(new Set(allTabs).size).toBe(allTabs.length)
  })
})
