import { describe, expect, it } from 'vitest'
import { parseFilterLists } from '@shared/filters/parse.js'
import {
  buildNetworkIndex,
  matchNetworkRequest,
  safeTokensOf,
  type NetworkIndex
} from '@shared/filters/network.js'
import type { FilterResourceType } from '@shared/filters/model.js'

/**
 * Network matching.
 *
 * The rule lines are taken from the published EasyList, EasyPrivacy and Fanboy
 * lists. The URLs are the kind a real page produces, because the mistakes worth
 * catching are asymmetric: a missed tracker is a privacy failure nobody sees, and
 * a false positive is a broken site the user blames on the browser. Both
 * directions are asserted for every rule shape here.
 */

function indexFrom(...lines: string[]): NetworkIndex {
  return buildNetworkIndex(parseFilterLists([lines.join('\n')]).network)
}

interface Ask {
  readonly documentUrl?: string | null
  readonly type?: FilterResourceType
}

function blocks(index: NetworkIndex, url: string, ask: Ask = {}): boolean {
  const match = matchNetworkRequest(index, {
    url,
    documentUrl: ask.documentUrl ?? null,
    type: ask.type ?? 'script'
  })
  return match?.blocked === true
}

function decidingRule(index: NetworkIndex, url: string, ask: Ask = {}): string | null {
  const match = matchNetworkRequest(index, {
    url,
    documentUrl: ask.documentUrl ?? null,
    type: ask.type ?? 'script'
  })
  return match === null ? null : match.rule.raw
}

describe('a plain block rule', () => {
  const index = indexFrom('||ad.doubleclick.net^')

  it('blocks the host it names', () => {
    expect(blocks(index, 'https://ad.doubleclick.net/ddm/ad?x=1', { type: 'image' })).toBe(true)
  })

  it('blocks a subdomain of it', () => {
    expect(blocks(index, 'https://static.ad.doubleclick.net/x.js')).toBe(true)
  })

  it('blocks it with nothing after the host at all', () => {
    // The end of the URL counts as a separator, so the `^` is satisfied.
    expect(blocks(index, 'https://ad.doubleclick.net')).toBe(true)
  })

  it('blocks it on a non-default port', () => {
    // `:` is a separator too, and the hostname index has to agree with the pattern
    // matcher about that rather than quietly disagree on odd ports.
    expect(blocks(index, 'https://ad.doubleclick.net:8443/x.js')).toBe(true)
  })

  it('leaves a different host alone', () => {
    expect(blocks(index, 'https://www.doubleclick.net/x.js')).toBe(false)
    expect(blocks(index, 'https://notad.doubleclick.net/x.js')).toBe(false)
  })

  it('is not fooled by the name appearing as a prefix of a longer label', () => {
    expect(blocks(index, 'https://ad.doubleclick.network/x.js')).toBe(false)
  })

  it('is not fooled by the name appearing to the left of the real host', () => {
    // `ad.doubleclick.net.evil.example` is a different site, and a `^` that matched
    // a dot would hand it every rule written for the real one.
    expect(blocks(index, 'https://ad.doubleclick.net.evil.example/x.js')).toBe(false)
  })

  it('does not match the name in a path or a query', () => {
    expect(blocks(index, 'https://example.com/redirect?to=ad.doubleclick.net')).toBe(false)
  })

  it('names the line that decided it', () => {
    expect(decidingRule(index, 'https://ad.doubleclick.net/x.js')).toBe('||ad.doubleclick.net^')
  })

  it('reports no match at all for an unrelated request', () => {
    expect(decidingRule(index, 'https://en.wikipedia.org/wiki/Berlin')).toBeNull()
  })
})

describe('a host anchor without the separator', () => {
  // `||example.com` and `||example.com^` are different rules, so the shortcut the
  // hostname index takes must not be applied to the first.
  const index = indexFrom('||umami.is')

  it('matches a longer label, as the syntax says it should', () => {
    expect(blocks(index, 'https://umami.island.example/x.js')).toBe(true)
  })

  it('still anchors to the host rather than matching anywhere', () => {
    expect(blocks(index, 'https://example.com/?ref=umami.is')).toBe(false)
  })
})

