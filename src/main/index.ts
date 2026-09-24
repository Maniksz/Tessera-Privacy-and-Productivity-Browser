import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { domainToASCII, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  safeStorage,
  session,
  shell,
  webContents
} from 'electron'
import { resolveLocale, translate, type Locale } from '@shared/i18n/catalog.js'
import { configureFaviconToken } from '@shared/favicons/model.js'
import { configureThumbnailToken } from '@shared/thumbnails/model.js'
import {
  PublicSuffixSubscription,
  readPublicSuffixBody
} from './privacy/PublicSuffixSubscription.js'
import { SettingsStore } from './settings/SettingsStore.js'
import { WindowRegistry } from './browser/WindowRegistry.js'
import { registerIpcHandlers } from './ipc/handlers.js'
import { installApplicationMenu } from './menu/appMenu.js'
import { installMenuActions } from './menu/menu-actions.js'
import { installTabUnloading } from './browser/tab-unloader.js'
import { applyRuntimeFlags } from './runtime-flags.js'
import {
  ExternalAddressInbox,
  externalAddressWindow,
  firstExternalAddress,
  readCheckModule,
  readStartupFlags,
  refusedDebugSwitch,
  secondInstanceAddress,
  startupFlagsFrom,
  writeStartupFlags
} from './startup-flags.js'
import { openLocalDataProtection } from './data/local-data-protection.js'
import { describeStoreLoad, type StoreLoadReport } from './data/store-load.js'
import { installProxy, networkFetch } from './session/proxy.js'
import {
  registerAsDefaultBrowser,
  registerInternalProtocol,
  registerInternalSchemePrivileges
} from './protocol.js'
import {
  arrangementsFile,
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
  inventoryPath,
  publicSuffixDir,
  quickLinksFile,
  sessionStateFile,
  settingsFile,
  startupFlagsFile,
  tabGroupsFile,
  thumbnailCacheDir,
  unencryptedDataNoticeFile,
  userRulesFile,
  windowPlacementFile
} from './paths.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import { QuickLinkStore } from './data/QuickLinkStore.js'
import { ExtensionStore } from './data/ExtensionStore.js'
import { HistoryStore } from './data/HistoryStore.js'
import { FaviconStore } from './data/FaviconStore.js'
import { ThumbnailStore } from './data/ThumbnailStore.js'
import { TabGroupStore } from './data/TabGroupStore.js'
import { ArrangementStore } from './data/ArrangementStore.js'
import { SessionStore } from './data/SessionStore.js'
import { WindowPlacementStore } from './data/WindowPlacementStore.js'
import { BookmarkStore } from './data/BookmarkStore.js'
import { DownloadStore } from './data/DownloadStore.js'
import { removeTempFilesOf } from './data/atomic-write.js'
import { catchUpPendingClears, clearOnExit, exitNoteAt, watchExitNote } from './data/clear-data.js'
import {
  applySessionRestore,
  restoredTabOptions,
  type RestoreHost
} from './session-restore/apply.js'
import { restoreSettingsFrom } from './session-restore/settings.js'
import { FilterSubscription } from './privacy/FilterSubscription.js'
import { CosmeticInjector } from './privacy/CosmeticInjector.js'
import { ElementPicker } from './privacy/ElementPicker.js'
import { pickerChrome } from './privacy/picker-chrome.js'
import { buildPageContextMenu } from './menu/pageContextMenu.js'
import { UserRuleStore } from './data/UserRuleStore.js'
import { PermissionStore } from './data/PermissionStore.js'
import { forgetfulSitePermissions } from './permissions/model.js'
import { PermissionArbiter } from './permissions/PermissionArbiter.js'
import { MediaSessions } from './media/MediaSessions.js'
import { DownloadManager } from './downloads/DownloadManager.js'
import { PasswordApi } from './passwords/PasswordApi.js'
import { PasswordVault } from './passwords/PasswordVault.js'
import { installAutofill } from './passwords/install-autofill.js'
import { MasterPasswordPrompt } from './passwords/MasterPasswordPrompt.js'
import { internalUrl } from '@shared/product.js'
import { installUpdateChecks } from './updates/install-updates.js'
import type { UpdateService } from './updates/UpdateService.js'
import {
  CLEAR_TIMEOUT_MS,
  FLUSH_TIMEOUT_MS,
  FlushRegistry,
  ShutdownSequence,
  type After,
  type ShutdownWork
} from './shutdown.js'

