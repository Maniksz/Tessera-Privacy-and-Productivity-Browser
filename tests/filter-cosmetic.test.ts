import { describe, expect, it } from 'vitest'
import { parseFilterLists } from '@shared/filters/parse.js'
import {
  buildCosmeticIndex,
  cosmeticCss,
  cosmeticSelectorsFor,
  hostChain,
  type CosmeticIndex,
  type CosmeticSelectors
} from '@shared/filters/cosmetic.js'

/**
 * Cosmetic filtering: which selectors apply to a host.
 *
 * The rules are real EasyList lines. The split between `specific` and `generic` is
 * asserted deliberately rather than incidentally: the default lists carry 28 916
 * generic selectors and 526 kB of selector text, so an injector that merged the two
 * halves would put that on every page load. Keeping them apart in the answer is the
 * only place that decision can be made honestly.
 */

function indexFrom(...lines: string[]): CosmeticIndex {
  return buildCosmeticIndex(parseFilterLists([lines.join('\n')]).cosmetic)
}

function selectorsFor(index: CosmeticIndex, host: string): CosmeticSelectors {
  return cosmeticSelectorsFor(index, host)
}

describe('generic rules', () => {
  const index = indexFrom('###AC_ad', '###AD_160', '##.ad-banner')

  it('applies to every host', () => {
    for (const host of ['www.spiegel.de', 'news.ycombinator.com', 'localhost']) {
      expect(selectorsFor(index, host).generic, host).toEqual(['#AC_ad', '#AD_160', '.ad-banner'])
    }
  })

  it('never appears among the host-specific selectors', () => {
    // The distinction is the whole point of the split; merging them here would hide
    // the cost from the injector.
    expect(selectorsFor(index, 'www.spiegel.de').specific).toEqual([])
  })

  it('counts what it holds', () => {
    expect(index.ruleCount).toBe(3)
    expect(index.byHost.size).toBe(0)
  })
})

describe('host-scoped rules', () => {
  const index = indexFrom(
    'advfn.com###APS_300_X_600',
    'advfn.com###APS_BILLBOARD',
    'thetvdb.com###ATF',
    '###AC_ad'
  )

  it('applies on the host it names', () => {
    expect(selectorsFor(index, 'advfn.com').specific).toEqual(['#APS_300_X_600', '#APS_BILLBOARD'])
  })

  it('applies on a subdomain of it', () => {
    expect(selectorsFor(index, 'uk.advfn.com').specific).toEqual([
      '#APS_300_X_600',
      '#APS_BILLBOARD'
    ])
  })

  it('does not leak onto another host', () => {
    expect(selectorsFor(index, 'thetvdb.com').specific).toEqual(['#ATF'])
  })

  it('leaves the generic set untouched on every host', () => {
    expect(selectorsFor(index, 'thetvdb.com').generic).toEqual(['#AC_ad'])
    expect(selectorsFor(index, 'example.org').generic).toEqual(['#AC_ad'])
  })

  it('collects rules from every host in a comma-separated list', () => {
    const shared = indexFrom('afterdawn.com,download.fi,edukas.fi##.ad-top')
    expect(selectorsFor(shared, 'download.fi').specific).toEqual(['.ad-top'])
    expect(selectorsFor(shared, 'edukas.fi').specific).toEqual(['.ad-top'])
    expect(selectorsFor(shared, 'other.fi').specific).toEqual([])
  })
})