describe('an exception', () => {
  const index = indexFrom('||ad.linksynergy.com^', '@@||ad.linksynergy.com^$image')

  it('beats the block rule it overlaps', () => {
    expect(blocks(index, 'https://ad.linksynergy.com/pixel.gif', { type: 'image' })).toBe(false)
  })

  it('does not widen beyond what it says', () => {
    expect(blocks(index, 'https://ad.linksynergy.com/track.js', { type: 'script' })).toBe(true)
  })

  it('is named as the deciding rule when it wins', () => {
    expect(
      decidingRule(index, 'https://ad.linksynergy.com/pixel.gif', { type: 'image' })
    ).toBe('@@||ad.linksynergy.com^$image')
  })

  it('does nothing on its own', () => {
    const allowOnly = indexFrom('@@||ad.linksynergy.com^$image')
    expect(decidingRule(allowOnly, 'https://ad.linksynergy.com/pixel.gif', { type: 'image' })).toBeNull()
  })
})

describe('$important', () => {
  const index = indexFrom(
    '||clarity.ms/tag/$important,script,domain=phileweb.com',
    '@@||clarity.ms^'
  )

  it('outranks an exception', () => {
    expect(
      blocks(index, 'https://www.clarity.ms/tag/abc', {
        documentUrl: 'https://www.phileweb.com/news',
        type: 'script'
      })
    ).toBe(true)
  })

  it('leaves the exception in charge everywhere it does not apply', () => {
    expect(
      blocks(index, 'https://www.clarity.ms/tag/abc', {
        documentUrl: 'https://example.org/news',
        type: 'script'
      })
    ).toBe(false)
  })
})

describe('$third-party', () => {
  const index = indexFrom('||0emm.com^$third-party')

  it('blocks a cross-site request', () => {
    expect(
      blocks(index, 'https://t.0emm.com/pixel.gif', {
        documentUrl: 'https://news.example.org/article',
        type: 'image'
      })
    ).toBe(true)
  })

  it('leaves a same-site request alone', () => {
    expect(
      blocks(index, 'https://t.0emm.com/pixel.gif', {
        documentUrl: 'https://www.0emm.com/',
        type: 'image'
      })
    ).toBe(false)
  })

  it('compares registrable domains, not hostnames', () => {
    // `a.example.co.uk` and `b.example.co.uk` are one party; `evil.co.uk` is not.
    const uk = indexFrom('||example.co.uk^$third-party')
    expect(blocks(uk, 'https://a.example.co.uk/x.js', { documentUrl: 'https://b.example.co.uk/' })).toBe(
      false
    )
    expect(blocks(uk, 'https://a.example.co.uk/x.js', { documentUrl: 'https://evil.co.uk/' })).toBe(true)
  })

  it('treats a request with no known document as first-party', () => {
    // The reading that cannot over-block: with no document there is no cross-site
    // relationship to assert.
    expect(blocks(index, 'https://t.0emm.com/pixel.gif', { type: 'image' })).toBe(false)
  })

  it('treats an unparseable document as first-party for the same reason', () => {
    expect(
      blocks(index, 'https://t.0emm.com/pixel.gif', { documentUrl: 'not a url', type: 'image' })
    ).toBe(false)
  })
})

describe('$~third-party', () => {
  const index = indexFrom('/oo/cl.js|$~third-party')

  it('blocks a same-site request', () => {
    expect(
      blocks(index, 'https://www.example.com/oo/cl.js', {
        documentUrl: 'https://www.example.com/page'
      })
    ).toBe(true)
  })

  it('leaves a cross-site request alone', () => {
    expect(
      blocks(index, 'https://cdn.other.example/oo/cl.js', {
        documentUrl: 'https://www.example.com/page'
      })
    ).toBe(false)
  })
})

