import type { Locale } from '../i18n/catalog.js'
import { DOWNLOAD_REFUSALS, MANIFEST_FAILURES } from './model.js'
import type { DownloadRefusal, ManifestFailure } from './model.js'

/**
 * The sentences behind the refusal codes.
 *
 * ## Why the media feature carries its own catalogue fragment
 *
 * Every refusal in `DOWNLOAD_REFUSALS` exists because the interface has to be able
 * to *explain* a decision — that is the whole reason the list distinguishes "this is
 * encrypted" from "this needs a converter we do not ship" instead of collapsing both
 * into `unsupported`. A code reaching the user undoes that: `separate-audio-track`
 * in a dialogue is not an explanation, it is a leak of an identifier.
 *
 * The keys are *derived* from the enumerations rather than listed beside them:
 * `MediaMessageKey` is a template-literal type over `DownloadRefusal` and
 * `ManifestFailure`, and the tables below `satisfies Record<MediaMessageKey, string>`.
 * A refusal added to the model with nothing written for it is therefore a type error
 * here, in both languages, rather than a key a user discovers as raw text on screen.
 * That is the property a hand-maintained mapping table cannot give: two lists that
 * have to be kept the same length by whoever remembers.
 *
 * ## Why these live here and not only in `i18n/catalog.ts`
 *
 * They belong in the catalogue and are meant to be spread into it — `en` and `de`
 * below are object literals with literal keys precisely so that
 * `const en = { ...MEDIA_MESSAGES_EN, … } as const` keeps `MessageKey` a union of
 * literals. Writing them out here as well as there would be two copies of the same
 * prose; deriving the catalogue from these keeps one.
 *
 * ## No placeholders
 *
 * Deliberately none, not even `{app}`. These sentences are resolved two ways — by
 * the core through `refusalSentence` below, and by a renderer through the catalogue
 * it fetched over IPC, which interpolates. A placeholder would come out filled on
 * one path and literal on the other, so a test asserts there are none.
 */

/**
 * The panel's own labels.
 *
 * Here beside the refusals rather than only in the catalogue, and for a reason that is
 * about the shape of the feature rather than about convenience: a refusal sentence and the
 * button that provoked it are read in the same breath, and prose that has to agree reads
 * better when it is written in one place. The catalogue is composed from this file, so
 * there is still exactly one copy of each sentence.
 */
const MEDIA_UI_KEYS = [
  'media.panel.title',
  'media.panel.close',
  'media.panel.empty',
  /** The honest boundary, stated before the user tries: not everything can be saved. */
  'media.panel.notice',
  'media.panel.qualities',
  'media.panel.quality',
  /** The default choice: the best variant that can actually be assembled. */
  'media.panel.qualityAuto',
  'media.panel.download',
  'media.panel.cancel',
  'media.panel.downloading',
  'media.panel.saved',
  'media.panel.live',
  'media.panel.protected'
] as const

export type MediaMessageKey =
  | `media.refusal.${DownloadRefusal}`
  | `media.manifest.${ManifestFailure}`
  | (typeof MEDIA_UI_KEYS)[number]

export const MEDIA_MESSAGES_EN = {
  'media.refusal.drm-protected':
    'This stream is encrypted. Removing copy protection is not part of this browser, so a download could only produce a file that will not play.',
  'media.refusal.live-stream': 'This is a live stream. There is no end to download up to.',
  'media.refusal.separate-audio-track':
    'This quality carries the picture without its sound. Joining the two needs a converter this browser does not ship.',
  'media.refusal.dash-needs-muxer':
    'This stream keeps picture and sound in separate tracks. Joining them needs a converter this browser does not ship.',
  'media.refusal.segments-not-concatenable':
    'The pieces of this stream are complete files rather than fragments. Joined together they would produce something no player reads past the first piece.',
  'media.refusal.manifest-unavailable': 'The playlist for this stream could not be read.',
  'media.refusal.unsupported-scheme':
    'This media was assembled inside the page, so there is no address to request it from again.',
  'media.refusal.segment-unavailable':
    'A piece of this stream could not be retrieved, and a file with a gap in it is not a download.',
  'media.refusal.too-large': 'This download is past the size limit.',
  'media.refusal.cancelled': 'Download stopped.',
  'media.refusal.write-failed': 'The file could not be written.',

  'media.manifest.unreachable': 'The playlist could not be retrieved.',
  'media.manifest.not-a-manifest': 'That address answered with something that is not a playlist.',
  'media.manifest.no-variants': 'The playlist lists neither qualities nor pieces.',
  'media.manifest.too-large': 'The playlist is larger than a playlist has any business being.',

  'media.panel.title': 'Media on this page',
  'media.panel.close': 'Close media',
  'media.panel.empty': 'This page is not playing anything this browser recognises.',
  'media.panel.notice':
    'What can be saved is what can be copied without re-encoding. Encrypted streams, live streams and qualities whose sound is a separate track are refused with a reason rather than saved half-finished.',
  'media.panel.qualities': 'Show qualities',
  'media.panel.quality': 'Quality',
  'media.panel.qualityAuto': 'Best that can be saved',
  'media.panel.download': 'Save',
  'media.panel.cancel': 'Stop',
  'media.panel.downloading': 'Saving…',
  'media.panel.saved': 'Saved to',
  'media.panel.live': 'Live',
  'media.panel.protected': 'Encrypted'
} as const satisfies Record<MediaMessageKey, string>

