import { session as electronSession, webContents, type Session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { SettingsStore } from '../settings/SettingsStore.js'
import type { QuickLinkStore } from '../data/QuickLinkStore.js'
import type { BrowsingMode, HistoryStore } from '../data/HistoryStore.js'
import type { FaviconStore } from '../data/FaviconStore.js'
import type { ThumbnailStore } from '../data/ThumbnailStore.js'
import type { TabGroupStore } from '../data/TabGroupStore.js'
import type { SessionStore } from '../data/SessionStore.js'
import type { SplitSnapshotForPersistence } from './SplitController.js'
import type { FilterSubscription } from '../privacy/FilterSubscription.js'
import type { FilterStatus } from '@shared/filters/status.js'
import type { Locale } from '@shared/i18n/catalog.js'
import type { PageContextTarget } from '../menu/page-context-items.js'
import type { Tab } from './Tab.js'
import { quickLinkCards, type QuickLinkCard } from '@shared/quicklinks/cards.js'
import type { QuickLink } from '@shared/quicklinks/model.js'
import type { DownloadEntry } from '@shared/downloads/model.js'
import { applySessionHardening } from '../session/hardening.js'
import { installRequestPipeline } from '../privacy/RequestPipeline.js'
import { BrowserWindowController } from './BrowserWindowController.js'
import { WindowRecency, downloadWindowFor } from './window-recency.js'

/**
 * Owns every window and every session.
 *
 * Sessions are created here so that hardening and the request pipeline are
 * installed exactly once per session, at the moment it comes into existence.
 * Doing it per window would install them repeatedly — and because Electron
 * keeps only one `webRequest` listener per event, the second install would
 * silently replace the first (see `RequestPipeline`).
 */

/**
 * Everything the registry needs, as one object.
 *
 * An object rather than seven positional parameters, and the change was overdue rather than tidy: adding an
 * eighth would have meant a call site where the difference between `favicons` and `thumbnails` was position
 * six versus position five. Both are stores with a `find` and a `flush`, so transposing them would compile.
 */
/**
 * The download manager, as far as this class needs one. `DownloadManager` satisfies it.
 *
 * Structural rather than the concrete class so this file does not import the download plumbing to
 * call two methods on it — and so the two calls below say exactly what the coupling is: one
 * subscription per session, one release per private window.
 */
export interface DownloadSubscriber {
  attach(session: Session, mode: BrowsingMode): void
  /**
   * Stops and drops what a session left in memory. The last piece of "a private window leaves no
   * record", and the reason an unfinished private download does not outlive its window.
   */
  releaseSession(session: Session): void
  /** A window closed: its downloads are filed under `successor` instead, or under no window. */
  releaseWindow(windowId: number, successor: number | undefined): void
  /**
   * One window's list, freshly probed — what its downloads panel opens with.
   *
   * The same call `downloads:list` answers the page with, so the panel is the head of the page's list
   * and not a list of its own (KTD7).
   */
  list(viewer: DownloadWindow['viewer']): DownloadEntry[]
}

/**
 * One window as the downloads channels see it; `registerDownloadHandlers` takes these.
 *
 * Built here rather than asked of the controller, because two of its three facts are this class's:
 * the session was created here, and "which web contents speak for this window" includes its tabs,
 * which the sender lookups in this class already walk. Structural, so this file imports nothing from
 * the IPC layer it is handed to.
 */
export interface DownloadWindow {
  readonly viewer: {
    readonly windowId: number
    readonly mode: BrowsingMode
    readonly session: Session
  }
  sends(webContentsId: number): boolean
  emitToInternalPages: BrowserWindowController['emitToInternalPages']
  /** To the window's chrome UI; the button's summary travels this way. */
  emit: BrowserWindowController['emit']
  /** The controller's record; see `BrowserWindowController.downloadsPanelPresentedAt`. */
  readonly downloadsPanelPresentedAt: number | null
  /** The window's panel with fresh rows, if it is up; see `BrowserWindowController.refreshDownloadsPanel`. */
  refreshDownloadsPanel: BrowserWindowController['refreshDownloadsPanel']
}

/** What the registry remembers about one open window beyond the controller itself. */
interface OpenWindow {
  readonly controller: BrowserWindowController
  /** Read once while the window exists; a destroyed `BrowserWindow` is not asked for anything. */
  readonly windowId: number
  readonly session: Session
  readonly downloads: DownloadWindow
}

/**
 * The user's own rules, as far as this class needs them. `UserRuleStore` satisfies it.
 *
 * Structural for the same reason `DownloadSubscriber` is, and one method wide on purpose: this class
 * neither reads a rule nor writes one. It owns exactly one fact nobody else has — whether any private
 * window is still open — and that fact is what ends a private session's rules.
 */
export interface SessionRuleKeeper {
  /** Drops the rules a private session kept in memory; see `UserRuleStore.endPrivateSession`. */
  endPrivateSession(): void
}

export interface WindowRegistryDeps {
  settings: SettingsStore
  /**
   * The interface language in force, already resolved.
   *
   * Injected rather than derived from `settings`, because `'system'` is answered with
   * `app.getLocale()` and this class has no business asking Electron what the operating system
   * prefers. The caller owns that question and already has to answer it for the menus.
   */
  uiLocale: () => Locale
  quickLinks: QuickLinkStore
  history: HistoryStore
  favicons: FaviconStore
  thumbnails: ThumbnailStore
  tabGroups: TabGroupStore
  /** The saved session. One store for every window; each window gets its own slot. */
  sessionStore: SessionStore
  /**
   * The blocker's rules, already loaded from cache and refreshing in the background.
   *
   * One subscription for every session including private ones: the rules follow the user's configuration
   * rather than a window, and a private window that blocked less would both surprise the user and be a way
   * to recognise it from the outside.
   */
  filters: FilterSubscription
  /**
   * Downloads, subscribed per session.
   *
   * The manager is handed in rather than built here for the same reason the stores are: it needs
   * settings, the default directory and a shell, none of which this class holds. What it needs from
   * *here* is the one thing only this class knows — which session belongs to which kind of window —
   * and it is bound once, in `#prepareSession`.
   */
  downloads: DownloadSubscriber
  /**
   * The user's own rules, for one call: the end of the private session.
   *
   * Held here rather than reached through the picker or the IPC layer because the end of a private
   * session is a window-lifetime event, and window lifetimes are this class's subject. The rules
   * themselves travel nowhere near it.
   */
  userRules: SessionRuleKeeper
  /**
   * The user right-clicked a page.
   *
   * Passed through from the entry point rather than decided here, because the menu needs the language, the
   * blocker's state and the element picker — and a registry that held those would be holding them only in
   * order to hand them on.
   */
  onPageContextMenu(controller: BrowserWindowController, tab: Tab, target: PageContextTarget): void
}

export class WindowRegistry {
  readonly #controllers = new Set<BrowserWindowController>()
  readonly #open = new Map<BrowserWindowController, OpenWindow>()
  /** Most recently focused first; see `window-recency.ts` for why an order and not only "focused". */
  readonly #recency = new WindowRecency<OpenWindow>()
  readonly #preparedSessions = new WeakSet<Session>()
  #privateSessionCounter = 0
  /** See `onDownloadsPanelPresented`. */
  readonly #downloadsPanelListeners = new Set<(window: DownloadWindow) => void>()

  readonly #deps: WindowRegistryDeps
  /** What the internal pages were last told, so `locale:changed` fires on a change and not on a save. */
  #locale: Locale

  constructor(deps: WindowRegistryDeps) {
    this.#deps = deps
    this.#locale = deps.uiLocale()
    // Settings that take effect live reach every open window (spec 5).
    this.#deps.settings.onChange(({ changed, snapshot }) => {
      // The blocker first: a window told about a list change before the rules were recompiled would
      // render a page against the old ones.
      this.#deps.filters.onSettingsChanged(changed)
      for (const controller of this.#controllers) {
        controller.onSettingsChanged(changed)
        controller.emit('settings:changed', { changed, snapshot })
      }
      /*
        Internal tabs hear about the language separately, and only when it actually moved.

        Keyed on the resolved locale rather than on `'appearance.uiLanguage' in changed`, because the
        two disagree in both directions: switching from `'system'` to the language the OS already uses
        changes the preference and nothing a page would render, and nothing here fires when the OS
        itself changes. Comparing what pages were last told is the question they care about.
      */
      const locale = this.#deps.uiLocale()
      if (locale === this.#locale) return
      this.#locale = locale
      for (const controller of this.#controllers) {
        controller.emitToInternalPages('locale:changed', { locale })
      }
    })

    // A tile added in one window appears in the others without a reload — the
    // start page is open in several tabs more often than not.
    this.#deps.quickLinks.onChange((links) => {
      const cards = this.quickLinkCards(links)
      for (const controller of this.#controllers) {
        controller.emit('quicklinks:changed', { links: cards })
        controller.emitToInternalPages('quicklinks:changed', { links: cards })
      }
    })

    /*
      A new picture also changes a card, and nothing else would say so.

      Without this, a screenshot taken while the start page is open appears only after a reload —
      which is precisely the visit that produced it. Both caches are watched because both feed a card
      and either can be the one that changes.
    */
    const republish = (): void => {
      const cards = this.quickLinkCards(this.#deps.quickLinks.list())
      for (const controller of this.#controllers) {
        controller.emitToInternalPages('quicklinks:changed', { links: cards })
      }
    }
    this.#deps.thumbnails.onChange(republish)
    this.#deps.favicons.onChange(republish)
  }

  /**
   * Attaches each link's picture addresses, ready for the start page.
   *
   * Here rather than in the IPC handler because this is the object that holds all three stores, and
   * because the change events above need exactly the same derivation — two copies of it would
   * eventually publish two different answers for the same link.
   */
  quickLinkCards(links: readonly QuickLink[]): QuickLinkCard[] {
    return quickLinkCards(links, {
      findThumbnail: (pageUrl) => this.#deps.thumbnails.find(pageUrl)?.entry ?? null,
      findFavicon: (pageUrl) => this.#deps.favicons.find(pageUrl)?.entry ?? null
    })
  }

  /** What the blocker made of the user's lists, for the settings page. */
  filterStatus(): FilterStatus {
    return this.#deps.filters.status()
  }

  /** Fetches any list that is missing or stale, now. Awaited, so the caller can report the result. */
  refreshFilters(): Promise<unknown> {
    return this.#deps.filters.refresh()
  }

  get controllers(): readonly BrowserWindowController[] {
    return [...this.#controllers]
  }

  get count(): number {
    return this.#controllers.size
  }

  createWindow(options: {
    privateMode: boolean
    /** Set only by session restore; see `WindowControllerOptions.initialSplit`. */
    initialSplit?: Partial<SplitSnapshotForPersistence>
  }): BrowserWindowController {
    const session = options.privateMode ? this.#createPrivateSession() : electronSession.defaultSession
    // Named once, so the bindings below cannot disagree about which kind of window this is — and
    // named *before* the session is prepared, because the download subscription is bound there.
    const mode: BrowsingMode = options.privateMode ? 'private' : 'normal'
    this.#prepareSession(session, mode)

    const controller = new BrowserWindowController({
      session,
      privateMode: options.privateMode,
      // Bound here, once per window, and never again. Asking per visit would put the decision back
      // at the call site, which is exactly what the named-mode APIs exist to prevent — a private
      // window is handed objects that discard, so there is no flag downstream to forget.
      wiring: {
        history: this.#deps.history.recorderFor(mode),
        favicons: this.#deps.favicons.cacheFor(mode),
        thumbnails: this.#deps.thumbnails.capturerFor(mode),
        thumbnailSettleDelayMs: this.#deps.thumbnails.settleDelayMs
      },
      // Bound the same way, and for the same reason: a private window's book keeps its groups in
      // memory and writes nothing.
      tabGroups: this.#deps.tabGroups.bookFor(mode),
      // Bound the same way and for the same reason: a private window's recorder discards, and takes no slot.
      sessionSlot: this.#deps.sessionStore.recorderFor(mode),
      ...(options.initialSplit === undefined ? {} : { initialSplit: options.initialSplit }),
      getSettings: () => this.#deps.settings.snapshot(),
      onClosed: (closed) => {
        this.#controllers.delete(closed)
        this.#open.delete(closed)
        this.#recency.forget(opened)
        closed.window.removeListener('focus', onFocus)
        // A private session's data exists only for the life of its window
        // (spec 4): nothing may outlive it on disk or in memory.
        if (closed.privateMode) {
          /*
            The manager first, which is the half no storage call reaches — and first because it
            *stops* something rather than only forgetting it.

            The store never saw those downloads — a private window holds a recorder that discards —
            but the manager did, and Chromium is still writing any that have not finished. Releasing
            the session cancels those before their listeners go, so no transfer outlives the window
            it can no longer be seen or stopped in; and a live entry that outlived its window would
            keep a private download's address and file name in the process for as long as the
            browser ran. Only for a private window: the default session is shared, and releasing it
            when an ordinary window closed would stop the downloads of every other one.
          */
          this.#deps.downloads.releaseSession(session)
          void session.clearStorageData()
          void session.clearCache()
          /*
            And the rules the picker wrote in that window, which are the third thing a private session
            leaves in memory rather than on disk.

            Only when the *last* private window goes, because the editor holding them is bound to the
            browsing mode rather than to one window — `UserRuleStore.editorFor` argues that choice out.
            While another private window is open they are still its rules, and dropping them here would
            make a rule vanish from a window nobody touched.
          */
          if (![...this.#controllers].some((open) => open.privateMode)) {
            this.#deps.userRules.endPrivateSession()
          }
        }
        /*
          And the window's claim on its downloads, for both kinds.

          A normal window's downloads keep running — the default session outlives it — so they move to
          the normal window focused most recently, whose button is the one a person would now look at.
          A private window's are already stopped; `undefined` just drops the claim. So does the case
          with no normal window left, which on macOS is an application still running with none open.
        */
        const successor = closed.privateMode
          ? undefined
          : this.#recency.latest((open) => !open.controller.privateMode)?.windowId
        this.#deps.downloads.releaseWindow(opened.windowId, successor)
      },
      onPageContextMenu: (tab, target) => {
        // The controller travels with it: the menu opens a new tab beside the page that was clicked, and
        // "beside" is a property of the window rather than of the tab.
        this.#deps.onPageContextMenu(controller, tab, target)
      },
      onRequestNewWindow: ({ privateMode }) => {
        this.createWindow({ privateMode }).createTab({})
      },
      onDownloadsPanelPresented: () => {
        for (const listener of this.#downloadsPanelListeners) listener(opened.downloads)
      },
      downloadsPanelEntries: () => this.#deps.downloads.list(opened.downloads.viewer)
    })

    this.#controllers.add(controller)
    const windowId = controller.window.id
    const opened: OpenWindow = {
      controller,
      windowId,
      session,
      downloads: {
        viewer: { windowId, mode, session },
        sends: (webContentsId) => this.#speaksFor(controller, webContentsId),
        emitToInternalPages: (channel, payload) => {
          controller.emitToInternalPages(channel, payload)
        },
        emit: (channel, payload) => {
          controller.emit(channel, payload)
        },
        get downloadsPanelPresentedAt() {
          return controller.downloadsPanelPresentedAt
        },
        refreshDownloadsPanel: (entries) => {
          controller.refreshDownloadsPanel(entries)
        }
      }
    }
    this.#open.set(controller, opened)
    // A new window is in front before its first `focus` event arrives, and a download can start in
    // between — a window opened from a link that turns out to be a file.
    this.#recency.touch(opened)
    const onFocus = (): void => {
      this.#recency.touch(opened)
    }
    controller.window.on('focus', onFocus)
    return controller
  }

  /** Every open window, as the downloads channels address them; one object per window, for its life. */
  get downloadWindows(): readonly DownloadWindow[] {
    return [...this.#open.values()].map((open) => open.downloads)
  }

  /**
   * Tells `listener` whenever a window has presented its downloads panel, naming the window.
   *
   * One listener set for the registry rather than one per window, and no way off: the downloads
   * channels subscribe once for the life of the process, the way they subscribe to the manager, so
   * nothing here is left holding a closed window. A window reaches it through its controller's
   * `downloadsPanelPresented`.
   */
  onDownloadsPanelPresented(listener: (window: DownloadWindow) => void): void {
    this.#downloadsPanelListeners.add(listener)
  }

  /**
   * The window a download that has just started belongs to, by id; `undefined` for none.
   *
   * Handed to the download manager as its resolver. The rule — the tab's window, else the window of
   * that session focused last — is `downloadWindowFor`'s, where it is tested.
   */
  windowForDownload(
    source: { readonly id: number } | undefined,
    session: unknown
  ): number | undefined {
    const owner = downloadWindowFor(
      source,
      session,
      this.#recency.mostRecentFirst,
      (open, webContentsId) => this.#speaksFor(open.controller, webContentsId)
    )
    return owner?.windowId
  }

  /**
   * Whether a web contents is this window's own: its chrome UI, its overlay, or one of its tabs.
   *
   * Strict on purpose, unlike `resolve`, which falls back to the focused window. A downloads page
   * answered by that fallback while a private window was in front would be shown the private
   * window's downloads.
   */
  #speaksFor(controller: BrowserWindowController, webContentsId: number): boolean {
    if (controller.ownsChromeWebContents(webContentsId)) return true
    return controller.tabs.some((tab) => tab.view.webContents.id === webContentsId)
  }

  /**
   * In-memory session with no `persist:` prefix, so Chromium never writes it to
   * disk (spec 4).
   */
  #createPrivateSession(): Session {
    this.#privateSessionCounter += 1
    return electronSession.fromPartition(`private-${this.#privateSessionCounter}`)
  }

  #prepareSession(session: Session, mode: BrowsingMode): void {
    if (this.#preparedSessions.has(session)) return
    this.#preparedSessions.add(session)

    applySessionHardening({
      session,
      getSettings: () => this.#deps.settings.snapshot()
    })

    /*
      `will-download`, bound to a browsing mode here and never asked about again.

      This is the only place that knows both facts at once: which session a download will arrive on,
      and which kind of window opened it. The manager takes a *recorder* from the store at this
      moment, so a private session physically holds an object that discards — there is no later
      branch deciding whether to write, which is the same discipline the history, favicon and
      thumbnail wiring above uses.

      Bound per session rather than per window for the reason the whole method exists: several
      normal windows share the default session, and a second subscription there would report every
      download twice. The manager keeps its own guard as well, so neither layer relies on the other
      remembering.
    */
    this.#deps.downloads.attach(session, mode)

    installRequestPipeline({
      session,
      getSettings: () => this.#deps.settings.snapshot(),
      /*
        The engine object is handed over once and never replaced.

        The pipeline captures it when it installs its single `webRequest` listener, and
        `FilterSubscription` mutates that same object's rules when the lists change — so a list the
        user adds takes effect without reinstalling the listener. Reinstalling would silently replace
        it, which is the failure mode `RequestPipeline` exists to prevent.
      */
      filterEngine: this.#deps.filters.engine,
      hooks: {
        onBlocked: (documentUrl) => this.#noteBlockedRequest(documentUrl)
      }
    })
  }

  /**
   * Attributes a blocked request to the tab that made it, for the badge count.
   *
   * ## Every tab, not only the ones in tiles
   *
   * This used to walk `split.tileCount` and ask the layout which tab sat in each, so a tab that was
   * loaded but off screen — a link opened in the background, a folded group's member, anything the
   * grid does not currently show — was never a candidate and its badge stayed at zero however much
   * its page fetched. A hidden tab keeps running and keeps making requests (spec 2), so the count has
   * to follow the tab rather than the tile.
   *
   * ## Against `currentUrl` rather than `toState().url`
   *
   * The comparison runs once per refused request, which on an advert-heavy page is hundreds of times
   * per load and multiplied by every open tab this loop walks before it finds the right one.
   * `toState()` builds a sixteen-field object out of eight synchronous calls into Chromium — the
   * address, the title, the loading flag, both history questions, both audio questions — to answer a
   * string comparison. `Tab.currentUrl` is a field the navigation events already maintain.
   */
  #noteBlockedRequest(documentUrl: string | null): void {
    if (documentUrl === null) return
    for (const controller of this.#controllers) {
      for (const tab of controller.tabs) {
        if (tab.currentUrl !== documentUrl) continue
        tab.noteBlockedRequest()
        return
      }
    }
  }

  /**
   * Which window an IPC call came from.
   *
   * Resolved from the sender rather than from "the focused window": during a
   * rapid focus change those differ, and acting on the wrong window is the kind
   * of bug that only shows up under real use.
   */
  fromEvent(event: IpcMainInvokeEvent): BrowserWindowController | undefined {
    const senderId = event.sender.id
    for (const controller of this.#controllers) {
      if (controller.window.isDestroyed()) continue
      if (controller.ownsChromeWebContents(senderId)) return controller
    }

    // The sender may be a tab's view rather than the chrome UI.
    const sender = webContents.fromId(senderId)
    if (!sender) return undefined
    for (const controller of this.#controllers) {
      if (controller.window.isDestroyed()) continue
      if (controller.window.webContents.id === sender.hostWebContents?.id) return controller
    }
    return undefined
  }

  /**
   * True when the message came from one of a window's own trusted UI renderers.
   *
   * That is the chrome renderer and the overlay surface — both are our browser UI, and
   * both need the full contract. A tab's view never qualifies, whatever it has loaded.
   *
   * Identity-based rather than URL-based on purpose: in development both are served from
   * an http dev server, and any URL rule permissive enough to accept that would also
   * accept a visited web page.
   */
  isChromeSender(event: IpcMainInvokeEvent): boolean {
    const senderId = event.sender.id
    for (const controller of this.#controllers) {
      if (controller.window.isDestroyed()) continue
      if (controller.ownsChromeWebContents(senderId)) return true
    }
    return false
  }

  focused(): BrowserWindowController | undefined {
    return [...this.#controllers].find((controller) => !controller.window.isDestroyed() && controller.window.isFocused())
  }

  /**
   * The window owning a content view, by web-contents id.
   *
   * Deliberately *not* falling back to the focused window, unlike `resolve` below. The caller is the
   * element picker, which acts on the page a message came from; guessing a different window would write a
   * rule for a site the user was not looking at — and, worse, could write from a private window's page
   * into the normal profile's rules.
   */
  controllerForWebContents(webContentsId: number): BrowserWindowController | undefined {
    for (const controller of this.#controllers) {
      for (const tab of controller.tabs) {
        if (tab.view.webContents.id === webContentsId) return controller
      }
    }
    return undefined
  }

  /** Sender's window, falling back to the focused one. */
  resolve(event?: IpcMainInvokeEvent): BrowserWindowController | undefined {
    if (event) {
      const fromSender = this.fromEvent(event)
      if (fromSender) return fromSender
    }
    return this.focused() ?? [...this.#controllers][0]
  }

  closeAll(): void {
    for (const controller of [...this.#controllers]) controller.destroy()
  }
}
