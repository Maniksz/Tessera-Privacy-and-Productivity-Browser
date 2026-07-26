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
import type { PageContextTarget } from '../menu/page-context-items.js'
import type { Tab } from './Tab.js'
import { quickLinkCards, type QuickLinkCard } from '@shared/quicklinks/cards.js'
import type { QuickLink } from '@shared/quicklinks/model.js'
import { applySessionHardening } from '../session/hardening.js'
import { installRequestPipeline } from '../privacy/RequestPipeline.js'
import { BrowserWindowController } from './BrowserWindowController.js'

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
  /** Drops what a session left in memory. The last piece of "a private window leaves no record". */
  releaseSession(session: Session): void
}

export interface WindowRegistryDeps {
  settings: SettingsStore
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
  readonly #preparedSessions = new WeakSet<Session>()
  #privateSessionCounter = 0

  readonly #deps: WindowRegistryDeps

  constructor(deps: WindowRegistryDeps) {
    this.#deps = deps
    // Settings that take effect live reach every open window (spec 5).
    this.#deps.settings.onChange(({ changed, snapshot }) => {
      // The blocker first: a window told about a list change before the rules were recompiled would
      // render a page against the old ones.
      this.#deps.filters.onSettingsChanged(changed)
      for (const controller of this.#controllers) {
        controller.onSettingsChanged(changed)
        controller.emit('settings:changed', { changed, snapshot })
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
        // A private session's data exists only for the life of its window
        // (spec 4): nothing may outlive it on disk or in memory.
        if (closed.privateMode) {
          void session.clearStorageData()
          void session.clearCache()
          /*
            And in the manager, which is the half no storage call reaches.

            The store never saw those downloads — a private window holds a recorder that discards —
            but the manager did, so a live entry that outlived its window would keep a private
            download's address and file name in the process for as long as the browser ran. Only for
            a private window: the default session is shared, and releasing it when an ordinary window
            closed would drop the live downloads of every other one.
          */
          this.#deps.downloads.releaseSession(session)
        }
      },
      onPageContextMenu: (tab, target) => {
        // The controller travels with it: the menu opens a new tab beside the page that was clicked, and
        // "beside" is a property of the window rather than of the tab.
        this.#deps.onPageContextMenu(controller, tab, target)
      },
      onRequestNewWindow: ({ privateMode }) => {
        this.createWindow({ privateMode }).createTab({})
      }
    })

    this.#controllers.add(controller)
    return controller
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

  /** Attributes a blocked request to the tab that made it, for the badge count. */
  #noteBlockedRequest(documentUrl: string | null): void {
    if (documentUrl === null) return
    for (const controller of this.#controllers) {
      for (let tile = 0; tile < controller.split.tileCount; tile++) {
        const tabId = controller.split.tabIdAt(tile)
        if (tabId === null) continue
        const tab = controller.tab(tabId)
        if (tab?.toState().url === documentUrl) {
          tab.noteBlockedRequest()
          return
        }
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
