import { describe, expect, it } from 'vitest'
import { HOME_URL, isHomeUrl, omniboxDisplayValue } from '@shared/url/omnibox.js'
import { interstitialUrl, withoutToken } from '@shared/privacy/https-token.js'

/**
 * The home address and what the address bar shows for it.
 *
 * The rule lives in `shared` because three layers depend on agreeing: the core picks
 * what a new tab loads, the address bar decides when to show nothing, and the Home
 * command navigates there. A second opinion anywhere means the field shows a URL the
 * browser does not consider home, or vice versa.
 */

describe('isHomeUrl', () => {
  it('recognises the home address', () => {
    expect(isHomeUrl(HOME_URL)).toBe(true)
  })

  it('recognises it with a trailing slash', () => {
    // Chromium normalises `tessera://start` to `tessera://start/` once loaded,
    // so the check has to accept both or the field would fill in after navigation.
    expect(isHomeUrl('tessera://start/')).toBe(true)
  })

  it('treats an empty address and about:blank as home', () => {
    expect(isHomeUrl('')).toBe(true)
    expect(isHomeUrl('about:blank')).toBe(true)
  })

  it('does not treat other internal pages as home', () => {
    // `tessera://history` is somewhere you can navigate to and copy; hiding its
    // address would be a loss, not a tidy-up.
    expect(isHomeUrl('tessera://history')).toBe(false)
    expect(isHomeUrl('tessera://settings')).toBe(false)
  })

  it('does not treat a deeper path on the start page as home', () => {
    expect(isHomeUrl('tessera://start/assets/x.js')).toBe(false)
  })

  it('does not treat web pages as home', () => {
    expect(isHomeUrl('https://example.com')).toBe(false)
    expect(isHomeUrl('https://start/')).toBe(false)
  })

  it('is not fooled by a crafted address', () => {
    expect(isHomeUrl('https://evil.example/#tessera://start')).toBe(false)
    expect(isHomeUrl('tessera://start.evil.example/')).toBe(false)
  })

  it('returns false for unparseable input rather than throwing', () => {
    expect(isHomeUrl('not a url')).toBe(false)
  })
})

describe('omniboxDisplayValue', () => {
  it('shows nothing on the home page', () => {
    expect(omniboxDisplayValue(HOME_URL)).toBe('')
    expect(omniboxDisplayValue('tessera://start/')).toBe('')
  })

  it('shows the address everywhere else', () => {
    expect(omniboxDisplayValue('https://example.com/page')).toBe('https://example.com/page')
    expect(omniboxDisplayValue('tessera://history')).toBe('tessera://history')
  })

  it('shows the target on the HTTPS-only interstitial, not the interstitial (R7)', () => {
    const interstitial = interstitialUrl('http://bank.example/login?next=1', 'A'.repeat(43), 'de')
    expect(omniboxDisplayValue(interstitial)).toBe('http://bank.example/login?next=1')
    // And after the page has dropped its token, which is the address the tab reports from then on.
    expect(omniboxDisplayValue(withoutToken(interstitial))).toBe('http://bank.example/login?next=1')
  })

  it('shows the interstitial’s own address when it names no target it would go to', () => {
    const forged = interstitialUrl('javascript:alert(1)', null, 'en')
    expect(omniboxDisplayValue(forged)).toBe(forged)
  })
})
