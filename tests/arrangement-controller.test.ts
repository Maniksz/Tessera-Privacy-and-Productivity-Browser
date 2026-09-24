import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArrangementController, type ArrangementHost } from '@main/browser/ArrangementController.js'
import { ArrangementStore, type ArrangementBook } from '@main/data/ArrangementStore.js'
import { defaultArrangementView, type ArrangementView } from '@shared/arrangements/model.js'
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
  /** The dividers and tile sounds it put back with each one (KTD11). */
  views: () => Array<Omit<ArrangementView, 'activeTile'>>
  /** `stow` and `apply` in the order they reached the window, for "put the other one away first". */
  events: () => string[]
  /**
   * The seats of every put-away view the controller ended, with the ids the book still held at that
   * moment — which is how "forgotten before any tab moves" is asserted (KTD12).
   */
  dissolved: () => Array<{ seats: Array<string | null>; heldAtTheTime: string[] }>
  /** The view the window reports: active tile, dividers, tile sounds. Defaults to the layout's own. */
  setView: (view: ArrangementView) => void
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
  const views: Array<Omit<ArrangementView, 'activeTile'>> = []
  const events: string[] = []
  const dissolved: Array<{ seats: Array<string | null>; heldAtTheTime: string[] }> = []
  let view: ArrangementView | null = null
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
    currentView: () => view ?? defaultArrangementView(layout),
    applyArrangement: (layoutId, seats, activatedTabId) => {
      events.push('apply')
      applied.push({ layoutId, seats: [...seats], activatedTabId })
    },
    applyView: (next) => {
      views.push({ fractions: { ...next.fractions }, tileAudio: [...next.tileAudio] })
    },
    // What the seam does: the panes go, nothing closes, and the one tile left is empty.
    stowTiling: () => {
      events.push('stow')
      layout = '1x1'
      tiles = [null]
      view = null
    },
    dissolveOffScreen: (seats) => {
      events.push('dissolve')
      dissolved.push({
        seats: [...seats],
        heldAtTheTime: store.list().map((arrangement) => arrangement.id)
      })
    }
  }

  return {
    controller: new ArrangementController(host),
    book: store,
    applied: () => applied,
    views: () => views,
    events: () => events,
    dissolved: () => dissolved,
    setView: (next) => {
      view = next
    },
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
      'applyView',
      'book',
      'currentLayout',
      'currentView',
      'dissolveOffScreen',
      'hiddenTabIds',
      'liveTabIds',
      'stowTiling',
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

    // `toMatchObject`, because the view an arrangement carries (KTD1) is not this test's subject.
    expect(h.book.list()).toMatchObject([
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

  it('does not replace the arrangement when the same tabs swap panes (KTD2)', async () => {
    // Seats are positional, so a drag between two tiles is a different seating — and it used to be
    // recorded afresh under a new id. With arrangements visible as entries, replacing one is an entry
    // vanishing; the in-place update under the same id arrives with the window's `liveId` (U2).
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.showing('1x2', ['t2', 't1'])
    h.controller.keep()

    expect(h.book.list().map((arrangement) => [arrangement.id, arrangement.seats])).toEqual([
      ['a1', ['t2', 't1']]
    ])

    await h.cleanup()
  })

  it('changes the visible arrangement in place when its layout shrinks (KTD2)', async () => {
    /*
      A tab belongs to at most one arrangement (R4), and the old way of keeping that — a new
      recording replacing every one it overlapped — made an entry disappear. The visible
      arrangement is now updated under its own id instead, so the entry stays and shows the change.
    */
    const h = await harness({
      live: ['t1', 't2', 't3', 't4'],
      layout: '2x2',
      tiles: ['t1', 't2', 't3', 't4']
    })
    h.controller.keep()

    h.showing('1x2', ['t1', 't2'])
    h.controller.keep()

    expect(h.book.list().map((arrangement) => [arrangement.id, arrangement.layoutId])).toEqual([
      ['a1', '1x2']
    ])

    await h.cleanup()
  })

  it('leaves the recording of another window untouched', async () => {
    // R16. One document holds every ordinary window's recordings, so a settle here must not evict
    // or supersede one made of tabs this window does not have.
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.book.create(
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
    expect(h.book.list()).toMatchObject([
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
    h.book.create(
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

describe('ending the tiling on screen for a single page', () => {
  it('forgets it, so a click on the page that lost its pane gives that page the window', async () => {
    /*
      The user chose "single". Kept, the recording would be the way back, and the next click on the
      other page would put the split straight back — "single" would last until the user touched a tab.
    */
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.controller.endTiling()
    h.showing('1x1', ['t1'])
    h.controller.restoreFor('t2')

    expect(h.book.list()).toEqual([])
    expect(h.applied()).toEqual([])

    await h.cleanup()
  })

  it('leaves the store alone when there is nothing to end', async () => {
    // The usual case — a window already showing one page — must not cost a publish.
    const h = await harness({ live: ['t1'], layout: '1x1', tiles: ['t1'] })

    h.controller.endTiling()

    expect(h.writes()).toBe(0)

    await h.cleanup()
  })

  it('keeps the way back to a tiling a new tab put away earlier', async () => {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.showing('1x1', ['t3'])

    h.controller.endTiling()
    h.controller.restoreFor('t2')

    expect(h.applied()).toEqual([{ layoutId: '1x2', seats: ['t1', 't2'], activatedTabId: 't2' }])

    await h.cleanup()
  })

  it('records afresh when the same tabs are tiled again', async () => {
    // No orphan, and no reuse either: the next split is a new recording from the next settle.
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.controller.endTiling()
    h.showing('1x1', ['t1'])

    h.showing('1x2', ['t1', 't2'])
    h.controller.keep()

    expect(h.book.list()).toMatchObject([
      { id: 'a2', layoutId: '1x2', seats: ['t1', 't2'], recordedAt: T0 + 2_000 }
    ])

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

describe('the visible arrangement and its id (U2)', () => {
  const LOUD = { muted: false, volume: 1 }

  it('knows the id of the arrangement it created for the screen', async () => {
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })

    h.controller.keep()

    expect(h.controller.liveId).toBe('a1')

    await h.cleanup()
  })

  it('takes a tab dropped into the visible arrangement under the same id', async () => {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.showing('1+2', ['t1', 't3', 't2'])
    h.controller.keep()

    expect(h.book.list()).toMatchObject([{ id: 'a1', layoutId: '1+2', seats: ['t1', 't3', 't2'] }])

    await h.cleanup()
  })

  it('writes the active tile, the dividers and the tile sounds down with the seating (KTD11)', async () => {
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.setView({
      activeTile: 1,
      fractions: { v: 0.3 },
      tileAudio: [LOUD, { muted: true, volume: 1 }]
    })
    h.controller.keep()
    h.controller.keep()

    expect(h.book.list()).toMatchObject([
      {
        id: 'a1',
        activeTile: 1,
        fractions: { v: 0.3 },
        tileAudio: [LOUD, { muted: true, volume: 1 }]
      }
    ])
    // Once for the creation and once for the view: the third settle found nothing new.
    expect(h.writes()).toBe(2)

    await h.cleanup()
  })

  it('adopts the arrangement that already holds every tab on screen instead of making a second', async () => {
    // A restart, a workspace, anything that shows an arrangement without going through `restore`.
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    const id = h.book.create(
      { layoutId: '1+2', seats: ['t1', 't2', 't3'] },
      { liveTabIds: ['t1', 't2', 't3'], hiddenTabIds: [] }
    )

    h.controller.keep()

    expect(h.controller.liveId).toBe(id)
    expect(h.book.list()).toMatchObject([{ id, layoutId: '1x2', seats: ['t1', 't2'] }])

    await h.cleanup()
  })

  it('lets go of the id once fewer than two tabs are on screen', async () => {
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.showing('1x2', ['t1', null])
    h.controller.keep()

    expect(h.controller.liveId).toBeNull()
    expect(h.book.list()).toMatchObject([{ id: 'a1', seats: ['t1', 't2'] }])

    await h.cleanup()
  })

  it('does not write a different set of tabs over the arrangement it had on screen', async () => {
    // The screen changed wholesale without the arrangement being put away: that is another tiling,
    // and rewriting the first one's seats would take its tabs out of its entry.
    const h = await harness({ live: ['t1', 't2', 't3', 't4'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.showing('1x2', ['t3', 't4'])
    h.controller.keep()

    expect(h.book.list().map((arrangement) => [arrangement.id, arrangement.seats])).toEqual([
      ['a1', ['t1', 't2']],
      ['a2', ['t3', 't4']]
    ])
    expect(h.controller.liveId).toBe('a2')

    await h.cleanup()
  })

  it('starts afresh when its arrangement was forgotten under it', async () => {
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.book.forget('a1')

    h.controller.keep()

    expect(h.controller.liveId).toBe('a2')

    await h.cleanup()
  })
})

describe('putting the visible arrangement away (R3, KTD11)', () => {
  it('writes the latest state down, takes the panes off screen and lets go of the id', async () => {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.setView({
      activeTile: 1,
      fractions: { v: 0.4 },
      tileAudio: [
        { muted: false, volume: 1 },
        { muted: false, volume: 1 }
      ]
    })

    h.controller.putAway()

    expect(h.events()).toEqual(['stow'])
    expect(h.controller.liveId).toBeNull()
    expect(h.book.list()).toMatchObject([
      { id: 'a1', seats: ['t1', 't2'], activeTile: 1, fractions: { v: 0.4 } }
    ])

    await h.cleanup()
  })

  it('does nothing to a window showing a single page', async () => {
    const h = await harness({ live: ['t1'], layout: '1x1', tiles: ['t1'] })

    h.controller.putAway()

    expect(h.events()).toEqual([])
    expect(h.writes()).toBe(0)

    await h.cleanup()
  })

  it('gives an unrecorded tiling on screen its own entry before it goes', async () => {
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })

    h.controller.putAway()

    expect(h.book.list()).toMatchObject([{ id: 'a1', seats: ['t1', 't2'] }])

    await h.cleanup()
  })
})

describe('bringing one back by its id (R4)', () => {
  /** A window that has put `t1`/`t2` away as `a1` and is showing `t3` alone. */
  async function withPutAway(): Promise<Harness> {
    const h = await harness({ live: ['t1', 't2', 't3', 't4'], layout: '1x2', tiles: ['t1', 't2'] })
    h.setView({
      activeTile: 1,
      fractions: { v: 0.3 },
      tileAudio: [
        { muted: false, volume: 1 },
        { muted: true, volume: 1 }
      ]
    })
    h.controller.keep()
    h.controller.putAway()
    h.showing('1x1', ['t3'])
    return h
  }

  it('applies its seats with the tab of its active tile active, and its dividers and sounds', async () => {
    const h = await withPutAway()

    h.controller.restore('a1')

    expect(h.applied()).toEqual([{ layoutId: '1x2', seats: ['t1', 't2'], activatedTabId: 't2' }])
    expect(h.views()).toEqual([
      {
        fractions: { v: 0.3 },
        tileAudio: [
          { muted: false, volume: 1 },
          { muted: true, volume: 1 }
        ]
      }
    ])
    expect(h.controller.liveId).toBe('a1')

    await h.cleanup()
  })

  it('clears the single page off the screen first, so it does not land in an empty seat', async () => {
    const h = await withPutAway()

    h.controller.restore('a1')

    expect(h.events()).toEqual(['stow', 'stow', 'apply'])

    await h.cleanup()
  })

  it('puts another visible arrangement away before bringing this one back', async () => {
    const h = await withPutAway()
    h.showing('1x2', ['t3', 't4'])
    h.controller.keep()
    expect(h.controller.liveId).toBe('a2')

    h.controller.restore('a1')

    expect(h.book.list().map((arrangement) => [arrangement.id, arrangement.seats])).toEqual([
      ['a1', ['t1', 't2']],
      ['a2', ['t3', 't4']]
    ])
    expect(h.events().slice(-2)).toEqual(['stow', 'apply'])
    expect(h.controller.liveId).toBe('a1')

    await h.cleanup()
  })

  it('does nothing for an id nothing holds, or while one of its tabs is hidden', async () => {
    const h = await withPutAway()

    h.controller.restore('nope')
    h.setHidden(['t1'])
    h.controller.restore('a1')

    expect(h.applied()).toEqual([])

    await h.cleanup()
  })

  it('does nothing for the arrangement already on screen', async () => {
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.controller.restore('a1')

    expect(h.applied()).toEqual([])
    expect(h.events()).toEqual([])

    await h.cleanup()
  })

  it('brings it back for a member found by search, with that member active (R14)', async () => {
    const h = await withPutAway()

    h.controller.restoreFor('t1')

    expect(h.applied()).toEqual([{ layoutId: '1x2', seats: ['t1', 't2'], activatedTabId: 't1' }])
    expect(h.controller.liveId).toBe('a1')

    await h.cleanup()
  })
})

describe('a member closing (KTD2)', () => {
  it('empties its seat in a put-away arrangement of three, which stays restorable', async () => {
    const h = await harness({
      live: ['t1', 't2', 't3', 't4'],
      layout: '1x3',
      tiles: ['t1', 't2', 't3']
    })
    h.controller.keep()
    h.controller.putAway()
    h.showing('1x1', ['t4'])

    h.controller.tabClosed('t2')
    h.setLiveTabs(['t1', 't3', 't4'])
    h.controller.restoreFor('t3')

    expect(h.book.list()).toMatchObject([{ id: 'a1', seats: ['t1', null, 't3'] }])
    expect(h.applied()).toEqual([
      { layoutId: '1x3', seats: ['t1', null, 't3'], activatedTabId: 't3' }
    ])

    await h.cleanup()
  })

  it('ends a put-away arrangement of two, leaving the other tab an ordinary one', async () => {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.controller.putAway()
    h.showing('1x1', ['t3'])

    h.controller.tabClosed('t2')
    h.setLiveTabs(['t1', 't3'])
    h.controller.restoreFor('t1')

    expect(h.book.list()).toEqual([])
    expect(h.applied()).toEqual([])

    await h.cleanup()
  })

  it('lets go of the id when the visible arrangement ends with it', async () => {
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.controller.tabClosed('t2')

    expect(h.controller.liveId).toBeNull()

    await h.cleanup()
  })
})

describe('releasing a tab from the view on screen (U10, R9)', () => {
  it('lets the tab go under the same id, and the settle after the panes close ranks keeps it', async () => {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x3', tiles: ['t1', 't2', 't3'] })
    h.controller.keep()

    expect(h.controller.releaseTab('t2')).toBe(true)
    expect(h.controller.isMember('t2')).toBe(false)
    expect(h.controller.liveId).toBe('a1')

    h.showing('1x2', ['t1', 't3'])
    h.controller.keep()
    expect(h.book.list()).toMatchObject([{ id: 'a1', layoutId: '1x2', seats: ['t1', 't3'] }])

    await h.cleanup()
  })

  it('ends a view of two, so neither tab is a member any more', async () => {
    // Without this the record would outlive the screen: fewer than two panes only lets go of the id,
    // and a click on either tab would bring the view back that the user has just taken apart.
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    expect(h.controller.releaseTab('t2')).toBe(true)

    expect(h.book.list()).toEqual([])
    expect(h.controller.liveId).toBeNull()
    expect(h.controller.isMember('t1')).toBe(false)

    await h.cleanup()
  })

  it('writes the screen down first, so a tab dropped in since the last settle can be released', async () => {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.showing('1+2', ['t1', 't3', 't2'])

    expect(h.controller.releaseTab('t3')).toBe(true)
    expect(h.book.list()).toMatchObject([{ id: 'a1', seats: ['t1', null, 't2'] }])

    await h.cleanup()
  })

  it('refuses a tab that is not on screen in a tiled view, and changes nothing', async () => {
    const h = await harness({ live: ['t1', 't2', 't3', 't4'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.controller.putAway()
    h.showing('1x2', ['t3', 't4'])
    h.controller.keep()
    const before = h.book.list()

    // A member of the view put away, and a tab in no view at all.
    expect(h.controller.releaseTab('t1')).toBe(false)
    expect(h.controller.releaseTab('loose')).toBe(false)
    expect(h.book.list()).toEqual(before)

    await h.cleanup()
  })
})

describe('the restart (KTD3)', () => {
  it('keeps the arrangement the session slot names as the visible one', async () => {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    const id = h.book.create(
      { layoutId: '1+2', seats: ['t1', 't2', 't3'] },
      { liveTabIds: ['t1', 't2', 't3'], hiddenTabIds: [] }
    )

    h.controller.settleRestored(id ?? null)
    h.controller.keep()

    expect(h.controller.liveId).toBe(id)
    expect(h.book.list()).toMatchObject([{ id, layoutId: '1x2', seats: ['t1', 't2'] }])

    await h.cleanup()
  })

  it('adopts the arrangement matching the screen for a slot without an id', async () => {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    const id = h.book.create(
      { layoutId: '1x2', seats: ['t1', 't2'] },
      { liveTabIds: ['t1', 't2', 't3'], hiddenTabIds: [] }
    )

    h.controller.settleRestored(null)

    expect(h.controller.liveId).toBe(id)

    await h.cleanup()
  })

  it('forgets an arrangement in the way of the screen, so the next settle can record it', async () => {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x2', tiles: ['t1', 't2'] })
    h.book.create(
      { layoutId: '1x2', seats: ['t3', 't1'] },
      { liveTabIds: ['t1', 't2', 't3'], hiddenTabIds: [] }
    )

    h.controller.settleRestored(null)
    h.controller.keep()

    expect(h.book.list().map((arrangement) => [arrangement.id, arrangement.seats])).toEqual([
      ['a2', ['t1', 't2']]
    ])
    expect(h.controller.liveId).toBe('a2')

    await h.cleanup()
  })

  it('names nothing while the window comes back showing a single page', async () => {
    const h = await harness({ live: ['t1', 't2', 't3'], layout: '1x1', tiles: ['t3'] })
    const id = h.book.create(
      { layoutId: '1x2', seats: ['t1', 't2'] },
      { liveTabIds: ['t1', 't2', 't3'], hiddenTabIds: [] }
    )

    h.controller.settleRestored(id ?? null)

    expect(h.controller.liveId).toBeNull()
    expect(h.book.list()).toHaveLength(1)

    await h.cleanup()
  })
})

describe('what the strip is told (KTD5)', () => {
  it("summarises this window's arrangements and marks the visible one", async () => {
    const h = await harness({ live: ['t1', 't2', 't3', 't4'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.controller.putAway()
    h.showing('1x2', ['t3', 't4'])
    h.controller.keep()

    expect(h.controller.summaries().map((summary) => [summary.id, summary.visible])).toEqual([
      ['a1', false],
      ['a2', true]
    ])

    await h.cleanup()
  })
})

describe('ending the tiling lets go of the id', () => {
  it('names no visible arrangement after the single layout was chosen', async () => {
    const h = await harness({ live: ['t1', 't2'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()

    h.controller.endTiling()

    expect(h.controller.liveId).toBeNull()

    await h.cleanup()
  })
})

describe('ending a put-away arrangement (KTD12, R8)', () => {
  /** `a1` = t1 | t2 put away, `a2` = t3 | t4 on screen. */
  async function withOneOnScreen(): Promise<Harness> {
    const h = await harness({ live: ['t1', 't2', 't3', 't4'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.controller.putAway()
    h.showing('1x2', ['t3', 't4'])
    h.controller.keep()
    return h
  }

  it('forgets it first and then hands its seats over to become ordinary tabs', async () => {
    const h = await withOneOnScreen()
    const before = h.events().length

    h.controller.endArrangement('a1')

    expect(h.dissolved()).toEqual([{ seats: ['t1', 't2'], heldAtTheTime: ['a2'] }])
    expect(h.book.list().map((arrangement) => arrangement.id)).toEqual(['a2'])
    // Nothing on screen moves: no stow, no apply, and the visible one is still the visible one.
    expect(h.events().slice(before)).toEqual(['dissolve'])
    expect(h.controller.liveId).toBe('a2')

    await h.cleanup()
  })

  it('ends one whose group is folded, because ending it puts nothing on screen', async () => {
    const h = await withOneOnScreen()
    h.setHidden(['t1', 't2'])

    h.controller.endArrangement('a1')

    expect(h.dissolved().map((call) => call.seats)).toEqual([['t1', 't2']])

    await h.cleanup()
  })

  it('leaves the visible one, an unknown id and another window’s alone', async () => {
    const h = await withOneOnScreen()

    h.controller.endArrangement('a2')
    h.controller.endArrangement('nope')
    h.setLiveTabs(['t2', 't3', 't4'])
    h.controller.endArrangement('a1')

    expect(h.dissolved()).toEqual([])
    expect(h.book.list().map((arrangement) => arrangement.id)).toEqual(['a1', 'a2'])

    await h.cleanup()
  })
})

describe('dissolving one by its id before its tabs close (KTD13, R5)', () => {
  /** `a1` = t1 | t2 put away, `a2` = t3 | t4 on screen. */
  async function withOneOnScreen(): Promise<Harness> {
    const h = await harness({ live: ['t1', 't2', 't3', 't4'], layout: '1x2', tiles: ['t1', 't2'] })
    h.controller.keep()
    h.controller.putAway()
    h.showing('1x2', ['t3', 't4'])
    h.controller.keep()
    return h
  }

  it('forgets a put-away one and answers its tabs in tile order, moving nothing on screen', async () => {
    const h = await withOneOnScreen()
    const before = h.events().length

    expect(h.controller.dissolve('a1')).toEqual(['t1', 't2'])

    expect(h.book.list().map((arrangement) => arrangement.id)).toEqual(['a2'])
    expect(h.events().slice(before)).toEqual([])
    expect(h.controller.liveId).toBe('a2')

    await h.cleanup()
  })

  it('puts the visible one away first, with what the screen shows now, and lets go of the id', async () => {
    const h = await withOneOnScreen()
    // A tab dropped in since the last round: the dissolve reads the screen, not the stale record.
    h.setLiveTabs(['t1', 't2', 't3', 't4', 't5'])
    h.showing('1x3', ['t3', 't4', 't5'])
    const before = h.events().length

    expect(h.controller.dissolve('a2')).toEqual(['t3', 't4', 't5'])

    expect(h.events().slice(before)).toEqual(['stow'])
    expect(h.controller.liveId).toBeNull()
    expect(h.book.list().map((arrangement) => arrangement.id)).toEqual(['a1'])

    await h.cleanup()
  })

  it('dissolves one a fold is hiding, because closing puts nothing on screen', async () => {
    const h = await withOneOnScreen()
    h.setHidden(['t1', 't2'])

    expect(h.controller.dissolve('a1')).toEqual(['t1', 't2'])
    expect(h.book.list().map((arrangement) => arrangement.id)).toEqual(['a2'])

    await h.cleanup()
  })

  it('answers nothing and forgets nothing for an unknown id or another window’s', async () => {
    const h = await withOneOnScreen()

    expect(h.controller.dissolve('nope')).toEqual([])
    h.setLiveTabs(['t2', 't3', 't4'])
    expect(h.controller.dissolve('a1')).toEqual([])

    expect(h.book.list().map((arrangement) => arrangement.id)).toEqual(['a1', 'a2'])

    await h.cleanup()
  })
})

describe('muting a put-away one (KTD11, R6)', () => {
  async function withOneOnScreen(): Promise<Harness> {
    const h = await harness({ live: ['t1', 't2', 't3', 't4'], layout: '1x2', tiles: ['t1', 't2'] })
    h.setView({
      activeTile: 1,
      fractions: { v: 0.3 },
      tileAudio: [
        { muted: false, volume: 0.5 },
        { muted: true, volume: 1 }
      ]
    })
    h.controller.keep()
    h.controller.putAway()
    h.showing('1x2', ['t3', 't4'])
    h.controller.keep()
    return h
  }

  it('writes every tile’s mute into its record, keeps the volumes, and answers its tabs', async () => {
    const h = await withOneOnScreen()

    expect(h.controller.setMuted('a1', true)).toEqual(['t1', 't2'])

    expect(h.book.list().find((arrangement) => arrangement.id === 'a1')?.tileAudio).toEqual([
      { muted: true, volume: 0.5 },
      { muted: true, volume: 1 }
    ])

    expect(h.controller.setMuted('a1', false)).toEqual(['t1', 't2'])
    expect(h.book.list().find((arrangement) => arrangement.id === 'a1')?.tileAudio).toEqual([
      { muted: false, volume: 0.5 },
      { muted: false, volume: 1 }
    ])

    await h.cleanup()
  })

  it('brings the mute back with the view', async () => {
    const h = await withOneOnScreen()
    h.controller.setMuted('a1', true)

    h.controller.restore('a1')

    expect(h.views().at(-1)?.tileAudio).toEqual([
      { muted: true, volume: 0.5 },
      { muted: true, volume: 1 }
    ])

    await h.cleanup()
  })

  it('leaves the visible one to its tiles, and an unknown id or another window’s alone', async () => {
    const h = await withOneOnScreen()
    const writes = h.writes()

    expect(h.controller.setMuted('a2', true)).toEqual([])
    expect(h.controller.setMuted('nope', true)).toEqual([])
    h.setLiveTabs(['t2', 't3', 't4'])
    expect(h.controller.setMuted('a1', true)).toEqual([])

    expect(h.writes()).toBe(writes)

    await h.cleanup()
  })
})