/**
 * Application entry point.
 *
 * The ordering here is load-bearing and mostly not obvious, so each step says
 * why it sits where it does.
 */

/*
  One browser per profile, decided before anything else runs.

  A second instance must hand its address to the running one rather than open a separate browser on
  the same files. `app.quit()` used to stand here, and it stopped nothing: it asks for a quit and
  returns, so every statement below still ran, `main()` included — and whether the quit beat `main()`
  to opening the stores of a profile the running instance was writing to was down to timing. `app.exit`
  ends the process without `before-quit`, and every other statement in this file with an effect runs
  only where `primaryInstance` says the lock is held.

  The address travels as `additionalData`, read here off this process's own command line, because the
  `argv` the running instance is handed carries switches Chromium added on the way. See
  `secondInstanceAddress`.
*/
/*
  A packaged build never runs with Chromium's remote debugging on. The fuses close Node's inspector and
  `ELECTRON_RUN_AS_NODE`, but not the DevTools protocol, and that is the one that hands whoever opened
  the port the chrome UI, its IPC and every cookie, under this app's own identity. Asked through
  `hasSwitch` rather than by reading argv, because Chromium accepts the switch with one dash, two, or
  on Windows a slash, in any case — an argv scan would miss the spellings Chromium itself honours.
  Before the lock, so a refused process does not take it; `app.exit` returns, so `primaryInstance` is
  false below and nothing else in this file runs.
*/
const refusedSwitch = refusedDebugSwitch((name) => app.commandLine.hasSwitch(name), {
  packaged: app.isPackaged
})
if (refusedSwitch !== null) {
  console.error(`[startup] a packaged build does not run with ${refusedSwitch}; exiting`)
  app.exit(1)
}

const launchAddress = firstExternalAddress(process.argv)
const primaryInstance =
  refusedSwitch === null && app.requestSingleInstanceLock({ url: launchAddress })
if (refusedSwitch === null && !primaryInstance) app.exit(0)

/*
  Addresses from outside, listened for from the first moment and held until the session is back.

  Both listeners used to be attached at the end of `main()`, after every store had opened and the
  session had been restored. A link that *started* the browser therefore went nowhere: on macOS it is
  delivered as `open-url` before `ready`, on Windows and Linux it is on this process's own command line,
  which nothing read. They are attached here, before the first `await` anywhere in this file, and what
  they receive waits in the inbox until `main()` opens it after the restore — so the link lands beside
  the restored windows instead of in one the restore then buries.
*/
const externalAddresses = new ExternalAddressInbox()

if (primaryInstance) {
  externalAddresses.receive(launchAddress)

  // macOS: links from other applications, whether the browser is running or being started by one.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    externalAddresses.receive(url)
  })

  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    const address = secondInstanceAddress(additionalData, argv)
    // A second launch with no address is somebody reaching for the browser: bring the last window used
    // forward. With one, the inbox opens it and brings its window forward itself.
    if (address === null) windows?.byRecentFocus[0]?.window.focus()
    else externalAddresses.receive(address)
  })
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

if (primaryInstance) {
  bootstrapFlags()
  // Before `ready`, which is the only time Chromium accepts it.
  registerInternalSchemePrivileges()
}

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
let arrangements: ArrangementStore | null = null
let sessionStore: SessionStore | null = null
let windowPlacement: WindowPlacementStore | null = null
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
 *
 * Each under a name, because the shutdown now gives up on a write that does not finish in time, and
 * "a store hung" is not something anybody can act on. See `shutdown.ts`.
 */
const flushOnExit = new FlushRegistry()

/** What clearing on exit owes, on disk from the start of the run to the quit that did it (KTD7). */
const exitNote = exitNoteAt(inventoryPath)

