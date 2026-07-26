import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildCosmeticIndex,
  cosmeticCss,
  cosmeticSelectorsFor,
  openCosmeticFeed,
  type CosmeticIndex
} from '@shared/filters/cosmetic.js'
import {
  GenericFeatureCursor,
  buildGenericFeatureIndex,
  selectorKeyCandidatesOf,
  type DocumentFeatures,
  type GenericFeatureIndex
} from '@shared/filters/features.js'
import { parseFilterLists } from '@shared/filters/parse.js'

/**
 * The feature-keyed path to the generic cosmetic selectors.
 *
 * Two properties carry the whole design and both are asserted directly rather than
 * incidentally:
 *
 *   - **Nothing is lost.** A selector must be filed under a feature the page will
 *     actually report. The failure mode is silent — advertising that quietly comes
 *     back — so the cases where a naive scan gets it wrong (`:not()`, attribute
 *     values, selector lists, CSS escapes) each have a test of their own.
 *   - **Nothing is sent twice.** A page reports features again as it grows, and a
 *     second copy of 500 selectors is a second copy of the cost this index exists to
 *     avoid.
 */

function features(overrides: Partial<DocumentFeatures>): DocumentFeatures {
  return { classes: [], ids: [], tags: [], ...overrides }
}

function indexFrom(...lines: string[]): CosmeticIndex {
  return buildCosmeticIndex(parseFilterLists([lines.join('\n')]).cosmetic)
}

describe('selectorKeyCandidatesOf', () => {
  it('reads a class off a class selector', () => {
    expect(selectorKeyCandidatesOf('.ad-banner')).toEqual({
      classes: ['ad-banner'],
      ids: [],
      tags: []
    })
  })

  it('reads an id off an id selector', () => {
    expect(selectorKeyCandidatesOf('#AC_ad').ids).toEqual(['AC_ad'])
  })

  it('keeps the case of a class name', () => {
    // Class names are case-sensitive in HTML, so lower-casing here would file the
    // selector under a name no page ever reports.
    expect(selectorKeyCandidatesOf('.AdSlot').classes).toEqual(['AdSlot'])
  })

  it('lower-cases a tag name, which is what the page will report', () => {
    expect(selectorKeyCandidatesOf('IFRAME[data-ad]').tags).toEqual(['iframe'])
  })

  it('requires every part of a combinator chain', () => {
    const candidates = selectorKeyCandidatesOf('#wrap > .ad ~ span')
    expect(candidates.ids).toEqual(['wrap'])
    expect(candidates.classes).toEqual(['ad'])
    expect(candidates.tags).toEqual(['span'])
  })

  it('ignores what a pseudo-class argument names', () => {
    // `div:not(.sponsored)` needs no `.sponsored` in the document — it needs the
    // opposite. Filing it under that class would withhold it from exactly the pages
    // it applies to.
    const candidates = selectorKeyCandidatesOf('div:not(.sponsored)')
    expect(candidates.classes).toEqual([])
    expect(candidates.tags).toEqual(['div'])
  })

  it('ignores the branches of `:is()` too', () => {
    expect(selectorKeyCandidatesOf(':is(.a, .b)')).toEqual({ classes: [], ids: [], tags: [] })
  })

  it('ignores what an attribute value contains', () => {
    const candidates = selectorKeyCandidatesOf('a[href*="/promo/#ad.gif"]')
    expect(candidates).toEqual({ classes: [], ids: [], tags: ['a'] })
  })

  it('is not confused by a bracket inside a quoted attribute value', () => {
    expect(selectorKeyCandidatesOf('div[data-x="]"] .ad').classes).toEqual(['ad'])
    expect(selectorKeyCandidatesOf("div[data-x=']'] .ad").classes).toEqual(['ad'])
  })

  it('is not confused by a group inside a group', () => {
    // The inner `]` closes a bracket without ending the pseudo-class argument, so a
    // masker that treated every closing character as the end would read the rest of
    // `:not(…)` as ordinary selector text.
    expect(selectorKeyCandidatesOf('.rail:not([data-keep]) .ad').classes).toEqual(['rail', 'ad'])
  })

  it('keys a selector list on what every branch needs', () => {
    // A page with only `.a` still needs this selector injected, so `.a, .b` cannot be
    // keyed on either one.
    expect(selectorKeyCandidatesOf('.a, .b').classes).toEqual([])
    expect(selectorKeyCandidatesOf('.wrap .a, .wrap .b').classes).toEqual(['wrap'])
  })

  it('refuses to key a selector carrying a CSS escape', () => {
    // `.\31 23` is the class `123`; a scan that took the escape at face value would
    // read a tag named `23` out of it and file the selector under a key no page has.
    expect(selectorKeyCandidatesOf('.\\31 23')).toEqual({ classes: [], ids: [], tags: [] })
  })

  it('refuses an unbalanced selector rather than guessing', () => {
    expect(selectorKeyCandidatesOf('.ad)')).toEqual({ classes: [], ids: [], tags: [] })
    expect(selectorKeyCandidatesOf('.ad[data-x')).toEqual({ classes: [], ids: [], tags: [] })
    expect(selectorKeyCandidatesOf('a[href="x')).toEqual({ classes: [], ids: [], tags: [] })
  })

  it('sees through a pseudo-element to the id in front of it', () => {
    expect(selectorKeyCandidatesOf('#banner::before').ids).toEqual(['banner'])
  })

  it('finds nothing to key on in a universal selector', () => {
    expect(selectorKeyCandidatesOf('*')).toEqual({ classes: [], ids: [], tags: [] })
  })

  it('reads a non-ASCII class name, which CSS allows and EasyList uses', () => {
    expect(selectorKeyCandidatesOf('.реклама').classes).toEqual(['реклама'])
  })

  it('survives a stray separator with nothing after it', () => {
    expect(selectorKeyCandidatesOf('.').classes).toEqual([])
    expect(selectorKeyCandidatesOf('div|a').tags).toEqual(['div'])
  })
})

