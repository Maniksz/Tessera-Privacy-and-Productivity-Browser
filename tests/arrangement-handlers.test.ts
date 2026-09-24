import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArrangementController } from '@main/browser/ArrangementController.js'
import { SplitController } from '@main/browser/SplitController.js'
import { createWindowSeams, type WindowInternals } from '@main/browser/window-seams.js'
import type { OverlayLayer } from '@main/browser/OverlayLayer.js'
import type { Tab } from '@main/browser/Tab.js'
import { ArrangementStore } from '@main/data/ArrangementStore.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import {
  registerArrangementHandlers,
  type ArrangementHandle,
  type ArrangementWindow
} from '@main/ipc/arrangement-handlers.js'
import { decideAccess, type ChromeAddresses } from '@main/ipc/sender-policy.js'
import { arrangementInvokeContract } from '@shared/arrangements/schema.js'
import { INTERNAL_PAGES } from '@shared/ipc/channels.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import type { LayoutId, Rect } from '@shared/split/layout.js'
import { HOME_URL } from '@shared/url/omnibox.js'

/**
 * The `arrangements:*` channels and the entry's menu (U6), against a window whose seams are the real
 * ones over real stores — so "End Tiled View on a put-away entry" is asked of the code that ends one,
 * the way `window-seams-arrangements.test.ts` drives the seams.
 *
 * What is tested is what neither the template nor a controller sees alone: that each channel reaches
 * the sending window, that the order of the steps holds across the controllers — dissolve before the
 * first close (KTD13), restore before a layout change (KTD12) — and that a sender with no window, or an
 * id nobody holds, gets nothing.
 */

type Handler = (payload: unknown, event: IpcMainInvokeEvent) => unknown

const EVENT = undefined as unknown as IpcMainInvokeEvent
const CONTENT: Rect = { x: 0, y: 88, width: 1200, height: 800 }

