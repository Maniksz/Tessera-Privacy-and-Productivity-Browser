/**
 * How a download is shown.
 *
 * Extracted from the page so it can be tested, the same split `history/presentation.ts`
 * makes. Zod-free and DOM-free: the page imports it at runtime.
 */

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
