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
import type { Tab } from '@main/browser/Tab.js'
import { ArrangementStore, type ArrangementBook } from '@main/data/ArrangementStore.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import type { BrowsingMode } from '@main/data/HistoryStore.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import type { LayoutId, Rect } from '@shared/split/layout.js'
import { dropZonesFor } from '@shared/split/dropzones.js'
import { windowCloseForgetsArrangements } from '@shared/arrangements/screen.js'

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
  /** A start page the browser opened as a filler: in the strip, ephemeral, a member like any tab. */
  addStartPage: (tabId: string) => void
  /** A new tab, the way `BrowserWindowController.createTab` places one: it gets the whole window. */
  newTab: (tabId: string) => void
  /** Switches layout the way nothing but this test does — no filling, no pulling in — and seats. */
  show: (layout: LayoutId, seats: Array<string | null>) => void
  /** What `BrowserWindowController.#finishClose` does once a tab has really gone. */
  close: (tabId: string) => void
  /** The book this window writes into, ids and all. */
  book: ArrangementBook
  /** Every tab the seams asked to leave its page's fullscreen, in order. */
  fullscreenExits: () => string[]
  /** Whether the seams last told this tab to be muted. */
  muted: (tabId: string) => boolean
  /** How often the seams asked the window for another broadcast round. */
  broadcasts: () => number
  /** The strip, which a closed tab has left. */
  order: () => string[]
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
  /** An `arrangements.json` another window, or the last run, already wrote to. */
  store?: ArrangementStore
  /** `splitView.adaptLayoutToTabs`, on unless a test says otherwise. */
  adaptLayoutToTabs?: boolean
}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-window-seams-'))
  directories.push(directory)
  const mode = options.mode ?? 'normal'

  const groupStore = await TabGroupStore.open({ filePath: join(directory, 'tab-groups.json') })
  const arrangementsFile = join(directory, 'arrangements.json')
  const arrangementStore =
    options.store ??
    (await ArrangementStore.open({
      filePath: arrangementsFile,
      debounceMs: 0
    }))
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

  /*
    Tab objects only as far as the seams read them: whether it is a filler, a view whose page can be
    asked to leave its fullscreen, and a mute switch. Built on demand for every id the window has,
    because the seams ask about tabs by id and a test adds them as it goes.
  */
  const ephemeral = new Set<string>()
  const fullscreenExits: string[] = []
  const mutedTabs = new Map<string, boolean>()
  let broadcasts = 0
  const fakeTab = (tabId: string): Tab => {
    const fake: unknown = {
      id: tabId,
      ephemeral: ephemeral.has(tabId),
      setTileIndex: () => {},
      setMuted: (muted: boolean) => mutedTabs.set(tabId, muted),
      toState: () => ({ id: tabId, title: tabId, url: `https://example.test/${tabId}` }),
      view: {
        webContents: {
          isDestroyed: () => false,
          executeJavaScript: () => {
            fullscreenExits.push(tabId)
            return Promise.resolve()
          }
        }
      }
    }
    return fake as Tab
  }

  const internals: WindowInternals = {
    split,
    overlay,
    isDestroyed: () => false,
    getSettings: () => ({
      ...defaultSettings(),
      'splitView.adaptLayoutToTabs': options.adaptLayoutToTabs ?? true
    }),
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
    tab: (tabId) => (order.includes(tabId) ? fakeTab(tabId) : undefined),
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
    broadcast: () => {
      broadcasts += 1
    },
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
    addStartPage: (tabId) => {
      order.push(tabId)
      ephemeral.add(tabId)
    },
    newTab: (tabId) => {
      order.push(tabId)
      split.assignTab(tabId, seams.occupancy.claimTileForNewTab())
    },
    show: (layout, seats) => {
      split.setLayout(layout)
      seats.forEach((tabId, index) => {
        if (tabId !== null) split.assignTab(tabId, index)
      })
    },
    close: (tabId) => {
      const vacated = split.tileOfTab(tabId)
      split.forgetTab(tabId)
      order = order.filter((id) => id !== tabId)
      seams.arrangements.tabClosed(tabId)
      seams.occupancy.afterTabClosed(vacated)
    },
    book: arrangements,
    fullscreenExits: () => fullscreenExits,
    muted: (tabId) => mutedTabs.get(tabId) === true,
    broadcasts: () => broadcasts,
    order: () => order,
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

  it('writes the smaller tiling into the same entry when a closed tab shrinks it, and touches no group (R6)', async () => {
    /*
      A shrink is the moment the entry has to follow the panes, and the group list is the thing that
      must not move while it happens. It used to call `afterTabClosed` with the tab still seated,
      which only the pull-in's one-step shrink could answer; a close forgets the tab first.
    */
    const h = await harness({ tabs: ['t1', 't2', 't3'], layout: '1x3' })
    h.seat(['t1', 't2', 't3'])
    h.round()
    const id = h.seams.arrangements.liveId

    h.close('t3')
    h.round()

    expect(h.split.layout).toBe('1x2')
    expect(h.seams.groups.groups()).toEqual([])
    expect(h.book.list().map((held) => [held.id, held.layoutId, held.seats])).toEqual([
      [id, '1x2', ['t1', 't2']]
    ])
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

describe('choosing the single layout', () => {
  it('ends the tiling, so the page that lost its pane takes the window rather than the split', async () => {
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.round()

    h.seams.occupancy.chooseLayout('1x1')
    h.round()
    h.activate('t2')

    expect(h.recordings()).toEqual([])
    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['t2'])
  })

  it('leaves a group the user made alone, members and all (R2)', async () => {
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])
    const group = h.seams.groups.create({ tabIds: ['t1', 't2'], name: 'Reading' })
    h.round()

    h.seams.occupancy.chooseLayout('1x1')
    h.round()

    expect(h.seams.groups.groups()).toEqual([group])
  })

  it('records the next split afresh, its new pane a start page rather than the page that left (KTD10)', async () => {
    /*
      Choosing the split again used to pull `t2` back into the pane it had left. The page that lost
      its pane is an ordinary tab from the moment the tiling ended, and a layout the user chooses
      gives its new panes start pages — not whichever loaded tab comes first in the strip.
    */
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.round()
    h.seams.occupancy.chooseLayout('1x1')
    h.round()

    h.seams.occupancy.chooseLayout('1x2')
    h.round()

    expect(h.split.toState().tileTabIds).toEqual(['t1', 'filler-2'])
    expect(h.split.tileOfTab('t2')).toBeNull()
    expect(h.recordings()).toEqual([{ layoutId: '1x2', seats: ['t1', 'filler-2'] }])
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

  it('ends a tiling for the single layout the way an ordinary window does', async () => {
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2', mode: 'private' })
    h.seat(['t1', 't2'])
    h.round()

    h.seams.occupancy.chooseLayout('1x1')
    h.activate('t2')

    expect(h.recordings()).toEqual([])
    expect(h.split.toState().tileTabIds).toEqual(['t2'])
  })
})

describe('the visible tiled view and its entry (U2)', () => {
  /** The ids and seats the book holds, in order. */
  const held = (h: Harness): Array<[string, Array<string | null>]> =>
    h.book.list().map((arrangement) => [arrangement.id, arrangement.seats])

  it('comes back exactly as it was put away, under the same id (AE1, R3, R4)', async () => {
    const h = await harness({ tabs: ['youtube', 'twitch', 'mail'], layout: '1x2' })
    h.seat(['youtube', 'twitch'])
    h.split.setFractions({ v: 0.3 }, CONTENT)
    h.split.setActiveTile(1)
    h.round()
    const id = h.book.list()[0]?.id ?? ''

    h.activate('mail')
    h.round()
    expect(h.split.toState().tileTabIds).toEqual(['mail'])
    expect(h.seams.arrangements.summaries()).toMatchObject([{ id, visible: false }])

    h.seams.arrangements.restore(id)
    h.round()

    expect(h.split.layout).toBe('1x2')
    expect(h.split.toState().tileTabIds).toEqual(['youtube', 'twitch'])
    expect(h.split.activeTile).toBe(1)
    expect(h.split.toState().fractions).toEqual({ v: 0.3 })
    expect(held(h)).toEqual([[id, ['youtube', 'twitch']]])
    expect(h.seams.arrangements.summaries()).toMatchObject([{ id, visible: true }])
  })

  it('keeps two tiled views put away one after the other, each under its own id', async () => {
    const h = await harness({ tabs: ['t1', 't2', 't3', 't4'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.round()
    h.newTab('t5')
    h.show('1x2', ['t5', 't3'])
    h.round()

    h.newTab('t6')
    h.round()

    const entries = held(h)
    expect(entries.map(([, seats]) => seats)).toEqual([
      ['t1', 't2'],
      ['t5', 't3']
    ])
    expect(new Set(entries.map(([id]) => id)).size).toBe(2)
    expect(h.seams.arrangements.summaries().map((summary) => summary.visible)).toEqual([
      false,
      false
    ])
  })

  it('puts the visible one away whole when the user brings another back (R16)', async () => {
    /*
      A is a `2x2` with a start page in it, B a `2x2` with an empty seat. Bringing B back must not
      leave any of A behind in B's empty seat, and putting A away must close nothing — its start
      page is a member like the others (R8, AE4).
    */
    const h = await harness({ tabs: ['b1', 'b2', 'b3', 'a1', 'a2', 'a3'], layout: '2x2' })
    h.seat(['b1', 'b2', 'b3'])
    h.round()
    const b = h.seams.arrangements.liveId ?? ''
    h.seams.arrangements.putAway()
    h.addStartPage('start')
    h.show('2x2', ['a1', 'start', 'a2', 'a3'])
    h.split.setFractions({ v: 0.4 }, CONTENT)
    h.split.setActiveTile(2)
    h.round()
    const a = h.seams.arrangements.liveId ?? ''

    h.seams.arrangements.restore(b)
    h.round()

    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b2', 'b3', null])
    expect(h.seams.arrangements.liveId).toBe(b)
    expect(h.book.list().find((arrangement) => arrangement.id === a)).toMatchObject({
      seats: ['a1', 'start', 'a2', 'a3'],
      activeTile: 2,
      fractions: { v: 0.4 }
    })
    expect(held(h).map(([id]) => id)).toEqual([b, a])
    expect(h.order()).toContain('start')
  })

  it('stands unchanged as a put-away entry when a workspace opens (lifecycle)', async () => {
    const h = await harness({ tabs: ['t1', 't2', 'w1', 'w2'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.round()
    const a = h.seams.arrangements.liveId ?? ''

    // What `workspaces:open` does: the visible view away first, then the workspace's seating.
    h.seams.arrangements.putAway()
    h.seams.occupancy.restoreArrangement('1x2', ['w1', 'w2'], 'w1')
    h.round()

    expect(h.book.list().find((arrangement) => arrangement.id === a)?.seats).toEqual(['t1', 't2'])
    expect(h.seams.arrangements.summaries()).toMatchObject([
      { id: a, tabIds: ['t1', 't2'], visible: false },
      { tabIds: ['w1', 'w2'], visible: true }
    ])
  })

  it('takes a tab dragged into it under the same id (KTD2)', async () => {
    const h = await harness({ tabs: ['t1', 't2', 't3'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.round()
    const id = h.seams.arrangements.liveId
    const zone = dropZonesFor('1x2', CONTENT).find(
      (candidate) => candidate.layout === '1x3' && candidate.tileIndex === 2
    )
    expect(zone).toBeDefined()

    h.seams.occupancy.applyDrop('t3', zone!)
    h.round()

    expect(held(h)).toEqual([[id, ['t1', 't2', 't3']]])
  })

  it('empties the seat of a member closing in a put-away view of three, which stays restorable', async () => {
    const h = await harness({ tabs: ['t1', 't2', 't3'], layout: '1x3' })
    h.seat(['t1', 't2', 't3'])
    h.round()
    h.newTab('other')

    h.close('t2')
    h.round()
    h.activate('t3')

    expect(h.split.layout).toBe('1x3')
    expect(h.split.toState().tileTabIds).toEqual(['t1', null, 't3'])
  })

  it('ends a put-away view of two when a member closes, and the other is an ordinary tab', async () => {
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.round()
    h.newTab('other')

    h.close('t2')
    h.round()
    h.activate('t1')

    expect(h.book.list()).toEqual([])
    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['t1'])
  })

  it('keeps each view its own tile sounds (KTD11)', async () => {
    const h = await harness({ tabs: ['a1', 'a2', 'b1', 'b2'], layout: '1x2' })
    h.seat(['a1', 'a2'])
    h.seams.audio.setMutedByUser(1, true)
    h.round()
    const a = h.seams.arrangements.liveId ?? ''
    h.seams.arrangements.putAway()
    h.show('1x2', ['b1', 'b2'])
    h.round()

    expect(h.split.tileAudio(1).muted).toBe(false)

    h.seams.arrangements.restore(a)
    h.round()

    expect(h.split.tileAudio(1).muted).toBe(true)
    expect(h.muted('a2')).toBe(true)
    expect(h.muted('a1')).toBe(false)
  })

  it('asks a page in tile fullscreen to leave it when the view is put away (KTD11)', async () => {
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.split.enterTileFullscreen(1)
    h.round()

    h.newTab('fresh')

    expect(h.fullscreenExits()).toEqual(['t2'])
    expect(h.split.fullscreenTile).toBeNull()
  })

  it('reaches the store without asking for another round (KTD5)', async () => {
    /*
      `arrangements:changed` is built from the same round's snapshot right after `keep()`, so a
      write here must not schedule the next round — or every settle would publish twice.
    */
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])

    h.round()
    h.split.setActiveTile(1)
    h.round()

    expect(h.broadcasts()).toBe(0)
    expect(h.seams.arrangements.summaries()).toMatchObject([{ activeTile: 1, visible: true }])
  })
})

/**
 * The paths the browser takes on its own, and what none of them may do any more (U3).
 *
 * Each used to move a tab between the strip and the panes without being asked: a closed tab's
 * pane took the first loaded tab, a chosen layout seated loaded tabs before opening start pages,
 * a drop filled the tiles nobody aimed at, a single view's last tab was replaced by whatever came
 * first. With every tiled view an entry in the strip, each of those is a page leaving its entry or
 * its place unasked (R16), so each path now has one rule, asserted here through the real seams.
 */
describe('the automatic paths (U3, R3, R16)', () => {
  const seatsOf = (h: Harness, id: string | null): Array<string | null> | undefined =>
    h.book.list().find((arrangement) => arrangement.id === id)?.seats

  it('closes the ranks of the visible view and pulls in no member of a put-away one (AE7)', async () => {
    const h = await harness({ tabs: ['b1', 'b2', 'a1', 'a2', 'a3'], layout: '1x2' })
    h.seat(['b1', 'b2'])
    h.round()
    const b = h.seams.arrangements.liveId
    h.seams.arrangements.putAway()
    h.show('1x3', ['a1', 'a2', 'a3'])
    h.round()
    const a = h.seams.arrangements.liveId

    h.close('a2')
    h.round()

    expect(h.split.toState().tileTabIds).toEqual(['a1', 'a3'])
    expect(seatsOf(h, a)).toEqual(['a1', 'a3'])
    expect(seatsOf(h, b)).toEqual(['b1', 'b2'])
    expect(h.seams.arrangements.liveId).toBe(a)
  })

  it('keeps an empty pane with adaptation off, and pulls nobody into it', async () => {
    const h = await harness({
      tabs: ['t1', 't2', 't3', 'loose'],
      layout: '1x3',
      adaptLayoutToTabs: false
    })
    h.seat(['t1', 't2', 't3'])
    h.round()
    const id = h.seams.arrangements.liveId

    h.close('t2')
    h.round()

    expect(h.split.toState().tileTabIds).toEqual(['t1', null, 't3'])
    expect(seatsOf(h, id)).toEqual(['t1', null, 't3'])
  })

  it('puts the visible view away on a click on an ordinary tab with adaptation off (KTD9)', async () => {
    /*
      The tile used to be replaced: with the switch off the clicked tab took the first empty pane, or
      the active one, and the page it displaced left the view on the next settle. R3 holds whatever
      the switch says, so the view is put away whole and the clicked tab gets the window.
    */
    const h = await harness({
      tabs: ['t1', 't2', 'mail'],
      layout: '1x2',
      adaptLayoutToTabs: false
    })
    h.seat(['t1', 't2'])
    h.round()
    const id = h.seams.arrangements.liveId

    h.activate('mail')
    h.round()

    expect(h.split.layout).toBe('1x1')
    expect(h.split.toState().tileTabIds).toEqual(['mail'])
    expect(seatsOf(h, id)).toEqual(['t1', 't2'])
    expect(h.seams.arrangements.summaries()).toMatchObject([{ id, visible: false }])
  })

  it('shows the next ordinary tab when a single view closes its tab, never a lone member', async () => {
    const h = await harness({ tabs: ['m1', 'm2', 'shown', 'ordinary'], layout: '1x2' })
    h.seat(['m1', 'm2'])
    h.round()
    h.seams.arrangements.putAway()
    h.show('1x1', ['shown'])
    h.round()

    h.close('shown')
    h.round()

    expect(h.split.toState().tileTabIds).toEqual(['ordinary'])
    expect(h.recordings()).toEqual([{ layoutId: '1x2', seats: ['m1', 'm2'] }])
  })

  it('brings back the first view in strip order when only members are left (KTD10)', async () => {
    // A was written down first, so the book's order is not the strip's; B comes first in the strip.
    const h = await harness({ tabs: ['b1', 'b2', 'a1', 'a2', 'shown'], layout: '1x2' })
    h.seat(['a1', 'a2'])
    h.round()
    h.seams.arrangements.putAway()
    h.show('1x2', ['b1', 'b2'])
    h.round()
    const b = h.seams.arrangements.liveId
    h.seams.arrangements.putAway()
    h.show('1x1', ['shown'])
    h.round()

    h.close('shown')
    h.round()

    expect(h.split.layout).toBe('1x2')
    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b2'])
    expect(h.seams.arrangements.liveId).toBe(b)
  })

  it('passes over a view a folded group holds and brings back the next one (KTD10)', async () => {
    const h = await harness({ tabs: ['f1', 'f2', 'b1', 'b2', 'shown'], layout: '1x2' })
    h.seat(['f1', 'f2'])
    h.round()
    const folded = h.seams.arrangements.liveId
    h.seams.arrangements.putAway()
    h.show('1x2', ['b1', 'b2'])
    h.round()
    const b = h.seams.arrangements.liveId
    h.seams.arrangements.putAway()
    h.show('1x1', ['shown'])
    h.round()
    const group = h.seams.groups.create({ tabIds: ['f1', 'f2'] })
    h.seams.groups.setCollapsed(group.id, true)

    h.close('shown')

    expect(h.split.toState().tileTabIds).toEqual(['b1', 'b2'])
    expect(h.seams.arrangements.liveId).toBe(b)
    expect(seatsOf(h, folded)).toEqual(['f1', 'f2'])
  })

  it('shows nothing rather than a folded view when that is all there is', async () => {
    const h = await harness({ tabs: ['f1', 'f2', 'shown'], layout: '1x2' })
    h.seat(['f1', 'f2'])
    h.round()
    h.seams.arrangements.putAway()
    h.show('1x1', ['shown'])
    h.round()
    const group = h.seams.groups.create({ tabIds: ['f1', 'f2'] })
    h.seams.groups.setCollapsed(group.id, true)

    h.close('shown')

    expect(h.split.toState().tileTabIds).toEqual([null])
    expect(h.seams.arrangements.liveId).toBeNull()
  })

  it('keeps a page a drop displaced in the view, in the pane that was free (R16)', async () => {
    /*
      `#reseat`'s rule, through the book: the displaced page goes to the tile the drop freed — here
      the one the split created — and so stays a member. What the drop no longer does is seat a
      loaded tab in the pane left over.
    */
    const h = await harness({ tabs: ['t1', 't2', 'dragged', 'loose'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.round()
    const id = h.seams.arrangements.liveId
    const zone = dropZonesFor('1x2', CONTENT).find((candidate) => candidate.id === '0-top')
    expect(zone).toBeDefined()

    h.seams.occupancy.applyDrop('dragged', zone!)
    h.round()

    expect(h.split.toState().tileTabIds).toEqual(['dragged', 't2', 't1', null])
    expect(seatsOf(h, id)).toEqual(['dragged', 't2', 't1', null])
  })

  it('swaps two members within the view, both staying members', async () => {
    const h = await harness({ tabs: ['t1', 't2'], layout: '1x2' })
    h.seat(['t1', 't2'])
    h.round()
    const id = h.seams.arrangements.liveId
    const zone = dropZonesFor('1x2', CONTENT).find((candidate) => candidate.id === '1-centre')

    h.seams.occupancy.applyDrop('t1', zone!)
    h.round()

    expect(seatsOf(h, id)).toEqual(['t2', 't1'])
  })
})

describe('a restart (R15, KTD3)', () => {
  /** What the last run left in `arrangements.json`: one tiled view of `t1` and `t2`. */
  async function lastRun(): Promise<{ store: ArrangementStore; id: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'tessera-window-seams-'))
    directories.push(directory)
    const store = await ArrangementStore.open({
      filePath: join(directory, 'arrangements.json'),
      debounceMs: 0
    })
    flushes.push(() => store.flush())
    const id =
      store.create(
        { layoutId: '1x2', seats: ['t1', 't2'], activeTile: 1 },
        { liveTabIds: ['t1', 't2'], hiddenTabIds: [] }
      ) ?? ''
    return { store, id }
  }

  it('shows the visible view as one entry with the same id', async () => {
    const { store, id } = await lastRun()
    const h = await harness({ tabs: ['t1', 't2', 't3'], layout: '1x2', store })
    h.seat(['t1', 't2'])

    h.seams.arrangements.settleRestored(id)
    h.round()

    expect(h.seams.arrangements.summaries()).toEqual([
      expect.objectContaining({ id, tabIds: ['t1', 't2'], visible: true })
    ])
  })

  it('adopts the matching view for a slot from an older build without an id', async () => {
    const { store, id } = await lastRun()
    const h = await harness({ tabs: ['t1', 't2', 't3'], layout: '1x2', store })
    h.seat(['t1', 't2'])

    h.seams.arrangements.settleRestored(null)
    h.round()

    expect(h.seams.arrangements.summaries()).toEqual([
      expect.objectContaining({ id, visible: true })
    ])
  })

  it('comes back put away with restoreLayoutOnStart off, the window showing another tab', async () => {
    const { store, id } = await lastRun()
    const h = await harness({ tabs: ['t1', 't2', 't3'], layout: '1x1', store })
    h.seat(['t3'])

    h.seams.arrangements.settleRestored(id)
    h.round()

    expect(h.seams.arrangements.summaries()).toEqual([
      expect.objectContaining({ id, visible: false })
    ])
    h.activate('t1')
    expect(h.split.toState().tileTabIds).toEqual(['t1', 't2'])
  })
})

describe('a window closing (KTD3)', () => {
  it("forgets the closing window's views while another window stays open, and only those", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tessera-window-seams-'))
    directories.push(directory)
    const store = await ArrangementStore.open({
      filePath: join(directory, 'arrangements.json'),
      debounceMs: 0
    })
    flushes.push(() => store.flush())
    store.create(
      { layoutId: '1x2', seats: ['a1', 'a2'] },
      { liveTabIds: ['a1', 'a2'], hiddenTabIds: [] }
    )
    store.create(
      { layoutId: '1x2', seats: ['b1', 'b2'] },
      { liveTabIds: ['b1', 'b2'], hiddenTabIds: [] }
    )

    const normal = { privateMode: false }
    if (windowCloseForgetsArrangements(normal, [normal], false)) store.forgetTabs(['a1', 'a2'])

    expect(store.list().map((arrangement) => arrangement.seats)).toEqual([['b1', 'b2']])
  })

  it('keeps the last window’s views for the restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tessera-window-seams-'))
    directories.push(directory)
    const filePath = join(directory, 'arrangements.json')
    const store = await ArrangementStore.open({ filePath, debounceMs: 0 })
    store.create(
      { layoutId: '1x2', seats: ['a1', 'a2'] },
      { liveTabIds: ['a1', 'a2'], hiddenTabIds: [] }
    )

    if (windowCloseForgetsArrangements({ privateMode: false }, [], false)) {
      store.forgetTabs(['a1', 'a2'])
    }
    await store.flush()
    const restarted = await ArrangementStore.open({ filePath, debounceMs: 0 })

    expect(restarted.list().map((arrangement) => arrangement.seats)).toEqual([['a1', 'a2']])
  })

  it('is decided by that rule where the window closes', () => {
    // `WindowRegistry` needs Electron, so the wiring is read rather than run: the rule is asked in
    // `onClosed`, with the windows still open, and its answer is what reaches `forgetTabs`.
    const registry = readFileSync(join(process.cwd(), 'src/main/browser/WindowRegistry.ts'), 'utf8')
    expect(registry).toMatch(
      /windowCloseForgetsArrangements\([\s\S]{0,200}?this\.#deps\.arrangements\.forgetTabs\(/
    )
  })
})

describe('the broadcast round in the window (KTD5)', () => {
  it('sends arrangements:changed once, after keep(), from the same round', () => {
    // `BrowserWindowController` needs Electron, so the round is read rather than run.
    const source = readFileSync(
      join(process.cwd(), 'src/main/browser/BrowserWindowController.ts'),
      'utf8'
    )
    const round = source.slice(source.indexOf('#scheduleBroadcast(): void {'))
    const body = round.slice(0, round.indexOf('\n  }\n'))
    const keep = body.indexOf('this.#seams.arrangements.keep()')
    const sent = body.indexOf("this.emit('arrangements:changed'")
    expect(keep).toBeGreaterThan(-1)
    expect(sent).toBeGreaterThan(keep)
    expect(body.split("'arrangements:changed'").length - 1).toBe(1)
    expect(body).toMatch(/arrangementId: this\.#seams\.arrangements\.liveId/)
  })
})
