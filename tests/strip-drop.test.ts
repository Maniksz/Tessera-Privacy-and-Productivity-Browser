import { describe, expect, it } from 'vitest'
import {
  resolveStripDrop,
  type StripDrop,
  type StripDropPlan,
  type StripDropSide,
  type StripDropSubject,
  type StripDropTarget
} from '@shared/strip/drop.js'
import { stripDropSchema, stripInvokeContract } from '@shared/strip/schema.js'
import type { StripArrangement } from '@shared/strip/model.js'
import type { TabGroup } from '@shared/tabgroups/model.js'

/**
 * A drop in the tab strip, resolved (U9, R12, KTD7): what the order and the groups are after a tab or a
 * tiled view's entry is let go before or after a tab, an entry, a chip, or at the end of the strip.
 *
 * What goes wrong in the product when a rule here is wrong:
 *
 *   - **A drop counted as an index into drawn tabs** lands one place per folded tab too far left, because
 *     the core inserted it into an order that holds the tabs a folded group hides. The drop is a target
 *     and a side now, and the regression case below is that bug.
 *   - **A drop between members that does not join** is pulled back out of the group by the settle, so
 *     the tab jumps to one end of the run — which is what dragging into a group did before.
 *   - **A view that joins member by member** splits into two brackets, or leaves one page in the old
 *     group, and folding the group then hides half of it (R10).
 */

function group(overrides: Partial<TabGroup> & { id: string; tabIds: string[] }): TabGroup {
  return { name: '', color: 'blue', collapsed: false, createdAt: 1, ...overrides }
}

function view(id: string, tabIds: string[]): StripArrangement {
  return { id, tabIds, activeTabId: tabIds[0] ?? null }
}

const tab = (tabId: string): { kind: 'tab'; tabId: string } => ({ kind: 'tab', tabId })
const split = (arrangementId: string): { kind: 'split'; arrangementId: string } => ({
  kind: 'split',
  arrangementId
})
const chip = (groupId: string): StripDropTarget => ({ kind: 'group', groupId })
const END: StripDropTarget = { kind: 'end' }

function drop(
  order: string[],
  groups: TabGroup[],
  subject: StripDropSubject,
  target: StripDropTarget,
  side: StripDropSide,
  arrangements: StripArrangement[] = []
): StripDropPlan | null {
  return resolveStripDrop(order, groups, arrangements, { subject, target, side })
}