export const MEDIA_MESSAGES_DE = {
  'media.refusal.drm-protected':
    'Dieser Stream ist verschlüsselt. Kopierschutz zu entfernen gehört nicht zu diesem Browser, ein Download könnte also nur eine Datei erzeugen, die sich nicht abspielen lässt.',
  'media.refusal.live-stream':
    'Das ist ein Live-Stream. Es gibt kein Ende, bis zu dem heruntergeladen werden könnte.',
  'media.refusal.separate-audio-track':
    'Diese Qualität enthält das Bild ohne den Ton. Beides zusammenzuführen braucht einen Konverter, den dieser Browser nicht mitbringt.',
  'media.refusal.dash-needs-muxer':
    'Dieser Stream hält Bild und Ton in getrennten Spuren. Sie zusammenzuführen braucht einen Konverter, den dieser Browser nicht mitbringt.',
  'media.refusal.segments-not-concatenable':
    'Die Teile dieses Streams sind vollständige Dateien und keine Fragmente. Aneinandergehängt entstünde etwas, das kein Player über den ersten Teil hinaus liest.',
  'media.refusal.manifest-unavailable':
    'Die Wiedergabeliste dieses Streams konnte nicht gelesen werden.',
  'media.refusal.unsupported-scheme':
    'Dieses Medium wurde in der Seite selbst zusammengesetzt, es gibt also keine Adresse, von der es erneut abgerufen werden könnte.',
  'media.refusal.segment-unavailable':
    'Ein Teil dieses Streams konnte nicht geladen werden, und eine Datei mit einer Lücke ist kein Download.',
  'media.refusal.too-large': 'Dieser Download liegt über der Größengrenze.',
  'media.refusal.cancelled': 'Download abgebrochen.',
  'media.refusal.write-failed': 'Die Datei konnte nicht geschrieben werden.',

  'media.manifest.unreachable': 'Die Wiedergabeliste konnte nicht geladen werden.',
  'media.manifest.not-a-manifest':
    'Diese Adresse hat mit etwas geantwortet, das keine Wiedergabeliste ist.',
  'media.manifest.no-variants': 'Die Wiedergabeliste nennt weder Qualitäten noch Teile.',
  'media.manifest.too-large':
    'Die Wiedergabeliste ist größer, als eine Wiedergabeliste sein sollte.',

  'media.panel.title': 'Medien auf dieser Seite',
  'media.panel.close': 'Medien schließen',
  'media.panel.empty': 'Diese Seite spielt nichts ab, was dieser Browser erkennt.',
  'media.panel.notice':
    'Gespeichert werden kann, was sich ohne Neukodierung kopieren lässt. Verschlüsselte Streams, Live-Streams und Qualitäten, deren Ton eine eigene Spur ist, werden mit Begründung abgelehnt statt halb fertig gespeichert.',
  'media.panel.qualities': 'Qualitäten anzeigen',
  'media.panel.quality': 'Qualität',
  'media.panel.qualityAuto': 'Beste speicherbare',
  'media.panel.download': 'Speichern',
  'media.panel.cancel': 'Anhalten',
  'media.panel.downloading': 'Wird gespeichert…',
  'media.panel.saved': 'Gespeichert unter',
  'media.panel.live': 'Live',
  'media.panel.protected': 'Verschlüsselt'
} as const satisfies Record<MediaMessageKey, string>

const MEDIA_MESSAGES: Readonly<Record<Locale, Readonly<Record<MediaMessageKey, string>>>> = {
  en: MEDIA_MESSAGES_EN,
  de: MEDIA_MESSAGES_DE
}

/**
 * One sentence, in one language.
 *
 * Total by construction: both tables are complete records over `MediaMessageKey`, so
 * there is no missing-key branch to fall back from — which is the point of deriving
 * the keys from the enumerations in the first place.
 */
export function mediaMessage(locale: Locale, key: MediaMessageKey): string {
  return MEDIA_MESSAGES[locale][key]
}

/** Why a download cannot be produced, in words the user can act on. */
export function refusalSentence(locale: Locale, refusal: DownloadRefusal): string {
  return mediaMessage(locale, `media.refusal.${refusal}`)
}

/** Why a manifest could not be described. */
export function manifestFailureSentence(locale: Locale, failure: ManifestFailure): string {
  return mediaMessage(locale, `media.manifest.${failure}`)
}

/**
 * Every key these sentences are filed under.
 *
 * Built from the enumerations rather than from the tables, so it is the same
 * derivation the type uses. Exported for the test that checks the catalogue carries
 * all of them.
 */
export function mediaMessageKeys(): readonly MediaMessageKey[] {
  return [
    ...DOWNLOAD_REFUSALS.map((refusal): MediaMessageKey => `media.refusal.${refusal}`),
    ...MANIFEST_FAILURES.map((failure): MediaMessageKey => `media.manifest.${failure}`),
    ...MEDIA_UI_KEYS
  ]
}
