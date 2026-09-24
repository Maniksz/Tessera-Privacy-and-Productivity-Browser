import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArrangementController, type ArrangementHost } from '@main/browser/ArrangementController.js'
import { ArrangementStore, type ArrangementBook } from '@main/data/ArrangementStore.js'
import type { LayoutId } from '@shared/split/layout.js'

/**
 * Arrangements where they meet a window.
 *
 * Every rule about what a recording may be is asserted against the pure functions in
 * `arrangements-model.test.ts`, and identity, the clock and the file in `arrangement-store.test.ts`.
 * What is left for this file is the two moments only a window has — the settle that has just
 * changed which pages sit in which pane, and the click on a tab whose panes were put away — plus
 * the one decision the controller makes on its own: when to leave the store alone.
 *
 * ## Why the store is real
 *
 * A fake book would let the controller pass while disagreeing with the thing it actually talks
 * to. The interesting behaviour here *is* the interaction: whether a settle supersedes the
 * window's own older recording, whether a collapsed group's recording survives the settle that
 * follows the collapse, whether a click finds anything at all. All of those are answers the model
 * gives through the store, and a stub that answered them would be a second implementation of the
 * rules under test. Same reason `tab-group-controller.test.ts` opens a real `TabGroupStore`.
 *
 * ## The assertion that is a type check
 *
 * The point of the whole controller is what its host cannot reach. That is proved by the file
 * compiling — `ArrangementHost` names no `TabGroupBook`, no `groups`, no `TabGroup` — and the
 * harness below is a plain object literal satisfying it, so a capability added to reach groups
 * would have to be added here too. One test states the capability list outright, so the narrowing
 * is visible to a reader rather than only to `tsc`.
 */

const T0 = 1_700_000_000_000

interface Applied {
  layoutId: LayoutId
  seats: Array<string | null>
  activatedTabId: string
}

interface Harness {
  controller: ArrangementController
  book: ArrangementBook
  /** Every call the controller made to put a recording back on screen, in order. */
  applied: () => Applied[]
  /**
   * How many times the store was handed a document.
   *
   * Counted through the store's own `onChange`, which fires once per write whether or not the
   * document changed — so this counts *writes attempted*, which is what the idempotence rule is
   * about. `keep()` runs inside the window's coalesced broadcast round, and a write publishes: a
   * pass that reached the store unconditionally would schedule the next round from inside the
   * current one and debounce a file to disk on every navigation event.
   */
  writes: () => number
  /** What the window is showing now — the layout and who is in which tile. */
  showing: (layoutId: LayoutId, seats: Array<string | null>) => void
  setLiveTabs: (ids: string[]) => void
  /** The tabs a collapsed group is keeping out of the strip (KTD8). */
  setHidden: (ids: string[]) => void
  /** The names on the seam, so the narrowing is asserted and not only compiled. */
  capabilities: () => string[]
  cleanup: () => Promise<void>
}

