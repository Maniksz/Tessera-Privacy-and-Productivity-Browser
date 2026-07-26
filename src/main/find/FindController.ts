import {
  FIND_STOP_ACTION,
  acceptsFindResult,
  findCountChanged,
  findStep,
  withFindResult,
  type FindPageAction,
  type FindRequest,
  type FindSession
} from '@shared/find/session.js'
import { findBarPresentation } from '@shared/find/bar.js'
import { endsFindSession, findResultPayload } from '@shared/find/wire.js'
import {
  mayPresentOver,
  type OverlayPresentation,
  type OverlayState
} from '@shared/overlay/surface.js'
import { findInPageOptions, type FindTarget } from './page-search.js'

/**
 * Find in page, wired to real pages (Ctrl+F, spec 9).
 *
 * ## What is here and what deliberately is not
 *
 * Every rule lives in `shared/find/session.ts` — which tab a message may affect, whether a keystroke
 * restarts or advances, what an emptied field means, when a highlight has to be taken off. What is
 * here is only what needs a window: resolving a tab, calling Chromium, subscribing to its answers,
 * and putting the bar on the overlay layer. The split is not tidiness. A find session is stateful and
 * asynchronous, and a state machine that could only be exercised by driving a browser would be a
 * state machine nobody checks.
 *
 * ## Which tile Ctrl+F searches, and why
 *
 * **The active tile's tab, resolved once, at the moment the bar opens.**
 *
 * Two candidates existed. The pointer's tile is what `TileInputController` uses, and rightly: a
 * hovering pointer, a thumb button and a trackpad swipe are all *pointer* input, and with four pages
 * on screen the hand is on the mouse over the page being read. Ctrl+F is the opposite case. The hand
 * is on the keyboard; the pointer may be parked over an unrelated tile or outside the window
 * altogether, and a find bar that opened over there — searching a page the user is not reading —
 * would be worse than no find bar at all. The active tile is also kept honest for exactly this: it
 * follows focus, because clicking into a tile makes it active (`Tab.onFocused`), so it *is* the tile
 * the keyboard is aimed at. It is the same answer the tile navigation bar's own shortcut gives.
 *
 * The second half matters as much as the first. The tab is fixed in the session and travels with
 * every message, so nothing that happens while the bar is up can move the search: the active tile
 * changing under an open bar leaves the bar searching the page it was opened for, which is the page
 * whose matches it is counting and whose highlight it will clear.
 *
 * ## Why the bar's departure is the thing that clears the highlight
 *
 * Escape is not the only way out. The window controller dismisses this layer on resize and on blur, a
 * layout change takes it down, a permission prompt displaces it, the surface's renderer can crash.
 * Each of those leaves a match highlighted on a page unless something stops the find session, and
 * none of them knows a find session exists. So the highlight is cleared from `overlayVacated` — the
 * announcement the layer already makes for surfaces whose departure is not free — and Escape simply
 * dismisses the layer like everything else. One path out, not five.
 */

/**
 * The window a find bar appears in.
 *
 * Structurally satisfied by `BrowserWindowController`, and declared as the five things this actually
 * uses rather than imported from it — the same arrangement as `PermissionHost`, and for the same
 * reason: it is the difference between "Ctrl+F searches the active tile" being a test and being a
 * claim.
 */
export interface FindHost {
  /** The tab in the active tile, or `undefined` when that tile is empty. */
  activeTab(): FindTarget | undefined
  tab(tabId: string): FindTarget | undefined
  presentOverlay(presentation: OverlayPresentation): void
  dismissOverlay(): void
  /** What is on the layer now, so a dismissal can only ever take down this feature's own surface. */
  overlayPresentation(): OverlayState
}

/** The find bar that is up in one window. */
interface LiveFind {
  session: FindSession
  /**
   * The id Electron gave the search in flight, or `null`.
   *
   * Kept so a result can be matched to the question that asked for it: typing "abc" leaves the
   * answers for "ab" still on their way, carrying a count for text that is no longer in the field.
   */
  requestId: number | null
  /** Undoes every subscription this session made on its page (spec 6). */
  release(): void
}

let sequence = 0

/** Session ids are per process and monotonic; only their distinctness is relied upon. */
export function nextFindSessionId(): string {
  sequence += 1
  return `find-${sequence}`
}

