import { BrowserWindow, type Session } from 'electron'
import { join } from 'node:path'
import type { ChromeInsets, WindowState } from '@shared/model.js'

import type { EventChannel } from '@shared/ipc/channels.js'
import type { EventPayload } from '@shared/ipc/contract.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { Fractions, LayoutId, Rect } from '@shared/split/layout.js'
import { HOME_URL, resolveOmniboxInput } from '@shared/url/omnibox.js'
import type { OverlayPresentation, OverlayState } from '@shared/overlay/surface.js'
import { Tab, adoptTabId, nextTabId, type TabWiring } from './Tab.js'
// The seams' *types* only: what each one is, and what it may reach, both live in `window-seams.ts`.
import { createWindowSeams, type WindowSeams } from './window-seams.js'
import type { LayoutChangeOptions } from './TileOccupancyController.js'
import { chromeWindowOptions } from './window-options.js'
import type { TileBarRequest } from '@shared/split/tile-bar.js'
import { nextZoomPercent } from '@shared/gestures/zoom.js'
import type { PageContextTarget } from '../menu/page-context-items.js'
import type { TabGroupBook } from '../data/TabGroupStore.js'
import type { SessionRecorder } from '@shared/session/model.js'
import type { SplitSnapshotForPersistence } from './SplitController.js'
import { OverlayLayer } from './OverlayLayer.js'
import { SplitController, type TileDirection } from './SplitController.js'
import { currentPlatform, preloadFile, preloadRoleArgument } from '../paths.js'
import { isInternalPageUrl } from '../ipc/sender-policy.js'
import { tabsHiddenByCollapse } from '@shared/tabgroups/model.js'
import { tabForStripPosition, type StripPosition } from './tab-strip-position.js'
import { pageKeyAction, type PageKeystroke } from './page-keys.js'

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
  /**
   * This window's slot in the saved session, already bound to its browsing mode; see
   * `SessionStore.recorderFor`. A private window's discards, so there is no flag here to forget.
   *
   * Named `sessionSlot` and not `session`: that name is already the Electron `Session` above.
   */
  sessionSlot: SessionRecorder
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
  onRequestNewWindow(options: { privateMode: boolean }): void
}

const DEFAULT_CHROME_INSETS: ChromeInsets = { top: 88, bottom: 0, left: 0, right: 0 }

