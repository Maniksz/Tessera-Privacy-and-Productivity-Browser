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

  /*
    `tessera://about`, which is served without a bridge and so reads these from the bundled catalogue.
    `{version}` and `{licence}` are the build constants from `package.json`; the licence is its SPDX
    identifier, which is not translated.
  */
  'about.title': 'About {app}',
  'about.version': 'Version {version}',
  'about.licence': 'Free software under the {licence} licence.',

  /*
    Menu labels that a renderer draws as well.

    The native menus are built by the core, and their own labels live in `main/menu/menu-text.*`, so
    no renderer downloads them. The ones below stay because a renderer shows them too: the tile bar's
    zoom buttons, the downloads panel's button to the full list, the tab strip's accessible name, and
    the layout names `shared/split/labels.ts` hands to the layout button and its menu as well as to
    the Split View menu. A `menu.*` key that no renderer or shared module reads belongs in
    `menu-text.*`, not here.
  */
  'menu.view.zoomIn': 'Zoom In',
  'menu.view.zoomOut': 'Zoom Out',
  'menu.view.zoomReset': 'Reset Zoom',

  'menu.split.layout1': 'Single Tile',
  'menu.split.layout2Columns': 'Two Columns',
  'menu.split.layout3Columns': 'Three Columns',
  'menu.split.layout4Columns': 'Four Columns',
  'menu.split.layout2Rows': 'Two Rows',
  'menu.split.layout3': 'One Large, Two Small',
  'menu.split.layout4': 'Four Tiles',

  'menu.tools.downloads': 'Downloads',

  'menu.window': 'Window',

  // toolbar
  'toolbar.back': 'Back',
  'toolbar.forward': 'Forward',
  'toolbar.reload': 'Reload',
  'toolbar.stop': 'Stop loading',
  'toolbar.home': 'Home',
  'toolbar.layout': 'Split layout: {current}',
  'toolbar.layoutTileCount': '{count} tiles',
  'workspaces.title': 'Workspaces',
  'workspaces.saveAs': 'Save as…',
  'workspaces.name': 'Workspace name',
  'workspaces.replace': 'Replace “{name}”?',
  'workspaces.readOnly': 'Saved by a newer version: read only.',
  'workspaces.remove': 'Remove {name}',
  'toolbar.settings': 'Settings',
  'toolbar.extensions': 'Extensions',
  'toolbar.menu': 'Main menu',
  /*
    The badge's own text, in the catalogue rather than built in the component, because where the space
    before `%` goes is a language's business: German writes `150 %` and English writes `150%`.
  */
  'toolbar.zoomLevel': '{percent}%',
  'toolbar.zoomReset': 'Reset zoom',
  // The download button's name while it has something to say; `{status}` is a `downloads.state.*`.
  'toolbar.downloadsStatus': 'Downloads: {status}',
  'toolbar.downloadsProgress': 'Downloads: {percent}%',
  // The password key. A count, never a name: the key is drawn before anything was pressed.
  'toolbar.autofillLocked': 'Passwords are locked — unlock',
  'toolbar.autofillMatches': 'Fill in a saved password ({count} for this site)',
  'toolbar.autofillNone': 'No password saved for this site',
  // The media button's name and tooltip; the count is the active tab's finds, zero included.
  'toolbar.media': 'Media on this page ({count})',

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
  /*
    The blocker button's label when there is no count to report, which is now most of the time.

    The button used to appear only where something had been blocked, so it had one label and it was a
    number. It is in the address bar on every page now — the element picker and the per-site switch are
    behind it, and a control that only appears once a site has misbehaved is not a control anybody can
    reach for. So it needs a name for the resting state, and the name has to be what the button *is*
    rather than what has happened.
  */
  'omnibox.blocker': 'Content blocker',
  'omnibox.blockerOffHere': 'Not filtering this site',
  'omnibox.blockerOff': 'Blocking is switched off',
  'omnibox.siteSettings': 'Site settings',
  'omnibox.suggestions': 'Suggestions',
  'omnibox.switchToTab': 'Switch to this tab',

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
  'tab.unloaded': 'Unloaded to save memory; loads again when opened',
  // the tab search (U22)
  'tabsearch.title': 'Search tabs',
  'tabsearch.placeholder': 'Title or address',
  'tabsearch.empty': 'No tab matches',
  'tabsearch.close': 'Close tab search',

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
  'split.muted': 'Muted',

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
  'bookmarks.unreadableEntry': 'One bookmark could not be read and is kept unchanged.',
  'bookmarks.unreadableEntries': '{count} bookmarks could not be read and are kept unchanged.',
  'bookmarks.documentNewer':
    'A newer version saved these bookmarks. They are shown here but cannot be changed.',
  'bookmarks.documentInvalid':
    'The bookmarks file could not be read and is kept as bookmarks.json.unreadable. Bookmarks started empty.',
  'bookmarks.documentReadOnly':
    'The bookmarks file could not be backed up, so nothing can be changed until the next start.',

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

    The six are not variations on a theme, so a template would have forced them into one grammar — and
    interpolating a noun into a shared clause is how a translation ends up saying the opposite in German,
    where the surrounding words change with the noun.
  */
  'passwords.protection.keystoreMaster':
    'Protected twice: by a key your operating system keeps, and by your master password. Opening this vault needs both.',
  'passwords.protection.weakKeystoreMaster':
    'The key store on this system is weak (Linux without a keyring). Only your master password protects your credentials.',
  'passwords.protection.master':
    'Protected by your master password alone — this machine offered no key store. That password is the only thing between this folder and your credentials.',
  'passwords.protection.keystore':
    'Encrypted with a key your operating system keeps. Anyone already signed in as you can read these. Set a master password to change that.',
  'passwords.protection.weakKeystore':
    'No real protection. The key store on this system is weak (Linux without a keyring), and no master password is set, so anyone who can read this folder can read your passwords.',
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
  /** Not damage, so the sentence must not suggest starting again: the newer version still opens it. */
  'passwords.keyNewer':
    'A newer version saved the key of this vault. This version cannot open it and leaves it unchanged.',
  'passwords.lockNow': 'Lock now',
  'passwords.idleNotice':
    'The vault locks itself after {minutes} minutes without use, when you lock it, and when the last window closes.',
  'passwords.unreadableEntry':
    '1 entry could not be read. It is kept unchanged and never filled in.',
  'passwords.unreadableEntries':
    '{count} entries could not be read. They are kept unchanged and never filled in.',
  'passwords.documentNewer':
    'A newer version saved this vault. It is shown here but cannot be changed.',
  'passwords.documentInvalid':
    'The vault file could not be read and is kept as passwords.json.unreadable. The vault started empty.',
  'passwords.documentReadOnly':
    'The vault file could not be backed up, so nothing can be changed until the next start.',

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

    The badge's label is the only one of them a screen reader reads and nobody sees: the badge is a
    key, drawn as a path, and this is its name.
  */
  'passwords.fillBadge': 'Fill in a saved password',
  'passwords.savePrompt': 'Save the password for {site}?',
  'passwords.saveUpdatePrompt': 'Update the saved password for {site}?',
  'passwords.saveAction': 'Save',
  'passwords.neverAction': 'Never here',
  'passwords.dismissAction': 'Not now',

  /*
    The account picker the badge in a password field opens (R5, R8).

    Drawn in the chrome rather than in the page, so unlike the six above these strings are rendered
    by a renderer and never travel to a preload — which is also why the refusal wordings can live
    here at all. There are eight of them, they are the longest sentences in this file, and a wordlist
    that size in a bundle parsed before every page is a cost paid on every site the user visits.

    Every one of these is an answer to "I pressed the key and nothing happened". So each says what
    was *not* done and why, in a sentence somebody can act on: not "unavailable", not "no match", and
    never the same wording for two different reasons — "this page is not encrypted" and "this is not
    the site the password was saved for" are different facts about the world and the user can only
    fix one of them.
  */
  'autofill.suggest.label': 'Saved passwords for tile {index}',
  'autofill.suggest.accounts': 'Saved accounts',
  /** Some sites sign in on a password alone; the row still has to be a thing you can point at. */
  'autofill.suggest.noUsername': 'No user name saved',
  'autofill.suggest.locked': 'The vault is locked, so nothing can be filled in yet.',
  'autofill.suggest.empty': 'Nothing is saved for this site.',
  'autofill.suggest.disabled': 'Filling in passwords is switched off in the settings.',
  'autofill.refusal.noUserGesture':
    'Nothing was filled in: that did not come from a key or a click.',
  'autofill.refusal.unsupportedScheme': 'Passwords are never filled in on a page of this kind.',
  'autofill.refusal.insecurePage':
    'This page is not encrypted, so the password was not filled in — anyone on the way could read it.',
  'autofill.refusal.schemeDowngrade':
    'This password was saved for an encrypted page, and this one is not.',
  'autofill.refusal.differentSite': 'This is not the site that password was saved for.',
  'autofill.refusal.crossOriginFrame':
    'This form belongs to another site embedded in this page, so nothing was filled in.',
  'autofill.refusal.crossOriginFormAction':
    'This form sends what you type to another site, so nothing was filled in.',
  'autofill.refusal.noPasswordField': 'There is no password field here to fill in.',

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

  // page context menu
  'page.openLinkInNewTab': 'Open link in new tab',
  'page.copyLinkAddress': 'Copy link address',
  'page.copyImageAddress': 'Copy image address',
  'page.copy': 'Copy',
  'page.searchFor': 'Search for “{text}”',
  'page.blockElement': 'Block element…',
  'page.inspect': 'Inspect',

  /*
    The popup-and-redirect prompt.

    Worded as what the *page* is doing rather than as a request it is making — "wants to open" and not
    "would like permission to open" — because the dialogue is up precisely because nobody asked for this.
    The host is the subject of the sentence, since it is the fact the answer turns on.
  */
  'navigation.wantsToOpen': '{host} wants to open a new tab',
  'navigation.wantsToLeave': 'This page wants to send you to {host}',
  /** Why the dialogue is there at all, in one line. Without it the prompt looks arbitrary. */
  'navigation.noGesture': 'You did not click or press anything to start this.',
  'navigation.open': 'Open the tab',
  'navigation.dontOpen': 'Do not open it',
  'navigation.follow': 'Go there',
  'navigation.stay': 'Stay on this page',
  'navigation.keyboardHint': 'Escape stays where you are',
  // The toggle under a long address, which the dialogue shows cut after its host.
  'navigation.fullAddress': 'Show full address',
  'navigation.lessAddress': 'Show less',

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
  'settings.section.passwords': 'Passwords',
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
  /* The link out of the Passwords section; the vault's contents are a page, not a settings row. */
  'settings.openPasswordManager': 'Manage saved passwords',
  'settings.systemProxyDirect':
    'The system setting sends some addresses directly. With the kill switch on, those are stopped.',
  'settings.on': 'On',
  'settings.off': 'Off',

  /*
    Back up and restore (U23), a section of the settings page. The items reuse the pages' own titles;
    a refusal is one sentence per reason, and a wrong passphrase is one with a damaged file.
  */
  'backup.title': 'Back up and restore',
  'backup.passphrase': 'Passphrase',
  'backup.repeat': 'Repeat passphrase',
  'backup.hint':
    'At least 12 characters. A forgotten passphrase cannot be recovered, and neither can the backup.',
  'backup.mismatch': 'The two passphrases differ.',
  'backup.create': 'Create backup…',
  'backup.saved': 'Backup saved.',
  'backup.vaultIncluded': 'The password vault goes in, still locked by its master password.',
  'backup.vaultNoMasterPassword':
    'Without a master password the password vault stays out of the backup.',
  'backup.vaultUnreadable': 'The password vault cannot be read right now and stays out.',
  'backup.restore': 'Restore…',
  'backup.restorePassphrase': 'Passphrase of the backup',
  'backup.from': 'Backup of {date}, version {version}',
  'backup.userRules': 'Your filter rules',
  'backup.confirm':
    'What is ticked is restored at the next start, after a safety copy of the current data. Permissions, filter rules and security settings stay as they are unless ticked.',
  'backup.securitySettings': 'Security settings that differ',
  'backup.stage': 'Restore at next start',
  'backup.staged': 'The restore runs at the next start.',
  'backup.pending': 'A restore is waiting for the next start.',
  'backup.notABackup': 'This is not a {app} backup.',
  'backup.tooLarge': 'This file is too large to be a backup.',
  'backup.wrongPassphrase': 'Wrong passphrase or damaged file.',
  'backup.newer': 'This backup is from a newer version of {app} and cannot be restored here.',
  'backup.tooShort': 'The passphrase needs at least 12 characters.',
  'backup.failed': 'That did not work. Nothing was changed.',

  /*
    Import from other browsers (U24), a section of the settings page, and the start page's card. The
    browser names are product names and come from the model; passwords come over as a CSV only.
  */
  'import.title': 'Import from other browsers',
  'import.source': 'Browser profile',
  'import.none': 'No Chrome, Edge, Chromium or Firefox profile was found on this computer.',
  'import.bookmarks': 'Import bookmarks',
  'import.history': 'Import history…',
  'import.bookmarksDone': '{imported} imported, {duplicates} already there, {skipped} skipped.',
  'import.historyPreview':
    '{added} entries are added, {merged} merged with yours, {skipped} skipped.',
  'import.historyDropped':
    '{dropped} more do not fit under the history’s limit of 10,000 entries and are left out. Your own history stays complete.',
  'import.historyConfirm': 'Import history',
  'import.historyDone': '{added} entries added, {merged} merged.',
  'import.missing': 'The profile is gone. Is the browser still installed?',
  'import.locked': '{browser} is using the file. Close {browser} and try again.',
  'import.unreadable': 'The file could not be read. For bookmarks, an HTML file works instead.',
  'import.readOnly': 'This data is read-only in this run, so nothing was imported.',
  'import.full': 'The bookmarks are full, so nothing was imported.',
  'import.htmlTitle': 'Bookmarks from an HTML file',
  'import.htmlHint':
    'In Firefox: Bookmarks › Manage bookmarks › Import and Backup › Export Bookmarks to HTML.',
  'import.passwords':
    'Passwords come over as a CSV file only: export them in the other browser, then import the file in the password manager.',
  'start.importOffer': 'Coming from another browser? Take your bookmarks and history with you.',
  'start.importOpen': 'Import…',
  'start.importClose': 'Close',

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

    Only the command is here, because the settings screen renders it as well as the Help menu. What
    the check then says — offers, notices, failures — is drawn in native message boxes by the core
    alone, so it lives in `main/updates/update-text.*` and costs the renderers nothing.
  */
  'updates.checkNow': 'Check for Updates…',

  // errors
  'error.dnsFailed': 'Could not find the server for {host}.',
  'error.offline': 'No network connection.',
  'error.certificate': 'The certificate for {host} could not be verified.',
  'error.blocked': '{app} blocked this request.',
  'error.network': 'Could not load {host}.',
  'error.proxy': 'The proxy server is not responding.',
  'error.crashed': 'This page stopped working.',
  'error.openAnyway': 'Open anyway',
  'error.killSwitch':
    'The kill switch stopped this page: the system setting allows a direct route.',
  'error.networkSettings': 'Network settings',
  'error.httpsOnly': '{host} does not offer an encrypted connection.',
  'error.httpsOnly.tryHttps': 'Try HTTPS',
  'error.httpsOnly.continue': 'Continue unencrypted',
  'error.httpsOnly.back': 'Go back',
  'error.httpsOnly.noTarget': 'This page was opened without an address to go to.'
} as const satisfies Record<string, string>

export type MessageKey = keyof typeof en

/** Every locale must cover exactly the reference keys. */
export type Catalog = Readonly<Record<MessageKey, string>>
