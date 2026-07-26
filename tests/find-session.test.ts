import { describe, expect, it } from 'vitest'
import {
  FIND_STOP_ACTION,
  acceptsFindResult,
  findCountChanged,
  findStep,
  normaliseFindResult,
  withFindResult,
  type FindSession
} from '@shared/find/session.js'
import { findWording } from '@shared/find/status.js'
import {
  FIND_BAR_HEIGHT,
  FIND_BAR_INSET,
  FIND_BAR_WIDTH,
  findBarBounds,
  findBarPresentation
} from '@shared/find/bar.js'
import { endsFindSession, findResultPayload } from '@shared/find/wire.js'

/**
 * Find in page, without a browser.
 *
 * Everything here is a rule that fails quietly when it is wrong. A changed query sent as an advance
 * walks to the next occurrence of the *previous* search and shows a count that belongs to it; a
 * session left running keeps a highlight on a page after the bar is gone; "0 of 0" is a count offered
 * where there is nothing to count. None of the three throws, and none of them is visible in a DOM
 * snapshot — which is why the decisions are in a pure module and checked here rather than by driving
 * a window.
 */

function session(overrides: Partial<FindSession> = {}): FindSession {
  return {
    sessionId: 'find-1',
    tabId: 'tab-1',
    query: 'needle',
    scoped: true,
    matches: 3,
    activeMatch: 2,
    ...overrides
  }
}

describe('opening the bar', () => {
  it('restores the query it was last used with', () => {
    // The commonest use of the feature is looking for the same thing again, and the commonest
    // complaint about browsers that forget is having to retype it.
    const result = findStep({
      current: null,
      remembered: 'needle',
      request: { ask: 'open', sessionId: 'find-9', tabId: 'tab-1' }
    })

    expect(result.session).toEqual({
      sessionId: 'find-9',
      tabId: 'tab-1',
      query: 'needle',
      scoped: true,
      matches: null,
      activeMatch: 0
    })
    expect(result.actions).toEqual([
      { do: 'restart', tabId: 'tab-1', query: 'needle', forward: true }
    ])
  })

  it('searches nothing when there is nothing remembered', () => {
    // Electron throws on an empty search string, so "open with no query" has to be a bar with no
    // search rather than a search for "".
    const result = findStep({
      current: null,
      remembered: '',
      request: { ask: 'open', sessionId: 'find-1', tabId: 'tab-1' }
    })

    expect(result.actions).toEqual([])
    expect(result.session?.scoped).toBe(false)
  })

  it('re-selects rather than doing nothing when the bar is already up for that tile', () => {
    /*
      Pressing the shortcut again means "replace what I was looking for". A new session id is what
      tells the surface to put the caret back and select the term; without it the second press would
      be indistinguishable from a keystroke that missed.
    */
    const result = findStep({
      current: session({ sessionId: 'find-1' }),
      remembered: 'needle',
      request: { ask: 'open', sessionId: 'find-2', tabId: 'tab-1' }
    })

    expect(result.session?.sessionId).toBe('find-2')
    expect(result.actions).toEqual([
      { do: 'restart', tabId: 'tab-1', query: 'needle', forward: true }
    ])
  })

  it('clears the tile it is leaving before searching the one it moves to', () => {
    /*
      The order is the point, and so is the fact that there are two calls. Nothing else will ever stop
      the find session on the tile being left — the bar that owned it is now somewhere else — so
      without the first action that page keeps its highlight for the rest of its life.
    */
    const result = findStep({
      current: session({ tabId: 'tab-1' }),
      remembered: 'needle',
      request: { ask: 'open', sessionId: 'find-2', tabId: 'tab-2' }
    })

    expect(result.actions).toEqual([
      { do: 'clear', tabId: 'tab-1' },
      { do: 'restart', tabId: 'tab-2', query: 'needle', forward: true }
    ])
    expect(result.session?.tabId).toBe('tab-2')
  })
})

