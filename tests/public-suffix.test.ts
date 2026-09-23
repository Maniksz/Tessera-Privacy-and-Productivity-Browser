import { domainToASCII } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configurePublicSuffixes,
  isPublicSuffix,
  registrableDomain,
  resetPublicSuffixes
} from '@shared/url/domain.js'
import {
  NO_PUBLIC_SUFFIX_HISTORY,
  PUBLIC_SUFFIX_MAX_BYTES,
  PUBLIC_SUFFIX_MAX_PRIVATE_REMOVED,
  PUBLIC_SUFFIX_MAX_REMOVED_FRACTION,
  PUBLIC_SUFFIX_MIN_RULES,
  checkPublicSuffixList,
  isOnlyPrivateLoss,
  parsePublicSuffixList,
  rulesOf,
  type PublicSuffixHistory,
  type PublicSuffixList
} from '@shared/url/public-suffix.js'
import {
  fillerPrivate,
  fixtureRules,
  fixtureText,
  withAdded,
  without,
  type FixtureRules
} from './public-suffix-fixture.js'

/**
 * The Public Suffix List's lookup, parser and checks (R5, R6).
 *
 * The lookup cases are the ones where a wrong answer offers a password to the wrong site; the check
 * cases are the ways a downloaded body can be something other than the list and still look like it.
 */

const parse = (rules: FixtureRules): PublicSuffixList =>
  parsePublicSuffixList(fixtureText(rules), domainToASCII)

const check = (rules: FixtureRules, history: PublicSuffixHistory = NO_PUBLIC_SUFFIX_HISTORY) =>
  checkPublicSuffixList(fixtureText(rules), domainToASCII, history).rejections

beforeEach(() => {
  resetPublicSuffixes()
})
afterEach(() => {
  resetPublicSuffixes()
})

describe('registrableDomain with the full list', () => {
  beforeEach(() => {
    configurePublicSuffixes(rulesOf(parse(fixtureRules())))
  })

  it('keeps bank.com.sg and evil.com.sg apart (AE3)', () => {
    expect(registrableDomain('bank.com.sg')).toBe('bank.com.sg')
    expect(registrableDomain('login.bank.com.sg')).toBe('bank.com.sg')
    expect(registrableDomain('evil.com.sg')).not.toBe(registrableDomain('bank.com.sg'))
  })

  it('follows the wildcard *.kawasaki.jp and the exception !city.kawasaki.jp (AE3)', () => {
    // The wildcard makes `b.kawasaki.jp` a suffix, so the site is one label above it.
    expect(registrableDomain('a.b.kawasaki.jp')).toBe('a.b.kawasaki.jp')
    expect(registrableDomain('x.a.b.kawasaki.jp')).toBe('a.b.kawasaki.jp')
    // The exception prevails over the wildcard: `city.kawasaki.jp` is a site, under `kawasaki.jp`.
    expect(registrableDomain('city.kawasaki.jp')).toBe('city.kawasaki.jp')
    expect(registrableDomain('www.city.kawasaki.jp')).toBe('city.kawasaki.jp')
  })

  it('falls back to the implicit * rule for an unknown top-level domain', () => {
    expect(registrableDomain('www.example.unknowntld')).toBe('example.unknowntld')
  })

  it('returns a host that is itself a suffix unchanged', () => {
    expect(isPublicSuffix('b.kawasaki.jp')).toBe(true)
    // The parent of a wildcard is not a suffix by being one: `kawasaki.jp` is a site under `jp`.
    expect(isPublicSuffix('kawasaki.jp')).toBe(false)
    expect(registrableDomain('github.io')).toBe('github.io')
    expect(registrableDomain('co.uk')).toBe('co.uk')
    expect(registrableDomain('b.kawasaki.jp')).toBe('b.kawasaki.jp')
  })

  it('keeps the special cases: IP, localhost, a single label, a trailing dot', () => {
    expect(registrableDomain('192.168.1.1')).toBe('192.168.1.1')
    expect(registrableDomain('[::1]')).toBe('::1')
    expect(registrableDomain('localhost')).toBe('localhost')
    expect(registrableDomain('intranet')).toBe('intranet')
    expect(registrableDomain('www.bank.com.sg.')).toBe('bank.com.sg')
  })

  it('matches a Unicode rule against the Punycode host a URL produces', () => {
    // `公司.cn` is stored as Punycode, which is what `new URL` gives as a hostname.
    const host = new URL('https://www.example.公司.cn/').hostname
    expect(host).toBe('www.example.xn--55qx5d.cn')
    expect(registrableDomain(host)).toBe('example.xn--55qx5d.cn')
  })

  it('knows com.sg for a suffix now, and a site or an address for none', () => {
    expect(isPublicSuffix('com.sg')).toBe(true)
    expect(isPublicSuffix('bank.com.sg')).toBe(false)
    expect(isPublicSuffix('10.0.0.1')).toBe(false)
    // A single label is a site in its own right, the way `registrableDomain` treats it.
    expect(isPublicSuffix('intranet')).toBe(false)
  })
})

