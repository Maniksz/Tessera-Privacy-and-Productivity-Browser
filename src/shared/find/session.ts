/**
 * Find in page, as the decisions that need no browser (spec 2, spec 9).
 *
 * ## Why any of this is a state machine at all
 *
 * `webContents.findInPage` is not a query that returns matches. It is a *session*: Chromium keeps
 * a live find state per document, the call either opens a new one or steps through the one already
 * running, results arrive later and repeatedly on a separate event, and the session has to be torn
 * down explicitly or the last match stays highlighted on the page after the bar is gone. Every one
 * of those is a rule somebody can get wrong, and every one of them is invisible in review:
 *
 *  - **A changed query must restart, never advance.** Typing the next letter of a word is not
 *    "find next". Sent as an advance, Chromium walks to the next occurrence of a search that is no
 *    longer the one on screen — the count belongs to the old text and the highlight to a match the
 *    user never asked for. The bar would look completely normal while doing it.
 *  - **An advance is only valid inside a running session.** After a navigation the previous
 *    session died with the previous document, so the first request against the new page has to be
 *    a fresh one. `scoped` is what remembers that, and it is why a navigation is a *request* here
 *    rather than something the core handles quietly.
 *  - **A message from the bar names the tab it was shown for.** The bar searches one tile's page,
 *    and in a split layout the active tile can change while the bar is up. Resolved at message
 *    time instead, a keystroke would search whichever page happened to be active — the same class
 *    of mistake as a tile navigation bar acting on the active tab.
 *
 * Pure, so all of it can be tested without a window, and so the one file that touches Electron is
 * left with no decisions in it.
 */

/**
 * How a find session ends, in Electron's vocabulary.
 *
 * Restated here rather than imported from Electron so this module stays platform-free; the three
 * names are the argument `stopFindInPage` takes.
 */
export type FindStopAction = 'clearSelection' | 'keepSelection' | 'activateSelection'

/**
 * The only way this browser ends a find session — and the choice is not obvious.
 *
 * Electron offers three, and two of them are wrong here in ways that look right:
 *
 * `keepSelection` "translates the selection into a normal selection", which means **the match stays
 *   highlighted on the page**. It reads like the polite option — the user might want to copy what
 *   they found — and its effect is a page carrying a blue block of text with the bar that explained
 *   it gone, and no affordance anywhere for getting rid of it. This is the trap: nothing about the
 *   name suggests a highlight left behind for ever, and no test of the find bar itself would notice.
 * `activateSelection` focuses *and clicks* the match. Closing a find bar must never activate what it
 *   was pointing at; on a page whose match sits inside a link, Escape would navigate.
 * `clearSelection` takes the highlight off and touches nothing else, which is exactly what "the bar
 *   is gone" should mean.
 *
 * A constant rather than an argument, because there is no caller that should be allowed to choose.
 */
export const FIND_STOP_ACTION: FindStopAction = 'clearSelection'

/** The search that is running, as the core remembers it between messages. */
export interface FindSession {
  /**
   * Identity of this search.
   *
   * Changes when the bar opens and *never* as counts arrive, which is what lets the surface tell
   * "a new search" from "the same search, one more result". Without it the bar would re-focus and
   * re-select its own field on every keystroke's answer, so typing would erase itself.
   */
  readonly sessionId: string
  /** The tab searched, fixed when the bar opened. Never empty. */
  readonly tabId: string
  readonly query: string
  /**
   * True while a find session is actually running on the page for `query`.
   *
   * False before the first search and after a navigation threw the previous document's session
   * away. The single fact that decides restart-versus-advance.
   */
  readonly scoped: boolean
  /** Total matches, or `null` while the page has not answered yet. */
  readonly matches: number | null
  /** One-based position of the highlighted match; `0` when nothing is highlighted. */
  readonly activeMatch: number
}

/**
 * Everything that can happen to a find bar.
 *
 * `open` carries the identity of the search it starts, because a pure function may not invent one.
 * Every other form carries the tab it is about, and a form whose tab is not the one being searched
 * decides nothing — see `findStep`.
 */
export type FindRequest =
  | { ask: 'open'; sessionId: string; tabId: string }
  | { ask: 'query'; tabId: string; query: string }
  | { ask: 'step'; tabId: string; forward: boolean }
  | { ask: 'close'; tabId: string }
  /** The page began loading a new document, so the session running in the old one is gone. */
  | { ask: 'invalidated'; tabId: string }
  /** The page finished loading, so a search invalidated by the navigation can run again. */
  | { ask: 'settled'; tabId: string }

