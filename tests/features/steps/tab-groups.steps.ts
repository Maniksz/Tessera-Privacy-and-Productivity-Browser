import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { SplitController } from '@main/browser/SplitController.js'
import {
  createWindowSeams,
  type WindowInternals,
  type WindowSeams
} from '@main/browser/window-seams.js'
import type { OverlayLayer } from '@main/browser/OverlayLayer.js'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { ArrangementStore } from '@main/data/ArrangementStore.js'
import {
  registerArrangementHandlers,
  type ArrangementHandle,
  type ArrangementWindow
} from '@main/ipc/arrangement-handlers.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import type { ArrangementSummary } from '@shared/arrangements/screen.js'
import { stripItems, type StripItem } from '@shared/strip/model.js'
import { HOME_URL } from '@shared/url/omnibox.js'
import { tabSearchRows } from '@shared/search/tab-search.js'
import { TabDiscards, type DiscardableTab } from '@main/browser/tab-unloader.js'
import { isLayoutId, type LayoutId, type Rect } from '@shared/split/layout.js'
import { dropZonesFor } from '@shared/split/dropzones.js'
import type { Tab } from '@main/browser/Tab.js'
import type { TabGroup } from '@shared/tabgroups/model.js'
import { scope, tempFile } from './world.js'

/**
 * Steps for `tab-groups.feature` and `tiled-views.feature`.
 *
 * A window's real seams, over real stores, because that is where the reported defect lived. Neither
 * controller was wrong: `TabGroupController.dissolve` dissolved, and the pass that keeps the tiling
 * written down wrote it down — into the book of groups, because a group was the only place a layout
 * could live, so it made one to write into. The bug was in `createWindowSeams`, and a scenario
 * driving either controller alone would pass while a user watched the chip come back.
 *
 * So the whole seam is built here and driven the way `BrowserWindowController` drives it: "the
 * window settles" is the `arrangements.keep()` of that class's coalesced broadcast round. What is
 * asserted at the end is the *strip* — `stripItems` is what the tab bar draws from — because "the
 * chip is gone" is the sentence the defect was reported in.
 *
 * `BrowserWindowController` itself cannot be here: it needs a browser process, which is why it is on
 * the coverage exclude list and why the defect survived. `WindowInternals` is the entire surface it
 * offers its seams, so a literal satisfying that interface is a complete stand-in for a window.
 *
 * A tiled view's entry in the strip is driven through the real `arrangements:*` handlers over the
 * same seams, the way a click and a right-click on the entry reach them: `ArrangementWindow` is all
 * those handlers ask of a window, and the seams answer most of it. The menu is the real template,
 * picked by its English labels.
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1200, height: 800 }

interface GroupedWindow {
  seams: WindowSeams
  split: SplitController
  /** The strip's order, which the fake window rewrites as a real one does. */
  order: () => readonly string[]
  /** A click on a tab in the strip: `BrowserWindowController.activateTab`, tiles and all. */
  activate: (tabId: string) => void
  /** A tab opened in the background: in the strip, in no tile — at the end, or at the front. */
  addTab: (tabId: string, where?: 'front' | 'end') => void
  /** The `arrangements:*` channels as the entry in the strip invokes them. */
  invoke: (channel: string, payload: unknown) => void
  /** Every native menu the handlers put up, the latest last. */
  menus: MenuItemConstructorOptions[][]
}

/**
 * Kept in the scenario's `scratch` rather than as a field of `Scope`.
 *
 * The shape is this file's alone — no other step file has a window's seams to share — and a typed
 * field in `world.ts` would mean `world.ts` importing a type from a module that imports it back.
 */
const KEY = 'groupedWindow'

function groupedWindow(state: unknown): GroupedWindow {
  const held = scope(state).scratch[KEY]
  if (held === undefined) throw new Error('this scenario has no window; add a Given for it')
  return held as GroupedWindow
}

/** Where `I search the tabs for` leaves the ids it listed, in its order. */
const SEARCH_KEY = 'tabSearchResults'

