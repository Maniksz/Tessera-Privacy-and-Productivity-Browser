import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  net,
  safeStorage,
  session,
  shell,
  webContents
} from 'electron'
import { resolveLocale, translate, type Locale } from '@shared/i18n/catalog.js'
import { SettingsStore } from './settings/SettingsStore.js'
import { WindowRegistry } from './browser/WindowRegistry.js'
import { registerIpcHandlers } from './ipc/handlers.js'
import { installApplicationMenu } from './menu/appMenu.js'
import { applyRuntimeFlags } from './runtime-flags.js'
import {
  readCheckModule,
  readStartupFlags,
  startupFlagsFrom,
  writeStartupFlags
} from './startup-flags.js'
import { openLocalDataProtection } from './data/local-data-protection.js'
import { applySecureDns } from './session/hardening.js'
import { registerAsDefaultBrowser, registerInternalProtocol, registerInternalSchemePrivileges } from './protocol.js'
import {
  currentPlatform,
  extensionsFile,
  bookmarksFile,
  downloadsFile,
  faviconCacheDir,
  historyFile,
  defaultDownloadsDir,
  filterListCacheDir,
  localDataKeyFile,
  permissionsFile,
  passwordsFile,
  passwordVaultKeyFile,
  quickLinksFile,
  sessionStateFile,
  settingsFile,
  startupFlagsFile,
  tabGroupsFile,
  thumbnailCacheDir,
  unencryptedDataNoticeFile,
  userRulesFile
} from './paths.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import { QuickLinkStore } from './data/QuickLinkStore.js'
import { ExtensionStore } from './data/ExtensionStore.js'
import { HistoryStore } from './data/HistoryStore.js'
import { FaviconStore } from './data/FaviconStore.js'
import { ThumbnailStore } from './data/ThumbnailStore.js'
import { TabGroupStore } from './data/TabGroupStore.js'
import { SessionStore } from './data/SessionStore.js'
import { BookmarkStore } from './data/BookmarkStore.js'
import { DownloadStore } from './data/DownloadStore.js'
import { applySessionRestore } from './session-restore/apply.js'
import { restoreSettingsFrom } from './session-restore/settings.js'
import { FilterSubscription } from './privacy/FilterSubscription.js'
import { CosmeticInjector } from './privacy/CosmeticInjector.js'
import { ElementPicker } from './privacy/ElementPicker.js'
import { pickerChromeFor } from './privacy/picker-chrome.js'
import { buildPageContextMenu } from './menu/pageContextMenu.js'
import { UserRuleStore } from './data/UserRuleStore.js'
import { PermissionStore } from './data/PermissionStore.js'
import { forgetfulSitePermissions } from './permissions/model.js'
import { PermissionArbiter } from './permissions/PermissionArbiter.js'
import { MediaSessions } from './media/MediaSessions.js'
import { DownloadManager } from './downloads/DownloadManager.js'
import { PasswordApi } from './passwords/PasswordApi.js'
import { PasswordVault } from './passwords/PasswordVault.js'
import { AutofillService } from './passwords/AutofillService.js'
import { installAutofill } from './passwords/install-autofill.js'
import { MasterPasswordPrompt } from './passwords/MasterPasswordPrompt.js'
import { installUpdateChecks } from './updates/install-updates.js'
import type { UpdateService } from './updates/UpdateService.js'

/**
 * Application entry point.
 *
 * The ordering here is load-bearing and mostly not obvious, so each step says
 * why it sits where it does.
 */

// A second instance must hand its URL to the running one rather than opening a
// separate browser with a separate session.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

/**
 * Settings are needed to build the command line, but `SettingsStore.open` is
 * async and Chromium reads its command line during initialisation — too early to
 * await anything. So the few restart-scoped flags are read synchronously from
 * the file here, with defaults as the fallback, and the full store is opened
 * once the app is ready.
 */
function bootstrapFlags(): void {
  /*
    Read from `startup-flags.json`, not from `settings.json`.

    These two values become Chromium command-line switches, which must be set before
    `app.whenReady()` — and `settings.json` is encrypted, with `safeStorage` not reliable that
    early on Linux. Reading it here would land in a `catch` on every launch and
    `advanced.hardwareAcceleration: false` would silently stop working. See `startup-flags.ts`.
  */
  const flags = readStartupFlags(startupFlagsFile(), startupFlagsFrom(defaultSettings()))
  applyRuntimeFlags(flags)
}

bootstrapFlags()
registerInternalSchemePrivileges()

// Never started, and stated explicitly rather than by omission (spec 4).
// crashReporter.start() is intentionally absent.

let settings: SettingsStore | null = null
let windows: WindowRegistry | null = null
let quickLinks: QuickLinkStore | null = null
let extensions: ExtensionStore | null = null
let history: HistoryStore | null = null
let favicons: FaviconStore | null = null
let thumbnails: ThumbnailStore | null = null
let tabGroups: TabGroupStore | null = null
let sessionStore: SessionStore | null = null
let bookmarks: BookmarkStore | null = null
let downloads: DownloadStore | null = null
let passwords: PasswordVault | null = null
let userRules: UserRuleStore | null = null
let elementPicker: ElementPicker | null = null
let permissionStore: PermissionStore | null = null

