/**
 * What the native menus say. English, and the reference table.
 *
 * `menu-text.de.ts` is checked against these keys with `satisfies MenuText`, so a German file that
 * misses a label or keeps one this file dropped does not compile — the same arrangement as
 * `catalog.en.ts` and `catalog.de.ts`, for the same reason.
 *
 * See `menu-text.ts` for why these labels are here in the core and not in `shared/i18n/catalog.*`,
 * and for which `menu.*` keys stayed behind in the catalogue.
 *
 * The keys keep the names they had in the catalogue. A search for `menu.file.newTab` still finds
 * the label and every place that shows it, and `menu-text.ts` can tell the two tables apart by key
 * alone, because no key is in both — `tests/menu-text.test.ts` holds them to that.
 */
export const en = {
  // application menu
  'menu.file': 'File',
  'menu.file.newTab': 'New Tab',
  'menu.file.newWindow': 'New Window',
  'menu.file.newPrivateWindow': 'New Private Window',
  'menu.file.closeTab': 'Close Tab',
  'menu.file.reopenClosedTab': 'Reopen Closed Tab',
  'menu.file.print': 'Print…',
  'menu.file.closeWindow': 'Close Window',
  'menu.file.quit': 'Quit',

  'menu.edit': 'Edit',
  'menu.edit.undo': 'Undo',
  'menu.edit.redo': 'Redo',
  'menu.edit.cut': 'Cut',
  'menu.edit.copy': 'Copy',
  'menu.edit.paste': 'Paste',
  'menu.edit.selectAll': 'Select All',
  'menu.edit.findInPage': 'Find in Page…',
  'menu.edit.findNext': 'Find Next',
  'menu.edit.settings': 'Settings…',

  'menu.view': 'View',
  'menu.view.reload': 'Reload',
  'menu.view.reloadIgnoringCache': 'Reload Without Cache',
  'menu.view.fullscreen': 'Full Screen',
  'menu.view.bookmarksBar': 'Bookmarks Bar',
  'menu.view.focusAddressBar': 'Focus Address Bar',
  'menu.view.focusTileBar': 'Focus Tile Navigation Bar',
  'menu.view.devTools': 'Developer Tools',

  'menu.history': 'History',
  'menu.history.back': 'Back',
  'menu.history.forward': 'Forward',
  'menu.history.home': 'Home',
  'menu.history.showAll': 'Show All History',

  'menu.bookmarks': 'Bookmarks',
  'menu.bookmarks.add': 'Bookmark This Page',
  'menu.bookmarks.manage': 'Manage Bookmarks',

  'menu.split': 'Split View',
  'menu.split.tileLeft': 'Focus Tile Left',
  'menu.split.tileRight': 'Focus Tile Right',
  'menu.split.tileUp': 'Focus Tile Above',
  'menu.split.tileDown': 'Focus Tile Below',
  'menu.split.maximizeTile': 'Maximize Tile',

  'menu.tools': 'Tools',
  'menu.tools.passwords': 'Passwords',
  'menu.tools.fillPassword': 'Fill In Saved Password',
  'menu.tools.extensionsTab': 'Extensions in a tab',
  'menu.tools.clearData': 'Clear Browsing Data…',
  'menu.tools.panic': 'Delete Everything and Quit',

  'menu.window.minimize': 'Minimize',
  'menu.window.zoom': 'Zoom',
  'menu.window.nextTab': 'Next Tab',
  'menu.window.previousTab': 'Previous Tab',
  'menu.window.searchTabs': 'Search Tabs…',

  'menu.help': 'Help',
  'menu.help.about': 'About {app}',

  // a tiled view's entry in the tab strip; see `menu/arrangement-items.ts`
  'arrangement.changeLayout': 'Change Layout',
  /** Also the Split View menu's item for the view on screen. */
  'arrangement.end': 'End Tiled View',
  'arrangement.closeAll': 'Close All Tabs',

  // blocker menu, behind the badge in the address bar
  'blocker.blockedOnPage': '{count} requests blocked on this page',
  'blocker.myRules': 'My rules ({count})',
  'blocker.updateLists': 'Update filter lists now',
  'blocker.enabled': 'Blocking enabled',
  /*
    The per-site switch, worded as the state rather than as the change.

    "Blocking on this site ✓" says what is true now as well as what a click would do, which is what a
    checkbox is for — and it matters more here than for the global switch, because somebody who turned
    filtering off to read one page and forgot has a wrong idea of why that site is full of adverts.
  */
  'blocker.enabledOnSite': 'Blocking on this site',
  'blocker.nothingBlockedYet': 'Nothing blocked on this page',
  'blocker.noRules': 'No rules of your own yet',
  'blocker.openSettings': 'Manage in settings…',
  /** How many of the user's own rules apply to the site in front of them, rather than in total. */
  'blocker.forgetSiteRules': 'Delete my rules for this site ({count})',

  // site menu, behind the lock in the address bar; see `menu/site-menu-items.ts`
  /** One stored answer: what the site asked for, and what it was told. */
  'site.permission.allowed': '{topic}: Allowed',
  'site.permission.blocked': '{topic}: Blocked',
  'site.permission.forget': 'Forget',
  /** Counts only what the menu lists, so camera, microphone and screen answers are not in it. */
  'site.permissions.forgetAll': 'Forget all permissions for this site ({count})',
  'site.permissions.none': 'No saved permissions for this site',
  'site.permissions.private': 'Permissions are not saved in private windows',
  'site.topic.geolocation': 'Location',
  'site.topic.notifications': 'Notifications',
  'site.topic.clipboardRead': 'Reading the clipboard',
  'site.topic.clipboardWrite': 'Writing to the clipboard',
  'site.topic.midi': 'MIDI devices',
  'site.topic.midiSysex': 'MIDI device commands',
  'site.topic.storageAccess': 'Storage across sites',
  'site.topic.topLevelStorageAccess': 'Storage across sites (whole page)',
  'site.zoom': 'Zoom: {percent}%',
  'site.fingerprint': 'Fingerprint protection',
  /** The plan is computed when a tab loads (`applies: 'new-tab'`), so an open tab keeps the old one. */
  'site.fingerprint.newTabs': 'Applies to tabs opened after a change',

  // the question a page's `beforeunload` puts, a native dialog as well; see `browser/unload-guard.ts`
  'unload.closeTab': 'Close this tab?',
  'unload.leavePage': 'Leave this page?',
  /** Names the site (R11): with four pages on screen, "this page" alone does not say which. */
  'unload.detail': 'Changes you made on {site} may not be saved.',
  'unload.leave': 'Leave',
  'unload.stay': 'Stay',

  // the three menu actions the core runs itself, native dialogs too; see `menu/menu-actions.ts`
  'bookmarks.readOnly.message': 'This page could not be bookmarked',
  'bookmarks.readOnly.detail':
    'The bookmarks file was written by a newer version of {app}, so this version only reads it. Nothing was changed.',
  'bookmarks.readOnly.ok': 'OK',
  'clearData.message': 'Clear browsing data now?',
  /** The categories are the inventory's, named as the settings page names them (KTD7). */
  'clearData.detail':
    'Everything clears history (with page pictures and icons), the downloads list, cookies (with network traces, HTTPS exceptions and media finds), site storage and the cache. Downloaded files stay where they are.',
  'clearData.detailPrivate':
    'Only this private window’s data is cleared; the normal windows are not touched. Downloaded files stay where they are.',
  'clearData.everything': 'Clear Everything',
  'clearData.keepHistory': 'Keep History and Downloads List',
  'clearData.cacheOnly': 'Only the Cache',
  'clearData.cancel': 'Cancel',
  'panic.message': 'Delete all browsing traces and quit {app}?',
  /** What stays is said as plainly as what goes: panic takes traces, not the profile. */
  'panic.detail':
    'History, the downloads list, cookies, site storage, the cache, every open tab and site permissions are deleted, and the next start restores no tabs. Bookmarks, passwords, quick links and settings stay, and so do downloaded files.',
  'panic.confirm': 'Delete and Quit',
  'panic.cancel': 'Cancel'
} as const satisfies Record<string, string>

export type MenuTextKey = keyof typeof en

/** Every locale must cover exactly the reference keys. */
export type MenuText = Readonly<Record<MenuTextKey, string>>