describe('$domain=', () => {
  const included = indexFrom('||yimg.com/aaq/vzm/$script,domain=news.yahoo.com')

  it('applies on a document the rule names', () => {
    expect(
      blocks(included, 'https://s.yimg.com/aaq/vzm/x.js', {
        documentUrl: 'https://news.yahoo.com/story'
      })
    ).toBe(true)
  })

  it('applies on a subdomain of one it names', () => {
    expect(
      blocks(included, 'https://s.yimg.com/aaq/vzm/x.js', {
        documentUrl: 'https://de.news.yahoo.com/story'
      })
    ).toBe(true)
  })

  it('does not apply anywhere else', () => {
    expect(
      blocks(included, 'https://s.yimg.com/aaq/vzm/x.js', {
        documentUrl: 'https://sports.yahoo.com/story'
      })
    ).toBe(false)
  })

  it('does not apply when the document is unknown', () => {
    expect(blocks(included, 'https://s.yimg.com/aaq/vzm/x.js')).toBe(false)
  })

  const excluded = indexFrom('/adobe-analytics-$domain=~business.adobe.com')

  it('applies everywhere an exclusion-only list does not name', () => {
    expect(
      blocks(excluded, 'https://cdn.example.org/adobe-analytics-1.js', {
        documentUrl: 'https://www.example.org/'
      })
    ).toBe(true)
  })

  it('stands down on a document its exclusion names', () => {
    expect(
      blocks(excluded, 'https://cdn.example.org/adobe-analytics-1.js', {
        documentUrl: 'https://business.adobe.com/products'
      })
    ).toBe(false)
  })

  it('applies with no document at all, having nothing to be excluded from', () => {
    expect(blocks(excluded, 'https://cdn.example.org/adobe-analytics-1.js')).toBe(true)
  })

  it('lets an exclusion override an inclusion on the same rule', () => {
    // Both lists are present, and the negated entry has to take precedence.
    const both = indexFrom('&ad_box_$domain=example.com|~shop.example.com')
    expect(blocks(both, 'https://cdn.x/a?&ad_box_=1', { documentUrl: 'https://www.example.com/' })).toBe(
      true
    )
    expect(
      blocks(both, 'https://cdn.x/a?&ad_box_=1', { documentUrl: 'https://shop.example.com/' })
    ).toBe(false)
  })
})

describe('resource types', () => {
  const index = indexFrom('/2x2.gif?$image')

  it('applies to the type it names', () => {
    expect(blocks(index, 'https://cdn.example.org/2x2.gif?id=1', { type: 'image' })).toBe(true)
  })

  it('does not apply to another type', () => {
    expect(blocks(index, 'https://cdn.example.org/2x2.gif?id=1', { type: 'script' })).toBe(false)
  })

  it('applies to any of several named types', () => {
    const several = indexFrom('&http_referer=$script,xmlhttprequest')
    expect(blocks(several, 'https://x.example/a?&http_referer=b', { type: 'script' })).toBe(true)
    expect(blocks(several, 'https://x.example/a?&http_referer=b', { type: 'xmlhttprequest' })).toBe(true)
    expect(blocks(several, 'https://x.example/a?&http_referer=b', { type: 'image' })).toBe(false)
  })

  it('honours a negated type as an exclusion from everything else', () => {
    const negated = indexFrom('&ad_box_$~image')
    expect(blocks(negated, 'https://x.example/a?&ad_box_=1', { type: 'script' })).toBe(true)
    expect(blocks(negated, 'https://x.example/a?&ad_box_=1', { type: 'image' })).toBe(false)
  })

  it('applies to every type when the rule names none', () => {
    const any = indexFrom('||ad.doubleclick.net^')
    for (const type of ['document', 'image', 'websocket', 'other'] as const) {
      expect(blocks(any, 'https://ad.doubleclick.net/x', { type }), type).toBe(true)
    }
  })
})