describe('joining a group (R12, KTD7)', () => {
  it('takes a loose tab dropped between two members into the group, at that place', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    const plan = drop(['X', 'a', 'b'], [G], tab('X'), tab('b'), 'before')
    expect(plan).toEqual({ tabIds: ['X'], order: ['a', 'X', 'b'], groupId: 'G', index: 1 })
    // The other side of the same gap says the same.
    expect(drop(['X', 'a', 'b'], [G], tab('X'), tab('a'), 'after')).toEqual(plan)
  })

  it('keeps the group where it stands when the joining tab came from before it', () => {
    // `contiguousOrder` puts a group at its earliest member, so a tab joined without moving it in the
    // order would drag the whole group back past Y.
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    expect(drop(['X', 'Y', 'a', 'b'], [G], tab('X'), tab('a'), 'after')?.order).toEqual([
      'Y',
      'a',
      'X',
      'b'
    ])
  })

  it('takes a tab dropped behind the last member into the group when the group ends the strip', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    expect(drop(['X', 'a', 'b'], [G], tab('X'), tab('b'), 'after')).toEqual({
      tabIds: ['X'],
      order: ['a', 'b', 'X'],
      groupId: 'G',
      index: 2
    })
  })

  it('puts a tab dropped just behind an open chip first in its group', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    expect(drop(['a', 'b', 'X'], [G], tab('X'), chip('G'), 'after')).toEqual({
      tabIds: ['X'],
      order: ['X', 'a', 'b'],
      groupId: 'G',
      index: 0
    })
  })

  it('puts a tab dropped onto a folded chip last in its group', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'], collapsed: true })
    expect(drop(['X', 'a', 'b', 'Y'], [G], tab('X'), chip('G'), 'after')).toEqual({
      tabIds: ['X'],
      order: ['a', 'b', 'X', 'Y'],
      groupId: 'G',
      index: 2
    })
  })

  it('takes a tab dropped beside a tiled view inside a group into that group', () => {
    const G = group({ id: 'G', tabIds: ['a', 'A1', 'A2'] })
    expect(
      drop(['X', 'a', 'A1', 'A2'], [G], tab('X'), split('A'), 'before', [view('A', ['A1', 'A2'])])
    ).toEqual({ tabIds: ['X'], order: ['a', 'X', 'A1', 'A2'], groupId: 'G', index: 1 })
  })

  it('reorders a member inside its own group, counted among the members that stay', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b', 'c'] })
    expect(drop(['a', 'b', 'c'], [G], tab('a'), tab('c'), 'after')).toEqual({
      tabIds: ['a'],
      order: ['b', 'c', 'a'],
      groupId: 'G',
      index: 2
    })
  })

  it('moves a member of one group into another', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    const H = group({ id: 'H', tabIds: ['h'] })
    expect(drop(['a', 'b', 'h'], [G, H], tab('a'), tab('h'), 'before')).toEqual({
      tabIds: ['a'],
      order: ['b', 'a', 'h'],
      groupId: 'H',
      index: 0
    })
  })

  it('takes a tab dropped behind a tiled view in a group into the group behind the whole view', () => {
    // Counted behind the view's last member, not its first: `index` is what the book writes, and a
    // place between the two would leave the group's own order disagreeing with the strip's.
    const G = group({ id: 'G', tabIds: ['a', 'A1', 'A2'] })
    expect(
      drop(['X', 'a', 'A1', 'A2'], [G], tab('X'), split('A'), 'after', [view('A', ['A1', 'A2'])])
    ).toEqual({ tabIds: ['X'], order: ['a', 'A1', 'A2', 'X'], groupId: 'G', index: 3 })
  })

  it.each([
    ['two', ['a', 'b']],
    ['one', ['a']]
  ])(
    'pulls a tab from before a folded group of %s in behind it, and leaves the group where it stands',
    (_label, members) => {
      // The tab joins at the far end of the chip; were it placed anywhere before the group, the group
      // would be gathered at its new earliest member and jump in front of Y.
      const G = group({ id: 'G', tabIds: members, collapsed: true })
      expect(drop(['X', 'Y', ...members, 'Z'], [G], tab('X'), chip('G'), 'after')).toEqual({
        tabIds: ['X'],
        order: ['Y', ...members, 'X', 'Z'],
        groupId: 'G',
        index: members.length
      })
    }
  )

  it('counts the place behind a folded chip among the members that stay', () => {
    // A member dropped back onto its own folded chip is last among the other two, not among three.
    const G = group({ id: 'G', tabIds: ['a', 'b', 'X'], collapsed: true })
    expect(drop(['a', 'b', 'X', 'Y'], [G], tab('X'), chip('G'), 'after')).toEqual({
      tabIds: ['X'],
      order: ['a', 'b', 'X', 'Y'],
      groupId: 'G',
      index: 2
    })
  })
})

describe('leaving a group (R12, KTD7)', () => {
  it('takes a member dropped before its chip out of the group, standing before it', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    expect(drop(['Y', 'a', 'b'], [G], tab('b'), chip('G'), 'before')).toEqual({
      tabIds: ['b'],
      order: ['Y', 'b', 'a'],
      groupId: null,
      index: 0
    })
  })

  it('takes a member dropped before its chip out of the group when the group opens the strip', () => {
    // The chip stands where the members that stay begin — the moving one has no seat to count.
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    expect(drop(['a', 'b', 'Y'], [G], tab('b'), chip('G'), 'before')).toEqual({
      tabIds: ['b'],
      order: ['b', 'a', 'Y'],
      groupId: null,
      index: 0
    })
  })

  it('keeps a tab dropped before a folded chip out of the group', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'], collapsed: true })
    expect(drop(['a', 'b', 'X'], [G], tab('X'), chip('G'), 'before')).toEqual({
      tabIds: ['X'],
      order: ['X', 'a', 'b'],
      groupId: null,
      index: 0
    })
  })

  it('takes a member dropped at the end of the strip out of its group', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    expect(drop(['X', 'a', 'b'], [G], tab('a'), END, 'after')).toEqual({
      tabIds: ['a'],
      order: ['X', 'b', 'a'],
      groupId: null,
      index: 0
    })
  })

  it('leaves a loose tab loose when it is dropped at the end, behind a group that ends the strip', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    expect(drop(['X', 'a', 'b'], [G], tab('X'), END, 'before')?.groupId).toBeNull()
    expect(drop(['X', 'a', 'b'], [G], tab('X'), END, 'before')?.order).toEqual(['a', 'b', 'X'])
  })

  it('takes a member dropped beside a loose tab out of its group, at that place', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    expect(drop(['a', 'b', 'Y'], [G], tab('a'), tab('Y'), 'after')).toEqual({
      tabIds: ['a'],
      order: ['b', 'Y', 'a'],
      groupId: null,
      index: 0
    })
  })

  it('lets the only member of a group leave it from its own chip, and stay where it is', () => {
    const G = group({ id: 'G', tabIds: ['X'] })
    expect(drop(['Y', 'X', 'Z'], [G], tab('X'), chip('G'), 'before')).toEqual({
      tabIds: ['X'],
      order: ['Y', 'X', 'Z'],
      groupId: null,
      index: 0
    })
    // Behind its own chip it is first in the group it is already the whole of.
    expect(drop(['Y', 'X', 'Z'], [G], tab('X'), chip('G'), 'after')).toEqual({
      tabIds: ['X'],
      order: ['Y', 'X', 'Z'],
      groupId: 'G',
      index: 0
    })
  })
})

