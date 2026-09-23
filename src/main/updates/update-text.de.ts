import type { UpdateText } from './update-text.en.js'

/**
 * The German half of the update check's message boxes.
 *
 * `satisfies UpdateText` holds this literal to the English keys: a sentence missing here, or one
 * English no longer has, does not compile. Key order follows `update-text.en.ts`, which the
 * compiler does not care about and a reviewer diffing the two files does.
 *
 * Where the English sentence names a placeholder such as {version}, the German one has to name it
 * too — `tests/update-text.test.ts` compares the sets, because the compiler cannot.
 */
export const de = {
  offerTitle: 'Eine neue Version ist verfügbar',
  offerMessage: 'Version {version} ist veröffentlicht. Diese Kopie ist {current}.',
  offerDetail:
    'Nichts wird ohne dein Ja heruntergeladen und nichts ohne Neustart installiert. Die Datei kommt von GitHub.',
  download: 'Herunterladen',
  notNow: 'Jetzt nicht',
  openReleasePage: 'Release-Seite öffnen',
  macNotSignedDetail:
    'macOS ersetzt keine Anwendung, die Apple nicht signiert hat, und dieser Build ist nicht signiert. Auf der Release-Seite liegt die Datei zum Installieren von Hand.',
  windowsNotSignedDetail:
    'Nicht signiert: von Hand über die Release-Seite installieren. SmartScreen warnt; „Weitere Informationen“, dann „Trotzdem ausführen“.',
  linuxNotSignedDetail: 'Nicht signiert: das AppImage von der Release-Seite laden.',
  readyTitle: 'Das Update ist bereit',
  readyMessage:
    'Version {version} wurde heruntergeladen. Installiert wird beim Neustart von {app}; bis dahin ändert sich nichts.',
  restartNow: 'Jetzt neu starten',
  later: 'Später',
  upToDateTitle: 'Keine neue Version',
  upToDateMessage: 'Diese Kopie ist {current}; Neueres ist nicht veröffentlicht.',
  nothingPublishedMessage:
    'Es ist noch keine Version veröffentlicht, also gibt es nichts Neueres als diese Kopie.',
  checkFailedTitle: 'Die Suche konnte nicht abgeschlossen werden',
  checkFailedMessage:
    'GitHub war nicht erreichbar, es gibt also nichts zu berichten. Diese Kopie ist unverändert; du kannst es später erneut versuchen.',
  downloadFailedTitle: 'Der Download konnte nicht abgeschlossen werden',
  downloadFailedMessage:
    'Es wurde nichts installiert und diese Kopie ist unverändert. Du kannst es erneut versuchen oder die Datei von der Release-Seite holen.',
  noFeedTitle: 'Diese Kopie kann sich nicht selbst aktualisieren',
  noFeedMessage:
    'Sie wurde nicht aus einem Release installiert, es gibt also nichts zu ersetzen. Neu bauen aktualisiert sie.',
  ok: 'OK'
} as const satisfies UpdateText