function searchResults(state: unknown): readonly string[] {
  const held = scope(state).scratch[SEARCH_KEY]
  if (held === undefined) throw new Error('this scenario has searched nothing; add a When for it')
  return held as readonly string[]
}

function groupNamed(state: unknown, name: string): TabGroup {
  const group = groupedWindow(state)
    .seams.groups.groups()
    .find((held) => held.name === name)
  if (group === undefined) throw new Error(`no group called ${name}`)
  return group
}

function tabList(list: string): string[] {
  return list.split(',').map((name) => name.trim())
}

/**
 * Whether a tab shows the start page. A tab the scenario names `start page…` does, and so does a
 * filler the window opens for an empty tile, as a real one would.
 */
function showsStartPage(tabId: string): boolean {
  return tabId.startsWith('start page') || tabId.startsWith('filler-')
}

/** Builds a window around these tabs and seats each one in the tile of the same index. */
async function openWindow(
  state: unknown,
  tabIds: readonly string[],
  layout: LayoutId = '1x2'
): Promise<void> {
  const groupStore = await TabGroupStore.open({
    filePath: tempFile('tab-groups', 'tab-groups.json')
  })
  const arrangementStore = await ArrangementStore.open({
    filePath: tempFile('tab-groups', 'arrangements.json'),
    debounceMs: 0
  })

  const split = new SplitController({ layout })
  // A tab named twice, or one more than the layout has tiles, would seat nowhere and then be
  // asserted about as if it had.
  expect(new Set(tabIds).size, 'every tab has a name of its own').toBe(tabIds.length)
  expect(tabIds.length, `the ${layout} layout holds as many tabs`).toBe(split.tileCount)
  let order = [...tabIds]

  /*
    Cast rather than built because building one means an Electron `WebContentsView`. The seams that
    use it — the drag and the tile bar — are constructed and asked nothing; folding a group away
    dismisses the tile-bound surfaces, which is the one call it answers.
  */
  const overlayStub: unknown = { dismissKind: () => {}, dismiss: () => {} }
  const overlay = overlayStub as OverlayLayer

  /*
    Read lazily for the same reason `createWindowSeams` reads its own occupancy controller lazily:
    the window hands the seams a way back into itself, and the seams do not exist until the window
    has described itself. Nothing calls any of it during construction.
  */
  let seams: WindowSeams | null = null

  const internals: WindowInternals = {
    split,
    overlay,
    isDestroyed: () => false,
    getSettings: () => defaultSettings(),
    contentBounds: () => CONTENT,
    cursorScreenPoint: () => ({ x: 0, y: 0 }),
    contentRect: () => CONTENT,
    setFullScreenable: () => {},
    exitWindowFullscreen: () => {},
    enterWindowFullscreen: () => {},
    toggleWindowFullscreen: () => {},
    /*
      Tab objects only as far as the seams read them — a title for the drag, and switches that do
      nothing. `SplitController` is the authority on tile assignment, so a window with these settles
      exactly as one with real tabs.
    */
    tab: (tabId) => (order.includes(tabId) ? fakeTab(tabId) : undefined),
    tabIds: () => order,
    tabOrder: () => order,
    setTabOrder: (next) => {
      order = [...next]
    },
    assignTabToTile: (tabId, tileIndex) => {
      split.assignTab(tabId, tileIndex)
    },
    closeTab: (tabId) => {
      order = order.filter((id) => id !== tabId)
      split.forgetTab(tabId)
    },
    // Both ways back `BrowserWindowController.activateTab` has for a tab with no tile: a recording
    // that seats it, or else the window, the way a new tab gets it.
    activateTab: (tabId) => {
      const tile = split.tileOfTab(tabId)
      if (tile !== null) {
        split.setActiveTile(tile)
        return
      }
      seams?.arrangements.restoreFor(tabId)
      if (seams !== null && split.tileOfTab(tabId) === null) {
        split.assignTab(tabId, seams.occupancy.claimTileForNewTab())
      }
    },
    setActiveTile: (tileIndex) => split.setActiveTile(tileIndex),
    openFiller: (tileIndex) => {
      const id = `filler-${order.length}`
      order.push(id)
      split.assignTab(id, tileIndex)
    },
    applyLayout: (layout, options) => {
      seams?.occupancy.afterLayoutChange(split.setLayout(layout), options)
    },
    presentOverlay: () => {},
    relayout: () => {},
    broadcast: () => {},
    onOverlayPresentationChanged: () => {},
    tabGroups: groupStore.bookFor('normal'),
    arrangements: arrangementStore.bookFor('normal')
  }

  const built = createWindowSeams(internals)
  seams = built
  tabIds.forEach((tabId, index) => split.assignTab(tabId, index))

  /*
    What `BrowserWindowController` is to the handlers, over the same seams: `setLayout` is the
    toolbar's choice (`chooseLayout`), and the rest reaches the fake window above. Nothing here is
    muted or published, because no scenario asks about either.
  */
  const window: ArrangementWindow = {
    arrangements: built.arrangements,
    groups: built.groups,
    split,
    occupancy: built.occupancy,
    setLayout: (next) => built.occupancy.chooseLayout(next),
    setTileMuted: (tileIndex, muted) => split.setTileMuted(tileIndex, muted),
    activateTab: (tabId) => internals.activateTab(tabId),
    closeTab: (tabId) => internals.closeTab(tabId),
    resolveTab: (tabId) => (order.includes(tabId) ? { setMuted: () => {} } : undefined),
    publish: () => {}
  }
  const handlers = new Map<string, (payload: unknown, event: IpcMainInvokeEvent) => unknown>()
  const menus: MenuItemConstructorOptions[][] = []
  const handle = ((channel: string, handler: (payload: unknown, event: unknown) => unknown) => {
    handlers.set(channel, handler)
  }) as unknown as ArrangementHandle
  registerArrangementHandlers({
    handle,
    windows: { resolve: () => window },
    locale: () => 'en',
    showMenu: (template) => menus.push(template)
  })
  // Never read: the handlers resolve the window through `windows.resolve`, which ignores it.
  const event: unknown = {}

  scope(state).scratch[KEY] = {
    seams: built,
    split,
    order: () => order,
    activate: (tabId) => internals.activateTab(tabId),
    addTab: (tabId, where = 'end') => {
      if (where === 'front') order.unshift(tabId)
      else order.push(tabId)
    },
    invoke: (channel, payload) => {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`nothing registered on ${channel}`)
      handler(payload, event as IpcMainInvokeEvent)
    },
    menus
  } satisfies GroupedWindow
}