describe('a query changed mid-search', () => {
  it('restarts the search rather than advancing it', () => {
    /*
      The rule this whole module exists for. Typing the next letter of a word is not "find next":
      sent as an advance, Chromium steps to the next occurrence of a search that is no longer the one
      on screen, so the highlight lands on a match nobody asked for and the count belongs to the old
      text. Nothing throws and the bar looks entirely normal.
    */
    const result = findStep({
      current: session({ query: 'need', matches: 9, activeMatch: 4 }),
      remembered: 'need',
      request: { ask: 'query', tabId: 'tab-1', query: 'needl' }
    })

    expect(result.actions).toEqual([
      { do: 'restart', tabId: 'tab-1', query: 'needl', forward: true }
    ])
  })

  it('drops the count it had, because that count was for the old text', () => {
    const result = findStep({
      current: session({ query: 'need', matches: 9, activeMatch: 4 }),
      remembered: 'need',
      request: { ask: 'query', tabId: 'tab-1', query: 'needl' }
    })

    // `null`, not `0`: one frame of "no matches" for a page full of them is the flicker this avoids.
    expect(result.session?.matches).toBeNull()
    expect(result.session?.activeMatch).toBe(0)
  })

  it('keeps the same session, so the caret is not thrown out of the field', () => {
    const result = findStep({
      current: session({ sessionId: 'find-1', query: 'need' }),
      remembered: 'need',
      request: { ask: 'query', tabId: 'tab-1', query: 'needl' }
    })
    expect(result.session?.sessionId).toBe('find-1')
  })

  it('does not restart for the same text arriving again', () => {
    // The bar echoes its field on every change and a re-render can repeat it unchanged. Restarted for
    // that, the active match would jump back to the top of the page for a keystroke that changed
    // nothing.
    const current = session({ query: 'needle', activeMatch: 3 })
    const result = findStep({
      current,
      remembered: 'needle',
      request: { ask: 'query', tabId: 'tab-1', query: 'needle' }
    })

    expect(result.actions).toEqual([])
    expect(result.session).toBe(current)
  })

  it('stops the search when the field is emptied', () => {
    /*
      Two reasons at once. Electron throws on an empty search string, so searching for "" is not an
      option; and the highlight has to go with the text, or deleting the query would leave the last
      match marked on the page with an empty field above it.
    */
    const result = findStep({
      current: session(),
      remembered: 'needle',
      request: { ask: 'query', tabId: 'tab-1', query: '' }
    })

    expect(result.actions).toEqual([{ do: 'clear', tabId: 'tab-1' }])
    expect(result.session).toEqual({
      sessionId: 'find-1',
      tabId: 'tab-1',
      query: '',
      scoped: false,
      matches: null,
      activeMatch: 0
    })
  })
})

describe('walking through matches', () => {
  it('advances inside the session already running', () => {
    const result = findStep({
      current: session(),
      remembered: 'needle',
      request: { ask: 'step', tabId: 'tab-1', forward: true }
    })

    expect(result.actions).toEqual([
      { do: 'advance', tabId: 'tab-1', query: 'needle', forward: true }
    ])
  })

  it('walks backwards when asked to', () => {
    const result = findStep({
      current: session(),
      remembered: 'needle',
      request: { ask: 'step', tabId: 'tab-1', forward: false }
    })

    expect(result.actions).toEqual([
      { do: 'advance', tabId: 'tab-1', query: 'needle', forward: false }
    ])
  })

  it('leaves the position alone until the page reports the new one', () => {
    // Guessing the ordinal here would show a position the page has not moved to yet, and it would be
    // wrong at both ends of the document, where the search wraps.
    const current = session({ activeMatch: 2 })
    const result = findStep({
      current,
      remembered: 'needle',
      request: { ask: 'step', tabId: 'tab-1', forward: true }
    })
    expect(result.session).toBe(current)
  })

  it('does nothing when there is no query to walk through', () => {
    const current = session({ query: '', scoped: false, matches: null, activeMatch: 0 })
    const result = findStep({
      current,
      remembered: '',
      request: { ask: 'step', tabId: 'tab-1', forward: true }
    })

    expect(result.actions).toEqual([])
    expect(result.session).toBe(current)
  })

  it('restarts instead of advancing when no session is running on the page', () => {
    /*
      The other half of restart-versus-advance, and the one that only a navigation produces: the query
      survived the page load, the find session in the previous document did not. An advance here asks
      Chromium to step through a search that was never started.
    */
    const result = findStep({
      current: session({ scoped: false, matches: null, activeMatch: 0 }),
      remembered: 'needle',
      request: { ask: 'step', tabId: 'tab-1', forward: false }
    })

    expect(result.actions).toEqual([
      { do: 'restart', tabId: 'tab-1', query: 'needle', forward: false }
    ])
    expect(result.session?.scoped).toBe(true)
  })
})

