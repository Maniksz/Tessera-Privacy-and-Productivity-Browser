import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TabGroupController } from '@main/browser/TabGroupController.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import {
  registerTabGroupHandlers,
  type TabGroupHandle,
  type TabGroupWindow
} from '@main/ipc/tabgroup-handlers.js'
import { tabGroupInvokeContract } from '@shared/tabgroups/schema.js'

/**
 * The `tabgroups:*` channels and the two menus they are reached through, against a window whose groups
 * are the real `TabGroupController` over a real store — so "ungrouping from the chip" is asked of the
 * code that ungroups, not of a stand-in.
 *
 * What is tested is what neither the template nor the controller can see on its own: that each channel
 * reaches the *sending* window's groups, that a menu's clicks land on the same controller the channels
 * use, and that a sender with no window gets no menu.
 */

type Handler = (payload: unknown, event: IpcMainInvokeEvent) => unknown

const EVENT = undefined as unknown as IpcMainInvokeEvent

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-tabgroup-handlers-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

interface FakeWindow extends TabGroupWindow {
  readonly groups: TabGroupController
  readonly closed: string[]
  readonly pinned: Map<string, boolean>
}

async function fakeWindow(tabIds: readonly string[]): Promise<FakeWindow> {
  const store = await TabGroupStore.open({ filePath: join(directory, 'tab-groups.json') })
  let order = [...tabIds]
  const closed: string[] = []
  const pinned = new Map<string, boolean>()
  const groups = new TabGroupController({
    book: store.bookFor('normal'),
    tabOrder: () => order,
    setTabOrder: (next) => {
      order = [...next]
    },
    releaseTiles: () => false,
    activeTabId: () => null,
    activateTab: () => {},
    liveTabIds: () => order,
    broadcast: () => {}
  })
  return {
    groups,
    closed,
    pinned,
    closeTab: (tabId) => closed.push(tabId),
    setTabPinned: (tabId, value) => pinned.set(tabId, value),
    resolveTab: (tabId) =>
      tabIds.includes(tabId) ? { pinned: pinned.get(tabId) === true } : undefined
  }
}

interface Registered {
  call(channel: string, payload: unknown): unknown
  /** Every template the handlers asked to put up, with the window it was for. */
  menus: Array<{ template: MenuItemConstructorOptions[]; window: FakeWindow }>
}

function register(window: FakeWindow | undefined): Registered {
  const handlers = new Map<string, Handler>()
  const menus: Registered['menus'] = []
  const handle = ((channel: string, handler: Handler) => {
    handlers.set(channel, handler)
  }) as unknown as TabGroupHandle
  registerTabGroupHandlers<FakeWindow>({
    handle,
    windows: { resolve: () => window },
    locale: () => 'en',
    showMenu: (template, target) => menus.push({ template, window: target })
  })
  return {
    call: (channel, payload) => {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`nothing registered on ${channel}`)
      return handler(payload, EVENT)
    },
    menus
  }
}

function click(items: MenuItemConstructorOptions[] | undefined, label: string): void {
  const item = items?.find((entry) => entry.label === label)
  if (item === undefined) throw new Error(`no item ${label}`)
  ;(item.click as () => void)()
}

function submenu(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  return (items.find((entry) => entry.label === label)?.submenu ??
    []) as MenuItemConstructorOptions[]
}

describe('registration', () => {
  it('registers every channel of the group contract, and the tab menu with them', () => {
    const channels: string[] = []
    registerTabGroupHandlers({
      handle: (channel: string) => channels.push(channel),
      windows: { resolve: () => undefined },
      locale: () => 'en',
      showMenu: () => {}
    })
    expect(channels.sort()).toEqual(
      [...Object.keys(tabGroupInvokeContract), 'tabs:contextMenu'].sort()
    )
  })
})