/** The one tiled view the window holds; a scenario about "the tiled view" means there is one. */
function theTiledView(state: unknown): ArrangementSummary {
  const summaries = groupedWindow(state).seams.arrangements.summaries()
  expect(summaries.length, 'the window holds one tiled view').toBe(1)
  return summaries[0]!
}

/**
 * The strip as a line of text, from what the tab bar draws (`stripItems` over the tabs, the groups
 * and the tiled views): a tab is its name, a tiled view its members in tile order as `[a | b]`, and
 * a group chip `<Name>` when open or `<Name: n>` when folded, `n` being the entries it hides.
 */
function stripText(state: unknown): string {
  const window = groupedWindow(state)
  const items: StripItem[] = stripItems(
    window.order(),
    window.seams.groups.groups(),
    window.seams.arrangements.summaries()
  )
  return items
    .map((item) => {
      if (item.kind === 'tab') return item.tabId
      if (item.kind === 'split') return `[${item.tabIds.join(' | ')}]`
      return item.group.collapsed
        ? `<${item.group.name}: ${item.hiddenCount}>`
        : `<${item.group.name}>`
    })
    .join(', ')
}

/** Clicks a menu item by its labels, a submenu's path separated by ` > `. */
function clickMenuItem(template: readonly MenuItemConstructorOptions[], path: string): void {
  let level: readonly MenuItemConstructorOptions[] = template
  const labels = path.split(' > ')
  for (const [index, label] of labels.entries()) {
    const found = level.find((entry) => entry.label === label)
    if (found === undefined) throw new Error(`the menu has no item ${label}`)
    if (index === labels.length - 1) {
      ;(found.click as () => void)()
      return
    }
    level = found.submenu as MenuItemConstructorOptions[]
  }
}