export class BrowserWindowController {
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
   * The tab drag in progress, if any.
   *
   * Held by the core rather than by a renderer because no single renderer sees the whole
   * gesture: the pointer leaves the chrome UI the moment it crosses into the content area,
   * where a native view takes it.
   *
   * Public alongside `split`, rather than behind three methods that forwarded to it and decided
   * nothing. A pass-through layer is a place for the two sides to drift apart.
   */
  /**
   * The six controllers this window delegates to.
   *
   * Held as one object rather than six fields: the alternative was six declarations here, six assignments in the
   * constructor and six imports, all of which said the same thing the factory's return type already says.
   */
  readonly #seams: WindowSeams
  #broadcastScheduled = false
  #disposers: Array<() => void> = []

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
        roleArgument: preloadRoleArgument('chrome')
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
      contentRect: () => this.#contentRect(),
      setFullScreenable: (allowed) => this.window.setFullScreenable(allowed),
      exitWindowFullscreen: () => this.window.setFullScreen(false),
      toggleWindowFullscreen: () => this.window.setFullScreen(!this.window.isFullScreen()),
      tab: (tabId) => this.#tabs.get(tabId),
      tabIds: () => [...this.#tabs.keys()],
      tabOrder: () => this.#tabOrder,
      setTabOrder: (order) => {
        this.#tabOrder = [...order]
      },
      assignTabToTile: (tabId, tileIndex) => this.assignTabToTile(tabId, tileIndex),
      closeTab: (tabId) => this.closeTab(tabId),
      setActiveTile: (tileIndex) => this.setActiveTile(tileIndex),
      openFiller: (tileIndex) => {
        this.createTab({ tileIndex, background: true, ephemeral: true })
      },
      applyLayout: (layout, options) => this.#applyLayout(layout, options),
      presentOverlay: (presentation) => this.presentOverlay(presentation),
      relayout: () => this.relayout(),
      broadcast: () => this.#scheduleBroadcast(),
      onOverlayPresentationChanged: (presentation) => this.emit('overlay:presented', { presentation }),
      tabGroups: this.options.tabGroups
    })

    this.#seams = seams

    this.#wireWindowEvents()
    this.#loadChrome()
    this.#seams.fullscreen.applyPolicy()
  }

  // --- lifecycle -----------------------------------------------------------

  #loadChrome(): void {
    const devServer = process.env.ELECTRON_RENDERER_URL
    if (devServer !== undefined && devServer !== '') {
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
   */
  #on(event: string, handler: (...args: unknown[]) => void): void {
    const emitter: NodeJS.EventEmitter = this.window
    emitter.on(event, handler)
    this.#disposers.push(() => {
      emitter.removeListener(event, handler)
    })
  }

  #wireWindowEvents(): void {
    // Resizing moves the button an anchored surface was placed against, so the surface
    // goes rather than hanging in the wrong spot.
    const onResize = (): void => {
      // A resize moves every drop zone, and the zones were computed at the start of the
      // drag on purpose. Rather than silently retargeting under the pointer, the drag goes.
      this.#seams.drag.cancel()
      this.#overlay.dismiss()
      this.relayout()
    }
    const onWindowState = (): void => this.#broadcastWindowState()
    const onBlur = (): void => {
      // Covers the drag that ended somewhere neither renderer could see — a pointer
      // released outside the window leaves no pointerup behind.
      this.#seams.drag.cancel()
      this.#overlay.dismiss()
      this.#broadcastWindowState()
    }
    const onEnterFullscreen = (): void => {
      this.split.setWindowFullscreen(true)
      this.relayout()
      this.#scheduleBroadcast()
    }
    const onLeaveFullscreen = (): void => {
      this.split.setWindowFullscreen(false)
      /*
        The confinement comes back here, and this is the only place it can.

        `toggleFullscreen` lifts `fullScreenable` so the *user's* key can take the window — the flag cannot
        tell a person from a page, so it has to be lifted for the request the person made. Left lifted, a
        video in one pane could then take the whole window and blank the other three, which is the thing
        spec 2 is about. Restoring it on the way *in* would trap the user in fullscreen; on the way out is
        both the earliest safe moment and the one that needs no second flag to remember why.
      */
      this.#seams.fullscreen.applyPolicy()
      this.relayout()
      this.#scheduleBroadcast()
    }

    this.#on('resize', onResize)
    this.#on('maximize', onWindowState)
    this.#on('unmaximize', onWindowState)
    this.#on('focus', onWindowState)
    this.#on('blur', onBlur)
    this.#on('enter-full-screen', onEnterFullscreen)
    this.#on('leave-full-screen', onLeaveFullscreen)

    /*
      Back and forward from hardware that has its own buttons for it.

      `app-command` is the mouse's fourth and fifth buttons on Windows and Linux, `swipe` is the macOS
      trackpad. Subscribed together so neither platform's half can be added without the other being visible,
      and both hand the decision to `decideNavigationGesture` — which direction means "back" is a convention
      that reads backwards from first principles, and one negation would invert every gesture on one platform.
    */
    this.#on('app-command', (...args) => {
      const [, command] = args
      if (typeof command === 'string') this.#seams.tileInput.navigateByGesture('app-command', command)
    })
    this.#on('swipe', (...args) => {
      const [, direction] = args
      if (typeof direction === 'string') this.#seams.tileInput.navigateByGesture('swipe', direction)
    })

    this.window.webContents.on('did-finish-load', () => {
      this.window.show()
      this.#broadcastWindowState()
      this.#scheduleBroadcast()
    })

    this.window.on('closed', () => {
      for (const dispose of this.#disposers) dispose()
      this.#disposers = []
      this.#overlay.destroy()
      for (const tab of this.#tabs.values()) tab.destroy()
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
    } = {}
  ): Tab {
    const tab = new Tab({
      id: options.id === undefined ? nextTabId() : adoptTabId(options.id),
      session: this.options.session,
      wiring: this.options.wiring,
      getSettings: this.getSettings,
      ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
      callbacks: {
        onStateChanged: () => this.#scheduleBroadcast(),
        onOpenNewTab: (url, { background }) => {
          this.createTab({ url, background, tileIndex: null })
        },
        onFocused: (source) => this.#handleTabFocused(source),
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
          The tab the gesture landed on zooms, whichever tile that is and whether or not it is active.

          Through `setZoomPercent` rather than the view's own zoom, so the value goes into the
          per-domain registry spec 1 requires. One consequence worth knowing rather than discovering:
          two tiles showing the *same* site zoom together, because that is what "zoom is per domain"
          means. Per tile would be a different specification, not a smaller change.
        */
        onZoomGesture: (source, direction) => {
          source.setZoomPercent(nextZoomPercent(source.zoomPercent, direction))
        },
        onPageKeystroke: (source, keystroke) => this.#handlePageKeystroke(source, keystroke)
      }
    })

    this.#tabs.set(tab.id, tab)
    this.#tabOrder.push(tab.id)
    // Index 0 puts the tab view at the bottom of the child stack, which keeps the overlay
    // layer above every tab no matter when each was added. Appending instead would put the
    // newest tab above the overlay and let it swallow the surface's clicks.
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

    if (options.deferred === undefined) tab.loadUrl(options.url ?? this.#startupUrl())
    else tab.deferLoad(options.deferred)

    this.relayout()
    this.#scheduleBroadcast()
    return tab
  }

  closeTab(tabId: string): void {
    const tab = this.#tabs.get(tabId)
    if (!tab) return

    const url = tab.toState().url
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

    this.#seams.occupancy.afterTabClosed(vacatedTile)

    /**
     * A window always keeps at least one tab.
     *
     * Closing the last one used to leave an empty window with a live toolbar acting
     * on nothing — every command silently no-oped because `activeTab()` was
     * undefined. A fresh start-page tab is both the safer state and what the user
     * would open next anyway.
     */
    if (this.#tabs.size === 0 && !this.window.isDestroyed()) {
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

  activateTab(tabId: string): void {
    if (!this.#tabs.has(tabId)) return
    // Activating a discarded tab is what finally fetches it; see `Tab.#deferred`.
    this.#tabs.get(tabId)?.loadIfDeferred()
    const tile = this.split.tileOfTab(tabId)
    if (tile !== null) {
      this.split.setActiveTile(tile)
    } else {
      /*
        A tab with no tile has two ways back, and which one applies is a question only its group can
        answer.

        If its group is carrying the arrangement these tabs were displaced from, that arrangement comes
        back: the layout it was, every member in the tile it had. That is the point of recording it — a
        new tab takes the window, and returning to what you were looking at is one click on any of the
        tabs that were in it.

        Otherwise it becomes visible the same way a newly created one does: it gets the window. It used
        to take over the active tile, which is the complaint one step removed — opening a tab out of a
        folded group replaced the page in front of the user, because a folded group releases its
        members' tiles and every one of them comes back through here.
      */
      const arrangement = this.#seams.groups.takeArrangementFor(tabId)
      if (arrangement === null) {
        this.assignTabToTile(tabId, this.#seams.occupancy.claimTileForNewTab())
      } else {
        this.#seams.occupancy.restoreArrangement(tabId, arrangement)
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

      The tile bar goes too, for the reason below: its bounds belong to a tile that is about to move.
    */
    this.#overlay.dismissKind('layout-menu')
    this.#overlay.dismissKind('tile-bar')
    // Same reason, and one more: a find bar's bounds are a tile's corner, captured when it was presented, so a
    // moved tile leaves the bar over the wrong page. Dropped rather than recomputed — the departure clears the
    // page's highlight, and the shortcut restores the term.
    this.#overlay.dismissKind('find-bar')
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
    /*
      The bar's bounds are a tile's top strip, captured when it was presented. Dragging a divider moves that
      tile, and `relayout()` repositions the layer from the stored rectangle — so an open bar would sit over a
      tile that is no longer there. Dropped rather than recomputed: the pointer is already inside a tile and
      re-reveals it on the next move, which is one frame away.
    */
    this.#overlay.dismissKind('tile-bar')
    // Same reason, and one more: a find bar's bounds are a tile's corner, captured when it was presented, so a
    // moved tile leaves the bar over the wrong page. Dropped rather than recomputed — the departure clears the
    // page's highlight, and the shortcut restores the term.
    this.#overlay.dismissKind('find-bar')
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
    // Same reason as `setFractions`: the tab under an open bar may be about to change or leave.
    this.#overlay.dismissKind('tile-bar')
    // Same reason, and one more: a find bar's bounds are a tile's corner, captured when it was presented, so a
    // moved tile leaves the bar over the wrong page. Dropped rather than recomputed — the departure clears the
    // page's highlight, and the shortcut restores the term.
    this.#overlay.dismissKind('find-bar')
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
    // A tile must show something, so a discarded tab dragged into one loads now.
    if (tileIndex !== null) this.#tabs.get(tabId)?.loadIfDeferred()
    this.relayout()
    this.#scheduleBroadcast()
  }

  /** The fullscreen key. Which of the two fullscreens it means is decided in the seam. */
  toggleFullscreen(): void {
    this.#seams.fullscreen.toggleFullscreen()
  }

  toggleTileMaximized(tileIndex?: number): void {
    // Same reason as `setFractions`: every tile's rectangle changes, including the one under an open bar.
    this.#overlay.dismissKind('tile-bar')
    // Same reason, and one more: a find bar's bounds are a tile's corner, captured when it was presented, so a
    // moved tile leaves the bar over the wrong page. Dropped rather than recomputed — the departure clears the
    // page's highlight, and the shortcut restores the term.
    this.#overlay.dismissKind('find-bar')
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
   * `Escape`, and macOS's `Command+.`, arriving in a page.
   *
   * Every rule is in `page-keys.ts` — including the one that is not visible here: the keystroke is
   * never taken from the page. Whatever this does, the page's own handler and the caret in its text
   * fields get the key as well.
   *
   * The tab that received the key is the one whose load is cancelled, rather than the active tile's:
   * the page the user is looking at is the page that had the focus. The ladder is the window's, so it
   * goes through the window either way.
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

  presentOverlay(presentation: OverlayPresentation): void {
    const { width, height } = this.window.getContentBounds()
    this.#overlay.present(presentation, { width, height }, this.#contentRect())
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
   * Input that belongs to a tile: a hovering pointer, the bar's shortcut, a thumb button, a swipe.
   *
   * All of it behind `TileInputController`, because all of it shares one question — which tile did the user
   * mean — and the answer is geometry rather than focus. See that file.
   */
  requestTileBar(request: TileBarRequest): void {
    this.#seams.tileInput.requestTileBar(request)
  }

  overlayPresentation(): OverlayState {
    return this.#overlay.presentation
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
    const insets = this.#chromeInsets
    // Website fullscreen inside a tile leaves the chrome in place; only real
    // window fullscreen gives the whole surface to content.
    const chromeHidden = this.split.escalation === 'window-fullscreen'
    const top = chromeHidden ? 0 : insets.top
    const bottom = chromeHidden ? 0 : insets.bottom
    const left = chromeHidden ? 0 : insets.left
    const right = chromeHidden ? 0 : insets.right

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

    const rects = this.split.tileRects(contentRect)

    const visibleTabIds = new Set<string>()
    rects.forEach((rect, index) => {
      const tabId = this.split.tabIdAt(index)
      if (tabId === null || rect === null) return
      const tab = this.#tabs.get(tabId)
      if (!tab) return
      tab.setBounds(rect)
      tab.setVisible(true)
      visibleTabIds.add(tabId)
    })

    // Tabs with no tile are hidden but stay loaded and keep running (spec 2).
    for (const [tabId, tab] of this.#tabs) {
      if (visibleTabIds.has(tabId)) continue
      tab.setVisible(false)
    }
  }

  #focusActiveTab(): void {
    const tab = this.activeTab()
    if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.focus()
  }

  /** Re-applies settings that take effect live (spec 5). */
  onSettingsChanged(changed: Readonly<Record<string, unknown>>): void {
    if ('splitView.fullscreenScope' in changed) this.#seams.fullscreen.applyPolicy()
    if (
      'splitView.onlyActiveTileAudible' in changed ||
      'splitView.muteAllButActive' in changed
    ) {
      this.#seams.audio.apply()
    }
    if ('appearance.defaultZoom' in changed) {
      for (const tab of this.#tabs.values()) tab.applyZoomForCurrentDomain()
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
      /*
        Sent in group order, with every group as one run of tabs.

        Derived here rather than stored, and sent in full rather than filtered: the strip needs the
        tabs of a *collapsed* group too — not to draw them, but because the chip has to say how many
        are folded away. Which ones to hide is decided on the other side with the same shared
        function, so the two cannot disagree.
      */
      const tabs = this.#seams.groups.displayOrder().map((id) => this.#tabs.get(id)).filter((tab): tab is Tab => tab !== undefined).map((tab) => tab.toState())
      this.emit('tabs:changed', { tabs, activeTabId: this.split.activeTabId() })
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