describe('buildGenericFeatureIndex', () => {
  it('files a class-bound selector under its class', () => {
    const index = buildGenericFeatureIndex(['.ad-banner', 'div.promo'])
    expect(index.byClass.get('ad-banner')).toEqual(['.ad-banner'])
    expect(index.byClass.get('promo')).toEqual(['div.promo'])
    expect(index.byId.size).toBe(0)
  })

  it('files an id-bound selector under its id', () => {
    const index = buildGenericFeatureIndex(['#AC_ad img'])
    expect(index.byId.get('AC_ad')).toEqual(['#AC_ad img'])
    expect(index.byTag.size).toBe(0)
  })

  it('falls back to the tag when there is no class or id', () => {
    // The third axis is what keeps the residue small: `iframe[...]` cannot matter to a
    // document with no iframe in it.
    const index = buildGenericFeatureIndex(['iframe[src*="/ads/"]'])
    expect(index.byTag.get('iframe')).toEqual(['iframe[src*="/ads/"]'])
    expect(index.unkeyed).toEqual([])
  })

  it('leaves a selector no survey can narrow in the residue', () => {
    const index = buildGenericFeatureIndex(['[data-ad-slot]', '.ad'])
    expect(index.unkeyed).toEqual(['[data-ad-slot]'])
    expect(index.unkeyedByteCount).toBe('[data-ad-slot]'.length + 2)
  })

  it('folds a selector two lists both carry', () => {
    const index = buildGenericFeatureIndex(['.ad-banner', '.ad-banner'])
    expect(index.selectorCount).toBe(1)
    expect(index.byClass.get('ad-banner')).toEqual(['.ad-banner'])
  })

  it('files each selector under the name fewest others share', () => {
    // Keying on the commonest name would put all four selectors under `ad`, so one
    // `class="ad"` on the page would drag in every one of them.
    const index = buildGenericFeatureIndex([
      '.ad',
      '.ad .promo-rail',
      '.ad .newsletter-bar',
      '.ad .sky-slot'
    ])
    expect(index.byClass.get('ad')).toEqual(['.ad'])
    expect(index.byClass.get('promo-rail')).toEqual(['.ad .promo-rail'])
    expect(index.byClass.get('sky-slot')).toEqual(['.ad .sky-slot'])
  })

  it('prefers a class or an id to a tag even when the tag is rarer', () => {
    // `object` occurs once and `ad` twice, but every document has a tag and few have a
    // given class: a tag key is close to always-on.
    const index = buildGenericFeatureIndex(['object.ad', '.ad'])
    expect(index.byClass.get('ad')).toEqual(['object.ad', '.ad'])
    expect(index.byTag.size).toBe(0)
  })

  it('breaks a tie towards the id, which a page holds one of', () => {
    const index = buildGenericFeatureIndex(['#top .rail'])
    expect(index.byId.get('top')).toEqual(['#top .rail'])
    expect(index.byClass.size).toBe(0)
  })

  it('counts the bytes it holds', () => {
    const index = buildGenericFeatureIndex(['.ad', '#promo'])
    expect(index.byteCount).toBe('.ad'.length + 2 + '#promo'.length + 2)
  })

  it('has nothing to say about an empty list', () => {
    const index = buildGenericFeatureIndex([])
    expect(index.selectorCount).toBe(0)
    expect(index.byteCount).toBe(0)
    expect(new GenericFeatureCursor(index).take(features({ classes: ['ad'] }))).toEqual([])
  })
})

