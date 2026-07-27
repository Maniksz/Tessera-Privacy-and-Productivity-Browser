import { WebContentsView, type Session } from 'electron'
import type { SecurityState, TabState } from '@shared/model.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { Rect } from '@shared/split/layout.js'
import { registrableDomain } from '@shared/url/domain.js'
import { isHomeUrl } from '@shared/url/omnibox.js'
import type { HistoryRecorder } from '@shared/history/model.js'
import { type FaviconCache, faviconDomainOf, faviconUrl } from '@shared/favicons/model.js'
import type { ThumbnailCapturer } from '@shared/thumbnails/model.js'
import type { PageContextTarget } from '../menu/page-context-items.js'
import { mouseMoveY } from '@shared/gestures/pointer.js'
import type { ZoomDirection } from '@shared/gestures/zoom.js'
import { sequenceOfTabId, tabIdForSequence } from '@shared/session/tab-ids.js'
import { INTERNAL_SCHEME } from '@shared/product.js'
import { applyWebRtcPolicy } from '../session/hardening.js'
import { preloadFile, preloadRoleArgument } from '../paths.js'
import { pageKeystrokeOf, type PageKeystroke } from './page-keys.js'

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
  /** Link opened with target=_blank or middle-click. */
  onOpenNewTab(url: string, options: { background: boolean }): void
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
  #disposers: Array<() => void> = []

  private readonly getSettings: () => SettingsSnapshot
  private readonly callbacks: TabCallbacks
  private readonly wiring: TabWiring

  constructor(options: TabOptions) {
    this.id = options.id
    this.getSettings = options.getSettings
    this.callbacks = options.callbacks
    this.#ephemeral = options.ephemeral ?? false
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
      if (this.getSettings()['splitView.tileBarMode'] !== 'hover') return
      const [, input] = args
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
      // Navigating anywhere real makes this a tab the user is using, so it stops being
      // disposable. Checked against the home address rather than a counter: a filler that
      // was reloaded is still a filler.
      if (this.#ephemeral && !isHomeUrl(wc.getURL())) this.#ephemeral = false
      // The store decides what is worth keeping — internal pages, `data:` addresses and the rest
      // are refused there, so this stays a plain report rather than a second policy.
      this.wiring.history.recordVisit({ url: wc.getURL(), title: wc.getTitle() })
      this.#faviconUrls = []
      /*
        The icon survives a navigation within the same site, and only that.

        Clearing it unconditionally would blank the tab on every click through a site and then bring
        the same picture back a moment later — a flicker on every page load. Keeping it
        unconditionally would show the previous site's icon next to the new site's title, which is
        worse than showing none: at a glance the tab claims to be somewhere it is not.
      */
      if (this.#favicon !== null && faviconDomainOf(wc.getURL()) !== this.#favicon.site) {
        this.#favicon = null
      }
      this.applyZoomForCurrentDomain()
      notify()
    })
    on('did-navigate-in-page', notify)
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

    // window.open and target=_blank become tabs, never popups we do not control.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:/i.test(url)) {
        this.callbacks.onOpenNewTab(url, { background: disposition === 'background-tab' })
      }
      return { action: 'deny' }
    })

    // A page calling window.close() should close its tab, not silently do
    // nothing.
    on('close', () => this.callbacks.onCloseRequested(this))
  }

  // --- geometry ------------------------------------------------------------

  setBounds(rect: Rect): void {
    this.view.setBounds(rect)
  }

  setVisible(visible: boolean): void {
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
   * Zoom is per domain, not per tab (spec 1): the same site opened twice must
   * look the same in both tabs.
   */
  applyZoomForCurrentDomain(): void {
    const percent = zoomRegistry.get(this.domain(), this.getSettings()['appearance.defaultZoom'])
    this.view.webContents.setZoomFactor(percent / 100)
  }

  setZoomPercent(percent: number): void {
    const clamped = Math.min(300, Math.max(30, Math.round(percent)))
    zoomRegistry.set(this.domain(), clamped)
    this.view.webContents.setZoomFactor(clamped / 100)
    this.callbacks.onStateChanged(this)
  }

  get zoomPercent(): number {
    return Math.round(this.view.webContents.getZoomFactor() * 100)
  }

  domain(): string {
    try {
      const { hostname } = new URL(this.view.webContents.getURL())
      return hostname === '' ? '' : registrableDomain(hostname)
    } catch {
      return ''
    }
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
      zoomPercent: destroyed ? 100 : this.zoomPercent,
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

/**
 * Per-domain zoom levels.
 *
 * In memory for now; belongs in the encrypted local store alongside history and
 * bookmarks (spec 3) so it survives a restart as spec 1 requires.
 */
class ZoomRegistry {
  readonly #levels = new Map<string, number>()

  get(domain: string, fallback: number): number {
    return this.#levels.get(domain) ?? fallback
  }

  set(domain: string, percent: number): void {
    if (domain === '') return
    this.#levels.set(domain, percent)
  }
}

export const zoomRegistry = new ZoomRegistry()
