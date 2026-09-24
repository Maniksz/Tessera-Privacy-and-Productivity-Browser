import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SplitController } from '@main/browser/SplitController.js'
import {
  createWindowSeams,
  type WindowInternals,
  type WindowSeams
} from '@main/browser/window-seams.js'
import type { OverlayLayer } from '@main/browser/OverlayLayer.js'
import type { Tab } from '@main/browser/Tab.js'
import { ArrangementStore } from '@main/data/ArrangementStore.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import type { LayoutId, Rect } from '@shared/split/layout.js'

/**
 * Folding a group away, driven through the wiring rather than around it.
 *
 * The defect this file exists for was invisible from either controller. `TabGroupController` released
 * its members' tiles through a host seam and its own test asserted that the seam had been *called*;
 * `createWindowSeams` wired that seam to `Tab.setTileIndex(null)`, which writes a field on a tab and
 * tells the split grid nothing. So a collapsed group's pages stayed on screen — `relayout()` decides
 * visibility from `SplitController.tabIdAt` — with nothing in the strip to close, mute or switch away
 * from them. Exactly the state the docblock over `setCollapsed` says it prevents.
 *
 * Everything below therefore asserts on the split's own state: which layout the window is in, which
 * tab sits in which tile, and which tab is active. A spy proving a function ran is what let the bug
 * through the first time.
 *
 * ## Why the window is faked and the stores are not
 *
 * Same argument as `tests/window-seams-arrangements.test.ts`: `WindowInternals` is the whole surface
 * `BrowserWindowController` exposes to its seams, so a literal satisfying it is a complete stand-in
 * without an Electron process. Nothing here mocks `electron`, and nothing has to: `window-seams.ts`
 * imports nothing from it at runtime and takes the pointer from `cursorScreenPoint`. The release of
 * the tiles is the seams' own code, driven for real; the two capabilities it leans on (`applyLayout`,
 * `activateTab`) are reimplemented in the harness exactly as that class implements them, because how
 * they touch the split is the thing under test.
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1200, height: 800 }

interface FakeTab {
  ephemeral: boolean
  tileIndex: number | null
  setTileIndex: (index: number | null) => void
  goBack: () => void
}

interface Harness {
  seams: WindowSeams
  split: SplitController
  /** Puts each tab in the tile of its position in the list; `null` leaves the tile empty. */
  seat: (tabIds: ReadonlyArray<string | null>) => void
  /** Adds a tab the browser opened for an empty tile and the user never navigated (R13). */
  addFiller: (tabId: string) => void
  /** One coalesced broadcast round, which calls `arrangements.keep()` in `BrowserWindowController`. */
  round: () => void
  /** Tab ids the window was told to close — empty is the assertion R13 asks for. */
  closed: () => string[]
  /** How many releases dismissed the tile-bound surfaces — one per release that moved a tile. */
  releases: () => number
  /** How many redraws the window was asked for. */
  redraws: () => number
  /** Tabs told to go back, in order. */
  wentBack: () => string[]
  recordings: () => Array<{ layoutId: LayoutId; seats: Array<string | null> }>
  cleanup: () => Promise<void>
}

