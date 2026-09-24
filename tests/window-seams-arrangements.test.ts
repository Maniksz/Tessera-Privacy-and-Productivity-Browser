import { readFileSync } from 'node:fs'
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
import { ArrangementStore } from '@main/data/ArrangementStore.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import type { BrowsingMode } from '@main/data/HistoryStore.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import type { LayoutId, Rect } from '@shared/split/layout.js'

/**
 * What a window's own seams do to each other — and, the point of this file, what they no longer do.
 *
 * The reported defect was never in a controller. Each one behaved as written; the *wiring* sent the
 * tiling automation into the book of tab groups, because a group was the only place a layout could
 * be stored. So dissolving a group in a tiled window undid itself on the next broadcast round, and a
 * tab removed from a group was pulled back into it. Neither controller could be blamed and neither
 * controller's test could catch it: the bug lived in `createWindowSeams`, which had no test at all.
 *
 * This file drives the seams the way `BrowserWindowController` drives them — `round()` below is the
 * `arrangements.keep()` of its broadcast round, and `activate()` is the `tile === null` branch of its
 * `activateTab` — against real stores, so what is asserted is the behaviour a user would see rather
 * than a call being forwarded.
 *
 * ## Why the window itself is faked and the stores are not
 *
 * `BrowserWindowController` is Electron-bound and excluded from coverage; that is precisely why the
 * defect survived. `WindowInternals` is the whole surface it exposes, so a literal satisfying that
 * interface is a complete stand-in for the window without an Electron process. The stores are real
 * because the interesting questions — does a settle create a group, does a recording supersede an
 * older one, does a private window write a file — are answered by the stores and the model, and a
 * fake that answered them would be a second implementation of the rules under test.
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1200, height: 800 }

interface Harness {
  seams: WindowSeams
  split: SplitController
  /** Puts each tab into the tile of the same index, as a window that has settled would have them. */
  seat: (tabIds: string[]) => void
  /** One coalesced broadcast round, which calls `arrangements.keep()` in `BrowserWindowController`. */
  round: () => void
  /** The `tile === null` branch of `BrowserWindowController.activateTab`. */
  activate: (tabId: string) => void
  addTab: (tabId: string) => void
  /** What the window's book holds, stripped of the id and the clock the store owns. */
  recordings: () => Array<{ layoutId: LayoutId; seats: Array<string | null> }>
  /**
   * What `arrangements.json` holds after every pending write, which for a private window must be
   * nothing at all.
   *
   * Read back off the disk rather than off the store, because the store is the thing on trial: a
   * private window is handed a book over a variable, and the only way to see that it never reached
   * the file is to look at the file.
   */
  persistedRecordings: () => unknown[]
  /** Waits for every debounced write, for the assertions that are about the file itself. */
  settled: () => Promise<void>
}