async function main(): Promise<void> {
  await app.whenReady()

  /*
    The clearing the last run still owes — a panic, or clearing on exit after a crash — done before
    anything can load a page. First thing after `ready`, the earliest `session.defaultSession` exists,
    and before protection, settings or any store opens (KTD7): on the files, so the history is gone
    before its store could load it. U23's staging goes after this, or the catch-up would delete it.
    Never a reason to refuse to start; `catchUpPendingClears` bounds the wait and keeps the note.
  */
  await catchUpPendingClears({
    session: session.defaultSession,
    path: inventoryPath,
    after: nodeAfter
  })
  // Each of these is a point where a quit that arrived during startup ends it; see `quitting`.
  if (quitting()) return

  /*
    One decision about protection, made once and handed to every store, so the browser cannot end
    up with an encrypted quick-links file next to a readable settings one.

    `safeStorage` is asked only after `whenReady`, which is the earliest it answers reliably on
    Linux — the reason the two startup switches come from their own file instead. That includes
    which backend Linux chose, the one question that tells a keyring from basic text.
  */
  const protection = await openLocalDataProtection({
    safeStorage,
    platform: process.platform,
    keyFilePath: localDataKeyFile(),
    noticeFilePath: unencryptedDataNoticeFile()
  })
  if (protection.mode === 'unencrypted') {
    console.warn('[data] local data is NOT encrypted:', protection.reason)
  }

  settings = await SettingsStore.open(settingsFile(), protection.codec)
  flushOnExit.push(() => settings?.flush() ?? Promise.resolve(), 'settings')
  if (settings.quarantinedFileOnLoad !== null) {
    // Not a warning to shrug at: the previous settings are intact in that file, and most often the
    // cause is a missing key rather than damage.
    console.warn('[settings] file could not be read; kept at', settings.quarantinedFileOnLoad)
  }
  if (settings.unknownKeysOnLoad.length > 0) {
    console.warn(
      '[settings] file contains keys this build does not know:',
      settings.unknownKeysOnLoad
    )
  }

  // The proxy on every session, and secure DNS, before anything below fetches or restores (U13).
  await installProxy(settings)
  // Armed now, so a crash from here on still leaves the clearing owed on disk (KTD7).
  await watchExitNote(exitNote, settings)

  /*
    The Public Suffix List decides what counts as one site, and several things below key on that:
    the favicon index, the user's element rules, password autofill, the third-party test. So it is
    installed here, before any of them opens, from disk only; the download that keeps it current
    runs later, in the filter lists' channel, and only ever takes effect at the next start, so a site
    means the same thing from the first key to the last in one run.
  */
  const publicSuffixes = new PublicSuffixSubscription({
    directory: publicSuffixDir(),
    fetchList: async (url) => readPublicSuffixBody(await networkFetch(url)),
    toAscii: domainToASCII
  })
  await publicSuffixes.load()
  flushOnExit.push(() => publicSuffixes.whenIdle(), 'public suffix list')

  /*
    Opened before the protocol is registered, and that ordering is load-bearing.

    `tessera://favicon` is served by the handler below, so the cache it reads from has to exist by
    the time the handler can be called. Registering first and filling the store in later would work
    almost always and fail on the icons of the very first page — the one case nobody re-tests.

    `networkFetch` (`net.fetch` behind the kill switch) rather than the global `fetch`: Chromium's stack,
    so the one request this cache makes per site obeys the same proxy rule, kill switch, DNS and
    certificates as the page the icon belongs to. Node's fetch would quietly bypass all of it.
  */
  const faviconStore = await FaviconStore.open({
    directory: faviconCacheDir(),
    fetch: networkFetch,
    codec: protection.codec
  })
  favicons = faviconStore
  flushOnExit.push(() => faviconStore.flush(), 'favicons')
  warnAboutStoreLoad('favicons', faviconStore.loadReport)
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
  flushOnExit.push(() => thumbnailStore.flush(), 'thumbnails')
  warnAboutStoreLoad('thumbnails', thumbnailStore.loadReport)
  if (thumbnailStore.recoveredFromInvalidFile) {
    console.warn('[thumbnails] index could not be used; pictures will be taken again')
  }

  /*
    Drawn fresh per start, before the protocol can answer. A web page can point an <img> at either
    cache and learn from load or error whether the user has been somewhere; the token is the one part
    of the address no page can know, and a new one per start means no address outlives the run.
  */
  configureFaviconToken(randomBytes(16).toString('base64url'))
  configureThumbnailToken(randomBytes(16).toString('base64url'))

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
  flushOnExit.push(() => quickLinks?.flush() ?? Promise.resolve(), 'quicklinks')
  warnAboutStoreLoad('quicklinks', quickLinks.loadReport)
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
  flushOnExit.push(() => extensions?.flush() ?? Promise.resolve(), 'extensions')
  warnAboutStoreLoad('extensions', extensions.loadReport)
  const extensionFailures = await extensions.attach(session.defaultSession)
  for (const failure of extensionFailures) {
    console.warn('[extensions] could not reload, dropped from the list:', failure)
  }

  history = await HistoryStore.open({ filePath: historyFile(), codec: protection.codec })
  flushOnExit.push(() => history?.flush() ?? Promise.resolve(), 'history')
  warnAboutStoreLoad('history', history.loadReport)
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
    void writeStartupFlags(startupFlagsFile(), startupFlagsFrom(snapshot)).catch(
      (error: unknown) => {
        // A failure here costs the *next* launch its switches, not this one. Worth saying, not worth
        // refusing to start over.
        console.warn('[startup-flags] could not be written:', String(error))
      }
    )
  }
  /*
    Leftovers a crash left beside the flags file, removed once before the first write. Not inside
    `writeStartupFlags`: its calls are not serialised, and a cleanup there would delete the temporary
    another call is about to rename.
  */
  await removeTempFilesOf(startupFlagsFile()).catch((error: unknown) => {
    console.warn('[startup-flags] could not remove leftover temporaries:', String(error))
  })
  persistStartupFlags(settings.snapshot())
  settings.onChange(({ snapshot }) => persistStartupFlags(snapshot))

  tabGroups = await TabGroupStore.open({ filePath: tabGroupsFile(), codec: protection.codec })
  flushOnExit.push(() => tabGroups?.flush() ?? Promise.resolve(), 'tabgroups')
  warnAboutStoreLoad('tabgroups', tabGroups.loadReport)
  if (tabGroups.recoveredFromInvalidFile) {
    console.warn('[tabgroups] file could not be used; started with no groups')
  }
  arrangements = await ArrangementStore.open({
    filePath: arrangementsFile(),
    codec: protection.codec // sealed like the group file: which pages sat beside which (KTD9)
  })
  flushOnExit.push(() => arrangements?.flush() ?? Promise.resolve(), 'arrangements')
  warnAboutStoreLoad('arrangements', arrangements.loadReport)
  /*
    Bookmarks, downloads and saved passwords.

    Registered for shutdown at the point of opening, which is the discipline the architecture test
    enforces: four stores once had a `flush()` and none of them reached `before-quit`, so a visit
    from thirty seconds before Quit was simply missing from the file.
  */
  bookmarks = await BookmarkStore.open({ filePath: bookmarksFile(), codec: protection.codec })
  flushOnExit.push(() => bookmarks?.flush() ?? Promise.resolve(), 'bookmarks')
  warnAboutStoreLoad('bookmarks', bookmarks.loadReport)
  if (bookmarks.recoveredFromInvalidFile) {
    // Worth a warning rather than a shrug: a bookmark collection is built by hand over years and
    // nothing else can recreate it.
    console.warn('[bookmarks] file could not be used; started from an empty set')
  }
  downloads = await DownloadStore.open({ filePath: downloadsFile(), codec: protection.codec })
  flushOnExit.push(() => downloads?.flush() ?? Promise.resolve(), 'downloads')
  warnAboutStoreLoad('downloads', downloads.loadReport)

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
    previousCodec: protection.codec,
    // What the key store is worth, as the decision above found it, so the page says the same thing.
    keystoreStrength: protection.keystore,
    /*
      `passwords.lockAfterMinutes`, read at every idle check rather than captured here.

      A function because the setting is live (spec 5), and here that is not a formality: somebody
      shortening this has just decided the current timeout is too long, and a value captured at
      startup would tell them to come back after a restart. The vault keeps its own fallback for the
      case this is absent, which is a test rather than a launch.
    */
    idleTimeoutMs: () => (settings?.get('passwords.lockAfterMinutes') ?? 15) * 60_000
  })
  flushOnExit.push(() => passwords?.flush() ?? Promise.resolve(), 'passwords')

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
    },
    /*
      Which window a download belongs to, asked of the registry at the moment it starts.

      A closure because the registry is built further down and needs this manager to exist first — the
      same arrangement as `parentWindow` below. Before the first window there is no download to ask
      about, so the `null` case answers "no window", which is also the truthful answer.
    */
    windowFor: (source, session) => windows?.windowForDownload(source, session)
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

  // Autofill: the service, the account picker and the toolbar key's feed. See `installAutofill`.
  const autofill = installAutofill({
    vault: passwordVault,
    prompt: masterPasswordPrompt,
    windows: () => windows,
    // `passwords.autofill`, per call: switching it off has to reach the form already on screen.
    enabled: () => settings?.get('passwords.autofill') ?? true,
    // Read per call, so a language change reaches the next sign-in form rather than the next restart.
    locale: () => uiLocale(settings)
  })

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
  flushOnExit.push(() => sessionStore?.flush() ?? Promise.resolve(), 'session')
  warnAboutStoreLoad('session', sessionStore.loadReport)
  if (sessionStore.recoveredFromInvalidFile) {
    console.warn('[session] file could not be used; started with no session to restore')
  }

  // Where the last window was, for the next one to open there. Kept apart from the session because it
  // has to hold when restore is off; see `@shared/window-placement/model.ts`.
  windowPlacement = await WindowPlacementStore.open({
    filePath: windowPlacementFile(),
    codec: protection.codec
  })
  flushOnExit.push(() => windowPlacement?.flush() ?? Promise.resolve(), 'window placement')

  /*
    The blocker, wired at last.

    `networkFetch` rather than Node's global, and the store *requires* the fetcher for exactly that
    reason: a list download must go through Chromium's network stack, so it obeys the same proxy rule,
    kill switch, secure DNS and certificate store as the pages the list protects. Node's fetch would
    slip past a proxy the user turned on — one request every five days, to a third party, outside the
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
  flushOnExit.push(() => userRules?.flush() ?? Promise.resolve(), 'user-rules')
  warnAboutStoreLoad('user-rules', userRules.loadReport)
  if (userRules.recoveredFromInvalidFile) {
    // Worth a warning rather than a shrug: these are rules the user made by hand, and nothing else
    // can recreate them.
    console.warn('[user-rules] file could not be used; started with no rules of your own')
  }

  const filterSubscription = new FilterSubscription({
    directory: filterListCacheDir(),
    fetchList: async (url) => {
      const response = await networkFetch(url)
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
    proceduralFor: (documentUrl) => filterSubscription.engine.proceduralSelectorsFor(documentUrl),
    /*
      The rules of a private window's session, and this is the whole of how they reach a page (KTD3).

      Not through `FilterEngine.replaceUserRules`: that is one slot for the entire program, fed from
      the store on disk, so a rule put there would hide the element in every window on the same site —
      including the ordinary ones this window's user is keeping it away from (R20, AE8).

      Pulled per serve rather than pushed per view, deliberately. These rules outlive the tab that
      wrote them: a private window's second tab is created, loads and asks long afterwards, and
      anything push-shaped would hold only for as long as somebody remembered to tell it about a new
      view. Asking the window each time cannot be forgotten.

      `null` for an ordinary window, and not because it has nothing to say — its rules are the stored
      ones, which every view already gets from the engine. A private window's answer leaves them out for
      the same reason: its views get them from the engine too, and answering with the whole list served
      each one twice.
    */
    sessionStylesFor: (contents) => {
      const controller = windows?.controllerForWebContents(contents.id)
      if (controller?.privateMode !== true) return null
      return userRules?.privateSessionText() ?? null
    }
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
    The same thing for a private window, and neither half is the pair above.

    No `reloadUserRules`: the engine's user-rule slot is fed from the store and must stay that way, or a
    rule written in a private window would hide the element in every ordinary window too (R20, AE8). The
    delivery is `sessionStylesFor` above, which reads these rules per serve — so all that is owed here is
    a re-serve of the views that are already open, which `refreshView` does one view at a time and only
    for the windows of this mode.

    Wired to the *held* editor, and this subscription is why it is held: it is made once, at startup, and
    goes on being right for every private window opened afterwards. Until now `SessionUserRuleEditor`
    had no subscriber anywhere in the core — there was no object to subscribe to that would still exist
    when it fired — and that was one of the three reasons blocking an element in a private window did
    nothing at all.
  */
  userRules.editorFor('private').onChange(() => {
    for (const controller of windows?.controllers ?? []) {
      if (!controller.privateMode) continue
      for (const tab of controller.tabs) {
        // A snapshot of the tabs can outlive one of them by a tick, and a destroyed view has no id to
        // ask for.
        if (tab.view.webContents.isDestroyed()) continue
        cosmeticInjector.refreshView(tab.view.webContents.id)
      }
    }
  })

  /*
    The element picker, which is the "and I want to block things myself, like uBlock Origin" half.

    Its rules go into `UserRuleStore` bound to the sending window's browsing mode, so a private window's
    picker writes nothing to disk — and that is a property of the editor it is handed rather than a check
    anywhere in the picker. What it does write reaches that window's own views, and only those, through
    the two blocks above. A picked rule may only ever *hide*: `describeUserRule` refuses anything that
    would block a request, because hiding a banner and cutting a site off must not sit behind one click.
  */
  elementPicker = new ElementPicker({
    // No language in the chrome any more: what crosses into the page is a stylesheet. The words are the
    // confirmation bar's, resolved in the core and sent with its presentation — hence `locale`.
    chrome: pickerChrome,
    getSettings: () => settings?.snapshot() ?? defaultSettings(),
    locale: () => uiLocale(settings),
    editorFor: (webContentsId) => {
      const controller = windows?.controllerForWebContents(webContentsId)
      if (controller === undefined) return null
      return userRules?.editorFor(controller.privateMode ? 'private' : 'normal') ?? null
    },
    /*
      The provisional rule, into one view and no other (R4, R20).

      Through the injector's per-view addition rather than the engine's user-rule slot, which is one
      slot for the whole program: a preview put there would hide the element in every window that
      happened to be on the same site, including the ones nobody is picking in. Delivered on the call
      rather than on a later refresh, because the revocation has to be a state of the page by the time
      the measurement runs.
    */
    preview: (webContentsId, ruleText) => {
      cosmeticInjector.setPreview(webContentsId, ruleText)
    },
    /*
      Where the bar goes, resolved once when a session starts.

      A tab with no tile has no rectangle to hang a bar off, and a bar is where every answer of this
      feature is delivered — so a view that is loaded but off screen is not a view a picker can start
      in. The window is held for the life of the session rather than looked up again: a tab closed
      under an open bar has to be able to take that bar down, and by then the view it was resolved
      from is gone.
    */
    hostFor: (webContentsId) => {
      const controller = windows?.controllerForWebContents(webContentsId)
      const tab = controller?.tabForWebContents(webContentsId)
      const tileIndex = tab?.tileIndex
      if (controller === undefined || tab === undefined || tileIndex == null) return null
      return {
        windowId: controller.window.id,
        tabId: tab.id,
        tileIndex,
        tileRect: () => tab.view.getBounds(),
        presentOverlay: (presentation) => {
          controller.presentOverlay(presentation)
        },
        dismissOverlayKind: (kind) => controller.dismissOverlayKind(kind),
        overlayPresentation: () => controller.overlayPresentation(),
        // The same call the blocker menu and the application menu make, so "my rules" is one place
        // rather than three spellings of one.
        openRules: () => {
          controller.createTab({ url: internalUrl('settings') })
        }
      }
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
  flushOnExit.push(() => permissionStore?.flush() ?? Promise.resolve(), 'permissions')
  warnAboutStoreLoad('permissions', permissionStore.loadReport)
  if (permissionStore.recoveredFromInvalidFile) {
    console.warn('[permissions] file could not be used; every site will be asked again')
  }
  // The last store is open. Past here come the windows, the handlers and the timers, none of which a
  // quit that is already running would wait for.
  if (quitting()) return
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
    Media detection and download, one service per browsing *session*: a stream is fetched by a session, and
    windows sharing the normal one see the same findings. A private window's is released with the window;
    its findings name the addresses a page fetched. Its downloads are ordinary rows in the manager's list.
  */
  const mediaSessions = new MediaSessions<Electron.Session>({
    hosts: () => windows?.controllers ?? [],
    directory: () => settings?.get('downloads.directory') ?? '',
    fallbackDirectory: defaultDownloadsDir,
    downloads: downloadManager
  })
  /*
    Not a flush but the same need: interrupting `writeAtomically` between its write and its rename leaves
    a `.tmp` file and no manifest, which the next launch reads as "nothing cached" and re-downloads
    every list.
  */
  flushOnExit.push(() => filterSubscription.whenIdle(), 'filter lists')

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
    arrangements,
    filters: filterSubscription,
    sessionStore,
    windowPlacement,
    // For one call and one only: the last private window closing is what ends the rules its picker
    // wrote, and this is the layer that knows when that happens.
    userRules,
    // Bound to a browsing mode where the session is created, so a private window holds a recorder
    // that discards rather than a flag somebody has to remember to check.
    downloads: downloadManager,
    media: mediaSessions,
    // Every session asks through the one arbiter, so two windows' prompts queue in one place and a
    // check reads the same memory the answer was written to.
    permissions: permissionArbiter,
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
        canFillPassword: autofill.service.hasFillableFocus(tab.view.webContents.id),
        onFillPassword: () => autofill.suggest.requestFromChrome(tab.view.webContents, null),
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
    discardDownloadCopies: () => downloads?.discardCopies() ?? Promise.resolve(),
    passwords: passwordApi,
    prompt: masterPasswordPrompt,
    autofill,
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

  // Strg+D, clearing now and panic, in the core (KTD6); the shutdown waits for a panic that runs.
  const actions = installMenuActions({
    windows,
    electron: { dialog, defaultSession: session.defaultSession, quit: () => app.quit() },
    bookmarks,
    stores: { history, downloads, favicons, thumbnails },
    stopped: [sessionStore, tabGroups, arrangements, permissionStore],
    downloads: downloadManager,
    media: mediaSessions,
    locale: () => uiLocale(settings),
    path: inventoryPath
  })
  flushOnExit.push(() => actions.whenIdle(), 'panic')
  // One timer for the program unloads idle tabs (U15); which tab may go is `unload-policy.ts`'s to say.
  const waiting = [autofill.service, permissionArbiter, elementPicker]
  installTabUnloading({ windows: () => windows?.controllers ?? [], settings, waiting, quitting })
  const menu = { windows, settings, actions, autofill, checkForUpdates: () => updates.checkNow() }
  const installMenu = (): void =>
    installApplicationMenu({ ...menu, locale: uiLocale(settings), platform: currentPlatform() })
  installMenu()
  // Rebuilt when the language or a shortcut changes, so accelerators and labels never lag (spec 5).
  settings.onChange(({ changed }) => {
    if ('appearance.uiLanguage' in changed || 'advanced.customShortcuts' in changed) installMenu()
  })

  /*
    The session, and the two reconciliations that depend on it.

    `beginRun` reads the plan out of the file and opens a fresh run in one call — the crash-loop counter is on
    disk before this line returns, which is what makes it a counter of launches that *started* a restore rather
    than of ones that finished. Groups and arrangements are then reconciled once each, with every id that came back.
  */
  const plan = await sessionStore.beginRun(restoreSettingsFrom(settings.snapshot()))
  // No windows for a shutdown that began while the plan was being read; the session is sealed by now.
  if (quitting()) return
  const registry = windows
  const restoreHost: RestoreHost = {
    openWindow: (layout, fractions) => {
      const controller = registry.createWindow({
        privateMode: false,
        initialSplit: { layout, fractions: { ...fractions } }
      })
      return {
        openTab: (tab) => {
          controller.createTab(restoredTabOptions(tab))
          if (tab.pinned) controller.setTabPinned(tab.id, true)
        },
        setActiveTile: (index) => controller.setActiveTile(index)
      }
    },
    retainTabs: (ids) => tabGroups?.retainTabs(ids),
    retainArrangementTabs: (ids) => arrangements?.retainTabs(ids)
  }
  if (plan.kind === 'skip') {
    // Worth saying rather than shrugging at: a user who asked for their session and did not get it has no other
    // way to find out why, and `restore-keeps-crashing` is the reason they would most want to know.
    console.warn(`[session] not restoring the previous session: ${plan.reason}`)
    // Off or refused says what an empty plan says — no tab came back — so the same call answers it: that
    // empties the stored arrangements alongside the group memberships (R8).
    applySessionRestore([], restoreHost)
    windows.createWindow({ privateMode: false }).createTab({})
  } else {
    applySessionRestore(plan.windows, restoreHost)
  }

  /*
    Addresses from outside, opened from here on: everything held since startup, then each as it comes.

    After the restore, so a link lands beside the windows that came back rather than first in line for
    them to cover. In the normal window used most recently and never in a private one — see
    `externalAddressWindow` for why the old `focused() ?? controllers[0]` got both halves of that wrong.
  */
  const openWindows = windows
  externalAddresses.deliverTo((url) => {
    const target = externalAddressWindow(openWindows.byRecentFocus)
    if (target === undefined) {
      openWindows.createWindow({ privateMode: false }).createTab({ url })
      return
    }
    target.window.focus()
    target.createTab({ url })
  })

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
  // Same moment and same channel as the filter lists: after the session, its proxy and kill switch
  // exist. What it fetches is only cached here; the list in force changes at the next start.
  void publicSuffixes.refresh().catch((error: unknown) => {
    console.warn('[public-suffix] refresh failed:', String(error))
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
      closed rather than one being closed underneath it — and that flush waits for this lock's own write
      rather than finding no store and answering at once, which is how the last change used to be lost
      when the last window was closed on Windows (see `PasswordVault.lock`).

      Not once a quit has begun: the windows are closing *because* of it, the vault has been flushed or
      is being flushed, and a lock now would start a write the ending process does not wait for.
    */
    if (!quitting()) void passwords?.lock()
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
      await new Promise<void>((resolve) =>
        first.webContents.once('did-finish-load', () => resolve())
      )
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
 *
 * The decisions — hold a second quit, give up on a write after ten seconds, on the clearing after
 * thirty, leave a note when the clearing did not finish — are `ShutdownSequence`'s, and tested
 * there. What is here is only what it needs from Electron and from the stores this file opened.
 */
const shutdown = new ShutdownSequence({
  after: nodeAfter,
  finish: (report) => {
    if (report.clear === 'timed-out') {
      const seconds = String(CLEAR_TIMEOUT_MS / 1000)
      console.error(`[shutdown] clearing on exit took over ${seconds} s; it runs at the next start`)
    }
    if (report.clear === 'failed') {
      console.error('[shutdown] clearing on exit did not finish; it runs again at the next start')
    }
    if (report.hung.length > 0) {
      const seconds = String(FLUSH_TIMEOUT_MS / 1000)
      console.error(
        `[shutdown] still writing after ${seconds} s, not waited for:`,
        report.hung.join(', ')
      )
    }
    for (const { name, reason } of report.failed) {
      console.error(`[shutdown] ${name} could not be flushed:`, reason)
    }
    app.quit()
  }
})

/**
 * Whether a quit has begun.
 *
 * Read by `main()` at the points between its phases, because a quit can arrive while it is still
 * opening stores — a second launch that quits at once, a user who closes the first window before the
 * restore has finished. Without the check, startup went on to open windows, start the update timer
 * and restore a session the shutdown had already sealed and flushed, in a process about to end.
 */
function quitting(): boolean {
  return shutdown.phase !== 'idle'
}

function onBeforeQuit(event: Electron.Event): void {
  if (!shutdown.beforeQuit(beginShutdown)) event.preventDefault()
}

/** What the first quit does before it starts waiting, and what it waits for. */
function beginShutdown(): ShutdownWork {
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
  // The idle timer, which could otherwise start a lock of its own halfway through the flushes.
  passwords?.dispose()

  /*
    No settings yet means a quit during startup, before anybody could have asked for anything to go.
    A store a category needs and startup had not opened fails the clearing, which keeps the note.
  */
  const stores = { history, downloads, favicons, thumbnails }
  return {
    clear:
      settings === null
        ? null
        : exitNote.clearing((categories) =>
            clearOnExit(categories, { session: session.defaultSession, stores })
          ),
    // Anything written after the process exits is lost, so everything registered is flushed and
    // awaited rather than left to a debounce timer.
    flushes: flushOnExit.entries()
  }
}

/**
 * `setTimeout` in the shape `shutdown.ts` asks for.
 *
 * A function declaration, not a constant: `shutdown` above is built with it while this file is still
 * being evaluated, and a `const` down here would not exist yet.
 */
function nodeAfter(ms: number, callback: () => void): ReturnType<After> {
  const timer = setTimeout(callback, ms)
  return () => {
    clearTimeout(timer)
  }
}

/**
 * The one line about a store's load, when there is one: a newer version's file left alone, an older
 * one upgraded, a broken one copied aside — and whether this run's changes will be kept.
 *
 * Next to every store's own `recoveredFromInvalidFile` warning rather than instead of it: that one says
 * what the store lost, this one says where the original is and what the run may write. The wording is
 * `describeStoreLoad`'s, so the dozen stores cannot describe one situation a dozen ways.
 */
function warnAboutStoreLoad(label: string, report: StoreLoadReport): void {
  const message = describeStoreLoad(report)
  if (message !== null) console.warn(`[${label}] ${message}`)
}

// Only in the instance holding the lock: a second one exits above, and must open nothing.
if (primaryInstance) {
  app.on('before-quit', onBeforeQuit)
  void main().catch((error: unknown) => {
    console.error('[startup] failed:', error)
    app.exit(1)
  })
}
