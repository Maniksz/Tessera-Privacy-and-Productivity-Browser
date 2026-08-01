import { WebContentsView, type Session } from 'electron'
import type { SecurityState, TabState } from '@shared/model.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { Rect } from '@shared/split/layout.js'
import { isHomeUrl } from '@shared/url/omnibox.js'
import type { HistoryRecorder } from '@shared/history/model.js'
import { type FaviconCache, faviconDomainOf, faviconUrl } from '@shared/favicons/model.js'
import type { ThumbnailCapturer } from '@shared/thumbnails/model.js'
import type { PageContextTarget } from '../menu/page-context-items.js'
import { mouseMoveY } from '@shared/gestures/pointer.js'
import type { ZoomDirection } from '@shared/gestures/zoom.js'
import { clampZoomPercent, effectiveZoomPercent, type PaneZoom } from '@shared/zoom/model.js'
import { sequenceOfTabId, tabIdForSequence } from '@shared/session/tab-ids.js'
import { INTERNAL_SCHEME } from '@shared/product.js'
import { applyWebRtcPolicy } from '../session/hardening.js'
import { preloadFile, preloadRoleArgument } from '../paths.js'
import { pageKeystrokeOf, type PageKeystroke } from './page-keys.js'
import {
  decideTabNavigation,
  pendingNavigationOf,
  type NavigationSource
} from './navigation-policy.js'
import { decideAutomaticNavigation, withinGestureWindow } from './automatic-navigation.js'
import { isFillGestureInput } from '@shared/passwords/gesture.js'

/**
 * One tab: a full `WebContentsView` with its own renderer process.
 *
 * Every tile in a split layout holds one of these, which is what makes tiles
 * genuinely independent views rather than embedded previews (spec 2) — separate
 * process, own navigation history, own devtools, own audio state.
 */

export interface TabCallbacks {
  onStateChanged(tab: Tab): void
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
   * A pinch or a `Ctrl`-wheel over *this* tab's page.
   *
   * Per tile without any work, and worth saying why: this arrives on the tab's own `webContents`, so
   * the page that received the gesture is the page the gesture is about. The navigation gestures have
   * a whole function for that question (`decideNavigationGesture`) only because their events reach the
   * window carrying no position at all.
   *
   * Reported rather than applied here because the step belongs to the ladder in `gestures/zoom.ts`,
   * which both this and the menu's zoom go through so the two cannot disagree.
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
  readonly view: WebContentsView

  #pinned = false
  #ephemeral: boolean
  #pendingInput: string | null = null
  #tileIndex: number | null = null
  #blockedRequests = 0
  #certificateError = false
  #faviconUrls: string[] = []

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
   * The address and title of a tab session restore brought back discarded.
   *
   * Held as one field because they are only ever valid as a pair — the same reason `#favicon` is. Non-null
   * means "in the strip, nothing fetched": `toState` reports the saved address and title so the strip is not a
   * row of blanks, and `unloaded: true` so the interface can mark it.
   *
   * The point is what a restore costs. A window of twenty saved tabs that loaded them all would make twenty
   * requests nobody asked for, on a connection that may be metered — so only the tabs a *tile* shows load, and
   * the rest wait until they are activated. See `loadTimingFor`.
   */
  #deferred: { url: string; title: string } | null = null

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
  #disposers: Array<() => void> = []

  private readonly getSettings: () => SettingsSnapshot
  private readonly callbacks: TabCallbacks
  private readonly wiring: TabWiring

