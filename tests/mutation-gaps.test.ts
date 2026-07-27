import { describe, expect, it } from 'vitest'
import { classifyOmniboxInput } from '@shared/url/omnibox.js'
import { clampFraction, computeTileRects, TILE_GUTTER } from '@shared/split/layout.js'
import { internalUrl } from '@shared/product.js'

/**
 * Assertions added in response to a mutation run.
 *
 * Every case here corresponds to a mutant that survived — a change to the source
 * that no existing test noticed. That is the useful half of mutation testing: not
 * the score, but the list of specific things the suite was not actually checking.
 *
 * Each block names the mutation it kills, so a future reader can tell these apart
 * from tests written to describe behaviour.
 */

describe('omnibox: mutants that survived', () => {
  it('rejects an IPv4 address with an octet above 255', () => {
    // Killed mutant: `every(part => Number(part) <= 255)` -> `< 255`, and
    // `every` -> `some`. Nothing tested an out-of-range octet, so both passed.
    expect(classifyOmniboxInput('999.1.1.1').kind).toBe('search')
    expect(classifyOmniboxInput('256.0.0.1').kind).toBe('search')
  })

  it('accepts an address whose octets are exactly at the boundary', () => {
    // The other half: `<= 255` must still admit 255.
    expect(classifyOmniboxInput('255.255.255.255')).toEqual({
      kind: 'url',
      url: 'https://255.255.255.255'
    })
    expect(classifyOmniboxInput('0.0.0.0').kind).toBe('url')
  })

  it('recognises an upper-case scheme', () => {
    // Killed mutant: `.toLowerCase()` -> `.toUpperCase()` in the scheme check. No
    // test used a capitalised scheme, so the comparison could have been inverted
    // without anyone noticing.
    expect(classifyOmniboxInput('HTTP://example.com/').kind).toBe('url')
    expect(classifyOmniboxInput('HTTPS://Example.COM/').kind).toBe('url')
  })

  it('rejects an upper-case javascript scheme just as firmly', () => {
    expect(classifyOmniboxInput('JavaScript:alert(1)').kind).toBe('search')
    expect(classifyOmniboxInput('DATA:text/html,x').kind).toBe('search')
  })

  it('trims whitespace after an explicit search prefix', () => {
    // Killed mutant: `input.slice(1).trim()` -> `input.slice(1)`. Every existing
    // case had no space after the question mark.
    expect(classifyOmniboxInput('?  hello world  ')).toEqual({
      kind: 'search',
      query: 'hello world'
    })
  })

  it('does not treat a partly numeric suffix as a port', () => {
    // Killed mutants: the port pattern `/^\d+$/` relaxed to `/\d+$/` or `/^\d+/`.
    // `example.com:12ab` and `example.com:ab12` both have to stay searches, or the
    // host would be truncated at the colon and silently resolved.
    expect(classifyOmniboxInput('example.com:12ab').kind).toBe('search')
    expect(classifyOmniboxInput('example.com:ab12').kind).toBe('search')
    expect(classifyOmniboxInput('example.com:8080').kind).toBe('url')
  })

  it('keeps userinfo out of the host judgement', () => {
    // Killed mutant: dropping the `+1` when slicing past the '@'. Without it the
    // host would include the separator and fail validation, turning a valid
    // address into a search.
    expect(classifyOmniboxInput('alice@example.com').kind).toBe('url')
    expect(classifyOmniboxInput('alice@not a host').kind).toBe('search')
  })
})