export class FindController {
  /**
   * The bar that is up, per window — at most one, because there is one overlay layer.
   *
   * A strong map, and it stays bounded because every way a bar can leave the layer ends up in
   * `overlayVacated`, which removes the entry. A window closed with a bar up arrives here as
   * `gone`.
   */
  readonly #live = new Map<FindHost, LiveFind>()

  /**
   * What the shortcut reopens a window's bar with.
   *
   * Weak on purpose. This outlives the bar — searching for the same thing again is the commonest use
   * of the feature — so a strong map would retain every window that has ever had a find bar, and with
   * it that window's tabs. Memory is the binding constraint on the machines this has to stay usable
   * on.
   */
  readonly #lastQuery = new WeakMap<FindHost, string>()

  /** Opens the bar for the active tile's tab, with the query it was last used with. */
  open(host: FindHost): void {
    /*
      Declined outright while something with a stronger claim holds the layer.

      Asked *before* anything happens, and that ordering is the point: `presentOverlay` can refuse —
      a permission prompt, a menu and a tab drag all outrank the bar — and the refusal is silent. Run
      the search first and the page would be scoped and highlighted with no bar anywhere on screen to
      explain the highlight or to take it off, because a surface that was never presented never
      departs and so is never announced. So the shortcut is simply declined, exactly as the tile bar's
      is while a prompt is up.
    */
    if (!mayPresentOver('find-bar', host.overlayPresentation())) return

    const target = host.activeTab()
    // A window whose active tile holds no tab has nothing to search, and a find bar over an empty
    // tile would be a text field whose every keystroke did nothing.
    if (target === undefined) return
    this.#run(host, { ask: 'open', sessionId: nextFindSessionId(), tabId: target.id })
  }

  /** The field changed. `tabId` is the bar's own; a stale one is ignored by `findStep`. */
  setQuery(host: FindHost, tabId: string, query: string): void {
    this.#run(host, { ask: 'query', tabId, query })
  }

