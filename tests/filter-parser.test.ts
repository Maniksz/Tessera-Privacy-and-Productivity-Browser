import { describe, expect, it } from 'vitest'
import { parseFilterList, parseFilterLists } from '@shared/filters/parse.js'
import {
  RESOURCE_TYPE_BITS,
  accountedLines,
  filterResourceTypeOf,
  hostnameOfUrl,
  type NetworkRule
} from '@shared/filters/model.js'

/**
 * The filter-list parser.
 *
 * Every rule line here is copied from EasyList, EasyPrivacy or Fanboy's
 * Cookiemonster as published, not invented. Invented lines test the parser against
 * the reader's idea of the syntax; real ones test it against the syntax the lists
 * are actually written in, which is the only version that matters.
 *
 * The pivotal test is `accounts for every line it was given`. A blocker that
 * silently drops what it cannot parse understands less than the user believes and
 * nothing says so, which is the failure spec 4 warns about. Making the outcome
 * counters sum to the line count turns that from a promise into an assertion.
 */

function onlyRule(line: string): NetworkRule {
  const parsed = parseFilterList(line)
  expect(parsed.diagnostics.unsupported, `${line} was rejected`).toBe(0)
  expect(parsed.network).toHaveLength(1)
  return parsed.network[0]!
}

function reasonsFor(line: string): Record<string, number> {
  return parseFilterList(line).diagnostics.unsupportedByReason
}

describe('line classification', () => {
  it('accounts for every line it was given', () => {
    // A slice with one of everything: header, comments, blank, network rules,
    // cosmetic rules, and syntax this engine declines.
    const list = [
      '[Adblock Plus 2.0]',
      '! Version: 202607252041',
      '! Title: EasyList',
      '',
      '||ad.doubleclick.net^',
      '||0emm.com^$third-party',
      '@@||ads-static.conde.digital^$domain=wired.com',
      '/2x2.gif?$image',
      '###AC_ad',
      'advfn.com###APS_300_X_600',
      'dez.ro#@##ad-carousel',
      '&adb=y&adb=y^$popup',
      '/(https?:\\/\\/)104\\.154\\..{100,}/',
      'deliveroo.*#?#a[role="button"]:has(p:has-text(Sponsored))',
      '# a hosts-file comment',
      '0.0.0.0 tracker.example.com'
    ].join('\n')

    const { diagnostics } = parseFilterList(list)
    expect(diagnostics.lines).toBe(16)
    expect(accountedLines(diagnostics)).toBe(diagnostics.lines)
    expect(diagnostics.blank).toBe(1)
    expect(diagnostics.comments).toBe(4)
    expect(diagnostics.network).toBe(5)
    expect(diagnostics.cosmetic).toBe(3)
    expect(diagnostics.unsupported).toBe(3)
  })

  it('combines several list bodies into one set', () => {
    const parsed = parseFilterLists(['||ad.doubleclick.net^', '###AC_ad\n! comment'])
    expect(parsed.network).toHaveLength(1)
    expect(parsed.cosmetic).toHaveLength(1)
    expect(parsed.diagnostics.lines).toBe(3)
    expect(accountedLines(parsed.diagnostics)).toBe(3)
  })

  it('reads the Adblock Plus header as metadata rather than a rule', () => {
    expect(parseFilterList('[Adblock Plus 2.0]').diagnostics.comments).toBe(1)
  })

  it('reads a hosts-file comment as a comment, not a cosmetic rule', () => {
    // `#` opens both a hosts comment and the cosmetic separator, and getting this
    // backwards turns half a hosts file into selectors.
    const parsed = parseFilterList('# Blocklist compiled 2026-07-25')
    expect(parsed.diagnostics.comments).toBe(1)
    expect(parsed.cosmetic).toHaveLength(0)
  })

  it('trims surrounding whitespace before deciding anything', () => {
    expect(parseFilterList('   ||ad.doubleclick.net^  ').network).toHaveLength(1)
  })
})

