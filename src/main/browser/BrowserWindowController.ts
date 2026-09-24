import { app, BrowserWindow, screen, type Session } from 'electron'
import { join } from 'node:path'
import type { ChromeInsets, WindowState } from '@shared/model.js'
import type { EventChannel } from '@shared/ipc/channels.js'
import type { EventPayload } from '@shared/ipc/contract.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { Fractions, LayoutId, Rect } from '@shared/split/layout.js'
import { chromeInsetsFor } from '@shared/split/chrome-insets.js'
import { decideAutomaticNavigation } from './automatic-navigation.js'
import { decideChromeNavigation, pendingNavigationOf } from './navigation-policy.js'
import { AutomaticNavigationPrompt } from './AutomaticNavigationPrompt.js'
import { HOME_URL, resolveOmniboxInput } from '@shared/url/omnibox.js'
import {
  TILE_BOUND_KINDS,
  downloadsPanelPresentation,
  downloadsPanelUpdate,
  type DownloadsPanelPresentation,
  type OverlayKind,
  type OverlayPresentation,
  type OverlayRequest,
  type OverlayState
} from '@shared/overlay/surface.js'
import type { DownloadEntry } from '@shared/downloads/model.js'
import { Tab, adoptTabId, nextTabId, type TabWiring } from './Tab.js'
// The seams' *types* only: what each one is, and what it may reach, both live in `window-seams.ts`.
import { createWindowSeams, type WindowSeams } from './window-seams.js'
import { wireWindowEvents } from './window-events.js'
import type { LayoutChangeOptions } from './TileOccupancyController.js'
import { chromeWindowOptions } from './window-options.js'
import type { TileBarRequest } from '@shared/split/tile-bar.js'
import { nextZoomPercent } from '@shared/gestures/zoom.js'
import { decideZoomTarget } from '@shared/gestures/wheel-zoom.js'
import type { PaneZoom } from '@shared/zoom/model.js'
import type { PageContextTarget } from '../menu/page-context-items.js'
import type { PermissionHost } from '../permissions/PermissionArbiter.js'
import type { PermissionTabChange } from '../permissions/model.js'
import type { TabGroupBook } from '../data/TabGroupStore.js'
import type { ArrangementBook } from '../data/ArrangementStore.js'
import type { SessionRecorder } from '@shared/session/model.js'
import { storablePlacement, type OpeningPlacement } from '@shared/window-placement/model.js'
import type { PlacementRecorder } from '../data/WindowPlacementStore.js'
import type { SplitSnapshotForPersistence } from './SplitController.js'
import { OverlayLayer } from './OverlayLayer.js'
import { SplitController, type TileDirection } from './SplitController.js'
import { currentPlatform, preloadFile, preloadRoleArgument } from '../paths.js'
import { devServerUrl } from '../startup-flags.js'
import { isInternalPageUrl } from '../ipc/sender-policy.js'
import { tabsHiddenByCollapse } from '@shared/tabgroups/model.js'
import { planViews } from '@shared/browser/view-visibility.js'
import { tabForStripPosition, type StripPosition } from './tab-strip-position.js'
import { CloseTabFallback, pageKeyAction, type PageKeystroke } from './page-keys.js'
import { CloseContract, askToLeave, hostOf, preventDefaultOf } from './unload-guard.js'
import { TabDiscards } from './tab-unloader.js'
import { PermissionTabs } from './permission-tabs.js'
import { loadAfterProxyRule } from '../session/proxy.js'

/**
 * One browser window: its chrome UI, its tabs, its split layout.
 *
 * Three layers, bottom to top: the window's own `webContents` renders the chrome, each tab is a
 * `WebContentsView` above it, and the overlay layer is above those. The renderer measures its own
 * chrome and reports the insets, so the two can never disagree about where content begins.
 *
 * Decisions that do not need a window live behind seams — `TabDragController`,
 * `TileOccupancyController`, `TileFullscreenController` — so they can be tested directly.
 */

export interface WindowControllerOptions {
  session: Session
  /** Everything this window's tabs write into, already bound to its browsing mode. See `TabWiring`. */
  wiring: TabWiring
  /** This window's groups, already bound to its browsing mode; see `TabGroupStore.bookFor`. */
  tabGroups: TabGroupBook
  /** This window's recorded tilings, bound the same way; see `ArrangementStore.bookFor`. */
  arrangements: ArrangementBook
  /**
   * This window's slot in the saved session, already bound to its browsing mode; see
   * `SessionStore.recorderFor`. A private window's discards, so there is no flag here to forget.
   *
   * Named `sessionSlot` and not `session`: that name is already the Electron `Session` above.
   */
  sessionSlot: SessionRecorder
  /** Where this window opens; see `placeNewWindow`. */
  placement: OpeningPlacement
  /**
   * Where this window's placement is remembered, already bound to its browsing mode; see
   * `WindowPlacementStore.recorderFor`. A private window's keeps nothing.
   */
  placementRecorder: PlacementRecorder
  /** The layout a restored window opens in, dividers included. Omitted for a fresh window. */
  initialSplit?: Partial<SplitSnapshotForPersistence>
  privateMode: boolean
  /**
   * The user right-clicked a page.
   *
   * Handled above the window rather than in it, because the menu needs the language, the blocker's state and
   * the element picker — none of which a window holds, and all of which the entry point already has.
   */
  onPageContextMenu(tab: Tab, target: PageContextTarget): void
  getSettings(): SettingsSnapshot
  onClosed(controller: BrowserWindowController): void
  /** A tab has gone, closed or with its window; its media finds go with it (media plan R4). */
  onTabClosed(tabId: string): void
  onRequestNewWindow(options: { privateMode: boolean }): void
  /**
   * This window has just presented its downloads panel; `downloadsPanelPresentedAt` already says when.
   *
   * Passed up rather than handled here because the button's summary is computed by the downloads
   * channels from the manager's list, neither of which a window holds.
   */
  onDownloadsPanelPresented(): void
  /**
   * This window's download list as its downloads page is shown it, freshly probed; newest first.
   *
   * What the panel is built from when the chrome UI asks for it (KTD7). Freshly probed because opening
   * the panel is a click, the one moment a stat call per row is worth it — the re-presentations that
   * follow reuse the pushed snapshot instead; see `refreshDownloadsPanel`.
   */
  downloadsPanelEntries(): readonly DownloadEntry[]
}

const DEFAULT_CHROME_INSETS: ChromeInsets = { top: 88, bottom: 0, left: 0, right: 0 }

export class BrowserWindowController implements PermissionHost {
  readonly window: BrowserWindow
  readonly split: SplitController
  readonly privateMode: boolean

  /**
   * The one layer above the tab views.
   *
   * Everything the chrome UI needs to show *over* a page goes here, because the DOM
   * beneath a native view is neither visible nor clickable. See `OverlayLayer`.
   */
  readonly #overlay: OverlayLayer

