import type { HistoryRecorder } from '@shared/history/model.js'
import type { FaviconCache } from '@shared/favicons/model.js'
import type { ThumbnailCapturer } from '@shared/thumbnails/model.js'
import type { ZoomDirection } from '@shared/gestures/zoom.js'
import type { PageContextTarget } from '../menu/page-context-items.js'
import type { PageKeystroke } from './page-keys.js'
import type { Tab } from './Tab.js'

/**
 * What a tab reports to its window, and what it writes into: the two halves of its contract with the window.
 *
 * Out of `Tab.ts` so that file holds the tab and not its interface (KTD21); `Tab.ts` re-exports both.
 */

export interface TabCallbacks {
  onStateChanged(tab: Tab): void
  /** Its failure came or went, and with it whether the view is shown; see `view-visibility.ts`. */
  onFailureChanged(tab: Tab): void
  /**
   * The user put the caret or the pointer into this tab's view.
   *
   * The only signal the core gets that someone clicked *into* a tile: the click lands on
   * a native view, so the chrome UI never sees it and cannot report it. Without this, the
   * active tile only ever changes through a keyboard shortcut or a new tab — which means
   * the toolbar's back button keeps acting on whatever tile was activated last, not the
   * one being looked at.
   */
  onFocused(tab: Tab): void
  /**
   * A page asked for a new tab or window — `window.open`, `target=_blank`, a middle-click.
   *
   * `userGesture` is the part that was missing. Every one of these used to become a tab
   * unconditionally, so a popup on a timer and a link the user middle-clicked were the same event as
   * far as the core could tell. The flag is `true` only when the *core* saw a real input event in this
   * view moments before — see `automatic-navigation.ts` for why a renderer's own claim about a gesture
   * is worth nothing.
   *
   * Reported upwards rather than decided here, because the decision needs the settings and, for `ask`,
   * a dialogue on the window's overlay layer. A tab has neither.
   *
   * Returns whether the gesture was **spent** — whether it is what let this popup through. The record it
   * would be spent from belongs to this view, but only the window knows which rule answered, so the fact
   * comes back rather than being guessed at here. See `AutomaticNavigationDecision.spendsGesture` for
   * what one click is and is not allowed to vouch for.
   */
  onOpenNewTab(url: string, options: { background: boolean; userGesture: boolean }): boolean
  /**
   * The page is about to send *itself* somewhere else, and nothing the user did explains it.
   *
   * Called only for the main frame, only across sites, and only when the settings say to gate it — see
   * `decideAutomaticNavigation`, which holds every one of those conditions and the reasoning for each.
   * The navigation has already been stopped by the time this runs: answering `true` re-issues it as a
   * load the core owns, and answering `false` leaves the page where it is.
   *
   * A callback rather than a return value because the answer may need a person: with the setting on
   * `ask` the window puts a prompt on the overlay layer and this resolves when it is answered.
   */
  onAutomaticNavigation(tab: Tab, url: string, allow: (permitted: boolean) => void): void
  onEnterHtmlFullscreen(tab: Tab): void
  onLeaveHtmlFullscreen(tab: Tab): void
  onCloseRequested(tab: Tab): void
  /**
   * The user right-clicked the page.
   *
   * Reported upwards rather than handled here, because the menu's items need things a tab does not have:
   * the current language, whether the blocker is on, and the ability to open a new tab beside this one.
   */
  onContextMenu(tab: Tab, target: PageContextTarget): void
  /**
   * The pointer moved inside this tab's view, `y` pixels below its top edge.
   *
   * The only source there is for revealing a tile's navigation bar, and it took a wrong comment in
   * `channels.ts` to notice: a tile is a native view stacked above the chrome renderer, so the chrome's DOM
   * never sees a pointer over a page — and the overlay layer is hidden until it already has something to show,
   * so it can report the bar's *departure* and nothing else. Neither renderer can report the approach, ever.
   */
  onPointerMoved(tab: Tab, y: number): void
  /**
   * A `Ctrl`-wheel, reported by *this* tab's page — and a pinch, which is now dropped.
   *
   * The tab it arrives on is the one under the pointer, because that is the view Chromium routes
   * wheel input to, and for a mouse wheel that is also the tab that zooms.
   *
   * A trackpad pinch arrives here too, because Chromium delivers one to the page as a `Ctrl`-wheel —
   * and it must not be applied, because the engine has already magnified the view itself. The window
   * decides through `decideZoomTarget`, using `isPinching` to tell the two apart; that function holds
   * the whole argument.
   *
   * Reported rather than applied here for that reason and one more: the step belongs to the ladder in
   * `gestures/zoom.ts`, which both this and the menu's zoom go through so the two cannot disagree.
   */
  onZoomGesture(tab: Tab, direction: ZoomDirection): void
  /**
   * A keystroke on its way into this tab's page, reported before the page has it.
   *
   * Only two keys are anybody's business up there — `Escape` and, on macOS, `Command+.` — and this is
   * the only route they have: as menu accelerators they would be claimed globally and taken from every
   * text field on every page. The window decides what to do with them, because both answers are the
   * window's (cancel this tab's load, or step down the escalation ladder) and neither is a tab's.
   *
   * Reported rather than acted on, and reported *without* the means to consume the key: the handler
   * that could call `preventDefault` stays in this file and deliberately never does. See
   * `page-keys.ts` for why the page always keeps the keystroke.
   */
  onPageKeystroke(tab: Tab, keystroke: PageKeystroke): void
}

/**
 * Everything a tab writes into, already bound to one browsing mode.
 *
 * Grouped because they share the property that matters and are never passed apart: each is the write
 * side of a persistent store, resolved *once* per window from that window's mode, and each has a
 * discarding variant a private window gets instead. So "a private window leaves no trace" is a fact
 * about the objects a tab holds rather than a check at every call site — there is no flag in here to
 * forget, and no path from this object to a file on disk.
 *
 * A tab records its own visits, icons and pictures rather than reporting upwards: it is the thing
 * that knows its address, its title and its view, and a round trip through the window would add a hop
 * without adding a decision.
 */
export interface TabWiring {
  /** See `HistoryStore.recorderFor`. */
  history: HistoryRecorder
  /** See `FaviconStore.cacheFor`. A private window's holds no fetcher, so it makes no request. */
  favicons: FaviconCache
  /** See `ThumbnailStore.capturerFor`. A private window's `shouldCapture` is always false. */
  thumbnails: ThumbnailCapturer
  /**
   * How long a page must stay put before it is photographed.
   *
   * Read from the store rather than from the constant, so a test that shortens it shortens it
   * everywhere instead of leaving the wiring on the production value.
   */
  thumbnailSettleDelayMs: number
}