  /**
   * Next or previous match.
   *
   * With no bar up this opens one instead of doing nothing, because that is what the shortcut means
   * on its own: `F3` before `Ctrl+F` should find the last thing searched for. Opening already
   * searches, and a fresh search lands on the first match — which is the next match when there is
   * nothing to advance from.
   */
  step(host: FindHost, options: { tabId?: string; forward: boolean }): void {
    const live = this.#live.get(host)
    if (live === undefined) {
      this.open(host)
      return
    }
    this.#run(host, {
      ask: 'step',
      tabId: options.tabId ?? live.session.tabId,
      forward: options.forward
    })
  }

  /**
   * A find bar left the overlay layer. Wired to `onOverlayVacancy`.
   *
   * Whatever the reason — Escape, a resize, a prompt taking the layer, a crashed surface, the window
   * closing — the bar is gone and the highlight has to go with it. The session is found by the id the
   * presentation carries, which is why `sessionId` is on the wire at all: the announcement names a
   * surface, not a window.
   */
  overlayVacated(presentation: OverlayPresentation): void {
    if (presentation.kind !== 'find-bar') return
    for (const [host, live] of this.#live) {
      if (live.session.sessionId !== presentation.sessionId) continue
      this.#run(host, { ask: 'close', tabId: presentation.tabId })
      return
    }
  }

  /** The bar up in a window, for tests and diagnostics. */
  sessionFor(host: FindHost): FindSession | null {
    return this.#live.get(host)?.session ?? null
  }

  // --- internals -----------------------------------------------------------

  #run(host: FindHost, request: FindRequest): void {
    const existing = this.#live.get(host) ?? null
    const result = findStep({
      current: existing?.session ?? null,
      remembered: this.#lastQuery.get(host) ?? '',
      request
    })

    const next = result.session
    if (next === null) {
      /*
        The record goes first, and the order is load-bearing.

        `dismissOverlay` announces the departure synchronously, which arrives back at
        `overlayVacated`. With the entry still present that would close a session that has already
        been closed — and, worse, would clear a page for a second time after another bar had taken
        the layer.
      */
      this.#live.delete(host)
      if (existing !== null) existing.release()
      for (const action of result.actions) this.#perform(host, action, null)
      this.#dismissOwnSurface(host)
      return
    }

    this.#lastQuery.set(host, next.query)

    let live = existing
    if (live?.session.tabId !== next.tabId) {
      // The bar moved to another tile, or this is the first one. Either way the previous page's
      // subscriptions have to go, or a closed session would keep reporting into a live bar.
      if (live !== null) live.release()
      live = { session: next, requestId: null, release: this.#bind(host, next.tabId) }
    } else {
      live.session = next
    }
    this.#live.set(host, live)

    for (const action of result.actions) this.#perform(host, action, live)
    this.#present(host, next)
  }

  #perform(host: FindHost, action: FindPageAction, live: LiveFind | null): void {
    const page = host.tab(action.tabId)?.view.webContents
    // A tab closed under the bar needs nothing done to it: its document, its find session and its
    // highlight went together.
    if (page === undefined || page.isDestroyed()) return

    if (action.do === 'clear') {
      page.stopFindInPage(FIND_STOP_ACTION)
      if (live !== null) live.requestId = null
      return
    }

    const requestId = page.findInPage(action.query, findInPageOptions(action))
    if (live !== null) live.requestId = requestId
  }

  /**
   * Puts the bar on the layer, or takes it down when there is nowhere to put it.
   *
   * "Nowhere" is the tab having been closed or pushed out of its tile while the bar was up. Closing
   * through `#run` rather than deleting the record directly, so the highlight is cleared on the way
   * out by the same path as every other departure; it recurses exactly once, because a close leaves
   * no session to present.
   */
  #present(host: FindHost, session: FindSession): void {
    const target = host.tab(session.tabId)
    const presentation =
      target === undefined
        ? null
        : findBarPresentation({
            session,
            tileIndex: target.tileIndex,
            tileRect: target.view.getBounds()
          })

    if (presentation === null) {
      this.#run(host, { ask: 'close', tabId: session.tabId })
      return
    }
    host.presentOverlay(presentation)
  }

  /**
   * Takes the layer down only if it is still showing this feature's bar.
   *
   * Never a plain dismiss. A close can arrive after something else has claimed the layer — a page
   * asking for the camera displaces the bar the instant it asks — and a prompt that leaves the layer
   * is settled the safe way, which is refused. `OverlayLayer.dismissKind` is the same rule from
   * inside; this is it from outside, because a window controller exposes the layer's contents but not
   * its kinds.
   */
  #dismissOwnSurface(host: FindHost): void {
    if (host.overlayPresentation()?.kind !== 'find-bar') return
    host.dismissOverlay()
  }

  /**
   * Subscribes to the one page a session searches, and returns the way back off (spec 6).
   *
   * Three events, and each is a rule rather than plumbing:
   *
   *  - `found-in-page` is the only way the counts ever arrive.
   *  - `did-start-navigation` ends the find session, because Chromium keeps it per document. Without
   *    it the next press of "next" would step through a search that no longer exists.
   *  - `did-stop-loading` is when the search can run again on the new document. Both halves are
   *    needed: the navigation cannot be the moment to re-search, because at that point the page being
   *    searched is still the old one.
   */
  #bind(host: FindHost, tabId: string): () => void {
    const page = host.tab(tabId)?.view.webContents
    if (page === undefined || page.isDestroyed()) {
      // Nothing to subscribe to. A no-op keeps every caller's teardown unconditional, which is what
      // stops a release from being skipped on the one path that has nothing to undo.
      return () => undefined
    }

    const onFound = (...args: unknown[]): void => {
      const [, payload] = args
      const result = findResultPayload(payload)
      if (result === null) return
      this.#received(host, result)
    }
    const onNavigation = (...args: unknown[]): void => {
      const [details] = args
      if (!endsFindSession(details)) return
      this.#run(host, { ask: 'invalidated', tabId })
    }
    const onSettled = (): void => this.#run(host, { ask: 'settled', tabId })

    page.on('found-in-page', onFound)
    page.on('did-start-navigation', onNavigation)
    page.on('did-stop-loading', onSettled)

    return () => {
      if (page.isDestroyed()) return
      page.removeListener('found-in-page', onFound)
      page.removeListener('did-start-navigation', onNavigation)
      page.removeListener('did-stop-loading', onSettled)
    }
  }

  #received(
    host: FindHost,
    result: { requestId: number; matches: number; activeMatch: number }
  ): void {
    const live = this.#live.get(host)
    if (live === undefined) return
    if (!acceptsFindResult(live.requestId, result.requestId)) return

    const next = withFindResult(live.session, result)
    /*
      Chromium reports several times per search as it walks the document, and repeats itself: the
      final update usually carries the numbers the one before it did. Presenting again for those
      would call `webContents.focus()` on the layer each time — see `takesFocus` — which is a
      keystroke's worth of interference for no change on screen.
    */
    if (!findCountChanged(live.session, next)) return
    live.session = next
    this.#present(host, next)
  }
}
