import { describe, expect, it } from 'vitest'
import { chromeTimeToMs, firefoxTimeToMs } from '@shared/import/epochs.js'

/**
 * The two clocks other browsers keep (U24, KTD19).
 *
 * Chrome counts microseconds since 1601-01-01, Firefox microseconds since 1970-01-01. A Chrome value
 * of today is past `Number.MAX_SAFE_INTEGER`, so it arrives as text (the `Bookmarks` JSON) or as a
 * bigint (SQLite) and is converted exactly; a helper that went through a double first would be off by
 * a few microseconds and, worse, would accept whatever rounding made of a damaged value.
 */

describe('Chrome time', () => {
  it('turns microseconds since 1601 into milliseconds since 1970', () => {
    expect(chromeTimeToMs('13345678901234567')).toBe(1_701_205_301_234)
    expect(chromeTimeToMs(13345678901234567n)).toBe(1_701_205_301_234)
    expect(new Date(1_701_205_301_234).toISOString()).toBe('2023-11-28T21:01:41.234Z')
  })

  it('reads a safe number too, and every safe number is before 1970 in this clock', () => {
    expect(chromeTimeToMs(11_644_473_600_000_000n + 1_000n)).toBe(1)
    // Why SQLite has to be read with bigints: no Chrome time since 1970 fits a safe integer.
    expect(chromeTimeToMs(Number.MAX_SAFE_INTEGER)).toBeNull()
  })

  it('answers nothing for "unset" and for anything before 1970', () => {
    expect(chromeTimeToMs('0')).toBeNull()
    expect(chromeTimeToMs(0n)).toBeNull()
    expect(chromeTimeToMs('11644473600000000')).toBeNull()
    expect(chromeTimeToMs(-5n)).toBeNull()
  })

  it('answers nothing for what is not a whole number', () => {
    const values = ['', 'abc', '1.5', '-1', '1e20', ' 1', null, undefined, {}, 1.5, NaN]
    for (const [index, value] of values.entries()) {
      expect(chromeTimeToMs(value), `value ${index}`).toBeNull()
    }
    expect(chromeTimeToMs(Number.POSITIVE_INFINITY)).toBeNull()
    expect(chromeTimeToMs('9'.repeat(40))).toBeNull()
  })

  it('answers nothing past the last instant a Date can hold', () => {
    const lastDate = 8_640_000_000_000_000n
    expect(chromeTimeToMs(11_644_473_600_000_000n + lastDate * 1000n)).toBe(8.64e15)
    expect(chromeTimeToMs(11_644_473_600_000_000n + (lastDate + 1n) * 1000n)).toBeNull()
  })
})

describe('Firefox time', () => {
  it('turns microseconds since 1970 into milliseconds', () => {
    expect(firefoxTimeToMs(1_726_000_000_000_000)).toBe(1_726_000_000_000)
    expect(firefoxTimeToMs(1_726_000_000_000_000n)).toBe(1_726_000_000_000)
    expect(firefoxTimeToMs('1726000000000000')).toBe(1_726_000_000_000)
    expect(new Date(1_726_000_000_000).toISOString()).toBe('2024-09-10T20:26:40.000Z')
  })

  it('cuts a partial millisecond off rather than rounding it up', () => {
    expect(firefoxTimeToMs(1_999n)).toBe(1)
  })

  it('answers nothing for "unset", a negative value or garbage', () => {
    expect(firefoxTimeToMs(0)).toBeNull()
    expect(firefoxTimeToMs(-1n)).toBeNull()
    expect(firefoxTimeToMs('x')).toBeNull()
    expect(firefoxTimeToMs(null)).toBeNull()
    expect(firefoxTimeToMs(8_640_000_000_000_001_000n)).toBeNull()
  })
})
