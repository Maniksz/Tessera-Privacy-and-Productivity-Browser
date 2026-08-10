import { describe, expect, it } from 'vitest'
import { FilterEngine } from '@main/privacy/FilterEngine.js'
import type { DocumentFeatures } from '@shared/filters/features.js'
import { cosmeticRuleFor } from '@shared/filters/picker.js'
import { viewStylesheet } from '@shared/filters/preview-styles.js'
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

/**
 * The stylesheet one *view* is served: the engine's host-specific answer, plus whatever that
 * single view — and no other — is currently being shown on top of it.
 *
 * ## Why there is an addition at all
 *
 * `FilterEngine.replaceUserRules` is one slot for the whole program, fed from the rule store on
 * disk. Two things need a rule to reach exactly one place and cannot use it: the element picker's
 * **preview**, which must show in the tab being picked in and nowhere else, and the **session
 * rules** of a private window, which must not leak into the normal windows sharing the same engine.
 * Put either into the global slot and it applies everywhere; leave either out and it applies
 * nowhere. So the host-specific delivery gained a per-view addition, and this is the arithmetic
 * behind it (KTD3, R4, R20).
 *
 * ## Why the arithmetic is here rather than in `CosmeticInjector.ts`
 *
 * That file is on the coverage exclude list, because it speaks to `app.on('web-contents-created')`
 * and a live `WebContents`. Every decision it holds is a decision no test can reach. What is left
 * over there is the map from view to addition text and the send; everything that can be *wrong* —
 * which lines are honoured, in what order they are appended, what a revocation restores — is
 * asserted against the pure module below.
 */
const HOST_STYLES = '.host-specific { display: none !important; }'
const DOCUMENT = 'https://example.com/article'

describe('the stylesheet a single view is served', () => {
  it('is the engine’s own answer, unchanged, when nothing is added to it', () => {
    /*
      The identity case, and it is the one everything else is measured against: a view with no
      preview and no session rules is served exactly what every other view on this host is served.
      Asserted against the engine's real output rather than a literal, so this cannot drift from
      what the injector actually has in hand.
    */
    const engine = engineFor()
    const hostStyles = engine.cosmeticStylesFor('https://example.com/')
    const result = viewStylesheet({ documentUrl: DOCUMENT, hostStyles })
    expect(result.css).toBe(hostStyles)
    expect(result.preview).toBeNull()
    expect(result.session).toBeNull()
  })

  it('appends the preview as a rule of its own rather than mixing it in', () => {
    /*
      Appended, not merged into the host rule's selector list. Merging would mean re-reading a
      string this module did not write — a second selector parser — and it would put a provisional
      selector inside the same all-or-nothing CSS rule as the site's working ones, where a selector
      the browser cannot read takes every one of them down with it.
    */
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      preview: cosmeticRuleFor('example.com', '.sponsored-row')
    })
    expect(result.css).toBe(`${HOST_STYLES}\n.sponsored-row { display: none !important; }`)
    expect(result.preview?.refused).toEqual([])
  })

  it('serves both additions, session first and preview last', () => {
    // Stable order, and this is the order: the session's rules are the standing ones, the preview
    // is the thing being tried on top of them.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      preview: 'example.com##.preview-target',
      session: 'example.com##.session-rule'
    })
    expect(result.css).toBe(
      [
        HOST_STYLES,
        '.session-rule { display: none !important; }',
        '.preview-target { display: none !important; }'
      ].join('\n')
    )
  })

  it('restores exactly the engine’s answer when the addition is taken away', () => {
    // Revoking is the same call with no addition text — there is deliberately no second route
    // back, because a second route is a second thing that can be forgotten.
    const withPreview = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      preview: 'example.com##.sponsored-row'
    })
    const revoked = viewStylesheet({ documentUrl: DOCUMENT, hostStyles: HOST_STYLES })
    expect(withPreview.css).not.toBe(HOST_STYLES)
    expect(revoked.css).toBe(HOST_STYLES)
  })

  it('is the addition alone when the host has no rules of its own', () => {
    // The common case for a picker: nothing on this site is filtered yet, which is why somebody is
    // pointing at a banner. `null` must not become the string "null", and must not leave a blank
    // line the next addition is appended after.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: null,
      preview: 'example.com##.sponsored-row'
    })
    expect(result.css).toBe('.sponsored-row { display: none !important; }')
  })

  it('treats an empty host stylesheet as no host stylesheet', () => {
    // `CosmeticInjector.refresh` sends `''` to mean "stop hiding", so an empty string reaches this
    // path as readily as a null does and has to compose the same way.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: '',
      preview: 'example.com##.sponsored-row'
    })
    expect(result.css).toBe('.sponsored-row { display: none !important; }')
  })

  it('computes the same text twice from the same host stylesheet', () => {
    /*
      Idempotence, stated as what it actually has to be: the function is pure and always takes the
      *engine's* stylesheet, never its own last answer. A caller that fed the previous result back
      in would grow the addition on every refresh, so the property worth pinning is that two
      identical calls produce two identical strings and the input is never the output.
    */
    const call = (): string | null =>
      viewStylesheet({
        documentUrl: DOCUMENT,
        hostStyles: HOST_STYLES,
        preview: 'example.com##.sponsored-row'
      }).css
    expect(call()).toBe(call())
  })
})