describe('the page navigating under an open bar', () => {
  it('records that the session is gone without touching the page', () => {
    // There is nothing to stop: the session went with the document. Only the fact is recorded, so the
    // next request restarts rather than advancing into a page that has never been searched.
    const result = findStep({
      current: session(),
      remembered: 'needle',
      request: { ask: 'invalidated', tabId: 'tab-1' }
    })

    expect(result.actions).toEqual([])
    expect(result.session).toEqual({
      sessionId: 'find-1',
      tabId: 'tab-1',
      query: 'needle',
      scoped: false,
      matches: null,
      activeMatch: 0
    })
  })

  it('searches the new document once it has finished loading', () => {
    const result = findStep({
      current: session({ scoped: false, matches: null, activeMatch: 0 }),
      remembered: 'needle',
      request: { ask: 'settled', tabId: 'tab-1' }
    })

    expect(result.actions).toEqual([
      { do: 'restart', tabId: 'tab-1', query: 'needle', forward: true }
    ])
  })

  it('leaves a running search alone when the page merely stops loading', () => {
    // `did-stop-loading` fires for far more than a navigation finishing. Restarting on each one would
    // drag the active match back to the first hit whenever the page finished fetching anything.
    const current = session({ activeMatch: 5 })
    const result = findStep({
      current,
      remembered: 'needle',
      request: { ask: 'settled', tabId: 'tab-1' }
    })

    expect(result.actions).toEqual([])
    expect(result.session).toBe(current)
  })

  it('has nothing to pick up again when the field is empty', () => {
    const current = session({ query: '', scoped: false, matches: null, activeMatch: 0 })
    const result = findStep({
      current,
      remembered: '',
      request: { ask: 'settled', tabId: 'tab-1' }
    })

    expect(result.actions).toEqual([])
    expect(result.session).toBe(current)
  })
})

describe('closing the bar', () => {
  it('takes the highlight off the page rather than only removing the bar', () => {
    /*
      The failure this prevents: `findInPage` marks its match in the document and only
      `stopFindInPage` unmarks it. A bar that closed without this leaves a block of highlighted text
      on the page with nothing on screen to explain it and no obvious way to remove it.
    */
    const result = findStep({
      current: session(),
      remembered: 'needle',
      request: { ask: 'close', tabId: 'tab-1' }
    })

    expect(result.actions).toEqual([{ do: 'clear', tabId: 'tab-1' }])
    expect(result.session).toBeNull()
  })

  it("clears the selection rather than keeping it or activating it", () => {
    /*
      `keepSelection` translates the match into a normal selection, which means the highlight *stays*
      — the polite-sounding option, and the one that leaves a page permanently marked.
      `activateSelection` focuses and clicks the match, so closing a find bar on a page whose match
      sits inside a link would navigate.
    */
    expect(FIND_STOP_ACTION).toBe('clearSelection')
  })
})

describe('a message from a bar that is no longer the one on screen', () => {
  it('decides nothing when it names another tab', () => {
    /*
      Reachable every time the layer changes under an in-flight message: the bar moves to another
      tile, a prompt displaces it, the tab is reassigned. Resolved against whatever is current
      instead, that keystroke would search a page the user is not looking at — and highlight it there.
    */
    const current = session({ tabId: 'tab-1' })
    for (const request of [
      { ask: 'query', tabId: 'tab-2', query: 'other' },
      { ask: 'step', tabId: 'tab-2', forward: true },
      { ask: 'close', tabId: 'tab-2' },
      { ask: 'invalidated', tabId: 'tab-2' },
      { ask: 'settled', tabId: 'tab-2' }
    ] as const) {
      const result = findStep({ current, remembered: 'needle', request })
      expect(result.actions, request.ask).toEqual([])
      expect(result.session, request.ask).toBe(current)
    }
  })

  it('decides nothing when there is no bar at all', () => {
    const result = findStep({
      current: null,
      remembered: '',
      request: { ask: 'query', tabId: 'tab-1', query: 'needle' }
    })

    expect(result.actions).toEqual([])
    expect(result.session).toBeNull()
  })
})