  constructor(options: TabOptions) {
    this.id = options.id
    this.getSettings = options.getSettings
    this.callbacks = options.callbacks
    this.#ephemeral = options.ephemeral ?? false
    this.#zoomPercent = options.zoomPercent ?? null
    this.wiring = options.wiring

    const settings = options.getSettings()

    this.view = new WebContentsView({
      webPreferences: {
        session: options.session,
        /*
          The content bundle, which is the one that has no chrome bridge in it at all.

          A visited page gets no bridge (spec 6); a `tessera://` page gets a narrow allowlist, decided
          from its own address. Both live in this one file because both are shown in *this* view — a
          tab starts on the start page and goes wherever the user types, and a preload is fixed when
          the view is created.

          The role argument is the cross-check rather than the switch: it lets the bundle notice it was
          handed to a view the core created for the chrome UI. See `preloadFile` in `paths.ts`.
        */
        preload: preloadFile('content'),
        additionalArguments: [preloadRoleArgument('content')],
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        /**
         * The single most important option for split view.
         *
         * Chromium throttles timers and rendering in content it considers
         * backgrounded. In a 2x2 grid, three of four tiles look backgrounded to
         * Chromium, and their videos would stutter or stall — the exact failure
         * spec 2 rules out. This turns it off per view; the command-line
         * switches in `runtime-flags.ts` cover the process-level equivalent.
         */
        backgroundThrottling: settings['splitView.throttleInactiveTiles'],
        /**
         * The zoom, ahead of the first paint — the only apply point there is before a document has
         * committed, because `setZoomFactor` acts on the origin a view is on and a view that has
         * loaded nothing has none. Without it, a session restored at 200 % and every pane on a
         * profile whose `appearance.defaultZoom` is not 100 would paint wrong and snap, on every
         * launch. A default only: Chromium's per-origin level wins once one exists, which is why
         * `did-navigate` re-asserts.
         */
        zoomFactor:
          effectiveZoomPercent(this.#zoomPercent, settings['appearance.defaultZoom']) / 100,
        spellcheck: settings['advanced.spellcheck'],
        autoplayPolicy:
          settings['splitView.autoplayInTiles'] === 'allow'
            ? 'no-user-gesture-required'
            : 'user-gesture-required'
      }
    })

    applyWebRtcPolicy(this.view.webContents, settings)
    this.#wireEvents()
  }

  #wireEvents(): void {
    const wc = this.view.webContents
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

    on('focus', () => this.callbacks.onFocused(this))

    /*
      Pinch and `Ctrl`-wheel, which on a laptop is the only zoom there is.

      Chromium raises this on the view under the pointer, not the focused one — the same routing it uses
      for scrolling — so with four pages on screen the gesture lands on the page being looked at. That is
      the behaviour asked for, and it comes free: no tile has to be worked out.

      The direction is read defensively because it comes from an untyped event payload, and an unknown
      value must do nothing rather than be treated as one of the two.
    */
    on('zoom-changed', (...args: unknown[]) => {
      const [, direction] = args
      if (direction !== 'in' && direction !== 'out') return
      this.callbacks.onZoomGesture(this, direction)
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

      // Gated on the setting here rather than further up: this runs per mouse move in every tile, which is
      // exactly the cost `splitView.tileBarMode: 'keyboard'` exists to remove on a machine that cannot
      // afford it.
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
      this.#certificateError = false
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
      // The pane's zoom, put back after every commit — not a leftover from the per-domain register
      // this line used to read, and worth saying so before somebody deletes it as one. Chromium's
      // zoom is same-origin per session, so re-asserting is what keeps the value the pane's rather
      // than whatever another pane last left this origin at.
      this.applyZoom()
      notify()
    })
    /*
      A client-side route change commits a new address without a new document, so `did-navigate`
      never fires for it. The blocker attributes a refused request by address, and a single-page
      application that moved route would otherwise credit every advert it then fetched to nobody.
    */
    on('did-navigate-in-page', () => {
      this.#currentUrl = wc.getURL()
      notify()
    })
    on('page-favicon-updated', (...args: unknown[]) => {
      const favicons = args[1]
      this.#faviconUrls = Array.isArray(favicons) ? favicons.filter((url): url is string => typeof url === 'string') : []
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
    on('media-started-playing', notify)
    on('media-paused', notify)
    on('did-fail-load', notify)
    on('destroyed', notify)

    // Fullscreen requests from the page. The window-level suppression that
    // keeps this inside the tile lives in `BrowserWindowController`.
    on('enter-html-full-screen', () => this.callbacks.onEnterHtmlFullscreen(this))
    on('leave-html-full-screen', () => this.callbacks.onLeaveHtmlFullscreen(this))

    on('certificate-error', () => {
      this.#certificateError = true
      notify()
    })

    /*
      Navigation to an internal address that this browser did not start.

      The decision is in `navigation-policy.ts` rather than here, and for the reason `page-keys.ts` was
      split off one subscription up: this file cannot run outside a browser process and is excluded from
      coverage, so a security rule written here would be a rule no test can put a question to.

      Two events, judged differently — `will-frame-navigate` for the main frame and every subframe,
      `will-redirect` for a `Location:` header, which is also how this browser's own HTTPS-only
      interstitial arrives. That module argues all of it, including why nothing the core itself
      navigates ever reaches this handler.
    */
    const guardNavigation =
      (source: NavigationSource) =>
      (...args: unknown[]): void => {
        const pending = pendingNavigationOf(args[0], source)
        if (pending === null) return
        const decision = decideTabNavigation(pending)
        if (decision.allowed) return
        pending.prevent()
        // Silent to the page on purpose — a site must not learn what this browser serves — but never
        // silent to a developer. The rule `decideAccess` set: a refusal that says nothing is a refusal
        // nobody can tell from a bug.
        console.warn(`[navigation] refused: ${decision.reason}`)
      }

    on('will-frame-navigate', guardNavigation('frame'))
    on('will-redirect', guardNavigation('redirect'))

    /*
      The page sending itself somewhere, gated on whether anybody asked for it.

      Registered *after* the privilege guard above and reached only if that one let the navigation
      through, which is the right order: an internal address is refused outright and never becomes a
      question for the user.

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

    // A page calling window.close() should close its tab, not silently do
    // nothing.
    on('close', () => this.callbacks.onCloseRequested(this))
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
    void this.view.webContents.loadURL(url).catch(() => {
      // Load failures surface through `did-fail-load` and the error page; a
      // rejected promise here is not additionally interesting.
    })
  }

  goBack(): void {
    const history = this.view.webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
  }

  goForward(): void {
    const history = this.view.webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
  }

  reload(ignoreCache: boolean): void {
    if (ignoreCache) this.view.webContents.reloadIgnoringCache()
    else this.view.webContents.reload()
  }

  stop(): void {
    this.view.webContents.stop()
  }

  /**
   * True while this tab is still fetching something.
   *
   * A getter rather than a second `isLoading()` call at the one other place that wants it, because
   * `toState` and the `Escape` decision must not be able to disagree about whether a load is in flight
   * — that is the whole question `stop` turns on.
   */
  get loading(): boolean {
    const wc = this.view.webContents
    return !wc.isDestroyed() && wc.isLoading()
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
    const wc = this.view.webContents
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'bottom' })
  }

  // --- audio ---------------------------------------------------------------

  setMuted(muted: boolean): void {
    this.view.webContents.setAudioMuted(muted)
    this.callbacks.onStateChanged(this)
  }

  get muted(): boolean {
    return this.view.webContents.isAudioMuted()
  }

  // --- zoom ----------------------------------------------------------------

  /**
   * Zoom belongs to the pane, not to the site. Spec 1 said the opposite — "the same page open twice
   * must look the same in both tabs" — and this was a `Map` from registrable domain to percentage.
   * **The user reversed it on 29.07.2026**, and the consequence belongs in the same breath as the
   * decision: *two tiles showing the same page no longer zoom together*, and a pane left at 200 %
   * stays there for whatever is opened in it. `shared/zoom/model.ts` has the rest — what was
   * rejected on the way, and the one part of this Chromium will not give us.
   */
  applyZoom(): void {
    this.view.webContents.setZoomFactor(this.zoomPercent / 100)
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
    this.callbacks.onStateChanged(this)
  }

  get faviconUrls(): readonly string[] {
    return this.#faviconUrls
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
    this.#deferred = deferred
    this.callbacks.onStateChanged(this)
  }

  /** Loads a discarded tab, once. A no-op for a tab that already has content. */
  loadIfDeferred(): void {
    const deferred = this.#deferred
    if (deferred === null) return
    // Cleared first: `loadUrl` triggers state changes, and a `toState` during them must already report the
    // real address rather than the saved one.
    this.#deferred = null
    this.loadUrl(deferred.url)
  }

  /** Milliseconds since the core last saw real input in this view, or `null` if it never has. */
  #sinceGesture(): number | null {
    return this.#lastGestureAt === null ? null : Date.now() - this.#lastGestureAt
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

  #securityState(): SecurityState {
    const url = this.view.webContents.getURL()
    if (url === '' || url.startsWith(INTERNAL_SCHEME) || url.startsWith('about:')) return 'internal'
    if (this.#certificateError) return 'invalid-certificate'
    return url.startsWith('https:') ? 'secure' : 'insecure'
  }

  toState(): TabState {
    const wc = this.view.webContents
    const destroyed = wc.isDestroyed()
    const history = destroyed ? null : wc.navigationHistory

    return {
      id: this.id,
      url: this.#deferred?.url ?? (destroyed ? '' : wc.getURL()),
      pendingInput: this.#pendingInput,
      title: this.#deferred?.title ?? (destroyed ? '' : wc.getTitle()),
      faviconUrl: this.#favicon?.url ?? null,
      loading: this.loading,
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false,
      pinned: this.#pinned,
      muted: destroyed ? false : wc.isAudioMuted(),
      audible: destroyed ? false : wc.isCurrentlyAudible(),
      security: destroyed ? 'internal' : this.#securityState(),
      blockedRequests: this.#blockedRequests,
      // The stored value, not the effective one: the session slot is filled from this and the file
      // has to be able to say "never zoomed". The number is ours rather than something read back
      // off Chromium, so a destroyed view no longer comes into it. See `PaneZoom`.
      zoomPercent: this.#zoomPercent,
      tileIndex: this.#tileIndex,
      unloaded: this.#deferred !== null
    }
  }

  destroy(): void {
    // Before the disposers, because a timer that survives a closed tab fires into a destroyed view.
    this.#cancelCapture()
    for (const dispose of this.#disposers) dispose()
    this.#disposers = []
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close()
    }
  }
}