async function harness(options: {
  live: string[]
  layout?: LayoutId
  tiles?: Array<string | null>
}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-arrangements-'))
  let sequence = 0
  const store = await ArrangementStore.open({
    filePath: join(directory, 'arrangements.json'),
    debounceMs: 0,
    // Injected so eviction order and equality assertions do not depend on when the run happened.
    generateId: () => {
      sequence += 1
      return `a${sequence}`
    },
    now: () => T0 + sequence * 1_000
  })

  let live = [...options.live]
  let hidden: string[] = []
  let layout: LayoutId = options.layout ?? '1x1'
  let tiles: Array<string | null> = options.tiles ?? [null]
  const applied: Applied[] = []
  let writes = 0
  store.onChange(() => {
    writes += 1
  })

  const host: ArrangementHost = {
    book: store,
    liveTabIds: () => live,
    hiddenTabIds: () => hidden,
    currentLayout: () => layout,
    tileTabIds: () => tiles,
    applyArrangement: (layoutId, seats, activatedTabId) => {
      applied.push({ layoutId, seats: [...seats], activatedTabId })
    }
  }

  return {
    controller: new ArrangementController(host),
    book: store,
    applied: () => applied,
    writes: () => writes,
    showing: (nextLayout, nextTiles) => {
      layout = nextLayout
      tiles = [...nextTiles]
    },
    setLiveTabs: (ids) => {
      live = [...ids]
    },
    setHidden: (ids) => {
      hidden = [...ids]
    },
    capabilities: () => Object.keys(host).sort(),
    cleanup: async () => {
      await store.flush()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

describe('the seam this controller was built for', () => {
  it('offers no capability that reaches a tab group', async () => {
    /*
      The whole point of the rebuild, stated once as an assertion a reader can see. `keepArrangement`
      created groups and absorbed loose tabs because a group was the only place a layout could be
      written down; here there is no book of groups to reach for, so no future edit can reach one
      without changing this list. R1, R2, R3.
    */
    const h = await harness({ live: ['t1', 't2'] })

    expect(h.capabilities()).toEqual([
      'applyArrangement',
      'book',
      'currentLayout',
      'hiddenTabIds',
      'liveTabIds',
      'tileTabIds'
    ])

    await h.cleanup()
  })
})

describe('recording what the window is showing', () => {
  it('writes down a two-pane tiling of tabs that are in no group', async () => {
    // AE3. Two tiles are filled with ungrouped tabs; a recording appears and nothing else can.
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })

    h.controller.keep()

    expect(h.book.list()).toEqual([
      { id: 'a1', layoutId: '1x2', seats: ['t1', 't2'], recordedAt: T0 + 1_000 }
    ])

    await h.cleanup()
  })

  it('leaves the store alone when the tiling has not changed', async () => {
    /*
      The idempotence gate, and it is about *reaching* the store rather than about what the store
      would decide: the round that calls this is the round a write publishes.
    */
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })

    h.controller.keep()
    h.controller.keep()
    h.controller.keep()

    expect(h.writes()).toBe(1)
    expect(h.book.list()).toHaveLength(1)

    await h.cleanup()
  })

  it('writes nothing while fewer than two tiles are occupied', async () => {
    // One page in one pane is not an arrangement, and reaching the store to be told so still costs
    // a publish.
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', null] })

    h.controller.keep()

    expect(h.writes()).toBe(0)
    expect(h.book.list()).toEqual([])

    await h.cleanup()
  })

  it('records again when the same tabs swap panes', async () => {
    // Seats are positional, so a drag between two tiles is a different arrangement. Comparing them
    // as sets would leave the drag unrecorded.
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.showing('1x2', ['t2', 't1'])
    h.controller.keep()

    expect(h.book.list()).toEqual([
      { id: 'a2', layoutId: '1x2', seats: ['t2', 't1'], recordedAt: T0 + 2_000 }
    ])

    await h.cleanup()
  })

  it('supersedes its own older recording that shares a tab', async () => {
    /*
      A tab that has just been re-tiled is not in the arrangement it used to be in. Leaving the old
      recording would offer the user two ways back for one tab, and the older one would be found
      first — a click on `t1` would jump to the four-pane layout the user has just left.
    */
    const h = await harness({
      live: ['t1', 't2', 't3', 't4'],
      layout: '2x2',
      tiles: ['t1', 't2', 't3', 't4']
    })
    h.controller.keep()

    h.showing('1x2', ['t1', 't2'])
    h.controller.keep()

    expect(h.book.list()).toEqual([
      { id: 'a2', layoutId: '1x2', seats: ['t1', 't2'], recordedAt: T0 + 2_000 }
    ])

    await h.cleanup()
  })

  it('leaves the recording of another window untouched', async () => {
    // R16. One document holds every ordinary window's recordings, so a settle here must not evict
    // or supersede one made of tabs this window does not have.
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.book.record(
      { layoutId: '1x2', seats: ['other-1', 'other-2'] },
      { liveTabIds: ['other-1', 'other-2'], hiddenTabIds: [] }
    )

    h.controller.keep()

    expect(h.book.list().map((arrangement) => arrangement.seats)).toEqual([
      ['other-1', 'other-2'],
      ['t1', 't2']
    ])

    await h.cleanup()
  })
})

describe('the settle that follows a collapse', () => {
  it('leaves the recording of the collapsed tabs standing', async () => {
    /*
      Collapsing frees the tiles and lets the layout shrink, and the settle that follows runs with
      one pane and a different tab in it. The recording made before the fold is the way back the
      user is one expand and one click away from wanting (R15).
    */
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.setHidden(['t1', 't2'])
    h.showing('1x1', ['t3'])
    h.controller.keep()

    expect(h.writes()).toBe(1)
    expect(h.book.list()).toEqual([
      { id: 'a1', layoutId: '1x2', seats: ['t1', 't2'], recordedAt: T0 + 1_000 }
    ])

    await h.cleanup()
  })

  it('records the new tiling beside the protected one', async () => {
    // The protection is against eviction, not against recording: the window goes on working while
    // a group is folded away, and both ways back survive.
    const h = await harness({
      live: ['t1', 't2', 't3', 't4'],
      layout: '1x2',
      tiles: ['t1', 't2']
    })
    h.controller.keep()

    h.setHidden(['t1', 't2'])
    h.showing('1x2', ['t3', 't4'])
    h.controller.keep()

    expect(h.book.list().map((arrangement) => arrangement.seats)).toEqual([
      ['t1', 't2'],
      ['t3', 't4']
    ])

    await h.cleanup()
  })
})