  readonly #tabs = new Map<string, Tab>()
  /** Tab-bar order, which is independent of tile assignment. */
  #tabOrder: string[] = []
  #closedTabUrls: string[] = []
  #chromeInsets: ChromeInsets = { ...DEFAULT_CHROME_INSETS }
  /**
   * True while the chrome UI has claimed the window for an overlay.
   *
   * Content views are hidden rather than unloaded, so a suspended tile keeps
   * playing and keeps its scroll position — the overlay is a display state, not a
   * lifecycle event.
   */
  #overlayActive = false
  /**
   * The six controllers this window delegates to.
   *
   * Held as one object rather than six fields: the alternative was six declarations here, six assignments in the
   * constructor and six imports, all of which said the same thing the factory's return type already says.
   */
  readonly #seams: WindowSeams
  /**
   * The dialogue for a popup or a redirect the user did not ask for.
   *
   * Assigned in the constructor rather than initialised here, because it needs `presentOverlay` and
   * `dismissOverlay` bound to this instance.
   */
  readonly #navigationPrompt: AutomaticNavigationPrompt
  /** What closing a tab or this window asks first, and what it never asks (KTD5); see `unload-guard.ts`. */
  readonly #close: CloseContract
  /** This window's unloaded tabs: the discard, and the new view on activation (U15); see `tab-unloader.ts`. */
  readonly #discards: TabDiscards<Tab>
  /**
   * The second route to `closeTab`, for the state in which the menu accelerator stops arriving.
   *
   * Every rule about it — why it exists, why it waits instead of guarding, and why a suppression
   * window was the wrong shape — is in `CloseTabFallback`. Here it is only wired: `arm` from the
   * keystroke, `cancel` from every close and from teardown.
   */
  readonly #closeTabFallback = new CloseTabFallback({
    closeTab: (tabId) => this.closeTab(tabId),
    after: (delayMs, run) => {
      const timer = setTimeout(run, delayMs)
      return () => clearTimeout(timer)
    }
  })
  #broadcastScheduled = false
  #disposers: Array<() => void> = []
  /** See `downloadsPanelPresentedAt`. */
  #downloadsPanelPresentedAt: number | null = null
  /** What the permission listeners were last told about each tab, and the telling; see `permission-tabs.ts`. */
  readonly #permissionTabs = new PermissionTabs<Tab>()

  private readonly getSettings: () => SettingsSnapshot
  private readonly options: WindowControllerOptions

  constructor(options: WindowControllerOptions) {
    this.options = options
    this.getSettings = options.getSettings
    this.privateMode = options.privateMode
    /*
      The layout is settled before the window has a single tab, and session restore depends on it.

      `SplitController.assignTab` clamps an out-of-range tile index rather than refusing it, so a window still
      in `1x1` when its restored tabs arrive would put all of them in tile 0, each displacing the last. And
      `setLayout` fills empty tiles with fresh start-page tabs when `splitView.adaptLayoutToTabs` is on — so
      growing the layout afterwards would open renderer processes for panes the saved session never had.
    */
    this.split = new SplitController(
      options.initialSplit ?? { layout: options.getSettings()['splitView.defaultLayout'] }
    )

    this.window = new BrowserWindow(
      chromeWindowOptions({
        privateMode: options.privateMode,
        platform: currentPlatform(),
        preload: preloadFile('chrome'),
        roleArgument: preloadRoleArgument('chrome'),
        bounds: options.placement.bounds
      })
    )

    this.#overlay = new OverlayLayer({
      window: this.window,
      // The chrome UI is told as well as the surface: its button owns `aria-expanded`,
      // and a button claiming a menu is open while the layer has dismissed it is exactly
      // the kind of disagreement two independent copies of state produce.
      onPresentationChanged: (state) => this.emit('overlay:presented', { presentation: state })
    })

    /*
      The six seams, and what each may reach, in one place.

      Built by a factory rather than inline because the interesting fact about them is not their construction but
      their *reach*: `WindowInternals` is the whole surface this window exposes to its own controllers, and every
      closure in that file is visibly a projection of it. Inline, the answer to "what can the drag controller
      touch?" was spread over a hundred lines of closures over private fields.
    */
    const seams = createWindowSeams({
      split: this.split,
      overlay: this.#overlay,
      isDestroyed: () => this.window.isDestroyed(),
      getSettings: () => this.getSettings(),
      contentBounds: () => this.window.getContentBounds(),
      cursorScreenPoint: () => screen.getCursorScreenPoint(),
      contentRect: () => this.#contentRect(),
      setFullScreenable: (allowed) => this.window.setFullScreenable(allowed),
      exitWindowFullscreen: () => this.window.setFullScreen(false),
      enterWindowFullscreen: () => this.window.setFullScreen(true),
      toggleWindowFullscreen: () => this.window.setFullScreen(!this.window.isFullScreen()),
      tab: (tabId) => this.#tabs.get(tabId),
      tabIds: () => [...this.#tabs.keys()],
      tabOrder: () => this.#tabOrder,
      setTabOrder: (order) => {
        this.#tabOrder = [...order]
      },
      assignTabToTile: (tabId, tileIndex) => this.assignTabToTile(tabId, tileIndex),
      closeTab: (tabId) => this.closeTab(tabId),
      activateTab: (tabId) => this.activateTab(tabId),
      setActiveTile: (tileIndex) => this.setActiveTile(tileIndex),
      openFiller: (tileIndex) => {
        this.createTab({ tileIndex, background: true, ephemeral: true })
      },
      applyLayout: (layout, options) => this.#applyLayout(layout, options),
      presentOverlay: (presentation) => this.presentOverlay(presentation),
      relayout: () => this.relayout(),
      broadcast: () => this.#scheduleBroadcast(),
      onOverlayPresentationChanged: (presentation) =>
        this.emit('overlay:presented', { presentation }),
      tabGroups: this.options.tabGroups,
      arrangements: this.options.arrangements
    })

    this.#seams = seams

    /*
      The dialogue for a popup or a redirect nobody asked for.

      Its own small controller rather than a second `PermissionArbiter`: nothing in the page is holding a
      promise here, so a second request arriving while one is on screen is refused instead of queued —
      which is both simpler and the right answer, since a page firing popups in a loop is the case the
      feature exists for. See that file.
    */
    this.#navigationPrompt = new AutomaticNavigationPrompt({
      host: {
        presentOverlay: (presentation) => this.presentOverlay(presentation),
        dismissOverlay: () => this.dismissOverlay()
      }
    })

    this.#close = new CloseContract({
      on: (event, handler) => this.#on(event, handler),
      tab: (tabId) => this.#tabs.get(tabId),
      groups: this.#seams.groups,
      activateTab: (tabId) => this.activateTab(tabId),
      confirm: (prompt) =>
        askToLeave(this.window, prompt, this.getSettings()['appearance.uiLanguage']),
      finish: (tabId, closed) => this.#finishClose(tabId, closed),
      closeWindow: () => this.window.close()
    })
    this.#discards = new TabDiscards<Tab>({
      tab: (tabId) => this.#tabs.get(tabId),
      contract: this.#close,
      contentView: this.window.contentView,
      groups: this.#seams.groups,
      // A restored view asks for permissions under its new id, and the dialogue has to know it (KTD9). Laid
      // out at once: a tab activated while its discard was still settling comes back outside any relayout.
      onViewReplaced: (tab, _oldId, newId) => {
        this.#permissionTabs.replaced(tab, newId)
        this.relayout()
      }
    })

    /*
      What the OS tells this window and what it does about it: ten handlers, in `window-events.ts`, where
      they can be run by a test rather than only read. Which of them belong there and which stayed — `closed`
      and `did-finish-load` — is argued in that file and in `#wireLifecycle` below.
    */
    wireWindowEvents({
      on: (event, handler) => this.#on(event, handler),
      drag: this.#seams.drag,
      overlay: this.#overlay,
      split: this.split,
      fullscreen: this.#seams.fullscreen,
      tileInput: this.#seams.tileInput,
      relayout: () => this.relayout(),
      broadcastWindowState: () => this.#broadcastWindowState(),
      scheduleBroadcast: () => this.#scheduleBroadcast(),
      rememberPlacement: () => this.#rememberPlacement()
    })
    this.#wireLifecycle()
    this.#guardChrome()
    this.#loadChrome()
    this.#seams.fullscreen.applyPolicy()
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Keeps the chrome UI on the document the core loaded into it.
   *
   * This renderer holds every IPC channel there is, so whatever it shows is trusted with all of them
   * — which makes "it shows only what `#loadChrome` put there" a security property, not a nicety.
   * Three ways a page could otherwise replace it, each closed here before the first load:
   *
   *   - `will-frame-navigate`: a dropped link, an assignment to `location`. The core never moves this
   *     view that way (`loadURL` does not fire the event), so `decideChromeNavigation` refuses
   *     everything but Vite's own reload in `pnpm dev`. Only this event, not `will-navigate` as well —
   *     it is the documented superset, the reasoning in `navigation-policy.ts`.
   *   - `setWindowOpenHandler`: nothing in the chrome UI opens a window, so every request is denied.
   *   - `will-attach-webview`: `webviewTag` is off, and this is what holds if it is ever switched on.
   *
   * Through `#on`, so the listeners go with the window like every other subscription here. The IPC
   * router checks the address on every call as well (`classifySender`), because a guard that cannot
   * see the core's own loads cannot be the only line.
   */
  #guardChrome(): void {
    const contents = this.window.webContents
    const devServer = devServerUrl(process.env, { packaged: app.isPackaged })

    this.#on(
      'will-frame-navigate',
      (details: unknown) => {
        const pending = pendingNavigationOf(details, 'frame')
        if (pending === null) {
          // A payload this build does not recognise is refused rather than waved through: for
          // this surface there is no navigation it would have been right to follow.
          preventDefaultOf(details)
          return
        }
        const decision = decideChromeNavigation(pending, devServer)
        if (decision.allowed) return
        pending.prevent()
        console.warn(`[chrome] refused: ${decision.reason}`)
      },
      contents
    )
    this.#on(
      'will-attach-webview',
      (event: unknown) => {
        preventDefaultOf(event)
        console.warn('[chrome] refused: the chrome UI may not attach a <webview>')
      },
      contents
    )
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }

  #loadChrome(): void {
    const devServer = devServerUrl(process.env, { packaged: app.isPackaged })
    if (devServer !== null) {
      void this.window.loadURL(devServer)
    } else {
      void this.window.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  /**
   * Subscribes, and registers the way off in the same breath (spec 6).
   *
   * The two used to be written apart — seven `window.on` calls and, twenty lines below, seven
   * `removeListener` calls naming the same events and handlers. An eighth subscription added to the
   * first list and not the second leaves a listener firing into a closed window, and nothing in the
   * shape of the code makes that omission visible. Pairing them here makes it impossible.
   *
   * Same helper and same reason as the one inside `Tab.#wireEvents`.
   *
   * Reached from `window-events.ts` as `WindowEventHost.on` rather than copied into it: the disposers are
   * this window's, and the pairing only means anything where the thing being torn down lives.
   *
   * The window by default; `#guardChrome` passes the window's `webContents`, whose navigation events
   * are not the window's.
   */
  #on(
    event: string,
    handler: (...args: unknown[]) => void,
    emitter: NodeJS.EventEmitter = this.window
  ): void {
    emitter.on(event, handler)
    this.#disposers.push(() => {
      emitter.removeListener(event, handler)
    })
  }

  /**
   * The events about this window's own existence: it can be shown, its chrome has loaded, and it is gone.
   *
   * The nine reactions to the OS moved to `window-events.ts`; these did not, and `closed` is the reason. It
   * disposes the listeners, destroys the overlay and every tab, closes the session slot and hands the window
   * back to whoever opened it — private fields, all of them. Passing a module enough to do that means passing
   * it the whole window, which is the reach that extraction exists to remove.
   *
   * `ready-to-show` and `did-finish-load` are this window reporting on itself rather than the OS speaking,
   * and neither carries a disposer: the first is a `once` that dies with the window it is registered on, the
   * second is on the `webContents`, which die with the window too.
   */
  #wireLifecycle(): void {
    /*
      The window goes up at the first paint, not at the end of the load.

      Showing on `did-finish-load` meant showing once the chrome bundle had run and React had mounted, so
      launching the browser produced nothing at all on screen for as long as that took and then popped a
      finished window into existence. `ready-to-show` is Chromium reporting that the window can be raised
      without a flash, which is a good deal earlier — and it is only true because `window-options.ts`
      already sets `backgroundColor` to the chrome's own `--bg`, so the frame the user sees first is an
      empty window in the right colour rather than a white rectangle.

      Repeated on `did-finish-load` because the two failures do not cost the same: raising a window twice
      is a no-op behind `isVisible`, while a first paint that never arrives would leave the user with no
      window at all. `once` on both, so a later reload of the chrome cannot pull a window back in front of
      whatever the user has since put over it.
    */
    const show = (): void => {
      if (this.window.isDestroyed() || this.window.isVisible()) return
      // Maximised here rather than at construction: `maximize` shows a hidden window on Windows and
      // Linux, which before the first paint would be the empty frame this whole function avoids.
      if (this.options.placement.maximized) this.window.maximize()
      this.window.show()
    }
    this.window.once('ready-to-show', show)
    this.window.webContents.once('did-finish-load', show)

    this.window.webContents.on('did-finish-load', () => {
      this.#broadcastWindowState()
      this.#scheduleBroadcast()
    })

    this.window.on('closed', () => {
      /*
        Anything still waiting on a tab here is refused before the listeners go. The overlay reports
        only the prompt it shows, so without this a question waiting in a background tab would be left
        pending on a window that no longer exists.
      */
      this.#permissionTabs.gone()
      for (const dispose of this.#disposers) dispose()
      this.#disposers = []
      // A timer outliving the window it would act on is the same class of leak the disposers above
      // exist for, so it goes in the same breath.
      this.#closeTabFallback.cancel()
      this.#overlay.destroy()
      // Before the tabs go: a close still waiting on a page finishes nothing in a window that is gone.
      this.#close.dispose()
      for (const tab of this.#tabs.values()) {
        tab.destroy()
        this.options.onTabClosed(tab.id)
      }
      this.#tabs.clear()
      // The window's slot goes with it. `SessionStore.seal()` is what keeps this from rewriting the session
      // during shutdown, when every window closes and none of them means it.
      this.options.sessionSlot.close()
      this.options.onClosed(this)
    })
  }

  destroy(): void {
    if (!this.window.isDestroyed()) this.window.destroy()
  }

  /**
   * Hands where this window is to the placement recorder.
   *
   * The *normal* bounds, so a maximised window stores the size it returns to beside the flag. Nothing
   * while fullscreen or minimised: the first is not a place to reopen in, and the second reports a
   * rectangle — or on some platforms a position far off screen — that says nothing about where the
   * window will be once it is restored. Hidden too, which is a window still waiting for its first
   * paint and not yet anywhere the user put it.
   */
  #rememberPlacement(): void {
    const window = this.window
    if (window.isDestroyed() || !window.isVisible()) return
    if (window.isFullScreen() || window.isMinimized()) return
    const placement = storablePlacement(window.getNormalBounds(), window.isMaximized())
    if (placement !== null) this.options.placementRecorder.record(placement)
  }

  // --- tabs ----------------------------------------------------------------

  createTab(
    options: {
      url?: string
      tileIndex?: number | null
      background?: boolean
      /** Opened by the browser to fill a tile; disposable until the user navigates it. */
      ephemeral?: boolean
      /**
       * The id this tab had in a previous run, for session restore only.
       *
       * `adoptTabId` raises the id counter past it in the same call, so a restored id can never be handed to a
       * later fresh tab. See `@shared/session/tab-ids.ts`.
       */
      id?: string
      /**
       * Bring the tab back discarded: in the strip, with its address and title, having fetched nothing until it
       * is activated. See `loadTimingFor` for why a restore must not fetch, and why a tab in a tile is the
       * exception.
       */
      deferred?: { url: string; title: string }
      /** Session restore only. At construction, because nothing applies zoom before the first paint. */
      zoomPercent?: PaneZoom
    } = {}
  ): Tab {
    const tab = new Tab({
      id: options.id === undefined ? nextTabId() : adoptTabId(options.id),
      session: this.options.session,
      wiring: this.options.wiring,
      getSettings: this.getSettings,
      ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
      ...(options.zoomPercent === undefined ? {} : { zoomPercent: options.zoomPercent }),
      callbacks: {
        onStateChanged: (source) => {
          this.#permissionTabs.navigated(source, source.currentUrl)
          this.#scheduleBroadcast()
        },
        /*
          A tab a page asked for, which is not the same as a tab the user asked for.

          Every one of these used to open unconditionally. `userGesture` comes from the tab, because only
          the view that received the input knows whether it did — with four pages on screen, a click in
          one tile is not consent to a popup from another.

          The decision is made here rather than in the tab because it needs the settings and, for `ask`,
          a dialogue on this window's overlay layer.
        */
        onOpenNewTab: (url, { background, userGesture }) => {
          const decision = decideAutomaticNavigation({
            kind: 'popup',
            url,
            documentUrl: url,
            // The tab has already applied the window; this only has to say whether there was one.
            sinceGestureMs: userGesture ? 0 : null,
            gate: this.getSettings()['privacy.pageOpenedTabs']
          })
          if (decision.action === 'allow') {
            this.createTab({ url, background, tileIndex: null })
            return decision.spendsGesture
          }
          if (decision.action === 'block') {
            console.warn(`[popup] refused: ${decision.reason} (${url})`)
            return decision.spendsGesture
          }
          this.#navigationPrompt.ask({ kind: 'popup', url, host: hostOf(url) }, (permitted) => {
            // Guarded because the answer arrives later: the window may be gone by then.
            if (!permitted || this.window.isDestroyed()) return
            this.createTab({ url, background, tileIndex: null })
          })
          return decision.spendsGesture
        },
        /*
          The page sending itself somewhere else. Already stopped by the time this runs; `allow` re-issues
          it as a load the core owns. See the subscription in `Tab.ts` and the reasoning in
          `automatic-navigation.ts`.
        */
        onAutomaticNavigation: (_source, url, allow) => {
          this.#navigationPrompt.ask({ kind: 'navigation', url, host: hostOf(url) }, allow)
        },
        onFocused: (source) => this.#handleTabFocused(source),
        onFailureChanged: () => this.relayout(),
        onEnterHtmlFullscreen: (source) => this.#seams.fullscreen.onPageEnter(source.id),
        onLeaveHtmlFullscreen: () => this.#seams.fullscreen.onPageLeave(),
        onCloseRequested: (source) => this.closeTab(source.id),
        onContextMenu: (source, target) => this.options.onPageContextMenu(source, target),
        onPointerMoved: (source, y) => {
          const tileIndex = source.tileIndex
          // A tab with no tile is loaded but off screen, so there is no strip to reveal.
          if (tileIndex === null) return
          this.requestTileBar({ invokedBy: 'pointer', tileIndex, y })
        },
        /*
          One pane zooms, and which one depends on where the hand is.

          For `Ctrl`-wheel it is the pane the gesture landed on, whichever tile that is and whether or
          not it is active — the user's reversal of spec 1 on 29.07.2026, unchanged. `Tab`'s zoom
          section carries that decision and its consequence: two tiles showing one page no longer zoom
          together.

          For a trackpad pinch it is the **focused** tile, which was asked for afterwards and is not a
          contradiction: on a mouse the hand is on the pointer, so the pointer names a pane; on a
          trackpad the hand is on the pad and the pointer is wherever it was last left, so it names
          nothing. `decideZoomTarget` holds both rules and the argument; the two are told apart by
          `isPinching`, which reads the browser process's own gesture bracket rather than guessing
          from the wheel deltas.

          Through `setZoomPercent` rather than the view's own zoom, because the view's factor is
          Chromium's per-origin state and this one is the pane's. Only this one survives a navigation
          somewhere else, and only this one reaches the session file.
        */
        onZoomGesture: (source, direction) => {
          const targetId = decideZoomTarget({
            pinch: source.isPinching,
            senderTabId: source.id
          })
          // `null` is a trackpad pinch, which Chromium has already applied as visual zoom — applying
          // it again here would zoom the pane twice by two mechanisms. See `decideZoomTarget`.
          const target = targetId === null ? undefined : this.resolveTab(targetId)
          if (target === undefined) return
          target.setZoomPercent(nextZoomPercent(target.zoomPercent, direction))
        },
        onPageKeystroke: (source, keystroke) => this.#handlePageKeystroke(source, keystroke)
      }
    })

    this.#tabs.set(tab.id, tab)
    this.#permissionTabs.add(tab, tab.view.webContents.id, tab.currentUrl)
    this.#close.track(tab.id)
    this.#tabOrder.push(tab.id)
    // Index 0: the bottom of the child stack, so the overlay stays above every tab whenever it was
    // added. Appending would put the newest tab above the overlay, swallowing the surface's clicks.
    this.window.contentView.addChildView(tab.view, 0)

    /**
     * Explicit `null` means "load it but leave it out of the grid" — a link opened in the
     * background, which must not disturb the arrangement on screen. An explicit index is session
     * restore and tile filling, both of which know exactly where the tab goes.
     *
     * Everything else is somebody asking for a new tab, and a new tab gets the whole window:
     * `claimTileForNewTab` puts the grid away and returns the one tile that is left. See there for
     * why that does not bring back the empty panes it used to replace.
     */
    const tile =
      options.tileIndex === null
        ? null
        : (options.tileIndex ?? this.#seams.occupancy.claimTileForNewTab())

    if (tile !== null) {
      this.assignTabToTile(tab.id, tile)
      if (!options.background) this.split.setActiveTile(tile)
    }

    if (options.deferred === undefined)
      loadAfterProxyRule(this.options.session, tab, options.url ?? this.#startupUrl())
    else tab.deferLoad(options.deferred)

    this.relayout()
    this.#scheduleBroadcast()
    return tab
  }

  closeTab(tabId: string): void {
    if (!this.#tabs.has(tabId)) return
    /*
      A tab is closing, so a keystroke waiting to close one has been answered — by the menu, by the
      strip's button, by anything. Below the unknown-tab guard on purpose: a request naming a tab that is
      already gone closed nothing, and calling off a real pending close on the strength of it would
      turn the fallback back into the thing it is a fallback for.
    */
    this.#closeTabFallback.cancel()
    this.#close.closeTab(tabId)
  }

  /** The second half of `closeTab`, once the tab has really gone; `CloseContract` decides when. */
  #finishClose(tabId: string, { url, keepOneTab }: { url: string; keepOneTab: boolean }): void {
    const tab = this.#tabs.get(tabId)
    if (!tab) return
    if (url !== '' && !this.privateMode) {
      this.#closedTabUrls.push(url)
      if (this.#closedTabUrls.length > 25) this.#closedTabUrls.shift()
    }

    const vacatedTile = this.split.tileOfTab(tabId)
    this.split.forgetTab(tabId)
    this.#tabOrder = this.#tabOrder.filter((id) => id !== tabId)
    // A group whose last member just closed would otherwise linger as a chip with nothing behind it.
    this.options.tabGroups.removeTab(tabId)
    this.#tabs.delete(tabId)
    this.window.contentView.removeChildView(tab.view)
    tab.destroy()
    this.#discards.forget(tabId)
    // After the tab has left `#tabs` and the split, so the arbiter, reacting, cannot find it in front.
    this.#permissionTabs.closed(tab)
    this.options.onTabClosed(tabId)

    this.#seams.occupancy.afterTabClosed(vacatedTile)

    // A window always keeps a tab: an empty one had a live toolbar acting on nothing, every command a
    // silent no-op. A fresh start page is both the safer state and what the user would open next.
    if (this.#tabs.size === 0 && keepOneTab && !this.window.isDestroyed()) {
      this.createTab({})
      return
    }

    this.relayout()
    this.#scheduleBroadcast()
  }

  reopenClosedTab(): string | null {
    const url = this.#closedTabUrls.pop()
    if (url === undefined) return null
    return this.createTab({ url }).id
  }

  /** What "Reopen Closed Tab" would bring back is history kept in memory; clearing it takes it (KTD7). */
  forgetClosedTabs(): void {
    this.#closedTabUrls = []
  }

  activateTab(tabId: string): void {
    if (!this.#tabs.has(tabId)) return
    // Activating an unloaded tab is what brings it back, out of a folded group too (U15, `TabDiscards.wake`).
    this.#discards.wake(tabId)
    const tile = this.split.tileOfTab(tabId)
    if (tile !== null) {
      this.split.setActiveTile(tile)
    } else {
      /*
        A tab with no tile has two ways back. If a recording seats it and may be applied, the tiling it
        was in comes back — see `ArrangementController.restoreFor`, which also says why the outcome is
        read off the split below rather than reported back. Otherwise the tab gets the window, the way
        a new one does: taking over the active tile instead would replace the page in front of the user
        every time a tab comes out of a folded group, because a fold releases its members' tiles.
      */
      this.#seams.arrangements.restoreFor(tabId)
      if (this.split.tileOfTab(tabId) === null) {
        this.assignTabToTile(tabId, this.#seams.occupancy.claimTileForNewTab())
      }
    }
    this.#focusActiveTab()
    this.relayout()
    this.#scheduleBroadcast()
  }

  /**
   * The positional tab keys: `Ctrl+1`…`Ctrl+8` and `Ctrl+9` (spec 9).
   *
   * Registered as hidden menu items in `tab-position-accelerators.ts`; which tab a position names is
   * `tabForStripPosition`, and that module says why it is neither the tile index nor `#tabOrder` as it
   * stands. A key naming a tab that is not there does nothing, as it does in every browser that has
   * this feature.
   */
  activateTabAtStripPosition(position: StripPosition): void {
    const groups = this.#seams.groups
    const tabId = tabForStripPosition(
      groups.displayOrder(),
      tabsHiddenByCollapse(groups.groups()),
      position
    )
    if (tabId === null) return
    this.activateTab(tabId)
  }

  moveTab(tabId: string, toIndex: number): void {
    const from = this.#tabOrder.indexOf(tabId)
    if (from === -1) return
    const clamped = Math.min(Math.max(toIndex, 0), this.#tabOrder.length - 1)
    this.#tabOrder.splice(from, 1)
    this.#tabOrder.splice(clamped, 0, tabId)
    this.#scheduleBroadcast()
  }

  setTabPinned(tabId: string, pinned: boolean): void {
    this.#tabs.get(tabId)?.setPinned(pinned)
  }

  tab(tabId: string): Tab | undefined {
    return this.#tabs.get(tabId)
  }

  /** Unloads a tab the one timer picked (U15). Nothing happens if its page objects. */
  discardTab(tabId: string): void {
    this.#discards.discard(tabId)
  }

  /**
   * Every tab this window holds, in no particular order.
   *
   * A snapshot, so a caller iterating it cannot be disturbed by a tab closing mid-loop — which is
   * exactly what happens when the thing being looked for is a view that has just gone away.
   */
  get tabs(): readonly Tab[] {
    return [...this.#tabs.values()]
  }

  /**
   * Finds the tab that owns a given `webContents` id.
   *
   * Used to answer "which tab did this internal page send from", so clicking a
   * quick link navigates the view the start page is in rather than whichever tile
   * happens to be active.
   */
  tabForWebContents(webContentsId: number): Tab | undefined {
    for (const tab of this.#tabs.values()) {
      if (tab.view.webContents.isDestroyed()) continue
      if (tab.view.webContents.id === webContentsId) return tab
    }
    return undefined
  }

  /** The tab commands act on when no id is given: the active tile's tab. */
  activeTab(): Tab | undefined {
    const id = this.split.activeTabId()
    return id === null ? undefined : this.#tabs.get(id)
  }

  resolveTab(tabId?: string): Tab | undefined {
    return tabId === undefined ? this.activeTab() : this.#tabs.get(tabId)
  }

  // --- permission questions --------------------------------------------------

  /**
   * `PermissionHost`: the tab a permission dialogue may appear over, as its `webContents` id.
   *
   * The active tile's tab and no other. In a split layout the other tiles are visible too, but the
   * active one is where the user's attention and keyboard are, and clicking into another tile makes
   * that one active — so a question from a visible tile comes up the moment the user turns to it.
   */
  activeTabWebContentsId(): number | null {
    return this.#permissionTabs.idOf(this.activeTab())
  }

  /**
   * `PermissionHost`: tells a listener when the tab in front may have changed, when a tab commits a
   * new address or closes, and when the window goes. Returns the way off.
   *
   * A set with its own unsubscribe rather than `#on`: the arbiter subscribes whenever a queue opens
   * here and unsubscribes whenever it empties, many times over a window's life, and `#disposers` only
   * ever grows. The window's own teardown clears the set as well, in `#wireLifecycle`.
   */
  onPermissionTabChange(listener: (change: PermissionTabChange) => void): () => void {
    return this.#permissionTabs.subscribe(listener)
  }

  // --- navigation ----------------------------------------------------------

  /**
   * Navigates from raw address-bar text. The address-versus-search decision is
   * made here, in the core, so it happens in exactly one place (spec 1).
   */
  navigateFromInput(input: string, tabId?: string): string | null {
    const settings = this.getSettings()
    const url = resolveOmniboxInput(input, {
      engine: settings['search.defaultEngine'],
      customUrl: settings['search.customEngineUrl']
    })
    if (url === null) return null

    const tab = this.resolveTab(tabId) ?? this.createTab({ url })
    tab.loadUrl(url)
    return url
  }

  #startupUrl(): string {
    const settings = this.getSettings()
    switch (settings['session.startupBehaviour']) {
      case 'custom-url':
        return settings['session.customStartupUrl'] || HOME_URL
      case 'blank':
        return 'about:blank'
      default:
        return HOME_URL
    }
  }

  // --- split view ----------------------------------------------------------

  setLayout(layout: LayoutId): void {
    /*
      The one explicit layout change there is, and therefore the only one that fills.

      A layout the user picked gets its empty tiles filled — first from whatever is already loaded
      and hidden, then with start pages. Every other route here is the browser changing the layout on
      its way to something else: a shrink after a close, a drop, a new tab taking the window. Filling
      those would conjure a replacement for the very tab that was just closed, or open pages nobody
      asked for alongside a page somebody did.
    */
    this.#applyLayout(layout, { fill: true, rehome: true })
  }

  #applyLayout(layout: LayoutId, options: LayoutChangeOptions): void {
    /*
      By kind, and that distinction is the whole point rather than tidiness.

      The layout menu's own choice closes it — leaving it up would show a radio state that no longer matches the
      window behind it. But an unconditional `dismiss()` here was a real defect: a layout chosen from the menu
      *accelerator* while a permission prompt is up would take the prompt down, and a prompt that leaves the
      layer is settled the safe way, which is `block`. A consent dialogue answered by an unrelated keystroke.

      Every tile surface goes too, for the reason `#dismissTileBoundSurfaces` gives: their bounds belong to
      tiles that are about to move.
    */
    this.#overlay.dismissKind('layout-menu')
    /*
      The downloads panel as well, by name — nothing derives it. It hangs from a toolbar button that a
      new layout can move, so it goes the way the layout menu does rather than staying up beside a
      button that is no longer where it points.
    */
    this.#overlay.dismissKind('downloads-panel')
    this.#dismissTileBoundSurfaces()
    const changed = this.split.setLayout(layout)
    /*
      Re-clamp the dividers, because a fraction carried over from another layout is correct alone and wrong
      in company.

      Confirmed by running it: `1x2` with the divider dragged to 0.85, then `1x3`, stores `{ v: 0.85,
      v2: 0.667 }` — the first boundary to the *right* of the second. `computeTileRects` clamps its own copy,
      so the tiles render correctly, but `toState()` publishes the unclamped set and `SplitDividers` draws
      handles from it: handle `v` lands on top of the *second* boundary, 240 px from the one it controls.
      The comment in `SplitDividers.tsx` claims the opposite.

      Here rather than inside `setLayout` because this is the only place that sees both the new layout and the
      content size, and `clampColumns` needs both.
    */
    this.split.setFractions({}, this.#contentRect())
    this.#seams.occupancy.afterLayoutChange(changed, options)
    this.#seams.fullscreen.applyPolicy()
    this.relayout()
    this.#scheduleBroadcast()
  }

  setFractions(fractions: Fractions): void {
    // Dragging a divider moves the tiles a `tile` surface's captured rectangle belongs to; see
    // `#dismissTileBoundSurfaces`.
    this.#dismissTileBoundSurfaces()
    this.split.setFractions(fractions, this.#contentRect())
    this.relayout()
    this.#scheduleBroadcast()
  }

  setActiveTile(index: number): void {
    this.split.setActiveTile(index)
    this.#focusActiveTab()
    this.#seams.audio.apply()
    this.relayout()
    this.#scheduleBroadcast()
  }

  moveActiveTile(direction: TileDirection): void {
    if (!this.split.moveActiveTile(direction, this.#contentRect())) return
    this.#focusActiveTab()
    this.#seams.audio.apply()
    this.#scheduleBroadcast()
  }

  assignTabToTile(tabId: string, tileIndex: number | null): void {
    // Same reason as `setFractions`, and one more: the tab under an open tile surface may be about to
    // change or leave, and a bar naming a tab that is no longer in that tile acts on the wrong page.
    this.#dismissTileBoundSurfaces()
    // Whatever used to occupy the target tile becomes unassigned rather than
    // closed (spec 2).
    if (tileIndex !== null) {
      const displaced = this.split.tabIdAt(tileIndex)
      if (displaced !== null && displaced !== tabId) {
        this.#tabs.get(displaced)?.setTileIndex(null)
      }
    }
    this.split.assignTab(tabId, tileIndex)
    this.#tabs.get(tabId)?.setTileIndex(tileIndex)
    // A tile must show something, so an unloaded tab dragged into one comes back now.
    if (tileIndex !== null) this.#discards.wake(tabId)
    this.relayout()
    this.#scheduleBroadcast()
  }

  /** The fullscreen key. Which of the two fullscreens it means is decided in the seam. */
  toggleFullscreen(): void {
    this.#seams.fullscreen.toggleFullscreen()
  }

  toggleTileMaximized(tileIndex?: number): void {
    // Same reason as `setFractions`: every tile's rectangle changes, including the one under an open bar.
    this.#dismissTileBoundSurfaces()
    this.split.toggleTileMaximized(tileIndex)
    this.relayout()
    this.#scheduleBroadcast()
  }

  /**
   * One step back down the escalation ladder (spec 2).
   *
   * Two callers, and they cannot both fire for one press because focus is in one web contents: the
   * chrome renderer's own key handler over `split:escape` (see `App.tsx`) when the toolbar or the tab
   * strip has the keyboard, and `#handlePageKeystroke` below when a page has it. The second is the one
   * that matters in the state this feature exists for — a fullscreen tile hides the chrome, so the
   * renderer never sees the key.
   */
  escape(): void {
    this.#seams.fullscreen.escape()
  }

  /**
   * `Escape`, macOS's `Command+.`, and the close-tab chord, arriving in a page.
   *
   * Every rule is in `page-keys.ts` — including the one that is not visible here: the keystroke is
   * never taken from the page. Whatever this does, the page's own handler and the caret in its text
   * fields get the key as well.
   *
   * The tab that received the key is the one whose load is cancelled and the one the fallback would
   * close, rather than the active tile's: the page the user is looking at is the page that had the
   * focus. The ladder is the window's, so it goes through the window either way.
   */
  #handlePageKeystroke(tab: Tab, keystroke: PageKeystroke): void {
    const action = pageKeyAction(keystroke, currentPlatform(), {
      loading: tab.loading,
      escalation: this.split.escalation
    })

    switch (action) {
      case 'stop-load':
        tab.stop()
        break
      case 'escape-ladder':
        this.escape()
        break
      case 'close-tab':
        // Armed rather than done: the menu accelerator may still be on its way, and `closeTab` above
        // calls this off if it arrives. See `CloseTabFallback`.
        this.#closeTabFallback.arm(tab.id)
        break
      case 'nothing':
        break
    }
  }

  setTileMuted(tileIndex: number, muted: boolean): void {
    this.#seams.audio.setMutedByUser(tileIndex, muted)
    this.#scheduleBroadcast()
  }

  // --- fullscreen ----------------------------------------------------------

  /**
   * Makes the tile the user just clicked into the active one.
   *
   * Deliberately not `setActiveTile`, which focuses the tile's tab: we are here *because*
   * it just took focus, and re-entering focus from a focus handler is how a loop starts.
   */
  #handleTabFocused(tab: Tab): void {
    const tile = this.split.tileOfTab(tab.id)
    if (tile === null || tile === this.split.activeTile) return
    this.split.setActiveTile(tile)
    this.#seams.audio.apply()
    this.relayout()
    this.#scheduleBroadcast()
  }

  // --- geometry ------------------------------------------------------------

  setChromeInsets(insets: ChromeInsets): void {
    this.#chromeInsets = { ...insets }
    this.relayout()
  }

  /** Hides or restores the content views for a chrome-UI overlay. */
  setOverlayActive(active: boolean): void {
    if (this.#overlayActive === active) return
    this.#overlayActive = active
    this.relayout()
  }

  // --- overlay surface -----------------------------------------------------

  /**
   * Puts a surface on the layer, as described — except the downloads panel, which is described by kind
   * and anchor only and whose rows this window fills in (KTD2).
   */
  presentOverlay(request: OverlayRequest): void {
    if (request.kind === 'downloads-panel') {
      this.#presentDownloadsPanel(
        downloadsPanelPresentation(request.anchor, this.options.downloadsPanelEntries())
      )
      return
    }
    this.#present(request)
  }

  /**
   * The panel again, with the rows of a coalesced download change — if, and only if, it is up.
   *
   * Called for every change whether anybody is looking or not, with the same snapshot the downloads
   * page and the button are sent, so the three views describe one moment (R9). A panel that is closed
   * stays closed, and one that something else has replaced is not brought back over it; the rule is
   * `downloadsPanelUpdate`'s. The layer treats what does go up as an update: same identity, no
   * departure, and no second grab of the keyboard (KTD8).
   */
  refreshDownloadsPanel(entries: readonly DownloadEntry[]): void {
    const update = downloadsPanelUpdate(this.#overlay.presentation, entries)
    if (update !== null) this.#presentDownloadsPanel(update)
  }

  #presentDownloadsPanel(panel: DownloadsPanelPresentation): void {
    // Only a presentation the layer took counts as the user having looked; a declined one showed nothing.
    if (this.#present(panel)) this.downloadsPanelPresented()
  }

  #present(presentation: OverlayPresentation): boolean {
    const { width, height } = this.window.getContentBounds()
    return this.#overlay.present(presentation, { width, height }, this.#contentRect())
  }

  /** The tab drag, which the IPC layer drives directly: the gesture spans two renderers. */
  get drag(): WindowSeams['drag'] {
    return this.#seams.drag
  }

  /** This window's tab groups. Public because the group channels act on a window, not on a tab. */
  get groups(): WindowSeams['groups'] {
    return this.#seams.groups
  }

  dismissOverlay(): void {
    this.#overlay.dismiss()
  }

  /**
   * Takes the layer down only if it is showing the kind named; `false` means it was not.
   *
   * What anything acting on one particular surface has to use. `dismissOverlay` takes down whatever
   * happens to be up, which is right for a click on a surface's own close button — the surface is on
   * screen, or the button could not have been pressed — and wrong for everything that arrives a moment
   * later than it meant to. A message aimed at a bar that a consent dialogue has since displaced would
   * take the dialogue down, and a departed dialogue is settled as a refusal nobody gave.
   */
  dismissOverlayKind(kind: OverlayKind): boolean {
    return this.#overlay.dismissKind(kind)
  }

  /**
   * Drops every surface whose rectangle belongs to a tile, because the tiles have moved.
   *
   * Called from each site that changes the geometry. The bounds of a `tile` surface are captured when it
   * is presented and the layer is repositioned from that stored rectangle, so a bar kept across a layout
   * change, a dragged divider or a maximised tile ends up over a page it has nothing to do with. Dropped
   * rather than recomputed, because each of them comes back cheaply: the tile bar re-reveals itself on
   * the next pointer move, the find bar's term is remembered by the core, and a picking session that
   * loses its bar is told through the layer's vacancy report and takes its preview back off the page.
   *
   * By kind, never wholesale, and derived from the region table rather than written out here; see
   * `TILE_BOUND_KINDS`.
   */
  #dismissTileBoundSurfaces(): void {
    for (const kind of TILE_BOUND_KINDS) this.#overlay.dismissKind(kind)
  }

  /**
   * Input that belongs to a tile: a hovering pointer, the bar's shortcut, a thumb button, a swipe.
   *
   * All of it behind `TileInputController`, because all of it shares one question — which tile did the user
   * mean — and the answer is geometry rather than focus. See that file.
   */
  requestTileBar(request: TileBarRequest): void {
    this.#seams.tileInput.requestTileBar(request)
  }

  /**
   * The answer to this window's popup-or-redirect prompt.
   *
   * On the controller rather than reaching into the seam from the handler, so the id check stays in one
   * place: `AutomaticNavigationPrompt.answer` ignores a reply for a question that is not the one on
   * screen, and every route to it goes through here.
   */
  answerNavigationPrompt(requestId: string, permitted: boolean): void {
    this.#navigationPrompt.answer(requestId, permitted)
  }

  /**
   * The prompt left without being answered — dismissed, displaced, the window resized.
   *
   * Refuses, which is the whole safe default of this feature: the page stays where it is. Called from the
   * overlay layer's vacancy announcement, the same route a permission prompt's refusal takes.
   */
  navigationPromptVacated(requestId: string): void {
    this.#navigationPrompt.cancel(requestId)
  }

  overlayPresentation(): OverlayState {
    return this.#overlay.presentation
  }

  /**
   * When this window last presented its downloads panel, or `null` if it has not.
   *
   * The moment the toolbar button counts from: an outcome that happened no later than this was on the
   * panel, so it has been seen and earns no mark (KTD6). In memory only, and per window, so it is gone
   * with the window — a private window's included.
   */
  get downloadsPanelPresentedAt(): number | null {
    return this.#downloadsPanelPresentedAt
  }

  /**
   * Records that the downloads panel has just been presented, and has the button told at once.
   *
   * To be called for *every* presentation of the panel: the first, and each re-presentation with fresh
   * rows while it stays open, same identity or not. Each one is the user looking at the list as it now
   * stands, so a download that finishes while the panel is up is seen by the re-presentation that
   * shows it, and closing the panel leaves no mark behind for it. The summary is sent even when it has
   * not changed, rather than waiting for the next download event to carry it.
   */
  downloadsPanelPresented(at: number = Date.now()): void {
    this.#downloadsPanelPresentedAt = at
    this.options.onDownloadsPanelPresented()
  }

  /**
   * True when `webContentsId` is one of this window's own trusted UI renderers.
   *
   * Both the chrome renderer and the overlay surface are browser UI and get the full IPC
   * surface; a tab's view never does.
   */
  ownsChromeWebContents(webContentsId: number): boolean {
    if (this.window.isDestroyed()) return false
    if (this.window.webContents.id === webContentsId) return true
    return this.#overlay.owns(webContentsId)
  }

  #contentRect(): Rect {
    const { width, height } = this.window.getContentBounds()
    /*
      Website fullscreen inside a tile leaves the chrome in place; only real window fullscreen gives
      the whole surface to content.

      The rule moved to `chrome-insets.ts` and is called from here rather than restated. It used to be
      four ternaries on a local `chromeHidden`, and the renderer — which draws the divider handles over
      this very rectangle — had no equivalent at all, so in fullscreen the handles sat a chrome height
      below the gutters they belong to and stopped working. Two derivations of one number is what that
      was; there is one now, and `App.tsx` reads the same function.
    */
    const { top, bottom, left, right } = chromeInsetsFor(this.split.escalation, this.#chromeInsets)

    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(0, Math.round(width - left - right)),
      height: Math.max(0, Math.round(height - top - bottom))
    }
  }

  /** Positions every tab view according to the current layout. */
  relayout(): void {
    if (this.window.isDestroyed()) return

    const contentRect = this.#contentRect()
    const { width, height } = this.window.getContentBounds()
    // The overlay layer is repositioned first and unconditionally: it must track the window
    // even while the panels have the content views suspended.
    this.#overlay.layout({ width, height }, contentRect)

    // While a full-window panel owns the chrome, every content view is hidden so the DOM
    // beneath them becomes visible and clickable.
    if (this.#overlayActive) {
      for (const tab of this.#tabs.values()) tab.setVisible(false)
      return
    }

    // One rule for every view (KTD22): a tab with no tile, or with a failure, stays hidden through this.
    const tiles = this.split
      .tileRects(contentRect)
      .map((rect, index) => ({ rect, tabId: this.split.tabIdAt(index) }))
    for (const [tabId, { visible, rect }] of planViews(tiles, this.#tabs)) {
      const tab = this.#tabs.get(tabId)
      if (rect !== null) tab?.setBounds(rect)
      tab?.setVisible(visible)
    }
  }

  #focusActiveTab(): void {
    const tab = this.activeTab()
    if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.focus()
  }

  /** Re-applies settings that take effect live (spec 5). */
  onSettingsChanged(changed: Readonly<Record<string, unknown>>): void {
    if ('splitView.fullscreenScope' in changed) this.#seams.fullscreen.applyPolicy()
    if ('splitView.onlyActiveTileAudible' in changed || 'splitView.muteAllButActive' in changed) {
      this.#seams.audio.apply()
    }
    if ('appearance.defaultZoom' in changed) {
      // Every pane, and only the untouched ones move: `applyZoom` falls back to the setting for a pane
      // still at `null` and leaves a deliberate one where it is. What the sentinel buys — see `PaneZoom`.
      for (const tab of this.#tabs.values()) tab.applyZoom()
    }
    this.relayout()
    this.#scheduleBroadcast()
  }

  // --- state broadcast -----------------------------------------------------

  windowState(): WindowState {
    const isMac = process.platform === 'darwin'
    return {
      windowId: this.window.id,
      platform: currentPlatform(),
      focused: this.window.isFocused(),
      maximized: this.window.isMaximized(),
      fullscreen: this.window.isFullScreen(),
      privateMode: this.privateMode,
      // Space the chrome UI must leave free for the OS window controls
      // (spec 10: the tab bar must not cover them).
      windowControlsInset: isMac ? { left: 78, right: 0 } : { left: 0, right: 140 }
    }
  }

  emit<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
    if (this.window.isDestroyed()) return
    this.window.webContents.send(channel, payload)
  }

  /**
   * Pushes an event to internal pages open in this window's tabs.
   *
   * Scoped to `tessera://` documents: a visited web page has no listener and
   * must never receive core events. The URL is parsed rather than prefix-matched,
   * because `https://evil.example/#tessera://` would pass a `startsWith` test.
   */
  emitToInternalPages<C extends EventChannel>(channel: C, payload: EventPayload<C>): void {
    for (const tab of this.#tabs.values()) {
      const contents = tab.view.webContents
      if (contents.isDestroyed()) continue
      if (!isInternalPageUrl(contents.getURL())) continue
      contents.send(channel, payload)
    }
  }

  #broadcastWindowState(): void {
    this.emit('window:stateChanged', this.windowState())
  }

  /**
   * Coalesces bursts of state changes into one message per tick. A single
   * navigation fires half a dozen webContents events, and pushing each one
   * separately would make the tab bar flicker.
   */
  #scheduleBroadcast(): void {
    if (this.#broadcastScheduled) return
    this.#broadcastScheduled = true
    setImmediate(() => {
      this.#broadcastScheduled = false
      if (this.window.isDestroyed()) return
      // The tiling on screen, written down on every settle; see `ArrangementController.keep` for why here.
      this.#seams.arrangements.keep()
      /*
        Sent in group order, with every group as one run of tabs.

        Derived here rather than stored, and sent in full rather than filtered: the strip needs the
        tabs of a *collapsed* group too — not to draw them, but because the chip has to say how many
        are folded away. Which ones to hide is decided on the other side with the same shared
        function, so the two cannot disagree.
      */
      const tabs = this.#seams.groups
        .displayOrder()
        .map((id) => this.#tabs.get(id))
        .filter((tab): tab is Tab => tab !== undefined)
        .map((tab) => tab.toState())
      this.emit('tabs:changed', { tabs, activeTabId: this.split.activeTabId() })
      // The same tick the strip learns which tab is active, a waiting permission question does too.
      this.#permissionTabs.activated(this.activeTabWebContentsId())
      /*
        An open tile bar reads the tab again, from the same tick the strip does.

        Here rather than in each navigation handler because the bar shows four things that change
        independently — back, forward, loading and the address — and a version wired to "back was
        pressed" was the bug: it left forward greyed out until the bar was re-opened. This is the one
        place every one of those changes already arrives at.
      */
      this.#seams.tileInput.refreshTileBar()
      /*
        The session is recorded from the same snapshot the interface is given, on the same coalesced tick.

        A second walk over the tabs could disagree with the first, and `TabState` already carries every field a
        slot needs — which is why the session model's captured tab is a structural subset of it.
      */
      this.options.sessionSlot.record({
        layout: this.split.layout,
        fractions: this.split.toPersistence().fractions,
        activeTile: this.split.activeTile,
        tabs
      })
      this.emit('tabgroups:changed', { groups: this.#seams.groups.groups() })
      this.emit('split:changed', this.split.toState())
    })
  }

  requestNewWindow(privateMode: boolean): void {
    this.options.onRequestNewWindow({ privateMode })
  }
}
