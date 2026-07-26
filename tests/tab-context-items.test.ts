import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { tabContextMenuTemplate, type TabContextMenuDeps } from '@main/menu/tab-context-items.js'
import type { TabGroup } from '@shared/tabgroups/model.js'

/**
 * The tab context menu's items.
 *
 * The only way into tab groups, which makes every decision here load-bearing: a missing item is a
 * feature nobody can reach, and a wrongly *present* one — "remove from group" on a tab that is in no
 * group — is an action that fails when clicked. Both look like a perfectly ordinary menu in review.
 */

function group(overrides: Partial<TabGroup> & { id: string; tabIds: string[] }): TabGroup {
  return { name: '', color: 'blue', collapsed: false, createdAt: 1, ...overrides }
}

function deps(overrides: Partial<TabContextMenuDeps> = {}): TabContextMenuDeps {
  return {
    locale: 'en',
    tabId: 't1',
    groups: [],
    onCreateGroup: vi.fn(),
    onAddToGroup: vi.fn(),
    onRemoveFromGroup: vi.fn(),
    onRecolor: vi.fn(),
    onDissolve: vi.fn(),
    onCloseTab: vi.fn(),
    onSetPinned: vi.fn(),
    isPinned: () => false,
    ...overrides
  }
}

const labels = (items: MenuItemConstructorOptions[]): string[] =>
  items.map((item) => item.label ?? (item.type === 'separator' ? '---' : ''))

const find = (
  items: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions | undefined => items.find((item) => item.label === label)

describe('a tab in no group', () => {
  it('is offered a new group', () => {
    expect(labels(tabContextMenuTemplate(deps()))).toContain('Group these tabs')
  })

  it('is not offered to be removed from one', () => {
    // Present, it would be an item that fails when clicked — worse than an absent one, because the
    // user learns the menu cannot be trusted.
    expect(labels(tabContextMenuTemplate(deps()))).not.toContain('Remove from group')
  })

  it('is not offered a colour or an ungroup', () => {
    const items = labels(tabContextMenuTemplate(deps()))
    expect(items).not.toContain('Group colour')
    expect(items).not.toContain('Ungroup')
  })

  it('is not offered to be added to a group when none exist', () => {
    // An empty submenu is a dead end that looks like a bug in the menu.
    expect(labels(tabContextMenuTemplate(deps()))).not.toContain('Add to group')
  })

  it('is offered to join an existing group', () => {
    const items = tabContextMenuTemplate(
      deps({ groups: [group({ id: 'g1', tabIds: ['t2'], name: 'Work' })] })
    )
    const addTo = find(items, 'Add to group')
    expect(addTo).toBeDefined()
    expect(labels((addTo?.submenu ?? []) as MenuItemConstructorOptions[])).toEqual(['Work'])
  })

  it('identifies an unnamed group by its colour', () => {
    // A blank row is unclickable in practice: there is nothing to read and nothing to aim at.
    const items = tabContextMenuTemplate(
      deps({ groups: [group({ id: 'g1', tabIds: ['t2'], color: 'green' })] })
    )
    const addTo = find(items, 'Add to group')
    expect(labels((addTo?.submenu ?? []) as MenuItemConstructorOptions[])).toEqual(['Green'])
  })
})

describe('a tab already in a group', () => {
  const grouped = (overrides: Partial<TabGroup> = {}): TabContextMenuDeps =>
    deps({ groups: [group({ id: 'g1', tabIds: ['t1'], name: 'Work', ...overrides })] })

  it('is offered to leave it, to recolour it and to ungroup', () => {
    const items = labels(tabContextMenuTemplate(grouped()))
    expect(items).toContain('Remove from group')
    expect(items).toContain('Group colour')
    expect(items).toContain('Ungroup')
  })

  it('is not offered to join the group it is already in', () => {
    // The one case the "add to group" list must exclude, and the easiest to get wrong: adding a tab to
    // its own group is a no-op that looks like the menu doing nothing.
    expect(labels(tabContextMenuTemplate(grouped()))).not.toContain('Add to group')
  })

  it('is still offered a new group, which moves it out of this one', () => {
    expect(labels(tabContextMenuTemplate(grouped()))).toContain('Group these tabs')
  })

  it('shows its current colour as the checked one', () => {
    // A radio rather than eight plain rows, so the group's colour is visible without remembering it.
    const items = tabContextMenuTemplate(grouped({ color: 'pink' }))
    const submenu = (find(items, 'Group colour')?.submenu ?? []) as MenuItemConstructorOptions[]
    expect(submenu).toHaveLength(8)
    expect(submenu.filter((item) => item.checked === true).map((item) => item.label)).toEqual([
      'Pink'
    ])
    expect(submenu.every((item) => item.type === 'radio')).toBe(true)
  })
})

describe('the actions the items run', () => {
  it('creates a group containing this tab', () => {
    const onCreateGroup = vi.fn()
    const items = tabContextMenuTemplate(deps({ tabId: 't7', onCreateGroup }))
    find(items, 'Group these tabs')?.click?.(
      // The click signature carries a menu item, a window and an event; none is read here.
      undefined as never,
      undefined,
      undefined as never
    )
    expect(onCreateGroup).toHaveBeenCalledWith(['t7'])
  })

  it('recolours the group the tab is in, not some other one', () => {
    const onRecolor = vi.fn()
    const items = tabContextMenuTemplate(
      deps({
        groups: [
          group({ id: 'g1', tabIds: ['t1'] }),
          group({ id: 'g2', tabIds: ['t2'] })
        ],
        onRecolor
      })
    )
    const submenu = (find(items, 'Group colour')?.submenu ?? []) as MenuItemConstructorOptions[]
    find(submenu, 'Red')?.click?.(undefined as never, undefined, undefined as never)
    expect(onRecolor).toHaveBeenCalledWith('g1', 'red')
  })
})

describe('the plain tab commands', () => {
  it('offers pinning, worded for the tab current state', () => {
    // One item that flips rather than two, so the menu never offers "pin" on a pinned tab.
    expect(labels(tabContextMenuTemplate(deps()))).toContain('Pin tab')
    expect(labels(tabContextMenuTemplate(deps({ isPinned: () => true })))).toContain('Unpin tab')
  })

  it('separates them from the group commands', () => {
    // Closing a tab and grouping it are different kinds of action; without the rule they read as one
    // list and a mis-click closes a tab instead of colouring a group.
    expect(labels(tabContextMenuTemplate(deps()))).toContain('---')
  })

  it('always offers closing, grouped or not', () => {
    for (const groups of [[], [group({ id: 'g1', tabIds: ['t1'] })]]) {
      expect(labels(tabContextMenuTemplate(deps({ groups })))).toContain('Close tab')
    }
  })
})

describe('translation', () => {
  it('takes its labels from the catalogue rather than hard-coding them', () => {
    // Spec 7: no hard-coded strings. German is the other shipped locale, so a label identical in both
    // would mean the key was not looked up at all.
    const german = labels(tabContextMenuTemplate(deps({ locale: 'de' })))
    expect(german).toContain('Diese Tabs gruppieren')
    expect(german).not.toContain('Group these tabs')
  })
})
