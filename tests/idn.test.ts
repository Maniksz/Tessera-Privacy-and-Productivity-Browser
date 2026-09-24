import { describe, expect, it } from 'vitest'
import { decodePunycode, displayHost } from '@shared/url/idn.js'

/**
 * How a host is shown on the HTTPS-only interstitial: in its own script where that cannot deceive, in
 * Punycode where it can.
 *
 * The encoded forms below are what the WHATWG parser (`domainToASCII`) produces for each name, checked
 * against Node's own decoder when the module was written.
 */

describe('decodePunycode', () => {
  it('decodes labels of one script and of several', () => {
    expect(decodePunycode('mnchen-3ya')).toBe('münchen')
    expect(decodePunycode('e1afmkfd')).toBe('пример')
    expect(decodePunycode('r8jz45g')).toBe('例え')
    expect(decodePunycode('3e0bk47br7k')).toBe('한국어')
    expect(decodePunycode('pypal-4ve')).toBe('pаypal')
    // Only basic code points before the delimiter: nothing to insert.
    expect(decodePunycode('ab-')).toBe('ab')
  })

  it('refuses a label that is not Punycode', () => {
    // Ends in the middle of a number.
    expect(decodePunycode('z')).toBeNull()
    // A character that is no base-36 digit.
    expect(decodePunycode('ab!c')).toBeNull()
    // A leading delimiter is a digit position, and `-` is no digit.
    expect(decodePunycode('-ab')).toBeNull()
    // A delta too large to be a real insertion.
    expect(decodePunycode('99999999')).toBeNull()
    // A code point past Unicode's last.
    expect(decodePunycode('in32g')).toBeNull()
  })
})

describe('displayHost', () => {
  it('shows a host of one script in that script', () => {
    expect(displayHost('xn--mnchen-3ya.de')).toBe('münchen.de')
    expect(displayHost('xn--e1afmkfd.xn--p1ai')).toBe('пример.рф')
    expect(displayHost('example.com')).toBe('example.com')
    expect(displayHost('EXAMPLE.com')).toBe('example.com')
    expect(displayHost('a-1.example')).toBe('a-1.example')
  })

  it('shows Japanese and Korean beside a Latin TLD, which is how they are written', () => {
    expect(displayHost('xn--r8jz45g.jp')).toBe('例え.jp')
    expect(displayHost('xn--3e0bk47br7k.kr')).toBe('한국어.kr')
  })

  it('keeps a Cyrillic look-alike of paypal.com in Punycode', () => {
    // `pаypal.com` with a Cyrillic `а`, and `раураl.com` with every letter but the `l` Cyrillic.
    expect(displayHost('xn--pypal-4ve.com')).toBe('xn--pypal-4ve.com')
    expect(displayHost('xn--l-7sba6dbr.com')).toBe('xn--l-7sba6dbr.com')
  })

  it('keeps Punycode for any other mixture, an unknown script, and a symbol', () => {
    // Greek beside Latin: safe here, but the rule cannot tell it from Cyrillic beside Latin.
    expect(displayHost('xn--hxargifdar.gr')).toBe('xn--hxargifdar.gr')
    // Ethiopic, which the table does not list.
    expect(displayHost('xn--9wdc.com')).toBe('xn--9wdc.com')
    // `a⁄b.com`: a fraction slash, the classic stand-in for `/`.
    expect(displayHost('xn--ab-c6t.com')).toBe('xn--ab-c6t.com')
  })

  it('keeps the whole host in Punycode when one label does not decode', () => {
    expect(displayHost('xn--mnchen-3ya.xn--z')).toBe('xn--mnchen-3ya.xn--z')
  })
})