describe('network patterns', () => {
  it('parses a host-anchored rule', () => {
    const rule = onlyRule('||ad.doubleclick.net^')
    expect(rule.parts).toEqual(['ad.doubleclick.net^'])
    expect(rule.hostAnchor).toBe(true)
    expect(rule.leftAnchor).toBe(false)
    expect(rule.rightAnchor).toBe(false)
    expect(rule.hasSeparator).toBe(true)
    expect(rule.isException).toBe(false)
    expect(rule.types).toBe(0)
  })

  it('keeps the original line so a block can be explained', () => {
    expect(onlyRule('||0emm.com^$third-party').raw).toBe('||0emm.com^$third-party')
  })

  it('recognises an exception', () => {
    const rule = onlyRule('@@||ads-static.conde.digital^$domain=wired.com')
    expect(rule.isException).toBe(true)
    expect(rule.includeDomains).toEqual(['wired.com'])
  })

  it('splits a wildcard into literal parts', () => {
    const rule = onlyRule('://2ip.*/member_photo/$third-party')
    expect(rule.parts).toEqual(['://2ip.', '/member_photo/'])
  })

  it('records an end anchor', () => {
    const rule = onlyRule('/oo/cl.js|$~third-party')
    expect(rule.rightAnchor).toBe(true)
    expect(rule.parts).toEqual(['/oo/cl.js'])
  })

  it('records a start anchor', () => {
    const rule = onlyRule('|http://example.com/ads')
    expect(rule.leftAnchor).toBe(true)
    expect(rule.hostAnchor).toBe(false)
    expect(rule.parts).toEqual(['http://example.com/ads'])
  })

  it('drops an anchor a neighbouring wildcard has already made vacuous', () => {
    // `|*ads` is "start, then anything, then ads", which is an unanchored `ads`.
    // Keeping the anchor would pin `ads` to position 0 and match nothing.
    const rule = onlyRule('|*ads')
    expect(rule.leftAnchor).toBe(false)
    expect(rule.parts).toEqual(['ads'])

    const trailing = onlyRule('ads*|')
    expect(trailing.rightAnchor).toBe(false)
  })

  it('lower-cases the pattern, because matching is case-insensitive by default', () => {
    expect(onlyRule('||Ad.DoubleClick.NET^').parts).toEqual(['ad.doubleclick.net^'])
  })

  it('leaves the case alone for a match-case rule', () => {
    const rule = onlyRule('/Ads.gif$match-case')
    expect(rule.matchCase).toBe(true)
    expect(rule.parts).toEqual(['/Ads.gif'])
  })

  it('reduces a pattern of nothing but wildcards to no parts at all', () => {
    // `*$domain=…` is a legitimate "block everything here" rule; its constraint is
    // entirely in its options.
    const rule = onlyRule('*$domain=example.com')
    expect(rule.parts).toEqual([])
  })
})