describe('a group whose every member is moving', () => {
  it.each([
    ['at the start of the strip', ['X', 'Y', 'Z']],
    ['at the end of the strip', ['Y', 'Z', 'X']]
  ])('leaves the only member of a group where it stood, %s', (_label, order) => {
    // Its chip has no member left to stand beside, so the place is the one the member had.
    const G = group({ id: 'G', tabIds: ['X'] })
    expect(drop(order, [G], tab('X'), chip('G'), 'before')).toEqual({
      tabIds: ['X'],
      order,
      groupId: null,
      index: 0
    })
    expect(drop(order, [G], tab('X'), chip('G'), 'after')).toEqual({
      tabIds: ['X'],
      order,
      groupId: 'G',
      index: 0
    })
  })

  it('leaves the only member of a folded group where it stood when it is dropped onto its chip', () => {
    const G = group({ id: 'G', tabIds: ['X'], collapsed: true })
    expect(drop(['Y', 'X', 'Z'], [G], tab('X'), chip('G'), 'after')).toEqual({
      tabIds: ['X'],
      order: ['Y', 'X', 'Z'],
      groupId: 'G',
      index: 0
    })
  })
})

describe('moving a tiled view as one (R10)', () => {
  const A = view('A', ['A1', 'A2'])

  it('takes every member of an entry into the group, as one run in tile order', () => {
    const G = group({ id: 'G', tabIds: ['a', 'b'] })
    expect(drop(['A1', 'A2', 'X', 'a', 'b'], [G], split('A'), tab('a'), 'after', [A])).toEqual({
      tabIds: ['A1', 'A2'],
      order: ['X', 'a', 'A1', 'A2', 'b'],
      groupId: 'G',
      index: 1
    })
  })

  it('reorders a view inside its group without leaving a member behind', () => {
    const G = group({ id: 'G', tabIds: ['A1', 'A2', 'X'] })
    expect(drop(['A1', 'A2', 'X'], [G], split('A'), tab('X'), 'after', [A])).toEqual({
      tabIds: ['A1', 'A2'],
      order: ['X', 'A1', 'A2'],
      groupId: 'G',
      index: 1
    })
  })

  it('takes every member of an entry out of its group', () => {
    const G = group({ id: 'G', tabIds: ['a', 'A1', 'A2'] })
    expect(drop(['a', 'A1', 'A2', 'Y'], [G], split('A'), END, 'after', [A])).toEqual({
      tabIds: ['A1', 'A2'],
      order: ['a', 'Y', 'A1', 'A2'],
      groupId: null,
      index: 0
    })
  })

  it('moves the whole view for a tab that is one of its members', () => {
    expect(drop(['A1', 'A2', 'X'], [], tab('A2'), END, 'after', [A])?.tabIds).toEqual(['A1', 'A2'])
    expect(drop(['A1', 'A2', 'X'], [], tab('A2'), END, 'after', [A])?.order).toEqual([
      'X',
      'A1',
      'A2'
    ])
  })

  it('places a tab dropped on a member of a view beside the whole view', () => {
    expect(drop(['A1', 'A2', 'X'], [], tab('X'), tab('A1'), 'before', [A])?.order).toEqual([
      'X',
      'A1',
      'A2'
    ])
  })

  it('only reorders a loose tab dropped on a put-away entry — it does not join the view', () => {
    const plan = drop(['X', 'A1', 'A2'], [], tab('X'), split('A'), 'after', [A])
    expect(plan).toEqual({ tabIds: ['X'], order: ['A1', 'A2', 'X'], groupId: null, index: 0 })
  })
})

describe('what a folded group does to the place (the index bug, KTD7)', () => {
  it('does not shift a drop by the tabs a folded group to its left hides', () => {
    /*
      The strip counted the tabs it drew — X and Y — and sent "index 0" for a drop before X; the core
      spliced that into an order that starts with the folded a and b, and Y landed in front of the
      group. A target and a side cannot be miscounted.
    */
    const G = group({ id: 'G', tabIds: ['a', 'b'], collapsed: true })
    expect(drop(['a', 'b', 'X', 'Y'], [G], tab('Y'), tab('X'), 'before')).toEqual({
      tabIds: ['Y'],
      order: ['a', 'b', 'Y', 'X'],
      groupId: null,
      index: 0
    })
  })

  it('settles an order that was not settled before placing the drop', () => {
    // A1 and A2 apart: the view is one run at A1 first, and the drop lands against that run.
    expect(
      drop(['A1', 'X', 'A2', 'Y'], [], tab('Y'), split('A'), 'after', [view('A', ['A1', 'A2'])])
        ?.order
    ).toEqual(['A1', 'A2', 'Y', 'X'])
  })
})