/**
 * Everything that must finish writing before the process exits.
 *
 * A registry rather than a hand-written list of names at the shutdown site, because that list was
 * already wrong. History, favicons, thumbnails and tab groups each arrived with a `flush()` and none of
 * them reached `before-quit` — so whatever they had buffered when the user chose Quit was lost to a
 * debounce timer that never got to fire. A visit from thirty seconds ago simply was not in the file.
 *
 * Nothing about the old shape made that visible: four separate omissions in four separate commits, in
 * a different part of a different file from the store being added. Registering at the point of opening
 * puts the two lines next to each other, and the architecture test below asserts that every store with
 * a `flush` is in here.
 */
const flushOnExit: Array<() => Promise<unknown>> = []

async function main(): Promise<void> {
  await app.whenReady()

  /*
    One decision about protection, made once and handed to every store, so the browser cannot end
    up with an encrypted quick-links file next to a readable settings one.

    `safeStorage` is asked only after `whenReady`, which is the earliest it answers reliably on
    Linux — the reason the two startup switches come from their own file instead.
  */
  const protection = await openLocalDataProtection({
    safeStorage,
    keyFilePath: localDataKeyFile(),
    noticeFilePath: unencryptedDataNoticeFile()
  })
  if (protection.mode === 'unencrypted') {
    console.warn('[data] local data is NOT encrypted:', protection.reason)
  }

  settings = await SettingsStore.open(settingsFile(), protection.codec)
  flushOnExit.push(() => settings?.flush() ?? Promise.resolve())
  if (settings.quarantinedFileOnLoad !== null) {
    // Not a warning to shrug at: the previous settings are intact in that file, and most often the
    // cause is a missing key rather than damage.
    console.warn('[settings] file could not be read; kept at', settings.quarantinedFileOnLoad)
  }
  if (settings.unknownKeysOnLoad.length > 0) {
    console.warn('[settings] file contains keys this build does not know:', settings.unknownKeysOnLoad)
  }

  applySecureDns(settings.snapshot())

  /*
    Opened before the protocol is registered, and that ordering is load-bearing.

    `tessera://favicon` is served by the handler below, so the cache it reads from has to exist by
    the time the handler can be called. Registering first and filling the store in later would work
    almost always and fail on the icons of the very first page — the one case nobody re-tests.

    `net.fetch` rather than the global `fetch`: it goes through Chromium's network stack, so the one
    request this cache ever makes per site obeys the same proxy, DNS and certificate settings as the
    page the icon belongs to. Node's fetch would quietly bypass all of it, including secure DNS.
  */
  const faviconStore = await FaviconStore.open({
    directory: faviconCacheDir(),
    fetch: (url) => net.fetch(url),
    codec: protection.codec
  })
  favicons = faviconStore
  flushOnExit.push(() => faviconStore.flush())
  if (faviconStore.recoveredFromInvalidFile) {
    console.warn('[favicons] index could not be used; icons will be fetched again')
  }

  /**
   * Start-page screenshots. Same ordering requirement as the icons above.
   *
   * The capturer is supplied here rather than inside the store, and that placement is the point: it
   * is the only layer that knows both which web contents an id refers to and what that view is
   * currently showing. The store asks for a picture of a page it saw a moment ago; by the time the
   * settle delay has passed the user may have navigated on, and a picture taken then would be filed
   * under the previous page's address — a card showing the wrong site.
   *
   * So the check is here, against the live view, and `null` means "not now" rather than an error.
   */
  const thumbnailStore = await ThumbnailStore.open({
    directory: thumbnailCacheDir(),
    capture: async ({ url, viewId }) => {
      const view = webContents.fromId(viewId)
      if (view === undefined || view.isDestroyed()) return null
      // Still the same page? A navigation during the settle delay invalidates the request.
      if (view.getURL() !== url) return null
      const image = await view.capturePage()
      return image.isEmpty() ? null : image
    },
    codec: protection.codec
  })
  thumbnails = thumbnailStore
  flushOnExit.push(() => thumbnailStore.flush())
  if (thumbnailStore.recoveredFromInvalidFile) {
    console.warn('[thumbnails] index could not be used; pictures will be taken again')
  }

  // Closed over as locals, not read from the module variables: the handler runs long after this
  // line, and a `?.` there would say a store might be missing when the ordering above is exactly
  // what guarantees it is not.
  registerInternalProtocol({
    favicons: (site) => {
      const found = faviconStore.find(site)
      if (found === null) return null
      return { filePath: found.filePath, contentType: found.entry.contentType }
    },
    thumbnails: (pageUrl) => {
      const found = thumbnailStore.find(pageUrl)
      if (found === null) return null
      return { filePath: found.filePath, contentType: found.contentType }
    }
  })
  registerAsDefaultBrowser()

  quickLinks = await QuickLinkStore.open({ filePath: quickLinksFile(), codec: protection.codec })
  flushOnExit.push(() => quickLinks?.flush() ?? Promise.resolve())
  if (quickLinks.recoveredFromInvalidFile) {
    console.warn('[quicklinks] file could not be used; started from an empty set')
  }

  /**
   * Extensions load into the normal browsing session only.
   *
   * A private window's session is in-memory and discarded with the window (spec 4);
   * putting third-party code there would defeat the point.
   */
  extensions = await ExtensionStore.open({ filePath: extensionsFile(), codec: protection.codec })
  flushOnExit.push(() => extensions?.flush() ?? Promise.resolve())
  const extensionFailures = await extensions.attach(session.defaultSession)
  for (const failure of extensionFailures) {
    console.warn('[extensions] could not reload, dropped from the list:', failure)
  }

  history = await HistoryStore.open({ filePath: historyFile(), codec: protection.codec })
  flushOnExit.push(() => history?.flush() ?? Promise.resolve())
  if (history.recoveredFromInvalidFile) {
    console.warn('[history] file could not be used; started from an empty history')
  }

  /*
    Written now and on every change, so the next launch reads current values.

    Writing it here as well as on change matters for an existing profile: without it the file would
    not exist until the user happened to change something, and the switches would stay at their
    defaults in the meantime.
  */
  const persistStartupFlags = (snapshot: SettingsSnapshot): void => {
    void writeStartupFlags(startupFlagsFile(), startupFlagsFrom(snapshot)).catch((error: unknown) => {
      // A failure here costs the *next* launch its switches, not this one. Worth saying, not worth
      // refusing to start over.
      console.warn('[startup-flags] could not be written:', String(error))
    })
  }
  persistStartupFlags(settings.snapshot())
  settings.onChange(({ snapshot }) => persistStartupFlags(snapshot))

  tabGroups = await TabGroupStore.open({ filePath: tabGroupsFile(), codec: protection.codec })
  flushOnExit.push(() => tabGroups?.flush() ?? Promise.resolve())
  if (tabGroups.recoveredFromInvalidFile) {
    console.warn('[tabgroups] file could not be used; started with no groups')
  }
  /*
    The session, opened before the first window so the plan can be read before anything exists.

    `retainTabs` used to be called here with nothing, and every stored group was emptied on every launch — the
    honest cost of a missing feature. It now happens once the restored ids are known; see the restore below.
  */
  /*
    Bookmarks, downloads and saved passwords.

    Registered for shutdown at the point of opening, which is the discipline the architecture test
    enforces: four stores once had a `flush()` and none of them reached `before-quit`, so a visit
    from thirty seconds before Quit was simply missing from the file.
  */
  bookmarks = await BookmarkStore.open({ filePath: bookmarksFile(), codec: protection.codec })
  flushOnExit.push(() => bookmarks?.flush() ?? Promise.resolve())
  if (bookmarks.recoveredFromInvalidFile) {
    // Worth a warning rather than a shrug: a bookmark collection is built by hand over years and
    // nothing else can recreate it.
    console.warn('[bookmarks] file could not be used; started from an empty set')
  }
  downloads = await DownloadStore.open({ filePath: downloadsFile(), codec: protection.codec })
  flushOnExit.push(() => downloads?.flush() ?? Promise.resolve())

  /*
    The vault, which owns its own `PasswordStore` rather than being one.

    It holds the key only while unlocked, so the document cannot be opened before somebody has
    proved knowledge of the master password — the re-authentication `safeStorage` alone cannot
    provide. `previousCodec` is the profile-wide codec and is used for *reading* once, to migrate a
    document sealed before the vault had a key of its own.

  */
  passwords = await PasswordVault.open({
    keyFilePath: passwordVaultKeyFile(),
    documentPath: passwordsFile(),
    safeStorage,
    previousCodec: protection.codec
  })
  flushOnExit.push(() => passwords?.flush() ?? Promise.resolve())

  /*
    The download manager, which is the Electron-bound half.

    Everything Electron-shaped that this feature needs is supplied here as a seam, and one of them is
    load-bearing in a way that reads as a mistake: `fileExists` is *synchronous*. Electron only
    offers `setSavePath` inside the `will-download` callback, and a handler that returns without
    having set one gets the native save dialogue — so probing the disk for a free file name cannot
    await. See the header of `DownloadManager`.

    `defaultDirectory` and `getSettings` are read per download rather than captured, so changing the
    download folder takes effect on the next file rather than the next launch.
  */
  const downloadManager = new DownloadManager({
    store: downloads,
    getSettings: () => settings?.snapshot() ?? defaultSettings(),
    defaultDirectory: () => defaultDownloadsDir(),
    fileExists: (path) => existsSync(path),
    shell: {
      openPath: (path) => shell.openPath(path),
      showItemInFolder: (path) => {
        shell.showItemInFolder(path)
      }
    }
  })

  const passwordVault = passwords

  /*
    Who asks for the master password.

    The clipboard is injected because paste has to work — the length floor pushes people towards
    passphrases they keep somewhere else — and because reading it *here*, in the main process, is what
    keeps the pasted text out of a renderer. That is the same rule the keystrokes follow, and this is
    the one place the two meet Electron.
  */
  const masterPasswordPrompt = new MasterPasswordPrompt({
    vault: passwordVault,
    readClipboard: () => clipboard.readText()
  })

  /*
    Autofill, and the wiring it had been waiting for.

    `AutofillService` and `installAutofill` were both complete, tested and *called by nothing*, which is
    the most expensive state this project keeps finding itself in: a feature that exists, passes its
    tests, and does not run. Three lines were missing, and every one of them is load-bearing.

    `modeFor` is what makes a private window fill without recording that it did, and it answers `null`
    for a view this browser cannot place — a devtools window, something being torn down — because the
    default for anything unaccounted for has to be "no".

    `onLock` is the third: without it a lock would be a half-truth. The key would be gone from the vault
    while a password the user typed two minutes ago sat in the save bar state for the rest of its two
    minutes. See `AutofillService.dropPendingSaves`.
  */
  const autofill = new AutofillService({
    vault: passwordVault,
    modeFor: (viewId) => {
      const controller = windows?.controllerForWebContents(viewId)
      if (controller === undefined) return null
      return controller.privateMode ? 'private' : 'normal'
    },
    // Read per call, so a language change reaches the next sign-in form rather than the next restart.
    locale: () => uiLocale(settings),
    now: () => Date.now()
  })
  passwordVault.onLock(() => autofill.dropPendingSaves())
  installAutofill(autofill)

  /*
    What the passwords page is allowed to do, and the two Electron-shaped things it needs.

    Both are injected rather than called inside `PasswordApi`, so every rule the import obeys and the
    ordering the reset obeys are testable without a dialog — and so the *core* reads the file. A
    page-side file input would have put an entire exported vault, in clear text, into one IPC message.
  */
  const passwordApi = new PasswordApi({
    vault: passwordVault,
    prompt: masterPasswordPrompt,
    chooseImportFile: async () => {
      const target = windows?.focused() ?? windows?.controllers[0]
      const chosen = await dialog.showOpenDialog(target?.window ?? (undefined as never), {
        properties: ['openFile'],
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      const [path] = chosen.canceled ? [] : chosen.filePaths
      if (path === undefined) return null
      return { path, text: await readFile(path, 'utf8') }
    },
    /*
      The offer to put the sealed vault aside before it is destroyed.

      A native message box rather than something on the page, and for a reason beyond convenience: this is
      the point of no return, and the sentence has to be read *here* — two clicks earlier, on a page, it
      would be a warning somebody scrolled past. `cancelId` and `defaultId` both point at Cancel, so
      Escape and a stray Return both keep the vault.

      `resetVaultConfirm` names its own buttons because a message box gives them no other explanation, and
      it says in the same breath what the copy is worth: unreadable without the master password that was
      just forgotten, and — when the key store wrapped it — only on this computer. A copy offered without
      that sentence would be a false promise of recovery.
    */
    askAboutVaultCopy: async () => {
      // Through `uiLocale`, which takes the store's absence as "ask the desktop": this closure runs long
      // after startup, and the raw setting is `'system'` until somebody picks a language by hand.
      const locale = uiLocale(settings)
      const target = windows?.focused() ?? windows?.controllers[0]
      const parent = target?.window
      /*
        `showMessageBox` takes an optional parent, unlike `showOpenDialog` above, so there is no cast here.

        Not a detail worth losing: with a parent the box is modal to that window, which is what makes it
        impossible to click the reset button again underneath it. Without one — no window open at all — it is
        application-modal, which is the correct fallback and the reason this is a real optional rather than a
        cast around one.
      */
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: translate(locale, 'passwords.resetVault'),
        message: translate(locale, 'passwords.resetVaultConfirm'),
        buttons: [
          translate(locale, 'passwords.saveChanges'),
          translate(locale, 'passwords.resetVault'),
          translate(locale, 'passwords.cancel')
        ],
        defaultId: 2,
        cancelId: 2
      }
      const answer = await (parent === undefined
        ? dialog.showMessageBox(options)
        : dialog.showMessageBox(parent, options))
      if (answer.response === 2) return { choice: 'cancel' }
      if (answer.response === 1) return { choice: 'discard' }

      const where = await dialog.showOpenDialog(parent ?? (undefined as never), {
        properties: ['openDirectory', 'createDirectory'],
        title: translate(locale, 'passwords.resetVault')
      })
      const [directory] = where.canceled ? [] : where.filePaths
      /*
        Closing the folder chooser cancels the *whole* operation rather than falling through to the
        deletion. Somebody who asked to keep a copy and then closed the picker has not agreed to lose it,
        and reading that as "delete anyway" is the one misreading this offer exists to prevent.
      */
      if (directory === undefined) return { choice: 'cancel' }
      return { choice: 'copy', directory }
    }
  })

  sessionStore = await SessionStore.open({ filePath: sessionStateFile(), codec: protection.codec })
  flushOnExit.push(() => sessionStore?.flush() ?? Promise.resolve())
  if (sessionStore.recoveredFromInvalidFile) {
    console.warn('[session] file could not be used; started with no session to restore')
  }

  /*
    The blocker, wired at last.

    `net.fetch` rather than Node's global, and the store *requires* the fetcher for exactly that
    reason: a list download must go through Chromium's network stack, so it obeys the same proxy, the
    same secure DNS and the same certificate store as the pages the list protects. Node's fetch would
    slip past a tunnel the user turned on — one request every five days, to a third party, outside the
    protection the user configured.

    Built here and *started* further down, after the first window exists. Constructing it is what closes
    the gate top-level navigations wait at, so the two cannot be reordered into a window that loads
    before the blocker has an opinion.
  */
  /*
    The user's own rules, kept apart from the downloaded lists.

    Compiled separately by `FilterEngine` for a concrete reason: adding one picker rule would otherwise
    reparse a hundred thousand lines on the main process's own thread while the user waits, and a
    hand-made rule changes far more often than a published list does.
  */
  userRules = await UserRuleStore.open({ filePath: userRulesFile(), codec: protection.codec })
  flushOnExit.push(() => userRules?.flush() ?? Promise.resolve())
  if (userRules.recoveredFromInvalidFile) {
    // Worth a warning rather than a shrug: these are rules the user made by hand, and nothing else
    // can recreate them.
    console.warn('[user-rules] file could not be used; started with no rules of your own')
  }

  const filterSubscription = new FilterSubscription({
    directory: filterListCacheDir(),
    fetchList: async (url) => {
      const response = await net.fetch(url)
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      return response.text()
    },
    getSettings: () => settings?.snapshot() ?? defaultSettings(),
    userRules: () => userRules?.enabledText() ?? ''
  })
  /*
    The two halves of a filter list that act on the page rather than on the network.

    Installed here rather than in `applySessionHardening`, because it needs the engine and hardening is
    per-session while this is per-application. Blocking a request removes an advert; it does not remove
    the space it occupied, and roughly a third of what a filter list contains is the rules that close
    that hole. Without this, fifty thousand of them are parsed on every launch and never used.

    `scriptletsFor` is the other half, and it was the larger gap of the two: 2 112 of the rules in the
    three default lists are `##+js(…)`, which no amount of hiding can substitute for — they exist for
    pages whose own script decides what to show. They were not merely unused before; they were being
    written into the page's stylesheet as if they were selectors, where each one invalidated the whole
    CSS rule it was joined into. See `shared/filters/selector-safety.ts`.
  */
  const cosmeticInjector = new CosmeticInjector({
    getSettings: () => settings?.snapshot() ?? defaultSettings(),
    stylesFor: (documentUrl) => filterSubscription.engine.cosmeticStylesFor(documentUrl),
    openFeed: (documentUrl) => filterSubscription.engine.openCosmeticFeed(documentUrl),
    scriptletsFor: (documentUrl) => filterSubscription.engine.scriptletsFor(documentUrl),
    proceduralFor: (documentUrl) => filterSubscription.engine.proceduralSelectorsFor(documentUrl)
  })
  cosmeticInjector.install()

  /*
    The two halves of "a rule the user just wrote takes effect".

    Recompiling was the half that existed, and on its own it only ever reached the *next* page load:
    the engine knew about the rule and no open document was ever told, so the element picker looked
    broken — you pointed at a banner and the banner stayed. `refresh` is the other half, and the order
    of these two lines is the requirement rather than the reading order: it re-serves from the engine
    that the line above has just rebuilt.

    Only the user's own rules are recompiled here; the downloaded lists are left alone. Registered
    after the injector exists rather than beside the store, which is where it used to sit — a
    subscription that reaches forward to a variable declared below it is a load-order bug waiting for
    somebody to make this function eager.
  */
  userRules.onChange(() => {
    filterSubscription.reloadUserRules()
    cosmeticInjector.refresh()
  })

  /*
    The element picker, which is the "and I want to block things myself, like uBlock Origin" half.

    Its rules go into `UserRuleStore` bound to the sending window's browsing mode, so a private window's
    picker writes nothing — and that is a property of the editor it is handed rather than a check anywhere
    in the picker. A picked rule may only ever *hide*: `describeUserRule` refuses anything that would block
    a request, because hiding a banner and cutting a site off must not sit behind one click.
  */
  elementPicker = new ElementPicker({
    // Read per call and through `uiLocale`, so the picker's own labels follow the language the rest of
    // the interface is in — including the `'system'` default, which the raw setting does not answer.
    chrome: () => pickerChromeFor(uiLocale(settings)),
    editorFor: (webContentsId) => {
      const controller = windows?.controllerForWebContents(webContentsId)
      if (controller === undefined) return null
      return userRules?.editorFor(controller.privateMode ? 'private' : 'normal') ?? null
    }
  })
  elementPicker.install()

  /*
    Permission prompts (spec 4).

    Three pieces, and the split is the design: the *store* remembers answers per site, the *arbiter*
    decides and queues, and `permission-policy.ts` asks. Only the arbiter knows what to do when two pages
    ask at once — a real case in a split layout, and the reason this is not simply a dialogue.

    `rulesFor(mode)` binds to a browsing mode, so a private window's answer lasts for the life of that
    window and is written nowhere. As everywhere else here, that is a property of the object handed over
    rather than a check at each call site.
  */
  permissionStore = await PermissionStore.open({
    filePath: permissionsFile(),
    codec: protection.codec
  })
  flushOnExit.push(() => permissionStore?.flush() ?? Promise.resolve())
  if (permissionStore.recoveredFromInvalidFile) {
    console.warn('[permissions] file could not be used; every site will be asked again')
  }
  const permissionArbiter = new PermissionArbiter({
    /*
      The forgetful rules as the fallback, not a throw.

      Reaching it would mean the store failed to open, and the honest behaviour then is a browser that
      asks every time rather than one that cannot ask at all — remembering nothing is an inconvenience,
      refusing everything silently is a browser whose camera never works with no explanation.
    */
    rulesFor: (mode) => permissionStore?.rulesFor(mode) ?? forgetfulSitePermissions,
    getSettings: () => settings?.snapshot() ?? defaultSettings()
  })

  /*
    Media detection and download.

    One service per browsing *session* rather than per window: a stream is fetched by a session, and two
    windows sharing the normal one are looking at the same findings. A private window's session gets its
    own, released with the window — its findings name the addresses a page fetched, which is browsing
    history by another route.
  */
  const mediaSessions = new MediaSessions({
    hosts: () => windows?.controllers ?? [],
    directory: () => settings?.get('downloads.directory') ?? defaultDownloadsDir()
  })
  /*
    Not a flush but the same need: interrupting `writeAtomically` between its write and its rename leaves
    a `.tmp` file and no manifest, which the next launch reads as "nothing cached" and re-downloads
    every list.
  */
  flushOnExit.push(() => filterSubscription.whenIdle())

  windows = new WindowRegistry({
    settings,
    // The same resolver the menus use, so an internal tab and the menu bar can never disagree about
    // which language is in force.
    uiLocale: () => uiLocale(settings),
    quickLinks,
    history,
    favicons,
    thumbnails,
    tabGroups,
    filters: filterSubscription,
    sessionStore,
    // Bound to a browsing mode where the session is created, so a private window holds a recorder
    // that discards rather than a flag somebody has to remember to check.
    downloads: downloadManager,
    /*
      The page's right-click menu is assembled here because this is the only layer that has all of it: the
      language, whether the blocker is on, the element picker, and the window to open a link beside.

      Built fresh on every click rather than kept: the items depend on what was clicked — a link, an image, a
      selection, a text field — which is different every time.
    */
    onPageContextMenu: (controller, tab, target) => {
      const snapshot = settings?.snapshot() ?? defaultSettings()
      buildPageContextMenu({
        locale: uiLocale(settings),
        target,
        canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
        canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
        blockerEnabled: snapshot['privacy.blockerEnabled'],
        onBack: () => tab.view.webContents.navigationHistory.goBack(),
        onForward: () => tab.view.webContents.navigationHistory.goForward(),
        onReload: () => tab.view.webContents.reload(),
        onOpenLinkInNewTab: (url) => controller.createTab({ url, background: true }),
        onCopy: (text) => clipboard.writeText(text),
        onSearchFor: (text) => {
          /*
            Through `navigateFromInput`, not a second search resolver.

            That method is where the address-versus-search decision is made, deliberately in one place (spec
            1) — so a selection that happens to *be* an address opens as one, exactly as it would from the
            address bar. Building a search URL here would be a second opinion about what text means, and the
            two would disagree the first time somebody selected `example.com`.
          */
          const opened = controller.createTab({})
          controller.navigateFromInput(text, opened.id)
        },
        onBlockElement: () => {
          elementPicker?.start(tab.view.webContents.id)
        },
        onInspect: () => tab.view.webContents.openDevTools({ mode: 'detach' })
      }).popup({ window: controller.window })
    }
  })

  /*
    The update service, declared here and built forty lines further down.

    The two calls are in this order on purpose and reordering them to avoid this variable would be a
    real loss: `registerIpcHandlers` is what calls `configureSenderPolicy`, so until it has run the
    router classifies *every* sender as untrusted. Building the update service first would start a
    three-second timer towards GitHub before the boundary it lives behind was configured. The
    handlers go up first; the network job comes after.

    So the dependency travels as a closure, exactly as `getSettings` and `parentWindow` do below and
    for a related reason — a value read at call time rather than captured at wiring time. A null
    check rather than a non-null assertion, and it throws rather than resolving quietly: an invoke
    that answered "fine" without checking anything is the failure the button exists to avoid. It is
    unreachable in practice, because the first window is created after both of these lines.
  */
  let updates: UpdateService | null = null

  registerIpcHandlers({
    settings,
    windows,
    quickLinks,
    extensions,
    history,
    bookmarks,
    downloads: downloadManager,
    passwords: passwordApi,
    prompt: masterPasswordPrompt,
    permissions: permissionArbiter,
    media: mediaSessions,
    picker: elementPicker,
    userRules,
    checkForUpdates: async () => {
      if (updates === null) throw new Error('The update checker has not started yet')
      await updates.checkOnDemand()
    }
  })

  /*
    The update check, started here and belonging to the application rather than to a window.

    One timer for the program: a check per window would multiply the requests by however many windows
    somebody keeps open, and a timer created with a private window would outlive the session it was
    born in. `installUpdateChecks` starts it — it does not return something for a caller to remember
    to start, because that is exactly the shape `installAutofill()` had while autofill did not run at
    all.

    The two closures are read per use, not captured: the settings so that switching the check off
    stops the next one instead of the next launch, and the window so a message box is modal to
    whichever window the person is looking at when it appears — which may be a window that did not
    exist when this line ran, or none at all on macOS.
  */
  updates = installUpdateChecks({
    getSettings: () => settings?.snapshot() ?? defaultSettings(),
    locale: () => uiLocale(settings),
    parentWindow: () => (windows?.focused() ?? windows?.controllers[0])?.window ?? null
  })

  const locale = uiLocale(settings)
  installApplicationMenu({
    windows,
    settings,
    locale,
    platform: currentPlatform(),
    checkForUpdates: () => updates.checkNow()
  })

  // Rebuild the menu when the language or a shortcut changes, so accelerators
  // and labels never lag behind the settings (spec 5).
  settings.onChange(({ changed }) => {
    if (!settings || !windows) return
    if ('appearance.uiLanguage' in changed || 'advanced.customShortcuts' in changed) {
      installApplicationMenu({
        windows,
        settings,
        locale: uiLocale(settings),
        platform: currentPlatform(),
        checkForUpdates: () => updates.checkNow()
      })
    }
    if ('network.secureDnsMode' in changed || 'network.secureDnsServers' in changed) {
      applySecureDns(settings.snapshot())
    }
  })

  /*
    The session, and the tab-group reconciliation that depends on it.

    `beginRun` reads the plan out of the file and opens a fresh run in one call — the crash-loop counter is on
    disk before this line returns, which is what makes it a counter of launches that *started* a restore rather
    than of ones that finished. `retainTabs` is then called once, with every id that actually came back.
  */
  const plan = await sessionStore.beginRun(restoreSettingsFrom(settings.snapshot()))
  if (plan.kind === 'skip') {
    // Worth saying rather than shrugging at: a user who asked for their session and did not get it has no other
    // way to find out why, and `restore-keeps-crashing` is the reason they would most want to know.
    console.warn(`[session] not restoring the previous session: ${plan.reason}`)
    tabGroups.retainTabs([])
    windows.createWindow({ privateMode: false }).createTab({})
  } else {
    const registry = windows
    const groups = tabGroups
    applySessionRestore(plan.windows, {
      openWindow: (layout, fractions) => {
        const controller = registry.createWindow({
          privateMode: false,
          initialSplit: { layout, fractions: { ...fractions } }
        })
        return {
          openTab: (tab) => {
            controller.createTab({
              id: tab.id,
              url: tab.url,
              tileIndex: tab.tileIndex,
              // The pane comes back at the zoom it had, passed at creation rather than set
              // afterwards: nothing applies zoom before the first paint but `Tab`'s `zoomFactor`.
              zoomPercent: tab.zoomPercent,
              // Every restored tab opens in the background; the active tile is chosen once, afterwards, by the
              // plan — otherwise each tab would steal focus from the last on its way in.
              background: true,
              ...(tab.load === 'now' ? {} : { deferred: { url: tab.url, title: tab.title } })
            })
            if (tab.pinned) controller.setTabPinned(tab.id, true)
          },
          setActiveTile: (index) => controller.setActiveTile(index)
        }
      },
      retainTabs: (ids) => groups.retainTabs(ids)
    })
  }

  /*
    The lists, compiled after the window rather than before it.

    This used to be awaited two hundred lines up, where it put the whole compile — six hundred to
    fifteen hundred milliseconds of parsing on the main process's own thread — in front of the first
    thing the user sees. The engine is valid empty, so nothing here needed the wait; what did need it
    was the first *page*, and that is held in the pipeline for as long as the compile takes, to a hard
    ceiling. See `holdMainFrameRequests`.

    Not awaited, so a failure is caught here rather than falling out of `main()`. A blocker that could
    not read its cache is a browser without a blocker for one launch; exiting over it, with windows
    already on screen, would be the worse answer by a wide margin.
  */
  void filterSubscription.start().catch((error: unknown) => {
    console.warn('[filters] lists could not be compiled:', String(error))
  })

  /*
    Development only: the application drives its own checks and exits with the verdict.

    Started here because the window that has just been opened is what the checks drive. From
    *inside* the process, which is the whole point: driving a real window from outside means a
    Chromium process with an open debugging port spoken to over CDP, and that is the standard
    technique for reading cookies and saved passwords out of a browser — so endpoint protection
    flags exactly that shape, whoever started it and whichever port it uses.
  */
  const checkModule = readCheckModule(process.argv, { packaged: app.isPackaged })
  if (checkModule !== null) void runOwnChecks(checkModule)

  app.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => /^https?:\/\//i.test(arg))
    const target = windows?.focused() ?? windows?.controllers[0]
    if (!target) return
    target.window.focus()
    if (url !== undefined) target.createTab({ url })
  })

  // macOS: links from other applications, and the Dock's "new window".
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const target = windows?.focused() ?? windows?.controllers[0]
    if (target) target.createTab({ url })
    else windows?.createWindow({ privateMode: false }).createTab({ url })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windows?.createWindow({ privateMode: false }).createTab({})
    }
  })

  app.on('window-all-closed', () => {
    /*
      The third of the three ways the vault key goes away, and the only one that can be wired here.

      `PasswordVault` owns the explicit lock and the idle timeout; it has no way to know a window closed.
      On macOS this is the case that matters most: the application keeps running with no windows, so
      without this line a vault unlocked an hour ago would stay open on a machine whose owner has visibly
      finished — and `reveal.ts` names all three as the bound the unlock is held to.

      Before the quit, so the flush that `before-quit` performs writes a vault that has already been
      closed rather than one being closed underneath it.
    */
    void passwords?.lock()
    // macOS keeps the application running with no windows; the others quit.
    if (process.platform !== 'darwin') app.quit()
  })
}