describe('bringing an arrangement back', () => {
  /** A window that recorded `t1`/`t2` side by side and has since put the panes away for `t3`. */
  async function putAway(): Promise<Harness> {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.showing('1x1', ['t3'])
    return h
  }

  it('applies the recording with the clicked tab as the one to activate', async () => {
    /*
      AE6. The third argument is the half that is easy to leave out: the seating says who is in
      which tile but not which pane should have the focus, and `restoreArrangement` derives the
      active tile from this tab.
    */
    const h = await putAway()

    h.controller.restoreFor('t2')

    expect(h.applied()).toEqual([{ layoutId: '1x2', seats: ['t1', 't2'], activatedTabId: 't2' }])

    await h.cleanup()
  })

  it('does nothing while one of the recorded tabs is hidden', async () => {
    /*
      AE9, R14, KD8. Seating the visible ones would leave a pane empty, would never match the
      recording, and would therefore let the next click apply the very same arrangement again.
    */
    const h = await putAway()
    h.setHidden(['t1'])

    h.controller.restoreFor('t2')

    expect(h.applied()).toEqual([])

    await h.cleanup()
  })

  it('does nothing for a tab no recording seats', async () => {
    const h = await putAway()

    h.controller.restoreFor('t3')

    expect(h.applied()).toEqual([])

    await h.cleanup()
  })

  it('does nothing when the recording is already what the window is showing', async () => {
    // Clicking a tab of a live multi-view is an ordinary tab activation. Re-applying would run a
    // layout change and move the focus for nothing.
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.controller.restoreFor('t1')

    expect(h.applied()).toEqual([])

    await h.cleanup()
  })

  it('does not apply a recording that seats a tab of another window', async () => {
    // R16. Applying it here would move a page the caller does not own.
    const h = await harness({ live: ['t1', 't3'], layout: '1x1', tiles: ['t3'] })
    h.book.record(
      { layoutId: '1x2', seats: ['t1', 'other-2'] },
      { liveTabIds: ['t1', 'other-2'], hiddenTabIds: [] }
    )

    h.controller.restoreFor('t1')

    expect(h.applied()).toEqual([])

    await h.cleanup()
  })

  it('does nothing while one of the recorded tabs has closed', async () => {
    /*
      A recording still naming a tab that is gone is applied by nobody until `retainLiveTabs` has
      tidied it: seating the survivors would leave a pane empty and would not be the arrangement
      that was recorded. The same "whole or not at all" as the hidden case, arrived at from the
      other direction — and the reason the live set is a capability rather than something derived
      from the tiles.
    */
    const h = await putAway()
    h.setLiveTabs(['t1', 't3'])

    h.controller.restoreFor('t1')

    expect(h.applied()).toEqual([])

    await h.cleanup()
  })

  it('does not spend the recording, so a second click brings it back again', async () => {
    /*
      The recording is rewritten by every settle, so it can never describe a state the user has
      moved on from — which is what removed the argument for consuming it, and with it the defect
      where a second return to a multi-view did nothing.
    */
    const h = await putAway()

    h.controller.restoreFor('t1')
    h.controller.restoreFor('t1')

    expect(h.applied()).toHaveLength(2)
    expect(h.writes()).toBe(1)

    await h.cleanup()
  })
})

describe('reconciling with the tabs that are still there', () => {
  it('drops a recording that loses too many tabs to be one', async () => {
    const h = await harness({ live: ['t1', 't2', 't3', 't4'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.showing('1x2', ['t3', 't4'])
    h.controller.keep()

    h.controller.retainLiveTabs(['t1', 't2', 't3'])

    expect(h.book.list().map((arrangement) => arrangement.seats)).toEqual([['t1', 't2']])

    await h.cleanup()
  })

  it('empties the tile of a tab that is gone and keeps the rest where they were', async () => {
    // The tile is emptied rather than closed up: coming back to a `2x2` minus one tab must show the
    // other three exactly where they were.
    const h = await harness({
      live: ['t1', 't2', 't3', 't4'],
      layout: '2x2',
      tiles: ['t1', 't2', 't3', 't4']
    })
    h.controller.keep()

    h.controller.retainLiveTabs(['t1', 't2', 't3'])

    expect(h.book.list().map((arrangement) => arrangement.seats)).toEqual([
      ['t1', 't2', 't3', null]
    ])

    await h.cleanup()
  })
})