const directories: string[] = []
/*
  Flushed before the temporary directories go, and that ordering is the whole reason this is a
  registry rather than a call at the end of each test. `debounceMs: 0` still defers the write by a
  turn of the loop, so a directory removed the moment a test ended left the store writing into
  nothing — noise on a passing run, and a misleading `EINVAL` beside a failing one.
*/
const flushes: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(flushes.splice(0).map((flush) => flush()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function harness(options: {
  tabs: string[]
  layout?: LayoutId
  mode?: BrowsingMode
}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-window-seams-'))
  directories.push(directory)
  const mode = options.mode ?? 'normal'

  const groupStore = await TabGroupStore.open({ filePath: join(directory, 'tab-groups.json') })
  const arrangementsFile = join(directory, 'arrangements.json')
  const arrangementStore = await ArrangementStore.open({
    filePath: arrangementsFile,
    debounceMs: 0
  })
  flushes.push(async () => {
    await arrangementStore.flush()
    await groupStore.flush()
  })

  const split = new SplitController({ layout: options.layout ?? '1x1' })
  let order = [...options.tabs]
  // Bound once, exactly as `WindowRegistry` binds it: `bookFor('private')` answers a fresh
  // memory-backed book on every call, so asking twice would give the window and the assertions two
  // different sets of recordings.
  const arrangements = arrangementStore.bookFor(mode)

  /*
    Cast rather than built because building one means an Electron `WebContentsView`. The seams that
    reach it — drag, fullscreen, the tile bar — are constructed here and asked nothing; folding a
    group away dismisses the tile-bound surfaces, which is the one call it answers.
  */
  const overlayStub: unknown = { dismissKind: () => {} }
  const overlay = overlayStub as OverlayLayer

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
      No tab objects at all, and nothing here needs one.

      `tab()` is reached for a title during a drag, for the ephemeral flag, and to clear a tile
      index — and `SplitController` is the authority on tile assignment either way, so a window with
      no `Tab` instances settles exactly as one with them.
    */
    tab: () => undefined,
    tabIds: () => order,
    tabOrder: () => order,
    setTabOrder: (next) => {
      order = [...next]
    },
    assignTabToTile: (tabId, tileIndex) => {
      if (tileIndex === null) split.assignTab(tabId, null)
      else split.assignTab(tabId, tileIndex)
    },
    closeTab: (tabId) => {
      order = order.filter((id) => id !== tabId)
      split.forgetTab(tabId)
    },
    activateTab: (tabId) => {
      const tile = split.tileOfTab(tabId)
      if (tile !== null) {
        split.setActiveTile(tile)
        return
      }
      seams.arrangements.restoreFor(tabId)
      if (split.tileOfTab(tabId) === null) {
        split.assignTab(tabId, seams.occupancy.claimTileForNewTab())
      }
    },
    setActiveTile: (tileIndex) => split.setActiveTile(tileIndex),
    openFiller: (tileIndex) => {
      const id = `filler-${order.length}`
      order.push(id)
      split.assignTab(id, tileIndex)
    },
    applyLayout: (layout, changeOptions) => {
      seams.occupancy.afterLayoutChange(split.setLayout(layout), changeOptions)
    },
    presentOverlay: () => {},
    relayout: () => {},
    broadcast: () => {},
    onOverlayPresentationChanged: () => {},
    tabGroups: groupStore.bookFor(mode),
    arrangements
  }

  const seams = createWindowSeams(internals)

  return {
    seams,
    split,
    seat: (tabIds) => {
      tabIds.forEach((tabId, index) => split.assignTab(tabId, index))
    },
    round: () => {
      seams.arrangements.keep()
    },
    activate: (tabId) => {
      seams.arrangements.restoreFor(tabId)
      if (split.tileOfTab(tabId) === null) {
        split.assignTab(tabId, seams.occupancy.claimTileForNewTab())
      }
    },
    addTab: (tabId) => {
      order.push(tabId)
    },
    recordings: () =>
      arrangements.list().map((held) => ({ layoutId: held.layoutId, seats: held.seats })),
    persistedRecordings: () => {
      const document: unknown = JSON.parse(readFileSync(arrangementsFile, 'utf8'))
      return (document as { arrangements: unknown[] }).arrangements
    },
    settled: async () => {
      await arrangementStore.flush()
      await groupStore.flush()
    }
  }
}

describe('the broadcast round and tab groups', () => {
  it('leaves a dissolved group dissolved (AE1, R2, R4)', async () => {
    /*
      The reported defect, in the shape it was reported in. Two tiled tabs in a group, the user
      dissolves it, and the very next round put it back — because the round wrote the arrangement
      into a group, and with no group left to write into it made one. The chip reappeared within a
      frame and "Gruppierung auflösen" looked broken.
    */
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])
    const group = h.seams.groups.create({ tabIds: ['t1', 't2'] })
    h.round()

    h.seams.groups.dissolve(group.id)
    h.round()

    expect(h.seams.groups.groups()).toEqual([])
  })

  it('leaves a tab removed from a group out of it (AE2, AE4, R3, R4)', async () => {
    /*
      The same defect from the other side, and the one the plan calls absorption. The round found a
      group holding two of the three seated tabs and pulled the third back in, because "mixed origin
      takes the existing group" was the rule that let one layout live in one group. Removing a tab
      from a group therefore held for one tick.
    */
    const h = await harness({ tabs: ['t1', 't2', 't3'], layout: '1x3' })
    h.seat(['t1', 't2', 't3'])
    const group = h.seams.groups.create({ tabIds: ['t1', 't2', 't3'] })
    h.round()

    h.seams.groups.removeTab('t3')
    h.round()

    expect(h.seams.groups.groups()[0]?.id).toBe(group.id)
    expect(h.seams.groups.groups()[0]?.tabIds).toEqual(['t1', 't2'])
    expect(h.seams.groups.isHidden('t3')).toBe(false)
  })

  it('creates no group for a tiling nobody grouped (R1)', async () => {
    // Tiling a window is not asking for a group. It used to be the commonest way to get one: every
    // split made from the layout menu, every drag into an edge, every restored session.
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])

    h.round()

    expect(h.seams.groups.groups()).toEqual([])
  })

  it('does not pull a loose tab into the group beside it (R3)', async () => {
    const h = await harness({ tabs: ['t1', 't2', 'loose'], layout: '1x3' })
    const group = h.seams.groups.create({ tabIds: ['t1', 't2'] })
    h.seat(['t1', 't2', 'loose'])

    h.round()

    expect(h.seams.groups.groups()[0]?.tabIds).toEqual(['t1', 't2'])
    expect(h.seams.groups.groups()[0]?.id).toBe(group.id)
  })

  it('records a tiling a new tab takes away, and makes no group to hold it (R1, R6)', async () => {
    /*
      The one write that cannot wait for a round, and the place the whole feature used to start: this
      was the *only* moment an arrangement was ever recorded, and it recorded it by making a group.
      Two IPC messages in one turn of the loop — split this window, then open a tab — still reach the
      collapse before any scheduled round, so the call stays; only its destination changed.
    */
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])

    h.addTab('fresh')
    h.split.assignTab('fresh', h.seams.occupancy.claimTileForNewTab())

    expect(h.split.layout).toBe('1x1')
    expect(h.seams.groups.groups()).toEqual([])
    expect(h.recordings()).toEqual([{ layoutId: '1x2', seats: ['t1', 't2'] }])
  })

  it('records the tiling it is losing when the layout shrinks, and touches no group (R6)', async () => {
    // A shrink is the moment a recording earns its keep, and the group list is the thing that must
    // not move while it happens.
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.round()

    h.seams.occupancy.afterTabClosed(1)
    h.round()

    expect(h.split.layout).toBe('1x1')
    expect(h.seams.groups.groups()).toEqual([])
    expect(h.recordings()).toEqual([{ layoutId: '1x2', seats: ['t1', 't2'] }])
  })
})

