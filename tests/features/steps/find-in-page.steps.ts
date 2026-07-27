import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { findBarPresentation } from '@shared/find/bar.js'
import {
  FIND_STOP_ACTION,
  acceptsFindResult,
  findStep,
  withFindResult,
  type FindPageAction,
  type FindRequest
} from '@shared/find/session.js'
import { findWording } from '@shared/find/status.js'
import { endsFindSession } from '@shared/find/wire.js'
import type { FindBarPresentation } from '@shared/overlay/surface.js'
import type { Rect } from '@shared/ui/anchor.js'
import { findSession, scope } from './world.js'

/**
 * Steps for `find-in-page.feature`.
 *
 * The find state machine is driven directly. Nothing here holds a page: a request goes in,
 * a session and a list of page actions come out, and the scenarios assert on those — which
 * is the only way "typing restarts, stepping advances" can be checked at all, because both
 * are the same Electron call with one option flipped and neither produces anything visible
 * to look at.
 *
 * The one piece of bookkeeping the steps keep is the number Electron would have given the
 * search in flight. That is data `FindController` also keeps; the rule about what to do with
 * it is `acceptsFindResult`, and that is called rather than restated.
 *
 * Not expressible here: which tile the shortcut opens over. That decision reads the window's
 * active tile and lives in `FindController`, so it needs a window to have tiles at all.
 */

/** Two tiles side by side in a 1440 by 900 window, below an 88 pixel chrome inset. */
const DEFAULT_TILE_WIDTH = 716

function tileWidth(state: unknown): number {
  const stored = scope(state).scratch['tileWidth']
  return typeof stored === 'number' ? stored : DEFAULT_TILE_WIDTH
}

function tileRect(state: unknown, index: number): Rect {
  const width = tileWidth(state)
  return { x: index * (width + 8), y: 88, width, height: 812 }
}

/** Tile 0 holds `tab-1`, tile 1 holds `tab-2`. The bar names a tab; the user sees a tile. */
function tabOfTile(index: number): string {
  return `tab-${index + 1}`
}

function tileOfTab(tabId: string): number {
  return Number(tabId.slice('tab-'.length)) - 1
}

function nextSessionId(state: unknown): string {
  const current = scope(state)
  const previous = current.scratch['findSessions']
  const next = (typeof previous === 'number' ? previous : 0) + 1
  current.scratch['findSessions'] = next
  return `find-${next}`
}

function run(state: unknown, request: FindRequest): void {
  const current = scope(state)
  const result = findStep({
    current: current.find,
    remembered: current.findRemembered,
    request
  })
  current.find = result.session
  current.findActions = [...result.actions]
  // The query outlives the bar on purpose; see `FindStepInput.remembered`.
  if (result.session !== null) current.findRemembered = result.session.query
  for (const action of result.actions) {
    // Electron numbers every search and echoes the number back. A clear is not a search.
    if (action.do !== 'clear') current.findRequestId += 1
  }
}

function actions(state: unknown): FindPageAction[] {
  return scope(state).findActions
}

function presentation(state: unknown): FindBarPresentation | null {
  const session = findSession(state)
  const detached = scope(state).scratch['tabLostItsTile'] === true
  const tile = tileOfTab(session.tabId)
  return findBarPresentation({
    session,
    tileIndex: detached ? null : tile,
    tileRect: tileRect(state, tile)
  })
}

function wording(state: unknown): string {
  const session = findSession(state)
  return findWording(session).say
}

// --- given -------------------------------------------------------------------

Given('the find bar is open on the page in tile {int}', (state: unknown, tile: number) => {
  run(state, { ask: 'open', sessionId: nextSessionId(state), tabId: tabOfTile(tile) })
})

Given('each tile is {int} pixels wide', (state: unknown, width: number) => {
  scope(state).scratch['tileWidth'] = width
})

// --- when --------------------------------------------------------------------

When('I type {string} into the find bar', (state: unknown, query: string) => {
  run(state, { ask: 'query', tabId: findSession(state).tabId, query })
})

When('I clear the search field', (state: unknown) => {
  run(state, { ask: 'query', tabId: findSession(state).tabId, query: '' })
})

When('I ask for the next match', (state: unknown) => {
  run(state, { ask: 'step', tabId: findSession(state).tabId, forward: true })
})

When('I ask for the previous match', (state: unknown) => {
  run(state, { ask: 'step', tabId: findSession(state).tabId, forward: false })
})

When('the page navigates to another document', (state: unknown) => {
  run(state, { ask: 'invalidated', tabId: findSession(state).tabId })
})

When('the page finishes loading', (state: unknown) => {
  run(state, { ask: 'settled', tabId: findSession(state).tabId })
})

When('the find bar goes away', (state: unknown) => {
  // Escape, a resize, a permission prompt taking the layer, the window closing: one path out.
  run(state, { ask: 'close', tabId: findSession(state).tabId })
})

When('I press the find shortcut for the page in tile {int}', (state: unknown, tile: number) => {
  run(state, { ask: 'open', sessionId: nextSessionId(state), tabId: tabOfTile(tile) })
})

When(
  'a keystroke arrives from a bar shown for the page in tile {int}',
  (state: unknown, tile: number) => {
    // A message naming a tab that is not the one being searched decides nothing.
    run(state, { ask: 'query', tabId: tabOfTile(tile), query: 'something else' })
  }
)

When(
  'the page reports {int} matches, at match {int}',
  (state: unknown, matches: number, activeMatch: number) => {
    const current = scope(state)
    const session = findSession(state)
    // The answer to the search in flight, which is the ordinary case.
    if (!acceptsFindResult(current.findRequestId, current.findRequestId)) return
    current.find = withFindResult(session, { matches, activeMatch })
    current.findActions = []
  }
)