describe('cosmetic exceptions', () => {
  it('cancels a host-scoped selector on the host it names', () => {
    const index = indexFrom('advfn.com###APS_BILLBOARD', 'advfn.com#@##APS_BILLBOARD')
    expect(selectorsFor(index, 'advfn.com').specific).toEqual([])
  })

  it('cancels a generic selector on that host only', () => {
    // One list adds the rule, another says it breaks a particular site; neither
    // knows about the other, so the exception cancels the *selector*.
    const index = indexFrom('###ad-carousel', 'dez.ro#@##ad-carousel')
    expect(selectorsFor(index, 'dez.ro').generic).toEqual([])
    expect(selectorsFor(index, 'example.org').generic).toEqual(['#ad-carousel'])
  })

  it('cancels on a subdomain of the host it names', () => {
    const index = indexFrom('###ad-carousel', 'dez.ro#@##ad-carousel')
    expect(selectorsFor(index, 'www.dez.ro').generic).toEqual([])
  })

  it('cancels for every host in its list', () => {
    // The exception names an id selector, so the generic rule it cancels is the
    // id one — `#ad-top` and `.ad-top` are different selectors, not spellings.
    const index = indexFrom(
      '###ad-top-banner-placeholder',
      'afterdawn.com,download.fi,edukas.fi#@##ad-top-banner-placeholder'
    )
    expect(selectorsFor(index, 'download.fi').generic).toEqual([])
    expect(selectorsFor(index, 'unrelated.fi').generic).toEqual(['#ad-top-banner-placeholder'])
  })

  it('cancels everywhere when it names no host', () => {
    const index = indexFrom('###AC_ad', '#@##AC_ad')
    expect(selectorsFor(index, 'example.org').generic).toEqual([])
    expect(index.globalExceptions.has('#AC_ad')).toBe(true)
  })

  it('cancels only the selector it names', () => {
    const index = indexFrom('###AC_ad', '###AD_160', 'dez.ro#@##AC_ad')
    expect(selectorsFor(index, 'dez.ro').generic).toEqual(['#AD_160'])
  })

  it('collects several exceptions written for the same host', () => {
    const index = indexFrom(
      '###AC_ad',
      '###AD_160',
      '###AD_300',
      'dez.ro#@##AC_ad',
      'dez.ro#@##AD_160'
    )
    expect(selectorsFor(index, 'dez.ro').generic).toEqual(['#AD_300'])
  })

  it('merges exceptions from a host and from its parent domain', () => {
    const index = indexFrom('###AC_ad', '###AD_160', 'dez.ro#@##AC_ad', 'www.dez.ro#@##AD_160')
    expect(selectorsFor(index, 'www.dez.ro').generic).toEqual([])
    expect(selectorsFor(index, 'other.dez.ro').generic).toEqual(['#AD_160'])
  })
})

describe('host exclusions', () => {
  it('withholds a generic rule from a host it excludes', () => {
    const index = indexFrom('~mail.example.com##.ad-slot', '###AC_ad')
    expect(selectorsFor(index, 'mail.example.com').generic).toEqual(['#AC_ad'])
    // Rules with exclusions are appended after the unconditional ones, so the
    // order a page receives is stable across queries.
    expect(selectorsFor(index, 'www.example.com').generic).toEqual(['#AC_ad', '.ad-slot'])
  })

  it('withholds it from a subdomain of the excluded host too', () => {
    const index = indexFrom('~example.com##.ad-slot')
    expect(selectorsFor(index, 'mail.example.com').generic).toEqual([])
  })

  it('withholds a host-scoped rule from an excluded subdomain', () => {
    const index = indexFrom('example.com,~shop.example.com##.ad-slot')
    expect(selectorsFor(index, 'www.example.com').specific).toEqual(['.ad-slot'])
    expect(selectorsFor(index, 'shop.example.com').specific).toEqual([])
  })

  it('lets an exception cancel an excluding generic rule as well', () => {
    const index = indexFrom('~mail.example.com##.ad-slot', 'news.example.org#@#.ad-slot')
    expect(selectorsFor(index, 'news.example.org').generic).toEqual([])
    expect(selectorsFor(index, 'www.example.org').generic).toEqual(['.ad-slot'])
  })
})

describe('hostChain', () => {
  it('walks up to the registrable domain', () => {
    expect(hostChain('a.b.example.com')).toEqual(['a.b.example.com', 'b.example.com', 'example.com'])
  })

  it('stops short of the bare public suffix', () => {
    // `com##…` is not a rule anybody writes, and probing for it would cost a
    // lookup on every query.
    expect(hostChain('example.com')).toEqual(['example.com'])
  })

  it('handles a single-label host', () => {
    expect(hostChain('localhost')).toEqual(['localhost'])
  })

  it('lower-cases the host it was given', () => {
    expect(hostChain('WWW.Example.COM')).toEqual(['www.example.com', 'example.com'])
  })

  it('yields nothing for an empty host', () => {
    expect(hostChain('')).toEqual([])
  })
})

describe('cosmeticCss', () => {
  it('hides the selectors with a rule a page cannot outrank', () => {
    const css = cosmeticCss(['#APS_300_X_600', '.ad-banner'])
    expect(css).toBe('#APS_300_X_600,\n.ad-banner { display: none !important; }')
  })

  it('collapses the element rather than merely hiding it', () => {
    // `visibility: hidden` would leave a 250-pixel hole where the advert was.
    expect(cosmeticCss(['.ad'])).toContain('display: none')
  })

  it('returns null when there is nothing to hide', () => {
    // A null answer lets the caller skip the injection entirely.
    expect(cosmeticCss([])).toBeNull()
  })
})

describe('an empty index', () => {
  it('answers with nothing rather than throwing', () => {
    const empty = buildCosmeticIndex([])
    expect(selectorsFor(empty, 'example.com')).toEqual({ specific: [], generic: [] })
    expect(empty.ruleCount).toBe(0)
  })
})