/**
 * A `Tab` as far as the seams read one: its title for a drag, its address for the start-page rule,
 * and switches that do nothing. Every page has finished loading and holds no typed input, so the
 * start-page rule (`isStartPageTile`) decides by the address alone.
 */
function fakeTab(tabId: string): Tab {
  const fake: unknown = {
    id: tabId,
    ephemeral: false,
    setTileIndex: () => {},
    setMuted: () => {},
    toState: () => ({
      id: tabId,
      title: tabId,
      url: showsStartPage(tabId) ? HOME_URL : `https://${tabId}.example/`,
      loading: false,
      pendingInput: null
    })
  }
  return fake as Tab
}

// --- given -------------------------------------------------------------------

Given('a window tiling tabs {string} side by side', async (state: unknown, list: string) => {
  const tabIds = tabList(list)
  // The layout is two panes, so a scenario naming three tabs would seat one nowhere and then
  // assert about a strip it never described.
  expect(tabIds.length, 'a side-by-side window holds exactly two tabs').toBe(2)
  await openWindow(state, tabIds)
})

Given(
  'a window tiling tabs {string} in the {string} layout',
  async (state: unknown, list: string, layout: string) => {
    if (!isLayoutId(layout)) throw new Error(`not a layout id: ${layout}`)
    await openWindow(state, tabList(list), layout)
  }
)

Given('the tabs {string} are grouped as {string}', (state: unknown, list: string, name: string) => {
  groupedWindow(state).seams.groups.create({ tabIds: tabList(list), name })
})

Given('the tabs {string} are grouped without a name', (state: unknown, list: string) => {
  groupedWindow(state).seams.groups.create({ tabIds: tabList(list) })
})

Given('the group {string} is folded', (state: unknown, name: string) => {
  const groups = groupedWindow(state).seams.groups
  groups.setCollapsed(groupNamed(state, name).id, true)
})

Given('a loose tab {string}', (state: unknown, tabId: string) => {
  groupedWindow(state).addTab(tabId)
})

Given('a loose tab {string} at the front of the strip', (state: unknown, tabId: string) => {
  groupedWindow(state).addTab(tabId, 'front')
})

// --- when --------------------------------------------------------------------

/** One coalesced broadcast round — the `arrangements.keep()` in `BrowserWindowController`. */
When('the window settles', (state: unknown) => {
  groupedWindow(state).seams.arrangements.keep()
})

/**
 * A tab dragged from the strip onto the right edge of the second pane, which grows the side-by-side
 * view into three columns with the tab in the new one. `TabDragController` from press to drop, so
 * the drop goes through the window's own seam, the way the strip's does.
 */
When('I drag {string} onto a new tile beside the tiled view', (state: unknown, tabId: string) => {
  const { seams, split } = groupedWindow(state)
  const zone = dropZonesFor(split.layout, CONTENT).find(
    (candidate) => candidate.layout === '1x3' && candidate.tileIndex === 2
  )
  if (zone === undefined) throw new Error('this window has no edge that grows a third column')
  seams.drag.start(tabId)
  seams.drag.end({ x: zone.hit.x + zone.hit.width / 2, y: zone.hit.y + zone.hit.height / 2 }, true)
})

When('I dissolve the group {string}', (state: unknown, name: string) => {
  groupedWindow(state).seams.groups.dissolve(groupNamed(state, name).id)
})