describe('network options', () => {
  it('reads a resource type', () => {
    expect(onlyRule('/2x2.gif?$image').types).toBe(RESOURCE_TYPE_BITS.image)
  })

  it('reads several types as one mask', () => {
    const rule = onlyRule(
      '&http_referer=$script,xmlhttprequest,domain=~biletomat.pl|~facebook.com|~jobscore.com'
    )
    expect(rule.types).toBe(RESOURCE_TYPE_BITS.script | RESOURCE_TYPE_BITS.xmlhttprequest)
    expect(rule.excludeDomains).toEqual(['biletomat.pl', 'facebook.com', 'jobscore.com'])
    expect(rule.includeDomains).toEqual([])
  })

  it('reads a negated type', () => {
    const rule = onlyRule('/get/live/web/_/*$script,~third-party')
    expect(rule.types).toBe(RESOURCE_TYPE_BITS.script)
    expect(rule.thirdParty).toBe(false)
  })

  it('accepts the older and shorter type spellings the lists use', () => {
    expect(onlyRule('&ad_box_$css').types).toBe(RESOURCE_TYPE_BITS.stylesheet)
    expect(onlyRule('&ad_box_$frame').types).toBe(RESOURCE_TYPE_BITS.subdocument)
    expect(onlyRule('&ad_box_$xhr').types).toBe(RESOURCE_TYPE_BITS.xmlhttprequest)
    expect(onlyRule('&ad_box_$doc').types).toBe(RESOURCE_TYPE_BITS.document)
    expect(onlyRule('&ad_box_$beacon').types).toBe(RESOURCE_TYPE_BITS.ping)
    expect(onlyRule('&ad_box_$object-subrequest').types).toBe(RESOURCE_TYPE_BITS.object)
  })

  it('records a negated type as an exclusion, not as a permitted type', () => {
    const rule = onlyRule('&ad_box_$~image')
    expect(rule.types).toBe(0)
    expect(rule.excludedTypes).toBe(RESOURCE_TYPE_BITS.image)
  })

  it('reads third-party in both directions', () => {
    expect(onlyRule('||0emm.com^$third-party').thirdParty).toBe(true)
    expect(onlyRule('/code/e.js|$~third-party').thirdParty).toBe(false)
    expect(onlyRule('&ad_box_$3p').thirdParty).toBe(true)
    expect(onlyRule('&ad_box_$first-party').thirdParty).toBe(false)
    expect(onlyRule('&ad_box_$~first-party').thirdParty).toBe(true)
    expect(onlyRule('&ad_box_$1p').thirdParty).toBe(false)
  })

  it('leaves third-party unset when the rule does not mention it', () => {
    expect(onlyRule('||ad.doubleclick.net^').thirdParty).toBeNull()
  })

  it('reads a domain list with inclusions and exclusions', () => {
    const rule = onlyRule('||yimg.com/aaq/vzm/$script,domain=news.yahoo.com')
    expect(rule.includeDomains).toEqual(['news.yahoo.com'])
    expect(rule.excludeDomains).toEqual([])
  })

  it('reads an exclusion-only domain list', () => {
    expect(onlyRule('/adobe-analytics-$domain=~business.adobe.com').excludeDomains).toEqual([
      'business.adobe.com'
    ])
  })

  it('accepts uBlock’s `from=` as a spelling of `domain=`', () => {
    expect(onlyRule('&ad_box_$from=example.com').includeDomains).toEqual(['example.com'])
  })

  it('ignores an empty entry in a domain list', () => {
    // A trailing separator is a typo, not a domain, and treating it as one would
    // put an entry in the list that matches nothing and reads like a bug.
    expect(onlyRule('&ad_box_$domain=example.com|').includeDomains).toEqual(['example.com'])
    expect(parseFilterList('example.com,,other.example##.ad-slot').cosmetic[0]!.includeHosts).toEqual([
      'example.com',
      'other.example'
    ])
  })

  it('reads important', () => {
    const rule = onlyRule('||clarity.ms/tag/$important,script,domain=phileweb.com')
    expect(rule.important).toBe(true)
  })

  it('treats a dollar the pattern owns as pattern text', () => {
    // A trailing `$` cannot be an option list, so the rule keeps it. Splitting
    // here would turn a working rule into one that can never match.
    const rule = onlyRule('||example.com/price$')
    expect(rule.parts).toEqual(['example.com/price$'])
  })
})