describe('a view whose members straddle a group (a document from before U8)', () => {
  /*
    R10 keeps a view's members in one group or none, and the day that does not hold the group's run
    wins (`stripOrder`): the view's entry holds the members in its first member's group, and a member
    outside it stands as a plain tab. A drop against such a view has to agree with what is drawn.
  */
  const A = view('A', ['A1', 'A2'])

  it("joins the group at the member the view's entry holds, not at the one outside it", () => {
    const G = group({ id: 'G', tabIds: ['a', 'b', 'A1'] })
    expect(drop(['a', 'b', 'A1', 'A2', 'X'], [G], tab('X'), split('A'), 'before', [A])).toEqual({
      tabIds: ['X'],
      order: ['a', 'b', 'X', 'A1', 'A2'],
      groupId: 'G',
      index: 2
    })
  })

  it("settles the order with the groups the drop leaves, so the group's run still wins", () => {
    const G = group({ id: 'G', tabIds: ['a', 'A2'] })
    expect(drop(['A1', 'X', 'a', 'A2', 'Y'], [G], tab('X'), END, 'after', [A])).toEqual({
      tabIds: ['X'],
      order: ['A1', 'a', 'A2', 'Y', 'X'],
      groupId: null,
      index: 0
    })
  })
})

describe('drops that move nothing', () => {
  const A = view('A', ['A1', 'A2'])
  const G = group({ id: 'G', tabIds: ['a'] })

  it.each<[string, StripDrop]>([
    ['a tab on itself', { subject: tab('X'), target: tab('X'), side: 'after' }],
    ['a view on itself', { subject: split('A'), target: split('A'), side: 'before' }],
    ['a view on one of its own members', { subject: split('A'), target: tab('A2'), side: 'after' }],
    ['a member on its own view', { subject: tab('A1'), target: split('A'), side: 'after' }],
    ['a tab the strip does not have', { subject: tab('gone'), target: END, side: 'after' }],
    ['a view the window does not have', { subject: split('Z'), target: END, side: 'after' }],
    [
      'onto a tab the strip does not have',
      { subject: tab('X'), target: tab('gone'), side: 'after' }
    ],
    [
      'onto a view the window does not have',
      { subject: tab('X'), target: split('Z'), side: 'after' }
    ],
    ['a view nobody has', { subject: split('nope'), target: END, side: 'after' }],
    ['onto a chip of no group', { subject: tab('X'), target: chip('none'), side: 'after' }]
  ])('refuses %s', (_label, input) => {
    expect(resolveStripDrop(['X', 'a', 'A1', 'A2'], [G], [A, view('Z', ['z'])], input)).toBeNull()
  })
})

describe('the wire form of a drop', () => {
  it('reads every target and side the strip sends', () => {
    for (const target of [tab('t'), split('s'), chip('g'), END]) {
      for (const side of ['before', 'after'] as const) {
        const input = { subject: tab('t'), target, side }
        expect(stripDropSchema.parse(input)).toEqual(input)
      }
    }
    expect(
      stripDropSchema.parse({ subject: split('s'), target: END, side: 'after' }).subject
    ).toEqual(split('s'))
  })

  it.each([
    ['an empty tab id', { subject: { kind: 'tab', tabId: '' }, target: END, side: 'after' }],
    [
      'an empty view id',
      { subject: { kind: 'split', arrangementId: '' }, target: END, side: 'after' }
    ],
    ['a chip as the subject', { subject: chip('g'), target: END, side: 'after' }],
    [
      'an empty target id',
      { subject: tab('t'), target: { kind: 'tab', tabId: '' }, side: 'after' }
    ],
    [
      'an empty chip id',
      { subject: tab('t'), target: { kind: 'group', groupId: '' }, side: 'after' }
    ],
    [
      'an empty entry id',
      { subject: tab('t'), target: { kind: 'split', arrangementId: '' }, side: 'after' }
    ],
    ['an unknown side', { subject: tab('t'), target: END, side: 'on' }],
    ['an index', { tabId: 't', toIndex: 0 }]
  ])('refuses %s', (_label, input) => {
    expect(stripDropSchema.safeParse(input).success).toBe(false)
  })

  it('declares the one channel, answered with ok', () => {
    expect(Object.keys(stripInvokeContract)).toEqual(['strip:drop'])
    expect(stripInvokeContract['strip:drop'].response.parse({ ok: true })).toEqual({ ok: true })
  })
})