describe('the group channels', () => {
  it("act on the sending window's groups", async () => {
    const window = await fakeWindow(['a', 'b', 'c'])
    const { call } = register(window)

    const created = call('tabgroups:create', { tabIds: ['a', 'b'], name: 'Work', color: 'red' })
    expect(tabGroupInvokeContract['tabgroups:create'].response.parse(created)).toMatchObject({
      name: 'Work',
      color: 'red',
      tabIds: ['a', 'b']
    })
    const id = window.groups.groups()[0]?.id ?? ''

    expect(call('tabgroups:rename', { id, name: 'Play' })).toEqual({ ok: true })
    expect(call('tabgroups:recolor', { id, color: 'green' })).toEqual({ ok: true })
    expect(call('tabgroups:setCollapsed', { id, collapsed: true })).toEqual({ ok: true })
    expect(call('tabgroups:addTab', { groupId: id, tabId: 'c' })).toEqual({ ok: true })
    expect(window.groups.groups()).toMatchObject([
      { name: 'Play', color: 'green', collapsed: true, tabIds: ['a', 'b', 'c'] }
    ])

    expect(call('tabgroups:removeTab', { tabId: 'a' })).toEqual({ ok: true })
    expect(window.groups.groups()[0]?.tabIds).toEqual(['b', 'c'])
    expect(call('tabgroups:dissolve', { id })).toEqual({ ok: true })
    expect(window.groups.groups()).toEqual([])
  })

  it('create without a name or a colour takes the defaults', async () => {
    const window = await fakeWindow(['a'])
    const { call } = register(window)
    expect(call('tabgroups:create', { tabIds: ['a'] })).toMatchObject({ name: '', tabIds: ['a'] })
  })

  it('refuses to create for a sender with no window, and does nothing for the rest', () => {
    const { call } = register(undefined)
    expect(() => call('tabgroups:create', { tabIds: ['a'] })).toThrow(/no window/)
    for (const [channel, payload] of [
      ['tabgroups:rename', { id: 'g', name: '' }],
      ['tabgroups:recolor', { id: 'g', color: 'red' }],
      ['tabgroups:setCollapsed', { id: 'g', collapsed: true }],
      ['tabgroups:dissolve', { id: 'g' }],
      ['tabgroups:addTab', { groupId: 'g', tabId: 'a' }],
      ['tabgroups:removeTab', { tabId: 'a' }]
    ] as const) {
      expect(call(channel, payload)).toEqual({ ok: true })
    }
  })
})

describe("a group chip's menu", () => {
  it('ungroups a folded group and leaves every tab open', async () => {
    // The case the menu is for: a folded group has no member on screen to right-click.
    const window = await fakeWindow(['a', 'b'])
    const { call, menus } = register(window)
    const group = window.groups.create({ tabIds: ['a', 'b'], name: 'Later' })
    window.groups.setCollapsed(group.id, true)

    expect(call('tabgroups:contextMenu', { id: group.id })).toEqual({ ok: true })
    expect(menus[0]?.window).toBe(window)
    click(menus[0]?.template, 'Ungroup')

    expect(window.groups.groups()).toEqual([])
    expect(window.closed).toEqual([])
    expect(window.groups.displayOrder()).toEqual(['a', 'b'])
  })

  it('recolours through the same controller', async () => {
    const window = await fakeWindow(['a'])
    const { call, menus } = register(window)
    const group = window.groups.create({ tabIds: ['a'], color: 'blue' })

    call('tabgroups:contextMenu', { id: group.id })
    click(submenu(menus[0]?.template ?? [], 'Group colour'), 'Pink')
    expect(window.groups.groups()[0]?.color).toBe('pink')
  })

  it('hands an empty template on for a group that is already gone', async () => {
    const window = await fakeWindow(['a'])
    const { call, menus } = register(window)
    call('tabgroups:contextMenu', { id: 'gone' })
    expect(menus).toEqual([{ template: [], window }])
  })

  it('opens nothing for a sender with no window', () => {
    const { call, menus } = register(undefined)
    expect(call('tabgroups:contextMenu', { id: 'g' })).toEqual({ ok: true })
    expect(menus).toEqual([])
  })
})

describe("a tab's menu", () => {
  it("wires every item to the sending window's controller", async () => {
    const window = await fakeWindow(['a', 'b'])
    const { call, menus } = register(window)
    const menu = (): MenuItemConstructorOptions[] => menus[menus.length - 1]?.template ?? []

    call('tabs:contextMenu', { tabId: 'a' })
    click(menu(), 'Group these tabs')
    const [own] = window.groups.groups()
    expect(own?.tabIds).toEqual(['a'])

    call('tabs:contextMenu', { tabId: 'b' })
    click(submenu(menu(), 'Add to group'), 'Blue')
    expect(window.groups.groups()[0]?.tabIds).toEqual(['a', 'b'])

    call('tabs:contextMenu', { tabId: 'b' })
    click(submenu(menu(), 'Group colour'), 'Red')
    expect(window.groups.groups()[0]?.color).toBe('red')

    call('tabs:contextMenu', { tabId: 'b' })
    click(menu(), 'Remove from group')
    expect(window.groups.groups()[0]?.tabIds).toEqual(['a'])

    call('tabs:contextMenu', { tabId: 'a' })
    click(menu(), 'Ungroup')
    expect(window.groups.groups()).toEqual([])

    call('tabs:contextMenu', { tabId: 'a' })
    click(menu(), 'Pin tab')
    expect(window.pinned.get('a')).toBe(true)
    call('tabs:contextMenu', { tabId: 'a' })
    expect(menu().some((item) => item.label === 'Unpin tab')).toBe(true)

    call('tabs:contextMenu', { tabId: 'a' })
    click(menu(), 'Close tab')
    expect(window.closed).toEqual(['a'])
  })

  it('opens nothing for a sender with no window', () => {
    const { call, menus } = register(undefined)
    expect(call('tabs:contextMenu', { tabId: 'a' })).toEqual({ ok: true })
    expect(menus).toEqual([])
  })
})
