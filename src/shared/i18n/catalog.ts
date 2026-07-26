/**
 * Message catalogue (spec 7: no hard-coded strings, German and English at
 * minimum).
 *
 * `en` is the reference catalogue; every other locale is checked against its keys
 * by the compiler, so a translation can never silently miss an entry or carry a
 * stale one.
 *
 * Deliberately dependency-free: every renderer imports this to render text, so a
 * validation library here would end up in the UI bundle. `localeSchema` lives in
 * `schema.ts` for that reason.
 */

import { PRODUCT_NAME } from '../product.js'

export const LOCALES = ['de', 'en'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

const en = {
  // application
  'app.name': '{app}',

  // menus
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
  'menu.view.stop': 'Stop',
  'menu.view.zoomIn': 'Zoom In',
  'menu.view.zoomOut': 'Zoom Out',
  'menu.view.zoomReset': 'Reset Zoom',
  'menu.view.readerMode': 'Reader Mode',
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
  'menu.split.layout1': 'Single Tile',
  'menu.split.layout2Columns': 'Two Columns',
  'menu.split.layout3Columns': 'Three Columns',
  'menu.split.layout4Columns': 'Four Columns',
  'menu.split.layout2Rows': 'Two Rows',
  'menu.split.layout3': 'One Large, Two Small',
  'menu.split.layout4': 'Four Tiles',
  'menu.split.tileLeft': 'Focus Tile Left',
  'menu.split.tileRight': 'Focus Tile Right',
  'menu.split.tileUp': 'Focus Tile Above',
  'menu.split.tileDown': 'Focus Tile Below',
  'menu.split.maximizeTile': 'Maximize Tile',

  'menu.tools': 'Tools',
  'menu.tools.downloads': 'Downloads',
  'menu.tools.passwords': 'Passwords',
  'menu.tools.settingsTab': 'Settings in a tab',
  'menu.tools.extensionsTab': 'Extensions in a tab',
  'menu.tools.clearData': 'Clear Browsing Data…',
  'menu.tools.panic': 'Delete Everything and Quit',

  'menu.window': 'Window',
  'menu.window.minimize': 'Minimize',
  'menu.window.zoom': 'Zoom',
  'menu.window.nextTab': 'Next Tab',
  'menu.window.previousTab': 'Previous Tab',

  'menu.help': 'Help',
  'menu.help.about': 'About {app}',

  // toolbar
  'toolbar.back': 'Back',
  'toolbar.forward': 'Forward',
  'toolbar.reload': 'Reload',
  'toolbar.stop': 'Stop loading',
  'toolbar.home': 'Home',
  'toolbar.layout': 'Split layout: {current}',
  'toolbar.layoutTileCount': '{count} tiles',
  'toolbar.settings': 'Settings',
  'toolbar.extensions': 'Extensions',
  'toolbar.menu': 'Main menu',

  // address bar
  'omnibox.placeholder': 'Search or enter address',
  'omnibox.searchWith': 'Search with {engine}',
  'omnibox.openUrl': 'Open {url}',
  'omnibox.security.secure': 'Connection is encrypted',
  'omnibox.security.insecure': 'Connection is not encrypted',
  'omnibox.security.invalidCertificate': 'Certificate is not valid',
  'omnibox.security.internal': '{app} page',
  'omnibox.privateMode': 'Private window',
  'omnibox.blockedCount': '{count} requests blocked',
  'omnibox.siteSettings': 'Site settings',

  // tabs
  'tab.newTab': 'New tab',
  'tab.untitled': 'Untitled',
  'tab.close': 'Close tab',
  'tab.mute': 'Mute tab',
  'tab.unmute': 'Unmute tab',
  'tab.pin': 'Pin tab',
  'tab.unpin': 'Unpin tab',
  'tab.openInTile': 'Open in tile {index}',
  'tab.inTile': 'In tile {index}',
  'tab.unassigned': 'Not shown in any tile',

  // tab groups
  /** What an unnamed group is called when it needs a name — in a label, never on screen. */
  'tabgroup.unnamed': 'Unnamed group',
  'tabgroup.collapse': 'Collapse group {name}',
  /** The count matters: it is the only thing saying the tabs still exist. */
  'tabgroup.expand': 'Expand group {name}, {count} tabs hidden',
  'tabgroup.new': 'Group these tabs',
  'tabgroup.rename': 'Rename group',
  'tabgroup.dissolve': 'Ungroup',
  'tabgroup.removeTab': 'Remove from group',
  'tabgroup.addTo': 'Add to group',
  'tabgroup.recolor': 'Group colour',
  /*
    The colours have names because a submenu of eight unlabelled swatches is unusable with a screen
    reader, and because an unnamed group is identified in a menu by its colour alone.
  */
  'tabgroup.color.blue': 'Blue',
  'tabgroup.color.cyan': 'Cyan',
  'tabgroup.color.green': 'Green',
  'tabgroup.color.yellow': 'Yellow',
  'tabgroup.color.orange': 'Orange',
  'tabgroup.color.red': 'Red',
  'tabgroup.color.pink': 'Pink',
  'tabgroup.color.grey': 'Grey',

  // split view
  'split.tile': 'Tile {index}',
  'split.activeTile': 'Active tile',
  'split.maximize': 'Maximize tile',
  'split.restore': 'Restore layout',
  'split.dropHere': 'Drop tab here',
  'split.dropLeft': 'Open on the left',
  'split.dropRight': 'Open on the right',
  'split.dropTop': 'Open above',
  'split.dropBottom': 'Open below',
  'split.dropTile': 'Open in tile {index}',
  'split.dragging': 'Moving “{title}”',
  'split.emptyTile': 'Drag a tab here',

  // history
  'history.title': 'History',
  'history.searchPlaceholder': 'Search history',
  'history.empty': 'Nothing here yet. Pages you visit will appear here.',
  'history.emptyPrivate': 'A private window records nothing.',
  'history.noMatches': 'No page matches {query}.',
  'history.today': 'Today',
  'history.yesterday': 'Yesterday',
  'history.older': 'Earlier',
  'history.visits': 'Visited {count} times',
  'history.visitedOnce': 'Visited once',
  'history.lastVisit': 'Last visited {time}',
  'history.open': 'Open {title}',
  'history.remove': 'Remove {title} from history',
  'history.removeDomain': 'Remove everything from {domain}',
  'history.clearAll': 'Clear all history',
  'history.clearAllConfirm': 'Remove every entry? This cannot be undone.',
  'history.removedCount': '{count} entries removed',
  'history.groupLabel': '{group}, {count} entries',

  // bookmarks
  'bookmarks.title': 'Bookmarks',
  'bookmarks.searchPlaceholder': 'Search bookmarks',
  /*
    The two roots are named here rather than stored as folder nodes.

    That is the stated cost of the decision in `shared/bookmarks/model.ts`: a root cannot be
    renamed, moved or deleted because it is not a node — so its name has to be a translated string,
    which is where it belonged anyway.
  */
  'bookmarks.bar': 'Bookmarks bar',
  'bookmarks.other': 'Other bookmarks',
  'bookmarks.empty': 'Nothing here yet. Pages you keep will appear here.',
  'bookmarks.emptyFolder': 'This folder is empty.',
  'bookmarks.noMatches': 'No bookmark matches {query}.',
  'bookmarks.location': 'Location',
  'bookmarks.open': 'Open {title}',
  'bookmarks.openFolder': 'Open folder {title}',
  'bookmarks.itemCount': '{count} items',
  'bookmarks.addFolder': 'New folder',
  'bookmarks.newFolderName': 'New folder',
  'bookmarks.edit': 'Edit {title}',
  'bookmarks.remove': 'Remove {title}',
  'bookmarks.removeFolder': 'Remove folder {title} and everything in it',
  /** Asked only when something else goes with it: deleting a folder is transitive. */
  'bookmarks.removeFolderConfirm':
    'Remove “{title}” and the {count} items inside it? This cannot be undone.',
  'bookmarks.removedCount': '{count} entries removed',
  'bookmarks.moveUp': 'Move {title} up',
  'bookmarks.moveDown': 'Move {title} down',
  'bookmarks.moveToBar': 'Move {title} to the bookmarks bar',
  'bookmarks.moveToOther': 'Move {title} to other bookmarks',
  'bookmarks.import': 'Import from a file…',
  /** The folder an import is grafted under, so nothing lands loose among curated entries. */
  'bookmarks.importedFolder': 'Imported bookmarks',
  'bookmarks.importResult': '{imported} imported, {skipped} skipped',
  'bookmarks.dialogTitle': 'Edit bookmark',
  'bookmarks.dialogFolderTitle': 'Rename folder',
  'bookmarks.name': 'Name',
  'bookmarks.address': 'Address',
  'bookmarks.addressInvalid': 'That is not an address. Enter a domain or a full URL.',
  'bookmarks.save': 'Save',
  'bookmarks.cancel': 'Cancel',

  // downloads
  'downloads.title': 'Downloads',
  'downloads.empty': 'Nothing downloaded yet.',
  'downloads.privateNotice': 'A private window records no downloads.',
  'downloads.state.progressing': 'Downloading',
  /*
    Paused is a state here although Electron reports it as a flag on `progressing`.

    A row built from `getState()` alone would say "in progress" beside a byte count that never
    moves, which is the most confusing thing this list could show.
  */
  'downloads.state.paused': 'Paused',
  'downloads.state.completed': 'Finished',
  'downloads.state.cancelled': 'Cancelled',
  'downloads.state.interrupted': 'Failed',
  'downloads.progress': '{received} of {total}',
  /** No `Content-Length`, so there is no total to count towards. */
  'downloads.progressUnknown': '{received} downloaded',
  'downloads.fromHost': 'from {host}',
  'downloads.open': 'Open {name}',
  'downloads.reveal': 'Show {name} in its folder',
  'downloads.pause': 'Pause {name}',
  'downloads.resume': 'Resume {name}',
  'downloads.cancel': 'Cancel {name}',
  'downloads.remove': 'Remove {name} from the list',
  'downloads.clear': 'Clear finished downloads',
  'downloads.clearedCount': '{count} entries removed',
  /** Said instead of offering an Open button, rather than beside one that fails. */
  'downloads.fileMissing': 'The file was moved or deleted.',
  'downloads.openFailed': 'That file is no longer there.',
  'downloads.cannotResume':
    'This download cannot be resumed and would start again from the beginning.',
  /** Shown verbatim: the reasons come from Chromium and the set grows between versions. */
  'downloads.reason': 'Reason: {reason}',
  'downloads.byteSize': '{value} {unit}',

  /*
    Saved passwords.

    Two of these say something no other page in the browser has to. `protectionNotice` and
    `unencryptedNotice` describe how the vault is actually protected on *this* machine, including
    the part that is uncomfortable — the platform key store unwraps for anybody already signed in
    as this user. A manager that did not say so on its own front page would be misrepresenting
    itself, and `revealNotice` exists for the same reason: a password that vanishes after half a
    minute reads as a fault unless the bound is stated.
  */
  'passwords.title': 'Passwords',
  'passwords.protectionNotice':
    'These are encrypted with a key your operating system keeps. Anyone already signed in as you can read them.',
  'passwords.unencryptedNotice':
    'There was no system key store to protect these with, so they are stored as readable text.',
  'passwords.searchPlaceholder': 'Search passwords',
  'passwords.empty': 'No passwords saved yet.',
  'passwords.noMatches': 'No entry matches {query}.',
  'passwords.username': 'User name',
  'passwords.noUsername': 'No user name',
  /** Short: the page uses this for the button text as well as for its label. */
  'passwords.reveal': 'Show for {site}',
  'passwords.hide': 'Hide',
  'passwords.revealNotice':
    'A password that is shown is hidden again after {seconds} seconds, and at once when you leave this tab.',
  /** Why autofill will never offer this entry — the scheme it was saved over. */
  'passwords.notFilled': 'not filled in automatically, because it was saved without encryption',
  'passwords.lastUsed': 'Last used {time}',
  'passwords.neverUsed': 'Never used',
  'passwords.remove': 'Remove the entry for {site}',
  'passwords.removeConfirm': 'Remove the saved password for {site}? This cannot be undone.',
  'passwords.removed': 'Entry removed',
  'passwords.edit': 'Change',
  'passwords.editTitle': 'Change the password for {site}',
  'passwords.newPassword': 'New password',
  'passwords.saveChanges': 'Save',
  'passwords.updated': 'Password updated',
  'passwords.cancel': 'Cancel',
  'passwords.add': 'Add',
  'passwords.addTitle': 'New entry',
  'passwords.site': 'Site',
  'passwords.sitePlaceholder': 'For example example.com',
  'passwords.password': 'Password',
  'passwords.created': 'Entry saved',
  'passwords.rejected':
    'That could not be saved. Check the address, and that the password is not empty.',
  'passwords.neverSavedTitle': 'Never saved here',
  'passwords.neverSavedEmpty': 'No site is on this list.',
  'passwords.forgetNeverSaved': 'Ask again for {site}',
  /*
    The last six are drawn inside a web page by the preload, with wording the core translates.

    So a language change reaches the next sign-in form rather than the next restart — the preload
    has no catalogue of its own and must not grow one.
  */
  'passwords.fillTitle': 'Saved for {site}',
  'passwords.savePrompt': 'Save the password for {site}?',
  'passwords.saveUpdatePrompt': 'Update the saved password for {site}?',
  'passwords.saveAction': 'Save',
  'passwords.neverAction': 'Never here',
  'passwords.dismissAction': 'Not now',

  /*
    Permission prompts (spec 4).

    Each subject is named as the thing the *user* recognises rather than as the Chromium permission it
    maps to: "your location", not "geolocation". A consent dialogue is only meaningful if the person can
    tell what they are agreeing to, and `midi-sysex` is not something anybody has an opinion about
    until it is described as what it can do.
  */
  'permission.title': 'Permission request',
  'permission.asking': '{origin} would like access to {subject}',
  'permission.allowOnce': 'Allow this time',
  'permission.allowAlways': 'Always allow for this site',
  'permission.block': 'Block',
  'permission.keyboardHint': 'Escape blocks the request',
  'permission.waitingOne': '1 further request is waiting',
  'permission.waitingMany': '{count} further requests are waiting',
  'permission.device.camera': 'Camera',
  'permission.device.microphone': 'Microphone',
  'permission.subject.camera': 'your camera',
  'permission.subject.microphone': 'your microphone',
  'permission.subject.cameraAndMicrophone': 'your camera and microphone',
  'permission.subject.geolocation': 'your location',
  'permission.subject.notifications': 'sending you notifications',
  'permission.subject.clipboardRead': 'reading your clipboard',
  'permission.subject.clipboardWrite': 'writing to your clipboard',
  'permission.subject.displayCapture': 'recording your screen',
  'permission.subject.midi': 'your MIDI devices',
  'permission.subject.midiSysex': 'sending commands to your MIDI devices',
  'permission.subject.storageAccess': 'storing data across sites',
  'permission.subject.topLevelStorageAccess': 'storing data across sites',

  /*
    The element picker.

    Each warning says what will *happen*, not what the rule is technically like: "would hide the surrounding
    region" is something a person can decide about, "matches an ancestor" is not.
  */
  'picker.hint': 'Click to hide · Escape to cancel',
  'picker.noRule': 'No rule can be written for this element',
  'picker.warning.matchesAncestor': 'Would hide the surrounding region',
  'picker.warning.matchesMany': 'Would hide several elements',
  'picker.warning.positional': 'Depends on position — may stop working when the page changes',
  'picker.warning.noStableFeature': 'This element has no stable name to match on',

  // page context menu
  'page.openLinkInNewTab': 'Open link in new tab',
  'page.copyLinkAddress': 'Copy link address',
  'page.copyImageAddress': 'Copy image address',
  'page.copy': 'Copy',
  'page.searchFor': 'Search for “{text}”',
  'page.blockElement': 'Block element…',
  'page.inspect': 'Inspect',

  // blocker menu, behind the badge in the address bar
  'blocker.blockedOnPage': '{count} requests blocked on this page',
  'blocker.myRules': 'My rules ({count})',
  'blocker.updateLists': 'Update filter lists now',
  'blocker.enabled': 'Blocking enabled',

  // reader mode
  'reader.title': 'Reader',
  'reader.untitled': 'Untitled',
  'reader.loading': 'Preparing…',
  'reader.byline': 'By {author}',
  'reader.published': 'Published {date}',
  'reader.measured': '{minutes} min read',
  'reader.openOriginal': 'Open the original page',
  'reader.imageAlt': 'Image from the article',
  'reader.imageOpen': 'Open this image',
  'reader.refusedTitle': 'This page does not look like an article',
  /*
    Each refusal names what was found rather than what was wanted.

    The extractor refuses rather than showing a partial article on purpose: three paragraphs of nine is worse
    than nothing, because the reader cannot tell until the text stops. So each of these has to be specific
    enough that the user knows whether to try again or go back.
  */
  'reader.refused.unreadable': 'The page could not be read.',
  'reader.refused.expired': 'The page changed while it was being prepared. Try again.',
  'reader.refused.truncated': 'Only part of the article could be found, so none of it is shown.',
  'reader.refused.noProse': 'No article text was found on this page.',
  'reader.refused.tooLittleProse': 'There is too little text here to show as an article.',

  // find in page
  'find.label': 'Find in tile {index}',
  'find.field': 'Search text in tile {index}',
  'find.searching': 'Searching…',
  'find.noMatches': 'No matches',
  'find.oneMatch': '1 match',
  'find.ordinal': '{active} of {total}',
  'find.previous': 'Previous match',
  'find.next': 'Next match',
  'find.close': 'Close find bar',

  // per-tile navigation bar
  'tileBar.label': 'Navigation for tile {index}',
  'tileBar.address': 'Address in tile {index}',

  // start page / quick links
  'start.tagline': 'Local only. No account, no cloud, no telemetry.',
  'start.quickLinks': 'Quick links',
  'start.breadcrumb': 'Location',
  'start.allTiles': 'All tiles',
  'start.addTile': 'Add tile',
  'start.addFolder': 'Add folder',
  'start.noTiles': 'No tiles yet. Add one to get started.',
  'start.itemCount': '{count} items',
  'start.tileLabel': '{name}, {url}',
  'start.folderLabel': 'Folder {name}, {count} items',
  'start.editTile': 'Edit {name}',
  'start.removeTile': 'Remove {name}',
  'start.bridgeUnavailable': 'This page cannot reach the browser core.',
  'start.dialog.newTile': 'New tile',
  'start.dialog.newFolder': 'New folder',
  'start.dialog.editTile': 'Edit tile',
  'start.dialog.editFolder': 'Rename folder',
  'start.dialog.address': 'Address',
  'start.dialog.addressHint': 'For example example.com',
  'start.dialog.addressResolved': 'Opens {title}',
  'start.dialog.addressInvalid': 'That is not an address. Enter a domain or a full URL.',
  'start.dialog.name': 'Name',
  'start.dialog.nameHint': 'Leave empty to use the domain.',
  'start.dialog.cancel': 'Cancel',
  'start.dialog.create': 'Create',
  'start.dialog.save': 'Save',

  // settings
  'settings.title': 'Settings',
  'settings.section.appearance': 'Appearance',
  'settings.section.search': 'Search',
  'settings.section.splitView': 'Split View',
  'settings.section.privacy': 'Privacy',
  'settings.section.permissions': 'Permissions',
  'settings.section.network': 'Network',
  'settings.section.downloads': 'Downloads',
  'settings.section.session': 'Session',
  'settings.section.clearData': 'Clear Data',
  'settings.section.advanced': 'Advanced',
  'settings.needsRestart': 'Takes effect after restarting',
  'settings.appliesNewTab': 'Takes effect for newly loaded content',
  'settings.unknownKey': 'Unknown setting: {key}',
  'settings.invalidValue': 'Invalid value for {key}',
  'settings.close': 'Close settings',
  'settings.searchPlaceholder': 'Search settings',
  'settings.reset': 'Reset to default',
  'settings.resetAll': 'Reset everything',
  'settings.noMatches': 'No setting matches {query}.',
  'settings.readOnly': 'Not editable here yet',
  'settings.listHint': 'One entry per line',
  'settings.on': 'On',
  'settings.off': 'Off',

  // extensions
  'extensions.title': 'Extensions',
  'extensions.close': 'Close extensions',
  'extensions.none': 'No extensions loaded.',
  'extensions.load': 'Load unpacked folder…',
  'extensions.remove': 'Remove {name}',
  'extensions.reason':
    'This browser has no extension store and no automatic updates. Only unpacked folders can be loaded, and only a subset of the extension APIs exists — no toolbar buttons, popups or options pages. An installed extension is also detectable by websites, which makes you easier to identify.',
  'extensions.loadFailed': 'Could not load that folder: {reason}',

  // shortcuts
  'shortcuts.conflict.linuxWorkspace':
    'Many Linux desktops use this combination to switch workspaces, so it never reaches {app}. Try {alternative}.',
  'shortcuts.conflict.macosMissionControl':
    'macOS reserves this combination for window management. Try {alternative}.',
  'shortcuts.conflict.windowsTextSelection':
    'Windows uses this combination for word-wise selection inside text fields. Try {alternative}.',

  // errors
  'error.dnsFailed': 'Could not find the server for {host}.',
  'error.offline': 'No network connection.',
  'error.certificate': 'The certificate for {host} could not be verified.',
  'error.blocked': '{app} blocked this request.',
  'error.httpsOnly': '{host} does not offer an encrypted connection.',
  'error.httpsOnly.continue': 'Continue unencrypted',
  'error.httpsOnly.back': 'Go back'
} as const satisfies Record<string, string>

export type MessageKey = keyof typeof en

/** Every locale must cover exactly the reference keys. */
type Catalog = Readonly<Record<MessageKey, string>>

const de = {
  'app.name': '{app}',

  'menu.file': 'Datei',
  'menu.file.newTab': 'Neuer Tab',
  'menu.file.newWindow': 'Neues Fenster',
  'menu.file.newPrivateWindow': 'Neues privates Fenster',
  'menu.file.closeTab': 'Tab schließen',
  'menu.file.reopenClosedTab': 'Geschlossenen Tab wiederherstellen',
  'menu.file.print': 'Drucken…',
  'menu.file.closeWindow': 'Fenster schließen',
  'menu.file.quit': 'Beenden',

  'menu.edit': 'Bearbeiten',
  'menu.edit.undo': 'Widerrufen',
  'menu.edit.redo': 'Wiederholen',
  'menu.edit.cut': 'Ausschneiden',
  'menu.edit.copy': 'Kopieren',
  'menu.edit.paste': 'Einfügen',
  'menu.edit.selectAll': 'Alles auswählen',
  'menu.edit.findInPage': 'Auf Seite suchen…',
  'menu.edit.findNext': 'Weitersuchen',
  'menu.edit.settings': 'Einstellungen…',

  'menu.view': 'Ansicht',
  'menu.view.reload': 'Neu laden',
  'menu.view.reloadIgnoringCache': 'Ohne Cache neu laden',
  'menu.view.stop': 'Laden abbrechen',
  'menu.view.zoomIn': 'Vergrößern',
  'menu.view.zoomOut': 'Verkleinern',
  'menu.view.zoomReset': 'Zoom zurücksetzen',
  'menu.view.readerMode': 'Lesemodus',
  'menu.view.fullscreen': 'Vollbild',
  'menu.view.bookmarksBar': 'Lesezeichenleiste',
  'menu.view.focusAddressBar': 'Adressleiste fokussieren',
  'menu.view.focusTileBar': 'Kachel-Navigationsleiste fokussieren',
  'menu.view.devTools': 'Entwicklerwerkzeuge',

  'menu.history': 'Verlauf',
  'menu.history.back': 'Zurück',
  'menu.history.forward': 'Vorwärts',
  'menu.history.home': 'Startseite',
  'menu.history.showAll': 'Gesamten Verlauf anzeigen',

  'menu.bookmarks': 'Lesezeichen',
  'menu.bookmarks.add': 'Lesezeichen setzen',
  'menu.bookmarks.manage': 'Lesezeichen verwalten',

  'menu.split': 'Split View',
  'menu.split.layout1': 'Einzelansicht',
  'menu.split.layout2Columns': 'Zwei Spalten',
  'menu.split.layout3Columns': 'Drei Spalten',
  'menu.split.layout4Columns': 'Vier Spalten',
  'menu.split.layout2Rows': 'Zwei Zeilen',
  'menu.split.layout3': 'Eine große, zwei kleine',
  'menu.split.layout4': 'Vier Kacheln',
  'menu.split.tileLeft': 'Kachel links aktivieren',
  'menu.split.tileRight': 'Kachel rechts aktivieren',
  'menu.split.tileUp': 'Kachel oben aktivieren',
  'menu.split.tileDown': 'Kachel unten aktivieren',
  'menu.split.maximizeTile': 'Kachel maximieren',

  'menu.tools': 'Werkzeuge',
  'menu.tools.downloads': 'Downloads',
  'menu.tools.passwords': 'Passwörter',
  'menu.tools.settingsTab': 'Einstellungen im Tab',
  'menu.tools.extensionsTab': 'Erweiterungen im Tab',
  'menu.tools.clearData': 'Browserdaten löschen…',
  'menu.tools.panic': 'Alles löschen und beenden',

  'menu.window': 'Fenster',
  'menu.window.minimize': 'Minimieren',
  'menu.window.zoom': 'Zoomen',
  'menu.window.nextTab': 'Nächster Tab',
  'menu.window.previousTab': 'Vorheriger Tab',

  'menu.help': 'Hilfe',
  'menu.help.about': 'Über {app}',

  'toolbar.back': 'Zurück',
  'toolbar.forward': 'Vorwärts',
  'toolbar.reload': 'Neu laden',
  'toolbar.stop': 'Laden abbrechen',
  'toolbar.home': 'Startseite',
  'toolbar.layout': 'Kachel-Layout: {current}',
  'toolbar.layoutTileCount': '{count} Kacheln',
  'toolbar.settings': 'Einstellungen',
  'toolbar.extensions': 'Erweiterungen',
  'toolbar.menu': 'Hauptmenü',

  'omnibox.placeholder': 'Suchen oder Adresse eingeben',
  'omnibox.searchWith': 'Mit {engine} suchen',
  'omnibox.openUrl': '{url} öffnen',
  'omnibox.security.secure': 'Verbindung ist verschlüsselt',
  'omnibox.security.insecure': 'Verbindung ist nicht verschlüsselt',
  'omnibox.security.invalidCertificate': 'Zertifikat ist ungültig',
  'omnibox.security.internal': '{app}-Seite',
  'omnibox.privateMode': 'Privates Fenster',
  'omnibox.blockedCount': '{count} Anfragen blockiert',
  'omnibox.siteSettings': 'Seiteneinstellungen',

  'tab.newTab': 'Neuer Tab',
  'tab.untitled': 'Ohne Titel',
  'tab.close': 'Tab schließen',
  'tab.mute': 'Tab stummschalten',
  'tab.unmute': 'Stummschaltung aufheben',
  'tab.pin': 'Tab anheften',
  'tab.unpin': 'Tab lösen',
  'tab.openInTile': 'In Kachel {index} öffnen',
  'tab.inTile': 'In Kachel {index}',
  'tab.unassigned': 'In keiner Kachel sichtbar',

  'tabgroup.unnamed': 'Unbenannte Gruppe',
  'tabgroup.collapse': 'Gruppe {name} einklappen',
  'tabgroup.expand': 'Gruppe {name} ausklappen, {count} Tabs verborgen',
  'tabgroup.new': 'Diese Tabs gruppieren',
  'tabgroup.rename': 'Gruppe umbenennen',
  'tabgroup.dissolve': 'Gruppierung auflösen',
  'tabgroup.removeTab': 'Aus Gruppe entfernen',
  'tabgroup.addTo': 'Zu Gruppe hinzufügen',
  'tabgroup.recolor': 'Gruppenfarbe',
  'tabgroup.color.blue': 'Blau',
  'tabgroup.color.cyan': 'Türkis',
  'tabgroup.color.green': 'Grün',
  'tabgroup.color.yellow': 'Gelb',
  'tabgroup.color.orange': 'Orange',
  'tabgroup.color.red': 'Rot',
  'tabgroup.color.pink': 'Pink',
  'tabgroup.color.grey': 'Grau',

  'split.tile': 'Kachel {index}',
  'split.activeTile': 'Aktive Kachel',
  'split.maximize': 'Kachel maximieren',
  'split.restore': 'Layout wiederherstellen',
  'split.dropHere': 'Tab hier ablegen',
  'split.dropLeft': 'Links öffnen',
  'split.dropRight': 'Rechts öffnen',
  'split.dropTop': 'Oben öffnen',
  'split.dropBottom': 'Unten öffnen',
  'split.dropTile': 'In Kachel {index} öffnen',
  'split.dragging': '„{title}“ wird verschoben',
  'split.emptyTile': 'Tab hierher ziehen',

  // history
  'history.title': 'Verlauf',
  'history.searchPlaceholder': 'Verlauf durchsuchen',
  'history.empty': 'Noch nichts hier. Besuchte Seiten erscheinen hier.',
  'history.emptyPrivate': 'Ein privates Fenster zeichnet nichts auf.',
  'history.noMatches': 'Keine Seite passt zu {query}.',
  'history.today': 'Heute',
  'history.yesterday': 'Gestern',
  'history.older': 'Früher',
  'history.visits': '{count} Mal besucht',
  'history.visitedOnce': 'Einmal besucht',
  'history.lastVisit': 'Zuletzt besucht {time}',
  'history.open': '{title} öffnen',
  'history.remove': '{title} aus dem Verlauf entfernen',
  'history.removeDomain': 'Alles von {domain} entfernen',
  'history.clearAll': 'Gesamten Verlauf löschen',
  'history.clearAllConfirm': 'Jeden Eintrag entfernen? Das lässt sich nicht zurücknehmen.',
  'history.removedCount': '{count} Einträge entfernt',
  'history.groupLabel': '{group}, {count} Einträge',

  'bookmarks.title': 'Lesezeichen',
  'bookmarks.searchPlaceholder': 'Lesezeichen durchsuchen',
  'bookmarks.bar': 'Lesezeichenleiste',
  'bookmarks.other': 'Weitere Lesezeichen',
  'bookmarks.empty': 'Noch nichts hier. Aufbewahrte Seiten erscheinen hier.',
  'bookmarks.emptyFolder': 'Dieser Ordner ist leer.',
  'bookmarks.noMatches': 'Kein Lesezeichen passt zu {query}.',
  'bookmarks.location': 'Ort',
  'bookmarks.open': '{title} öffnen',
  'bookmarks.openFolder': 'Ordner {title} öffnen',
  'bookmarks.itemCount': '{count} Einträge',
  'bookmarks.addFolder': 'Neuer Ordner',
  'bookmarks.newFolderName': 'Neuer Ordner',
  'bookmarks.edit': '{title} bearbeiten',
  'bookmarks.remove': '{title} entfernen',
  'bookmarks.removeFolder': 'Ordner {title} mit allem darin entfernen',
  'bookmarks.removeFolderConfirm':
    '„{title}“ und die {count} Einträge darin entfernen? Das lässt sich nicht zurücknehmen.',
  'bookmarks.removedCount': '{count} Einträge entfernt',
  'bookmarks.moveUp': '{title} nach oben',
  'bookmarks.moveDown': '{title} nach unten',
  'bookmarks.moveToBar': '{title} in die Lesezeichenleiste verschieben',
  'bookmarks.moveToOther': '{title} zu den weiteren Lesezeichen verschieben',
  'bookmarks.import': 'Aus einer Datei importieren…',
  'bookmarks.importedFolder': 'Importierte Lesezeichen',
  'bookmarks.importResult': '{imported} importiert, {skipped} übersprungen',
  'bookmarks.dialogTitle': 'Lesezeichen bearbeiten',
  'bookmarks.dialogFolderTitle': 'Ordner umbenennen',
  'bookmarks.name': 'Name',
  'bookmarks.address': 'Adresse',
  'bookmarks.addressInvalid':
    'Das ist keine Adresse. Gib eine Domain oder eine vollständige URL ein.',
  'bookmarks.save': 'Speichern',
  'bookmarks.cancel': 'Abbrechen',

  'downloads.title': 'Downloads',
  'downloads.empty': 'Noch nichts heruntergeladen.',
  'downloads.privateNotice': 'Ein privates Fenster zeichnet keine Downloads auf.',
  'downloads.state.progressing': 'Wird geladen',
  'downloads.state.paused': 'Angehalten',
  'downloads.state.completed': 'Fertig',
  'downloads.state.cancelled': 'Abgebrochen',
  'downloads.state.interrupted': 'Fehlgeschlagen',
  'downloads.progress': '{received} von {total}',
  'downloads.progressUnknown': '{received} geladen',
  'downloads.fromHost': 'von {host}',
  'downloads.open': '{name} öffnen',
  'downloads.reveal': '{name} im Ordner zeigen',
  'downloads.pause': '{name} anhalten',
  'downloads.resume': '{name} fortsetzen',
  'downloads.cancel': '{name} abbrechen',
  'downloads.remove': '{name} aus der Liste entfernen',
  'downloads.clear': 'Fertige Downloads aus der Liste entfernen',
  'downloads.clearedCount': '{count} Einträge entfernt',
  'downloads.fileMissing': 'Die Datei wurde verschoben oder gelöscht.',
  'downloads.openFailed': 'Diese Datei ist nicht mehr vorhanden.',
  'downloads.cannotResume':
    'Dieser Download lässt sich nicht fortsetzen und würde von vorn beginnen.',
  'downloads.reason': 'Grund: {reason}',
  'downloads.byteSize': '{value} {unit}',

  'passwords.title': 'Passwörter',
  'passwords.protectionNotice':
    'Sie sind mit einem Schlüssel verschlüsselt, den dein Betriebssystem aufbewahrt. Wer als du angemeldet ist, kann sie lesen.',
  'passwords.unencryptedNotice':
    'Es gab keinen Schlüsselspeicher des Systems, um sie zu schützen — sie liegen als lesbarer Text auf der Platte.',
  'passwords.searchPlaceholder': 'Passwörter durchsuchen',
  'passwords.empty': 'Noch keine Passwörter gespeichert.',
  'passwords.noMatches': 'Kein Eintrag passt zu {query}.',
  'passwords.username': 'Benutzername',
  'passwords.noUsername': 'Kein Benutzername',
  'passwords.reveal': 'Für {site} anzeigen',
  'passwords.hide': 'Verbergen',
  'passwords.revealNotice':
    'Ein angezeigtes Passwort wird nach {seconds} Sekunden wieder verborgen — und sofort, wenn du diesen Tab verlässt.',
  'passwords.notFilled': 'wird nicht automatisch eingefüllt, weil ohne Verschlüsselung gespeichert',
  'passwords.lastUsed': 'Zuletzt verwendet {time}',
  'passwords.neverUsed': 'Nie verwendet',
  'passwords.remove': 'Eintrag für {site} entfernen',
  'passwords.removeConfirm':
    'Gespeichertes Passwort für {site} entfernen? Das lässt sich nicht zurücknehmen.',
  'passwords.removed': 'Eintrag entfernt',
  'passwords.edit': 'Ändern',
  'passwords.editTitle': 'Passwort für {site} ändern',
  'passwords.newPassword': 'Neues Passwort',
  'passwords.saveChanges': 'Speichern',
  'passwords.updated': 'Passwort aktualisiert',
  'passwords.cancel': 'Abbrechen',
  'passwords.add': 'Hinzufügen',
  'passwords.addTitle': 'Neuer Eintrag',
  'passwords.site': 'Seite',
  'passwords.sitePlaceholder': 'Zum Beispiel example.com',
  'passwords.password': 'Passwort',
  'passwords.created': 'Eintrag gespeichert',
  'passwords.rejected':
    'Das ließ sich nicht speichern. Prüfe die Adresse und dass das Passwort nicht leer ist.',
  'passwords.neverSavedTitle': 'Hier nie speichern',
  'passwords.neverSavedEmpty': 'Keine Seite steht auf dieser Liste.',
  'passwords.forgetNeverSaved': 'Für {site} wieder fragen',
  'passwords.fillTitle': 'Gespeichert für {site}',
  'passwords.savePrompt': 'Passwort für {site} speichern?',
  'passwords.saveUpdatePrompt': 'Gespeichertes Passwort für {site} aktualisieren?',
  'passwords.saveAction': 'Speichern',
  'passwords.neverAction': 'Hier nie',
  'passwords.dismissAction': 'Jetzt nicht',

  'permission.title': 'Berechtigungsanfrage',
  'permission.asking': '{origin} möchte Zugriff auf {subject}',
  'permission.allowOnce': 'Dieses Mal erlauben',
  'permission.allowAlways': 'Für diese Seite immer erlauben',
  'permission.block': 'Blockieren',
  'permission.keyboardHint': 'Escape blockiert die Anfrage',
  'permission.waitingOne': '1 weitere Anfrage wartet',
  'permission.waitingMany': '{count} weitere Anfragen warten',
  'permission.device.camera': 'Kamera',
  'permission.device.microphone': 'Mikrofon',
  'permission.subject.camera': 'deine Kamera',
  'permission.subject.microphone': 'dein Mikrofon',
  'permission.subject.cameraAndMicrophone': 'deine Kamera und dein Mikrofon',
  'permission.subject.geolocation': 'deinen Standort',
  'permission.subject.notifications': 'Benachrichtigungen an dich',
  'permission.subject.clipboardRead': 'deine Zwischenablage zu lesen',
  'permission.subject.clipboardWrite': 'in deine Zwischenablage zu schreiben',
  'permission.subject.displayCapture': 'deinen Bildschirm aufzuzeichnen',
  'permission.subject.midi': 'deine MIDI-Geräte',
  'permission.subject.midiSysex': 'Befehle an deine MIDI-Geräte zu senden',
  'permission.subject.storageAccess': 'seitenübergreifend Daten zu speichern',
  'permission.subject.topLevelStorageAccess': 'seitenübergreifend Daten zu speichern',

  'picker.hint': 'Klicken zum Ausblenden · Escape bricht ab',
  'picker.noRule': 'Für dieses Element lässt sich keine Regel schreiben',
  'picker.warning.matchesAncestor': 'Würde den umgebenden Bereich mit ausblenden',
  'picker.warning.matchesMany': 'Würde mehrere Elemente ausblenden',
  'picker.warning.positional': 'Hängt von der Position ab — kann bei Änderungen der Seite ausfallen',
  'picker.warning.noStableFeature': 'Dieses Element hat keinen stabilen Namen zum Anknüpfen',

  'page.openLinkInNewTab': 'Link in neuem Tab öffnen',
  'page.copyLinkAddress': 'Linkadresse kopieren',
  'page.copyImageAddress': 'Bildadresse kopieren',
  'page.copy': 'Kopieren',
  'page.searchFor': 'Nach „{text}“ suchen',
  'page.blockElement': 'Element blockieren…',
  'page.inspect': 'Untersuchen',

  'blocker.blockedOnPage': '{count} Anfragen auf dieser Seite blockiert',
  'blocker.myRules': 'Meine Regeln ({count})',
  'blocker.updateLists': 'Filterlisten jetzt aktualisieren',
  'blocker.enabled': 'Blockieren aktiv',

  'reader.title': 'Leseansicht',
  'reader.untitled': 'Ohne Titel',
  'reader.loading': 'Wird vorbereitet…',
  'reader.byline': 'Von {author}',
  'reader.published': 'Veröffentlicht {date}',
  'reader.measured': '{minutes} Min. Lesezeit',
  'reader.openOriginal': 'Originalseite öffnen',
  'reader.imageAlt': 'Bild aus dem Artikel',
  'reader.imageOpen': 'Dieses Bild öffnen',
  'reader.refusedTitle': 'Diese Seite sieht nicht wie ein Artikel aus',
  'reader.refused.unreadable': 'Die Seite konnte nicht gelesen werden.',
  'reader.refused.expired': 'Die Seite hat sich während der Vorbereitung geändert. Bitte erneut versuchen.',
  'reader.refused.truncated': 'Es wurde nur ein Teil des Artikels gefunden, daher wird nichts davon gezeigt.',
  'reader.refused.noProse': 'Auf dieser Seite wurde kein Artikeltext gefunden.',
  'reader.refused.tooLittleProse': 'Hier ist zu wenig Text, um ihn als Artikel darzustellen.',
  'find.label': 'In Kachel {index} suchen',
  'find.field': 'Suchtext in Kachel {index}',
  'find.searching': 'Wird gesucht…',
  'find.noMatches': 'Keine Treffer',
  'find.oneMatch': '1 Treffer',
  'find.ordinal': '{active} von {total}',
  'find.previous': 'Vorheriger Treffer',
  'find.next': 'Nächster Treffer',
  'find.close': 'Suchleiste schließen',
  'tileBar.label': 'Navigation für Kachel {index}',
  'tileBar.address': 'Adresse in Kachel {index}',

  'start.tagline': 'Nur lokal. Kein Account, keine Cloud, keine Telemetrie.',
  'start.quickLinks': 'Quick Links',
  'start.breadcrumb': 'Ort',
  'start.allTiles': 'Alle Kacheln',
  'start.addTile': 'Kachel hinzufügen',
  'start.addFolder': 'Ordner hinzufügen',
  'start.noTiles': 'Noch keine Kacheln. Lege die erste an.',
  'start.itemCount': '{count} Einträge',
  'start.tileLabel': '{name}, {url}',
  'start.folderLabel': 'Ordner {name}, {count} Einträge',
  'start.editTile': '{name} bearbeiten',
  'start.removeTile': '{name} entfernen',
  'start.bridgeUnavailable': 'Diese Seite erreicht den Browser-Kern nicht.',
  'start.dialog.newTile': 'Neue Kachel',
  'start.dialog.newFolder': 'Neuer Ordner',
  'start.dialog.editTile': 'Kachel bearbeiten',
  'start.dialog.editFolder': 'Ordner umbenennen',
  'start.dialog.address': 'Adresse',
  'start.dialog.addressHint': 'Zum Beispiel example.com',
  'start.dialog.addressResolved': 'Öffnet {title}',
  'start.dialog.addressInvalid': 'Das ist keine Adresse. Gib eine Domain oder eine vollständige URL ein.',
  'start.dialog.name': 'Name',
  'start.dialog.nameHint': 'Leer lassen, um die Domain zu verwenden.',
  'start.dialog.cancel': 'Abbrechen',
  'start.dialog.create': 'Anlegen',
  'start.dialog.save': 'Speichern',

  'settings.title': 'Einstellungen',
  'settings.section.appearance': 'Darstellung',
  'settings.section.search': 'Suche',
  'settings.section.splitView': 'Split View',
  'settings.section.privacy': 'Datenschutz',
  'settings.section.permissions': 'Berechtigungen',
  'settings.section.network': 'Netzwerk',
  'settings.section.downloads': 'Downloads',
  'settings.section.session': 'Sitzung',
  'settings.section.clearData': 'Daten löschen',
  'settings.section.advanced': 'Erweitert',
  'settings.needsRestart': 'Wirkt nach einem Neustart',
  'settings.appliesNewTab': 'Wirkt für neu geladene Inhalte',
  'settings.unknownKey': 'Unbekannte Einstellung: {key}',
  'settings.invalidValue': 'Ungültiger Wert für {key}',
  'settings.close': 'Einstellungen schließen',
  'settings.searchPlaceholder': 'Einstellungen durchsuchen',
  'settings.reset': 'Auf Standard zurücksetzen',
  'settings.resetAll': 'Alles zurücksetzen',
  'settings.noMatches': 'Keine Einstellung passt zu {query}.',
  'settings.readOnly': 'Hier noch nicht bearbeitbar',
  'settings.listHint': 'Ein Eintrag pro Zeile',
  'settings.on': 'An',
  'settings.off': 'Aus',

  'extensions.title': 'Erweiterungen',
  'extensions.close': 'Erweiterungen schließen',
  'extensions.none': 'Keine Erweiterungen geladen.',
  'extensions.load': 'Entpackten Ordner laden…',
  'extensions.remove': '{name} entfernen',
  'extensions.reason':
    'Dieser Browser hat keinen Erweiterungs-Store und keine automatischen Updates. Es lassen sich nur entpackte Ordner laden, und nur ein Teil der Erweiterungs-Schnittstellen existiert — keine Toolbar-Buttons, keine Popups, keine Options-Seiten. Eine installierte Erweiterung ist außerdem für Websites erkennbar und macht dich damit leichter identifizierbar.',
  'extensions.loadFailed': 'Ordner konnte nicht geladen werden: {reason}',

  'shortcuts.conflict.linuxWorkspace':
    'Viele Linux-Desktops nutzen diese Kombination zum Wechsel der Arbeitsfläche, sie erreicht {app} deshalb nicht. Alternative: {alternative}.',
  'shortcuts.conflict.macosMissionControl':
    'macOS reserviert diese Kombination für die Fensterverwaltung. Alternative: {alternative}.',
  'shortcuts.conflict.windowsTextSelection':
    'Windows nutzt diese Kombination in Eingabefeldern für die wortweise Auswahl. Alternative: {alternative}.',

  'error.dnsFailed': 'Der Server für {host} wurde nicht gefunden.',
  'error.offline': 'Keine Netzwerkverbindung.',
  'error.certificate': 'Das Zertifikat für {host} konnte nicht überprüft werden.',
  'error.blocked': '{app} hat diese Anfrage blockiert.',
  'error.httpsOnly': '{host} bietet keine verschlüsselte Verbindung an.',
  'error.httpsOnly.continue': 'Unverschlüsselt fortfahren',
  'error.httpsOnly.back': 'Zurück'
} as const satisfies Catalog

export const catalogs: Readonly<Record<Locale, Catalog>> = { de, en }

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * Resolves a message and substitutes `{name}` placeholders. Falls back to the
 * key itself rather than an empty string: a visible key in the UI is a bug
 * report, an empty label is a mystery.
 */
/**
 * Fills `{placeholders}` in a message.
 *
 * `{app}` is always available, without any caller passing it. The product name appears inside
 * a dozen translated sentences, and a literal in each of them would mean the rename had to
 * touch prose in two languages — where a search-and-replace also hits the word in sentences
 * that were never about the product. See `shared/product.ts`.
 *
 * Exported because the renderers interpolate catalogues they received over IPC rather than the
 * bundled ones, and there must be exactly one set of rules for what a placeholder means.
 */
export function interpolate(
  template: string,
  params?: Readonly<Record<string, string | number>>
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (name === 'app') return PRODUCT_NAME
    const value = params?.[name]
    return value === undefined ? match : String(value)
  })
}

export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>
): string {
  // No fallback chain: `Catalog` is a total record over `MessageKey`, and the
  // compiler enforces that every locale covers every key. A `??` here would be
  // dead code pretending to be a safety net.
  return interpolate(catalogs[locale][key], params)
}

/** Picks the closest supported locale for an OS locale string like `de-AT`. */
export function resolveLocale(candidate: string | undefined): Locale {
  if (!candidate) return DEFAULT_LOCALE
  const lower = candidate.toLowerCase()
  for (const locale of LOCALES) {
    if (lower === locale || lower.startsWith(`${locale}-`)) return locale
  }
  return DEFAULT_LOCALE
}
