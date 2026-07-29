/**
 * English messages — the reference locale.
 *
 * Adding a key: here first, then in every `catalog.<locale>.ts`. English first because
 * `MessageKey` is read off this literal, so a key that is not here does not exist at all,
 * while a key that is here and nowhere else is a compile error in the translation. Keep the
 * namespace blocks and their order: the translations repeat them, and comparing two locales
 * is only possible for as long as they line up.
 *
 * `MessageKey` and `Catalog` are declared here, beside the literal they are derived from,
 * rather than next to `catalogs` in `catalog.ts` where they are used. The alternative was
 * tried and rejected: it makes every translation file import a type back out of the module
 * that imports the translations. That cycle is type-only, and `verbatimModuleSyntax` erases
 * it — which is what makes it a trap rather than a nuisance, because the first value that
 * ever has to cross the same edge turns a cycle nobody could see into a load-order bug. As
 * written the graph runs one way: translations depend on the reference, `catalog.ts` depends
 * on both, and neither of them points back at `catalog.ts`.
 *
 * The product name is never spelled out below. `{app}` is filled in by `interpolate`, so a
 * rename stays an edit to `shared/product.ts` instead of a search through prose in two
 * languages — where the same search also hits the word in sentences that were never about
 * the product.
 */

export const en = {
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

    Four of these say something no other page in the browser has to. The `protection.*` sentences
    describe how the vault is actually protected on *this* machine, including the part that is
    uncomfortable — the platform key store unwraps for anybody already signed in as this user. A
    manager that did not say so on its own front page would be misrepresenting itself, and
    `revealNotice` exists for the same reason: a password that vanishes after half a minute reads as a
    fault unless the bound is stated.

    They replaced a pair, `protectionNotice` and `unencryptedNotice`, which could only say "encrypted"
    or "not encrypted". Once a master password exists that is not enough to be honest with: key store
    *and* master password is a different guarantee from either alone, and rounding four states up to two
    means claiming the stronger one on a page about credentials.
  */
  'passwords.title': 'Passwords',
  /*
    One sentence per protection level rather than one sentence with a noun interpolated.

    The four are not variations on a theme, so a template would have forced them into one grammar — and
    interpolating a noun into a shared clause is how a translation ends up saying the opposite in German,
    where the surrounding words change with the noun.
  */
  'passwords.protection.keystoreMaster':
    'Protected twice: by a key your operating system keeps, and by your master password. Opening this vault needs both.',
  'passwords.protection.master':
    'Protected by your master password alone — this machine offered no key store. That password is the only thing between this folder and your credentials.',
  'passwords.protection.keystore':
    'Encrypted with a key your operating system keeps. Anyone already signed in as you can read these. Set a master password to change that.',
  'passwords.protection.plain':
    'Not protected. There was no system key store, and no master password is set, so the key sits beside the file it protects.',

  /*
    The lock.

    `lockedBody` is the sentence under the prompt on the overlay layer rather than on the page, and it
    carries two facts that are not decoration: which keys work, because that field has no caret and
    ignores Tab, and that the browser drew it — the one thing distinguishing this prompt from a page
    imitating it, which is the attack a master-password field invites.
  */
  'passwords.lockedTitle': 'The vault is locked',
  'passwords.lockedBody':
    'The browser draws this field itself, so no page can read it. Return continues, Escape cancels.',
  'passwords.masterPassword': 'Master password',
  'passwords.unlock': 'Unlock',
  'passwords.unlockFailed': 'That was not the master password.',
  'passwords.unreadableTitle': 'This vault cannot be opened',
  /** No master password helps here, so the sentence must not suggest trying one. */
  'passwords.unreadableBody':
    'The key file is damaged, or the system key store that wrapped it is gone. No master password can open it. You can save a copy and start a new vault.',
  'passwords.lockNow': 'Lock now',
  'passwords.idleNotice':
    'The vault locks itself after {minutes} minutes without use, when you lock it, and when the last window closes.',

  /*
    The master password.

    `masterPasswordWarning` is shown while a new one is being chosen, and it says the thing nobody wants
    to read at that moment: there is no recovery. Saying it later would be saying it too late.
  */
  'passwords.masterPasswordTitle': 'Master password',
  'passwords.setMasterPassword': 'Set a master password',
  'passwords.changeMasterPassword': 'Change the master password',
  'passwords.removeMasterPassword': 'Remove the master password',
  'passwords.currentMasterPassword': 'Current master password',
  'passwords.newMasterPassword': 'New master password',
  'passwords.confirmMasterPassword': 'The new master password again',
  'passwords.masterPasswordMismatch': 'The two did not match. Choose it again.',
  'passwords.masterPasswordTooShort': 'At least {min} characters.',
  'passwords.masterPasswordTooLong': 'That is too long to be a password.',
  'passwords.masterPasswordWarning':
    'At least {min} characters, and length matters far more than symbols do. Nothing can recover it: forget it and the saved passwords are gone.',
  'passwords.masterPasswordSet': 'Master password set',
  'passwords.masterPasswordChanged': 'Master password changed',
  'passwords.masterPasswordRemoved':
    'Master password removed. The vault now opens without asking anybody.',

  /*
    Importing an exported CSV.

    `importDeleteFile` is the important one and the easiest to leave out: the biggest exposure an import
    creates is not in the vault but the plain-text file of every password the user owns, now sitting in
    their downloads folder. This browser will not delete somebody else's file behind their back, so it
    names it and says so.
  */
  'passwords.import': 'Import from a file…',
  'passwords.importTitle': 'Import',
  'passwords.importUnreadable': 'That file could not be read.',
  'passwords.importLocked': 'Unlock the vault before importing.',
  'passwords.importRefusedColumns':
    'That does not look like an exported password file: no address column, or no password column.',
  'passwords.importRefusedEmpty': 'There was nothing in that file.',
  'passwords.importRefusedTooLarge': 'That file is too large to be a password export.',
  'passwords.importRefusedTooManyRows': 'That file has more rows than an export should.',
  'passwords.importSummary': '{imported} imported, {skipped} skipped',
  'passwords.importDuplicates': '{count} were already stored, unchanged',
  /** The only number in the report worth acting on; see `main/passwords/import.ts`. */
  'passwords.importConflicts':
    '{count} are stored here with a different password. The stored one was kept.',
  'passwords.importFull': '{count} did not fit and were not imported.',
  'passwords.importNotesDropped': '{count} notes were not imported.',
  'passwords.importDeleteFile':
    'That file holds every one of these passwords as readable text. Delete it: {path}',

  /*
    Destroying the vault.

    `resetVaultConfirm` is a native dialogue message and has to do two jobs in one breath — say what is
    about to be lost, and say that the copy on offer is worth keeping *and* unreadable without the
    password that was just forgotten. It names its own buttons, because a message box gives them no
    other explanation.
  */
  'passwords.resetVault': 'Delete all saved passwords',
  'passwords.resetVaultConfirm':
    'This deletes every saved password and starts an empty vault. Save keeps a copy of the sealed files where you choose — unreadable without the master password, and only on this computer if the system key store wrapped it, but if the password comes back so do the credentials. Delete all saved passwords discards them now.',
  'passwords.resetVaultDone': 'The vault was deleted. A new, empty one has been started.',
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

  /*
    Updates.

    Every sentence here names what state the user's own copy is in, because that is the fact they are
    actually asking about — and the failures say it explicitly ("unchanged"), since a person who has
    just been told something went wrong will otherwise wonder whether it went wrong halfway.
  */
  'updates.checkNow': 'Check for Updates…',
  'updates.offerTitle': 'A new version is available',
  'updates.offerMessage': 'Version {version} has been published. This copy is {current}.',
  'updates.offerDetail':
    'Nothing is downloaded until you agree, and nothing is installed until you restart. The file comes from GitHub.',
  'updates.download': 'Download',
  'updates.notNow': 'Not now',
  'updates.openReleasePage': 'Open the release page',
  'updates.macNotSignedDetail':
    'macOS refuses to replace an application Apple has not signed, and this build is not signed. The release page has the file to install by hand.',
  'updates.readyTitle': 'The update is ready',
  'updates.readyMessage':
    'Version {version} has been downloaded. It is installed while {app} restarts; nothing changes until you choose to.',
  'updates.restartNow': 'Restart now',
  'updates.later': 'Later',
  'updates.upToDateTitle': 'No new version',
  'updates.upToDateMessage': 'This copy is {current}, and nothing newer has been published.',
  'updates.nothingPublishedMessage':
    'No version has been published yet, so there is nothing newer than this copy.',
  'updates.checkFailedTitle': 'The check could not be completed',
  'updates.checkFailedMessage':
    'GitHub could not be reached, so there is nothing to report. This copy is unchanged; you can try again later.',
  'updates.downloadFailedTitle': 'The download could not be completed',
  'updates.downloadFailedMessage':
    'Nothing was installed and this copy is unchanged. You can try again, or fetch the file from the release page.',
  'updates.noFeedTitle': 'This copy cannot update itself',
  'updates.noFeedMessage':
    'It was not installed from a release, so there is nothing to replace. Build it again to update it.',
  'updates.ok': 'OK',

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
export type Catalog = Readonly<Record<MessageKey, string>>
