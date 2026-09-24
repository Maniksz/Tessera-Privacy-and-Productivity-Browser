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
import { stripItems } from '@shared/strip/model.js'

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

describe('folding a group away puts its tiled view away (R11, AE6)', () => {
  /*
    It used to release the folded members' tiles one by one and shrink the layout round whatever was
    left. With a tiled view an entry in the strip that rewrote the view: the next settle wrote the
    reduced seating into it, or ended it once fewer than two were left. The fold now puts the view
    away whole — its seats, its view and its start pages as they were — and gives the window the
    first tab the strip still draws (R10, R11). Expanding brings nothing back by itself.
  */
  it('puts the view away unchanged and shows the first visible tab (AE6)', async () => {
    const h = await harness({ tabs: ['m1', 'm2', 'other'], layout: '1x2' })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['m1', 'm2'])
    h.split.setActiveTile(1)
    h.round()
    const id = h.seams.arrangements.liveId

    h.seams.groups.setCollapsed(group.id, true)
    h.round()

    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['other'])
    expect(h.recordings()).toEqual([{ layoutId: '1x2', seats: ['m1', 'm2'] }])
    expect(h.seams.arrangements.summaries()).toMatchObject([{ id, activeTile: 1, visible: false }])
    // The folded chip counts the view as one entry, not as its two pages (R11).
    const [chip] = stripItems(
      h.seams.groups.displayOrder(),
      h.seams.groups.groups(),
      h.seams.arrangements.summaries()
    )
    expect(chip).toMatchObject({ kind: 'group', hiddenCount: 1 })
    await h.cleanup()
  })

  it('leaves the seats of a view it folds only partly as they were (R11)', async () => {
    /*
      The rewrite this replaces, in the one shape where it showed. Releasing `m1` and `m2` alone left
      `f1 | f2` on screen, and the next settle wrote that into the view — two of its members gone
      from its entry because a group was folded (R16).
    */
    const h = await harness({ tabs: ['m1', 'm2', 'f1', 'f2'], layout: '2x2' })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['m1', 'f1', 'm2', 'f2'])
    h.round()

    h.seams.groups.setCollapsed(group.id, true)
    h.round()

    expect(h.recordings()).toEqual([{ layoutId: '2x2', seats: ['m1', 'f1', 'm2', 'f2'] }])
    expect(h.split.toState().tileTabIds).toEqual(['f1'])
    await h.cleanup()
  })

  it('closes nothing, not even a start page in the view (R8)', async () => {
    const h = await harness({ tabs: ['m1', 'm2', 'm3'], layout: '2x2' })
    h.addFiller('filler')
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2', 'm3', 'filler'] })
    h.seat(['m1', 'm2', 'm3', 'filler'])
    h.round()

    h.seams.groups.setCollapsed(group.id, true)
    h.round()

    expect(h.closed()).toEqual([])
    expect(h.recordings()).toEqual([{ layoutId: '2x2', seats: ['m1', 'm2', 'm3', 'filler'] }])
    await h.cleanup()
  })

  it('puts the view away with layout adaptation off as well, pulling nothing in', async () => {
    const h = await harness({
      tabs: ['m1', 'm2', 'loose'],
      layout: '1x2',
      adaptLayoutToTabs: false
    })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['m1', 'm2'])
    h.round()

    h.seams.groups.setCollapsed(group.id, true)

    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['loose'])
    expect(h.recordings()).toEqual([{ layoutId: '1x2', seats: ['m1', 'm2'] }])
    await h.cleanup()
  })

  it('writes a view down that had not settled yet, rather than losing it', async () => {
    // Two messages in one turn — tile these, fold their group — reach the fold before any round.
    const h = await harness({ tabs: ['m1', 'm2', 'other'], layout: '1x2' })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['m1', 'm2'])

    h.seams.groups.setCollapsed(group.id, true)

    expect(h.recordings()).toEqual([{ layoutId: '1x2', seats: ['m1', 'm2'] }])
    await h.cleanup()
  })

  it('gives the window back to a page that was beside the folded ones and stays visible', async () => {
    // Before the invariant that keeps a view in one group (U8) a view can be partly grouped. The
    // page the user was looking at is not folded, so it is the one that takes the window.
    const h = await harness({ tabs: ['m1', 'first', 'watched'], layout: '1x2' })
    const group = h.seams.groups.create({ tabIds: ['m1'] })
    h.seat(['m1', 'watched'])
    h.split.setActiveTile(1)

    h.seams.groups.setCollapsed(group.id, true)

    expect(h.split.toState().tileTabIds).toEqual(['watched'])
    await h.cleanup()
  })

  it('takes a single page out of its pane, one release and one redraw (KTD5)', async () => {
    const h = await harness({ tabs: ['m1', 'other'], layout: '1x1' })
    const group = h.seams.groups.create({ tabIds: ['m1'] })
    h.seat(['m1'])

    h.seams.groups.setCollapsed(group.id, true)

    expect(h.releases()).toBe(1)
    expect(h.redraws()).toBe(1)
    expect(h.split.tileOfTab('m1')).toBeNull()
    expect(h.split.activeTabId()).toBe('other')
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

  it('brings nothing back when the group is opened again (R11)', async () => {
    /*
      Expanding is not the way back to a tiling — the entry is, and a click on it applies it. The
      members stay where the fold left them: in their put-away view, off the grid.
    */
    const h = await harness({ tabs: ['m1', 'm2', 'other'], layout: '1x2' })
    const group = h.seams.groups.create({ tabIds: ['m1', 'm2'] })
    h.seat(['m1', 'm2'])
    h.round()
    h.seams.groups.setCollapsed(group.id, true)

    h.seams.groups.setCollapsed(group.id, false)

    expect(h.seams.groups.isHidden('m1')).toBe(false)
    expect(h.split.toState().tileTabIds).toEqual(['other'])
    expect(h.recordings()).toEqual([{ layoutId: '1x2', seats: ['m1', 'm2'] }])
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