/**
 * What the page has to be told, named by tab.
 *
 * `restart` and `advance` are the same Electron call with one option flipped, and they are two
 * cases here rather than a boolean so that the mapping onto that option is written down exactly
 * once — see `main/find/page-search.ts`, where the option's name means the opposite of what it
 * reads like.
 */
export type FindPageAction =
  | { do: 'restart'; tabId: string; query: string; forward: boolean }
  | { do: 'advance'; tabId: string; query: string; forward: boolean }
  | { do: 'clear'; tabId: string }

/** The two actions that start a search rather than end one; see `findInPageOptions`. */
export type FindSearchAction = Extract<FindPageAction, { do: 'restart' | 'advance' }>

export interface FindStepResult {
  /** The session after this request, or `null` when the bar should go. */
  session: FindSession | null
  /**
   * In order, and occasionally two.
   *
   * Moving the bar from one tile to another has to clear the page being left *before* scoping the
   * page being taken up: one call each, on two different pages, and the wrong order leaves the
   * first page marked.
   */
  actions: FindPageAction[]
}

export interface FindStepInput {
  current: FindSession | null
  /**
   * The query the bar reopens with.
   *
   * Kept across a closed bar on purpose: pressing the shortcut again to search for the same thing
   * is the commonest way the feature is used, and retyping it is the commonest complaint about
   * browsers that forget.
   */
  remembered: string
  request: FindRequest
}

/**
 * The whole decision, as one pure step.
 *
 * Total: every request has an answer, and a request that changes nothing returns the session it was
 * given with no actions rather than a special case the caller has to recognise.
 */
export function findStep(input: FindStepInput): FindStepResult {
  const { current, request } = input

  if (request.ask === 'open') return opened(current, input.remembered, request)

  /*
    A message from a bar that is no longer the one on screen decides nothing.

    The bar sends its own tab id with everything, so this is not defensive padding: it is reachable
    every time the layer changes under an in-flight message — a permission prompt displaces the bar
    as the user types, the bar moves to another tile, the tab is reassigned. Resolved against
    whatever is current instead, that keystroke would search a page the user was not looking at.
  */
  if (current?.tabId !== request.tabId) return unchanged(current)

  switch (request.ask) {
    case 'query':
      return queried(current, request.query)
    case 'step':
      return stepped(current, request.forward)
    case 'invalidated':
      /*
        No page action: the session did not need stopping, it stopped when the document went. Only
        the *fact* is recorded, so the next request restarts instead of advancing into a page that
        has never been searched.
      */
      return { session: { ...current, scoped: false, matches: null, activeMatch: 0 }, actions: [] }
    case 'settled':
      return settled(current)
    case 'close':
      // The highlight is the point. A bar that closed without this leaves the last match marked on
      // the page with nothing left on screen to explain it — see `FIND_STOP_ACTION`.
      return { session: null, actions: [{ do: 'clear', tabId: current.tabId }] }
  }
}

/**
 * A result from the page, folded into the session.
 *
 * A result for a session that is no longer running is dropped: the numbers describe a document or a
 * query that has moved on, and showing them would be a count for a search nobody is doing.
 */
export function withFindResult(
  session: FindSession,
  result: { matches: number; activeMatch: number }
): FindSession {
  if (!session.scoped) return session
  const { matches, activeMatch } = normaliseFindResult(result)
  return { ...session, matches, activeMatch }
}

/**
 * Chromium's two numbers, made presentable.
 *
 * Both need it. `activeMatchOrdinal` is `-1` or `0` while a session is still being scoped and can
 * arrive larger than the total reported alongside it, because the count grows as the page is
 * walked; a bar rendering that raw says "7 of 3". Clamped here rather than at the point it is
 * displayed, so the presentation never carries a pair that cannot be true.
 */
export function normaliseFindResult(result: { matches: number; activeMatch: number }): {
  matches: number
  activeMatch: number
} {
  const matches = Math.max(0, Math.trunc(result.matches))
  return {
    matches,
    activeMatch: Math.min(Math.max(0, Math.trunc(result.activeMatch)), matches)
  }
}

/**
 * Whether a result changed anything the bar shows.
 *
 * Chromium sends several updates per search as it scopes the document, and repeats itself: the
 * final update commonly carries the same pair as the one before it. Presenting again for those
 * costs a `webContents.focus()` on the layer each time — see `takesFocus` — so the answer to "did
 * anything change" decides whether the caret is disturbed while somebody is typing.
 */
export function findCountChanged(before: FindSession, after: FindSession): boolean {
  if (before.matches !== after.matches) return true
  return before.activeMatch !== after.activeMatch
}

