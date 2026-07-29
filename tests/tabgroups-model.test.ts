import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EmptyTabGroupError,
  MAX_TAB_GROUPS,
  MAX_TAB_GROUP_NAME_LENGTH,
  MIN_ARRANGED_TILES,
  TabGroupLimitError,
  TabGroupNotFoundError,
  addGroup,
  addTabToGroup,
  arrangedTabs,
  arrangementIsCurrent,
  contiguousOrder,
  dissolveGroup,
  emptyTabGroupDocument,
  findGroup,
  groupOfTab,
  groupToHoldArrangement,
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
  setGroupLayout,
  tabsHiddenByCollapse,
  tabsToAbsorb,
  visibleTabOrder,
  type TabGroup,
  type TabGroupLayout
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

  /**
   * The one module outside the directory these files may name.
   *
   * `split/layout.ts` is what *defines* a layout id, and a group that records the arrangement its tabs
   * were displaced from has to speak the same seven names — a local copy of them would be a second
   * source of truth for the shape of the window. It costs the bundle nothing: it is pure, zod-free,
   * dependency-free by its own docblock, and `LayoutIcon`, `LayoutMenu` and `SplitDividers` already
   * import it, so the strip's neighbours have loaded it either way.
   *
   * An allowance rather than dropping the rule, because what the rule is really for survives: no
   * `@main/`, nothing with a transitive dependency, nothing that pulls a validator into a bundle the
   * user waits for.
   */
  const ALLOWED_OUTSIDE = new Set(['../split/layout.js'])

  it('keeps the renderer-facing files inside their own directory', () => {
    // A dependency here is a dependency in the UI bundle. Staying within the directory is stricter
    // than needed and cheap to keep, and it makes an accidental `@main/` import impossible.
    for (const name of RENDERER_FACING) {
      const text = readFileSync(join(directory, name), 'utf8')
      const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
      for (const specifier of specifiers) {
        if (specifier !== undefined && ALLOWED_OUTSIDE.has(specifier)) continue
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

describe('the arrangement a group keeps', () => {
  /**
   * A four-pane arrangement over the four tabs named.
   *
   * `2x2` rather than `1x4` on purpose: both have four tiles, so a test that passed with the count
   * inferred from the array would still be checking something.
   */
  function quad(tiles: Array<string | null>): TabGroupLayout {
    return { id: '2x2', tiles }
  }

  it('is carried by a group created to remember it', () => {
    /*
      The write path the capture uses. Set at creation rather than by a second call, so the group reaches
      the strip complete — broadcast once without its arrangement and once with it, a click arriving
      between the two would take the old path and the arrangement would be lost in the moment it was
      being saved.
    */
    const created = newTabGroup(
      [],
      { tabIds: ['a', 'b'], layout: quad(['a', 'b', null, null]) },
      {
        id: 'g',
        now: T0
      }
    )
    expect(created.layout).toEqual(quad(['a', 'b', null, null]))
  })

  it('is absent, not undefined, on a group made without one', () => {
    // `exactOptionalPropertyTypes` is on and the difference reaches the disk: a key present with an
    // `undefined` value is written to the document as a key, and every file written before this feature
    // existed has none.
    const created = newTabGroup([], { tabIds: ['a'] }, { id: 'g', now: T0 })
    expect(Object.hasOwn(created, 'layout')).toBe(false)
  })

  it('is refused when it names a tab the group does not have', () => {
    // A seat nobody can fill, and worse than nothing: on the way back it would still evict whatever is
    // in that tile, so a stale id costs a page rather than leaving a pane empty.
    const created = newTabGroup(
      [],
      { tabIds: ['a', 'b'], layout: quad(['a', 'b', 'stranger', null]) },
      {
        id: 'g',
        now: T0
      }
    )
    expect(created.layout).toBeUndefined()
  })

  it('is recorded on a group that already exists', () => {
    const groups = setGroupLayout([group('g', ['a', 'b'])], 'g', quad(['a', null, 'b', null]))
    expect(findGroup(groups, 'g')?.layout).toEqual(quad(['a', null, 'b', null]))
  })

  it('can be cleared again, although nothing in the browser clears it any more', () => {
    /*
      The primitive outliving its caller, on purpose. `null` used to be the other half of the feature —
      a restore spent the recording it used — and `takeArrangementFor` stopped doing that when the
      arrangement became something maintained on every settle rather than a snapshot of one
      displacement.

      Kept and tested anyway, because clearing the field has to have exactly one gate. The next caller
      that wants it — a group told to forget its layout, a recording the schema healed away — must find
      the rule here instead of writing a second way to set the field, which is what `withLayout` and
      `sanitisedLayout` exist to prevent.
    */
    const recorded = setGroupLayout([group('g', ['a', 'b'])], 'g', quad(['a', 'b', null, null]))
    const cleared = setGroupLayout(recorded, 'g', null)
    expect(Object.hasOwn(cleared[0]!, 'layout')).toBe(false)
  })

  it('is refused when it has the wrong number of tiles for its layout', () => {
    // `2x2` has four. Three would leave the last pane out of the recording and unaccounted for on the
    // way back; five would silently drop a member.
    const groups = setGroupLayout([group('g', ['a', 'b'])], 'g', {
      id: '2x2',
      tiles: ['a', 'b', null]
    })
    expect(findGroup(groups, 'g')?.layout).toBeUndefined()
  })

  it('is refused when it seats one tab in two tiles', () => {
    /*
      One tab cannot be in two places, and the failure is not a caught error but a wrong arrangement:
      `assignTab` moves a tab rather than copying it, so the first tile would end up empty and what came
      back would not be what was recorded.
    */
    const groups = setGroupLayout([group('g', ['a', 'b'])], 'g', quad(['a', 'a', 'b', null]))
    expect(findGroup(groups, 'g')?.layout).toBeUndefined()
  })

  it('is refused when it seats fewer tabs than an arrangement needs', () => {
    // One page in one pane is not an arrangement — it is the single view the browser is switching to
    // anyway. Recording it would make a group out of every new tab.
    expect(MIN_ARRANGED_TILES).toBe(2)
    const groups = setGroupLayout([group('g', ['a', 'b'])], 'g', quad(['a', null, null, null]))
    expect(findGroup(groups, 'g')?.layout).toBeUndefined()
  })

  it('empties the tile of a member that leaves, and moves nobody else', () => {
    /*
      Why `tiles` is positional. Closing the gap would answer "put it back the way it was" by sliding two
      pages that never moved — the user closes one tab of four and the other three come back in different
      panes.
    */
    const recorded = setGroupLayout([group('g', ['a', 'b', 'c'])], 'g', quad(['a', 'b', 'c', null]))
    const after = removeTabFromGroup(recorded, 'b')
    expect(findGroup(after, 'g')?.layout).toEqual(quad(['a', null, 'c', null]))
  })

  it('drops the recording when too few members are left to seat', () => {
    // Applying a four-pane layout to seat one page would put three empty panes on screen, which is the
    // outcome the split rules exist to prevent. Nothing left to restore, so nothing is kept.
    const recorded = setGroupLayout(
      [group('g', ['a', 'b', 'c'])],
      'g',
      quad(['a', 'b', null, null])
    )
    const after = removeTabFromGroup(recorded, 'b')
    expect(findGroup(after, 'g')?.layout).toBeUndefined()
    // The group itself survives: it still has members, and losing an arrangement must not cost tabs.
    expect(findGroup(after, 'g')?.tabIds).toEqual(['a', 'c'])
  })

  it('drops the recording for members a launch did not bring back', () => {
    // Same rule down the other path. Tab ids restart at `tab-1` every launch, so a stored arrangement
    // naming ids nothing came back under would otherwise seat whichever fresh tabs took those ids.
    const recorded = setGroupLayout([group('g', ['a', 'b', 'c'])], 'g', quad(['a', 'b', 'c', null]))
    const after = retainTabs(recorded, ['a', 'b'])
    expect(findGroup(after, 'g')?.layout).toEqual(quad(['a', 'b', null, null]))
  })

  it('stores a copy of the arrangement, not the array it was handed', () => {
    // The array comes from the split controller, which goes on owning its own tiles. Storing it would make
    // the document change on its own the next time a tab moved — a recording that silently follows the
    // window is not a way back to anywhere.
    const tiles: Array<string | null> = ['a', 'b', null, null]
    const recorded = setGroupLayout([group('g', ['a', 'b'])], 'g', { id: '2x2', tiles })
    tiles[0] = 'moved-on'
    expect(recorded[0]?.layout?.tiles[0]).toBe('a')
  })

  it('hands out an arrangement no earlier result shares', () => {
    // `tiles` is the second array on a group and needs what `tabIds` gets. Shared, a store's "previous" and
    // "next" documents come out as the same object, and a change that has to be diffed cannot be seen.
    const recorded = setGroupLayout([group('g', ['a', 'b'])], 'g', quad(['a', 'b', null, null]))
    const renamed = renameGroup(recorded, 'g', 'Work')
    renamed[0]!.layout!.tiles[1] = 'tampered'
    expect(recorded[0]?.layout?.tiles[1]).toBe('b')
  })

  it('names its seated members in tile order, skipping the empty tiles', () => {
    expect(arrangedTabs(quad(['a', null, 'b', 'c']))).toEqual(['a', 'b', 'c'])
  })
})

describe('deciding which group keeps an arrangement', () => {
  const quad = (tiles: Array<string | null>): TabGroupLayout => ({ id: '2x2', tiles })

  it('makes a group when none of the tabs is in one', () => {
    // The ordinary case: four panes of ungrouped tabs, and the request is that they stay together.
    expect(groupToHoldArrangement([], quad(['a', 'b', 'c', 'd']))).toEqual({ kind: 'create' })
  })

  it('reuses the group that already holds all of them', () => {
    /*
      What keeps this from being group spam. A window collapsed, restored and collapsed again reuses the
      group it made the first time — keeping its colour and any name the user has given it — instead of
      leaving a trail of one chip per new tab down the strip.
    */
    const groups = [group('g', ['a', 'b', 'c'])]
    expect(groupToHoldArrangement(groups, quad(['a', 'b', null, null]))).toEqual({
      kind: 'reuse',
      groupId: 'g'
    })
  })

  it('takes the group that is already there when the rest of the panes are loose tabs', () => {
    /*
      The reversal, and it is the user's decision of 29.07.2026 rather than a refinement:
      "immer die bestehende Gruppe nehmen." This case used to answer `none`, on the grounds that
      remembering a layout must not edit a group the user built by hand.

      What changed is what a group *is*. A multi-view is now a group, so the tabs sharing the panes are
      its membership, and a run that has picked up a loose tab is the group catching up rather than the
      browser rewriting something. The destructive half of the old argument does not apply either: the
      loose tabs join through `addTabToGroup`, which takes nothing from anybody, where `addGroup` would
      have taken these members away from the group that already holds them.
    */
    const groups = [group('work', ['a', 'b'], { name: 'Steuererklärung 2026' })]
    expect(groupToHoldArrangement(groups, quad(['a', 'b', 'loose', null]))).toEqual({
      kind: 'reuse',
      groupId: 'work'
    })
    // And it is the *existing* group rather than a new one over the same tabs, which is what keeps the
    // name and the colour the user gave it.
    expect(findGroup(groups, 'work')?.name).toBe('Steuererklärung 2026')
  })

  it('names the loose tabs that have to join, and only those', () => {
    // The other half of the absorb case. A member that is already in the group must not be handed to
    // `addTab` again: with no index that is a no-op, but it is a store write, and a write publishes.
    const groups = [group('work', ['a', 'b'])]
    expect(tabsToAbsorb(groups, 'work', quad(['a', 'b', 'loose', null]))).toEqual(['loose'])
    expect(tabsToAbsorb(groups, 'work', quad(['a', 'b', null, null]))).toEqual([])
  })

  it('keeps nothing when the tabs are spread over two groups', () => {
    /*
      The one case that stays refused, and deliberately a narrower exception than the rule above
      replaced. What the user decided was about group members mixed with *loose* tabs; this is two
      groups they built, and honouring it would merge them — `addTabToGroup` dissolves a source group
      it empties, so the loser's name, colour and identity go with no undo.

      Forgetting an arrangement costs one drag. That does not.
    */
    const groups = [group('one', ['a']), group('two', ['b'])]
    expect(groupToHoldArrangement(groups, quad(['a', 'b', null, null]))).toEqual({ kind: 'none' })
    // Including when loose tabs are in the mix as well: one group plus loose absorbs, two groups plus
    // loose still refuses, because it is the second group that makes it destructive.
    const withLoose = [group('one', ['a']), group('two', ['b'])]
    expect(groupToHoldArrangement(withLoose, quad(['a', 'b', 'loose', null]))).toEqual({
      kind: 'none'
    })
  })

  it('keeps nothing when only one pane held anything', () => {
    // Same floor as the write path, applied here so "is this worth keeping" and "where would it go"
    // cannot answer differently.
    expect(groupToHoldArrangement([], quad(['a', null, null, null]))).toEqual({ kind: 'none' })
  })

  it('keeps nothing rather than asking for a group past the cap', () => {
    /*
      The bug this rules out is not a lost arrangement but a browser that cannot open a tab. This caller
      is not a user pressing a button: `newTabGroup` throws past the cap, and the throw would travel up
      through `claimTileForNewTab` into `createTab`, so at fifty groups "new tab" would fail outright.
    */
    const full = Array.from({ length: MAX_TAB_GROUPS }, (_, index) =>
      group(`g${index}`, [`x${index}`])
    )
    expect(groupToHoldArrangement(full, quad(['a', 'b', null, null]))).toEqual({ kind: 'none' })
    // Reusing costs no group, so a window at the cap can still record onto one it already has.
    const atCap = [...full.slice(1), group('holder', ['a', 'b'])]
    expect(groupToHoldArrangement(atCap, quad(['a', 'b', null, null]))).toEqual({
      kind: 'reuse',
      groupId: 'holder'
    })
  })
})

describe('deciding that there is nothing to write', () => {
  /*
    The gate that makes "maintain the arrangement on every settle" affordable.

    The pass runs from the window's coalesced broadcast round, which fires on every title change and
    every navigation event. Two things go wrong without a "nothing changed" answer, and neither is
    theoretical: the debounced store is handed a document every time, and — because a write publishes
    and the pass runs inside a publish — the round schedules the next round for ever.
  */
  const quad = (tiles: Array<string | null>): TabGroupLayout => ({ id: '2x2', tiles })
  const pair = (tiles: Array<string | null>): TabGroupLayout => ({ id: '1x2', tiles })

  it('is current when the holder already carries exactly this arrangement', () => {
    const layout = quad(['a', 'b', null, null])
    const groups = [group('g', ['a', 'b'], { layout })]
    expect(arrangementIsCurrent(groups, layout)).toBe(true)
  })

  it('is current although a group with nothing to do with the panes is listed first', () => {
    /*
      The window a real user has: one group holding the tiled pages, and others further up the strip
      that are not in any pane. Only groups with a *seated* member can make the decision ambiguous,
      so an unrelated one must be passed over rather than counted — and it has to be looked at
      first, because a check that stops at the first group would answer correctly by luck if the
      holder happened to be at index 0. That is also the pass-over branch that keeps the lookup in
      `arrangementIsCurrent` honest instead of guarding a group id that cannot go missing.
    */
    const layout = quad(['a', 'b', null, null])
    const groups = [group('elsewhere', ['x', 'y']), group('g', ['a', 'b'], { layout })]
    expect(arrangementIsCurrent(groups, layout)).toBe(true)
  })

  it('is not current when the same members sit in different panes', () => {
    // Element by element, because `tiles` is positional. Compared as a set, dragging one page from the
    // left pane to the right would leave the recording describing the arrangement before the drag —
    // and the next click on a member would undo it.
    const groups = [group('g', ['a', 'b'], { layout: pair(['a', 'b']) })]
    expect(arrangementIsCurrent(groups, pair(['b', 'a']))).toBe(false)
  })

  it('is not current when the layout changed under the same seating', () => {
    // `2x2` and `1x4` both have four tiles, so the id cannot be inferred from the array and the array
    // cannot stand in for the id.
    const groups = [group('g', ['a', 'b'], { layout: quad(['a', 'b', null, null]) })]
    expect(arrangementIsCurrent(groups, { id: '1x4', tiles: ['a', 'b', null, null] })).toBe(false)
  })

  it('is not current while a loose tab has still to join', () => {
    // The absorb case would never happen otherwise: the tiles a group already carries can only name
    // its own members, so a comparison of arrangements alone would answer "nothing to do" for a pane
    // holding a tab the group has never heard of.
    const groups = [group('g', ['a', 'b'], { layout: quad(['a', 'b', null, null]) })]
    expect(arrangementIsCurrent(groups, quad(['a', 'b', 'loose', null]))).toBe(false)
  })

  it('is not current when the holder is carrying nothing yet', () => {
    expect(arrangementIsCurrent([group('g', ['a', 'b'])], quad(['a', 'b', null, null]))).toBe(false)
  })

  it('is never current when a group would have to be made, or when nothing is kept', () => {
    // Two answers that are not "reuse", and neither has a group to compare against. Asserted so a
    // future short-circuit cannot make the create path silently stop creating.
    expect(arrangementIsCurrent([], quad(['a', 'b', null, null]))).toBe(false)
    const twoGroups = [group('one', ['a']), group('two', ['b'])]
    expect(arrangementIsCurrent(twoGroups, quad(['a', 'b', null, null]))).toBe(false)
  })

  it('is not current for an arrangement too small to be one', () => {
    // Below `MIN_ARRANGED_TILES` the holder is `none`, so the answer is "not current" rather than
    // "current". The caller must not read it as permission to write: it refuses on `none` first.
    const groups = [group('g', ['a', 'b'], { layout: quad(['a', 'b', null, null]) })]
    expect(arrangementIsCurrent(groups, quad(['a', null, null, null]))).toBe(false)
    expect(groupToHoldArrangement(groups, quad(['a', null, null, null]))).toEqual({ kind: 'none' })
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

  it('accepts a document with no arrangement anywhere in it', () => {
    // Every file this browser has written so far. The field arrived after them, so its absence is the
    // normal state and must not read as damage — repairing it away would be harmless, rejecting the
    // document over it would cost the user every group.
    const groups = [group('a', ['t1', 't2'])]
    expect(repairGroups(groups)).toEqual(groups)
    expect(Object.hasOwn(repairGroups(groups)[0]!, 'layout')).toBe(false)
  })

  it('keeps an arrangement that describes its group', () => {
    // Asserted alongside the rejections below, because a repair that dropped every arrangement would pass
    // all of them and quietly disable the feature on the first launch after a restart.
    const layout: TabGroupLayout = { id: '1x2', tiles: ['t1', 't2'] }
    const repaired = repairGroups([group('a', ['t1', 't2'], { layout })])
    expect(repaired[0]?.layout).toEqual(layout)
  })

  it('drops an arrangement with the wrong number of tiles for its layout', () => {
    // Honoured, it would leave the last pane of a `2x2` unaccounted for on the way back. The layout id
    // and the tile count cannot check each other — `2x2` and `1x4` both have four — so this is the only
    // place it is caught.
    const layout: TabGroupLayout = { id: '2x2', tiles: ['t1', 't2'] }
    const repaired = repairGroups([group('a', ['t1', 't2'], { layout })])
    expect(repaired[0]?.layout).toBeUndefined()
    // The group and its tabs survive. Losing an arrangement costs a drag; losing a group costs eleven
    // loaded pages and a name.
    expect(repaired[0]?.tabIds).toEqual(['t1', 't2'])
  })

  it('drops an arrangement naming a tab the group does not have', () => {
    const layout: TabGroupLayout = { id: '1x2', tiles: ['t1', 'stranger'] }
    const repaired = repairGroups([group('a', ['t1', 't2'], { layout })])
    expect(repaired[0]?.layout).toBeUndefined()
  })

  it('drops an arrangement naming a tab this pass has just taken off the group', () => {
    /*
      The two repairs meeting, and the order that makes it work. `t1` is claimed by the first group, so the
      second loses it — and the second group's arrangement still seats it. Validated against the *repaired*
      member list rather than the one in the file, or the recording would survive naming a tab the group no
      longer has.
    */
    const layout: TabGroupLayout = { id: '1x2', tiles: ['t1', 't2'] }
    const repaired = repairGroups([group('a', ['t1']), group('b', ['t1', 't2'], { layout })])
    expect(repaired[1]?.tabIds).toEqual(['t2'])
    expect(repaired[1]?.layout).toBeUndefined()
  })

  it('drops an arrangement that seats one tab in two tiles', () => {
    const layout: TabGroupLayout = { id: '1x2', tiles: ['t1', 't1'] }
    const repaired = repairGroups([group('a', ['t1', 't2'], { layout })])
    expect(repaired[0]?.layout).toBeUndefined()
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