describe('the way back to a tiling that was put away', () => {
  it('brings back the panes a new tab took, with the clicked tab active (R7)', async () => {
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.round()

    // A new tab takes the window, which is what `claimTileForNewTab` is for.
    h.addTab('fresh')
    h.split.assignTab('fresh', h.seams.occupancy.claimTileForNewTab())
    expect(h.split.layout).toBe('1x1')

    h.activate('t2')

    expect(h.split.layout).toBe('1x2')
    expect(h.split.toState().tileTabIds).toEqual(['t1', 't2'])
    expect(h.split.activeTile).toBe(1)
  })

  it('gives a tab with no recording the window rather than a pane', async () => {
    const h = await harness({ tabs: ['t1', 'never-tiled'], layout: '1x1' })
    h.seat(['t1'])

    h.activate('never-tiled')

    expect(h.split.layout).toBe('1x1')
    expect(h.split.tileOfTab('never-tiled')).toBe(0)
  })
})

describe('a private window', () => {
  it('writes no arrangements file however often it settles (R8, spec 4)', async () => {
    /*
      The half of `ArrangementStore.bookFor` that only the wiring can get wrong: the store is opened
      once for the whole application, and a window that was handed the store itself rather than a
      book for its mode would persist a private session's tilings — which pages sat beside which,
      and when.
    */
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2', mode: 'private' })
    h.seat(['t1', 't2'])
    h.round()
    h.seams.occupancy.afterTabClosed(1)
    h.round()
    await h.settled()

    // Both halves, because either alone would pass for the wrong reason: a window that recorded
    // nothing at all would leave the file empty too, and a file that is merely absent proves
    // nothing about a store that writes lazily.
    expect(h.recordings().length).toBeGreaterThan(0)
    expect(h.persistedRecordings()).toEqual([])
  })
})