/**
 * Whether a result belongs to the search in flight.
 *
 * Type "ab", then "c". The results for "ab" are already on their way when "abc" is sent, and they
 * carry a count for two letters. Electron numbers every request and echoes the number back, which
 * is the only way to tell them apart — without this the bar would settle on whichever answer
 * arrived last.
 */
export function acceptsFindResult(inFlight: number | null, reported: number): boolean {
  // Nothing was asked, so nothing can be answered: a result arriving after the session was cleared.
  if (inFlight === null) return false
  return inFlight === reported
}

// --- internals -------------------------------------------------------------

function unchanged(session: FindSession | null): FindStepResult {
  return { session, actions: [] }
}

function opened(
  current: FindSession | null,
  remembered: string,
  request: { sessionId: string; tabId: string }
): FindStepResult {
  const query = current === null ? remembered : current.query
  const actions: FindPageAction[] = []
  /*
    The page being left has to be cleared, and it is not the same page as the one being searched.

    Pressing the shortcut while a bar is up in another tile moves the bar. Without this the tile
    left behind keeps its highlight for the rest of its life: nothing else will ever stop a find
    session on it, because the bar that owned it is now somewhere else.
  */
  if (current !== null && current.tabId !== request.tabId) {
    actions.push({ do: 'clear', tabId: current.tabId })
  }

  const session: FindSession = {
    sessionId: request.sessionId,
    tabId: request.tabId,
    query,
    scoped: query !== '',
    matches: null,
    activeMatch: 0
  }
  /*
    Opening searches immediately when there is something to search for — including when the bar was
    already up for this tile.

    A new session id every time is what re-selects the text in the field, which is what makes
    pressing the shortcut twice mean "replace what I was looking for" rather than nothing at all.
    Re-scoping the same query costs one call and produces a fresh count.
  */
  if (query !== '') {
    actions.push({ do: 'restart', tabId: request.tabId, query, forward: true })
  }
  return { session, actions }
}

function queried(current: FindSession, query: string): FindStepResult {
  /*
    The same text, again, is not a search.

    The bar echoes its field back on every change, and a re-render can repeat the value unchanged.
    Restarted for that, the active match would jump back to the top of the page on a keystroke that
    changed nothing.
  */
  if (query === current.query) return unchanged(current)

  if (query === '') {
    /*
      An emptied field stops the search rather than searching for nothing.

      Electron throws on an empty search string — "Must provide a non-empty search content" — so
      this is not merely tidier; sending it would raise from inside a keystroke handler. And the
      highlight has to go with the text, or deleting the query would leave the last match marked.
    */
    return {
      session: { ...current, query: '', scoped: false, matches: null, activeMatch: 0 },
      actions: [{ do: 'clear', tabId: current.tabId }]
    }
  }

  // A restart, never an advance: see the module docblock. The count is dropped to `null` rather
  // than kept, because the old number belongs to the old text and one frame of it is a lie.
  return {
    session: { ...current, query, scoped: true, matches: null, activeMatch: 0 },
    actions: [{ do: 'restart', tabId: current.tabId, query, forward: true }]
  }
}

function stepped(current: FindSession, forward: boolean): FindStepResult {
  // Nothing to walk through, so the keystroke is not an error — it is a no-op.
  if (current.query === '') return unchanged(current)

  if (!current.scoped) {
    /*
      A restart, because there is no session to advance inside.

      This is the shortcut pressed after the page navigated: the query survived, the find session in
      the previous document did not. An advance here asks Chromium to step through a search that was
      never started.
    */
    return {
      session: { ...current, scoped: true, matches: null, activeMatch: 0 },
      actions: [{ do: 'restart', tabId: current.tabId, query: current.query, forward }]
    }
  }

  // The session is untouched: the new ordinal is not known until the page answers, and guessing it
  // here would show a position the page has not moved to yet.
  return {
    session: current,
    actions: [{ do: 'advance', tabId: current.tabId, query: current.query, forward }]
  }
}

function settled(current: FindSession): FindStepResult {
  /*
    Only a search that a navigation invalidated is picked up again.

    `did-stop-loading` fires for far more than a navigation finishing, and restarting a live search
    on each one would drag the active match back to the first hit every time the page stopped
    loading something.
  */
  if (current.query === '' || current.scoped) return unchanged(current)
  return {
    session: { ...current, scoped: true, matches: null, activeMatch: 0 },
    actions: [{ do: 'restart', tabId: current.tabId, query: current.query, forward: true }]
  }
}