const directories: string[] = []
const flushes: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(flushes.splice(0).map((flush) => flush()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

interface Harness {
  window: FakeWindow
  split: SplitController
  /** One coalesced broadcast round: `arrangements.keep()`, as `BrowserWindowController` runs it. */
  round: () => void
  /** Switches layout and seats, the way nothing but a test does. */
  show: (layout: LayoutId, seats: Array<string | null>) => void
  /** `BrowserWindowController.activateTab`, as far as the seams go. */
  activate: (tabId: string) => void
  addStartPage: (tabId: string) => void
  /** Tabs whose page asks "Leave this page?" on close; the answer is given later by `answer`. */
  asks: Set<string>
  /** Tabs whose page is answered "Stay" when it asks. */
  refuses: Set<string>
  /** Every tab that has really closed, in order. */
  closed: () => string[]
  order: () => string[]
  muted: (tabId: string) => boolean
  /** Each question a page put, with what the window looked like while it was up. */
  questions: () => Array<{
    tabId: string
    liveId: string | null
    entries: string[]
    tiles: Array<string | null>
  }>
  /** Every layout the window was asked to take. */
  layoutChanges: () => LayoutId[]
  /** The screen after each close, for "nothing is pulled in between the closes". */
  screens: () => Array<Array<string | null>>
}

interface FakeWindow extends ArrangementWindow {
  /** The real controller, so a test can ask what the handler's narrowed view of it cannot. */
  readonly arrangements: ArrangementController
  readonly publishes: number
  /** The group calls the entry's menu made, with their arguments. */
  readonly groupCalls: unknown[][]
}

async function harness(tabs: string[]): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-arrangement-handlers-'))
  directories.push(directory)
  const groupStore = await TabGroupStore.open({ filePath: join(directory, 'tab-groups.json') })
  const arrangementStore = await ArrangementStore.open({
    filePath: join(directory, 'arrangements.json'),
    debounceMs: 0
  })
  flushes.push(async () => {
    await arrangementStore.flush()
    await groupStore.flush()
  })

  const split = new SplitController({ layout: '1x1' })
  let order = [...tabs]
  const startPages = new Set<string>()
  const asks = new Set<string>()
  const refuses = new Set<string>()
  const closed: string[] = []
  const mutedTabs = new Map<string, boolean>()
  const questions: ReturnType<Harness['questions']> = []
  const layoutChanges: LayoutId[] = []
  const screens: Array<Array<string | null>> = []

  const fakeTab = (tabId: string): Tab => {
    const fake: unknown = {
      id: tabId,
      ephemeral: startPages.has(tabId),
      setTileIndex: () => {},
      setMuted: (muted: boolean) => mutedTabs.set(tabId, muted),
      toState: () => ({
        id: tabId,
        title: tabId,
        url: startPages.has(tabId) ? HOME_URL : `https://example.test/${tabId}`,
        loading: false,
        pendingInput: null
      }),
      view: {
        webContents: { isDestroyed: () => false, executeJavaScript: () => Promise.resolve() }
      }
    }
    return fake as Tab
  }

  const activate = (tabId: string): void => {
    const tile = split.tileOfTab(tabId)
    if (tile !== null) {
      split.setActiveTile(tile)
      return
    }
    seams.arrangements.restoreFor(tabId)
    if (split.tileOfTab(tabId) === null) {
      split.assignTab(tabId, seams.occupancy.claimTileForNewTab())
    }
  }

  // `BrowserWindowController.#finishClose`, once `CloseContract` has let the tab go.
  const finish = (tabId: string): void => {
    closed.push(tabId)
    const vacated = split.tileOfTab(tabId)
    split.forgetTab(tabId)
    order = order.filter((id) => id !== tabId)
    seams.arrangements.tabClosed(tabId)
    seams.occupancy.afterTabClosed(vacated)
    screens.push([...split.toState().tileTabIds])
  }

  /*
    `CloseContract.closeTab`: a page that asks is brought to the front first (`#reveal`, which is
    `activateTab`), and its question is up while the window is in whatever state that left.
  */
  const closeTab = (tabId: string): void => {
    if (!order.includes(tabId)) return
    if (!asks.has(tabId) && !refuses.has(tabId)) {
      finish(tabId)
      return
    }
    activate(tabId)
    questions.push({
      tabId,
      liveId: seams.arrangements.liveId,
      entries: seams.arrangements.summaries().map((summary) => summary.id),
      tiles: [...split.toState().tileTabIds]
    })
    if (!refuses.has(tabId)) finish(tabId)
  }

  const overlayStub: unknown = { dismissKind: () => {} }
  const internals: WindowInternals = {
    split,
    overlay: overlayStub as OverlayLayer,
    isDestroyed: () => false,
    getSettings: () => ({ ...defaultSettings(), 'splitView.adaptLayoutToTabs': true }),
    contentBounds: () => CONTENT,
    cursorScreenPoint: () => ({ x: 0, y: 0 }),
    contentRect: () => CONTENT,
    setFullScreenable: () => {},
    exitWindowFullscreen: () => {},
    enterWindowFullscreen: () => {},
    toggleWindowFullscreen: () => {},
    tab: (tabId) => (order.includes(tabId) ? fakeTab(tabId) : undefined),
    tabIds: () => order,
    tabOrder: () => order,
    setTabOrder: (next) => {
      order = [...next]
    },
    assignTabToTile: (tabId, tileIndex) => split.assignTab(tabId, tileIndex),
    closeTab,
    activateTab: activate,
    setActiveTile: (tileIndex) => split.setActiveTile(tileIndex),
    openFiller: (tileIndex) => {
      const id = `filler-${order.length}`
      order.push(id)
      startPages.add(id)
      split.assignTab(id, tileIndex)
    },
    applyLayout: (layout, options) => {
      layoutChanges.push(layout)
      seams.occupancy.afterLayoutChange(split.setLayout(layout), options)
    },
    presentOverlay: () => {},
    relayout: () => {},
    broadcast: () => {},
    onOverlayPresentationChanged: () => {},
    tabGroups: groupStore.bookFor('normal'),
    arrangements: arrangementStore.bookFor('normal')
  }
  const seams = createWindowSeams(internals)

  const groupCalls: unknown[][] = []
  let publishes = 0
  const window: FakeWindow = {
    arrangements: seams.arrangements,
    groups: {
      groups: () => seams.groups.groups(),
      create: (input) => {
        groupCalls.push(['create', input])
        return seams.groups.create(input)
      },
      addTab: (groupId, tabId, index) => {
        groupCalls.push(['addTab', groupId, tabId])
        seams.groups.addTab(groupId, tabId, index)
      },
      removeTab: (tabId) => {
        groupCalls.push(['removeTab', tabId])
        seams.groups.removeTab(tabId)
      },
      dropInStrip: (drop) => {
        groupCalls.push(['dropInStrip', drop])
        seams.groups.dropInStrip(drop)
      }
    },
    split,
    occupancy: seams.occupancy,
    setLayout: (layout) => seams.occupancy.chooseLayout(layout),
    setTileMuted: (tileIndex, muted) => seams.audio.setMutedByUser(tileIndex, muted),
    activateTab: activate,
    closeTab,
    resolveTab: (tabId) => (order.includes(tabId) ? fakeTab(tabId) : undefined),
    publish: () => {
      publishes += 1
    },
    get publishes() {
      return publishes
    },
    groupCalls
  }

  return {
    window,
    split,
    round: () => seams.arrangements.keep(),
    show: (layout, seats) => {
      split.setLayout(layout)
      seats.forEach((tabId, index) => {
        if (tabId !== null) split.assignTab(tabId, index)
      })
    },
    activate,
    addStartPage: (tabId) => {
      order.push(tabId)
      startPages.add(tabId)
    },
    asks,
    refuses,
    closed: () => closed,
    order: () => order,
    muted: (tabId) => mutedTabs.get(tabId) === true,
    questions: () => questions,
    layoutChanges: () => layoutChanges,
    screens: () => screens
  }
}

interface Registered {
  call(channel: string, payload: unknown): unknown
  menus: MenuItemConstructorOptions[][]
}

function register(window: FakeWindow | undefined, locale: 'en' | 'de' = 'en'): Registered {
  const handlers = new Map<string, Handler>()
  const menus: MenuItemConstructorOptions[][] = []
  const handle = ((channel: string, handler: Handler) => {
    handlers.set(channel, handler)
  }) as unknown as ArrangementHandle
  registerArrangementHandlers<FakeWindow>({
    handle,
    windows: { resolve: () => window },
    locale: () => locale,
    showMenu: (template) => menus.push(template)
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

function item(
  items: readonly MenuItemConstructorOptions[] | undefined,
  label: string
): MenuItemConstructorOptions {
  const found = items?.find((entry) => entry.label === label)
  if (found === undefined) throw new Error(`no item ${label}`)
  return found
}

function click(items: readonly MenuItemConstructorOptions[] | undefined, ...path: string[]): void {
  let level = items
  for (const label of path.slice(0, -1)) {
    level = item(level, label).submenu as MenuItemConstructorOptions[]
  }
  ;(item(level, path.at(-1) ?? '').click as () => void)()
}

/** The strip's view of the window: every entry, with whether it is on screen. */
function entries(
  h: Harness
): Array<{ id: string; layoutId: LayoutId; tabIds: string[]; visible: boolean }> {
  return h.window.arrangements
    .summaries()
    .map(({ id, layoutId, tabIds, visible }) => ({ id, layoutId, tabIds, visible }))
}

/**
 * A window with `A` = a1 | a2 put away (a2 active) and `B` = b1 | b2 on screen, `x` a loose tab.
 * Answers the two ids.
 */
async function twoViews(): Promise<{ h: Harness; a: string; b: string }> {
  const h = await harness(['x', 'a1', 'a2', 'b1', 'b2'])
  h.show('1x2', ['a1', 'a2'])
  h.split.setActiveTile(1)
  h.round()
  h.activate('x')
  h.show('1x2', ['b1', 'b2'])
  h.round()
  const [a, b] = h.window.arrangements.summaries().map((summary) => summary.id)
  if (a === undefined || b === undefined) throw new Error('the two views were not recorded')
  return { h, a, b }
}

describe('registration', () => {
  it('registers every channel of the arrangement contract, and nothing else', () => {
    const channels: string[] = []
    registerArrangementHandlers({
      handle: (channel: string) => channels.push(channel),
      windows: { resolve: () => undefined },
      locale: () => 'en',
      showMenu: () => {}
    })

    expect(channels.sort()).toEqual(Object.keys(arrangementInvokeContract).sort())
    expect(channels).toEqual([
      'arrangements:activate',
      'arrangements:close',
      'arrangements:contextMenu',
      'arrangements:releaseTab',
      'arrangements:setMuted'
    ])
  })

  it('answers every channel for a sender with no window, doing nothing', () => {
    const { call, menus } = register(undefined)
    for (const channel of Object.keys(arrangementInvokeContract)) {
      expect(call(channel, { id: 'a', muted: true, tabId: 'a' }), channel).toEqual({ ok: true })
    }
    expect(menus).toEqual([])
  })

  it('is refused to every internal page by the router’s sender policy', () => {
    // Closing tabs and rearranging the panes are window state no `tessera://` document may touch.
    const chrome: ChromeAddresses = { devServer: null, bundle: ['file:///app/renderer/index.html'] }
    for (const page of INTERNAL_PAGES) {
      for (const channel of Object.keys(arrangementInvokeContract)) {
        const sender = { frameUrl: `tessera://${page}`, isChromeRenderer: false, isMainFrame: true }
        expect(decideAccess(channel, sender, chrome).allowed, `${page}: ${channel}`).toBe(false)
      }
    }
  })

  it('validates its requests', () => {
    const contract = arrangementInvokeContract
    expect(contract['arrangements:close'].request.safeParse({ id: 'a' }).success).toBe(true)
    expect(contract['arrangements:close'].request.safeParse({ id: '' }).success).toBe(false)
    expect(contract['arrangements:activate'].request.safeParse({}).success).toBe(false)
    expect(contract['arrangements:setMuted'].request.safeParse({ id: 'a' }).success).toBe(false)
    expect(
      contract['arrangements:setMuted'].request.safeParse({ id: 'a', muted: true }).success
    ).toBe(true)
    // A tab, not an entry: the tile bar names the page it sits over.
    expect(contract['arrangements:releaseTab'].request.safeParse({ tabId: 't' }).success).toBe(true)
    expect(contract['arrangements:releaseTab'].request.safeParse({ tabId: '' }).success).toBe(false)
    expect(contract['arrangements:releaseTab'].request.safeParse({ id: 'a' }).success).toBe(false)
    // The place a drag from the grip let go of it (U10): a target and a side, as a strip drop has.
    const at = { target: { kind: 'tab', tabId: 'x' }, side: 'before' }
    const release = contract['arrangements:releaseTab'].request
    expect(release.safeParse({ tabId: 't', at }).success).toBe(true)
    expect(
      release.safeParse({ tabId: 't', at: { target: { kind: 'end' }, side: 'after' } }).success
    ).toBe(true)
    expect(release.safeParse({ tabId: 't', at: { ...at, side: 'onto' } }).success).toBe(false)
    expect(release.safeParse({ tabId: 't', at: { side: 'after' } }).success).toBe(false)
  })
})

describe('arrangements:activate (R4)', () => {
  it('brings a put-away view back with its stored active tile', async () => {
    const { h, a, b } = await twoViews()
    const { call } = register(h.window)

    expect(call('arrangements:activate', { id: a })).toEqual({ ok: true })
    h.round()

    expect(h.split.toState().tileTabIds).toEqual(['a1', 'a2'])
    expect(h.split.activeTabId()).toBe('a2')
    expect(entries(h).map(({ id, visible }) => ({ id, visible }))).toEqual([
      { id: a, visible: true },
      { id: b, visible: false }
    ])
  })

  it('leaves the visible one as it is, and ignores an id nobody holds', async () => {
    const { h, b } = await twoViews()
    const { call } = register(h.window)

    call('arrangements:activate', { id: b })
    call('arrangements:activate', { id: 'gone' })

    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b2'])
    expect(h.window.arrangements.liveId).toBe(b)
  })
})

describe('the entry menu (R7)', () => {
  it('shows the visible 1x2 view’s layout as checked', async () => {
    const { h, b } = await twoViews()
    const { call, menus } = register(h.window)

    call('arrangements:contextMenu', { id: b })

    const layouts = item(menus[0], 'Change Layout').submenu as MenuItemConstructorOptions[]
    expect(layouts.filter((entry) => entry.checked === true).map((entry) => entry.label)).toEqual([
      'Two Columns'
    ])
  })

  it('opens nothing for an unknown id', async () => {
    const { h } = await twoViews()
    const { call, menus } = register(h.window)

    expect(call('arrangements:contextMenu', { id: 'gone' })).toEqual({ ok: true })

    expect(menus).toEqual([])
  })

  it('is in the window’s language', async () => {
    const { h, b } = await twoViews()
    const { call, menus } = register(h.window, 'de')

    call('arrangements:contextMenu', { id: b })

    expect(menus[0]?.map((entry) => entry.label)).toContain('Kachelansicht beenden')
  })
})

describe('Change Layout (KTD12)', () => {
  it('brings a put-away view back first, then gives it the layout', async () => {
    const { h, a } = await twoViews()
    const { call, menus } = register(h.window)

    call('arrangements:contextMenu', { id: a })
    click(menus[0], 'Change Layout', 'Four Tiles')
    h.round()

    expect(h.split.layout).toBe('2x2')
    expect(h.split.toState().tileTabIds.slice(0, 2)).toEqual(['a1', 'a2'])
    expect(entries(h).find((entry) => entry.id === a)).toMatchObject({
      layoutId: '2x2',
      visible: true
    })
  })

  it('changes the visible one in place, under its id', async () => {
    const { h, b } = await twoViews()
    const { call, menus } = register(h.window)

    call('arrangements:contextMenu', { id: b })
    click(menus[0], 'Change Layout', 'Two Rows')
    h.round()

    expect(h.split.layout).toBe('2x1')
    expect(entries(h).find((entry) => entry.id === b)).toMatchObject({
      layoutId: '2x1',
      tabIds: ['b1', 'b2'],
      visible: true
    })
  })
})

describe('End Tiled View (R8, KTD12)', () => {
  it('ends a put-away one off screen: the visible one stays, its start pages close', async () => {
    const h = await harness(['x', 'a1', 'a2', 'b1', 'b2'])
    h.addStartPage('s')
    h.show('1x3', ['a1', 's', 'a2'])
    h.round()
    h.activate('x')
    h.show('1x2', ['b1', 'b2'])
    h.round()
    const [a, b] = h.window.arrangements.summaries().map((summary) => summary.id)
    const { call, menus } = register(h.window)
    const publishes = h.window.publishes

    call('arrangements:contextMenu', { id: a })
    click(menus[0], 'End Tiled View')
    h.round()

    expect(h.closed()).toEqual(['s'])
    expect(entries(h)).toEqual([{ id: b, layoutId: '1x2', tabIds: ['b1', 'b2'], visible: true }])
    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b2'])
    expect(h.order()).toEqual(['x', 'a1', 'a2', 'b1', 'b2'])
    // Nothing on screen changed, so the strip has to be told the entry went.
    expect(h.window.publishes).toBeGreaterThan(publishes)
  })

  it('ends the visible one by choosing the single layout', async () => {
    const { h, a, b } = await twoViews()
    const { call, menus } = register(h.window)

    call('arrangements:contextMenu', { id: b })
    click(menus[0], 'End Tiled View')
    h.round()

    expect(h.split.layout).toBe('1x1')
    expect(entries(h).map((entry) => entry.id)).toEqual([a])
    expect(h.order()).toEqual(['x', 'a1', 'a2', 'b1', 'b2'])
  })
})

describe('arrangements:close — closing every tab of an entry (R5, KTD13)', () => {
  it('closes a put-away one’s tabs and leaves the visible one alone', async () => {
    const { h, a, b } = await twoViews()
    const { call } = register(h.window)

    call('arrangements:close', { id: a })
    h.round()

    expect(h.closed()).toEqual(['a1', 'a2'])
    expect(entries(h).map((entry) => entry.id)).toEqual([b])
    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b2'])
  })

  it('pulls nothing into the screen between the closes of the visible one, then shows a loose tab', async () => {
    const h = await harness(['x', 'y', 'b1', 'b2', 'b3'])
    h.show('1x3', ['b1', 'b2', 'b3'])
    h.round()
    const [b] = h.window.arrangements.summaries().map((summary) => summary.id)
    const { call } = register(h.window)

    call('arrangements:close', { id: b })
    h.round()

    expect(h.closed()).toEqual(['b1', 'b2', 'b3'])
    expect(h.screens()).toEqual([[null], [null], [null]])
    expect(h.split.toState().tileTabIds).toEqual(['x'])
    expect(entries(h)).toEqual([])
  })

  it('covers AE8: one page stays, two close, and the one that stayed is an ordinary tab', async () => {
    const h = await harness(['x', 'b1', 'b2', 'b3'])
    h.show('1x3', ['b1', 'b2', 'b3'])
    h.round()
    const [b] = h.window.arrangements.summaries().map((summary) => summary.id)
    h.refuses.add('b2')
    const { call } = register(h.window)

    call('arrangements:close', { id: b })
    h.round()

    expect(h.closed()).toEqual(['b1', 'b3'])
    expect(h.order()).toContain('b2')
    expect(h.window.arrangements.isMember('b2')).toBe(false)
    expect(entries(h)).toEqual([])
    // The page that asked was brought to the front for its question, alone.
    expect(h.split.toState().tileTabIds).toEqual(['b2'])
  })

  it('restores no view and closes no ranks while a page asks', async () => {
    const { h, a, b } = await twoViews()
    h.asks.add('b1')
    const { call } = register(h.window)
    const layoutsBefore = h.layoutChanges().length

    call('arrangements:close', { id: b })

    expect(h.questions()).toEqual([
      // `a` is still put away, `b` is gone from the strip, and the asker stands alone in one pane.
      { tabId: 'b1', liveId: null, entries: [a], tiles: ['b1'] }
    ])
    // The one layout change is the view being put away, before the first close; none follows it.
    expect(h.layoutChanges().slice(layoutsBefore)).toEqual(['1x1'])
    expect(h.closed()).toEqual(['b1', 'b2'])
  })

  it('does nothing for an unknown id', async () => {
    const { h } = await twoViews()
    const { call } = register(h.window)

    call('arrangements:close', { id: 'gone' })

    expect(h.closed()).toEqual([])
    expect(entries(h)).toHaveLength(2)
  })

  it('is what the menu’s Close All Tabs does', async () => {
    const { h, a } = await twoViews()
    const { call, menus } = register(h.window)

    call('arrangements:contextMenu', { id: a })
    click(menus[0], 'Close All Tabs')

    expect(h.closed()).toEqual(['a1', 'a2'])
  })
})

describe('arrangements:setMuted (R6, KTD11)', () => {
  it('mutes a put-away one’s tabs at once, and they stay muted once it is back', async () => {
    const { h, a } = await twoViews()
    const { call } = register(h.window)

    call('arrangements:setMuted', { id: a, muted: true })

    expect(h.muted('a1')).toBe(true)
    expect(h.muted('a2')).toBe(true)
    expect(h.muted('b1')).toBe(false)

    call('arrangements:activate', { id: a })

    expect(h.muted('a1')).toBe(true)
    expect(h.muted('a2')).toBe(true)
    expect(h.split.toState().tileAudio.map((tile) => tile.muted)).toEqual([true, true])
  })

  it('mutes and unmutes every tile of the visible one through its tiles', async () => {
    const { h, b } = await twoViews()
    const { call } = register(h.window)

    call('arrangements:setMuted', { id: b, muted: true })
    expect(h.split.toState().tileAudio.map((tile) => tile.muted)).toEqual([true, true])
    expect(h.muted('b1')).toBe(true)
    expect(h.muted('b2')).toBe(true)

    call('arrangements:setMuted', { id: b, muted: false })
    expect(h.split.toState().tileAudio.map((tile) => tile.muted)).toEqual([false, false])
    expect(h.muted('b1')).toBe(false)
  })

  it('touches no tab for an unknown id', async () => {
    const { h } = await twoViews()
    const { call } = register(h.window)

    call('arrangements:setMuted', { id: 'gone', muted: true })

    for (const tabId of ['x', 'a1', 'a2', 'b1', 'b2']) expect(h.muted(tabId), tabId).toBe(false)
  })
})

describe('the group actions of the entry (R10)', () => {
  it('reach the tab groups through one member of the view', async () => {
    const { h, a } = await twoViews()
    const { call, menus } = register(h.window)

    call('arrangements:contextMenu', { id: a })
    click(menus[0], 'Group these tabs')
    const created = h.window.groups.groups()[0]
    if (created === undefined) throw new Error('no group was made')

    call('arrangements:contextMenu', { id: a })
    click(menus[1], 'Remove from group')

    expect(h.window.groupCalls).toEqual([
      ['create', { tabIds: ['a1'] }],
      ['removeTab', 'a1']
    ])
  })

  it('adds the view to another group through one member', async () => {
    const { h, b } = await twoViews()
    const other = h.window.groups.create({ tabIds: ['x'], name: 'Sport' })
    const { call, menus } = register(h.window)

    call('arrangements:contextMenu', { id: b })
    click(menus[0], 'Add to group', 'Sport')

    expect(h.window.groupCalls.at(-1)).toEqual(['addTab', other.id, 'b1'])
  })
})

describe('arrangements:releaseTab — the tile bar’s release (U10, R9)', () => {
  it('takes one page out of a 1x3: the view stays on screen as a 1x2, the page right behind it', async () => {
    const h = await harness(['x', 'b1', 'b2', 'b3', 'y'])
    h.show('1x3', ['b1', 'b2', 'b3'])
    h.split.setActiveTile(1)
    h.round()
    const [b] = h.window.arrangements.summaries().map((summary) => summary.id)
    const { call } = register(h.window)

    expect(call('arrangements:releaseTab', { tabId: 'b2' })).toEqual({ ok: true })
    h.round()

    expect(entries(h)).toEqual([{ id: b, layoutId: '1x2', tabIds: ['b1', 'b3'], visible: true }])
    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b3'])
    expect(h.order()).toEqual(['x', 'b1', 'b3', 'b2', 'y'])
    // The released page was the active one; a tile of the view is active now, not an empty one.
    expect(['b1', 'b3']).toContain(h.split.activeTabId())
    expect(h.window.arrangements.isMember('b2')).toBe(false)
  })

  it('ends a 1x2: both pages are ordinary tabs and the one left shows the window', async () => {
    const h = await harness(['b1', 'b2'])
    h.show('1x2', ['b1', 'b2'])
    h.round()
    const { call } = register(h.window)

    call('arrangements:releaseTab', { tabId: 'b1' })
    h.round()

    expect(entries(h)).toEqual([])
    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['b2'])
    expect(h.window.arrangements.isMember('b1')).toBe(false)
    expect(h.window.arrangements.isMember('b2')).toBe(false)
  })

  it('leaves a grouped member in its group (R10 keeps the group state)', async () => {
    const h = await harness(['b1', 'b2', 'b3'])
    h.show('1x3', ['b1', 'b2', 'b3'])
    h.round()
    const group = h.window.groups.create({ tabIds: ['b1'] })
    const { call } = register(h.window)

    call('arrangements:releaseTab', { tabId: 'b3' })
    h.round()

    const after = h.window.groups.groups().find((candidate) => candidate.id === group.id)
    expect(after?.tabIds).toEqual(expect.arrayContaining(['b1', 'b2', 'b3']))
    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b2'])
  })

  it('closes no start page, even one in another tile (R8)', async () => {
    const h = await harness(['b1', 'b2'])
    h.addStartPage('s')
    h.show('1x3', ['b1', 's', 'b2'])
    h.round()
    const { call } = register(h.window)

    call('arrangements:releaseTab', { tabId: 'b1' })
    h.round()

    expect(h.closed()).toEqual([])
    expect(h.split.toState().tileTabIds).toEqual(['s', 'b2'])
  })

  it('does nothing for a member of a view put away, or a tab in no view', async () => {
    const { h, a, b } = await twoViews()
    const { call } = register(h.window)
    const before = entries(h)

    call('arrangements:releaseTab', { tabId: 'a1' })
    call('arrangements:releaseTab', { tabId: 'x' })
    call('arrangements:releaseTab', { tabId: 'gone' })
    h.round()

    expect(entries(h)).toEqual(before)
    expect(entries(h).map((entry) => entry.id)).toEqual([a, b])
    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b2'])
    expect(h.order()).toEqual(['x', 'a1', 'a2', 'b1', 'b2'])
  })
})

/**
 * The same release by dragging the tile bar's grip into the strip (U10, KTD14): the strip names the place
 * under the pointer, and the tab goes there instead of behind the entry.
 *
 * The order of the two steps is the whole of what can go wrong. A drop in the strip widens a member of a
 * tiled view to the view (R10), so a drop applied while the tab is still a member moves every page of the
 * view there, and the release after it puts the tab back behind the entry — the user drags one page and
 * watches the whole view move. The release has to come first.
 */
describe('arrangements:releaseTab with a place — the grip let go over the strip (U10)', () => {
  it('releases first and drops the tab alone, not the view it was in', async () => {
    const h = await harness(['x', 'b1', 'b2', 'b3', 'y'])
    h.show('1x3', ['b1', 'b2', 'b3'])
    h.round()
    const [b] = h.window.arrangements.summaries().map((summary) => summary.id)
    const { call } = register(h.window)

    const at = { target: { kind: 'tab', tabId: 'x' }, side: 'before' }
    expect(call('arrangements:releaseTab', { tabId: 'b2', at })).toEqual({ ok: true })
    h.round()

    expect(h.order()).toEqual(['b2', 'x', 'b1', 'b3', 'y'])
    expect(entries(h)).toEqual([{ id: b, layoutId: '1x2', tabIds: ['b1', 'b3'], visible: true }])
    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b3'])
    expect(h.window.arrangements.isMember('b2')).toBe(false)
  })

  it('puts the tab in the group it is dropped into, and leaves the view where it was', async () => {
    const h = await harness(['x', 'b1', 'b2', 'b3', 'y'])
    h.show('1x3', ['b1', 'b2', 'b3'])
    h.round()
    const group = h.window.groups.create({ tabIds: ['y'] })
    const { call } = register(h.window)

    call('arrangements:releaseTab', {
      tabId: 'b2',
      at: { target: { kind: 'tab', tabId: 'y' }, side: 'after' }
    })
    h.round()

    const after = h.window.groups.groups().find((candidate) => candidate.id === group.id)
    expect(after?.tabIds).toEqual(['y', 'b2'])
    expect(h.order()).toEqual(['x', 'b1', 'b3', 'y', 'b2'])
    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b3'])
  })

  it('ends a view of two and drops the page at the end of the strip', async () => {
    const h = await harness(['b1', 'b2', 'x'])
    h.show('1x2', ['b1', 'b2'])
    h.round()
    const { call } = register(h.window)

    call('arrangements:releaseTab', {
      tabId: 'b1',
      at: { target: { kind: 'end' }, side: 'after' }
    })
    h.round()

    expect(entries(h)).toEqual([])
    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['b2'])
    expect(h.order()).toEqual(['b2', 'x', 'b1'])
  })

  it('moves nothing for a tab in no view on screen, place or not', async () => {
    const { h } = await twoViews()
    const { call } = register(h.window)
    const at = { target: { kind: 'end' }, side: 'after' }

    call('arrangements:releaseTab', { tabId: 'x', at })
    call('arrangements:releaseTab', { tabId: 'a1', at })
    h.round()

    expect(h.order()).toEqual(['x', 'a1', 'a2', 'b1', 'b2'])
    expect(h.window.groupCalls).toEqual([])
  })
})