describe('counted rather than swallowed', () => {
  it('counts an option it knows about and does not implement', () => {
    // `$popup` is 3 038 lines of EasyList. Treating it as a plain block would
    // cancel every `t.co` link; the honest outcome is a skipped rule and a number.
    expect(reasonsFor('&adb=y&adb=y^$popup')).toEqual({ 'unsupported-option:popup': 1 })
    expect(reasonsFor('@@||jetzt.de^$generichide')).toEqual({
      'unsupported-option:generichide': 1
    })
    expect(
      reasonsFor(
        '||googletagmanager.com/gtag/js$important,redirect=googletagmanager_gtm.js,script,xmlhttprequest,domain=redstoneonline.jp'
      )
    ).toEqual({ 'unsupported-option:redirect': 1 })
  })

  it('counts an option it has never heard of separately', () => {
    // A newer syntax should be distinguishable from a deliberate omission.
    expect(reasonsFor('&ad_box_$somethingnew=1')).toEqual({ 'unknown-option:somethingnew': 1 })
  })

  it('counts a bare `domain` with no value as unusable', () => {
    expect(reasonsFor('&ad_box_$domain')).toEqual({ 'unknown-option:domain': 1 })
    expect(reasonsFor('&ad_box_$~domain=example.com')).toEqual({ 'unknown-option:domain': 1 })
  })

  it('counts a regular-expression pattern', () => {
    // Compiling one from a downloaded list would put an attacker-supplied pattern
    // in the hot path of every request.
    expect(reasonsFor('/(https?:\\/\\/)104\\.154\\..{100,}/')).toEqual({ 'regex-pattern': 1 })
    expect(
      reasonsFor('/^https?:\\/\\/146\\.59\\.211\\.(\\d){1,3}.*/$popup,third-party')
    ).toEqual({ 'regex-pattern': 1 })
  })

  it('counts an entity domain, which needs a public-suffix expansion', () => {
    expect(reasonsFor('||cacheserve.com^$domain=example.*')).toEqual({ 'domain-entity': 1 })
    expect(reasonsFor('crazygames.*##[class*="MpuContainer_"]')).toEqual({ 'domain-entity': 1 })
  })

  it('counts a rule with no pattern left to match on', () => {
    expect(reasonsFor('$script')).toEqual({ 'empty-pattern': 1 })
    expect(reasonsFor('|')).toEqual({ 'empty-pattern': 1 })
    expect(reasonsFor('||')).toEqual({ 'empty-pattern': 1 })
  })

  it('counts an extended cosmetic selector', () => {
    expect(reasonsFor('deliveroo.*#?#a[role="button"]:has(p:has-text(Sponsored))')).toEqual({
      'extended-cosmetic': 1
    })
    expect(reasonsFor('example.com#@?#.ad:has-text(Ad)')).toEqual({ 'extended-cosmetic': 1 })
  })

  it('counts a cosmetic snippet or CSS injection', () => {
    expect(reasonsFor('example.com#$#body { overflow: auto !important; }')).toEqual({
      'cosmetic-snippet': 1
    })
    expect(reasonsFor('example.com#%#//scriptlet("abort-on-property-read", "x")')).toEqual({
      'cosmetic-snippet': 1
    })
  })

  it('counts a cosmetic rule with nothing to hide', () => {
    expect(reasonsFor('example.com##')).toEqual({ 'cosmetic-empty-selector': 1 })
  })

  it('adds up repeated reasons rather than overwriting them', () => {
    const parsed = parseFilterList('&popunder=$popup\n&cbiframe=$popup')
    expect(parsed.diagnostics.unsupportedByReason).toEqual({ 'unsupported-option:popup': 2 })
    expect(parsed.diagnostics.unsupported).toBe(2)
  })
})

describe('cosmetic rules', () => {
  it('parses a generic rule', () => {
    const rule = parseFilterList('###AC_ad').cosmetic[0]!
    expect(rule.selector).toBe('#AC_ad')
    expect(rule.includeHosts).toEqual([])
    expect(rule.isException).toBe(false)
  })

  it('parses a host-scoped rule', () => {
    const rule = parseFilterList('advfn.com###APS_300_X_600').cosmetic[0]!
    expect(rule.selector).toBe('#APS_300_X_600')
    expect(rule.includeHosts).toEqual(['advfn.com'])
  })

  it('parses an exception', () => {
    const rule = parseFilterList(
      'afterdawn.com,download.fi,edukas.fi#@##ad-top-banner-placeholder'
    ).cosmetic[0]!
    expect(rule.isException).toBe(true)
    expect(rule.selector).toBe('#ad-top-banner-placeholder')
    expect(rule.includeHosts).toEqual(['afterdawn.com', 'download.fi', 'edukas.fi'])
  })

  it('parses host exclusions', () => {
    const rule = parseFilterList('~mail.example.com##.ad-slot').cosmetic[0]!
    expect(rule.includeHosts).toEqual([])
    expect(rule.excludeHosts).toEqual(['mail.example.com'])
  })

  it('lower-cases hosts but never the selector', () => {
    // Selectors are case-sensitive: `#APS_300_X_600` is not `#aps_300_x_600`.
    const rule = parseFilterList('ADVFN.com###APS_300_X_600').cosmetic[0]!
    expect(rule.includeHosts).toEqual(['advfn.com'])
    expect(rule.selector).toBe('#APS_300_X_600')
  })

  it('does not mistake a regular expression containing a hash for a selector', () => {
    // A `/…/` rule may contain `#`, and reading it as a cosmetic separator would
    // turn a network rule into a selector for a host that is really a pattern.
    const parsed = parseFilterList('/tracker\\.php#id=/')
    expect(parsed.cosmetic).toHaveLength(0)
    expect(parsed.diagnostics.unsupportedByReason).toEqual({ 'regex-pattern': 1 })
  })
})