describe('anchors and wildcards', () => {
  it('honours a start anchor', () => {
    const index = indexFrom('|http://example.com/ads')
    expect(blocks(index, 'http://example.com/ads/banner.js')).toBe(true)
    // Same substring, but not at the start.
    expect(blocks(index, 'https://cdn.other/?u=http://example.com/ads')).toBe(false)
  })

  it('honours an end anchor', () => {
    const index = indexFrom('/oo/cl.js|$~third-party')
    const document = 'https://www.example.com/page'
    expect(blocks(index, 'https://www.example.com/oo/cl.js', { documentUrl: document })).toBe(true)
    expect(blocks(index, 'https://www.example.com/oo/cl.js?v=2', { documentUrl: document })).toBe(false)
  })

  it('finds a later occurrence when the end anchor needs one', () => {
    // The leftmost match ends mid-URL; only the second satisfies the anchor.
    const index = indexFrom('/oo/cl.js|$~third-party')
    expect(
      blocks(index, 'https://www.example.com/oo/cl.js?next=/oo/cl.js', {
        documentUrl: 'https://www.example.com/page'
      })
    ).toBe(true)
  })

  it('matches across a wildcard', () => {
    const index = indexFrom('://2ip.*/member_photo/$third-party')
    const document = 'https://forum.example.org/thread'
    expect(blocks(index, 'https://2ip.ru/member_photo/1.jpg', { documentUrl: document })).toBe(true)
    expect(blocks(index, 'https://2ip.io/x/member_photo/1.jpg', { documentUrl: document })).toBe(true)
    expect(blocks(index, 'https://2ip.ru/avatar/1.jpg', { documentUrl: document })).toBe(false)
  })

  it('keeps the parts in order across a wildcard', () => {
    const index = indexFrom('://2ip.*/member_photo/$third-party')
    expect(
      blocks(index, 'https://member_photo.example/2ip.foo/', {
        documentUrl: 'https://forum.example.org/thread'
      })
    ).toBe(false)
  })

  it('combines a wildcard with an end anchor', () => {
    const index = indexFrom('||umami.*/script.js|$script')
    expect(blocks(index, 'https://umami.is/script.js')).toBe(true)
    expect(blocks(index, 'https://umami.example.com/x/script.js')).toBe(true)
    expect(blocks(index, 'https://umami.is/script.js?v=2')).toBe(false)
  })

  it('anchors a wildcard rule to the host as well', () => {
    const index = indexFrom('||cloudfront.net*/sp.js|')
    expect(blocks(index, 'https://d1.cloudfront.net/a/sp.js')).toBe(true)
    expect(blocks(index, 'https://example.org/?u=cloudfront.net/a/sp.js')).toBe(false)
  })

  it('treats a separator placeholder inside a host-anchored pattern as one', () => {
    const index = indexFrom('||tagtray.com/api^$third-party')
    const document = 'https://shop.example.org/'
    expect(blocks(index, 'https://www.tagtray.com/api/v1', { documentUrl: document })).toBe(true)
    expect(blocks(index, 'https://www.tagtray.com/api?x=1', { documentUrl: document })).toBe(true)
    // The end of the URL counts as a separator too.
    expect(blocks(index, 'https://www.tagtray.com/api', { documentUrl: document })).toBe(true)
    // Neither `.` nor `_` is one, so those are different paths entirely.
    expect(blocks(index, 'https://www.tagtray.com/api.json', { documentUrl: document })).toBe(false)
    expect(blocks(index, 'https://www.tagtray.com/api_v2', { documentUrl: document })).toBe(false)
  })

  it('handles a separator placeholder in an unanchored pattern', () => {
    // No anchor, so the pattern has to be found by scanning — the slow path, which
    // only nineteen rules in the default lists take.
    const index = indexFrom('-logging.nextmedia.com^')
    expect(blocks(index, 'https://cdn.example.org/x/-logging.nextmedia.com/beacon')).toBe(true)
    expect(blocks(index, 'https://cdn.example.org/x/-logging.nextmedia.computer')).toBe(false)
  })

  it('handles a pattern that opens with a separator placeholder', () => {
    const index = indexFrom('^endpoint=track^$image')
    expect(blocks(index, 'https://x.example/log?endpoint=track&id=1', { type: 'image' })).toBe(true)
    // `.` is not a separator, so the leading `^` has nothing to stand on here.
    expect(blocks(index, 'https://x.example/log.endpoint=track&id=1', { type: 'image' })).toBe(false)
    expect(blocks(index, 'https://x.example/plain.gif', { type: 'image' })).toBe(false)
  })

  it('does not let the end of the URL satisfy a placeholder mid-pattern', () => {
    // The end of the URL is a separator, but only for a `^` the pattern ends on.
    // A `^` with more pattern after it has to find a real character.
    const index = indexFrom('||tagtray.com/api^v1')
    expect(blocks(index, 'https://www.tagtray.com/api/v1')).toBe(true)
    expect(blocks(index, 'https://www.tagtray.com/api')).toBe(false)
  })

  it('matches a pattern that is nothing but options', () => {
    const index = indexFrom('*$domain=ads.example.org')
    expect(
      blocks(index, 'https://anything.example/whatever.png', {
        documentUrl: 'https://ads.example.org/'
      })
    ).toBe(true)
    expect(
      blocks(index, 'https://anything.example/whatever.png', { documentUrl: 'https://other.example/' })
    ).toBe(false)
  })
})

