import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { SplitController } from '@main/browser/SplitController.js'
import {
  createWindowSeams,
  type WindowInternals,
  type WindowSeams
} from '@main/browser/window-seams.js'
import type { OverlayLayer } from '@main/browser/OverlayLayer.js'
import { ArrangementStore } from '@main/data/ArrangementStore.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import { stripItems } from '@shared/tabgroups/strip.js'
import { tabSearchRows } from '@shared/search/tab-search.js'
import { TabDiscards, type DiscardableTab } from '@main/browser/tab-unloader.js'
import type { Rect } from '@shared/split/layout.js'
import type { TabGroup } from '@shared/tabgroups/model.js'
import { scope, tempFile } from './world.js'

/**
 * Steps for `tab-groups.feature`.
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
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1200, height: 800 }

interface GroupedWindow {
  seams: WindowSeams
  split: SplitController
  /** The strip's order, which the fake window rewrites as a real one does. */
  order: () => readonly string[]
  /** A click on a tab in the strip: `BrowserWindowController.activateTab`, tiles and all. */
  activate: (tabId: string) => void
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

/** Builds a window around these tabs and seats each one in the tile of the same index. */
async function openWindow(state: unknown, tabIds: readonly string[]): Promise<void> {
  const groupStore = await TabGroupStore.open({
    filePath: tempFile('tab-groups', 'tab-groups.json')
  })
  const arrangementStore = await ArrangementStore.open({
    filePath: tempFile('tab-groups', 'arrangements.json'),
    debounceMs: 0
  })

  const split = new SplitController({ layout: '1x2' })
  let order = [...tabIds]

  /*
    Cast rather than built because building one means an Electron `WebContentsView`. The seams that
    use it — the drag and the tile bar — are constructed and asked nothing; folding a group away
    dismisses the tile-bound surfaces, which is the one call it answers.
  */
  const overlayStub: unknown = { dismissKind: () => {} }
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
    // No `Tab` objects: `SplitController` is the authority on tile assignment, so a window with
    // none settles exactly as one with them.
    tab: () => undefined,
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

  seams = createWindowSeams(internals)
  tabIds.forEach((tabId, index) => split.assignTab(tabId, index))

  scope(state).scratch[KEY] = {
    seams,
    split,
    order: () => order,
    activate: (tabId) => internals.activateTab(tabId)
  } satisfies GroupedWindow
}

// --- given -------------------------------------------------------------------

Given('a window tiling tabs {string} side by side', async (state: unknown, list: string) => {
  const tabIds = tabList(list)
  // The layout is two panes, so a scenario naming three tabs would seat one nowhere and then
  // assert about a strip it never described.
  expect(tabIds.length, 'a side-by-side window holds exactly two tabs').toBe(2)
  await openWindow(state, tabIds)
})

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

// --- when --------------------------------------------------------------------

/** One coalesced broadcast round — the `arrangements.keep()` in `BrowserWindowController`. */
When('the window settles', (state: unknown) => {
  groupedWindow(state).seams.arrangements.keep()
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

Then('the window shows {string} side by side', (state: unknown, list: string) => {
  const { split } = groupedWindow(state)
  expect(split.layout).toBe('1x2')
  expect(split.toState().tileTabIds).toEqual(tabList(list))
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