When('I take {string} out of its group', (state: unknown, tabId: string) => {
  groupedWindow(state).seams.groups.removeTab(tabId)
})

/**
 * The layout menu's choice — `BrowserWindowController.setLayout` — which is `chooseLayout` on the
 * occupancy seam and nothing else. Worded apart from `split-view.feature`'s "I switch to the … layout",
 * which drives a bare split with no seams behind it.
 */
When('I choose the single layout for the window', (state: unknown) => {
  groupedWindow(state).seams.occupancy.chooseLayout('1x1')
})

When('I choose the side-by-side layout for the window', (state: unknown) => {
  groupedWindow(state).seams.occupancy.chooseLayout('1x2')
})

When('I click the tab {string}', (state: unknown, tabId: string) => {
  groupedWindow(state).activate(tabId)
})

/** A click into a tile's page, which makes that tile the active one (`split:setActiveTile`). */
When('I click into the tile showing {string}', (state: unknown, tabId: string) => {
  const { split } = groupedWindow(state)
  const tile = split.tileOfTab(tabId)
  if (tile === null) throw new Error(`no tile shows ${tabId}`)
  split.setActiveTile(tile)
})

/** A click on the tiled view's entry in the strip: `arrangements:activate` with its id. */
When('I click the entry of the tiled view', (state: unknown) => {
  groupedWindow(state).invoke('arrangements:activate', { id: theTiledView(state).id })
})

/**
 * A right-click on the tiled view's entry, which puts up its native menu
 * (`arrangements:contextMenu`), and a click on one of its items.
 */
When('I choose {string} from the menu of the tiled view', (state: unknown, path: string) => {
  const window = groupedWindow(state)
  window.invoke('arrangements:contextMenu', { id: theTiledView(state).id })
  const menu = window.menus.at(-1)
  if (menu === undefined) throw new Error('the entry put up no menu')
  clickMenuItem(menu, path)
})

/** A click on a group's chip that folds it — the same call as the Given above. */
When('I fold the group {string}', (state: unknown, name: string) => {
  groupedWindow(state).seams.groups.setCollapsed(groupNamed(state, name).id, true)
})

/**
 * The tab search's own list over this window's tabs, in the strip's order (U22).
 *
 * Each tab is titled with its name and given an address of its own, so a search for a name finds that
 * tab by title and by address alike.
 */
When('I search the tabs for {string}', (state: unknown, text: string) => {
  const tabs = groupedWindow(state)
    .order()
    .map((id) => ({ id, title: id, url: `https://${id}.example/` }))
  scope(state).scratch[SEARCH_KEY] = tabSearchRows(tabs, text).map((row) => row.id)
})

/**
 * What `BrowserWindowController.activateTab` does to a tab's group, and nothing it does to tiles.
 *
 * The window itself needs a browser process (see the top of this file), so the step runs the one call of
 * `activateTab` that decides about groups — `TabDiscards.wake`, over the window's real group controller.
 * The tab is loaded and nobody's discard, so waking it only unfolds its group and asks it to load if it
 * was deferred.
 */
When('I activate the first tab the search lists', (state: unknown) => {
  const tabId = searchResults(state)[0]
  if (tabId === undefined) throw new Error('the search listed nothing to activate')
  const noop = (): void => {}
  // Never read: waking a tab that was not discarded touches no view.
  const noContents: unknown = {}
  const loaded: DiscardableTab = {
    id: tabId,
    view: { webContents: noContents as DiscardableTab['view']['webContents'] },
    currentUrl: `https://${tabId}.example/`,
    tileIndex: null,
    markActive: noop,
    beginDiscard: noop,
    endDiscard: noop,
    revive: noop,
    loadIfDeferred: noop,
    loadUrl: noop
  }
  new TabDiscards({
    tab: (id) => (id === tabId ? loaded : undefined),
    contract: { discard: noop, track: noop },
    contentView: { addChildView: noop, removeChildView: noop },
    groups: groupedWindow(state).seams.groups,
    onViewReplaced: noop
  }).wake(tabId)
})

