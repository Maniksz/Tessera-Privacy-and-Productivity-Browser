/**
 * Channel names for the UI <-> core boundary.
 *
 * This module is deliberately dependency-free (no zod, no Electron) because the
 * sandboxed chrome preload imports it to build its allowlist, and a sandboxed
 * preload cannot pull in anything heavier than plain JavaScript.
 *
 * It is the *naming* half of the single source of truth required by spec 6.
 * The *typing* half lives in `contract.ts`, which is forced by the compiler to
 * cover exactly these names — no more, no fewer. Adding a name here without a
 * matching contract entry is a type error, and vice versa. That is what makes
 * drift a build failure instead of a runtime surprise.
 */

/** Renderer -> main, request/response. */
export const INVOKE_CHANNELS = [
  // settings
  'settings:getAll',
  'settings:get',
  'settings:set',
  'settings:reset',
  'settings:resetAll',
  'settings:describe',
  /**
   * "Check for updates now."
   *
   * The one channel here that reaches the network because a button was pressed, so it is granted to
   * a single page — see `INTERNAL_PAGE_INVOKE_CHANNELS.settings` and the fitness function
   * `gives no page but settings an update command`. It is deliberately *not* `updates:download` or
   * `updates:install`: those two consents are answered in a native dialog the core owns, and a
   * channel for either would put the decision back inside a document.
   *
   * Resolves when the check is over and carries nothing about what it found. The result is the
   * dialog `install-updates.ts` raises, so a payload would be the same answer told twice — and the
   * page would be holding a version number and a decline it has no use for.
   */
  'updates:checkNow',
  // window
  'window:getState',
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'window:setChromeInsets',
  'window:setOverlay',
  // the window's topmost layer, the only place the chrome UI can draw over pages
  'overlay:present',
  'overlay:dismiss',
  /**
   * Dragging a tab into a tile.
   *
   * Reported by whichever trusted renderer the pointer is currently over — the chrome UI
   * while it is in the tab strip, the overlay surface once it is over the tiles. Neither
   * can see the whole gesture, because a native view takes the pointer as soon as it
   * crosses into the content area. The core owns the drag so the two halves add up.
   */
  'drag:start',
  'drag:move',
  'drag:end',
  // tabs
  'tabs:create',
  'tabs:close',
  'tabs:activate',
  'tabs:move',
  'tabs:setPinned',
  'tabs:reopenClosed',
  /*
    Tab groups.

    Chrome-only, and not on any internal page's allowlist: a group decides which tabs are visible and
    which tiles they may hold, which is window state an `tessera://` document has no business
    touching. See `INTERNAL_PAGE_INVOKE_CHANNELS`.
  */
  'tabgroups:create',
  'tabgroups:rename',
  'tabgroups:recolor',
  'tabgroups:setCollapsed',
  'tabgroups:dissolve',
  'tabgroups:addTab',
  'tabgroups:removeTab',
  /*
    Opens the native context menu for a tab.

    A native menu rather than one drawn in the DOM, and not for the usual layering reason: this one
    would sit over the tab strip, which *is* above the content views. It is native because the items
    are plain text, so nothing is lost, and because the platform's assistive technology already reads
    a real menu. See `menu/tabContextMenu.ts`.
  */
  'tabs:contextMenu',
  /*
    What the blocker made of the user's lists.

    Not a nicety. A hand-written filter engine understands a subset of the syntax, and without a way
    to see *which* subset, "the blocker does not work on this site" is not a diagnosis anybody can
    act on — the counters are the difference between that and "eleven thousand lines declined, all of
    them `$popup`".
  */
  /**
   * The answer to a permission prompt.
   *
   * Chrome-only and on no internal page's allowlist. A page that could reach this channel could grant
   * itself the camera, so the sender policy classifies it independently of what the preload believes.
   */
  'permissions:answer',
  /**
   * The answer to a "this page wants to open something" prompt.
   *
   * Chrome-only, and on no internal page's allowlist, for the same reason `permissions:answer` is: a page
   * that could reach this channel could permit its own popup, which is the whole thing the prompt exists
   * to stop. The core checks the request id against the prompt actually on screen as well, so even the
   * chrome UI cannot answer a question that is not being asked.
   */
  'navigation:answer',
  /*
    Media the page fetched, and downloading it.

    Chrome-only. The list names the addresses a page requested, which is browsing history by another
    route — an internal page has no business reading it, and no page has any business reading another
    tab's.
  */
  /*
    "Block this element myself."

    Chrome-only, and it has to be: a page that could start the picker in itself could then propose and
    commit rules for its own site — see `ElementPicker`, where the set of started views is the only thing
    that grants the right to propose at all.
  */
  /**
   * Opens the blocker's menu at the badge in the address bar.
   *
   * A native menu, so the core opens it rather than the renderer drawing it — a DOM menu here would drop down
   * behind the page, and the overlay layer already has four claimants.
   */
  /**
   * How far the pointer is from the top of one tile, so that tile's bar can hide itself.
   *
   * The *departure* only. This comment used to claim the reveal came through here too — "from the overlay,
   * because it is the only renderer whose document covers the tiles" — and that was wrong in a way that made
   * the feature impossible: the overlay is hidden until it already has something to show, so it can report a
   * pointer leaving the bar and never a pointer approaching one. The approach comes from the tile view's own
   * `input-event`, in `Tab.ts`, which is the only thing that sees a pointer over a page at all.
   *
   * Reported as a position rather than as "hide the bar", so the decision stays in the core with the geometry.
   */
  'tiles:pointerAt',
  'blocker:menu',
  'picker:start',
  'picker:stop',
  /** The user's own rules, for the settings page and the blocker menu. */
  'userrules:list',
  'userrules:setEnabled',
  'userrules:remove',
  'media:list',
  'media:describe',
  'media:download',
  'media:cancel',
  'filters:getStatus',
  /** Fetches any list that is missing or stale, now, rather than waiting five days. */
  'filters:refresh',
  // navigation (acts on the active tile's tab)
  'nav:goBack',
  'nav:goForward',
  'nav:reload',
  'nav:stop',
  'nav:navigate',
  'nav:getBackForwardList',
  /*
    Find in page, for the tile the bar was opened over.

    Chrome-only and on no internal page's allowlist: a page that could reach these could search — and
    highlight — another tab.
  */
  /**
   * The article the reader page was opened for.
   *
   * Keyed by an id rather than by an address: the harvest happens once, in the core, from the page the user was
   * looking at — so a reader page that named a URL could ask the browser to fetch and render any site's text
   * inside a document that has a bridge.
   */
  'reader:get',
  'find:open',
  'find:query',
  'find:step',
  // split view
  'split:setLayout',
  'split:setFractions',
  'split:setActiveTile',
  'split:assignTab',
  'split:toggleTileMaximized',
  'split:escape',
  // per-tile media
  'media:setTileMuted',
  // developer tools
  'devtools:toggle',
  // i18n
  'i18n:getCatalog',
  // quick links on the start page
  'quicklinks:list',
  'quicklinks:create',
  'quicklinks:update',
  'quicklinks:remove',
  'quicklinks:move',
  'quicklinks:open',
  // extensions
  'extensions:list',
  'extensions:load',
  'extensions:remove',
  // browsing history
  'history:query',
  /** Follows an entry in the tab that asked, so a page cannot steer other tabs. */
  'history:open',
  'history:removeVisit',
  'history:removeDomain',
  'history:removeRange',
  'history:clear',
  /*
    Bookmarks.

    The whole tree is answered at once rather than queried, because the page needs the structure —
    a breadcrumb, a child count, which folder a row sits in — and a flat filtered result carries
    none of it. See `BookmarksPage`.
  */
  'bookmarks:list',
  'bookmarks:create',
  /** Title only. The address goes through `bookmarks:relocate`, which keeps folder and position. */
  'bookmarks:update',
  'bookmarks:remove',
  'bookmarks:move',
  /** The "this page has moved" operation: keeps the title, the folder and the position. */
  'bookmarks:relocate',
  /** Follows a bookmark in the tab that asked. Never `nav:navigate`. */
  'bookmarks:open',
  /*
    Reads an exported bookmark file.

    The path comes from the OS picker inside the core and is never part of the request — the rule
    `extensions:load` established, so a compromised renderer cannot ask the core to read an
    arbitrary file and hand back its contents.
  */
  'bookmarks:import',
  /*
    Downloads.

    A pull for the first list and a push for everything after it: see `downloads:changed`. The
    list re-probes the disk, which is why it is a call rather than a read of pushed state.
  */
  'downloads:list',
  'downloads:open',
  'downloads:reveal',
  'downloads:remove',
  'downloads:clear',
  'downloads:pause',
  'downloads:resume',
  'downloads:cancel',
  /*
    Saved passwords.

    Thirteen channels, and the interesting number is how many of them carry a password: one, in one
    direction. `passwords:reveal` answers with a single secret for a single id the user asked about.
    Nothing else in this group carries one in either direction, and nothing anywhere on this boundary
    answers with more than one. That absence is what makes the bound on an open passwords tab real —
    see `shared/passwords/reveal.ts`.

    The absence that took the most rearranging is the master password. It has no channel, no field and
    no payload: `passwords:requestUnlock` sends nothing, the core raises a prompt on the overlay layer
    and reads the keystrokes off that view in the main process, and the answer is one of four words. See
    `shared/passwords/api.ts` for what that replaced and why a promise about a payload was not enough.
  */
  'passwords:list',
  'passwords:create',
  'passwords:update',
  'passwords:remove',
  /** One secret, for one id the user asked about. The only channel here that returns a password. */
  'passwords:reveal',
  'passwords:forgetNeverSaved',
  /** How the vault is protected, and whether it is open. Never a count of what is in it. */
  'passwords:vaultStatus',
  /**
   * Asks the core to raise the master-password prompt, and resolves with what came of it.
   *
   * No payload in either direction beyond four words and the resulting state. Pending for as long as
   * somebody is being asked, which is the honest representation of a question put to a person.
   */
  'passwords:requestUnlock',
  /** Drops the key now, rather than waiting for the idle timeout. */
  'passwords:lock',
  /** Starts the set, change or remove sequence. Carries the intent; the core derives the questions. */
  'passwords:beginSetMasterPassword',
  /** No payload: the core opens the file chooser and reads the file. See `shared/passwords/api.ts`. */
  'passwords:import',
  /** Destroys the vault, after offering to put the sealed copy aside. */
  'passwords:resetVault',
  /**
   * Continue or Cancel on the master-password prompt.
   *
   * Chrome-only, and on no internal page allowlist. It exists for the two buttons a mouse can reach:
   * every keyboard route is handled in the core, because that surface never receives its own keystrokes.
   * It carries a request id and a verb, so the worst a forged call can do is submit or abandon whatever
   * the person in front of the machine had already typed.
   */
  'passwords:answerPrompt'
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

/**
 * The internal pages that get a bridge at all.
 *
 * One name per `tessera://<name>` document that talks to the core. Asset routes such as
 * `tessera://favicon` are deliberately absent: they serve bytes and have no renderer.
 */
export const INTERNAL_PAGES = [
  'start',
  'settings',
  'extensions',
  'history',
  'bookmarks',
  'downloads',
  'passwords',
  'reader'
] as const

export type InternalPage = (typeof INTERNAL_PAGES)[number]

/**
 * What each internal page may call — **per page**, not per class of page.
 *
 * ## Why it is per page
 *
 * Internal pages are our own code, but they are still web content in a sandboxed process, and
 * nothing stops a visited site from linking to one. So their privileges have to survive being
 * reached that way.
 *
 * One shared allowlist could not survive a settings page: it would have had to contain
 * `settings:set`, and then the *start* page could rewrite every setting in the browser. Per page,
 * each surface gets only its own operations — the settings page cannot touch quick links, the
 * history page cannot write settings, and the start page still cannot do either. That makes this
 * model **stricter** than the one it replaces, not looser.
 *
 * ## Why openers are per page too
 *
 * `history:open` rather than `nav:navigate`: the core resolves it to the tab that sent it. A page
 * granted `nav:navigate` could steer *other* tabs, which is a far larger permission than "follow
 * the link I just clicked". `quicklinks:open` established the pattern.
 *
 * `satisfies` keeps every entry a real channel: a typo fails the build rather than silently
 * granting nothing — or, worse, silently granting everything if the check were a string compare.
 */
export const INTERNAL_PAGE_INVOKE_CHANNELS = {
  start: [
    'i18n:getCatalog',
    'quicklinks:list',
    'quicklinks:create',
    'quicklinks:update',
    'quicklinks:remove',
    'quicklinks:move',
    'quicklinks:open'
  ],
  /*
    `settings:get` and `settings:resetAll` were granted and never called.

    Removed rather than kept "in case": a grant nobody exercises is a grant nobody notices going wrong, and
    `resetAll` is the single most destructive operation on this boundary — a page that can reach it can undo
    every choice the user has made, in one call, and the page it would be reached from is one a website can
    link to. `getAll` already serves every read the view performs.

    If a "reset everything" button is built later, this is one line and a deliberate decision again.

    `updates:checkNow` is the deliberate decision going the other way, and the only grant in this table
    that lets a page cause an outbound request. It is here because the user asked for the button and
    the settings screen is where it belongs; it is here *and nowhere else* because the worry that kept
    the check channel-less for so long — a page making this browser talk to GitHub — is still right for
    every page that is not this one. Nothing about the start page or the reader page needs it.
  */
  settings: [
    'i18n:getCatalog',
    'settings:getAll',
    'settings:set',
    'settings:reset',
    'settings:describe',
    'updates:checkNow'
  ],
  extensions: ['i18n:getCatalog', 'extensions:list', 'extensions:load', 'extensions:remove'],
  history: [
    'i18n:getCatalog',
    'history:query',
    'history:open',
    'history:removeVisit',
    'history:removeDomain',
    'history:removeRange',
    'history:clear'
  ],
  /*
    Eight bookmark channels and nothing else — no setting, no tab, no window.

    `bookmarks:open` rather than `nav:navigate` for the reason stated above: the core resolves the
    target from the sender, so the page steers itself and nothing else.
  */
  bookmarks: [
    'i18n:getCatalog',
    'bookmarks:list',
    'bookmarks:create',
    'bookmarks:update',
    'bookmarks:remove',
    'bookmarks:move',
    'bookmarks:relocate',
    'bookmarks:open',
    'bookmarks:import'
  ],
  /*
    No opener at all, which is the one thing that makes this list different in kind.

    A download row leads to a *file*, and opening one is `downloads:open` — the core hands the path
    to the operating system after re-checking that it is still there. There is no channel here that
    can navigate anything, so the most dangerous thing this page could be tricked into is opening a
    file the user already downloaded.
  */
  downloads: [
    'i18n:getCatalog',
    'downloads:list',
    'downloads:open',
    'downloads:reveal',
    'downloads:remove',
    'downloads:clear',
    'downloads:pause',
    'downloads:resume',
    'downloads:cancel'
  ],
  /*
    Twelve, and one deliberate omission: `passwords:answerPrompt`.

    Every operation the page offers is here, including the ones that can destroy the vault — because the
    page is where a person manages their own credentials, and a manager whose reset button is somewhere
    else is a manager people cannot recover from. What is not here is the answer to the *prompt*: that
    surface belongs to the chrome, a mis-aimed submit on it would spend whatever the person had typed,
    and the page has no business reaching it. The page asks a question and waits for the outcome.
  */
  passwords: [
    'i18n:getCatalog',
    'passwords:list',
    'passwords:create',
    'passwords:update',
    'passwords:remove',
    'passwords:reveal',
    'passwords:forgetNeverSaved',
    'passwords:vaultStatus',
    'passwords:requestUnlock',
    'passwords:lock',
    'passwords:beginSetMasterPassword',
    'passwords:import',
    'passwords:resetVault'
  ],
  /*
    The narrowest allowlist in the table, and it should be: the reader page renders text harvested from a
    *website*. Two channels — read the catalogue, fetch the one article it was opened for — and nothing that
    could act on a tab, a setting or another page's data.
  */
  reader: ['i18n:getCatalog', 'reader:get']
} as const satisfies Record<InternalPage, readonly InvokeChannel[]>

/**
 * Events each internal page may subscribe to. Same reasoning, same shape.
 *
 * `locale:changed` is the one channel every page holds. It exists because `useInternalI18n` has to
 * re-read its catalogue when the language changes: granted to the settings page alone, switching
 * the language changed every window's chrome at once and left every other open internal tab —
 * history, bookmarks, downloads, the vault — in the previous language until it was reloaded, which
 * reads as a language switch that half worked.
 *
 * `settings:changed` would have done the same job and is deliberately *not* used for it. It carries
 * the whole snapshot, so granting it to all eight would hand the user's entire configuration to
 * every internal page on every change — including the reader page, which renders text harvested
 * from a website. A language is not a configuration; it gets its own channel, and `settings:changed`
 * stays with the one page that displays settings. A fitness function holds that line.
 *
 * The subject-specific events are still per page — `downloads:changed` names what a person
 * downloaded, and that stays with the downloads page.
 */
export const INTERNAL_PAGE_EVENT_CHANNELS = {
  start: ['quicklinks:changed', 'locale:changed'],
  settings: ['settings:changed', 'locale:changed'],
  extensions: ['locale:changed'],
  history: ['locale:changed'],
  /*
    The bookmarks page hears nothing about bookmarks, deliberately.

    It refreshes after its own writes, and a bookmark changes because somebody changed it. A
    download changes on its own, which is why the page below has an event of its own and this one
    does not.
  */
  bookmarks: ['locale:changed'],
  downloads: ['downloads:changed', 'locale:changed'],
  /*
    Nothing about the vault here, and that absence is a privacy decision rather than a shrug.

    A pushed list would arrive whenever the vault changed — including when autofill noted a
    sign-in — so an open passwords tab would learn that the user had just signed in somewhere.
    The page refreshes after its own writes instead.
  */
  passwords: ['locale:changed'],
  reader: ['locale:changed']
} as const satisfies Record<InternalPage, readonly EventChannel[]>

/**
 * Every channel some internal page can reach.
 *
 * Not a permission — no single page has all of these. It exists so a test can ask "could *any*
 * internal page reach this?", which is the right question for the operations that must stay
 * chrome-only: closing tabs, closing the window, presenting overlays.
 */
export type InternalInvokeChannel =
  (typeof INTERNAL_PAGE_INVOKE_CHANNELS)[InternalPage][number]

/**
 * The same, for subscriptions.
 *
 * Needed because the internal bridge's `on` was declared for one literal channel — `quicklinks:changed` — while
 * the table above grants `settings:changed` to the settings page and the preload installs it. The result was an
 * asymmetry nobody would have looked for: the settings *panel* updated live when a setting changed elsewhere,
 * and the settings *tab* did not, because its own bridge would not type the subscription it was allowed to make.
 */
export type InternalEventChannel =
  (typeof INTERNAL_PAGE_EVENT_CHANNELS)[InternalPage][number]

const internalPageSet: ReadonlySet<string> = new Set(INTERNAL_PAGES)

export function isInternalPage(value: string): value is InternalPage {
  return internalPageSet.has(value)
}

/** Union across pages, for tests and diagnostics rather than for granting anything. */
export function anyInternalInvokeChannels(): InvokeChannel[] {
  return [...new Set(Object.values(INTERNAL_PAGE_INVOKE_CHANNELS).flat())]
}

export function mayInternalPageInvoke(page: string, channel: string): boolean {
  if (!isInternalPage(page)) return false
  return (INTERNAL_PAGE_INVOKE_CHANNELS[page] as readonly string[]).includes(channel)
}

export function mayInternalPageListen(page: string, channel: string): boolean {
  if (!isInternalPage(page)) return false
  return (INTERNAL_PAGE_EVENT_CHANNELS[page] as readonly string[]).includes(channel)
}

/** Main -> renderer, fire-and-forget notifications. */
export const EVENT_CHANNELS = [
  'window:stateChanged',
  'tabs:changed',
  'split:changed',
  'settings:changed',
  /**
   * The effective interface language changed. Carries the resolved locale and nothing else, so
   * every internal page can hold it without holding the user's configuration.
   */
  'locale:changed',
  'shortcut:triggered',
  'quicklinks:changed',
  /**
   * The window's groups changed: created, renamed, recoloured, folded or dissolved.
   *
   * Separate from `tabs:changed` although the two almost always fire together, because they answer
   * different questions and one of them can change without the other: renaming a group leaves every
   * tab exactly as it was.
   */
  /**
   * A tab's media findings changed without anybody asking: a player started a second stream, the page
   * navigated, a download finished. Pushed only to the window owning the tab.
   */
  'media:changed',
  /**
   * The download list changed: one started, advanced, paused, finished, or was forgotten.
   *
   * Pushed rather than polled because a download is an event over time — the list moves while
   * nobody is touching it. Already coalesced to a few a second by `DownloadManager`, and sent per
   * window, because what a window may see depends on whether it is private.
   */
  'downloads:changed',
  'tabgroups:changed',
  /**
   * Sent to both the overlay surface, which renders it, and the chrome UI, whose button
   * needs to know whether its menu is up. One event rather than two keeps the two
   * renderers from ever disagreeing about what is on screen.
   */
  'overlay:presented'
] as const

export type EventChannel = (typeof EVENT_CHANNELS)[number]

const invokeSet: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
const eventSet: ReadonlySet<string> = new Set(EVENT_CHANNELS)

export function isInvokeChannel(value: string): value is InvokeChannel {
  return invokeSet.has(value)
}

export function isEventChannel(value: string): value is EventChannel {
  return eventSet.has(value)
}