describe('results from the page', () => {
  it('folds a count into the session', () => {
    const next = withFindResult(session({ matches: null, activeMatch: 0 }), {
      matches: 7,
      activeMatch: 3
    })
    expect(next.matches).toBe(7)
    expect(next.activeMatch).toBe(3)
  })

  it('drops a result for a session that is no longer running', () => {
    // The numbers describe a document or a query that has moved on, and showing them would be a count
    // for a search nobody is doing.
    const current = session({ scoped: false, matches: null, activeMatch: 0 })
    expect(withFindResult(current, { matches: 7, activeMatch: 3 })).toBe(current)
  })

  it('never lets the position exceed the total', () => {
    // Chromium's count grows as it walks the document, so an ordinal can arrive larger than the total
    // reported alongside it. Rendered raw, the bar says "7 of 3".
    expect(normaliseFindResult({ matches: 3, activeMatch: 7 })).toEqual({
      matches: 3,
      activeMatch: 3
    })
  })

  it('reads a not-yet-highlighted match as no position', () => {
    // `-1` is what Chromium sends while a session is still being scoped.
    expect(normaliseFindResult({ matches: 4, activeMatch: -1 })).toEqual({
      matches: 4,
      activeMatch: 0
    })
  })

  it('refuses a negative total', () => {
    expect(normaliseFindResult({ matches: -2, activeMatch: 0 })).toEqual({
      matches: 0,
      activeMatch: 0
    })
  })

  it('takes whole numbers only', () => {
    expect(normaliseFindResult({ matches: 3.7, activeMatch: 2.9 })).toEqual({
      matches: 3,
      activeMatch: 2
    })
  })
})

describe('whether a result changed anything', () => {
  it('notices a new total', () => {
    expect(findCountChanged(session({ matches: 3 }), session({ matches: 4 }))).toBe(true)
  })

  it('notices a new position', () => {
    expect(findCountChanged(session({ activeMatch: 1 }), session({ activeMatch: 2 }))).toBe(true)
  })

  it('says no to the repeat Chromium sends as its final update', () => {
    // Presenting again for those costs a `focus()` on the overlay layer each time, which is a
    // keystroke's worth of interference for no change on screen.
    expect(findCountChanged(session(), session())).toBe(false)
  })
})

describe('matching an answer to the question that asked for it', () => {
  it('accepts the answer to the search in flight', () => {
    expect(acceptsFindResult(4, 4)).toBe(true)
  })

  it('drops an answer to a search that has been superseded', () => {
    // Type "abc" and the answers for "ab" are already on their way, carrying a count for text that is
    // no longer in the field. Without the id the bar would settle on whichever arrived last.
    expect(acceptsFindResult(5, 4)).toBe(false)
  })

  it('drops an answer when nothing was asked', () => {
    // A result arriving after the session was cleared belongs to nobody.
    expect(acceptsFindResult(null, 4)).toBe(false)
  })
})

describe('wording the count', () => {
  it('says nothing at all while the field is empty', () => {
    expect(findWording({ query: '', matches: null, activeMatch: 0 })).toEqual({ say: 'nothing' })
  })

  it('says a search is running rather than showing a zero', () => {
    /*
      The distinction that stops the flicker. Treated as zero, a search in flight would announce "no
      matches" on every keystroke and correct itself a moment later — so a page full of hits reads as
      empty while it is being counted.
    */
    expect(findWording({ query: 'needle', matches: null, activeMatch: 0 })).toEqual({
      say: 'searching'
    })
  })

  it('says there are none rather than "0 of 0"', () => {
    // A person who has just mistyped a word needs to be told there is nothing there, not shown a
    // fraction whose numerator happens to be zero.
    expect(findWording({ query: 'needle', matches: 0, activeMatch: 0 })).toEqual({
      say: 'no-matches'
    })
  })

  it('states a single match rather than giving it a position', () => {
    // "1 of 1" offers a count to walk through where there is nothing to walk through.
    expect(findWording({ query: 'needle', matches: 1, activeMatch: 1 })).toEqual({
      say: 'one-match'
    })
  })

  it('gives a position among many', () => {
    expect(findWording({ query: 'needle', matches: 12, activeMatch: 3 })).toEqual({
      say: 'ordinal',
      active: 3,
      total: 12
    })
  })
})