describe('what a view’s addition is not allowed to be', () => {
  it('refuses a line the rule store would refuse, and says so', () => {
    /*
      The preview runs the real injection path, so it must not also be a way around the rules that
      govern a *written* rule. Network syntax belongs to a blocking list rather than to an element
      picker, and `##+js(…)` is code to run in the page — neither becomes a selector because it was
      called provisional.
    */
    for (const line of [
      '||ads.example.com^',
      'example.com##+js(set-constant, x, true)',
      'nonsense'
    ]) {
      const result = viewStylesheet({
        documentUrl: DOCUMENT,
        hostStyles: HOST_STYLES,
        preview: line
      })
      expect(result.css, line).toBe(HOST_STYLES)
      expect(result.preview, line).toEqual({
        css: null,
        refused: [{ text: line, reason: 'unreadable' }]
      })
    }
  })

  it('refuses an exception, which appending cannot honour', () => {
    /*
      `#@#` cancels a selector somebody else contributed. The host stylesheet is finished text by the
      time it arrives here, so there is nothing to cancel — and taking the selector at face value
      would *hide* the very element the line asks to bring back. Refused rather than approximated.
    */
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      session: 'example.com#@#.host-specific'
    })
    expect(result.css).toBe(HOST_STYLES)
    expect(result.session?.refused).toEqual([
      { text: 'example.com#@#.host-specific', reason: 'exception' }
    ])
  })

  it('refuses a procedural rule, whose CSS prefix is not the rule', () => {
    // `.box:has-text(Anzeige)` reaches the page as a chain the procedural engine evaluates. The CSS
    // it starts from — `.box` — is a strictly broader selector, so writing that into a stylesheet
    // would hide every box on the page rather than the one with the word in it.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      preview: 'example.com##.box:has-text(Anzeige)'
    })
    expect(result.css).toBe(HOST_STYLES)
    expect(result.preview?.refused).toEqual([
      { text: 'example.com##.box:has-text(Anzeige)', reason: 'procedural' }
    ])
  })

  it('refuses a rule that is perfectly good somewhere else', () => {
    /*
      R20 from the other side. A preview cannot follow the page: the view navigates, the injector
      re-serves, and the rule the picker was holding is suddenly scoped to a host that is no longer
      open. It contributes nothing here, and it is reported rather than dropped in silence.
    */
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      preview: 'other.test##.sponsored-row'
    })
    expect(result.css).toBe(HOST_STYLES)
    expect(result.preview?.refused).toEqual([
      { text: 'other.test##.sponsored-row', reason: 'other-host' }
    ])
  })

  it('has no host to match a scoped rule against on a document that has none', () => {
    const result = viewStylesheet({
      documentUrl: 'about:blank',
      hostStyles: null,
      preview: 'example.com##.sponsored-row'
    })
    expect(result.css).toBeNull()
    expect(result.preview?.refused).toEqual([
      { text: 'example.com##.sponsored-row', reason: 'other-host' }
    ])
  })

  it('lets one unreadable line cost itself and not the rest of the addition', () => {
    /*
      The session editor's text is a list, and a list is where this matters: the rule somebody typed
      wrong sits between two that are right, and losing all three would look exactly like the
      browser ignoring them.
    */
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      session: ['example.com##.first', '||ads.example.com^', 'example.com##.second'].join('\n')
    })
    expect(result.css).toBe(`${HOST_STYLES}\n.first,\n.second { display: none !important; }`)
    expect(result.session?.refused).toEqual([{ text: '||ads.example.com^', reason: 'unreadable' }])
  })

  it('takes a rule the user scoped to nothing at all', () => {
    // A generic line is one the writer chose to write generically — this module is not the place to
    // second-guess it, and the session editor is a text box in which `##.x` is a legal thing to say.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: null,
      session: '##.everywhere'
    })
    expect(result.css).toBe('.everywhere { display: none !important; }')
  })

  it('reports nothing for the blank lines a rule list is joined with', () => {
    // `enabledUserRuleText` joins with newlines and produces `''` for an empty list, so both a blank
    // line and an empty text arrive here in ordinary use. Neither is a refusal.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      session: '\n  \nexample.com##.kept\n'
    })
    expect(result.css).toBe(`${HOST_STYLES}\n.kept { display: none !important; }`)
    expect(result.session).toEqual({
      css: '.kept { display: none !important; }',
      refused: []
    })
  })

  it('adds nothing for an empty addition text, and does not call it a refusal', () => {
    const result = viewStylesheet({ documentUrl: DOCUMENT, hostStyles: HOST_STYLES, session: '' })
    expect(result.css).toBe(HOST_STYLES)
    expect(result.session).toEqual({ css: null, refused: [] })
  })
})