/** What a check module has to expose, and everything it is given. */
interface CheckModule {
  run(handles: {
    webContents: typeof webContents
    /** `sendInputEvent` reaches a focused window only — Electron's own note on the method. */
    focus(): void
  }): Promise<number>
}

/**
 * Loads the check module, runs it, and exits 0 only if every check passed.
 *
 * The count of failures is printed by the module itself; the status is the answer to "did this build
 * pass", which is what a script or a CI step can act on.
 *
 * A runtime `import()` of a path outside `src/`, and that is a size decision rather than a style
 * one: the checks are a thousand lines of assertions, the main bundle is parsed once per launch by
 * every user, and its budget is already over. Bundled they would be paid for at every start; loaded
 * like this they cost a `readCheckModule` call.
 *
 * Waits for the first window's document, because everything the checks read is rendered by it —
 * `did-finish-load` rather than a delay, so a slow machine changes nothing.
 *
 * `app.exit` rather than `app.quit`: the verdict is the exit status, and `quit` would go through
 * `before-quit`, which cancels the first attempt to do its cleanup and would swallow the code.
 */
async function runOwnChecks(modulePath: string): Promise<void> {
  try {
    const [first] = BrowserWindow.getAllWindows()
    if (first?.webContents.isLoading() === true) {
      await new Promise<void>((resolve) => first.webContents.once('did-finish-load', () => resolve()))
    }
    const loaded = (await import(pathToFileURL(modulePath).href)) as Partial<CheckModule>
    const run = loaded.run
    if (run === undefined) throw new Error(`${modulePath} exports no run()`)
    const failures = await run({ webContents, focus: () => app.focus({ steal: true }) })
    app.exit(failures === 0 ? 0 : 1)
  } catch (error) {
    console.error('[checks] could not be run:', error)
    app.exit(1)
  }
}

