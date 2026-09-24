import { describe, expect, it } from 'vitest'
import { TabGroupController, type TabGroupHost } from '@main/browser/TabGroupController.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

/**
 * Tab groups where they meet a window.
 *
 * The model decides what a legal group is and is tested on its own. What is tested here is the part
 * that has to reconcile groups with the window's two other pieces of state — the strip's order, and
 * which tab holds which tile — because those couplings are invisible from the model and each has a
 * failure that looks like something else entirely:
 *
 *   - An order that is not settled leaves a group drawn as two runs with someone else's tab between
 *     them, which reads as a sorting bug.
 *   - A collapsed group that keeps its tiles leaves a page on screen with nothing in the strip to
 *     close it, mute it, or switch away from — a pane the user cannot get rid of.
 *
 * There used to be a third coupling here — the arrangement a multi-view is — and the cases that went
 * with it are gone rather than moved: the recording no longer lives on a group, and what replaced it is
 * covered by `tests/arrangement-controller.test.ts` against a host that cannot reach a group at all.
 *
 * ## What this file deliberately does not prove
 *
 * That releasing a tile actually reaches the split grid. The host below is a fake, so "the tiles were
 * released" here means "the seam was called" — and that is exactly how the wiring shipped a fold that
 * told a `Tab` its tile index was `null` and told `SplitController` nothing, leaving the page on
 * screen. `tests/window-seams.test.ts` drives the real `createWindowSeams` and asserts on the split
 * itself. What is left here is what this controller alone decides: which tabs are released, in how
 * many calls, and which tab is activated afterwards.
 */

interface Harness {
  controller: TabGroupController
  order: () => string[]
  released: () => string[]
  releaseCalls: () => string[][]
  activated: () => string[]
  broadcasts: () => number
  cleanup: () => Promise<void>
}