describe('GenericFeatureCursor', () => {
  const index: GenericFeatureIndex = buildGenericFeatureIndex([
    '.ad-banner',
    '.promo-rail',
    '#AC_ad',
    'iframe[src*="/ads/"]',
    '[data-ad-slot]'
  ])

  it('answers only for the features it was given', () => {
    const cursor = new GenericFeatureCursor(index)
    expect(cursor.take(features({ classes: ['ad-banner'] }))).toEqual([
      '[data-ad-slot]',
      '.ad-banner'
    ])
  })

  it('sends the unnarrowable residue once, with the first answer', () => {
    const cursor = new GenericFeatureCursor(index)
    expect(cursor.take(features({}))).toEqual(['[data-ad-slot]'])
    expect(cursor.take(features({}))).toEqual([])
  })

  it('says nothing when asked about the same features again', () => {
    const cursor = new GenericFeatureCursor(index)
    cursor.take(features({ classes: ['ad-banner'], ids: ['AC_ad'] }))
    expect(cursor.take(features({ classes: ['ad-banner'], ids: ['AC_ad'] }))).toEqual([])
  })

  it('answers for a feature that appeared later', () => {
    const cursor = new GenericFeatureCursor(index)
    cursor.take(features({ classes: ['ad-banner'] }))
    expect(cursor.take(features({ classes: ['ad-banner', 'promo-rail'] }))).toEqual(['.promo-rail'])
  })

  it('never repeats a selector across a run of overlapping surveys', () => {
    // The realistic shape of the problem: an infinite list appends rows and the
    // injector surveys again, mostly seeing what it saw before.
    const cursor = new GenericFeatureCursor(index)
    const surveys: DocumentFeatures[] = [
      features({ classes: ['ad-banner'] }),
      features({ classes: ['ad-banner', 'promo-rail'], tags: ['div'] }),
      features({ classes: ['promo-rail'], ids: ['AC_ad'], tags: ['div', 'iframe'] }),
      features({ classes: ['ad-banner', 'promo-rail'], ids: ['AC_ad'], tags: ['iframe'] })
    ]
    const served = surveys.flatMap((survey) => cursor.take(survey))
    expect(served).toEqual([...new Set(served)])
    expect(served).toHaveLength(index.selectorCount)
    expect(cursor.servedSelectorCount).toBe(index.selectorCount)
    expect(cursor.servedByteCount).toBe(index.byteCount)
  })

  it('answers nothing for a feature no selector needs', () => {
    const cursor = new GenericFeatureCursor(index)
    cursor.take(features({}))
    expect(cursor.take(features({ classes: ['site-header'], ids: ['main'] }))).toEqual([])
  })
})