When(
  'the page answers the search before last with {int} matches',
  (state: unknown, matches: number) => {
    const current = scope(state)
    const session = findSession(state)
    const stale = current.findRequestId - 1
    current.findActions = []
    if (!acceptsFindResult(current.findRequestId, stale)) return
    current.find = withFindResult(session, { matches, activeMatch: 1 })
  }
)

When('the page reports the navigation {string}', (state: unknown, navigation: string) => {
  const payloads: Readonly<Record<string, { isMainFrame: boolean; isSameDocument: boolean }>> = {
    'a new document in the main frame': { isMainFrame: true, isSameDocument: false },
    'a fragment link on the same page': { isMainFrame: true, isSameDocument: true },
    'a subframe loading': { isMainFrame: false, isSameDocument: false }
  }
  const payload = payloads[navigation]
  if (payload === undefined) throw new Error(`no such navigation in this scenario: ${navigation}`)
  scope(state).findActions = []
  if (!endsFindSession(payload)) return
  run(state, { ask: 'invalidated', tabId: findSession(state).tabId })
})

When('the searched tab loses its tile', (state: unknown) => {
  scope(state).scratch['tabLostItsTile'] = true
})

// --- then --------------------------------------------------------------------

Then(
  'the page in tile {int} is searched for {string} from the top',
  (state: unknown, tile: number, query: string) => {
    expect(actions(state)).toContainEqual({
      do: 'restart',
      tabId: tabOfTile(tile),
      query,
      forward: true
    })
  }
)

Then('the page in tile {int} is not stepped to another match', (state: unknown, tile: number) => {
  const stepped = actions(state).filter(
    (action) => action.do === 'advance' && action.tabId === tabOfTile(tile)
  )
  expect(stepped, 'an advance walks a search the page is no longer running').toEqual([])
})

Then('the page in tile {int} is stepped to the next match', (state: unknown, tile: number) => {
  expect(actions(state)).toContainEqual({
    do: 'advance',
    tabId: tabOfTile(tile),
    query: findSession(state).query,
    forward: true
  })
})

Then('the page in tile {int} is told to take its highlight off', (state: unknown, tile: number) => {
  expect(actions(state)).toContainEqual({ do: 'clear', tabId: tabOfTile(tile) })
})

Then('nothing is asked of any page', (state: unknown) => {
  expect(actions(state)).toEqual([])
})

Then('the highlight is taken off rather than left behind as a selection', () => {
  /*
    `keepSelection` would leave the match highlighted on the page with the bar that explained
    it gone, and `activateSelection` would click it — on a match inside a link, closing the bar
    would navigate. Only `clearSelection` means "the bar is gone".
  */
  expect(FIND_STOP_ACTION).toBe('clearSelection')
})

Then(
  'the page in tile {int} is told to take its highlight off before the page in tile {int} is searched',
  (state: unknown, cleared: number, searched: number) => {
    const order = actions(state)
    const clearAt = order.findIndex(
      (action) => action.do === 'clear' && action.tabId === tabOfTile(cleared)
    )
    const searchAt = order.findIndex(
      (action) => action.do === 'restart' && action.tabId === tabOfTile(searched)
    )
    expect(clearAt, `the page in tile ${cleared} was never cleared`).toBeGreaterThanOrEqual(0)
    expect(searchAt, `the page in tile ${searched} was never searched`).toBeGreaterThanOrEqual(0)
    // Two calls on two different pages: the wrong order leaves the first page marked for ever.
    expect(clearAt).toBeLessThan(searchAt)
  }
)

Then('the find bar is gone', (state: unknown) => {
  expect(scope(state).find, 'the bar is still up').toBeNull()
})

Then('the bar is still searching the page in tile {int}', (state: unknown, tile: number) => {
  expect(findSession(state).tabId).toBe(tabOfTile(tile))
})

Then('the search is over', (state: unknown) => {
  expect(findSession(state).scoped).toBe(false)
})

Then('the search is running', (state: unknown) => {
  expect(findSession(state).scoped).toBe(true)
})

Then('the bar says it is still searching', (state: unknown) => {
  expect(wording(state)).toBe('searching')
})

Then('the bar says there are no matches', (state: unknown) => {
  expect(wording(state)).toBe('no-matches')
})

Then('the bar says there is one match', (state: unknown) => {
  expect(wording(state)).toBe('one-match')
})

Then('the bar says nothing about a count', (state: unknown) => {
  expect(wording(state)).toBe('nothing')
})

Then('the bar shows match {int} of {int}', (state: unknown, active: number, total: number) => {
  expect(findWording(findSession(state))).toEqual({ say: 'ordinal', active, total })
})

Then('the find bar sits inside tile {int}', (state: unknown, tile: number) => {
  const bar = presentation(state)
  expect(bar, 'there is no find bar to place').not.toBeNull()
  if (bar === null) return
  const rect = tileRect(state, tile)
  expect(bar.tileIndex).toBe(tile)
  expect(bar.bounds.x, 'the bar starts left of its tile').toBeGreaterThanOrEqual(rect.x)
  expect(bar.bounds.x + bar.bounds.width, 'the bar reaches over its neighbour').toBeLessThanOrEqual(
    rect.x + rect.width
  )
  expect(bar.bounds.y).toBeGreaterThanOrEqual(rect.y)
  expect(bar.bounds.y + bar.bounds.height).toBeLessThanOrEqual(rect.y + rect.height)
})

Then('there is no bar over the page', (state: unknown) => {
  expect(presentation(state), 'a bar over a page nobody can see counts invisible matches').toBeNull()
})
