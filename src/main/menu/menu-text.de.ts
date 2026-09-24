import type { MenuText } from './menu-text.en.js'

/**
 * The German half of the native menus.
 *
 * `satisfies MenuText` holds this literal to the English keys: a label missing here, or one English
 * no longer has, does not compile. Key order follows `menu-text.en.ts`, which the compiler does not
 * care about and a reviewer diffing the two files does.
 *
 * Where the English label names a placeholder such as {count}, the German one has to name it too —
 * `tests/menu-text.test.ts` compares the sets, because the compiler cannot.
 */
export const de = {
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
  'menu.split.tileLeft': 'Kachel links aktivieren',
  'menu.split.tileRight': 'Kachel rechts aktivieren',
  'menu.split.tileUp': 'Kachel oben aktivieren',
  'menu.split.tileDown': 'Kachel unten aktivieren',
  'menu.split.maximizeTile': 'Kachel maximieren',

  'menu.tools': 'Werkzeuge',
  'menu.tools.passwords': 'Passwörter',
  'menu.tools.extensionsTab': 'Erweiterungen im Tab',
  'menu.tools.clearData': 'Browserdaten löschen…',
  'menu.tools.panic': 'Alles löschen und beenden',

  'menu.window.minimize': 'Minimieren',
  'menu.window.zoom': 'Zoomen',
  'menu.window.nextTab': 'Nächster Tab',
  'menu.window.previousTab': 'Vorheriger Tab',

  'menu.help': 'Hilfe',
  'menu.help.about': 'Über {app}',

  'blocker.blockedOnPage': '{count} Anfragen auf dieser Seite blockiert',
  'blocker.myRules': 'Meine Regeln ({count})',
  'blocker.updateLists': 'Filterlisten jetzt aktualisieren',
  'blocker.enabled': 'Blockieren aktiv',
  'blocker.enabledOnSite': 'Auf dieser Seite blockieren',
  'blocker.nothingBlockedYet': 'Auf dieser Seite nichts blockiert',
  'blocker.noRules': 'Noch keine eigenen Regeln',
  'blocker.openSettings': 'In den Einstellungen verwalten…',
  'blocker.forgetSiteRules': 'Meine Regeln für diese Seite löschen ({count})',

  'unload.closeTab': 'Tab schließen?',
  'unload.leavePage': 'Seite verlassen?',
  'unload.detail': 'Änderungen auf {site} werden möglicherweise nicht gespeichert.',
  'unload.leave': 'Verlassen',
  'unload.stay': 'Bleiben',

  'bookmarks.readOnly.message': 'Diese Seite konnte nicht als Lesezeichen gespeichert werden',
  'bookmarks.readOnly.detail':
    'Die Lesezeichen-Datei stammt von einer neueren Version von {app}, deshalb liest diese Version sie nur. Es wurde nichts geändert.',
  'bookmarks.readOnly.ok': 'OK',
  'clearData.message': 'Browserdaten jetzt löschen?',
  'clearData.detail':
    '„Alles löschen“ löscht den Verlauf (mit Seitenbildern und Symbolen), die Downloads-Liste, Cookies (mit Netzwerkspuren, HTTPS-Ausnahmen und Medienfunden), den Seitenspeicher und den Cache. Heruntergeladene Dateien bleiben, wo sie sind.',
  'clearData.detailPrivate':
    'Gelöscht werden nur die Daten dieses privaten Fensters; die normalen Fenster bleiben unberührt. Heruntergeladene Dateien bleiben, wo sie sind.',
  'clearData.everything': 'Alles löschen',
  'clearData.keepHistory': 'Verlauf und Downloads-Liste behalten',
  'clearData.cacheOnly': 'Nur den Cache',
  'clearData.cancel': 'Abbrechen',
  'panic.message': 'Alle Browsing-Spuren löschen und {app} beenden?',
  'panic.detail':
    'Verlauf, Downloads-Liste, Cookies, Seitenspeicher, Cache, alle offenen Tabs und die Website-Berechtigungen werden gelöscht, und der nächste Start stellt keine Tabs wieder her. Lesezeichen, Passwörter, Quick Links und Einstellungen bleiben, ebenso heruntergeladene Dateien.',
  'panic.confirm': 'Löschen und beenden',
  'panic.cancel': 'Abbrechen'
} as const satisfies MenuText