describe('openCosmeticFeed', () => {
  it('withholds every generic selector the document does not call for', () => {
    const index = indexFrom('##.ad-banner', '###AC_ad', '##.promo-rail')
    const feed = openCosmeticFeed(index, 'www.spiegel.de')
    expect(feed.take(features({ classes: ['ad-banner'] }))).toEqual(['.ad-banner'])
    expect(feed.servedSelectorCount).toBe(1)
  })

  it('costs a fraction of the whole generic set for a page with one ad slot', () => {
    const index = indexFrom('##.ad-banner', '###AC_ad', '##.promo-rail', '##.sky-slot')
    const everything = cosmeticCss(cosmeticSelectorsFor(index, 'example.com').generic)!
    const feed = openCosmeticFeed(index, 'example.com')
    feed.take(features({ classes: ['ad-banner'], tags: ['div', 'span'] }))
    expect(feed.servedByteCount).toBeLessThan(everything.length / 2)
  })

  it('never hands over a selector an exception cancelled on this host', () => {
    const index = indexFrom('##.ad-banner', 'spiegel.de#@#.ad-banner')
    expect(
      openCosmeticFeed(index, 'www.spiegel.de').take(features({ classes: ['ad-banner'] }))
    ).toEqual([])
    expect(
      openCosmeticFeed(index, 'example.com').take(features({ classes: ['ad-banner'] }))
    ).toEqual(['.ad-banner'])
  })

  it('respects a `#@#` exception with no host at all', () => {
    const index = indexFrom('##.ad-banner', '#@#.ad-banner')
    expect(
      openCosmeticFeed(index, 'example.com').take(features({ classes: ['ad-banner'] }))
    ).toEqual([])
  })

  it('delivers a generic rule with `~host` exclusions everywhere else', () => {
    const index = indexFrom('~mail.example.com##.ad-slot')
    expect(
      openCosmeticFeed(index, 'www.example.com').take(features({ classes: ['ad-slot'] }))
    ).toEqual(['.ad-slot'])
    expect(
      openCosmeticFeed(index, 'mail.example.com').take(features({ classes: ['ad-slot'] }))
    ).toEqual([])
  })

  it('hands over a selector that is both unconditional and excluded only once', () => {
    // Two lists, one writing `##.ad-slot` and the other `~mail.example.com##.ad-slot`.
    // The broader rule already applies everywhere, so the narrower one adds nothing —
    // and a page receiving the selector twice pays twice.
    const index = indexFrom('##.ad-slot', '~mail.example.com##.ad-slot')
    expect(
      openCosmeticFeed(index, 'www.example.com').take(features({ classes: ['ad-slot'] }))
    ).toEqual(['.ad-slot'])
  })

  it('keeps an excluding generic rule out of the shared index', () => {
    // It has to be resolved against the host before it can be keyed, so it cannot live
    // in the index every document shares.
    const index = indexFrom('~mail.example.com##.ad-slot')
    expect(index.genericFeatures.selectorCount).toBe(0)
    expect(index.genericExcludingExtra).toHaveLength(1)
  })

  it('reports nothing for a host-specific rule, which is injected wholesale', () => {
    // The feed is the generic half only; `cosmeticStylesFor` already delivers the
    // host's own rules the moment the document commits.
    const index = indexFrom('example.com##.ad-slot')
    expect(openCosmeticFeed(index, 'example.com').take(features({ classes: ['ad-slot'] }))).toEqual(
      []
    )
    expect(cosmeticSelectorsFor(index, 'example.com').specific).toEqual(['.ad-slot'])
  })

  it('accumulates what it has served across surveys', () => {
    const index = indexFrom('##.ad-banner', '##.promo-rail')
    const feed = openCosmeticFeed(index, 'example.com')
    feed.take(features({ classes: ['ad-banner'] }))
    feed.take(features({ classes: ['ad-banner', 'promo-rail'] }))
    expect(feed.servedSelectorCount).toBe(2)
    expect(feed.servedByteCount).toBe('.ad-banner'.length + 2 + '.promo-rail'.length + 2)
  })
})