describe('isPublicSuffix on the bootstrap', () => {
  it('knows the bootstrap entries and not com.sg', () => {
    expect(isPublicSuffix('github.io')).toBe(true)
    expect(isPublicSuffix('com.sg')).toBe(false)
  })
})

describe('parsePublicSuffixList', () => {
  it('reads both sections and skips comments and blank lines', () => {
    const list = parse(fixtureRules())
    expect(list.structured).toBe(true)
    expect(list.icann).toContain('com.sg')
    expect(list.icann).toContain('*.kawasaki.jp')
    expect(list.icann).toContain('!city.kawasaki.jp')
    expect(list.private).toContain('github.io')
    expect(list.icann.some((rule) => rule.startsWith('//'))).toBe(false)
  })

  it('reads a rule up to the first whitespace, in lower case, across CRLF line ends', () => {
    const text = fixtureText({ icann: ['CO.UK   trailing words', '*.Kawasaki.JP'], private: [] })
    const list = parsePublicSuffixList(text.replace(/\n/g, '\r\n'), domainToASCII)
    expect(list.icann).toEqual(['co.uk', '*.kawasaki.jp'])
    expect(list.structured).toBe(true)
  })

  it('stores a Unicode rule as Punycode, and passes ASCII rules past the converter', () => {
    const toAscii = vi.fn(domainToASCII)
    const list = parsePublicSuffixList(
      fixtureText({ icann: ['рф', '!пример.рф', 'co.uk'], private: [] }),
      toAscii
    )
    expect(list.icann).toEqual(['xn--p1ai', '!xn--e1afmkfd.xn--p1ai', 'co.uk'])
    expect(toAscii).toHaveBeenCalledTimes(2)
  })

  it('leaves out a rule it cannot represent rather than failing the list', () => {
    const list = parsePublicSuffixList(
      fixtureText({ icann: ['a.*.b', 'ok.example', 'ünconvertible'], private: [] }),
      () => ''
    )
    expect(list.icann).toEqual(['ok.example'])
    expect(list.structured).toBe(true)
  })

  it('is not structured without all four markers in order', () => {
    const html = '<!doctype html>\n<html><body>Service unavailable</body></html>\n'
    expect(parsePublicSuffixList(html, domainToASCII).structured).toBe(false)

    const truncated = fixtureText(fixtureRules()).replace('// ===END PRIVATE DOMAINS===', '')
    expect(parsePublicSuffixList(truncated, domainToASCII).structured).toBe(false)

    const reordered = fixtureText(fixtureRules())
      .replace('// ===BEGIN ICANN DOMAINS===', '// ===PLACEHOLDER===')
      .replace('// ===BEGIN PRIVATE DOMAINS===', '// ===BEGIN ICANN DOMAINS===')
      .replace('// ===PLACEHOLDER===', '// ===BEGIN PRIVATE DOMAINS===')
    expect(parsePublicSuffixList(reordered, domainToASCII).structured).toBe(false)
  })

  it('is not structured with a rule outside the two sections', () => {
    const text = fixtureText(fixtureRules()).replace(
      '// ===BEGIN PRIVATE DOMAINS===',
      'stray.example\n// ===BEGIN PRIVATE DOMAINS==='
    )
    expect(parsePublicSuffixList(text, domainToASCII).structured).toBe(false)
  })
})

describe('checkPublicSuffixList: what it accepts', () => {
  it('accepts a well-formed list with no history', () => {
    expect(check(fixtureRules())).toEqual([])
  })

  it('accepts the same list against itself, and additions against it', () => {
    const list = parse(fixtureRules())
    const history = { current: list, baseline: list }
    expect(check(fixtureRules(), history)).toEqual([])
    expect(check(withAdded(fixtureRules(), 'icann', ['new.zz', '*.region.zz']), history)).toEqual(
      []
    )
  })

  it('accepts a wildcard on a country domain the bootstrap says nothing about, and keeps it', () => {
    // `*.ck` is in the fixture from the start; against a current list that has it, it is not new.
    const list = parse(fixtureRules())
    expect(check(fixtureRules(), { current: list, baseline: null })).toEqual([])
  })
})

