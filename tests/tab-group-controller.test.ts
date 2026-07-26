import { describe, expect, it } from 'vitest'
import { TabGroupController, type TabGroupHost } from '@main/browser/TabGroupController.js'
import { TabGroupStore, type TabGroupBook } from '@main/data/TabGroupStore.js'
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
    const h = await harness(['t1'])
    expect(() => h.controller.create({ tabIds: ['gone', 'also-gone'] })).toThrow()
    expect(h.controller.groups()).toEqual([])
    await h.cleanup()
  })

  it('refuses to add an unknown tab to an existing group', async () => {
    const h = await harness(['t1', 't2'])
    const group = h.controller.create({ tabIds: ['t1'] })
    expect(() => h.controller.addTab(group.id, 'gone')).toThrow()
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