/**
 * Size measurement against the real lists.
 *
 * Skipped unless `OWNBROWSER_FILTER_CORPUS` names one or more list files, because a
 * test that downloads 5 MB is not a unit test and a fixture that large does not belong
 * in the repository. It is here rather than in a script so the figures quoted in the
 * documentation come from the shipped code and can be reproduced:
 *
 *   OWNBROWSER_FILTER_CORPUS=/path/easylist.txt,/path/easyprivacy.txt pnpm vitest run
 */
const corpus = (process.env['OWNBROWSER_FILTER_CORPUS'] ?? '')
  .split(',')
  .map((path) => path.trim())
  .filter((path) => path !== '' && existsSync(path))

describe.skipIf(corpus.length === 0)('the real lists', () => {
  const bodies = corpus.map((path) => readFileSync(path, 'utf8'))
  const index = buildCosmeticIndex(parseFilterLists(bodies).cosmetic)
  const keyed = index.genericFeatures

  /** A plausible census of one news page: what its markup would report. */
  const pageFeatures = features({
    tags: [
      'html',
      'head',
      'body',
      'div',
      'span',
      'a',
      'p',
      'img',
      'ul',
      'li',
      'h1',
      'h2',
      'h3',
      'section',
      'article',
      'aside',
      'nav',
      'header',
      'footer',
      'form',
      'input',
      'button',
      'script',
      'style',
      'link',
      'meta',
      'iframe',
      'svg',
      'path',
      'picture',
      'source',
      'figure',
      'figcaption',
      'time',
      'strong',
      'em',
      'table',
      'tr',
      'td',
      'ins'
    ],
    classes: [
      'container',
      'wrapper',
      'content',
      'main',
      'sidebar',
      'header',
      'footer',
      'nav',
      'menu',
      'logo',
      'search',
      'article',
      'teaser',
      'headline',
      'byline',
      'lead',
      'body-text',
      'paragraph',
      'image',
      'caption',
      'credit',
      'button',
      'btn',
      'link',
      'list',
      'item',
      'row',
      'col',
      'grid',
      'card',
      'badge',
      'icon',
      'avatar',
      'meta',
      'tag',
      'breadcrumb',
      'pagination',
      'newsletter',
      'social',
      'share',
      'comment',
      'related',
      'recommended',
      'video',
      'gallery',
      'slider',
      'banner',
      'ad',
      'ads',
      'advert',
      'advertisement',
      'ad-slot',
      'ad-container',
      'sponsored',
      'promo',
      'paywall',
      'cookie-banner',
      'consent',
      'overlay',
      'modal',
      'tooltip',
      'dropdown',
      'accordion',
      'tab',
      'panel',
      'form',
      'input',
      'label',
      'select',
      'checkbox',
      'radio',
      'toolbar',
      'breaking',
      'live',
      'ticker',
      'weather',
      'stocks',
      'sports',
      'politics',
      'culture',
      'science'
    ],
    ids: [
      'root',
      'app',
      'main',
      'content',
      'header',
      'footer',
      'nav',
      'sidebar',
      'search',
      'searchform',
      'logo',
      'masthead',
      'article',
      'comments',
      'respond',
      'newsletter',
      'banner',
      'ad',
      'ads',
      'adwrapper',
      'advertisement',
      'top-ad',
      'sky',
      'skyscraper',
      'leaderboard',
      'sidebar-ad',
      'footer-ad',
      'cookie-consent',
      'paywall',
      'modal',
      'overlay',
      'video-player',
      'social',
      'share',
      'related',
      'tags',
      'breadcrumb',
      'pagination',
      'wrapper',
      'container'
    ]
  })

  it('holds every generic selector under a class, an id, a tag, or none', () => {
    const filed =
      [...keyed.byClass.values()].reduce((sum, bucket) => sum + bucket.length, 0) +
      [...keyed.byId.values()].reduce((sum, bucket) => sum + bucket.length, 0) +
      [...keyed.byTag.values()].reduce((sum, bucket) => sum + bucket.length, 0) +
      keyed.unkeyed.length
    expect(filed).toBe(keyed.selectorCount)
  })

  it('sends a small fraction of the corpus to a page that reports ordinary markup', () => {
    const feed = openCosmeticFeed(index, 'www.spiegel.de')
    feed.take(pageFeatures)
    const whole = cosmeticCss(cosmeticSelectorsFor(index, 'www.spiegel.de').generic) ?? ''

    const buckets = [...keyed.byClass.values(), ...keyed.byId.values(), ...keyed.byTag.values()]
      .map((bucket) => bucket.length)
      .sort((left, right) => right - left)
    const worstCase = buckets.slice(0, 100).reduce((sum, size) => sum + size, keyed.unkeyed.length)

    // Split apart, because the two axes behave completely differently and a single
    // figure hides it: the class and id keys are nearly perfect discriminators, while
    // the tag keys are close to always-on — every page has an `<a>` and an `<img>`, and
    // that is where the attribute-only selectors (`a[href*="/click?"]`) live.
    const namedOnly = openCosmeticFeed(index, 'www.spiegel.de')
    namedOnly.take(features({ classes: pageFeatures.classes, ids: pageFeatures.ids }))
    const tagOnly = openCosmeticFeed(index, 'www.spiegel.de')
    tagOnly.take(features({ tags: pageFeatures.tags }))

    const bucketList = (buckets: ReadonlyMap<string, readonly string[]>): string =>
      `${[...buckets.values()].reduce((sum, bucket) => sum + bucket.length, 0)} in ${buckets.size} buckets`

    console.log(
      [
        '',
        `lists                     ${corpus.length}`,
        `cosmetic rules            ${index.ruleCount}`,
        `generic selectors         ${keyed.selectorCount}`,
        `  class-keyed             ${bucketList(keyed.byClass)}`,
        `  id-keyed                ${bucketList(keyed.byId)}`,
        `  tag-keyed               ${bucketList(keyed.byTag)}`,
        `  unkeyed residue         ${keyed.unkeyed.length}`,
        `generic rules with ~host  ${index.genericExcluding.length} (${index.genericExcludingExtra.length} adding a selector)`,
        `whole generic stylesheet  ${(whole.length / 1000).toFixed(1)} kB`,
        `residue, sent to all      ${(keyed.unkeyedByteCount / 1000).toFixed(1)} kB`,
        `simulated news page       ${(feed.servedByteCount / 1000).toFixed(1)} kB for ${feed.servedSelectorCount} selectors`,
        `  from classes and ids    ${(namedOnly.servedByteCount / 1000).toFixed(1)} kB for ${namedOnly.servedSelectorCount}`,
        `  from tags               ${(tagOnly.servedByteCount / 1000).toFixed(1)} kB for ${tagOnly.servedSelectorCount}`,
        `largest single bucket     ${buckets.at(0) ?? 0} selectors`,
        `worst case, 100 buckets   ${worstCase} selectors`,
        ''
      ].join('\n')
    )

    // The claim the whole design rests on. A fifth is a deliberately loose bound: the
    // point is that this cannot quietly become "most of it" without a red test.
    expect(feed.servedByteCount).toBeLessThan(whole.length / 5)
    // And the residue, which every page pays whatever it contains, stays a rounding
    // error rather than becoming the problem again by another route.
    expect(keyed.unkeyedByteCount).toBeLessThan(whole.length / 20)
  })
})