const directories: string[] = []
const flushes: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(flushes.splice(0).map((flush) => flush()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function harness(options: {
  tabs: string[]
  layout: LayoutId
  adaptLayoutToTabs?: boolean
  /** Where the pointer is on the screen. */
  cursor?: { x: number; y: number }
}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-window-seams-collapse-'))
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

  const settings: SettingsSnapshot = {
    ...defaultSettings(),
    'splitView.adaptLayoutToTabs': options.adaptLayoutToTabs ?? true
  }

  const split = new SplitController({ layout: options.layout })
  const arrangements = arrangementStore.bookFor('normal')
  let order = [...options.tabs]
  const closed: string[] = []
  let releases = 0
  let redraws = 0
  const wentBack: string[] = []

  const tabs = new Map<string, FakeTab>()
  const makeTab = (tabId: string, ephemeral: boolean): void => {
    const tab: FakeTab = {
      ephemeral,
      tileIndex: null,
      setTileIndex: (index) => {
        tab.tileIndex = index
      },
      goBack: () => {
        wentBack.push(tabId)
      }
    }
    tabs.set(tabId, tab)
  }
  for (const tabId of options.tabs) makeTab(tabId, false)

  const overlayStub: unknown = {
    dismissKind: (kind: string) => {
      if (kind === 'tile-bar') releases += 1
    }
  }

  const internals: WindowInternals = {
    split,
    overlay: overlayStub as OverlayLayer,
    isDestroyed: () => false,
    getSettings: () => settings,
    contentBounds: () => CONTENT,
    cursorScreenPoint: () => options.cursor ?? { x: 0, y: 0 },
    contentRect: () => CONTENT,
    setFullScreenable: () => {},
    exitWindowFullscreen: () => {},
    enterWindowFullscreen: () => {},
    toggleWindowFullscreen: () => {},
    /*
      Real stand-ins here, unlike the arrangements file, because two of the questions below are asked
      of a `Tab`: whether it is one of the browser's own fillers (R13), and the tile index the strip
      draws. A window that answered `undefined` would let the old wiring — `setTileIndex(null)` and
      nothing else — look like it had done something.
    */
    tab: (tabId) => tabs.get(tabId) as unknown as Tab | undefined,
    tabIds: () => order,
    tabOrder: () => order,
    setTabOrder: (next) => {
      order = [...next]
    },
    assignTabToTile: (tabId, tileIndex) => {
      if (tileIndex !== null) {
        const displaced = split.tabIdAt(tileIndex)
        if (displaced !== null && displaced !== tabId) tabs.get(displaced)?.setTileIndex(null)
      }
      split.assignTab(tabId, tileIndex)
      tabs.get(tabId)?.setTileIndex(tileIndex)
    },
    closeTab: (tabId) => {
      closed.push(tabId)
      order = order.filter((id) => id !== tabId)
      tabs.delete(tabId)
      split.forgetTab(tabId)
    },
    activateTab: (tabId) => {
      // `BrowserWindowController.activateTab`, both branches.
      const tile = split.tileOfTab(tabId)
      if (tile !== null) {
        split.setActiveTile(tile)
      } else {
        seams.arrangements.restoreFor(tabId)
        if (split.tileOfTab(tabId) === null) {
          internals.assignTabToTile(tabId, seams.occupancy.claimTileForNewTab())
        }
      }
    },
    setActiveTile: (tileIndex) => split.setActiveTile(tileIndex),
    openFiller: (tileIndex) => {
      const tabId = `filler-${order.length}`
      order.push(tabId)
      makeTab(tabId, true)
      internals.assignTabToTile(tabId, tileIndex)
    },
    applyLayout: (layout, changeOptions) => {
      // `BrowserWindowController.#applyLayout`, minus the overlay and fraction work no assertion here
      // can see.
      seams.occupancy.afterLayoutChange(split.setLayout(layout), changeOptions)
    },
    presentOverlay: () => {},
    relayout: () => {
      redraws += 1
    },
    broadcast: () => {},
    onOverlayPresentationChanged: () => {},
    tabGroups: groupStore.bookFor('normal'),
    arrangements
  }

  const seams = createWindowSeams(internals)

  return {
    seams,
    split,
    seat: (tabIds) => {
      tabIds.forEach((tabId, index) => {
        if (tabId !== null) internals.assignTabToTile(tabId, index)
      })
    },
    addFiller: (tabId) => {
      order.push(tabId)
      makeTab(tabId, true)
    },
    round: () => {
      seams.arrangements.keep()
    },
    closed: () => closed,
    releases: () => releases,
    redraws: () => redraws,
    wentBack: () => wentBack,
    recordings: () =>
      arrangements.list().map((held) => ({ layoutId: held.layoutId, seats: held.seats })),
    cleanup: async () => {
      await arrangementStore.flush()
      await groupStore.flush()
    }
  }
}

describe('folding a group away gives its tiles back', () => {
  it('leaves the split holding none of the members, in a smaller layout (AE5, R9, R10)', async () => {
    /*
      The reported state, and the one the seam was silently failing to produce. Two members holding
      the only two tiles of a `1x2`: releasing them has to reach the *split*, because that is what
      `relayout()` reads to decide which view is on screen. Writing `tileIndex = null` on the tab
      left both pages up with no tab in the strip to act on.
    */
    const h = await harness({ tabs: ['m1', 'm2', 'other'], layout: '1x2' })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['m1', 'm2'])
    h.split.setActiveTile(1)

    h.seams.groups.setCollapsed(group.id, true)

    expect(h.split.tileOfTab('m1')).toBeNull()
    expect(h.split.tileOfTab('m2')).toBeNull()
    expect(h.split.layout).toBe('1x1')
    // R10: the active tab was one of the folded members, so the first tab the strip still draws
    // takes over. Without this every toolbar command reads `activeTabId() === null` and no-ops.
    expect(h.split.activeTabId()).toBe('other')
    await h.cleanup()
  })

  it('closes nothing, however many tiles it takes back (AE8, R13)', async () => {
    const h = await harness({ tabs: ['m1', 'm2', 'm3', 'm4'], layout: '2x2' })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2', 'm3', 'm4'] })
    h.seat(['m1', 'm2', 'm3', 'm4'])

    h.seams.groups.setCollapsed(group.id, true)

    expect(h.closed()).toEqual([])
    expect(h.split.toState().tileTabIds).toEqual([null])
    expect(h.split.layout).toBe('1x1')
    await h.cleanup()
  })

  it('keeps a filler the shrink would otherwise sweep up (R13)', async () => {
    /*
      The trap in reusing the close path. `afterLayoutChange` closes every *orphaned* tab the browser
      opened itself, so a shrink that let a filler fall off the end of the grid would cost the user a
      tab — and R13 forbids losing even that one. The tiles that survive are compacted before the
      layout changes, so nothing is orphaned and nothing is swept up.
    */
    const h = await harness({ tabs: ['m1', 'm2', 'foreign'], layout: '2x2' })
    h.addFiller('filler')
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['m1', 'm2', 'filler', 'foreign'])

    h.seams.groups.setCollapsed(group.id, true)

    expect(h.closed()).toEqual([])
    expect(h.split.toState().tileTabIds).toEqual(['filler', 'foreign'])
    await h.cleanup()
  })

  it('shrinks with layout adaptation off and pulls no loose tab in (AE10, R9, R13, R15)', async () => {
    /*
      The mixed window, and the case where the close path would have gone wrong twice over:
      `afterTabClosed` returns early when adaptation is off — so R9 would not hold at all — and when
      it does run it seats `#firstHiddenTab()` in the freed tile, which is the filling KD7 rejected.
      Neither happens here: the shrink is unconditional and moves only tabs that already held a tile.
    */
    const h = await harness({
      tabs: ['m1', 'm2', 'f1', 'f2', 'loose'],
      layout: '2x2',
      adaptLayoutToTabs: false
    })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['m1', 'f1', 'm2', 'f2'])
    h.split.setActiveTile(0)
    h.round()

    h.seams.groups.setCollapsed(group.id, true)

    expect(h.split.layout).toBe('1x2')
    expect(h.split.toState().tileTabIds).toEqual(['f1', 'f2'])
    expect(h.closed()).toEqual([])
    // "kein weiterer Tab ist nachgerückt": the loaded, untiled foreign tab stays off the grid.
    expect(h.split.tileOfTab('loose')).toBeNull()
    // R15: the recording of the tiling that has just been folded away is still there to come back to.
    expect(h.recordings()).toEqual([{ layoutId: '2x2', seats: ['m1', 'f1', 'm2', 'f2'] }])
    await h.cleanup()
  })

  it('leaves an active tab that was not a member active (R10)', async () => {
    const h = await harness({ tabs: ['m1', 'm2', 'f1', 'f2'], layout: '2x2' })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['m1', 'f1', 'm2', 'f2'])
    h.split.setActiveTile(1)

    h.seams.groups.setCollapsed(group.id, true)

    // It moved tile — the survivors are compacted — but it is still the page in front of the user.
    expect(h.split.activeTabId()).toBe('f1')
    await h.cleanup()
  })

  it('takes three tiles back in one release, not one release per member (KTD5)', async () => {
    const h = await harness({ tabs: ['m1', 'm2', 'm3', 'other'], layout: '1x3' })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2', 'm3'] })
    h.seat(['m1', 'm2', 'm3'])

    h.seams.groups.setCollapsed(group.id, true)

    // One release carrying all three, and one redraw for it — the reason the capability is plural.
    expect(h.releases()).toBe(1)
    expect(h.redraws()).toBe(1)
    expect(['m1', 'm2', 'm3'].map((tabId) => h.split.tileOfTab(tabId))).toEqual([null, null, null])
    await h.cleanup()
  })

  it('does not touch the split for a group whose members hold no tile', async () => {
    const h = await harness({ tabs: ['m1', 'm2', 'shown'], layout: '1x2' })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['shown'])

    h.seams.groups.setCollapsed(group.id, true)

    expect(h.split.layout).toBe('1x2')
    expect(h.split.toState().tileTabIds).toEqual(['shown', null])
    expect(h.releases()).toBe(0)
    expect(h.redraws()).toBe(0)
    await h.cleanup()
  })

  it('brings the members back untiled when the group is opened again (R11)', async () => {
    /*
      Expanding is not the way back to a tiling — `ArrangementController` holds that, and clicking a
      member is what applies it. The members return as ordinary unassigned tabs.
    */
    const h = await harness({ tabs: ['m1', 'm2', 'other'], layout: '1x2' })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['m1', 'm2'])
    h.seams.groups.setCollapsed(group.id, true)

    const layoutAfterCollapse = h.split.layout
    h.seams.groups.setCollapsed(group.id, false)

    expect(h.seams.groups.isHidden('m1')).toBe(false)
    expect(h.split.tileOfTab('m1')).toBeNull()
    expect(h.split.tileOfTab('m2')).toBeNull()
    expect(h.split.layout).toBe(layoutAfterCollapse)
    await h.cleanup()
  })
})

describe('the pointer', () => {
  it('comes from the window rather than from Electron, in the content area’s coordinates', async () => {
    /*
      `window-seams.ts` used to call `screen.getCursorScreenPoint()` itself, which is why no test could
      build the seams without an Electron process. The pointer is now a capability of the window: a
      back gesture lands in the tile under it, not in the active one.
    */
    const h = await harness({ tabs: ['left', 'right'], layout: '1x2', cursor: { x: 900, y: 488 } })
    h.seat(['left', 'right'])
    h.split.setActiveTile(0)

    h.seams.tileInput.navigateByGesture('app-command', 'browser-backward')

    expect(h.wentBack()).toEqual(['right'])
    await h.cleanup()
  })
})