describe('hosts-file lines', () => {
  it('turns an unroutable address into the host rule it stands for', () => {
    const parsed = parseFilterList('0.0.0.0 tracker.example.com')
    expect(parsed.network).toHaveLength(1)
    expect(parsed.network[0]!.parts).toEqual(['tracker.example.com^'])
    expect(parsed.network[0]!.hostAnchor).toBe(true)
    expect(parsed.diagnostics.network).toBe(1)
  })

  it('accepts the other loopback spellings', () => {
    expect(parseFilterList('127.0.0.1 ads.example.com').network).toHaveLength(1)
    expect(parseFilterList('::1 ads.example.com').network).toHaveLength(1)
    expect(parseFilterList(':: ads.example.com').network).toHaveLength(1)
  })

  it('takes every name on the line', () => {
    const parsed = parseFilterList('0.0.0.0 a.example.com b.example.com # why')
    expect(parsed.network.map((rule) => rule.parts[0])).toEqual([
      'a.example.com^',
      'b.example.com^'
    ])
    // One line, however many rules it produced: the counters account for lines.
    expect(parsed.diagnostics.network).toBe(1)
  })

  it('refuses to block the machine’s own names', () => {
    // Every hosts file starts with these, and turning them into rules would make
    // `localhost` unreachable. Counted, so the line is not silently gone.
    const parsed = parseFilterList('127.0.0.1 localhost\n::1 ip6-localhost ip6-loopback')
    expect(parsed.network).toHaveLength(0)
    expect(parsed.diagnostics.unsupportedByReason).toEqual({ 'hosts-loopback-name': 2 })
    expect(accountedLines(parsed.diagnostics)).toBe(2)
  })
})

describe('resource type translation', () => {
  it('maps Electron’s names onto the list vocabulary', () => {
    expect(filterResourceTypeOf('mainFrame')).toBe('document')
    expect(filterResourceTypeOf('subFrame')).toBe('subdocument')
    expect(filterResourceTypeOf('xhr')).toBe('xmlhttprequest')
    expect(filterResourceTypeOf('webSocket')).toBe('websocket')
    expect(filterResourceTypeOf('favicon')).toBe('image')
  })

  it('calls anything unrecognised `other` rather than guessing', () => {
    // A new Chromium release adds resource names; mapping one to something
    // plausible would apply rules the list author never scoped to it.
    expect(filterResourceTypeOf('cspReport')).toBe('other')
    expect(filterResourceTypeOf('somethingNewIn2027')).toBe('other')
  })

  it('gives every type its own bit', () => {
    const bits = Object.values(RESOURCE_TYPE_BITS)
    expect(new Set(bits).size).toBe(bits.length)
  })
})

describe('hostnameOfUrl', () => {
  it('lower-cases the host', () => {
    expect(hostnameOfUrl('https://Ads.Example.COM/x')).toBe('ads.example.com')
  })

  it('returns null when there is no host to speak of', () => {
    expect(hostnameOfUrl('data:text/html,<p>x')).toBeNull()
    expect(hostnameOfUrl('not a url')).toBeNull()
  })
})
