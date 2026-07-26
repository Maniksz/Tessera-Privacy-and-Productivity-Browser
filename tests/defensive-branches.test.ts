import { describe, expect, it } from 'vitest'
import { clampFraction, computeTileRects, tileInDirection } from '@shared/split/layout.js'
import { registrableDomain, configurePublicSuffixes } from '@shared/url/domain.js'

/**
 * Defensive branches.
 *
 * These are the fallbacks that only run when something upstream is already wrong —
 * a divider id a layout does not have, a window with no area, a host with a single
 * label. They are worth covering precisely because they are the paths nobody
 * exercises by hand: if one of them is broken, the symptom is not an error but a
 * tile in the wrong place or a domain compared incorrectly.
 *
 * Where a branch cannot be reached without editing the source, it is named in the
 * threshold comment in `vitest.config.ts` rather than reached by contortion.
 */

describe('clampFraction fallbacks', () => {
  const content = { width: 1600, height: 900 }

  it('falls back to a symmetric split for a divider the layout does not have', () => {
    // `1x1` has no dividers at all, so there is no default to fall back to.
    expect(clampFraction('1x1', 'v', Number.NaN, content)).toBe(0.5)
  })

  it('falls back for a non-finite value on a real divider', () => {
    expect(clampFraction('1x2', 'v', Number.NaN, content)).toBe(0.5)
    expect(clampFraction('1x2', 'v', Number.POSITIVE_INFINITY, content)).toBe(0.5)
  })

  it('falls back when the content area has no width', () => {
    // A window mid-resize, or a layout computed before the first paint.
    expect(clampFraction('1x2', 'v', 0.3, { width: 0, height: 900 })).toBe(0.5)
  })

  it('falls back when the content area has no height', () => {
    expect(clampFraction('2x1', 'h', 0.3, { width: 1600, height: 0 })).toBe(0.5)
  })

  it('falls back for an unknown divider on a layout that has others', () => {
    expect(clampFraction('1x2', 'zzz', Number.NaN, content)).toBe(0.5)
  })

  it('uses the layout default for a non-finite value on 1+2', () => {
    expect(clampFraction('1+2', 'v', Number.NaN, content)).toBe(0.6)
  })
})

describe('computeTileRects fallbacks', () => {
  it('uses a symmetric right-hand split when 1+2 has no hRight fraction', () => {
    const rects = computeTileRects('1+2', { v: 0.6 }, { x: 0, y: 0, width: 1000, height: 800 })
    const [, topRight, bottomRight] = rects
    expect(topRight?.height).toBe(bottomRight?.height)
  })

  it('produces zero-size tiles rather than negative ones in a degenerate area', () => {
    const rects = computeTileRects('2x2', {}, { x: 0, y: 0, width: 0, height: 0 })
    for (const rect of rects) {
      expect(rect.width).toBeGreaterThanOrEqual(0)
      expect(rect.height).toBeGreaterThanOrEqual(0)
    }
  })

  it('never produces a negative dimension once the gutter is applied', () => {
    const rects = computeTileRects('2x2', {}, { x: 0, y: 0, width: 4, height: 4 }, { gutter: 40 })
    for (const rect of rects) {
      expect(rect.width).toBeGreaterThanOrEqual(0)
      expect(rect.height).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('tileInDirection with gaps in the list', () => {
  it('skips a hole rather than throwing', () => {
    // `SplitController.tileRects` returns nulls for collapsed tiles while one is
    // maximised, and navigation must survive being handed that shape.
    const rects = [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 100, y: 0, width: 100, height: 100 }
    ]
    const withHole = [rects[0]!, undefined as unknown as (typeof rects)[number], rects[1]!]
    expect(tileInDirection(withHole, 0, 'right')).toBe(2)
  })

  it('returns null when every candidate is a hole', () => {
    const rects = [
      { x: 0, y: 0, width: 100, height: 100 },
      undefined as unknown as { x: number; y: number; width: number; height: number }
    ]
    expect(tileInDirection(rects, 0, 'right')).toBeNull()
  })
})

describe('registrableDomain edges', () => {
  it('returns a single-label host unchanged', () => {
    // An intranet name has no registrable domain to derive.
    expect(registrableDomain('intranet')).toBe('intranet')
  })

  it('returns a host that is itself a public suffix unchanged', () => {
    configurePublicSuffixes(['co.uk'])
    // Nothing sits in front of the suffix, so there is no registration.
    expect(registrableDomain('co.uk')).toBe('co.uk')
  })

  it('handles a host whose first label is the suffix match', () => {
    configurePublicSuffixes(['github.io'])
    expect(registrableDomain('github.io')).toBe('github.io')
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io')
  })

  it('falls back to the last two labels for an unlisted suffix', () => {
    configurePublicSuffixes([])
    expect(registrableDomain('a.b.example.com')).toBe('example.com')
    expect(registrableDomain('example.zzz')).toBe('example.zzz')
  })
})