/**
 * The language the interface is in.
 *
 * The one answer to that question in this process, and it takes a possibly-missing store on purpose:
 * every closure below runs long after startup, and the alternative each of them had reached for —
 * `resolveLocale(settings?.get('appearance.uiLanguage'))` — is not the same answer. `resolveLocale`
 * has never heard of `'system'`, which is the *default* value, so it fell through to English for
 * everybody who had not picked a language by hand. A German desktop got a German menu bar and an
 * English save-password bar.
 *
 * No store at all means the same thing as `'system'`: ask the desktop.
 */
function uiLocale(store: SettingsStore | null): Locale {
  const preference = store?.get('appearance.uiLanguage') ?? 'system'
  return preference === 'system' ? resolveLocale(app.getLocale()) : preference
}

/**
 * Shutdown.
 *
 * `before-quit` is where deletion has to happen, and it has to *finish* before
 * the process exits — spec 4 is explicit that a clear-on-exit which races the
 * shutdown runs into nothing. So the first pass cancels the quit, does the work,
 * and only then quits for real.
 */
let shutdownComplete = false

app.on('before-quit', (event) => {
  const store = settings
  if (shutdownComplete || store === null) return
  event.preventDefault()

  /*
    No more session writes from here on.

    The flush below records every window while they are all still open; the windows then close and would each
    drop their slot, turning "three windows were open" into "one window, closed" on the way out — and whether
    that landed would depend on whether the process outlived a debounce timer.

    It used to sit in the `open-url` handler, where it did the opposite of what it says: a quit never sealed
    anything, and one link opened from another application silenced the session recording for the rest of the
    run. Sealing belongs to the shutdown, next to the flush the comment is about.
  */
  sessionStore?.seal()

  void (async () => {
    try {
      if (store.get('clearData.onExit')) {
        await clearDataOnExit(store.get('clearData.onExitCategories'))
      }
      // Anything written after the process exits is lost, so everything registered is flushed and
      // awaited here rather than left to a debounce timer. `allSettled`, not `all`: one store that
      // cannot write must not stop the others from trying.
      const results = await Promise.allSettled(flushOnExit.map((flush) => flush()))
      for (const result of results) {
        if (result.status === 'rejected') console.error('[shutdown] a store could not be flushed:', result.reason)
      }
    } catch (error) {
      console.error('[shutdown] cleanup failed:', error)
    } finally {
      shutdownComplete = true
      app.quit()
    }
  })()
})

type StorageType = NonNullable<
  NonNullable<Parameters<Electron.Session['clearStorageData']>[0]>['storages']
>[number]

async function clearDataOnExit(categories: readonly string[]): Promise<void> {
  const target = session.defaultSession
  const storageTypes: StorageType[] = []

  if (categories.includes('cookies')) storageTypes.push('cookies')
  if (categories.includes('storage')) {
    storageTypes.push('localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem', 'shadercache')
  }

  const work: Array<Promise<unknown>> = []
  if (storageTypes.length > 0) work.push(target.clearStorageData({ storages: storageTypes }))
  if (categories.includes('cache')) work.push(target.clearCache())

  // History, downloads and form data live in tessera's own store rather than
  // Chromium's; they are cleared here once that layer exists.

  await Promise.all(work)
}

void main().catch((error: unknown) => {
  console.error('[startup] failed:', error)
  app.exit(1)
})
