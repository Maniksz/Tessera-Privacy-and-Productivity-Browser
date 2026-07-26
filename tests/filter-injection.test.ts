import { describe, expect, it } from 'vitest'
import { FilterEngine } from '@main/privacy/FilterEngine.js'
import type { DocumentFeatures } from '@shared/filters/features.js'
import { cosmeticRuleFor } from '@shared/filters/picker.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * The engine's cosmetic half as the injector sees it: a per-document feed of generic
 * selectors, and the user's own rules alongside the downloaded ones.
 *
 * What is worth asserting here is the seam rather than the matching — the matching is
 * `filter-features.test.ts` and `filter-cosmetic.test.ts`. Three things can only go
 * wrong at this level: the setting has to be honoured live, the user's own rules have to
 * reach a page without a full recompile, and a user exception has to be able to cancel a
 * selector a *list* contributed, because that is the escape hatch for the day a filter
 * list breaks a site.
 */

const LIST = [
  '[Adblock Plus 2.0]',
  '##.ad-banner',
  '###AC_ad',
  '##.promo-rail',
  '##[data-ad-slot]',
  'example.com##.host-specific'
].join('\n')

function features(overrides: Partial<DocumentFeatures>): DocumentFeatures {
  return { classes: [], ids: [], tags: [], ...overrides }
}

function engineFor(
  options: { userRules?: string; settings?: Partial<SettingsSnapshot> } = {}
): FilterEngine {
  const settings = { ...defaultSettings(), ...options.settings }
  return new FilterEngine({
    lists: [LIST],
    getSettings: () => settings,
    ...(options.userRules === undefined ? {} : { userRules: options.userRules })
  })
}

describe('openCosmeticFeed', () => {
  it('sends only the selectors the document called for', () => {
    const feed = engineFor().openCosmeticFeed('https://news.example.org/article')
    const css = feed.take(features({ classes: ['ad-banner', 'headline'] }))
    expect(css).toContain('.ad-banner')
    expect(css).not.toContain('.promo-rail')
    // The residue rides along with the first answer; it cannot be narrowed by anything
    // a survey reports.
    expect(css).toContain('[data-ad-slot]')
    expect(css).toContain('display: none !important')
  })

  it('says nothing when a later survey brings nothing new', () => {
    const feed = engineFor().openCosmeticFeed('https://news.example.org/article')
    feed.take(features({ classes: ['ad-banner'] }))
    expect(feed.take(features({ classes: ['ad-banner'] }))).toBeNull()
  })

  it('answers again for a feature that appeared as the page grew', () => {
    const feed = engineFor().openCosmeticFeed('https://news.example.org/article')
    feed.take(features({ classes: ['ad-banner'] }))
    expect(feed.take(features({ ids: ['AC_ad'] }))).toBe('#AC_ad { display: none !important; }')
  })

  it('withholds the host-specific selectors, which are injected wholesale', () => {
    const engine = engineFor()
    const feed = engine.openCosmeticFeed('https://example.com/')
    expect(feed.take(features({ classes: ['host-specific'] }))).not.toContain('.host-specific')
    expect(engine.cosmeticStylesFor('https://example.com/')).toContain('.host-specific')
  })

  it('counts the bytes that actually reached the page', () => {
    const feed = engineFor().openCosmeticFeed('https://news.example.org/article')
    const css = feed.take(features({ classes: ['ad-banner'] }))!
    expect(feed.servedByteCount).toBe(css.length)
    expect(feed.servedSelectorCount).toBe(2)
  })

  it('stops injecting into an open document when the setting is switched off', () => {
    // Checked on every `take` rather than only when the feed opens, so a user turning
    // cosmetic filtering off is not told to reload every tab first.
    const live = { ...defaultSettings() }
    const engine = new FilterEngine({ lists: [LIST], getSettings: () => live })
    const feed = engine.openCosmeticFeed('https://news.example.org/article')
    expect(feed.take(features({ classes: ['ad-banner'] }))).not.toBeNull()
    live['privacy.cosmeticFiltering'] = false
    expect(feed.take(features({ ids: ['AC_ad'] }))).toBeNull()
  })

  it('has nothing to inject into a document with no host', () => {
    const feed = engineFor().openCosmeticFeed('about:blank')
    expect(feed.take(features({ classes: ['ad-banner'] }))).toBeNull()
    expect(feed.servedSelectorCount).toBe(0)
    expect(feed.servedByteCount).toBe(0)
  })

  it('reports what the generic set costs, and how much of it no survey can narrow', () => {
    const engine = engineFor()
    expect(engine.genericSelectorBytes).toBe(
      ['.ad-banner', '#AC_ad', '.promo-rail', '[data-ad-slot]'].reduce(
        (sum, selector) => sum + selector.length + 2,
        0
      )
    )
    expect(engine.unkeyedSelectorBytes).toBe('[data-ad-slot]'.length + 2)
  })
})

