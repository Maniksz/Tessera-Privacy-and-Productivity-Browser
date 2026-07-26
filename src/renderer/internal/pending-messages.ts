import { DEFAULT_LOCALE, interpolate, type Locale } from '@shared/i18n/catalog.js'

/**
 * Messages for the two new pages, until they are in the catalogue.
 *
 * ## Why they are here and not in `shared/i18n/catalog.ts`
 *
 * Spec 7 is clear that every user-visible string lives in the catalogue, and these belong
 * there. They are staged here because the catalogue is being edited by other work in flight
 * and this feature must not collide with it — not because a second catalogue is a good idea.
 *
 * The shape is chosen so that the move is a copy and nothing more: the `en` and `de` records
 * below are exactly what `catalog.ts` expects, key for key. Once they are in it, this module
 * goes and `tp(` becomes `t(` in the two pages. Nothing else changes, because `translate`'s
 * placeholder rules are reused rather than reimplemented — `interpolate` is imported from the
 * catalogue, so `{app}` and every other placeholder already means the same thing here as in
 * the core.
 *
 * ## Why the pages do not simply render keys
 *
 * A page that shows `bookmarks.title` where a heading belongs is a page nobody can test and
 * nobody would ship. Component tests assert on the words a user reads, which is the only
 * assertion that catches a label attached to the wrong control.
 */

const bookmarksEn = {
  'bookmarks.title': 'Bookmarks',
  'bookmarks.searchPlaceholder': 'Search bookmarks',
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
  'bookmarks.removeFolderConfirm':
    'Remove “{title}” and the {count} items inside it? This cannot be undone.',
  'bookmarks.removedCount': '{count} entries removed',
  'bookmarks.moveUp': 'Move {title} up',
  'bookmarks.moveDown': 'Move {title} down',
  'bookmarks.moveToBar': 'Move {title} to the bookmarks bar',
  'bookmarks.moveToOther': 'Move {title} to other bookmarks',
  'bookmarks.import': 'Import from a file…',
  'bookmarks.importedFolder': 'Imported bookmarks',
  'bookmarks.importResult': '{imported} imported, {skipped} skipped',
  'bookmarks.dialogTitle': 'Edit bookmark',
  'bookmarks.dialogFolderTitle': 'Rename folder',
  'bookmarks.name': 'Name',
  'bookmarks.address': 'Address',
  'bookmarks.addressInvalid': 'That is not an address. Enter a domain or a full URL.',
  'bookmarks.save': 'Save',
  'bookmarks.cancel': 'Cancel'
} as const satisfies Record<string, string>

const bookmarksDe = {
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
  'bookmarks.addressInvalid': 'Das ist keine Adresse. Gib eine Domain oder eine vollständige URL ein.',
  'bookmarks.save': 'Speichern',
  'bookmarks.cancel': 'Abbrechen'
} as const satisfies Record<keyof typeof bookmarksEn, string>

const downloadsEn = {
  'downloads.title': 'Downloads',
  'downloads.empty': 'Nothing downloaded yet.',
  'downloads.privateNotice': 'A private window records no downloads.',
  'downloads.state.progressing': 'Downloading',
  'downloads.state.paused': 'Paused',
  'downloads.state.completed': 'Finished',
  'downloads.state.cancelled': 'Cancelled',
  'downloads.state.interrupted': 'Failed',
  'downloads.progress': '{received} of {total}',
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
  'downloads.fileMissing': 'The file was moved or deleted.',
  'downloads.openFailed': 'That file is no longer there.',
  'downloads.cannotResume': 'This download cannot be resumed and would start again from the beginning.',
  'downloads.reason': 'Reason: {reason}',
  'downloads.byteSize': '{value} {unit}'
} as const satisfies Record<string, string>

const downloadsDe = {
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
  'downloads.cannotResume': 'Dieser Download lässt sich nicht fortsetzen und würde von vorn beginnen.',
  'downloads.reason': 'Grund: {reason}',
  'downloads.byteSize': '{value} {unit}'
} as const satisfies Record<keyof typeof downloadsEn, string>

export const BOOKMARK_MESSAGES: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en: bookmarksEn,
  de: bookmarksDe
}

export const DOWNLOAD_MESSAGES: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en: downloadsEn,
  de: downloadsDe
}

export type BookmarkMessageKey = keyof typeof bookmarksEn
export type DownloadMessageKey = keyof typeof downloadsEn

/**
 * A translator over one of the staged catalogues.
 *
 * Falls back to the reference locale rather than to the key: an untranslated string is the
 * wrong language for a moment, a visible key is a bug report. The same choice
 * `useInternalI18n` makes.
 */
/*
  `K` appears once, which the linter flags. It is kept because it is what makes a page's own key union the type of
  its translator: without it every call site accepts any string and a typo in a key becomes a runtime blank.
*/
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function pendingTranslator<K extends string>(
  locale: Locale,
  messages: Readonly<Record<Locale, Readonly<Record<string, string>>>>
): (key: K, params?: Record<string, string | number>) => string {
  return (key, params) =>
    interpolate(messages[locale][key] ?? messages[DEFAULT_LOCALE][key] ?? key, params)
}
