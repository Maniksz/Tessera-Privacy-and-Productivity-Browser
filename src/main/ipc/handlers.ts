import { readFile } from 'node:fs/promises'
import { app, dialog } from 'electron'
import type { SettingsStore } from '../settings/SettingsStore.js'
import { describeSettings } from '../settings/describe.js'
import type { WindowRegistry } from '../browser/WindowRegistry.js'
import type { QuickLinkStore } from '../data/QuickLinkStore.js'
import type { ExtensionStore } from '../data/ExtensionStore.js'
import { findLink } from '@shared/quicklinks/model.js'
import { findService } from '../find/service.js'
import { readerOutcomeFor } from '../reader/reader-mode.js'
import { assertAllChannelsRegistered, configureSenderPolicy, handle, OK } from './router.js'
import { catalogs, resolveLocale, type Locale } from '@shared/i18n/catalog.js'
import {
  DEFAULT_BINDINGS,
  SHORTCUT_ACTIONS,
  acceleratorFor,
  conflictFor
} from '@shared/shortcuts/bindings.js'
import { translate } from '@shared/i18n/catalog.js'
import { currentPlatform } from '../paths.js'
import type { ShortcutBinding } from '@shared/model.js'
import type { HistoryStore } from '../data/HistoryStore.js'
import { buildTabContextMenu } from '../menu/tabContextMenu.js'
import { registerPermissionHandlers } from './permission-handlers.js'
import { registerMediaHandlers } from './media-handlers.js'
import { registerDownloadHandlers } from './download-handlers.js'
import { buildBlockerMenu } from '../menu/blockerMenu.js'
import { injectableDocumentUrl } from '@shared/filters/injection.js'
import type { PermissionArbiter } from '../permissions/PermissionArbiter.js'
import type { IpcMainInvokeEvent } from 'electron'
import type { MediaSessions } from '../media/MediaSessions.js'
import type { ElementPicker } from '../privacy/ElementPicker.js'
import type { UserRuleStore, UserRuleEditor } from '../data/UserRuleStore.js'
import type { BookmarkStore } from '../data/BookmarkStore.js'
import type { DownloadManager } from '../downloads/DownloadManager.js'
import type { PasswordApi } from '../passwords/PasswordApi.js'

/**
 * Wires every contract channel to the core.
 *
 * Handlers stay thin on purpose: they resolve the window the call came from and
 * delegate. Behaviour belongs in the controllers, so it can be reasoned about
 * without an IPC layer in the way.
 */

