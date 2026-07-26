import { describe, expect, it } from 'vitest'
import {
  hostMatchesRule,
  isSameSite,
  registrableDomain,
  registrableDomainOfUrl
} from '@shared/url/domain.js'

/**
 * Spec 4 calls out two failure modes by name, and both are tested here:
 * multi-part suffixes like `.co.uk`, and substring matching on names like
 * `track.` that would break parcel tracking and newsletter links.
 */

describe('registrableDomain', () => {
  it('handles a simple two-label host', () => {
    expect(registrableDomain('example.com')).toBe('example.com')
  })

  it('strips subdomains', () => {
    expect(registrableDomain('ads.tracker.example.com')).toBe('example.com')
  })

  it('handles multi-part suffixes', () => {
    // Naive "last two labels" logic yields "co.uk" here, which would make every
    // British site look like the same party.
    expect(registrableDomain('www.bbc.co.uk')).toBe('bbc.co.uk')
    expect(registrableDomain('bbc.co.uk')).toBe('bbc.co.uk')
  })

  it('keeps distinct .co.uk registrations apart', () => {
    expect(registrableDomain('bbc.co.uk')).not.toBe(registrableDomain('evil.co.uk'))
  })

  it('treats hosting suffixes as separate parties', () => {
    // Two GitHub Pages sites are different parties, not one.
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io')
    expect(registrableDomain('bob.github.io')).toBe('bob.github.io')
  })

  it('returns IP addresses unchanged', () => {
    expect(registrableDomain('192.168.1.1')).toBe('192.168.1.1')
    expect(registrableDomain('[::1]')).toBe('::1')
  })

  it('returns localhost unchanged', () => {
    expect(registrableDomain('localhost')).toBe('localhost')
  })

  it('is case- and trailing-dot-insensitive', () => {
    expect(registrableDomain('WWW.Example.COM.')).toBe('example.com')
  })
})

describe('registrableDomainOfUrl', () => {
  it('extracts from a URL', () => {
    expect(registrableDomainOfUrl('https://shop.example.co.uk/cart?a=1')).toBe('example.co.uk')
  })

  it('returns null for a URL with no host', () => {
    expect(registrableDomainOfUrl('about:blank')).toBeNull()
  })

  it('returns null for unparseable input', () => {
    expect(registrableDomainOfUrl('not a url')).toBeNull()
  })
})

describe('isSameSite', () => {
  it('matches across subdomains', () => {
    expect(isSameSite('https://a.example.com/x', 'https://b.example.com/y')).toBe(true)
  })

  it('does not match different sites', () => {
    expect(isSameSite('https://example.com', 'https://example.org')).toBe(false)
  })
})

describe('hostMatchesRule', () => {
  it('matches the host itself', () => {
    expect(hostMatchesRule('doubleclick.net', 'doubleclick.net')).toBe(true)
  })

  it('matches a subdomain', () => {
    expect(hostMatchesRule('ad.doubleclick.net', 'doubleclick.net')).toBe(true)
  })

  it('does not match on a label suffix', () => {
    // Substring matching would block this; whole-label matching does not.
    expect(hostMatchesRule('notdoubleclick.net', 'doubleclick.net')).toBe(false)
  })

  it('does not match a legitimate host containing a tracker-ish label', () => {
    // The exact regression spec 4 warns about: parcel tracking must survive.
    expect(hostMatchesRule('track.dhl.de', 'track')).toBe(false)
    expect(hostMatchesRule('click.newsletter.example.com', 'click')).toBe(false)
  })

  it('rejects an empty pattern instead of matching everything', () => {
    expect(hostMatchesRule('example.com', '')).toBe(false)
  })
})
