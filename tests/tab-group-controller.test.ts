import { describe, expect, it } from 'vitest'
import { TabGroupController, type TabGroupHost } from '@main/browser/TabGroupController.js'
import { TabGroupStore, type TabGroupBook } from '@main/data/TabGroupStore.js'
import type { TabGroupLayout } from '@shared/tabgroups/model.js'
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
 *   - An arrangement recorded on the wrong group, or on a new group that took its members from one the
 *     user made, turns "remember where these tabs were" into "quietly edit my groups".
 */

interface Harness {
  controller: TabGroupController
  book: TabGroupBook
  order: () => string[]
  unassigned: () => string[]
  broadcasts: () => number
  /**
   * Replaces the set of tabs the window still holds.
   *
   * Separate from the strip's order on purpose, because in a real window they are two different
   * things: `#tabs` is the map of live tabs and `#tabOrder` is the strip's sequence. A harness that
   * derived one from the other could not express "these tabs are gone", which is exactly the state
   * `retainLiveTabs` exists for.
   */
  setLiveTabs: (ids: string[]) => void
  cleanup: () => Promise<void>
}

async function harness(initialOrder: string[]): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-groups-'))
  // A real store rather than a fake book: the interesting behaviour is the *interaction* between the
  // store's rules and the window's state, and a fake would let the controller pass while disagreeing
  // with the thing it actually talks to.
  const store = await TabGroupStore.open({ filePath: join(directory, 'groups.json'), debounceMs: 0 })

  let order = [...initialOrder]
  let liveTabs = [...initialOrder]
  const unassigned: string[] = []
  let broadcasts = 0

  const host: TabGroupHost = {
    book: store,
    tabOrder: () => order,
    setTabOrder: (next) => {
      order = [...next]
    },
    unassign: (tabId) => unassigned.push(tabId),
    liveTabIds: () => liveTabs,
    broadcast: () => {
      broadcasts += 1
    }
  }

  return {
    controller: new TabGroupController(host),
    book: store,
    order: () => order,
    unassigned: () => unassigned,
    broadcasts: () => broadcasts,
    setLiveTabs: (ids) => {
      liveTabs = [...ids]
    },
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

    expect(h.unassigned()).toContain('t1')
    expect(h.unassigned()).toContain('t2')
    await h.cleanup()
  })

  it('leaves tabs outside the group in their tiles', async () => {
    const h = await harness(['t1', 't2', 't3'])
    const group = h.controller.create({ tabIds: ['t1'] })
    h.controller.setCollapsed(group.id, true)
    expect(h.unassigned()).not.toContain('t3')
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
    const afterCollapse = h.unassigned().length

    h.controller.setCollapsed(group.id, false)
    expect(h.unassigned()).toHaveLength(afterCollapse)
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

  it('empties every group when a launch brings back no tabs', async () => {
    /*
      What happens today, stated so it cannot change by accident. Session restore does not exist yet,
      so a launch supplies no ids and every stored group is emptied — and that is the intended outcome
      rather than a bug: keeping them would attach the user's old groups to whichever fresh tabs
      happened to get the ids `tab-1` and `tab-3`.
    */
    const h = await harness(['t1', 't2'])
    h.controller.create({ tabIds: ['t1', 't2'] })
    h.setLiveTabs([])
    h.controller.retainLiveTabs()
    expect(h.controller.groups()).toEqual([])
    await h.cleanup()
  })

  it('drops members the window no longer has', async () => {
    /*
      The reconciliation a launch needs, and the one that makes stored groups safe. Tab ids restart at
      `tab-1` every launch, so a stored membership names *this* run's tabs whichever pages they turn
      out to be — adopting it unreconciled would drop unrelated fresh tabs into the user's old groups.
    */
    const h = await harness(['t1', 't2', 't3'])
    h.controller.create({ tabIds: ['t1', 't2'] })

    // The window now has only `t3`: the other two closed, or this is a fresh launch.
    h.setLiveTabs(['t3'])
    h.controller.retainLiveTabs()
    expect(h.controller.groups()).toEqual([])
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
    expect(h.unassigned()).toEqual([])
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
    expect(h.unassigned()).toEqual([])
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

/**
 * Keeping and spending a displaced arrangement.
 *
 * The user's request in one sentence: opening a new tab may take the window, but it must not dissolve the
 * arrangement the other tabs were in. `keepArrangement` is called at the one moment that arrangement still
 * exists — the collapse — and `takeArrangementFor` is the way back. Tested against the real store, because
 * what matters is that the recording survives the store's own rules rather than that a fake accepted it.
 */
describe('keeping the arrangement a new tab displaced', () => {
  const pair = (tiles: Array<string | null>): TabGroupLayout => ({ id: '1x2', tiles })
  const quad = (tiles: Array<string | null>): TabGroupLayout => ({ id: '2x2', tiles })

  it('makes a group for tabs that were in none, carrying the arrangement', async () => {
    // The everyday case, and the whole point: the tabs stay together *and* where they were is written
    // down. A group without the arrangement would keep them together and still lose the layout.
    const h = await harness(['t1', 't2', 't3'])
    h.controller.keepArrangement(pair(['t1', 't2']))

    const groups = h.controller.groups()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.tabIds).toEqual(['t1', 't2'])
    expect(groups[0]?.layout).toEqual(pair(['t1', 't2']))
    await h.cleanup()
  })

  it('leaves the group it makes unnamed', async () => {
    /*
      Decided rather than overlooked. An unnamed group is a first-class state here — a bare colour, labelled
      `tabgroup.unnamed` for a screen reader — while a name stored in the document would be frozen in the
      language it was captured in: recorded in German it would still read "Geteilte Ansicht" after the user
      switched to English, because a stored string cannot be re-read from the catalogue.
    */
    const h = await harness(['t1', 't2'])
    h.controller.keepArrangement(pair(['t1', 't2']))
    expect(h.controller.groups()[0]?.name).toBe('')
    await h.cleanup()
  })

  it('records a second displacement on the group it made the first time', async () => {
    /*
      What keeps this from being group spam. Collapse, restore, collapse again is an ordinary afternoon, and
      a new chip each time would march down the strip in a different colour every round — with the user's own
      name on none of them.
    */
    const h = await harness(['t1', 't2', 't3'])
    h.controller.keepArrangement(pair(['t1', 't2']))
    const first = h.controller.groups()[0]!
    h.controller.rename(first.id, 'Recherche')

    h.controller.takeArrangementFor('t1')
    h.controller.keepArrangement(pair(['t2', 't1']))

    const groups = h.controller.groups()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.id).toBe(first.id)
    expect(groups[0]?.name).toBe('Recherche')
    expect(groups[0]?.layout).toEqual(pair(['t2', 't1']))
    await h.cleanup()
  })

  it('refuses to edit a group the user made in order to remember a layout', async () => {
    /*
      The destructive case, refused. `create` takes its members away from whatever held them, so recording
      an arrangement of "two tabs from Work plus one loose tab" would shrink Work — and dissolve it outright
      if the arrangement held all of it. Opening a new tab is not consent to that.

      The stated cost is in the same breath: this arrangement is not remembered. One drag to rebuild, against
      a group the user built that cannot be got back.
    */
    const h = await harness(['t1', 't2', 't3'])
    const work = h.controller.create({ tabIds: ['t1', 't2'], name: 'Steuererklärung 2026' })

    h.controller.keepArrangement(quad(['t1', 't2', 't3', null]))

    const groups = h.controller.groups()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.id).toBe(work.id)
    expect(groups[0]?.tabIds).toEqual(['t1', 't2'])
    expect(groups[0]?.layout).toBeUndefined()
    await h.cleanup()
  })

  it('keeps nothing when only one pane held anything', async () => {
    // One page in one pane is not an arrangement, and a group per new tab is not a feature.
    const h = await harness(['t1', 't2'])
    h.controller.keepArrangement(pair(['t1', null]))
    expect(h.controller.groups()).toEqual([])
    await h.cleanup()
  })

  it('gathers the members it grouped into one run of the strip', async () => {
    // A group must be drawn as one bracket, and this one is created out of tabs that were not adjacent —
    // the panes of a split have nothing to do with the strip's order.
    const h = await harness(['t1', 't2', 't3', 't4'])
    h.controller.keepArrangement(pair(['t1', 't4']))

    const order = h.order()
    expect(order).toHaveLength(4)
    expect(Math.abs(order.indexOf('t1') - order.indexOf('t4'))).toBe(1)
    await h.cleanup()
  })

  it('publishes, so the chip appears', async () => {
    const h = await harness(['t1', 't2'])
    const before = h.broadcasts()
    h.controller.keepArrangement(pair(['t1', 't2']))
    expect(h.broadcasts()).toBeGreaterThan(before)
    await h.cleanup()
  })
})

describe('taking a displaced arrangement back out', () => {
  const pair = (tiles: Array<string | null>): TabGroupLayout => ({ id: '1x2', tiles })

  it('hands the arrangement to a member being activated', async () => {
    const h = await harness(['t1', 't2'])
    h.controller.keepArrangement(pair(['t1', 't2']))
    expect(h.controller.takeArrangementFor('t2')).toEqual(pair(['t1', 't2']))
    await h.cleanup()
  })

  it('spends it, so a second activation does not replay it', async () => {
    /*
      The decision, and the reason. A recording is of one displacement, not a preference: by the time the
      user clicks another tab they may have dragged a page into a different pane or chosen another layout,
      and reapplying would quietly undo what they did after the first restore. Spent once it is a way back;
      kept, it is a layout that keeps reasserting itself.
    */
    const h = await harness(['t1', 't2'])
    h.controller.keepArrangement(pair(['t1', 't2']))
    h.controller.takeArrangementFor('t1')
    expect(h.controller.takeArrangementFor('t2')).toBeNull()
    await h.cleanup()
  })

  it('leaves the group standing after the arrangement is spent', async () => {
    /*
      The other half of the same decision, and it is the user's request rather than an implementation detail:
      the tabs that were in the arrangement stay together. Dissolving the group here would also throw away a
      name they may have given it and force the next displacement to invent a new group in a new colour.
    */
    const h = await harness(['t1', 't2'])
    h.controller.keepArrangement(pair(['t1', 't2']))
    h.controller.takeArrangementFor('t1')

    const groups = h.controller.groups()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.tabIds).toEqual(['t1', 't2'])
    expect(groups[0]?.layout).toBeUndefined()
    await h.cleanup()
  })

  it('hands nothing to a tab in no group', async () => {
    const h = await harness(['t1', 't2'])
    expect(h.controller.takeArrangementFor('t1')).toBeNull()
    await h.cleanup()
  })

  it('hands nothing to a group that is not carrying one', async () => {
    const h = await harness(['t1', 't2'])
    const group = h.controller.create({ tabIds: ['t1', 't2'] })
    expect(group.layout).toBeUndefined()
    expect(h.controller.takeArrangementFor('t1')).toBeNull()
    await h.cleanup()
  })

  it('hands nothing to a member the arrangement does not seat', async () => {
    /*
      A member added after the recording, which the arrangement has no tile for. Restoring for that tab would
      apply a layout with nowhere for the tab the user just clicked: they would click one thing and watch a
      different set of pages appear, with their own click's target still off screen.
    */
    const h = await harness(['t1', 't2', 't3'])
    h.controller.keepArrangement(pair(['t1', 't2']))
    const group = h.controller.groups()[0]!
    h.controller.addTab(group.id, 't3')

    expect(h.controller.takeArrangementFor('t3')).toBeNull()
    // And it is still there for the members it does seat, rather than spent by the refusal.
    expect(h.controller.takeArrangementFor('t1')).toEqual(pair(['t1', 't2']))
    await h.cleanup()
  })
})