describe('where the bar sits', () => {
  const tile = { x: 720, y: 88, width: 720, height: 812 }

  it('sits in the top-right corner of the tile it searches', () => {
    expect(findBarBounds(tile)).toEqual({
      x: 720 + 720 - FIND_BAR_WIDTH - FIND_BAR_INSET,
      y: 88 + FIND_BAR_INSET,
      width: FIND_BAR_WIDTH,
      height: FIND_BAR_HEIGHT
    })
  })

  it('stays inside its own tile when the tile is narrower than the bar', () => {
    /*
      The one thing a per-tile surface may never do is reach into its neighbour. Clamped to the full
      tile width rather than the inset one, a narrow tile would put the bar's left edge over the tile
      beside it — and the layer swallows pointer events, so that neighbour would lose clicks to a bar
      that is not its own.
    */
    const narrow = { x: 100, y: 0, width: 200, height: 400 }
    const bounds = findBarBounds(narrow)
    expect(bounds.x).toBeGreaterThanOrEqual(narrow.x)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(narrow.x + narrow.width)
    expect(bounds.width).toBe(200 - FIND_BAR_INSET * 2)
  })

  it('shrinks to fit a tile shorter than the bar', () => {
    const short = { x: 0, y: 0, width: 800, height: 30 }
    expect(findBarBounds(short).height).toBe(30 - FIND_BAR_INSET * 2)
  })

  it('refuses a tile too small to hold anything', () => {
    // A grid computed before the first paint produces these. Presented anyway it would be a
    // zero-sized surface holding the layer against everything else.
    expect(
      findBarPresentation({
        session: session(),
        tileIndex: 0,
        tileRect: { x: 0, y: 0, width: 4, height: 400 }
      })
    ).toBeNull()
    expect(
      findBarPresentation({
        session: session(),
        tileIndex: 0,
        tileRect: { x: 0, y: 0, width: 400, height: 4 }
      })
    ).toBeNull()
  })

  it('refuses a tab that is off screen', () => {
    // A bar over a page that is not in the grid would be counting matches in something invisible.
    expect(findBarPresentation({ session: session(), tileIndex: null, tileRect: tile })).toBeNull()
  })

  it('carries the search, the tab and the tile it belongs to', () => {
    expect(findBarPresentation({ session: session(), tileIndex: 1, tileRect: tile })).toEqual({
      kind: 'find-bar',
      sessionId: 'find-1',
      tileIndex: 1,
      bounds: findBarBounds(tile),
      tabId: 'tab-1',
      query: 'needle',
      matches: 3,
      activeMatch: 2
    })
  })
})

describe("reading Chromium's own payloads", () => {
  it('reads a find result', () => {
    expect(
      findResultPayload({
        requestId: 4,
        activeMatchOrdinal: 2,
        matches: 9,
        selectionArea: {},
        finalUpdate: true
      })
    ).toEqual({ requestId: 4, matches: 9, activeMatch: 2 })
  })

  it('refuses anything that is not one', () => {
    for (const payload of [
      undefined,
      null,
      7,
      {},
      { requestId: 1, matches: 2 },
      { requestId: 1, activeMatchOrdinal: 0 },
      { matches: 2, activeMatchOrdinal: 0 },
      { requestId: Number.NaN, matches: 2, activeMatchOrdinal: 0 }
    ]) {
      expect(findResultPayload(payload), JSON.stringify(payload ?? null)).toBeNull()
    }
  })

  it('treats a main-frame document change as the end of the session', () => {
    expect(endsFindSession({ isMainFrame: true, isSameDocument: false })).toBe(true)
  })

  it('ignores a subframe navigating', () => {
    /*
      An advertisement iframe reloading itself does not end the main document's find session. Read as
      one, the user's position in the search would reset every few seconds on exactly the pages where
      searching is most needed.
    */
    expect(endsFindSession({ isMainFrame: false, isSameDocument: false })).toBe(false)
  })

  it('ignores a fragment link and a pushState', () => {
    expect(endsFindSession({ isMainFrame: true, isSameDocument: true })).toBe(false)
  })

  it('keeps believing the session is alive for a payload it cannot read', () => {
    // The safe direction: a stale flag costs one wrong advance, whereas invalidating on everything
    // unreadable would restart the search continuously.
    expect(endsFindSession(null)).toBe(false)
    expect(endsFindSession('did-start-navigation')).toBe(false)
    expect(endsFindSession({})).toBe(false)
  })
})