describe('the user’s own rules', () => {
  it('hides what a picker rule names, on the host it names', () => {
    const engine = engineFor({ userRules: cosmeticRuleFor('example.com', '.sponsored-row') })
    expect(engine.cosmeticStylesFor('https://example.com/')).toContain('.sponsored-row')
    expect(engine.cosmeticStylesFor('https://other.test/')).toBeNull()
    expect(engine.userRuleCount).toBe(1)
  })

  it('applies a change without recompiling the downloaded lists', () => {
    const engine = engineFor()
    const before = engine.networkRuleCount
    engine.replaceUserRules('example.com##.sponsored-row')
    expect(engine.cosmeticStylesFor('https://example.com/')).toContain('.sponsored-row')
    expect(engine.networkRuleCount).toBe(before)
    expect(engine.cosmeticRuleCount).toBe(5)
  })

  it('lets a user exception cancel a selector a list contributed', () => {
    // The escape hatch. A list hides something the site needs; without this the user's
    // only recourse is switching the whole blocker off.
    const engine = engineFor({ userRules: 'example.com#@#.host-specific' })
    expect(engine.cosmeticStylesFor('https://example.com/')).toBeNull()
    // And only on the host the exception names.
    expect(engine.cosmeticSelectorsFor('https://elsewhere.test/').generic).toContain('.ad-banner')
  })

  it('lets a user exception cancel a generic selector the feed would have sent', () => {
    const engine = engineFor({ userRules: 'news.example.org#@#.ad-banner' })
    const feed = engine.openCosmeticFeed('https://news.example.org/article')
    expect(feed.take(features({ classes: ['ad-banner'] }))).not.toContain('.ad-banner')
    const elsewhere = engine.openCosmeticFeed('https://other.test/')
    expect(elsewhere.take(features({ classes: ['ad-banner'] }))).toContain('.ad-banner')
  })

  it('sends a generic rule the user wrote by hand through the feed as well', () => {
    const engine = engineFor({ userRules: '##.user-generic' })
    const feed = engine.openCosmeticFeed('https://news.example.org/article')
    expect(feed.take(features({ classes: ['user-generic'] }))).toContain('.user-generic')
  })

  it('leaves the lists alone when the user has no rules at all', () => {
    const engine = engineFor()
    expect(engine.userRuleCount).toBe(0)
    expect(engine.cosmeticSelectorsFor('https://example.com/').specific).toEqual(['.host-specific'])
  })

  it('is silent when cosmetic filtering is switched off', () => {
    const engine = engineFor({
      userRules: 'example.com##.sponsored-row',
      settings: { 'privacy.cosmeticFiltering': false }
    })
    expect(engine.cosmeticStylesFor('https://example.com/')).toBeNull()
    expect(engine.cosmeticSelectorsFor('https://example.com/')).toEqual({
      specific: [],
      generic: []
    })
  })
})
