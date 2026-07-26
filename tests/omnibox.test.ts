import { describe, expect, it } from 'vitest'
import {
  buildSearchUrl,
  classifyOmniboxInput,
  resolveOmniboxInput
} from '@shared/url/omnibox.js'

/**
 * Spec 7 names address-bar resolution as a unit-test target. The cases that
 * matter are the ambiguous ones: guessing "address" wrongly leaks the user's
 * text to a DNS resolver, so the bias has to be towards searching.
 */

describe('classifyOmniboxInput', () => {
  it('treats a bare host as an address', () => {
    expect(classifyOmniboxInput('example.com')).toEqual({
      kind: 'url',
      url: 'https://example.com'
    })
  })

  it('keeps an explicit scheme', () => {
    expect(classifyOmniboxInput('http://example.com/path')).toEqual({
      kind: 'url',
      url: 'http://example.com/path'
    })
  })

  it('treats anything containing whitespace as a search', () => {
    expect(classifyOmniboxInput('example.com and more')).toEqual({
      kind: 'search',
      query: 'example.com and more'
    })
  })

  it('treats a single label without a dot as a search', () => {
    expect(classifyOmniboxInput('settings')).toEqual({ kind: 'search', query: 'settings' })
  })

  it('does not mistake a decimal number for a host', () => {
    // "3.14" has a dot, but "14" is not a plausible TLD. Resolving it would
    // send the number to a DNS server.
    expect(classifyOmniboxInput('3.14')).toEqual({ kind: 'search', query: '3.14' })
  })

  it('does not mistake a partial IP for a host', () => {
    expect(classifyOmniboxInput('192.168.1')).toEqual({ kind: 'search', query: '192.168.1' })
  })

  it('recognises a full IPv4 address', () => {
    expect(classifyOmniboxInput('192.168.1.1:8080')).toEqual({
      kind: 'url',
      url: 'https://192.168.1.1:8080'
    })
  })

  it('recognises localhost with a port', () => {
    expect(classifyOmniboxInput('localhost:5173')).toEqual({
      kind: 'url',
      url: 'https://localhost:5173'
    })
  })

  it('forces a search with a leading question mark', () => {
    expect(classifyOmniboxInput('?example.com')).toEqual({ kind: 'search', query: 'example.com' })
  })

  it('refuses javascript: as a navigation target', () => {
    // Typed or pasted javascript: URLs are a classic self-XSS vector; they must
    // never navigate.
    expect(classifyOmniboxInput('javascript:alert(1)')).toEqual({
      kind: 'search',
      query: 'javascript:alert(1)'
    })
  })

  it('refuses data: as a navigation target', () => {
    expect(classifyOmniboxInput('data:text/html,<h1>hi')).toEqual({
      kind: 'search',
      query: 'data:text/html,<h1>hi'
    })
  })

  it('passes internal pages through untouched', () => {
    expect(classifyOmniboxInput('tessera://settings')).toEqual({
      kind: 'url',
      url: 'tessera://settings'
    })
  })

  it('reports empty input as empty', () => {
    expect(classifyOmniboxInput('   ')).toEqual({ kind: 'empty' })
  })

  it('handles a multi-label host with a path', () => {
    expect(classifyOmniboxInput('mail.google.com/mail/u/0')).toEqual({
      kind: 'url',
      url: 'https://mail.google.com/mail/u/0'
    })
  })

  it('treats an unknown scheme as a search rather than handing it to the OS', () => {
    expect(classifyOmniboxInput('slack://channel?id=1')).toEqual({
      kind: 'search',
      query: 'slack://channel?id=1'
    })
  })
})

describe('buildSearchUrl', () => {
  it('uses the privacy-friendly default engine', () => {
    expect(buildSearchUrl('hello world', { engine: 'duckduckgo', customUrl: '' })).toBe(
      'https://duckduckgo.com/?q=hello%20world'
    )
  })

  it('encodes characters that would otherwise change the query', () => {
    expect(buildSearchUrl('a&b=c', { engine: 'duckduckgo', customUrl: '' })).toBe(
      'https://duckduckgo.com/?q=a%26b%3Dc'
    )
  })

  it('falls back to the default when a custom template has no placeholder', () => {
    // A template without {query} would otherwise search for nothing at all.
    expect(buildSearchUrl('x', { engine: 'custom', customUrl: 'https://example.com/' })).toBe(
      'https://duckduckgo.com/?q=x'
    )
  })

  it('uses a valid custom template', () => {
    expect(
      buildSearchUrl('x', { engine: 'custom', customUrl: 'https://example.com/s?q={query}' })
    ).toBe('https://example.com/s?q=x')
  })
})

describe('resolveOmniboxInput', () => {
  it('returns null for empty input so the current page is left alone', () => {
    expect(resolveOmniboxInput('', { engine: 'duckduckgo', customUrl: '' })).toBeNull()
  })

  it('resolves a search term through the engine', () => {
    expect(resolveOmniboxInput('rust traits', { engine: 'mojeek', customUrl: '' })).toBe(
      'https://www.mojeek.com/search?q=rust%20traits'
    )
  })
})
