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
  'blocker.forgetSiteRules': 'Meine Regeln für diese Seite löschen ({count})'
} as const satisfies MenuText
