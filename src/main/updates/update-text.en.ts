/**
 * What the update check says in its message boxes. English, and the reference table.
 *
 * `update-text.de.ts` is checked against these keys with `satisfies UpdateText`, so a German
 * file that misses a sentence or keeps one this file dropped does not compile — the same
 * arrangement as `catalog.en.ts` and `catalog.de.ts`, for the same reason.
 *
 * See `update-text.ts` for why these sentences are here in the core and not in
 * `shared/i18n/catalog.*`.
 *
 * Every sentence here names what state the user's own copy is in, because that is the fact they
 * are actually asking about — and the failures say it explicitly ("unchanged"), since a person
 * who has just been told something went wrong will otherwise wonder whether it went wrong
 * halfway.
 */
export const en = {
  offerTitle: 'A new version is available',
  offerMessage: 'Version {version} has been published. This copy is {current}.',
  offerDetail:
    'Nothing is downloaded until you agree, and nothing is installed until you restart. The file comes from GitHub.',
  download: 'Download',
  notNow: 'Not now',
  openReleasePage: 'Open the release page',
  macNotSignedDetail:
    'macOS refuses to replace an application Apple has not signed, and this build is not signed. The release page has the file to install by hand.',
  windowsNotSignedDetail:
    'Unsigned build: install it by hand from the release page. SmartScreen warns; choose “More info”, then “Run anyway”.',
  linuxNotSignedDetail: 'Unsigned build: download the AppImage from the release page.',
  readyTitle: 'The update is ready',
  readyMessage:
    'Version {version} has been downloaded. It is installed while {app} restarts; nothing changes until you choose to.',
  restartNow: 'Restart now',
  later: 'Later',
  upToDateTitle: 'No new version',
  upToDateMessage: 'This copy is {current}, and nothing newer has been published.',
  nothingPublishedMessage:
    'No version has been published yet, so there is nothing newer than this copy.',
  checkFailedTitle: 'The check could not be completed',
  checkFailedMessage:
    'GitHub could not be reached, so there is nothing to report. This copy is unchanged; you can try again later.',
  downloadFailedTitle: 'The download could not be completed',
  downloadFailedMessage:
    'Nothing was installed and this copy is unchanged. You can try again, or fetch the file from the release page.',
  noFeedTitle: 'This copy cannot update itself',
  noFeedMessage:
    'It was not installed from a release, so there is nothing to replace. Build it again to update it.',
  ok: 'OK'
} as const satisfies Record<string, string>

export type UpdateTextKey = keyof typeof en

/** Every locale must cover exactly the reference keys. */
export type UpdateText = Readonly<Record<UpdateTextKey, string>>
