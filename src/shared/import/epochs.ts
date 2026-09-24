/**
 * The clocks of the browsers an import reads (U24, KTD19), turned into this browser's milliseconds.
 *
 * Two named helpers rather than one with a parameter, because getting the epoch wrong is silent:
 * Chrome's microseconds taken as Firefox's put every visit in the year 2393 — and the import then
 * drops them all as "in the future", without an error anywhere.
 *
 * ## Why the arithmetic is on bigints
 *
 * A Chrome timestamp of today is about 1.34 × 10^16, past `Number.MAX_SAFE_INTEGER`. It arrives as
 * text in the `Bookmarks` JSON and as a bigint from SQLite (`readBigInts`, without which the driver
 * refuses the value outright), and is converted exactly. A double would round it and accept whatever
 * rounding made of a damaged value.
 *
 * Anything that is not a whole number, is "unset" (zero), falls before 1970 or past the last instant a
 * `Date` can hold answers `null`. The caller decides what a missing time means; this does not guess.
 */

/** Microseconds from 1601-01-01 to 1970-01-01: Chrome's epoch, the Windows `FILETIME` one. */
const CHROME_EPOCH_OFFSET = 11_644_473_600_000_000n

/** The last millisecond `new Date()` accepts. */
const LAST_DATE_MS = 8_640_000_000_000_000n

/** A whole number as a bigint, or `null`. Text is digits only: no sign, no exponent, no padding. */
function microsOf(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null
  if (typeof value === 'string' && /^\d{1,30}$/.test(value)) return BigInt(value)
  return null
}

function millisecondsSince1970(micros: bigint): number | null {
  if (micros <= 0n) return null
  const ms = micros / 1000n
  return ms > LAST_DATE_MS ? null : Number(ms)
}

/** Chrome, Edge and Chromium: microseconds since 1601 (`date_added`, `visit_time`). */
export function chromeTimeToMs(value: unknown): number | null {
  const micros = microsOf(value)
  return micros === null ? null : millisecondsSince1970(micros - CHROME_EPOCH_OFFSET)
}

/** Firefox: PRTime, microseconds since 1970 (`visit_date`, `dateAdded`). */
export function firefoxTimeToMs(value: unknown): number | null {
  const micros = microsOf(value)
  return micros === null ? null : millisecondsSince1970(micros)
}