describe('$match-case', () => {
  const index = indexFrom('/Ads.gif$match-case')

  it('matches the case the rule was written in', () => {
    expect(blocks(index, 'https://cdn.example.org/Ads.gif')).toBe(true)
  })

  it('does not match another casing', () => {
    expect(blocks(index, 'https://cdn.example.org/ads.gif')).toBe(false)
  })

  it('is the exception: matching is otherwise case-insensitive', () => {
    const insensitive = indexFrom('/tracking.gif')
    expect(blocks(insensitive, 'https://cdn.example.org/Tracking.GIF')).toBe(true)
  })

  it('still knows an upper-case letter is not a separator', () => {
    // The one path that compares against the URL as it arrived, so it is the only
    // place where a capital can reach the separator test at all.
    const index = indexFrom('/Ads^$match-case')
    expect(blocks(index, 'https://cdn.example.org/Ads?id=1')).toBe(true)
    expect(blocks(index, 'https://cdn.example.org/AdsBanner.js')).toBe(false)
  })

  it('treats a character beyond ASCII as a separator', () => {
    // Chromium hands over punycode hosts and percent-encoded paths, so this only
    // arises from a caller passing a raw URL. Answering "separator" is the reading
    // that cannot over-block, and the matcher must stay total over its input.
    const index = indexFrom('/api^')
    expect(blocks(index, 'https://cdn.example.org/apiä')).toBe(true)
  })
})

describe('URLs with no host to anchor to', () => {
  const index = indexFrom('||ad.doubleclick.net^')

  it('never matches a host-anchored rule against a data URL', () => {
    expect(blocks(index, 'data:image/gif;base64,ad.doubleclick.net')).toBe(false)
  })

  it('leaves an internal page alone', () => {
    expect(blocks(index, 'tessera://start')).toBe(false)
  })

  it('does not choke on an IPv6 literal', () => {
    expect(blocks(index, 'https://[2001:db8::1]/x.js')).toBe(false)
    // With a port, so the colon that ends the host is not one of the address's own.
    expect(blocks(index, 'https://[::1]:8080/x.js')).toBe(false)
  })

  it('matches a bare IP host the list names', () => {
    const ip = indexFrom('||34.215.155.61^')
    expect(blocks(ip, 'https://34.215.155.61/beacon')).toBe(true)
    expect(blocks(ip, 'https://34.215.155.62/beacon')).toBe(false)
  })
})

describe('rules the token index cannot file', () => {
  // `/b/s/beacon` has one token, `beacon`, and the pattern does not pin its right
  // edge — the rule has to match `…/b/s/beaconlogger.js`, whose own token is
  // `beaconlogger`. Filing it under `beacon` would lose it silently, so it goes to
  // the fallback bucket instead.
  const index = indexFrom('/b/s/beacon')

  it('still matches when the URL token is longer than the pattern token', () => {
    expect(blocks(index, 'https://cdn.example.org/b/s/beaconlogger.js')).toBe(true)
  })

  it('still matches the exact form', () => {
    expect(blocks(index, 'https://cdn.example.org/b/s/beacon')).toBe(true)
  })

  it('goes to the fallback bucket rather than a token bucket', () => {
    expect(index.block.untokenised).toHaveLength(1)
    expect(index.block.byToken.size).toBe(0)
  })
})

