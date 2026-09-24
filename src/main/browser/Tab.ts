import type { Session, WebContents, WebContentsView } from 'electron'
import type { TabState } from '@shared/model.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { Rect } from '@shared/split/layout.js'
import { isHomeUrl } from '@shared/url/omnibox.js'
import { faviconDomainOf, faviconUrl } from '@shared/favicons/model.js'
import { mouseMoveY } from '@shared/gestures/pointer.js'
import {
  PINCH_GRACE_MS,
  ZOOM_GESTURE_CHANNEL,
  pinchInputPhase
} from '@shared/gestures/wheel-zoom.js'
import { SWIPE_GESTURE_CHANNEL } from '@shared/gestures/wheel-swipe.js'
import {
  MAX_VISUAL_ZOOM,
  MIN_VISUAL_ZOOM,
  clampZoomPercent,
  effectiveZoomPercent,
  type PaneZoom
} from '@shared/zoom/model.js'
import { sequenceOfTabId, tabIdForSequence } from '@shared/session/tab-ids.js'
import { UNSAVED_INPUT_CHANNEL } from '@shared/session/unload-policy.js'
import { securityStateOf } from '@shared/site/model.js'
import { createTabView } from './tab-view.js'
import type { DiscardedPage } from './tab-unloader.js'
import { pageKeystrokeOf } from './page-keys.js'
import {
  decideTabNavigation,
  pendingNavigationOf,
  type NavigationSource
} from './navigation-policy.js'
import { decideAutomaticNavigation, withinGestureWindow } from './automatic-navigation.js'
import { isFillGestureInput } from '@shared/passwords/gesture.js'
import { watchTabFailure, type TabFailureWatch } from './tab-failure-watch.js'
import { followInterstitial } from '../privacy/https-exemptions.js'

/**
 * One tab: a full `WebContentsView` with its own renderer process.
 *
 * Every tile in a split layout holds one of these, which is what makes tiles
 * genuinely independent views rather than embedded previews (spec 2) — separate
 * process, own navigation history, own devtools, own audio state.
 */

import type { TabCallbacks, TabWiring } from './tab-contract.js'
export type { TabCallbacks, TabWiring } from './tab-contract.js'

export interface TabOptions {
  id: string
  session: Session
  getSettings(): SettingsSnapshot
  callbacks: TabCallbacks
  wiring: TabWiring
  /**
   * True when the browser opened this tab by itself to fill an empty tile.
   *
   * The flag is dropped the moment the user navigates anywhere, because from then on it is a
   * tab they are using. Only a still-untouched filler may be closed when a layout shrinks;
   * see `shared/split/tile-fill.ts`.
   */
  ephemeral?: boolean
  /**
   * The zoom this pane comes back at, for session restore. Absent and `null` both mean a pane
   * nobody has zoomed, which is every pane the browser opens by itself — see `PaneZoom`.
   */
  zoomPercent?: PaneZoom
}

let sequence = 0

export function nextTabId(): string {
  sequence += 1
  return tabIdForSequence(sequence)
}

/**
 * Takes an id session restore is bringing back, and raises the counter past it in the same call.
 *
 * One function rather than a `reserveTabIds` to call before the first `createTab`, because that ordering would
 * be a convention and conventions get broken: a restore that created a tab before reserving would hand out
 * `tab-1` twice, and two different pages would answer to one id. Every id-keyed part of the browser would then
 * be quietly wrong about which page is which — `SplitController` would put the wrong page in a tile,
 * `TabGroupController` would group the wrong tab, and `closeTab` would destroy whichever the map happened to
 * hold. No error, no warning, and nothing a user could describe. Adopting *is* reserving, so there is no order
 * to get wrong.
 *
 * The arithmetic is in `@shared/session/tab-ids.ts` rather than here: this file cannot run outside a browser
 * process and is excluded from coverage, so a decision made in it is made where no unit test can see it.
 */
export function adoptTabId(id: string): string {
  sequence = Math.max(sequence, sequenceOfTabId(id))
  return id
}

export class Tab {
  readonly id: string
  /** Replaced when a discarded tab comes back (U15); read it fresh rather than keeping it. */
  #view: WebContentsView
  readonly #session: Session

  #pinned = false
  #ephemeral: boolean
  #pendingInput: string | null = null
  #tileIndex: number | null = null
  #blockedRequests = 0
  #faviconUrls: string[] = []
  /** What went wrong with the page, for the tile and the omnibox; see `tab-failure-watch.ts`. */
  #failure: TabFailureWatch | undefined

  /**
   * Where the last commit left this view.
   *
   * Held rather than read back off Chromium, and it is one caller that makes the difference. Every
   * request the blocker refuses is attributed to a tab by comparing document addresses
   * (`WindowRegistry.#noteBlockedRequest`), and that comparison used to go through `toState()` — a
   * sixteen-field snapshot built from eight synchronous calls into the browser process, to read one
   * string. On an advert-heavy page in a 2x2 that is several thousand of them per page load, for a
   * badge count.
   */
  #currentUrl = ''

  /**
   * This pane's zoom, or `null` while it still follows `appearance.defaultZoom`. Held rather than
   * read back off the view: `getZoomFactor()` reports Chromium's per-origin state, so the ladder's
   * starting point would otherwise depend on what some other pane is showing.
   */
  #zoomPercent: PaneZoom