export function registerIpcHandlers(deps: {
  settings: SettingsStore
  windows: WindowRegistry
  quickLinks: QuickLinkStore
  extensions: ExtensionStore
  history: HistoryStore
  bookmarks: BookmarkStore
  /** Subscribed to every session, and the only thing that knows a live download; see `attach`. */
  downloads: DownloadManager
  /** The six operations a passwords page may perform, already measured; see `PasswordApi`. */
  passwords: PasswordApi
  /** Decides and queues permission prompts; see `PermissionArbiter`. */
  permissions: PermissionArbiter
  /** One media service per browsing session; see `MediaSessions`. */
  media: MediaSessions
  /** "Block this element": starts and stops the mode for one view. */
  picker: ElementPicker
  /** The user's own rules. */
  userRules: UserRuleStore
}): void {
  const { settings, windows, quickLinks, extensions, history, bookmarks, passwords } = deps

  /** The rule editor for the sending window's browsing mode; a private window's discards. */
  const editorFor = (event: IpcMainInvokeEvent): UserRuleEditor =>
    deps.userRules.editorFor(windows.resolve(event)?.privateMode === true ? 'private' : 'normal')

  // The router must know which renderers are the trusted chrome UI before any
  // handler can run; everything else is refused or restricted to the internal
  // allowlist (see `sender-policy.ts`).
  configureSenderPolicy((event) => windows.isChromeSender(event))

  // --- settings ------------------------------------------------------------
  handle('settings:getAll', () => settings.snapshot())

  handle('settings:get', ({ key }) => {
    // Rejects for an unknown key via the store's own guard.
    return settings.snapshot()[key as keyof ReturnType<typeof settings.snapshot>]
  })

  handle('settings:set', ({ key, value }) => {
    // Throws UnknownSettingKeyError / InvalidSettingValueError, which becomes a
    // rejected invoke the UI must show (spec 5).
    settings.set(key, value)
    return settings.snapshot()
  })

  handle('settings:reset', ({ key }) => {
    settings.reset(key)
    return settings.snapshot()
  })

  handle('settings:resetAll', () => {
    settings.resetAll()
    return settings.snapshot()
  })

  handle('settings:describe', () => describeSettings())

  // --- window --------------------------------------------------------------
  handle('window:getState', (_payload, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    return controller.windowState()
  })

  handle('window:minimize', (_payload, event) => {
    windows.resolve(event)?.window.minimize()
    return OK
  })

  handle('window:toggleMaximize', (_payload, event) => {
    const win = windows.resolve(event)?.window
    if (win) {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    }
    return OK
  })

  handle('window:close', (_payload, event) => {
    windows.resolve(event)?.window.close()
    return OK
  })

  handle('window:setChromeInsets', (insets, event) => {
    windows.resolve(event)?.setChromeInsets(insets)
    return OK
  })

  handle('window:setOverlay', ({ active }, event) => {
    windows.resolve(event)?.setOverlayActive(active)
    return OK
  })

  // --- overlay surface -----------------------------------------------------
  handle('overlay:present', (presentation, event) => {
    windows.resolve(event)?.presentOverlay(presentation)
    return OK
  })

  handle('overlay:dismiss', (_payload, event) => {
    windows.resolve(event)?.dismissOverlay()
    return OK
  })

  // --- dragging a tab into a tile ------------------------------------------
  handle('drag:start', ({ tabId }, event) => {
    windows.resolve(event)?.drag.start(tabId)
    return OK
  })

  handle('drag:move', ({ x, y }, event) => {
    windows.resolve(event)?.drag.move({ x, y })
    return OK
  })

  handle('drag:end', ({ x, y, commit }, event) => {
    windows.resolve(event)?.drag.end({ x, y }, commit)
    return OK
  })

  // --- tabs ----------------------------------------------------------------
  handle('tabs:create', (payload, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    const tab = controller.createTab({
      ...(payload.url === undefined ? {} : { url: payload.url }),
      ...(payload.tileIndex === undefined ? {} : { tileIndex: payload.tileIndex }),
      ...(payload.background === undefined ? {} : { background: payload.background })
    })
    return { tabId: tab.id }
  })

  handle('tabs:close', ({ tabId }, event) => {
    windows.resolve(event)?.closeTab(tabId)
    return OK
  })

  handle('tabs:activate', ({ tabId }, event) => {
    windows.resolve(event)?.activateTab(tabId)
    return OK
  })

  handle('tabs:move', ({ tabId, toIndex }, event) => {
    windows.resolve(event)?.moveTab(tabId, toIndex)
    return OK
  })

  handle('tabs:setPinned', ({ tabId, pinned }, event) => {
    windows.resolve(event)?.setTabPinned(tabId, pinned)
    return OK
  })

  handle('tabs:reopenClosed', (_payload, event) => {
    return { tabId: windows.resolve(event)?.reopenClosedTab() ?? null }
  })

  /*
    Two areas registered from their own modules rather than written out here.

    Both are wiring whose *shape* is the interesting part — a permission answer has to be matched against
    the prompt actually on screen, and a media request has to be resolved to the session that fetched the
    stream — and both would otherwise add sixty lines to a file that is already the longest list of
    channels in the project. The seam also lets each be tested against a fake `handle`.
  */
  registerPermissionHandlers({ permissions: deps.permissions })
  registerMediaHandlers({
    handle,
    media: deps.media,
    windows,
    // Read per call, so a language change reaches the next refusal rather than the next restart.
    locale: () => resolveLocale(settings.get('appearance.uiLanguage'))
  })
  registerDownloadHandlers({ handle, downloads: deps.downloads, windows })

  // --- element picker and the user's own rules ------------------------------
  /*
    Resolved from the *sender's* window and then from a tab in it, never from "the focused window".

    The picker writes a rule for the site in a specific tab. Guessing the wrong window would write a rule for
    a site the user was not looking at — and, worse, could write from a private window's page into the normal
    profile's rules, because that is where the editor would have come from.
  */
  handle('picker:start', (payload, event) => {
    const window = windows.resolve(event)
    const tab = window?.resolveTab(payload.tabId)
    if (tab === undefined) return { started: false }
    return { started: deps.picker.start(tab.view.webContents.id) }
  })
  handle('picker:stop', (payload, event) => {
    const window = windows.resolve(event)
    const tab = window?.resolveTab(payload.tabId)
    if (tab !== undefined) deps.picker.stop(tab.view.webContents.id)
    return OK
  })

  /*
    Opened by the core because it is a native menu.

    Everything it needs is read at open time rather than passed in: the blocked count belongs to the tab that
    is showing, the rule count changes as the user picks elements, and the blocker's state is a setting. A
    payload carrying any of them would be a second copy of a number that had already moved.
  */
  // --- per-tile navigation bar ----------------------------------------------
  /*
    Reported by the overlay, because it is the only renderer whose document covers the tiles.

    The chrome UI's own DOM sits beneath every page and never sees a pointer move there — which is the same
    reason the bar has to be drawn on the overlay in the first place.
  */
  handle('tiles:pointerAt', ({ tileIndex, y }, event) => {
    windows.resolve(event)?.requestTileBar({ invokedBy: 'pointer', tileIndex, y })
    return OK
  })

  // --- reader mode ----------------------------------------------------------
  /*
    Answered from what the core already harvested, keyed by id.

    Not from a URL the page supplies, and that is the whole privilege story: the harvest happens once, from the
    page the user was looking at, when they asked for reader mode. A reader page that could name an address would
    be able to have the browser fetch and render any site's text inside a document that holds a bridge.
  */
  handle('reader:get', ({ id }) => readerOutcomeFor(id))

  // --- find in page ---------------------------------------------------------
  /*
    Resolved from the *sender's* window, never from "the focused window", and the tile is resolved inside the
    controller. `find:open` carries no tab because the answer to "which tile did the user mean" is the active
    one, and deciding that in the core keeps it in one place.
  */
  handle('find:open', (_payload, event) => {
    const window = windows.resolve(event)
    if (window !== undefined) findService().open(window)
    return OK
  })
  handle('find:query', ({ tabId, query }, event) => {
    const window = windows.resolve(event)
    if (window !== undefined) findService().setQuery(window, tabId, query)
    return OK
  })
  handle('find:step', ({ tabId, forward }, event) => {
    const window = windows.resolve(event)
    if (window !== undefined) {
      findService().step(window, { ...(tabId === undefined ? {} : { tabId }), forward })
    }
    return OK
  })

  handle('blocker:menu', (_payload, event) => {
    const window = windows.resolve(event)
    const tab = window?.resolveTab()
    if (window === undefined || tab === undefined) return OK
    const state = tab.toState()
    buildBlockerMenu({
      locale: resolveLocale(settings.get('appearance.uiLanguage')),
      blockedOnPage: state.blockedRequests,
      userRuleCount: deps.userRules.rules().length,
      blockerEnabled: settings.get('privacy.blockerEnabled'),
      // The same rule the page menu uses, and through the same function: no host, no rule to key on.
      canPickElement: injectableDocumentUrl(state.url, '') !== null,
      onBlockElement: () => {
        deps.picker.start(tab.view.webContents.id)
      },
      onOpenSettings: () => window.emit('shortcut:triggered', { action: 'settings' }),
      onRefreshLists: () => {
        void windows.refreshFilters()
      },
      onSetBlockerEnabled: (enabled) => {
        settings.set('privacy.blockerEnabled', enabled)
      }
    }).popup({ window: window.window })
    return OK
  })

  handle('userrules:list', () => deps.userRules.rules())
  handle('userrules:setEnabled', ({ id, enabled }, event) => {
    // Through the mode-bound editor rather than the store, so a private window cannot alter the rules the
    // normal profile keeps — the same reason the picker takes its editor from the sending window.
    editorFor(event).setEnabled(id, enabled)
    return OK
  })
  handle('userrules:remove', ({ id }, event) => {
    editorFor(event).remove(id)
    return OK
  })

  // --- content blocker -----------------------------------------------------
  /*
    Not resolved from the sender, unlike almost everything else here.

    The blocker's rules are one global configuration rather than window state, so there is nothing to
    resolve: every window blocks the same things, including private ones. Asking the registry rather
    than holding the subscription directly keeps the number of things `registerIpcHandlers` has to be
    handed from growing for no gain.
  */
  handle('filters:getStatus', () => windows.filterStatus())
  handle('filters:refresh', async () => {
    await windows.refreshFilters()
    return windows.filterStatus()
  })

  // --- tab groups ----------------------------------------------------------
  /*
    Every one of these resolves the *sending window* and acts on its groups.

    A group is window state: it decides which tabs the strip draws and which of them may hold a tile.
    Taking a window id in the request instead would let one window fold away another window's tabs,
    and the sender is the only source a renderer cannot lie about. Same rule as the tab handlers above.

    The store's errors — no such group, too many groups, a group with no tabs — travel back as
    rejections rather than being swallowed, because each one is something the user did and can undo.
  */
  handle('tabgroups:create', ({ tabIds, name, color }, event) => {
    const controller = windows.resolve(event)
    if (controller === undefined) throw new Error('no window for this sender')
    return controller.groups.create({
      tabIds,
      ...(name === undefined ? {} : { name }),
      ...(color === undefined ? {} : { color })
    })
  })

  handle('tabgroups:rename', ({ id, name }, event) => {
    windows.resolve(event)?.groups.rename(id, name)
    return OK
  })

  handle('tabgroups:recolor', ({ id, color }, event) => {
    windows.resolve(event)?.groups.recolor(id, color)
    return OK
  })

  handle('tabgroups:setCollapsed', ({ id, collapsed }, event) => {
    windows.resolve(event)?.groups.setCollapsed(id, collapsed)
    return OK
  })

  handle('tabgroups:dissolve', ({ id }, event) => {
    windows.resolve(event)?.groups.dissolve(id)
    return OK
  })

  handle('tabgroups:addTab', ({ groupId, tabId, index }, event) => {
    windows.resolve(event)?.groups.addTab(groupId, tabId, index)
    return OK
  })

  handle('tabgroups:removeTab', ({ tabId }, event) => {
    windows.resolve(event)?.groups.removeTab(tabId)
    return OK
  })

  /*
    The menu is built here rather than in the window, because this is where the locale lives.

    Every action is a closure over the same controller the channels above use, so a menu item and a
    keyboard-driven call cannot end up doing different things — which is exactly what a second code
    path for the same operations would produce.
  */
  handle('tabs:contextMenu', ({ tabId }, event) => {
    const controller = windows.resolve(event)
    if (controller === undefined) return OK
    const groups = controller.groups
    buildTabContextMenu({
      locale: activeLocale(settings.get('appearance.uiLanguage')),
      tabId,
      groups: groups.groups(),
      onCreateGroup: (tabIds, color) => {
        groups.create({ tabIds, ...(color === undefined ? {} : { color }) })
      },
      onAddToGroup: (groupId, id) => groups.addTab(groupId, id),
      onRemoveFromGroup: (id) => groups.removeTab(id),
      onRecolor: (groupId, color) => groups.recolor(groupId, color),
      onDissolve: (groupId) => groups.dissolve(groupId),
      onCloseTab: (id) => controller.closeTab(id),
      onSetPinned: (id, pinned) => controller.setTabPinned(id, pinned),
      isPinned: (id) => controller.resolveTab(id)?.pinned === true
    }).popup({ window: controller.window })
    return OK
  })

  // --- navigation ----------------------------------------------------------
  handle('nav:goBack', ({ tabId }, event) => {
    windows.resolve(event)?.resolveTab(tabId)?.goBack()
    return OK
  })

  handle('nav:goForward', ({ tabId }, event) => {
    windows.resolve(event)?.resolveTab(tabId)?.goForward()
    return OK
  })

  handle('nav:reload', ({ tabId, ignoreCache }, event) => {
    windows.resolve(event)?.resolveTab(tabId)?.reload(ignoreCache ?? false)
    return OK
  })

  handle('nav:stop', ({ tabId }, event) => {
    windows.resolve(event)?.resolveTab(tabId)?.stop()
    return OK
  })

  handle('nav:navigate', ({ input, tabId }, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    const url = controller.navigateFromInput(input, tabId)
    return { url: url ?? '' }
  })

  handle('nav:getBackForwardList', ({ tabId }, event) => {
    const tab = windows.resolve(event)?.resolveTab(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return []

    const history = tab.view.webContents.navigationHistory
    const active = history.getActiveIndex()
    return history.getAllEntries().map((entry, index) => ({
      url: entry.url,
      title: entry.title,
      offset: index - active
    }))
  })

  // --- split view ----------------------------------------------------------
  handle('split:setLayout', ({ layout }, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    controller.setLayout(layout)
    return controller.split.toState()
  })

  handle('split:setFractions', ({ fractions }, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    controller.setFractions(fractions)
    return controller.split.toState()
  })

  handle('split:setActiveTile', ({ tileIndex }, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    controller.setActiveTile(tileIndex)
    return controller.split.toState()
  })

  handle('split:assignTab', ({ tabId, tileIndex }, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    controller.assignTabToTile(tabId, tileIndex)
    return controller.split.toState()
  })

  handle('split:toggleTileMaximized', ({ tileIndex }, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    controller.toggleTileMaximized(tileIndex)
    return controller.split.toState()
  })

  handle('split:escape', (_payload, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    controller.escape()
    return controller.split.toState()
  })

  // --- media ---------------------------------------------------------------
  handle('media:setTileMuted', ({ tileIndex, muted }, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    controller.setTileMuted(tileIndex, muted)
    return controller.split.toState()
  })

  // --- devtools ------------------------------------------------------------
  handle('devtools:toggle', ({ tabId }, event) => {
    windows.resolve(event)?.resolveTab(tabId)?.toggleDevTools()
    return OK
  })

  // --- i18n ----------------------------------------------------------------
  handle('i18n:getCatalog', () => {
    const locale = activeLocale(settings.get('appearance.uiLanguage'))
    return { locale, messages: { ...catalogs[locale] } }
  })

  // --- shortcuts -----------------------------------------------------------
  handle('shortcuts:getBindings', () => {
    const platform = currentPlatform()
    const overrides = settings.get('advanced.customShortcuts')
    const locale = activeLocale(settings.get('appearance.uiLanguage'))

    return SHORTCUT_ACTIONS.map((action): ShortcutBinding => {
      const accelerator = acceleratorFor(platform, action, overrides)
      const conflict = conflictFor(platform, accelerator)
      return {
        action,
        accelerator,
        knownConflict: conflict !== null,
        // Spec 9: when a combination never reaches the application, say so and
        // suggest an alternative rather than showing a binding that does
        // nothing.
        conflictNote:
          conflict === null
            ? null
            : translate(locale, conflict.messageKey, { alternative: conflict.alternative })
      }
    })
  })

  // --- quick links (start page, spec 1) ------------------------------------
  handle('quicklinks:list', () => windows.quickLinkCards(quickLinks.list()))

  handle('quicklinks:create', (payload) =>
    quickLinks.create({
      kind: payload.kind,
      title: payload.title,
      ...(payload.url === undefined ? {} : { url: payload.url }),
      ...(payload.parentId === undefined ? {} : { parentId: payload.parentId }),
      ...(payload.index === undefined ? {} : { index: payload.index })
    })
  )

  handle('quicklinks:update', ({ id, title, url }) =>
    quickLinks.update(id, {
      ...(title === undefined ? {} : { title }),
      ...(url === undefined ? {} : { url })
    })
  )

  handle('quicklinks:remove', ({ id }) => {
    quickLinks.remove(id)
    return OK
  })

  handle('quicklinks:move', ({ id, parentId, toIndex }) => {
    quickLinks.move(id, parentId, toIndex)
    return quickLinks.list()
  })

  /**
   * Opening happens in the core, not by handing a URL back to the page: the start
   * page must not be able to make the browser navigate to an arbitrary address,
   * only to a tile the user previously saved.
   */
  handle('quicklinks:open', ({ id, newTab, background }, event) => {
    const link = findLink(quickLinks.list(), id)
    if (link === undefined) throw new Error(`Quick link not found: ${id}`)
    if (link.kind !== 'link') throw new Error('A folder cannot be opened as a page')

    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')

    if (newTab === true) {
      controller.createTab({ url: link.url, background: background ?? false })
    } else {
      // Navigate the view the start page itself is showing in, so clicking a tile
      // behaves like following a link rather than spawning a tab.
      const senderTab = controller.tabForWebContents(event.sender.id) ?? controller.activeTab()
      if (senderTab) senderTab.loadUrl(link.url)
      else controller.createTab({ url: link.url })
    }

    return { url: link.url }
  })

  // --- extensions ----------------------------------------------------------
  handle('extensions:list', () => extensions.list())

  handle('extensions:load', async (_payload, event) => {
    const controller = windows.resolve(event)
    // The path comes from the OS picker, never from the renderer: loading a directory
    // means executing the code in it, so the choice has to be the user's.
    const result = await dialog.showOpenDialog(controller?.window ?? undefined as never, {
      properties: ['openDirectory'],
      message: 'Choose an unpacked extension folder'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { extension: null, error: null }
    }

    try {
      return { extension: await extensions.load(result.filePaths[0]!), error: null }
    } catch (error) {
      return { extension: null, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('extensions:remove', ({ id }) => {
    extensions.remove(id)
    return OK
  })


  // --- browsing history ----------------------------------------------------
  handle('history:query', (criteria) => {
    /*
      Rebuilt key by key rather than passed through. `exactOptionalPropertyTypes` treats an absent
      field and one holding `undefined` as different types, and a request that crossed IPC has the
      second shape — so spreading it would hand the store `{ text: undefined }` and claim a filter
      that was never asked for.
    */
    return history.query({
      ...(criteria.text === undefined ? {} : { text: criteria.text }),
      ...(criteria.from === undefined ? {} : { from: criteria.from }),
      ...(criteria.to === undefined ? {} : { to: criteria.to }),
      ...(criteria.limit === undefined ? {} : { limit: criteria.limit })
    })
  })

  /**
   * Follows an entry in the tab that asked.
   *
   * The target tab comes from the sender, never from the request — the history page may steer
   * itself and nothing else. `quicklinks:open` established the pattern and the reasoning: a page
   * granted `nav:navigate` could redirect any tab in the window.
   */
  handle('history:open', ({ url, newTab, background }, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')

    if (newTab === true) {
      controller.createTab({ url, ...(background === undefined ? {} : { background }) })
      return { url }
    }

    const sender = controller.tabForWebContents(event.sender.id)
    // Falls back to the active tile only when the sender is not a tab of this window, which is
    // the chrome UI asking on the user's behalf.
    const resolved = controller.navigateFromInput(url, sender?.id)
    if (resolved === null) throw new Error(`Not a usable address: ${url}`)
    return { url: resolved }
  })

  handle('history:removeVisit', ({ url }) => ({ removed: history.removeVisit(url) }))
  handle('history:removeDomain', ({ domain }) => ({ removed: history.removeDomain(domain) }))
  handle('history:removeRange', ({ from, to }) => ({ removed: history.removeRange(from, to) }))
  handle('history:clear', () => ({ removed: history.clear() }))

  // --- bookmarks -----------------------------------------------------------
  /*
    No mode-bound writer here, unlike history, favicons, thumbnails and downloads. The line
    `BookmarkStore` draws: *observed* data is mode-bound, *requested* data is not.

    Every refusal the tree rules produce — no such node, a folder asked to hold itself, an address
    that is really a search term — travels back as a rejected invoke, because each one is something
    the person did and can undo.
  */
  handle('bookmarks:list', () => bookmarks.list())
  // Rebuilt key by key: `exactOptionalPropertyTypes` treats an absent field and one holding
  // `undefined` as different types, and a request that crossed IPC has the second shape.
  handle('bookmarks:create', (payload) =>
    bookmarks.create({
      kind: payload.kind,
      title: payload.title,
      ...(payload.url === undefined ? {} : { url: payload.url }),
      ...(payload.parentId === undefined ? {} : { parentId: payload.parentId }),
      ...(payload.index === undefined ? {} : { index: payload.index })
    })
  )
  handle('bookmarks:update', ({ id, title }) =>
    bookmarks.update(id, { ...(title === undefined ? {} : { title }) })
  )
  handle('bookmarks:relocate', ({ id, url }) => bookmarks.relocate(id, url))
  handle('bookmarks:remove', ({ id }) => ({ removed: bookmarks.remove(id) }))
  // Answers with the whole tree, so the page never redraws from a position it worked out itself.
  handle('bookmarks:move', ({ id, parentId, toIndex }) => {
    bookmarks.move(id, parentId, toIndex)
    return bookmarks.list()
  })

  /**
   * Follows a bookmark in the tab that asked — never `nav:navigate`, which would let this page steer
   * any tab in the window. `quicklinks:open` established the pattern and `history:open` follows it.
   */
  handle('bookmarks:open', ({ url }, event) => {
    const controller = windows.resolve(event)
    if (!controller) throw new Error('No window for this request')
    const sender = controller.tabForWebContents(event.sender.id)
    // Falls back to the active tile only when the sender is not a tab of this window, which is the
    // chrome UI asking on the user's behalf.
    const resolved = controller.navigateFromInput(url, sender?.id)
    if (resolved === null) throw new Error(`Not a usable address: ${url}`)
    return { url: resolved }
  })

  /**
   * Reads an exported bookmark file into the tree.
   *
   * The path comes from the OS picker rather than from the request, exactly as `extensions:load` does,
   * and the store is handed the file's *text* — so a compromised renderer cannot ask the core to read
   * an arbitrary file and hand back its contents, and cannot sidestep that one layer down either.
   */
  handle('bookmarks:import', async (_payload, event) => {
    const controller = windows.resolve(event)
    const locale = activeLocale(settings.get('appearance.uiLanguage'))
    const chosen = await dialog.showOpenDialog(controller?.window ?? (undefined as never), {
      properties: ['openFile'],
      title: translate(locale, 'bookmarks.import'),
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }]
    })
    // Cancelling is an answer, not a failure and not "nothing was imported" — the page says nothing
    // at all for this case, where it reports a count for the other.
    if (chosen.canceled || chosen.filePaths.length === 0) {
      return { imported: 0, skipped: 0, cancelled: true }
    }

    const html = await readFile(chosen.filePaths[0]!, 'utf8')
    const summary = bookmarks.import(html, translate(locale, 'bookmarks.importedFolder'))
    return { ...summary, cancelled: false }
  })

  // --- saved passwords -----------------------------------------------------
  /*
    Six one-line forwards, and that is the whole of this block on purpose: every decision lives in
    `PasswordApi`, which is free of Electron and therefore measurable — and the operations that touch
    a password vault are the ones this project would least like to have only in a file no test reaches.

    `update` is rebuilt key by key for the `exactOptionalPropertyTypes` reason above, which here is
    not pedantry: spreading the request would hand the vault `{ password: undefined }` and claim an
    edit nobody asked for, and the edit in question overwrites a password.
  */
  handle('passwords:list', () => passwords.list())
  handle('passwords:reveal', ({ id }) => passwords.reveal({ id }))
  handle('passwords:create', ({ url, username, password }) =>
    passwords.create({ url, username, password })
  )
  handle('passwords:update', ({ id, username, password }) =>
    passwords.update({
      id,
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password })
    })
  )
  handle('passwords:remove', ({ id }) => passwords.remove({ id }))
  handle('passwords:forgetNeverSaved', ({ origin }) => passwords.forgetNeverSaved({ origin }))

  assertAllChannelsRegistered()
}

function activeLocale(preference: 'system' | 'de' | 'en'): Locale {
  if (preference !== 'system') return preference
  return resolveLocale(app.getLocale())
}

/** Re-exported so the menu builder shares one source for accelerators. */
export { DEFAULT_BINDINGS }
