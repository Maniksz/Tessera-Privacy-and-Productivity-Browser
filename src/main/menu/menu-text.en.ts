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
  'menu.tools.extensionsTab': 'Extensions in a tab',
  'menu.tools.clearData': 'Clear Browsing Data…',
  'menu.tools.panic': 'Delete Everything and Quit',

  'menu.window.minimize': 'Minimize',
  'menu.window.zoom': 'Zoom',
  'menu.window.nextTab': 'Next Tab',
  'menu.window.previousTab': 'Previous Tab',

  'menu.help': 'Help',
  'menu.help.about': 'About {app}',

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

  // the question a page's `beforeunload` puts, a native dialog as well; see `browser/unload-guard.ts`
  'unload.closeTab': 'Close this tab?',
  'unload.leavePage': 'Leave this page?',
  /** Names the site (R11): with four pages on screen, "this page" alone does not say which. */
  'unload.detail': 'Changes you made on {site} may not be saved.',
  'unload.leave': 'Leave',
  'unload.stay': 'Stay'
} as const satisfies Record<string, string>

export type MenuTextKey = keyof typeof en

/** Every locale must cover exactly the reference keys. */
export type MenuText = Readonly<Record<MenuTextKey, string>>