  /**
   * The `tessera://favicon` address to show, and which site it belongs to.
   *
   * The site is kept alongside so a navigation can decide whether the icon still applies. Held
   * together in one field because they are only ever valid as a pair — two fields could disagree.
   */
  #favicon: { site: string; url: string } | null = null

  /**
   * The address and title of a tab with nothing loaded, and which of the two ways it got there (KTD9).
   *
   * Held as one field because they are only ever valid together — the same reason `#favicon` is. Non-null
   * means "in the strip, nothing fetched": `toState` reports the saved address and title so the strip is not a
   * row of blanks, and `unloaded: true` so the interface can mark it.
   *
   * `deferred` is session restore's: a window of twenty saved tabs that loaded them all would make twenty
   * requests nobody asked for, so only the tabs a *tile* shows load and the rest keep an empty view until they
   * are activated (`loadTimingFor`). `discarded` is tab unloading's: the view is gone, and `revive` builds a new
   * one whose history `TabDiscards` restores. `muted` is what the new view is put back to.
   */
  #unloaded: (DiscardedPage & { kind: 'deferred' | 'discarded' }) | null = null

  /** The facts tab unloading reads (U15), each kept by the events below; see `unload-policy.ts`. */
  #lastActiveAt = Date.now()
  /** A page's media started since the last commit, playing or paused (AE7). */
  #media = false
  /** The preload saw typing that no submit or navigation has taken away. */
  #unsavedInput = false
  #htmlFullscreen = false
  /** The page refused the last discard; it is not asked again until it navigates. */
  #objected = false
  /** A discard is in flight: its `close` is not the page asking, its renderer going is no crash. */
  #unloading = false

  /**
   * The pending screenshot, if one is waiting for the page to settle.
   *
   * A single handle, cleared before every new one, so a page that reports itself loaded several
   * times — a subframe finishing, a client-side route change — ends up with one timer rather than a
   * queue of them all photographing the same view.
   */
  #captureTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * When the core last saw a real input event in this view, or `null` if it never has.
   *
   * The whole of "did a person do this". A page opening a tab or redirecting itself is judged against
   * this, because `input-event` only fires for input the *browser process* dispatched — a page calling
   * `element.click()` never produces one and so can never move this number. See
   * `automatic-navigation.ts`.
   *
   * Per view rather than per window: a click in one tile is not consent to a popup in another, and with
   * four pages on screen that distinction is the difference between the feature working and not.
   */
  #lastGestureAt: number | null = null

  /**
   * Until when a zoom step from this view counts as part of a trackpad pinch.
   *
   * `Infinity` while the fingers are still down, a deadline once they lift (see `PINCH_GRACE_MS` for
   * the race that needs one), and `-Infinity` — never — when no pinch has happened. One number
   * rather than a flag and a timestamp, because "is this a pinch" then has exactly one answer and
   * cannot be assembled wrongly from two.
   *
   * The state a *failure* leaves is the reason it is written this way round: if `gesturePinchBegin`
   * never arrives on this view, this stays `-Infinity`, `isPinching` stays false, and the pinch
   * still zooms — just the pane under the pointer rather than the focused one. The feature degrades
   * in its routing instead of disappearing.
   */
  #pinchUntil = Number.NEGATIVE_INFINITY

  #disposers: Array<() => void> = []

  private readonly getSettings: () => SettingsSnapshot
  private readonly callbacks: TabCallbacks
  private readonly wiring: TabWiring

  constructor(options: TabOptions) {
    this.id = options.id
    this.#session = options.session
    this.getSettings = options.getSettings
    this.callbacks = options.callbacks
    this.#ephemeral = options.ephemeral ?? false
    this.#zoomPercent = options.zoomPercent ?? null
    this.wiring = options.wiring
    this.#view = this.#createView()
    // The pinch, before the first page. Re-asserted at every commit; see `applyVisualZoomLimits`.
    this.applyVisualZoomLimits()
  }

  get view(): WebContentsView {
    return this.#view
  }

