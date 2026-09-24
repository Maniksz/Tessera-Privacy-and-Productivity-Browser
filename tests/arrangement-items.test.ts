import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { arrangementMenuTemplate, type ArrangementMenuDeps } from '@main/menu/arrangement-items.js'
import type { ArrangementSummary } from '@shared/arrangements/screen.js'
import type { TabGroup } from '@shared/tabgroups/model.js'

/**
 * The menu a right-click on a tiled view's entry opens (R7, KTD12).
 *
 * Pure, like `tab-context-items.ts`, so every decision in it is asserted here by clicking the item and
 * reading which callback it reached with which arguments — which items appear is half of it, and the
 * other half is that each one acts on the entry it was opened for.
 */

const VISIBLE: ArrangementSummary = {
  id: 'a1',
  layoutId: '1x2',
  tabIds: ['t1', 't2'],
  activeTile: 0,
  activeTabId: 't1',
  visible: true
}

const PUT_AWAY: ArrangementSummary = {
  id: 'a2',
  layoutId: '2x2',
  tabIds: ['t3', 't4', 't5'],
  activeTile: 1,
  activeTabId: 't4',
  visible: false
}

function group(
  id: string,
  tabIds: string[],
  name = '',
  color: TabGroup['color'] = 'green'
): TabGroup {
  return { id, name, color, collapsed: false, tabIds, createdAt: 0 }
}

interface Built {
  template: MenuItemConstructorOptions[]
  calls: unknown[][]
}

function build(overrides: Partial<ArrangementMenuDeps> = {}): Built {
  const calls: unknown[][] = []
  const template = arrangementMenuTemplate({
    locale: 'en',
    id: 'a1',
    arrangements: [VISIBLE, PUT_AWAY],
    groups: [],
    onChangeLayout: (id, layout) => calls.push(['layout', id, layout]),
    onEnd: (id) => calls.push(['end', id]),
    onCreateGroup: (tabId) => calls.push(['create', tabId]),
    onAddToGroup: (groupId, tabId) => calls.push(['add', groupId, tabId]),
    onRemoveFromGroup: (tabId) => calls.push(['remove', tabId]),
    onCloseAll: (id) => calls.push(['closeAll', id]),
    ...overrides
  })
  return { template, calls }
}

function item(
  items: readonly MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions {
  const found = items.find((entry) => entry.label === label)
  if (found === undefined) throw new Error(`no item ${label}`)
  return found
}

function submenu(
  items: readonly MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions[] {
  return item(items, label).submenu as MenuItemConstructorOptions[]
}

function click(entry: MenuItemConstructorOptions): void {
  ;(entry.click as () => void)()
}

function labels(items: readonly MenuItemConstructorOptions[]): Array<string | undefined> {
  return items.map((entry) => (entry.type === 'separator' ? '—' : entry.label))
}

describe('the entry menu', () => {
  it('offers the layout, ending it, grouping it and closing it, in that order', () => {
    const { template } = build()

    expect(labels(template)).toEqual([
      'Change Layout',
      'End Tiled View',
      '—',
      'Group these tabs',
      '—',
      'Close All Tabs'
    ])
  })

  it('reads in German', () => {
    const { template } = build({ locale: 'de' })

    expect(labels(template)).toEqual([
      'Layout ändern',
      'Kachelansicht beenden',
      '—',
      'Diese Tabs gruppieren',
      '—',
      'Alle Tabs schließen'
    ])
    expect(submenu(template, 'Layout ändern').map((entry) => entry.label)).toContain('Zwei Spalten')
  })

  it('answers nothing for an entry that is gone', () => {
    // The strip drew the entry from an `arrangements:changed` that may be a moment old.
    expect(build({ id: 'gone' }).template).toEqual([])
    expect(build({ arrangements: [] }).template).toEqual([])
  })
})

describe('Change Layout', () => {
  it('lists every layout but the single one, as a radio with the current one checked', () => {
    const layouts = submenu(build().template, 'Change Layout')

    // `LAYOUT_IDS` order, the order of the toolbar's layout menu and of the Split View menu.
    expect(layouts.map((entry) => entry.label)).toEqual([
      'Two Columns',
      'Two Rows',
      'Four Tiles',
      'One Large, Two Small',
      'Three Columns',
      'Four Columns'
    ])
    expect(layouts.every((entry) => entry.type === 'radio')).toBe(true)
    expect(layouts.filter((entry) => entry.checked === true).map((entry) => entry.label)).toEqual([
      'Two Columns'
    ])
  })

  it('checks the stored layout of a view that is put away', () => {
    const layouts = submenu(build({ id: 'a2' }).template, 'Change Layout')

    expect(layouts.filter((entry) => entry.checked === true).map((entry) => entry.label)).toEqual([
      'Four Tiles'
    ])
  })

  it('asks for the layout clicked, for this entry', () => {
    const { template, calls } = build({ id: 'a2' })

    click(item(submenu(template, 'Change Layout'), 'Two Rows'))
    click(item(submenu(template, 'Change Layout'), 'Two Columns'))

    expect(calls).toEqual([
      ['layout', 'a2', '2x1'],
      ['layout', 'a2', '1x2']
    ])
  })
})

describe('ending and closing', () => {
  it('ends this entry, and closes this entry', () => {
    const { template, calls } = build({ id: 'a2' })

    click(item(template, 'End Tiled View'))
    click(item(template, 'Close All Tabs'))

    expect(calls).toEqual([
      ['end', 'a2'],
      ['closeAll', 'a2']
    ])
  })
})

describe('the group actions (R10)', () => {
  it('groups the view through its first member, which the group side widens to all of them', () => {
    const { template, calls } = build({ id: 'a2' })

    click(item(template, 'Group these tabs'))

    expect(calls).toEqual([['create', 't3']])
  })

  it('offers only a new group when there is no group at all', () => {
    const { template } = build()

    expect(labels(template)).not.toContain('Add to group')
    expect(labels(template)).not.toContain('Remove from group')
  })

  it('offers the other groups, named or by colour, and adds through the first member', () => {
    const { template, calls } = build({
      groups: [group('g1', ['x'], 'Sport'), group('g2', ['y'], '', 'red')]
    })

    const targets = submenu(template, 'Add to group')
    expect(targets.map((entry) => entry.label)).toEqual(['Sport', 'Red'])
    click(item(targets, 'Red'))

    expect(calls).toEqual([['add', 'g2', 't1']])
    expect(labels(template)).not.toContain('Remove from group')
  })

  it('offers removal for a view in a group, and leaves its own group out of the targets', () => {
    const { template, calls } = build({
      groups: [group('g1', ['t1', 't2'], 'Sport'), group('g2', ['y'], 'Work')]
    })

    expect(labels(template)).toEqual([
      'Change Layout',
      'End Tiled View',
      '—',
      'Group these tabs',
      'Add to group',
      'Remove from group',
      '—',
      'Close All Tabs'
    ])
    expect(submenu(template, 'Add to group').map((entry) => entry.label)).toEqual(['Work'])
    click(item(template, 'Remove from group'))

    expect(calls).toEqual([['remove', 't1']])
  })

  it('offers no target list when the view is in the only group', () => {
    const { template } = build({ groups: [group('g1', ['t1', 't2'])] })

    expect(labels(template)).not.toContain('Add to group')
    expect(labels(template)).toContain('Remove from group')
  })
})
