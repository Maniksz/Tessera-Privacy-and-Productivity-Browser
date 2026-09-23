/**
 * How a download is shown.
 *
 * Extracted from the page so it can be tested, the same split `history/presentation.ts`
 * makes. Zod-free and DOM-free: the page imports it at runtime.
 *
 * ## Why the words live here and not in the page
 *
 * Two surfaces show a download row: `tessera://downloads` and the toolbar's downloads panel.
 * The product decision is that they say the same thing — the same state names, the same
 * "1.2 MB of 5 MB" — and two copies of a formatting rule agree only until one of them is
 * fixed. So the state-to-key map and the size and progress text are here, once, and each
 * surface hands in its own translator: the page's staged one and the chrome UI's `t()` both
 * cover the keys in `DownloadTextKey`, because the staged copy and the bundled catalogue are
 * word for word the same for `downloads.*`.
 */

import type { DownloadRecord, DownloadState } from './model.js'

/** Units in ascending order. Decimal, matching every file manager and the Vite build log. */
export const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const
export type ByteUnit = (typeof BYTE_UNITS)[number]

export interface ByteSize {
  /** Rounded to at most one decimal by the caller's `Intl.NumberFormat`, never here. */
  value: number
  unit: ByteUnit
}

/**
 * A byte count as a number and a unit, for a caller that will format the number.
 *
 * Split in two on purpose. The number has to go through `Intl.NumberFormat` for the locale's
 * decimal separator — `1,2 MB` in German, `1.2 MB` in English — and a function that returned
 * a finished string would either hard-code a separator or need a locale, which would make it
 * a formatting function pretending to be a calculation.
 *
 * Total. A negative count, a fractional one, `NaN`: all come back as `0 B` rather than
 * throwing, because the input is a byte count from a remote server by way of Chromium, and
 * one absurd number must not take the row down.
 */
export function byteSize(bytes: number): ByteSize {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: 0, unit: 'B' }

  // Truncated at the door, so the `B` unit is always a whole number of bytes — `1.5 B` is not
  // a thing, and a fractional count can only come from a bad header.
  let value = Math.trunc(bytes)
  let index = 0
  // Stops at the last unit rather than running off the end of the array, so a number past a
  // terabyte is reported in terabytes instead of in `undefined`.
  while (value >= 1000 && index < BYTE_UNITS.length - 1) {
    value /= 1000
    index += 1
  }
  const [unit] = BYTE_UNITS.slice(index, index + 1)
  return { value: roundToOneDecimal(value), unit: unit ?? 'B' }
}

/**
 * Rounded here rather than left to the formatter.
 *
 * `Intl.NumberFormat` with `maximumFractionDigits` would round for display and leave the value
 * itself long, so two callers formatting the same size differently would disagree about it.
 * Three significant figures is what every file manager shows: `1.2 MB`, but `234 MB`.
 */
function roundToOneDecimal(value: number): number {
  if (value >= 100) return Math.round(value)
  return Math.round(value * 10) / 10
}

/**
 * The message key that names each state.
 *
 * A record over `DownloadState` rather than a string built from it, so a new state fails the
 * build here instead of rendering a key nobody translated.
 */
export const DOWNLOAD_STATE_LABELS = {
  progressing: 'downloads.state.progressing',
  paused: 'downloads.state.paused',
  completed: 'downloads.state.completed',
  cancelled: 'downloads.state.cancelled',
  interrupted: 'downloads.state.interrupted'
} as const satisfies Readonly<Record<DownloadState, `downloads.state.${DownloadState}`>>

/** What a row can offer, on the page and in the panel alike. */
export type DownloadAction = 'open' | 'reveal' | 'pause' | 'resume' | 'cancel' | 'remove'

/** Every key the text functions below ask a translator for. */
export type DownloadTextKey = 'downloads.byteSize' | 'downloads.progress' | 'downloads.progressUnknown'

/**
 * Whatever translator the calling surface holds, narrowed to the keys used here.
 *
 * A wider translator is assignable to this one — a function that accepts every key accepts
 * these three — so neither surface has to wrap its own.
 */
export type DownloadTranslate = (
  key: DownloadTextKey,
  params: Readonly<Record<string, string | number>>
) => string

/**
 * The number format a byte count is shown in.
 *
 * One decimal at most, matching the one decimal `byteSize` rounds to — a format allowing more
 * would print nothing more, and a format allowing fewer would round a second time and disagree
 * with the value. Here so the two surfaces cannot drift apart on it.
 */
export function downloadNumberFormat(locale: string): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
}

/** A byte count as the row shows it: `1.2 MB`, `1,2 MB`. */
export function downloadSizeText(
  bytes: number,
  translate: DownloadTranslate,
  numberFormat: Intl.NumberFormat
): string {
  const { value, unit } = byteSize(bytes)
  return translate('downloads.byteSize', { value: numberFormat.format(value), unit })
}

/**
 * How far a download has got, in words: `1.2 MB of 5 MB`, or `1.2 MB downloaded` when the
 * server declared no length — the `0` that `DownloadRecord.totalBytes` uses for unknown. Saying
 * "of 0 B" would be a claim about the file that nobody made.
 */
export function downloadProgressText(
  record: DownloadRecord,
  translate: DownloadTranslate,
  numberFormat: Intl.NumberFormat
): string {
  const received = downloadSizeText(record.receivedBytes, translate, numberFormat)
  return record.totalBytes > 0
    ? translate('downloads.progress', {
        received,
        total: downloadSizeText(record.totalBytes, translate, numberFormat)
      })
    : translate('downloads.progressUnknown', { received })
}