  /** The view's contents while it is there; `null` once closed or discarded, so a command does nothing. */
  get #live(): WebContents | null {
    const wc = this.#view.webContents
    return wc.isDestroyed() ? null : wc
  }

  /**
   * A view with the whole wiring (KTD9): the one this tab starts with, and the one a discarded tab comes back in.
   * Built by `createTabView`, so preferences, zoom, spellcheck and the WebRTC policy are those of the first.
   */
  #createView(): WebContentsView {
    const view = createTabView({
      session: this.#session,
      settings: this.getSettings(),
      zoomPercent: this.#zoomPercent
    })
    this.#wireEvents(view.webContents)
    return view
  }

  #wireEvents(wc: WebContents): void {
    const notify = (): void => this.callbacks.onStateChanged(this)

    /**
     * `WebContents` extends Node's `EventEmitter`, so this is a widening to a
     * real interface rather than a cast to `any` — no unchecked assertion, and
     * the handler signatures stay typed.
     *
     * Electron's per-event overloads cannot be addressed generically, and
     * spelling out `on`/`removeListener` for two dozen events would bury the
     * intent. The typing rule that matters (spec 6) is about the UI/core
     * boundary, which is `ipc/contract.ts`; these are Electron's own events.
     */
    const emitter: NodeJS.EventEmitter = wc

    const on = (event: string, handler: (...args: unknown[]) => void): void => {
      emitter.on(event, handler)
      // Every subscription gets a way back off (spec 6): a closed tab must not
      // leave listeners behind that fire into a destroyed view.
      this.#disposers.push(() => {
        emitter.removeListener(event, handler)
      })
    }

    on('focus', () => {
      this.#lastActiveAt = Date.now()
      this.callbacks.onFocused(this)
    })
    // Typing nobody has sent yet, as the preload reports it (U15); a tab holding it is not unloaded.
    on('ipc-message', (...args: unknown[]) => {
      if (args[1] === UNSAVED_INPUT_CHANNEL) this.#unsavedInput = args[2] === true
    })

    /*
      Zoom by pinch or by `Ctrl`-wheel, as the page's own preload read it.

      This used to be Electron's `zoom-changed`, and that subscription is gone rather than kept
      alongside — `shared/gestures/zoom-gesture.ts` holds the report that led to it and the whole
      argument, of which two lines matter here. `zoom-changed` never fired for a trackpad pinch,
      which is the bug; and it could not see whether the page wanted the gesture for itself, which
      is why the reading has to happen in the renderer. Two sources would mean two ladder steps per
      notch for anyone with a mouse.

      ## Why a message from a page can be trusted with this

      It is not a page's message. A visited page has no bridge and cannot reach `ipcRenderer` (spec
      6), and `nodeIntegrationInSubFrames` is off, so this bundle runs in the top frame only — the
      sender is this view's own preload or nothing. The same construction as the autofill channels,
      and for the same reason `install-autofill.ts` gives: a listener attached to a view makes the
      sender *be* the view, so there is no sender check written by hand.

      The direction is still read defensively. It crosses a process boundary, and an unknown value
      must do nothing rather than be treated as one of the two.
    */
    on('ipc-message', (...args: unknown[]) => {
      const [, channel, direction] = args
      if (channel !== ZOOM_GESTURE_CHANNEL) return
      if (direction !== 'in' && direction !== 'out') return
      this.callbacks.onZoomGesture(this, direction)
    })

    /*
      The two-finger swipe, as the same preload read it — see `shared/gestures/wheel-swipe.ts`.

      Applied here rather than reported up, unlike the zoom above, because there is nothing left to
      decide: the sender is the page under the pointer, which is the tile the user meant, and back and
      forward are this tab's own. The same trust argument as the zoom channel holds, and the same
      defensive read of the value.
    */
    on('ipc-message', (...args: unknown[]) => {
      const [, channel, intent] = args
      if (channel !== SWIPE_GESTURE_CHANNEL) return
      if (intent === 'back') this.goBack()
      else if (intent === 'forward') this.goForward()
    })

    /*
      Every mouse move in the page, filtered to the one number the tile bar needs.

      Gated on the setting here rather than further up: this runs per mouse move in every tile, which is exactly
      the cost `splitView.tileBarMode: 'keyboard'` exists to remove on a machine that cannot afford it.
      `mouseMoveY` is what makes the untyped payload safe to read — and see that module for why a `mouseLeave`
      must never be read as the pointer leaving.
    */
    on('input-event', (...args: unknown[]) => {
      const [, input] = args
      /*
        The gesture record, before the tile-bar filter and deliberately not gated on any setting.

        This is the one signal that tells a popup the user asked for from one that arrived on a timer, and
        `automatic-navigation.ts` explains why it has to be taken here: `input-event` fires for input the
        *browser process* dispatched into the view, so `element.click()` and `dispatchEvent` inside a page
        produce nothing. A renderer cannot forge it, which is the whole property.

        Recorded rather than reported: a timestamp per view costs one field and is read only when a page
        tries to open or navigate something, where sending an event per keystroke up to the window would
        be a message per keystroke for a question nobody asked.
      */
      if (isFillGestureInput(input)) this.#lastGestureAt = Date.now()

      /*
        The pinch bracket, which decides *which pane* a zoom step lands on rather than whether one
        happens — see `decideZoomTarget`.

        Read here because this is the only trustworthy place it exists. The wheel events the preload
        reports look identical whether a finger or a wheel produced them; `gesturePinchBegin` is the
        browser process saying which, and a renderer cannot forge it any more than it can forge the
        click above.
      */
      const pinch = pinchInputPhase(input)
      if (pinch === 'begin') this.#pinchUntil = Number.POSITIVE_INFINITY
      else if (pinch === 'end') this.#pinchUntil = Date.now() + PINCH_GRACE_MS

      if (this.getSettings()['splitView.tileBarMode'] !== 'hover') return
      const y = mouseMoveY(input)
      if (y === null) return
      this.callbacks.onPointerMoved(this, y)
    })
    /*
      `Escape`, before the page sees it — and left for the page all the same.

      `before-input-event` rather than the `input-event` above, although nothing here consumes the
      keystroke and `input-event` would therefore do. Two reasons, both deliberate. This event carries
      Electron's parsed `Input` — `key`, the four modifier flags, `isAutoRepeat` — where `input-event`
      carries the raw serialised Blink event with none of that described; and the `preventDefault` this
      one *could* call is exactly the decision `page-keys.ts` is about, so the code should sit where
      that choice is visible rather than where it cannot be made. The other subscription is also gated
      on the hover setting, which a keyboard user turns off.

      `event.preventDefault` is not called on any path. See `page-keys.ts`.
    */
    on('before-input-event', (...args: unknown[]) => {
      const [, input] = args
      const keystroke = pageKeystrokeOf(input)
      if (keystroke === null) return
      this.callbacks.onPageKeystroke(this, keystroke)
    })
    on('page-title-updated', () => {
      // Chromium reports the title after the navigation, so without this most entries would have
      // no title and searching by title would find almost nothing.
      this.wiring.history.noteTitle({ url: wc.getURL(), title: wc.getTitle() })
      notify()
    })
    on('did-start-loading', () => {
      this.#blockedRequests = 0
      notify()
    })
    on('did-stop-loading', () => {
      this.#pendingInput = null
      this.#scheduleCapture()
      notify()
    })
    on('did-start-navigation', () => {
      /*
        Cancel any pending screenshot. This is the whole reason the timer is held rather than fired
        and forgotten: the capture is filed under the address it was *requested* for, so one that
        survives a navigation photographs the new page and files it under the old page's address —
        a start-page card showing the wrong site, which looks like a caching bug and is not one.

        The capturer checks the view's address again before pressing the shutter, so this is the
        second of two guards. Both are wanted: this one saves the work, that one is the backstop for
        a navigation that begins after the timer has already fired.
      */
      this.#cancelCapture()
      notify()
    })
    on('did-navigate', () => {
      /*
        The gesture does not cross into the new document, and this is the other half of the report in
        `AutomaticNavigationDecision.spendsGesture`.

        `#lastGestureAt` is one field on a tab that outlives every page shown in it, so a click on the
        page being left counted as a click on the page arriving — for as long as a second, which is
        precisely how long a page needs to open something the moment it loads. The click that followed a
        link is consent to follow that link; it says nothing about what the destination then decides to
        open, and a tab that appears by itself right after a page loads is the exact complaint this
        gating exists to answer.

        `did-navigate` rather than `did-start-navigation`: only a committed main-frame document is a new
        document, and a subframe loading — an advert, an embed — must not spend the click the user made
        on the page around it.
      */
      this.#lastGestureAt = null
      // A new document: nothing typed, nothing played, no refusal — and the tab was in use (U15).
      this.#lastActiveAt = Date.now()
      this.#unsavedInput = this.#media = this.#objected = false
      // Read once and kept. Three of the lines below want it, and the blocker wants it once per
      // refused request until the next commit — see `#currentUrl`.
      this.#currentUrl = wc.getURL()
      // Navigating anywhere real makes this a tab the user is using, so it stops being
      // disposable. Checked against the home address rather than a counter: a filler that
      // was reloaded is still a filler.
      if (this.#ephemeral && !isHomeUrl(this.#currentUrl)) this.#ephemeral = false
      // The store decides what is worth keeping — internal pages, `data:` addresses and the rest
      // are refused there, so this stays a plain report rather than a second policy.
      this.wiring.history.recordVisit({ url: this.#currentUrl, title: wc.getTitle() })
      this.#faviconUrls = []
      /*
        The icon survives a navigation within the same site, and only that.

        Clearing it unconditionally would blank the tab on every click through a site and then bring
        the same picture back a moment later — a flicker on every page load. Keeping it
        unconditionally would show the previous site's icon next to the new site's title, which is
        worse than showing none: at a glance the tab claims to be somewhere it is not.
      */
      if (this.#favicon !== null && faviconDomainOf(this.#currentUrl) !== this.#favicon.site) {
        this.#favicon = null
      }
      // The pane's zoom, put back after every commit. Chromium's zoom is same-origin per session, so
      // re-asserting is what keeps the value the pane's rather than whatever another pane last left
      // this origin at — see `shared/zoom/model.ts` for what that does and does not buy.
      this.applyZoom()
      // And the pinch limits, which a cross-site navigation genuinely loses. See the method.
      this.applyVisualZoomLimits()
      notify()
    })
    /*
      A client-side route change commits a new address without a new document, so `did-navigate`
      never fires for it. The blocker attributes a refused request by address, and a single-page
      application that moved route would otherwise credit every advert it then fetched to nobody.

      ## Why the history is written here too

      It was not, and that is a hole the size of the modern web. `did-navigate` fires once per
      *document*, and on a site that routes in the page — a video site, a code host, a mail client —
      the document is fetched once and every page the user reads afterwards is one of these. So the
      history kept the address somebody landed on and nothing they went on to look at, which is
      indistinguishable from the history missing whole tabs.

      Bounded to the main frame, and that is the difference between recording a visit and inflating a
      count: a subframe routing in place leaves `wc.getURL()` on the top document, so recording it
      would advance the entry for a page nobody navigated. Electron passes the flag as the third
      argument, read defensively because it crosses from a browser process this file cannot type.

      Nothing is deduplicated here. `recordVisit` advances an existing entry for the same address
      rather than adding a second one, so `replaceState` called in a loop — which is how a page tracks
      a scroll position — costs one entry whose timestamp moves, not one entry per call.

      The title is read at the same moment and is routinely the *old* one: an application that changes
      route sets `document.title` shortly afterwards. That is what `page-title-updated` and `noteTitle`
      are for, and it is why an empty or stale title never overwrites a known one.
    */
    on('did-navigate-in-page', (...args: unknown[]) => {
      const [, , isMainFrame] = args
      this.#currentUrl = wc.getURL()
      if (isMainFrame === true) {
        this.wiring.history.recordVisit({ url: this.#currentUrl, title: wc.getTitle() })
      }
      notify()
    })
    on('page-favicon-updated', (...args: unknown[]) => {
      const favicons = args[1]
      this.#faviconUrls = Array.isArray(favicons)
        ? favicons.filter((url): url is string => typeof url === 'string')
        : []
      void this.#adoptFavicon(wc.getURL(), this.#faviconUrls)
      notify()
    })
    on('context-menu', (...args: unknown[]) => {
      /*
        Read defensively from Chromium's params object rather than trusted wholesale.

        It is Electron's own payload, so this is totality rather than suspicion: a field absent in one version
        must produce a menu with fewer items, not a menu that fails to open — a right-click that does nothing
        is indistinguishable from a frozen browser.
      */
      const params = (args[1] ?? {}) as Record<string, unknown>
      const text = (key: string): string => {
        const value = params[key]
        return typeof value === 'string' ? value : ''
      }
      this.callbacks.onContextMenu(this, {
        linkUrl: text('linkURL'),
        srcUrl: text('srcURL'),
        selectionText: text('selectionText'),
        isEditable: params['isEditable'] === true,
        pageUrl: wc.getURL()
      })
    })
    on('audio-state-changed', notify)
    // Paused counts as much as playing: a paused video that is unloaded starts over (AE7).
    const noteMedia = (): void => {
      this.#media = true
      notify()
    }
    on('media-started-playing', noteMedia)
    on('media-paused', noteMedia)
    this.#failure = watchTabFailure(
      { webContentsId: wc.id, on, url: () => wc.getURL(), unloading: () => this.#unloading },
      () => {
        notify()
        this.callbacks.onFailureChanged(this)
      }
    )
    on('destroyed', notify)

    // Fullscreen requests from the page. The window-level suppression that
    // keeps this inside the tile lives in `BrowserWindowController`.
    on('enter-html-full-screen', () => {
      this.#htmlFullscreen = true
      this.callbacks.onEnterHtmlFullscreen(this)
    })
    on('leave-html-full-screen', () => {
      this.#htmlFullscreen = false
      this.callbacks.onLeaveHtmlFullscreen(this)
    })

    /*
      Navigation to an internal address that this browser did not start. The decision is in
      `navigation-policy.ts`, for the reason `page-keys.ts` was split off one subscription up: this file
      is excluded from coverage, so a security rule written here would be one no test can question.

      Two events, judged differently — `will-frame-navigate` for every frame, `will-redirect` for a
      `Location:` header, which is how the HTTPS-only interstitial arrives. A refused navigation may be
      that interstitial's own "Continue" or "Go back", which the core carries out (KTD3).
    */
    const guardNavigation =
      (source: NavigationSource) =>
      (...args: unknown[]): void => {
        const pending = pendingNavigationOf(args[0], source)
        if (pending === null) return
        const decision = decideTabNavigation(pending)
        if (decision.allowed) return
        pending.prevent()
        const step = followInterstitial(pending, wc)
        if (step?.kind === 'back') this.goBack()
        else if (step !== null) this.loadUrl(step.url)
        // Silent to the page on purpose — a site must not learn what this browser serves — but never
        // silent to a developer: a refusal that says nothing is a refusal nobody can tell from a bug.
        else console.warn(`[navigation] refused: ${decision.reason}`)
      }

    on('will-frame-navigate', guardNavigation('frame'))
    on('will-redirect', guardNavigation('redirect'))

    /*
      The page sending itself somewhere, gated on whether anybody asked for it.

      Registered *after* the privilege guard above, which is the right order: an internal address is
      refused outright and never becomes a question for the user.

      ## Why the navigation is stopped first and re-issued afterwards

      `preventDefault` has to be called synchronously — the event is over by the time an answer could
      arrive from a person — so the only way to offer "ask" at all is to stop the navigation and perform
      it again if it is permitted. `loadUrl` is what re-issues it, which means the second attempt is a
      load the *core* owns and therefore does not come back through here. `navigation-policy.ts` already
      rests on that same documented behaviour of `will-frame-navigate`, so this is not a new assumption.

      ## Why only the main frame

      A subframe navigating itself is what an embed does, several times per page on a great many sites,
      and it cannot take the tab anywhere. The filter is here rather than in the decision because there
      is no reading of a subframe navigation the decision would answer differently.
    */
    on('will-frame-navigate', (...args: unknown[]) => {
      const pending = pendingNavigationOf(args[0], 'frame')
      if (pending?.isMainFrame !== true) return
      if (!/^https?:/i.test(pending.url)) return

      const decision = decideAutomaticNavigation({
        kind: 'navigation',
        url: pending.url,
        documentUrl: wc.getURL(),
        sinceGestureMs: this.#sinceGesture(),
        gate: this.getSettings()['privacy.pageInitiatedRedirects']
      })
      if (decision.action === 'allow') {
        // The click that vouched for this redirect cannot also vouch for the popup behind it.
        if (decision.spendsGesture) this.#lastGestureAt = null
        return
      }

      pending.prevent()
      if (decision.action === 'block') {
        console.warn(`[navigation] refused: ${decision.reason} (${pending.url})`)
        return
      }

      const target = pending.url
      this.callbacks.onAutomaticNavigation(this, target, (permitted) => {
        // Guarded because the answer arrives later: the tab may have been closed, or navigated
        // elsewhere by the user, while the prompt was on screen.
        if (!permitted || this.view.webContents.isDestroyed()) return
        this.loadUrl(target)
      })
    })

    /*
      window.open and target=_blank become tabs, never popups we do not control — and now only when
      somebody asked for one.

      This used to open a tab for every request, so a popup on a timer, a popup on page load and a link
      the user middle-clicked were one event as far as the core could tell. The gesture is decided here
      and carried upwards rather than decided upwards, because `#lastGestureAt` belongs to this view and
      "was there a gesture *in the tile the popup came from*" is the question that matters with four
      pages on screen.

      `{ action: 'deny' }` on every path, as before: whether a tab is opened is the window's business,
      and letting Electron open a real popup window would hand a page a surface this browser does not
      control.
    */
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:/i.test(url)) {
        const spent = this.callbacks.onOpenNewTab(url, {
          background: disposition === 'background-tab',
          userGesture: withinGestureWindow(this.#sinceGesture())
        })
        // One click, one thing. A page that answers a click with four `window.open` calls gets one tab
        // and three questions, which is what every browser's own popup blocker does.
        if (spent) this.#lastGestureAt = null
      }
      return { action: 'deny' }
    })

    // A page calling window.close() should close its tab, not silently do nothing. A discard closes the
    // page too, and Electron reports that the same way — which must not close the tab (U15).
    on('close', () => {
      if (!this.#unloading) this.callbacks.onCloseRequested(this)
    })
  }

  // --- geometry ------------------------------------------------------------

  /*
    Both guarded, and until now neither was — the only two methods of this class that reached for the
    view without first asking whether it is still there.

    `relayout()` walks every tab on every layout change, and a tab whose renderer has gone is still in
    the window's map for as long as it takes the window to notice: a crash, a `window.close()` racing
    the teardown, and — once tabs can be unloaded to reclaim their memory — a discard. Touching a
    destroyed view is at best wasted work and at worst an exception out of the middle of that loop,
    which would leave every tab after it where the *previous* layout put it.
  */
  setBounds(rect: Rect): void {
    if (this.view.webContents.isDestroyed()) return
    this.view.setBounds(rect)
  }

  setVisible(visible: boolean): void {
    if (this.view.webContents.isDestroyed()) return
    this.view.setVisible(visible)
  }

  // --- navigation ----------------------------------------------------------

  loadUrl(url: string): void {
    this.#pendingInput = url
    void this.#live?.loadURL(url).catch(() => {
      // Load failures surface through `did-fail-load` and the error page; a
      // rejected promise here is not additionally interesting.
    })
  }

  goBack(): void {
    const history = this.#live?.navigationHistory
    if (history?.canGoBack() === true) history.goBack()
  }

  goForward(): void {
    const history = this.#live?.navigationHistory
    if (history?.canGoForward() === true) history.goForward()
  }

  reload(ignoreCache: boolean): void {
    if (ignoreCache) this.#live?.reloadIgnoringCache()
    else this.#live?.reload()
  }

  stop(): void {
    this.#live?.stop()
  }

  /**
   * True while this tab is still fetching something.
   *
   * A getter rather than a second `isLoading()` call at the one other place that wants it, because
   * `toState` and the `Escape` decision must not be able to disagree about whether a load is in flight
   * — that is the whole question `stop` turns on.
   */
  get loading(): boolean {
    return this.#live?.isLoading() === true
  }

  /**
   * Where this tab is, answered without asking Chromium and without building a state object.
   *
   * Deliberately *not* `toState().url`, which is what the blocker used to compare against: this is the
   * committed address and nothing else, so it is safe to ask for once per refused request. See
   * `#currentUrl` for what that cost before.
   */
  get currentUrl(): string {
    return this.#currentUrl
  }

  toggleDevTools(): void {
    const wc = this.#live
    if (wc?.isDevToolsOpened() === true) wc.closeDevTools()
    else wc?.openDevTools({ mode: 'bottom' })
  }

  // --- audio ---------------------------------------------------------------

  setMuted(muted: boolean): void {
    this.#live?.setAudioMuted(muted)
    this.callbacks.onStateChanged(this)
  }

  get muted(): boolean {
    return this.#live?.isAudioMuted() === true
  }

  // --- zoom ----------------------------------------------------------------

  /**
   * Page zoom: the factor that reflows, put on the view.
   *
   * The value is the pane's — spec 1 said the opposite and **the user reversed it on 29.07.2026** —
   * and the *rendering* is per origin per session, because `setZoomFactor` writes into a zoom map
   * Chromium keys by host. Two tiles showing one site therefore share the level, which is the cost
   * that was weighed and accepted after the alternative was built and measured: a stylesheet putting
   * CSS `zoom` on the page root is genuinely per pane and restyles the whole document on every step,
   * which was reported as unusable. `shared/zoom/model.ts` carries that whole history, and the pinch
   * — the case where per-pane really matters — is answered by visual zoom in the constructor.
   *
   * Guarded on the view being gone, because this is reached from a settings change that walks every
   * pane in the window.
   */
  applyZoom(): void {
    const wc = this.view.webContents
    if (wc.isDestroyed()) return
    wc.setZoomFactor(this.zoomPercent / 100)
  }

  /**
   * Visual zoom: the pinch, handed to the engine rather than implemented here.
   *
   * Electron switches visual zoom off, so a trackpad pinch did nothing until it was read out of the
   * page as a `Ctrl`-wheel and stepped along the page-zoom ladder — the slow route, a round trip and
   * a relayout per step, driving a factor that is shared per origin. Raising the limits gives the
   * gesture back to Chromium, where it is the page *scale*: per view, in the compositor, no layout at
   * all. Safari's trackpad pinch is the same mechanism.
   *
   * ## Why this is called again at every commit
   *
   * Because the limits belong to a *renderer*, and a tab does not keep the same one. Site isolation
   * gives a cross-site navigation a fresh renderer process, and the fresh one starts at Electron's
   * default — pinch disabled — so the setting made when the tab was built applies to the process that
   * loaded the start page and to nothing after it.
   *
   * That is exactly how it was reported: *"warum klappt der nur auf der startseite?"*. The start page
   * is where the tab begins, so it is the one document that shares a process with the call; every site
   * navigated to afterwards is another process, and pinching there did nothing.
   *
   * Cheap enough to do unconditionally: it is one asynchronous message per committed document, on a
   * path that has just loaded one.
   *
   * The promise is dropped deliberately. A view that refuses this is a view whose pinch does nothing,
   * which is where every Electron application starts and is not a reason to fail a navigation.
   */
  applyVisualZoomLimits(): void {
    const wc = this.view.webContents
    if (wc.isDestroyed()) return
    void wc.setVisualZoomLevelLimits(MIN_VISUAL_ZOOM, MAX_VISUAL_ZOOM).catch(() => {
      // A view torn down between the commit and this call. Nothing to do and nothing to say.
    })
  }

  setZoomPercent(percent: number): void {
    this.#zoomPercent = clampZoomPercent(percent)
    this.applyZoom()
    this.callbacks.onStateChanged(this)
  }

  /**
   * Back to "never zoomed", which is not back to 100 %: a pane that follows `appearance.defaultZoom`
   * keeps following it, and this is the only way into that state once a pane has been zoomed.
   */
  resetZoom(): void {
    this.#zoomPercent = null
    this.applyZoom()
    this.callbacks.onStateChanged(this)
  }

  /** What this pane is showing at, with the setting standing in for a pane never zoomed. */
  get zoomPercent(): number {
    return effectiveZoomPercent(this.#zoomPercent, this.getSettings()['appearance.defaultZoom'])
  }

  // --- bookkeeping ---------------------------------------------------------

  get pinned(): boolean {
    return this.#pinned
  }

  /** True while this is still an untouched tile filler the browser opened by itself. */
  get ephemeral(): boolean {
    return this.#ephemeral
  }

  setPinned(pinned: boolean): void {
    this.#pinned = pinned
    this.callbacks.onStateChanged(this)
  }

  get tileIndex(): number | null {
    return this.#tileIndex
  }

  setTileIndex(index: number | null): void {
    this.#tileIndex = index
    // Joining or leaving a tile is being looked at, so an idle tab's clock starts when it leaves one.
    this.#lastActiveAt = Date.now()
    this.callbacks.onStateChanged(this)
  }

  /** Why the tile shows a failure instead of this page, if it does. */
  get failure(): TabFailureWatch['current'] {
    return this.#failure?.current
  }

  noteBlockedRequest(): void {
    this.#blockedRequests += 1
  }

  get blockedRequests(): number {
    return this.#blockedRequests
  }

  /**
   * Turns the icon addresses a page declared into the one address a renderer can draw.
   *
   * Awaits a retrieval that may involve the network, so by the time it answers the tab may be
   * somewhere else entirely — a slow icon on a page the user has already left. The site is therefore
   * compared against the tab's *current* address before anything is adopted, which is the difference
   * between an icon appearing late and one site's icon appearing beside another site's title.
   *
   * Failures are not reported here. `ensure` already counts every refusal by reason, and there is
   * nothing a tab could usefully do about a site whose icon is a 404 — see `FAVICON_REJECTIONS`.
   */
  async #adoptFavicon(pageUrl: string, candidates: readonly string[]): Promise<void> {
    const site = faviconDomainOf(pageUrl)
    if (site === null) return

    const outcome = await this.wiring.favicons.ensure(pageUrl, candidates)
    if (outcome.kind === 'rejected') return

    const wc = this.view.webContents
    if (wc.isDestroyed()) return
    // The tab moved on while this was in flight.
    if (faviconDomainOf(wc.getURL()) !== site) return

    this.#favicon = { site, url: faviconUrl(outcome.entry) }
    this.callbacks.onStateChanged(this)
  }

  /** Brings a tab back in the strip without fetching anything. Session restore only. */
  deferLoad(deferred: { url: string; title: string }): void {
    this.#unloaded = { kind: 'deferred', ...deferred, muted: false }
    this.callbacks.onStateChanged(this)
  }

  /** Loads a tab restored deferred, once, into the view it has. A no-op for any other tab. */
  loadIfDeferred(): void {
    const deferred = this.#unloaded
    if (deferred?.kind !== 'deferred') return
    // Cleared first: `loadUrl` triggers state changes, and a `toState` during them must already report the
    // real address rather than the saved one.
    this.#unloaded = null
    this.loadUrl(deferred.url)
  }

  // --- unloading (U15) -----------------------------------------------------

  get lastActiveAt(): number {
    return this.#lastActiveAt
  }

  get hasMedia(): boolean {
    return this.#media
  }

  get unsavedInput(): boolean {
    return this.#unsavedInput
  }

  get htmlFullscreen(): boolean {
    return this.#htmlFullscreen
  }

  get objected(): boolean {
    return this.#objected
  }

  /** Nothing loaded, either way; the view rule hides the view (KTD22). */
  get unloaded(): boolean {
    return this.#unloaded !== null
  }

  markActive(): void {
    this.#lastActiveAt = Date.now()
  }

  beginDiscard(): void {
    this.#unloading = true
  }

  /** The discard settled: the view went and `page` is what the strip keeps, or the page kept it (`null`). */
  endDiscard(page: DiscardedPage | null): void {
    this.#unloading = false
    if (page === null) {
      this.#objected = true
      return
    }
    this.#release()
    this.#unloaded = { kind: 'discarded', ...page }
    this.callbacks.onStateChanged(this)
  }

  /** A discarded tab's new view, wired as the first was; `TabDiscards` attaches it and restores the history. */
  revive(): void {
    const discarded = this.#unloaded
    this.#unloaded = null
    this.#view = this.#createView()
    this.applyVisualZoomLimits()
    if (discarded?.muted === true) this.#view.webContents.setAudioMuted(true)
    // The address bar shows where the tab is going while the history comes back.
    this.#pendingInput = discarded?.url ?? null
    this.callbacks.onStateChanged(this)
  }

  /** Milliseconds since the core last saw real input in this view, or `null` if it never has. */
  #sinceGesture(): number | null {
    return this.#lastGestureAt === null ? null : Date.now() - this.#lastGestureAt
  }

  /**
   * Whether a zoom step arriving now belongs to a trackpad pinch.
   *
   * Read by the window to decide which pane the step lands on; see `decideZoomTarget` and
   * `#pinchUntil` for what the two ends of the number mean.
   */
  get isPinching(): boolean {
    return Date.now() <= this.#pinchUntil
  }

  #cancelCapture(): void {
    if (this.#captureTimer === null) return
    clearTimeout(this.#captureTimer)
    this.#captureTimer = null
  }

  /**
   * Photographs the page for its start-page card, once it has stopped moving.
   *
   * Delayed rather than taken at `did-stop-loading`, because "loading finished" and "looks like the
   * page" are different moments: fonts swap, images decode, a hero element animates in. A picture
   * taken at the first is of a half-built page, and it is the one that gets kept.
   *
   * `shouldCapture` is asked *before* the timer is set rather than inside it. That is what makes a
   * private window cost nothing at all — no timer, no delayed work, no photograph — and it also
   * skips pages that already have a current picture, which is most of them.
   */
  #scheduleCapture(): void {
    this.#cancelCapture()

    const wc = this.view.webContents
    if (wc.isDestroyed()) return
    const url = wc.getURL()
    if (!this.wiring.thumbnails.shouldCapture(url)) return

    this.#captureTimer = setTimeout(() => {
      this.#captureTimer = null
      if (wc.isDestroyed()) return
      /*
        The address is read again here, not captured above.

        A same-document navigation — a client-side route change — does not fire
        `did-start-navigation`, so the cancellation above would not have run, and the picture would be
        filed under the address the page had when it finished loading rather than the one it shows.
      */
      void this.wiring.thumbnails.capture({
        url: wc.getURL(),
        title: wc.getTitle(),
        viewId: wc.id
      })
    }, this.wiring.thumbnailSettleDelayMs)
  }

  toState(): TabState {
    const wc = this.view.webContents
    const destroyed = wc.isDestroyed()
    const history = destroyed ? null : wc.navigationHistory

    return {
      id: this.id,
      url: this.#unloaded?.url ?? (destroyed ? '' : wc.getURL()),
      pendingInput: this.#pendingInput,
      title: this.#unloaded?.title ?? (destroyed ? '' : wc.getTitle()),
      faviconUrl: this.#favicon?.url ?? null,
      loading: this.loading,
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false,
      pinned: this.#pinned,
      muted: destroyed ? false : wc.isAudioMuted(),
      audible: destroyed ? false : wc.isCurrentlyAudible(),
      security: destroyed
        ? 'internal'
        : securityStateOf(wc.getURL(), this.#failure?.certificateRejected === true),
      blockedRequests: this.#blockedRequests,
      // The stored value, not the effective one: the session slot is filled from this and the file
      // has to be able to say "never zoomed". The number is ours rather than something read back
      // off Chromium, so a destroyed view no longer comes into it. See `PaneZoom`.
      zoomPercent: this.#zoomPercent,
      tileIndex: this.#tileIndex,
      unloaded: this.#unloaded !== null,
      failure: this.failure
    }
  }

  destroy(): void {
    this.#release()
    this.#live?.close()
  }

  /** Lets go of the view: a closed tab's, or a discarded one's. */
  #release(): void {
    // Before the disposers, because a timer that survives a closed tab fires into a destroyed view.
    this.#cancelCapture()
    for (const dispose of this.#disposers) dispose()
    this.#disposers = []
  }
}