describe('layout: mutants that survived', () => {
  const content = { x: 0, y: 0, width: 1600, height: 900 }

  it('picks the axis from the divider prefix, not its ending', () => {
    // Killed mutant: `dividerId.startsWith('v')` -> `endsWith('v')`. For the ids in
    // use today both agree, which is exactly why the mutant survived — and exactly
    // why a future `vRight` would silently be treated as horizontal.
    const vertical = clampFraction('1x2', 'vRight', 0, { width: 1600, height: 400 })
    const horizontal = clampFraction('2x1', 'hRight', 0, { width: 1600, height: 400 })
    // Bounded by width for a vertical divider, by height for a horizontal one, so
    // the two clamp to different values on a non-square area.
    expect(vertical).not.toBeCloseTo(horizontal, 6)
  })

  it('snaps only when an even split is actually reachable', () => {
    // Killed mutants: the `0.5 >= lower && 0.5 <= upper` guard collapsed to `true`.
    // On an area wide enough for the minimum, 0.5 is reachable and snapping applies.
    expect(clampFraction('1x2', 'v', 0.505, content)).toBe(0.5)
    // Just outside the snap distance, the value is kept as given.
    expect(clampFraction('1x2', 'v', 0.53, content)).toBeCloseTo(0.53, 6)
  })

  it('treats a zero-sized area as unusable rather than dividing by it', () => {
    // Killed mutant: `available <= 0` -> `available < 0`.
    expect(clampFraction('1x2', 'v', 0.3, { width: 0, height: 900 })).toBe(0.5)
    expect(clampFraction('2x1', 'h', 0.3, { width: 1600, height: 0 })).toBe(0.5)
  })

  it('applies the gutter to interior edges only, on every side', () => {
    // Killed mutants: each of the four interior-edge conditions replaced by
    // `false`. Checking only the outer bounds let three of them survive.
    const [topLeft, topRight, bottomLeft, bottomRight] = computeTileRects(
      '2x2',
      { v: 0.5, h: 0.5 },
      content,
      { gutter: TILE_GUTTER }
    )
    const half = Math.round(TILE_GUTTER / 2)

    // Left column: flush left, inset on the right.
    expect(topLeft!.x).toBe(content.x)
    expect(topLeft!.x + topLeft!.width).toBe(content.width / 2 - half)
    // Right column: inset on the left, flush right.
    expect(topRight!.x).toBe(content.width / 2 + half)
    expect(topRight!.x + topRight!.width).toBe(content.width)
    // Top row: flush top, inset at the bottom.
    expect(topLeft!.y).toBe(content.y)
    expect(topLeft!.y + topLeft!.height).toBe(content.height / 2 - half)
    // Bottom row: inset at the top, flush bottom.
    expect(bottomLeft!.y).toBe(content.height / 2 + half)
    expect(bottomLeft!.y + bottomLeft!.height).toBe(content.height)
    expect(bottomRight!.x + bottomRight!.width).toBe(content.width)
  })

  it('leaves a single tile untouched by the gutter', () => {
    // A 1x1 layout has no interior edges, so the gutter must change nothing.
    expect(computeTileRects('1x1', {}, content, { gutter: TILE_GUTTER })).toEqual([content])
  })

  it('applies no gutter when none is asked for', () => {
    // Killed mutant: the `gutter === 0` early return replaced by `false`, which
    // would run the inset pass with a half-gutter of zero — the same result, unless
    // rounding differs. Pinning the identity keeps the fast path honest.
    const withZero = computeTileRects('2x2', { v: 0.5, h: 0.5 }, content, { gutter: 0 })
    const without = computeTileRects('2x2', { v: 0.5, h: 0.5 }, content)
    expect(withZero).toEqual(without)
  })

  it('uses the supplied minimum tile size rather than the default', () => {
    // Killed mutant: `options.minTile ?? MIN_TILE_SIZE` -> `&&` in
    // `computeTileRects`. With `??` a caller can widen the minimum; with `&&` the
    // default would always win and this tile would come out at 240px.
    const [left] = computeTileRects('1x2', { v: 0.05 }, content, {
      minTile: { width: 600, height: 180 }
    })
    expect(left!.width).toBeGreaterThanOrEqual(600)

    // And the default still applies when nothing is supplied.
    const [defaultLeft] = computeTileRects('1x2', { v: 0.05 }, content)
    expect(defaultLeft!.width).toBeLessThan(600)
    expect(defaultLeft!.width).toBeGreaterThanOrEqual(240)
  })
})

describe('internal addresses: mutants that survived', () => {
  it('appends no question mark for a query with nothing in it', () => {
    /*
      Killed mutant: `search === '' ? base : ...` replaced by the query branch always
      being taken, which yields `tessera://history?`.

      A caller assembling a filtered address — the history page opened with no filter,
      a quick link built from a record that had no parameters — would then get an
      address that is *equal to no other spelling of the same page*. `isHomeUrl`
      compares strings, history de-duplicates on the stored URL and the start page
      matches its own address, so one stray `?` shows up as a card that never
      highlights and a second history entry for a page the user has already visited.
    */
    expect(internalUrl('history', {})).toBe('tessera://history')
    expect(internalUrl('history')).toBe('tessera://history')
    // And a query that has something in it is still appended, so the empty case is not
    // being met by dropping the parameters altogether.
    expect(internalUrl('history', { q: 'news' })).toBe('tessera://history?q=news')
  })
})
