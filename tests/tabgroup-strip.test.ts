import { describe, expect, it } from 'vitest'
import { stripItems, type StripItem } from '@shared/tabgroups/strip.js'
import type { TabGroup } from '@shared/tabgroups/model.js'

/**
 * The sequence the tab strip draws.
 *
 * Every interesting case is a boundary — a group at the very start, two groups touching, a folded
 * group between two loose tabs — and each has a way of looking almost right: a chip in the wrong
 * place, a band with two rounded ends in the middle of a group, a tab that disappears entirely.
 */

function group(overrides: Partial<TabGroup> & { id: string; tabIds: string[] }): TabGroup {
  return {
    name: '',
    color: 'blue',
    collapsed: false,
    createdAt: 1,
    ...overrides
  }
}

/** A compact reading of the sequence, so an assertion says what someone would see. */
function shape(items: StripItem[]): string[] {
  return items.map((item) =>
    item.kind === 'group'
      ? `[${item.group.id}${item.hiddenCount > 0 ? `x${item.hiddenCount}` : ''}]`
      : `${item.tabId}${item.position === null ? '' : `(${item.position})`}`
  )
}

describe('an ungrouped strip', () => {
  it('is just the tabs', () => {
    expect(shape(stripItems(['t1', 't2'], []))).toEqual(['t1', 't2'])
  })

  it('gives a loose tab no group and no position', () => {
    const [item] = stripItems(['t1'], [])
    expect(item).toMatchObject({ kind: 'tab', group: null, position: null })
  })

  it('handles an empty strip', () => {
    expect(stripItems([], [])).toEqual([])
  })
})

describe('a group in the strip', () => {
  it('puts its chip before its first member', () => {
    const items = stripItems(['t1', 't2', 't3'], [group({ id: 'g1', tabIds: ['t2', 't3'] })])
    expect(shape(items)).toEqual(['t1', '[g1]', 't2(first)', 't3(last)'])
  })

  it('works at the very start of the strip', () => {
    // The boundary an off-by-one gets wrong: nothing precedes the chip.
    const items = stripItems(['t1', 't2'], [group({ id: 'g1', tabIds: ['t1'] })])
    expect(shape(items)).toEqual(['[g1]', 't1(only)', 't2'])
  })

  it('marks a single member as the only one, so its band is rounded at both ends', () => {
    const items = stripItems(['t1'], [group({ id: 'g1', tabIds: ['t1'] })])
    expect(shape(items)).toEqual(['[g1]', 't1(only)'])
  })

  it('marks the middle of a longer group', () => {
    const items = stripItems(
      ['t1', 't2', 't3'],
      [group({ id: 'g1', tabIds: ['t1', 't2', 't3'] })]
    )
    expect(shape(items)).toEqual(['[g1]', 't1(first)', 't2(middle)', 't3(last)'])
  })

  it('emits one chip per group when two groups touch', () => {
    // Two runs side by side, which is what dragging one group next to another produces. A single chip
    // here would silently merge them on screen while they stayed separate underneath.
    const items = stripItems(
      ['t1', 't2'],
      [group({ id: 'g1', tabIds: ['t1'] }), group({ id: 'g2', tabIds: ['t2'] })]
    )
    expect(shape(items)).toEqual(['[g1]', 't1(only)', '[g2]', 't2(only)'])
  })
})

describe('a folded group', () => {
  it('draws its chip and none of its tabs', () => {
    const items = stripItems(
      ['t1', 't2', 't3'],
      [group({ id: 'g1', tabIds: ['t1', 't2'], collapsed: true })]
    )
    expect(shape(items)).toEqual(['[g1x2]', 't3'])
  })

  it('says how many are folded away', () => {
    // The only thing that tells the user the tabs still exist. A chip with no count reads as an empty
    // group.
    const items = stripItems(['t1', 't2'], [group({ id: 'g1', tabIds: ['t1', 't2'], collapsed: true })])
    const chip = items.find((item) => item.kind === 'group')
    expect(chip).toMatchObject({ hiddenCount: 2 })
  })

  it('reports no hidden count while it is open', () => {
    const items = stripItems(['t1'], [group({ id: 'g1', tabIds: ['t1'] })])
    expect(items.find((item) => item.kind === 'group')).toMatchObject({ hiddenCount: 0 })
  })

  it('keeps the tabs around it in place', () => {
    const items = stripItems(
      ['t1', 't2', 't3'],
      [group({ id: 'g1', tabIds: ['t2'], collapsed: true })]
    )
    expect(shape(items)).toEqual(['t1', '[g1x1]', 't3'])
  })
})

describe('an order that is not contiguous', () => {
  it('renders something rather than losing a tab', () => {
    /*
      The core settles the order before sending it, so this should not occur — which is exactly why it
      is worth pinning. A strip that dropped a tab because an invariant was briefly untrue would leave
      an open page unreachable, and that is a far worse failure than a second chip.
    */
    const items = stripItems(
      ['t1', 't2', 't3'],
      [group({ id: 'g1', tabIds: ['t1', 't3'] })]
    )
    const drawn = items.filter((item) => item.kind === 'tab').map((item) => item.tabId)
    expect(drawn).toEqual(['t1', 't2', 't3'])
  })

  it('never drops a tab, whatever the groups claim', () => {
    // A stale member id — a group naming a tab this window does not have — must not remove a tab that
    // it does.
    const items = stripItems(
      ['t1', 't2'],
      [group({ id: 'g1', tabIds: ['gone', 't2'] })]
    )
    expect(items.filter((item) => item.kind === 'tab').map((item) => item.tabId)).toEqual([
      't1',
      't2'
    ])
  })

  it('gives a member no position when the group does not list it', () => {
    // Belt and braces: `groupOfTab` and `tabIds` are the same source, so this cannot normally differ.
    // Returning `null` rather than a wrong end keeps the band from being rounded in the middle.
    const items = stripItems(['t1'], [group({ id: 'g1', tabIds: ['t1'] })])
    expect(items.find((item) => item.kind === 'tab')).toMatchObject({ position: 'only' })
  })
})