// --- then --------------------------------------------------------------------

Then('the tab strip shows no group chip', (state: unknown) => {
  const window = groupedWindow(state)
  const chips = stripItems(window.order(), window.seams.groups.groups()).filter(
    (item) => item.kind === 'group'
  )
  expect(chips, 'the strip still draws a group chip').toEqual([])
})

Then('the window shows only {string}', (state: unknown, tabId: string) => {
  const { split } = groupedWindow(state)
  expect(split.layout, 'the window is still split').toBe('1x1')
  expect(split.toState().tileTabIds).toEqual([tabId])
})

/**
 * A split whose second pane the browser filled for a layout the user chose. `openFiller` in the fake
 * window names its tabs `filler-…`, which is how a start page is told apart here from a page the
 * scenario opened.
 */
Then('the window shows {string} beside a start page', (state: unknown, tabId: string) => {
  const { split } = groupedWindow(state)
  expect(split.layout).toBe('1x2')
  const [left, right] = split.toState().tileTabIds
  expect(left).toBe(tabId)
  expect(right, 'the second pane holds a page the scenario opened').toMatch(/^filler-/)
})

Then('the group {string} still holds {string}', (state: unknown, name: string, list: string) => {
  expect(groupNamed(state, name).tabIds).toEqual(tabList(list))
})

Then('the tab strip shows one unnamed group chip', (state: unknown) => {
  const window = groupedWindow(state)
  const names = stripItems(window.order(), window.seams.groups.groups()).flatMap((item) =>
    item.kind === 'group' ? [item.group.name] : []
  )
  expect(names).toEqual([''])
})

Then('the tab search lists {string} first', (state: unknown, name: string) => {
  expect(searchResults(state)[0]).toBe(name)
})

Then('the tiled view holds {string}', (state: unknown, list: string) => {
  const summaries = groupedWindow(state).seams.arrangements.summaries()
  expect(summaries.map((summary) => summary.tabIds)).toEqual([tabList(list)])
})

Then('the group {string} is open', (state: unknown, name: string) => {
  expect(groupNamed(state, name).collapsed, `${name} is still folded`).toBe(false)
})

Then('the tab strip still shows tabs {string}', (state: unknown, list: string) => {
  const window = groupedWindow(state)
  const shown = stripItems(window.order(), window.seams.groups.groups())
    .filter((item) => item.kind === 'tab')
    .map((item) => item.tabId)
  // Dissolving a group must not cost a tab: the members go on being ordinary tabs (R4).
  expect(shown).toEqual(tabList(list))
})

Then('the tab strip reads {string}', (state: unknown, text: string) => {
  expect(stripText(state)).toBe(text)
})

Then(
  'the window shows {string} in the {string} layout',
  (state: unknown, list: string, layout: string) => {
    const { split } = groupedWindow(state)
    expect(split.layout).toBe(layout)
    expect(split.toState().tileTabIds).toEqual(tabList(list))
  }
)

Then('the active tile shows {string}', (state: unknown, tabId: string) => {
  expect(groupedWindow(state).split.activeTabId()).toBe(tabId)
})

/** The view as its entry holds it while off screen: members in tile order, layout, active page. */
Then(
  'the tiled view is put away as {string} in the {string} layout with {string} active',
  (state: unknown, list: string, layout: string, active: string) => {
    const view = theTiledView(state)
    expect(view.visible, 'the tiled view is still on screen').toBe(false)
    expect(view.tabIds).toEqual(tabList(list))
    expect(view.layoutId).toBe(layout)
    expect(view.activeTabId).toBe(active)
  }
)

Then('the window holds no tiled view', (state: unknown) => {
  expect(groupedWindow(state).seams.arrangements.summaries()).toEqual([])
})

Then('the tab {string} is closed', (state: unknown, tabId: string) => {
  expect(groupedWindow(state).order(), `${tabId} is still open`).not.toContain(tabId)
})