describe('checkPublicSuffixList: what it refuses', () => {
  it('refuses a body over a megabyte before parsing it', () => {
    const verdict = checkPublicSuffixList(
      'x'.repeat(PUBLIC_SUFFIX_MAX_BYTES + 1),
      domainToASCII,
      NO_PUBLIC_SUFFIX_HISTORY
    )
    expect(verdict).toEqual({ list: null, rejections: ['too-large'] })
  })

  it('parses a body of exactly a megabyte', () => {
    const verdict = checkPublicSuffixList(
      'x'.repeat(PUBLIC_SUFFIX_MAX_BYTES),
      domainToASCII,
      NO_PUBLIC_SUFFIX_HISTORY
    )
    expect(verdict.rejections).toEqual(['structure'])
  })

  it('counts bytes, not characters', () => {
    // Three bytes each in UTF-8, so this is over the limit at a third of the characters.
    const text = '公'.repeat(Math.floor(PUBLIC_SUFFIX_MAX_BYTES / 3) + 1)
    expect(checkPublicSuffixList(text, domainToASCII, NO_PUBLIC_SUFFIX_HISTORY).rejections).toEqual(
      ['too-large']
    )
  })

  it('refuses an HTML page and a list without its END PRIVATE marker', () => {
    const html = '<html><body>302 Found</body></html>'
    expect(checkPublicSuffixList(html, domainToASCII, NO_PUBLIC_SUFFIX_HISTORY).rejections).toEqual(
      ['structure']
    )
    const truncated = fixtureText(fixtureRules()).replace('// ===END PRIVATE DOMAINS===', '')
    expect(
      checkPublicSuffixList(truncated, domainToASCII, NO_PUBLIC_SUFFIX_HISTORY).rejections
    ).toEqual(['structure'])
  })

  it('refuses fewer rules than the minimum', () => {
    const small = fixtureRules(PUBLIC_SUFFIX_MIN_RULES - 1000, 999)
    expect(check(small)).toEqual(['too-few-rules'])
    expect(check(fixtureRules(PUBLIC_SUFFIX_MIN_RULES - 1000, 1000))).toEqual([])
  })

  it('refuses an exception without the wildcard it is an exception to', () => {
    expect(check(withAdded(fixtureRules(), 'private', ['!foo.example.zz']))).toEqual([
      'orphan-exception'
    ])
    expect(check(withAdded(fixtureRules(), 'private', ['!zz']))).toEqual(['orphan-exception'])
  })

  it('refuses !github.io, which has no wildcard and would undo a bootstrap entry', () => {
    const rejections = check(withAdded(fixtureRules(), 'private', ['!github.io']))
    expect(rejections).toContain('orphan-exception')
    expect(rejections).toContain('bootstrap-override')
    expect(rejections).toContain('canary')
  })

  it('refuses an exception that undoes a bootstrap entry even with its wildcard present', () => {
    const rules = withAdded(fixtureRules(), 'private', ['*.amazonaws.com', '!s3.amazonaws.com'])
    expect(check(rules)).toEqual(['bootstrap-override'])
    // An exception *above* a bootstrap entry undoes it too, because an exception prevails over
    // the longer `s3.amazonaws.com` match.
    const above = withAdded(fixtureRules(), 'icann', ['*.com', '!amazonaws.com'])
    expect(check(above)).toContain('bootstrap-override')
    // An exception with its wildcard, nowhere near the bootstrap, is how the list is written.
    const ordinary = withAdded(fixtureRules(), 'private', ['*.hosting.com', '!www.hosting.com'])
    expect(check(ordinary)).toEqual([])
  })

  it('refuses *.com', () => {
    const rejections = check(withAdded(fixtureRules(), 'icann', ['*.com']))
    expect(rejections).toContain('tld-wildcard')
    expect(rejections).toContain('canary')
  })

  it('refuses a wildcard on a top-level domain the list in force does not have', () => {
    const current = parse(fixtureRules())
    const rules = withAdded(fixtureRules(), 'icann', ['*.zz'])
    expect(check(rules, { current, baseline: null })).toEqual(['tld-wildcard'])
    // On a first download there is nothing to be new against; `*.zz` covers no bootstrap entry.
    expect(check(rules)).toEqual([])
  })

  it('refuses a candidate without com.sg, against the list in force and on its own', () => {
    const current = parse(fixtureRules())
    const rules = without(fixtureRules(), ['com.sg'])
    expect(check(rules, { current, baseline: null })).toEqual(['icann-removed', 'canary'])
    expect(check(rules)).toEqual(['canary'])
  })

  it('refuses every canary that fails', () => {
    for (const removed of ['co.uk', 'github.io', '*.kawasaki.jp', '!city.kawasaki.jp']) {
      expect(check(without(fixtureRules(), [removed])), removed).toContain('canary')
    }
    // `www.example.com` → `example.com` fails once `example.com` is itself a suffix.
    expect(check(withAdded(fixtureRules(), 'private', ['example.com']))).toEqual(['canary'])
  })

  it('refuses 300 rules removed and 300 added: a set difference, not a count', () => {
    const baseline = parse(fixtureRules())
    const churned = withAdded(
      without(fixtureRules(), fillerPrivate(0, 300)),
      'private',
      fillerPrivate(10_000, 10_300)
    )
    expect(rulesOf(parse(churned))).toHaveLength(rulesOf(baseline).length)
    expect(check(churned, { current: null, baseline })).toEqual(['baseline-drift'])
  })

  it('allows exactly 2 % removed against the baseline', () => {
    const baseline = parse(fixtureRules())
    const limit = rulesOf(baseline).length * PUBLIC_SUFFIX_MAX_REMOVED_FRACTION
    const atLimit = without(fixtureRules(), fillerPrivate(0, limit))
    const overLimit = without(fixtureRules(), fillerPrivate(0, limit + 1))
    expect(check(atLimit, { current: null, baseline })).toEqual([])
    expect(check(overLimit, { current: null, baseline })).toEqual(['baseline-drift'])
  })

  it('refuses the second of seven deliveries that each drop 1.9 % against the baseline', () => {
    const original = fixtureRules()
    const baseline = parse(original)
    // 1.9 % of the 7 000 rules, all of them PRIVATE filler.
    const step = Math.floor(rulesOf(baseline).length * 0.019)
    expect(step).toBeLessThanOrEqual(PUBLIC_SUFFIX_MAX_PRIVATE_REMOVED)

    let current = baseline
    const verdicts: string[][] = []
    for (let delivery = 1; delivery <= 7; delivery++) {
      const rules = without(original, fillerPrivate(0, step * delivery))
      verdicts.push([...check(rules, { current, baseline })])
      current = parse(rules)
    }
    // The first loses only PRIVATE rules within the limit: held back, not refused.
    expect(verdicts[0]).toEqual(['private-removed'])
    // Every later one is measured against the baseline, not against its predecessor.
    for (const verdict of verdicts.slice(1)) expect(verdict).toContain('baseline-drift')
  })

  it('refuses ICANN rules removed against the list in force', () => {
    const current = parse(fixtureRules())
    const rules = without(fixtureRules(), ['i5.zz'])
    expect(check(rules, { current, baseline: null })).toEqual(['icann-removed'])
  })

  it('holds back PRIVATE rules removed within the limit, and refuses beyond it', () => {
    const current = parse(fixtureRules())
    const within = without(fixtureRules(), fillerPrivate(0, PUBLIC_SUFFIX_MAX_PRIVATE_REMOVED))
    const beyond = without(fixtureRules(), fillerPrivate(0, PUBLIC_SUFFIX_MAX_PRIVATE_REMOVED + 1))
    expect(check(within, { current, baseline: null })).toEqual(['private-removed'])
    expect(check(beyond, { current, baseline: null })).toEqual(['private-removed-beyond-limit'])
  })
})

describe('isOnlyPrivateLoss', () => {
  it('is true for private-removed alone and nothing else', () => {
    expect(isOnlyPrivateLoss(['private-removed'])).toBe(true)
    expect(isOnlyPrivateLoss([])).toBe(false)
    expect(isOnlyPrivateLoss(['canary'])).toBe(false)
    expect(isOnlyPrivateLoss(['private-removed', 'canary'])).toBe(false)
    expect(isOnlyPrivateLoss(['private-removed-beyond-limit'])).toBe(false)
  })
})