describe('safeTokensOf', () => {
  function tokens(line: string): readonly string[] {
    const rules = parseFilterLists([line]).network
    expect(rules).toHaveLength(1)
    return safeTokensOf(rules[0]!)
  }

  it('takes a token the host anchor pins on the left', () => {
    expect(tokens('||ad.doubleclick.net^')).toEqual(['doubleclick', 'net'])
  })

  it('skips runs shorter than three characters', () => {
    // `||ad.gt^` has nothing long enough, which is why 84 rules in the default
    // lists end up in the fallback bucket.
    expect(tokens('||ad.gt^')).toEqual([])
  })

  it('refuses a token an unanchored pattern edge leaves open', () => {
    expect(tokens('/b/s/beacon')).toEqual([])
  })

  it('accepts a token only the end anchor pins', () => {
    expect(tokens('://plausible.*/api/event|')).toEqual(['plausible', 'api', 'event'])
    // Same rule without the anchor: `event` sits at an open pattern edge again.
    expect(tokens('://plausible.*/api/event')).toEqual(['plausible', 'api'])
  })

  it('skips a token whose only runs are two characters long', () => {
    expect(tokens('/oo/cl.js|$~third-party')).toEqual([])
  })

  it('refuses a token a wildcard sits beside', () => {
    // `://2ip.*/member_photo/`: `2ip` is pinned by `.`, `member_photo` by the
    // slashes; nothing is filed under a fragment adjacent to the `*`.
    expect(tokens('://2ip.*/member_photo/$third-party')).toEqual(['2ip', 'member', 'photo'])
  })

  it('lower-cases a match-case rule’s pattern before looking for tokens', () => {
    // Scanning the pattern as written would find the fragment `dvert` inside
    // `Advert`, judge it pinned, and file the rule under a token no URL produces.
    expect(tokens('/Advert.gif$match-case')).toEqual(['advert'])
    expect(tokens('/Ads.gif$match-case')).toEqual(['ads'])
  })
})

describe('the index itself', () => {
  const index = indexFrom(
    '||ad.doubleclick.net^',
    '||td.doubleclick.net^',
    '@@||ad.linksynergy.com^$image',
    '||clarity.ms/tag/$important,script',
    '/b/s/beacon'
  )

  it('separates blocks, exceptions and important blocks', () => {
    expect(index.block.size).toBe(3)
    expect(index.allow.size).toBe(1)
    expect(index.important.size).toBe(1)
    expect(index.ruleCount).toBe(5)
  })

  it('files plain host rules in the hostname map, not under a token', () => {
    expect([...index.block.byHost.keys()].sort()).toEqual([
      'ad.doubleclick.net',
      'td.doubleclick.net'
    ])
  })

  it('groups two rules with the same host under one key', () => {
    const shared = indexFrom('||example.com^$script', '||example.com^$image')
    expect(shared.block.byHost.get('example.com')).toHaveLength(2)
  })

  it('groups two rules with the same token under one key', () => {
    const shared = indexFrom('&adservertag=$script', '&adservertag=$image')
    expect([...shared.block.byToken.values()].flat()).toHaveLength(2)
  })

  it('files a rule under its rarest token rather than its first', () => {
    // `com` appears in both rules and `adservertag` in one, so the shared token
    // must not be the one that decides where either rule lives.
    const shared = indexFrom('||example.com/adservertag/', '||other.com/pixel/')
    expect(shared.block.byToken.has('com')).toBe(false)
  })

  it('is empty for an empty list', () => {
    const empty = buildNetworkIndex([])
    expect(empty.ruleCount).toBe(0)
    expect(matchNetworkRequest(empty, {
      url: 'https://ad.doubleclick.net/x',
      documentUrl: null,
      type: 'script'
    })).toBeNull()
  })
})
