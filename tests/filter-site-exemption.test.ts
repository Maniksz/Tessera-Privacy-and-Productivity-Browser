import { describe, expect, it } from 'vitest'
import {
  exemptionHostOf,
  filteringExemptFor,
  withSiteExemption
} from '@shared/filters/site-exemption.js'

/**
 * "Do not filter this site" — the switch that makes the global off switch safe to have.
 *
 * `blocker-menu-items.ts` had argued for years that a blocker with no visible off switch for the current
 * site is a blocker people uninstall, and offered only the switch that turns filtering off *everywhere*.
 * So the way to read one page the blocker breaks was to disable it globally and remember to re-enable it.
 *
 * The decisions worth testing are not "does the list contain the host". They are the three that decide
 * whether the switch behaves as a person expects: which documents can be exempt at all, how an exemption
 * for a parent domain relates to a subdomain, and whether switching filtering back *on* actually does
 * anything when a broader exemption is in the list.
 */

describe('which documents an exemption can be keyed on', () => {
  it('takes the host of an ordinary page', () => {
    expect(exemptionHostOf('https://shop.example/products?q=1')).toBe('shop.example')
    expect(exemptionHostOf('http://www.example.com/')).toBe('www.example.com')
  })

  it('lower-cases it, because a host is case-insensitive and a list entry is a string', () => {
    // Without this, an exemption added from a link written `HTTPS://Shop.Example` would never match the
    // same site reached normally, and the switch would appear not to work at all.
    expect(exemptionHostOf('https://Shop.EXAMPLE/')).toBe('shop.example')
  })

  it('refuses anything that is not a web page', () => {
    /*
      The same boundary the element picker uses, and for the same reason: there is nothing to key a rule
      on. Offering the switch for these documents would be offering something that cannot be stored.
    */
    expect(exemptionHostOf('tessera://settings')).toBeNull()
    expect(exemptionHostOf('file:///etc/hosts')).toBeNull()
    expect(exemptionHostOf('about:blank')).toBeNull()
    expect(exemptionHostOf('data:text/html,hi')).toBeNull()
    expect(exemptionHostOf('not a url')).toBeNull()
    expect(exemptionHostOf('')).toBeNull()
    expect(exemptionHostOf(null)).toBeNull()
  })
})

describe('whether a document is exempt', () => {
  it('is not, with an empty list', () => {
    expect(filteringExemptFor('https://shop.example/', [])).toBe(false)
  })

  it('is, for the host itself', () => {
    expect(filteringExemptFor('https://shop.example/', ['shop.example'])).toBe(true)
  })

  it('is, for a subdomain of an exempt domain', () => {
    /*
      The asymmetry the user wants, and it comes free from `hostMatchesRule`: an exemption written for
      `example.com` covers everything under it, while one written for `docs.example.com` covers only that.
      Narrow by default, broad on request.
    */
    expect(filteringExemptFor('https://docs.example.com/a', ['example.com'])).toBe(true)
    expect(filteringExemptFor('https://example.com/a', ['docs.example.com'])).toBe(false)
  })

  it('matches whole labels only', () => {
    // `notexample.com` must not be covered by `example.com`. Substring matching here would silently
    // switch filtering off for sites the user never named — the exact failure `hostMatchesRule` exists to
    // prevent, asserted at this level too because this is where the consequence is visible.
    expect(filteringExemptFor('https://notexample.com/', ['example.com'])).toBe(false)
    expect(filteringExemptFor('https://example.com.evil.test/', ['example.com'])).toBe(false)
  })

  it('is not, for a document with no host', () => {
    // The safe direction, and the only coherent one: there is nothing in the list it could match.
    expect(filteringExemptFor('tessera://settings', ['settings'])).toBe(false)
    expect(filteringExemptFor(null, ['shop.example'])).toBe(false)
  })
})

describe('toggling a site', () => {
  it('adds the host', () => {
    expect(withSiteExemption([], 'shop.example', true)).toEqual(['shop.example'])
  })

  it('normalises what it stores', () => {
    expect(withSiteExemption([], '  Shop.EXAMPLE ', true)).toEqual(['shop.example'])
  })

  it('does not add a host something already covers', () => {
    /*
      Returned unchanged *by identity*, so the caller can skip a settings write. That is not
      micro-optimisation: writing the same list back broadcasts a settings change to every window and to
      every open settings tab, for a click that changed nothing.
    */
    const list = ['example.com']
    expect(withSiteExemption(list, 'docs.example.com', true)).toBe(list)
  })

  it('removes an exemption that covers the host, not only an exact match', () => {
    /*
      The case that would otherwise look like a broken switch.

      With `example.com` in the list, switching blocking back on for `docs.example.com` by removing only
      an exact entry removes nothing: the menu would show the switch back on and the page would still not
      be filtered. One click, one honest outcome — so every entry covering the host goes.
    */
    expect(withSiteExemption(['example.com', 'other.test'], 'docs.example.com', false)).toEqual([
      'other.test'
    ])
    expect(withSiteExemption(['docs.example.com'], 'docs.example.com', false)).toEqual([])
  })

  it('leaves a narrower entry alone when switching a broader host back on', () => {
    // `docs.example.com` does not cover `example.com`, so turning filtering back on for the parent must
    // not silently re-enable it for the subdomain the user exempted separately.
    expect(withSiteExemption(['docs.example.com'], 'example.com', false)).toEqual([
      'docs.example.com'
    ])
  })

  it('changes nothing when there is nothing to remove', () => {
    const list = ['other.test']
    expect(withSiteExemption(list, 'shop.example', false)).toBe(list)
  })

  it('ignores an empty host rather than storing one', () => {
    // An empty entry in the list would be matched by `hostMatchesRule` against nothing — but it would be
    // shown on the settings page as a blank line nobody can explain.
    const list = ['other.test']
    expect(withSiteExemption(list, '   ', true)).toBe(list)
    expect(withSiteExemption(list, '', false)).toBe(list)
  })

  it('round-trips', () => {
    const off = withSiteExemption([], 'shop.example', true)
    expect(filteringExemptFor('https://shop.example/x', off)).toBe(true)
    const on = withSiteExemption(off, 'shop.example', false)
    expect(filteringExemptFor('https://shop.example/x', on)).toBe(false)
  })
})
