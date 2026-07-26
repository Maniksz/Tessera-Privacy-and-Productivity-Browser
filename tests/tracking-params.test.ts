import { describe, expect, it } from 'vitest'
import { cleanUrl, stripTrackingParams } from '@shared/url/tracking-params.js'

/** Spec 7 names URL cleaning as a unit-test target. */

describe('stripTrackingParams', () => {
  it('removes utm parameters', () => {
    const { url, removed } = stripTrackingParams(
      'https://example.com/article?utm_source=news&utm_medium=email&id=42'
    )
    expect(url).toBe('https://example.com/article?id=42')
    expect(removed.sort()).toEqual(['utm_medium', 'utm_source'])
  })

  it('removes click identifiers', () => {
    expect(cleanUrl('https://example.com/?gclid=abc&fbclid=def&msclkid=ghi')).toBe(
      'https://example.com/'
    )
  })

  it('drops the question mark when nothing is left', () => {
    // A trailing "?" is what URL.search leaves behind; it must not survive.
    expect(cleanUrl('https://example.com/page?utm_source=x')).toBe('https://example.com/page')
  })

  it('keeps functional parameters untouched', () => {
    const input = 'https://example.com/search?q=hello&page=2&sort=date'
    expect(cleanUrl(input)).toBe(input)
  })

  it('leaves a URL without a query alone', () => {
    const input = 'https://example.com/page'
    expect(cleanUrl(input)).toBe(input)
  })

  it('matches parameter names case-insensitively', () => {
    expect(cleanUrl('https://example.com/?UTM_Source=x&keep=1')).toBe('https://example.com/?keep=1')
  })

  it('honours host-scoped exceptions', () => {
    // `si` is share attribution on YouTube but part of how a Spotify link
    // resolves, so it is removed in one place and kept in the other.
    expect(cleanUrl('https://open.spotify.com/track/abc?si=xyz')).toBe(
      'https://open.spotify.com/track/abc?si=xyz'
    )
    expect(cleanUrl('https://www.youtube.com/watch?v=abc&si=xyz')).toBe(
      'https://www.youtube.com/watch?v=abc'
    )
  })

  it('leaves unparseable input untouched rather than guessing', () => {
    const { url, removed } = stripTrackingParams('not a url at all')
    expect(url).toBe('not a url at all')
    expect(removed).toEqual([])
  })

  it('ignores non-http schemes', () => {
    const input = 'mailto:someone@example.com?utm_source=x'
    expect(cleanUrl(input)).toBe(input)
  })

  it('preserves the fragment', () => {
    expect(cleanUrl('https://example.com/doc?utm_source=x#section-3')).toBe(
      'https://example.com/doc#section-3'
    )
  })

  it('removes prefix-matched families', () => {
    expect(cleanUrl('https://example.com/?pk_campaign=a&matomo_kwd=b&keep=1')).toBe(
      'https://example.com/?keep=1'
    )
  })
})
