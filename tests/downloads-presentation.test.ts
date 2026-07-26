import { describe, expect, it } from 'vitest'
import { BYTE_UNITS, byteSize } from '@shared/downloads/presentation.js'

/**
 * Byte counts as a person reads them.
 *
 * Total on purpose: the number comes from a remote server by way of Chromium, so a negative,
 * fractional or absent one must produce a row rather than an exception.
 */

describe('byteSize', () => {
  it('uses decimal units, like every file manager and the build log', () => {
    expect(byteSize(999)).toEqual({ value: 999, unit: 'B' })
    expect(byteSize(1000)).toEqual({ value: 1, unit: 'kB' })
    expect(byteSize(1_500_000)).toEqual({ value: 1.5, unit: 'MB' })
  })

  it('shows three significant figures, as a file manager does', () => {
    expect(byteSize(1_234_567)).toEqual({ value: 1.2, unit: 'MB' })
    expect(byteSize(234_000_000)).toEqual({ value: 234, unit: 'MB' })
  })

  it('reports whole bytes below a kilobyte', () => {
    // `1.5 B` is not a thing, and a fractional count can only come from a bad header.
    expect(byteSize(1.5)).toEqual({ value: 1, unit: 'B' })
  })

  it('stops at the largest unit rather than running off the end', () => {
    // A number past a terabyte must be reported in terabytes, not in `undefined`.
    const enormous = byteSize(5 * 1000 ** 5)
    expect(enormous.unit).toBe(BYTE_UNITS[BYTE_UNITS.length - 1])
    expect(enormous.value).toBe(5000)
  })

  it('answers zero for every number that is not one', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(byteSize(bad), String(bad)).toEqual({ value: 0, unit: 'B' })
    }
  })
})