async function harness(
  initialOrder: string[],
  options: { tiled?: string[]; activeTab?: string } = {}
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-groups-'))
  // A real store rather than a fake book: the interesting behaviour is the *interaction* between the
  // store's rules and the window's state, and a fake would let the controller pass while disagreeing
  // with the thing it actually talks to.
  const store = await TabGroupStore.open({
    filePath: join(directory, 'groups.json'),
    debounceMs: 0
  })

  let order = [...initialOrder]
  const liveTabs = [...initialOrder]
  const tiled = new Set(options.tiled ?? initialOrder)
  let activeTab: string | null = options.activeTab ?? null
  const releaseCalls: string[][] = []
  const activated: string[] = []
  let broadcasts = 0

  const host: TabGroupHost = {
    book: store,
    tabOrder: () => order,
    setTabOrder: (next) => {
      order = [...next]
    },
    releaseTiles: (tabIds) => {
      releaseCalls.push([...tabIds])
      const held = tabIds.filter((tabId) => tiled.has(tabId))
      for (const tabId of held) {
        tiled.delete(tabId)
        // A released tab cannot be the one in the active tile any more; the split answers `null`
        // for an empty tile, and that emptiness is what R10's activation exists to repair.
        if (activeTab === tabId) activeTab = null
      }
      return held.length > 0
    },
    activeTabId: () => activeTab,
    activateTab: (tabId) => {
      activated.push(tabId)
      activeTab = tabId
    },
    liveTabIds: () => liveTabs,
    broadcast: () => {
      broadcasts += 1
    }
  }

  return {
    controller: new TabGroupController(host),
    order: () => order,
    released: () => releaseCalls.flat(),
    releaseCalls: () => releaseCalls,
    activated: () => activated,
    broadcasts: () => broadcasts,
    cleanup: async () => {
      await store.flush()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

describe('grouping tabs that are apart', () => {
  it('moves them together in the strip', async () => {
    /*
      The behaviour a person would call "grouping". Selecting the first and last of five tabs and
      grouping them has to move something; leaving the order alone would draw the group as two runs
      with three unrelated tabs between them.
    */
    const h = await harness(['t1', 't2', 't3', 't4', 't5'])
    h.controller.create({ tabIds: ['t1', 't5'], name: 'Work' })

    const order = h.order()
    expect(order).toHaveLength(5)
    expect(Math.abs(order.indexOf('t1') - order.indexOf('t5'))).toBe(1)
    await h.cleanup()
  })

  it('leaves every other tab in the strip', async () => {
    // Settling the order must not drop anyone. A tab that vanished from the order is still open, still
    // consuming a process, and unreachable.
    const h = await harness(['t1', 't2', 't3', 't4', 't5'])
    h.controller.create({ tabIds: ['t2', 't4'] })
    expect([...h.order()].sort()).toEqual(['t1', 't2', 't3', 't4', 't5'])
    await h.cleanup()
  })

  it('passes on the name and the colour the request carried', async () => {
    /*
      The controller filters the tab ids and hands the rest of the request through. Both
      the name and the colour are optional, and the two spreads that forward them could
      be dropped with every other assertion in this file still passing: the group would
      come back with an empty name and the next colour in the palette. What the user
      would see is the group they just named "Work" in orange drawn as an unnamed blue
      chip — and, because the name is what the strip labels the run with, no way to tell
      which run is which.
    */
    const h = await harness(['t1', 't2', 't3'])
    const group = h.controller.create({ tabIds: ['t1'], name: 'Work', color: 'orange' })

    expect(group.name).toBe('Work')
    expect(group.color).toBe('orange')
    // Stored, not merely returned: the strip reads the store on the next broadcast.
    expect(h.controller.groups()).toEqual([
      expect.objectContaining({ name: 'Work', color: 'orange' })
    ])

    // And a request that names neither still gets the defaults, so the assertion above
    // cannot be met by ignoring the `undefined` check and forwarding it anyway.
    const plain = h.controller.create({ tabIds: ['t2'] })
    expect(plain.name).toBe('')
    expect(plain.color).not.toBe('orange')
    await h.cleanup()
  })

  it('publishes, so the strip redraws', async () => {
    const h = await harness(['t1', 't2'])
    const before = h.broadcasts()
    h.controller.create({ tabIds: ['t1'] })
    expect(h.broadcasts()).toBeGreaterThan(before)
    await h.cleanup()
  })
})

describe('a request naming a tab this window does not have', () => {
  it('groups the ones it does and ignores the rest', async () => {
    /*
      Found by driving the real contract: a request naming an unknown id used to succeed, producing a
      group with a phantom member — a chip that counts a tab nobody can see and reports "2 hidden" when
      only one exists.

      Dropped rather than refused, because the honest cause is a race: the chrome UI took the ids from a
      `tabs:changed` it has already drawn, and a tab can close between the render and the click.
    */
    const h = await harness(['t1', 't2'])
    const group = h.controller.create({ tabIds: ['t1', 'gone'] })
    expect(group.tabIds).toEqual(['t1'])
    await h.cleanup()
  })

  it('refuses when nothing is left, rather than making an empty group', async () => {
    /*
      The message is asserted, not merely that something was thrown. Without the check in
      the controller the empty list reaches the store, which throws `EmptyTabGroupError`
      from the model — so a bare `toThrow()` passes either way while the refusal has moved
      to a layer that does not know *why* the list is empty. The controller's sentence is
      the one that reaches the user: "the tabs you selected have closed" rather than "a
      group must contain a tab", which reads like a bug in the browser.
    */
    const h = await harness(['t1'])
    expect(() => h.controller.create({ tabIds: ['gone', 'also-gone'] })).toThrow(
      /none of those tabs are in this window/
    )
    expect(h.controller.groups()).toEqual([])
    await h.cleanup()
  })

  it('refuses to add an unknown tab to an existing group', async () => {
    const h = await harness(['t1', 't2'])
    const group = h.controller.create({ tabIds: ['t1'] })
    // Naming the tab, for the same reason: this refusal is reported over IPC, and the id
    // is the only thing that tells a stale request apart from a genuine bug.
    expect(() => h.controller.addTab(group.id, 'gone')).toThrow(/no tab gone in this window/)
    expect(h.controller.groups()[0]?.tabIds).toEqual(['t1'])
    await h.cleanup()
  })
})

describe('folding a group away', () => {
  it('takes its tabs out of their tiles', async () => {
    /*
      The coupling that matters. A hidden tab holding a tile leaves a page visible with no way to act
      on it — the strip has nothing to click, so it cannot be closed, muted or switched away from.
    */
    const h = await harness(['t1', 't2', 't3'])
    const group = h.controller.create({ tabIds: ['t1', 't2'] })
    h.controller.setCollapsed(group.id, true)

    // One call carrying both, not one call each: the grid must never be observable half-released,
    // and the whole fold is a single redraw (KTD5).
    expect(h.releaseCalls()).toEqual([['t1', 't2']])
    await h.cleanup()
  })

  it('leaves tabs outside the group in their tiles', async () => {
    const h = await harness(['t1', 't2', 't3'])
    const group = h.controller.create({ tabIds: ['t1'] })
    h.controller.setCollapsed(group.id, true)
    expect(h.released()).not.toContain('t3')
    await h.cleanup()
  })

  it('gives the window a tab once the screen is cleared, whoever was active (R11)', async () => {
    /*
      A release that took anything off screen has left it empty: a tiled view holding a folded tab
      is put away whole, and a single page leaves the only pane there is. So the window needs a tab
      whether or not the one in front of the user was folded — no shrink is asked for any more,
      because there are no panes left to take away (R11 replaces R9).
    */
    const h = await harness(['t1', 't2', 't3'])
    const group = h.controller.create({ tabIds: ['t1', 't2'] })
    h.controller.setCollapsed(group.id, true)
    expect(h.activated()).toEqual(['t3'])
    await h.cleanup()
  })

  it('activates nothing when no member was on screen', async () => {
    // Nothing left the screen, so the page in front of the user is still there.
    const h = await harness(['t1', 't2', 't3'], { tiled: ['t3'], activeTab: 't3' })
    const group = h.controller.create({ tabIds: ['t1', 't2'] })
    h.controller.setCollapsed(group.id, true)
    expect(h.activated()).toEqual([])
    await h.cleanup()
  })

  it('reports its members as hidden, and only while it is folded', async () => {
    const h = await harness(['t1', 't2'])
    const group = h.controller.create({ tabIds: ['t1'] })
    expect(h.controller.isHidden('t1')).toBe(false)

    h.controller.setCollapsed(group.id, true)
    expect(h.controller.isHidden('t1')).toBe(true)
    expect(h.controller.isHidden('t2')).toBe(false)

    h.controller.setCollapsed(group.id, false)
    expect(h.controller.isHidden('t1')).toBe(false)
    await h.cleanup()
  })

  it('keeps the hidden tabs in the order it publishes', async () => {
    /*
      Deliberate, and easy to get wrong the other way. The chip has to say how many tabs are folded
      away, so the strip needs to know they exist — which ones to *draw* is decided on the renderer's
      side with the same shared function.
    */
    const h = await harness(['t1', 't2', 't3'])
    const group = h.controller.create({ tabIds: ['t1', 't2'] })
    h.controller.setCollapsed(group.id, true)
    expect(h.controller.displayOrder()).toHaveLength(3)
    await h.cleanup()
  })

  it('does not put the tabs back into tiles when it is opened again', async () => {
    /*
      Which tile a tab should return to is not recoverable: the layout may have changed and another
      tab may be in that tile now. Guessing would evict whatever the user has since put there, so the
      tabs come back unassigned and dragging one into a tile is how it returns.
    */
    const h = await harness(['t1', 't2'])
    const group = h.controller.create({ tabIds: ['t1'] })
    h.controller.setCollapsed(group.id, true)
    const activatedAfterCollapse = [...h.activated()]

    h.controller.setCollapsed(group.id, false)

    // Nothing to release — no tab is hidden any more — so nothing leaves the screen and no tile is
    // handed back out. The tiled view's entry is the way back, and a click is what applies it (R11).
    expect(h.releaseCalls().at(-1)).toEqual([])
    expect(h.activated()).toEqual(activatedAfterCollapse)
    await h.cleanup()
  })

  it('moves the selection to the first tab still in the strip (R10)', async () => {
    /*
      Without this the window is left with nothing active at all: `SplitController.activeTabId()` is
      `tabIdAt(activeTile)`, so releasing the tile the active tab was in makes it `null`, and from
      then on every toolbar command reads no active tab and silently does nothing.

      "First still in the strip" is the published order, not the raw one — grouping gathers a group's
      members into one run, and that run is what the user sees.
    */
    const h = await harness(['t1', 't2', 't3'], { activeTab: 't2' })
    const group = h.controller.create({ tabIds: ['t1', 't2'] })

    h.controller.setCollapsed(group.id, true)

    expect(h.activated()).toEqual(['t3'])
    await h.cleanup()
  })

  it('gives the window back to an active tab the fold did not hide (R10)', async () => {
    /*
      It used to be left alone, because it kept its pane. Now the view it sat in is put away with
      the folded members, so leaving it alone would leave the window empty; it takes the window,
      ahead of the first tab in the strip, because it is the page the user was looking at.
    */
    const h = await harness(['t0', 't1', 't2', 't3'], { activeTab: 't3' })
    const group = h.controller.create({ tabIds: ['t1', 't2'] })

    h.controller.setCollapsed(group.id, true)

    expect(h.activated()).toEqual(['t3'])
    await h.cleanup()
  })

  it('activates nothing when the fold leaves no tab in the strip', async () => {
    // Every remaining tab is hidden, so there is nothing to make active and no honest fallback —
    // activating a hidden tab would recreate the very state the fold exists to clear.
    const h = await harness(['t1', 't2'], { activeTab: 't1' })
    const group = h.controller.create({ tabIds: ['t1', 't2'] })

    h.controller.setCollapsed(group.id, true)

    expect(h.activated()).toEqual([])
    await h.cleanup()
  })
})

describe('a group losing its tabs', () => {
  it('goes when its last member is removed', async () => {
    // A group with no tabs is a chip with nothing behind it — clickable, nameable, and attached to
    // nothing.
    const h = await harness(['t1', 't2'])
    const group = h.controller.create({ tabIds: ['t1'] })
    h.controller.removeTab('t1')
    expect(h.controller.groups().find((candidate) => candidate.id === group.id)).toBeUndefined()
    await h.cleanup()
  })

  it('survives losing one of several', async () => {
    const h = await harness(['t1', 't2', 't3'])
    const group = h.controller.create({ tabIds: ['t1', 't2'] })
    h.controller.removeTab('t1')
    expect(h.controller.groups().find((candidate) => candidate.id === group.id)?.tabIds).toEqual([
      't2'
    ])
    await h.cleanup()
  })
})

describe('renaming and recolouring', () => {
  it('changes the group without touching any tab', async () => {
    // Renaming is the one operation that changes a group and nothing else, which is why
    // `tabgroups:changed` is a separate event from `tabs:changed`.
    const h = await harness(['t1', 't2'])
    const group = h.controller.create({ tabIds: ['t1'] })
    const orderBefore = [...h.order()]

    h.controller.rename(group.id, 'Reading')
    h.controller.recolor(group.id, 'green')

    const updated = h.controller.groups().find((candidate) => candidate.id === group.id)
    expect(updated?.name).toBe('Reading')
    expect(updated?.color).toBe('green')
    expect(h.order()).toEqual(orderBefore)
    expect(h.releaseCalls()).toEqual([])
    await h.cleanup()
  })
})

describe('dissolving a group', () => {
  it('keeps every tab open and ungrouped', async () => {
    // Dissolving is not closing. The distinction is the whole reason the two are different verbs.
    const h = await harness(['t1', 't2'])
    const group = h.controller.create({ tabIds: ['t1', 't2'] })
    h.controller.dissolve(group.id)

    expect(h.controller.groups()).toEqual([])
    expect([...h.order()].sort()).toEqual(['t1', 't2'])
    expect(h.releaseCalls()).toEqual([])
    await h.cleanup()
  })
})

describe('adding a tab to an existing group', () => {
  it('brings it next to the others', async () => {
    const h = await harness(['t1', 't2', 't3', 't4'])
    const group = h.controller.create({ tabIds: ['t1'] })
    h.controller.addTab(group.id, 't4')

    const order = h.order()
    expect(Math.abs(order.indexOf('t1') - order.indexOf('t4'))).toBe(1)
    await h.cleanup()
  })
})
