import { describe, expect, it } from 'vitest'
import {
  isProceduralSelector,
  parseProceduralSelector,
  type ProceduralSelector
} from '@shared/filters/procedural.js'
import {
  applyProceduralRules,
  matchProcedural,
  textMatcher,
  type MatchableDocument
} from '@shared/filters/procedural-match.js'
import {
  buildProceduralIndex,
  proceduralSelectorsFor
} from '@shared/filters/procedural-index.js'
import { parseFilterList } from '@shared/filters/parse.js'
import { asProceduralSelectors } from '@shared/filters/injection.js'

/**
 * Procedural cosmetic selectors — the ones no CSS engine can evaluate.
 *
 * ## Why the file needs a DOM
 *
 * Every other filter test is pure: a rule in, a decision out. These are not, and cannot be made so without
 * making them meaningless — `:has-text()` asks about an element's text, `:upward()` about its ancestry,
 * `:matches-css()` about its *computed* style. So this file runs in happy-dom and builds real documents,
 * which is also the only way to catch the mistakes that matter here: an `:upward(1)` that returns the
 * element instead of its parent passes any test written against a fake tree the author also invented.
 *
 * ## Where the syntax comes from
 *
 * uBlock Origin's *Procedural cosmetic filters* and AdGuard's *ExtendedCss*, read rather than guessed —
 * a filter list is written against theirs, so an invented dialect would be a feature that works on nothing.
 * Three of their rules are load-bearing and each has a test below: an action operator comes last, extended
 * pseudo-classes come after the standard part, and a procedural filter must name a host.
 */

/** The parsed selector, or a failure the test can report as one rather than as a type error. */
function selectorOf(text: string): ProceduralSelector {
  const parsed = parseProceduralSelector(text)
  if ('problem' in parsed) throw new Error(`${text} was refused: ${parsed.problem}`)
  return parsed
}

/**
 * A selector with no steps, for the tests that are about the *action* rather than the matching.
 *
 * Built directly rather than parsed, because `parseProceduralSelector` refuses a selector with no operator in
 * it — correctly: a plain `.ad` belongs on the declarative path, and routing it through the matcher would be
 * script doing what a stylesheet does. The action tests still need a selector that reaches an element, so
 * they name the shape instead of asking the parser for something it should not give them.
 */
const hideOnly = (css: string): ProceduralSelector => ({
  css,
  steps: [],
  action: { kind: 'hide' }
})

/** A document built from markup, as the matcher sees it. */
function documentOf(html: string): MatchableDocument {
  document.body.innerHTML = html
  return document as unknown as MatchableDocument
}

const problemOf = (text: string): string => {
  const parsed = parseProceduralSelector(text)
  return 'problem' in parsed ? parsed.problem : 'accepted'
}

describe('telling a procedural selector from a CSS one', () => {
  it('recognises the operators that need an engine', () => {
    expect(isProceduralSelector('.box:has-text(Advert)')).toBe(true)
    expect(isProceduralSelector('.item:upward(2)')).toBe(true)
    expect(isProceduralSelector('.a:style(height: 0)')).toBe(true)
  })

  it('leaves ordinary CSS alone, including the pseudo-classes that look procedural', () => {
    /*
      The direction that must not fail. `:has()` is *605 uses* in the three default lists and is native CSS
      now; `:not()` and the `nth-` family likewise. Reading one of those as procedural would move tens of
      thousands of rules from a stylesheet the browser matches onto script re-run on every mutation burst.
    */
    for (const selector of [
      '.ad',
      'div:has(> .sponsor)',
      '.ad:not(.keep)',
      'li:nth-child(2n)',
      '[data-ad="1"]',
      '.a > .b + .c',
      '.promo::before'
    ]) {
      expect(isProceduralSelector(selector), selector).toBe(false)
    }
  })

  it('is not fooled by a colon inside a string or an escape', () => {
    // `selector-safety.ts` had to learn both of these too: `[title=":has-text"]` is a string token, and
    // `.md\:flex` is one class whose name contains a colon.
    expect(isProceduralSelector('[title=":has-text(x)"]')).toBe(false)
    expect(isProceduralSelector('.md\\:flex')).toBe(false)
  })

  it('does not read a nested operator as a step of the chain', () => {
    /*
      `div:has(.a:has-text(b))` is uBO's *procedural* `:has`, whose argument is itself a chain. The top-level
      operator is `:has`, which is CSS — so this is not the shape this engine accepts. What it must not do is
      see `has-text` and treat it as a step, which would evaluate it against the wrong set of elements.
    */
    expect(isProceduralSelector('div:has(.a:has-text(b))')).toBe(false)
  })
})

describe('parsing the chain', () => {
  it('splits the CSS prefix from the steps', () => {
    expect(selectorOf('.box:has-text(Advert)')).toEqual({
      css: '.box',
      steps: [{ op: 'has-text', pattern: 'Advert' }],
      action: { kind: 'hide' }
    })
  })

  it('keeps a native pseudo-class in the prefix where the browser can match it', () => {
    // `:has()` before a procedural step belongs to the CSS the chain starts from — not to the chain.
    const parsed = selectorOf('div:has(> img):has-text(Advert)')
    expect(parsed.css).toBe('div:has(> img)')
    expect(parsed.steps).toHaveLength(1)
  })

  it('chains several steps in order', () => {
    const parsed = selectorOf('.item:has-text(Advert):min-text-length(4):upward(2)')
    expect(parsed.steps).toEqual([
      { op: 'has-text', pattern: 'Advert' },
      { op: 'min-text-length', length: 4 },
      { op: 'upward', levels: 2, selector: null }
    ])
  })

  it('takes :contains as the AdGuard spelling of :has-text', () => {
    // Both dialects, deliberately: a user pasting a rule from a forum should not have to know which of the
    // two implementations the person who wrote it was using.
    expect(selectorOf('p:contains(Sponsored)').steps).toEqual([
      { op: 'has-text', pattern: 'Sponsored' }
    ])
  })

  it('reads :upward with a selector as well as a count', () => {
    expect(selectorOf('.child:upward(div[id])').steps).toEqual([
      { op: 'upward', levels: null, selector: 'div[id]' }
    ])
  })

  it('refuses an :upward outside the range a rule can mean', () => {
    // uBO's own bound. `0` means "this element", which is what no operator at all means, and a very large
    // number always reaches `<html>` — neither is a rule anybody wrote.
    expect(problemOf('.a:upward(0)')).toBe('procedural-bad-argument')
    expect(problemOf('.a:upward(999)')).toBe('procedural-bad-argument')
  })

  it('reads the action operators, which must come last', () => {
    expect(selectorOf('.a:style(height: 0)').action).toEqual({
      kind: 'style',
      declarations: 'height: 0'
    })
    expect(selectorOf('.a:remove()').action).toEqual({ kind: 'remove' })
    expect(selectorOf('.a:remove-attr(onclick|target)').action).toEqual({
      kind: 'remove-attr',
      names: ['onclick', 'target'],
      pattern: null
    })
    expect(selectorOf('.a:remove-class(sticky)').action).toEqual({
      kind: 'remove-class',
      names: ['sticky'],
      pattern: null
    })
  })

  it('takes a regular expression where a name would randomise', () => {
    /*
      Real syntax, and refusing it counted three real rules as malformed — `:remove-attr(/oncontextmenu|
      onselectstart/)` in two lyrics sites' rules and `:remove-class(/scroll-block--is-blocked/)` in
      Crunchyroll's. It is also the form that matters for what these rules are *for*: a class a site
      randomises per session cannot be named literally.

      The trap it had fallen into: splitting on `|` first turns one pattern into two broken halves,
      `/oncontextmenu` and `onselectstart/`, each of which then fails the identifier test.
    */
    expect(selectorOf('.a:remove-attr(/oncontextmenu|onselectstart/)').action).toEqual({
      kind: 'remove-attr',
      names: [],
      pattern: '/oncontextmenu|onselectstart/'
    })
    expect(selectorOf('.a:remove-class(/scroll-block/)').action).toEqual({
      kind: 'remove-class',
      names: [],
      pattern: '/scroll-block/'
    })
  })

  it('names an unimplemented operator even when it is the whole selector', () => {
    /*
      `example.com##:xpath('//*[contains(text(),"Adblock")]')` has no CSS in front of it, because for that
      operator the selector *is* the operator — and the lists carry eleven such rules between `:xpath()` and
      `:-abp-properties()`.

      Checking the prefix first reported every one of them as `procedural-no-css-prefix`, which is true about
      the text and misleading about the reason: it reads as "malformed rule" where it means "no `:xpath()`
      here". The counters exist so the next thing worth building is legible, and a wrong name defeats that
      more thoroughly than a missing one.
    */
    expect(problemOf(":xpath('//*[contains(text(),\"Adblock\")]')")).toBe(
      'procedural-unimplemented:xpath'
    )
    expect(problemOf(':-abp-properties(data:)')).toBe(
      'procedural-unimplemented:-abp-properties'
    )
  })

  it('refuses an action that is not last', () => {
    /*
      Both implementations require it, and this enforces it rather than tolerating it: an action in the middle
      would have to mean "restyle these, then keep filtering from them", which neither uBO nor AdGuard
      defines — so honouring it would be inventing semantics the rule's author cannot have intended.
    */
    expect(problemOf('.a:remove():has-text(x)')).toBe('procedural-bad-argument')
  })

  it('refuses CSS after a procedural step', () => {
    /*
      AdGuard states this as the rule of its syntax — `div[class="ad"]:has(img)` is valid,
      `div:has(img)[class="ad"]` is not — and uBO does allow it. Refused whole rather than half-honoured,
      because a rule read as `.a:has-text(x)` when it said `.a:has-text(x) .b` hides the wrong element on a
      page nobody is testing. A counted refusal is visible; a wrong reading is not.
    */
    expect(problemOf('.a:has-text(x) .b')).toBe('procedural-trailing-css')
  })

  it('refuses a chain with nothing to start from', () => {
    // A chain needs a set of elements to narrow. `:has-text(x)` alone would mean "every element in the
    // document containing x", which is a rule that hides the page.
    expect(problemOf(':has-text(Advert)')).toBe('procedural-no-css-prefix')
  })

  it('names an operator it has no implementation for', () => {
    /*
      Counted with the name, the way an unimplemented scriptlet is, so the next one worth building is a
      number somebody can read rather than a guess. Each of these is one to six uses across the three
      default lists.
    */
    expect(problemOf('.a:xpath(//div)')).toBe('procedural-unimplemented:xpath')
    expect(problemOf('.a:matches-path(/shop)')).toBe('procedural-unimplemented:matches-path')
    expect(problemOf('.a:watch-attr(class)')).toBe('procedural-unimplemented:watch-attr')
    expect(problemOf('.a:-abp-properties(width: 100px)')).toBe(
      'procedural-unimplemented:-abp-properties'
    )
  })

  it('refuses a :style() that could close its own declaration block', () => {
    // Applied through `style.cssText`, which parses declarations only and cannot escape into a rule — so
    // this is belt to that brace, and it costs one line.
    expect(problemOf('.a:style(height: 0} body { display: none)')).toBe('procedural-bad-argument')
  })
})

describe('matching a real document', () => {
  it('keeps only the elements whose text matches', () => {
    const dom = documentOf(`
      <div class="box"><span>Advert</span></div>
      <div class="box"><span>Article</span></div>
    `)
    const found = matchProcedural(selectorOf('.box:has-text(Advert)'), dom)
    expect(found).toHaveLength(1)
    // `textContent` is non-nullable on `Element` in the DOM lib, so the optional chain would be dead code.
    expect((found[0] as unknown as Element).textContent.trim()).toBe('Advert')
  })

  it('takes a regular expression, with its flags', () => {
    const dom = documentOf('<p>SPONSORED</p><p>editorial</p>')
    expect(matchProcedural(selectorOf('p:has-text(/sponsored/i)'), dom)).toHaveLength(1)
  })

  it('climbs the number of levels it was given', () => {
    const dom = documentOf('<section id="outer"><div id="mid"><img class="ad"></div></section>')
    const found = matchProcedural(selectorOf('.ad:upward(2)'), dom)
    expect((found[0] as unknown as Element).id).toBe('outer')
  })

  it('climbs to the nearest ancestor matching a selector, never to the element itself', () => {
    /*
      The mistake this is written against, because it is the one that produces a rule which looks like it
      works: `element.closest()` includes the element, so `.ad:upward(.ad)` would select the thing it started
      from — turning a container rule into exactly the plain selector it was written to improve on.
    */
    const dom = documentOf('<div class="ad" id="outer"><div class="ad" id="inner"></div></div>')
    const found = matchProcedural(selectorOf('#inner:upward(.ad)'), dom)
    expect((found[0] as unknown as Element).id).toBe('outer')
  })

  it('answers with nothing when the ancestry runs out', () => {
    const dom = documentOf('<div class="ad"></div>')
    expect(matchProcedural(selectorOf('.ad:upward(20)'), dom)).toEqual([])
    expect(matchProcedural(selectorOf('.ad:upward(.nowhere)'), dom)).toEqual([])
  })

  it('collapses two matches that share one container', () => {
    // Two children of one box is the everyday case for `:upward`, and hiding it twice would mean two passes
    // over the same element on every mutation burst for the life of the page.
    const dom = documentOf('<div id="box"><i class="ad"></i><i class="ad"></i></div>')
    expect(matchProcedural(selectorOf('.ad:upward(1)'), dom)).toHaveLength(1)
  })

  it('filters on a minimum text length', () => {
    const dom = documentOf('<p>short</p><p>a much longer paragraph</p>')
    expect(matchProcedural(selectorOf('p:min-text-length(10)'), dom)).toHaveLength(1)
  })

  it('answers with nothing for an unreadable CSS prefix', () => {
    // One rule's problem stays one rule's problem: a malformed prefix must not throw out of the pass and
    // take every other rule on the page with it.
    const dom = documentOf('<div class="ad"></div>')
    expect(matchProcedural({ css: '[[[', steps: [], action: { kind: 'hide' } }, dom)).toEqual([])
  })

  it('narrows step by step, so an empty set ends the chain', () => {
    const dom = documentOf('<div class="box"><span>Article</span></div>')
    expect(matchProcedural(selectorOf('.box:has-text(Advert):upward(1)'), dom)).toEqual([])
  })
})

describe('doing what the rule asks', () => {
  it('hides without discarding the page\'s own inline style', () => {
    /*
      `setProperty` rather than assigning `cssText`, and this is what says so: assigning would throw away a
      layout the page set up for itself in order to hide a box inside it.
    */
    documentOf('<div class="ad" style="color: red"></div>')
    const element = document.querySelector('.ad') as HTMLElement
    applyProceduralRules([hideOnly('.ad')], document as unknown as MatchableDocument)
    expect(element.style.display).toBe('none')
    expect(element.style.color).toBe('red')
  })

  it('applies :style() on top of what was there', () => {
    documentOf('<div class="hdr" style="color: red"></div>')
    applyProceduralRules(
      [selectorOf('.hdr:style(top: 0)')],
      document as unknown as MatchableDocument
    )
    const element = document.querySelector('.hdr') as HTMLElement
    expect(element.style.top).toBe('0px')
    expect(element.style.color).toBe('red')
  })

  it('removes the element for :remove()', () => {
    documentOf('<div class="ad"></div><div class="keep"></div>')
    applyProceduralRules([selectorOf('.ad:remove()')], document as unknown as MatchableDocument)
    expect(document.querySelector('.ad')).toBeNull()
    expect(document.querySelector('.keep')).not.toBeNull()
  })

  it('strips the attributes and classes it was told to', () => {
    documentOf('<a class="x sticky" onclick="go()" target="_blank">l</a>')
    const dom = document as unknown as MatchableDocument
    applyProceduralRules([selectorOf('a:remove-attr(onclick|target)')], dom)
    applyProceduralRules([selectorOf('a:remove-class(sticky)')], dom)
    const element = document.querySelector('a') as HTMLElement
    expect(element.getAttribute('onclick')).toBeNull()
    expect(element.getAttribute('target')).toBeNull()
    expect(element.className).toBe('x')
  })

  it('strips by pattern, matched against the names actually present', () => {
    // The form a randomised name needs. `class` itself must survive a pattern aimed at the others, which is
    // what makes this worth asserting rather than assuming.
    documentOf('<a class="keep scroll-block--is-blocked" oncontextmenu="x" onselectstart="y">l</a>')
    const dom = document as unknown as MatchableDocument
    applyProceduralRules([selectorOf('a:remove-attr(/^on/)')], dom)
    applyProceduralRules([selectorOf('a:remove-class(/scroll-block/)')], dom)
    const element = document.querySelector('a') as HTMLElement
    expect(element.getAttribute('oncontextmenu')).toBeNull()
    expect(element.getAttribute('onselectstart')).toBeNull()
    expect(element.className).toBe('keep')
  })

  it('reports how many elements it touched', () => {
    // The number a screen could use to say "this rule is doing something". A rule that matches nothing for
    // the life of a page is a rule the user wrote wrongly, and that is worth being able to tell them.
    documentOf('<div class="ad"></div><div class="ad"></div>')
    expect(applyProceduralRules([hideOnly('.ad')], document as unknown as MatchableDocument)).toBe(2)
  })

  it('lets one broken rule cost only itself', () => {
    documentOf('<div class="ad"></div>')
    const dom = document as unknown as MatchableDocument
    const touched = applyProceduralRules(
      [{ css: '[[[', steps: [], action: { kind: 'hide' } }, hideOnly('.ad')],
      dom
    )
    expect(touched).toBe(1)
    expect((document.querySelector('.ad') as HTMLElement).style.display).toBe('none')
  })
})

describe('the pattern argument', () => {
  it('is a substring unless it is wrapped in slashes', () => {
    expect(textMatcher('Advert')('an Advert here')).toBe(true)
    expect(textMatcher('Advert')('nothing')).toBe(false)
    expect(textMatcher('/^ad/i')('ADvert')).toBe(true)
  })

  it('matches nothing for an expression that cannot compile', () => {
    // Rather than throwing: a rule with a bad pattern must cost its own rule and not the pass.
    expect(textMatcher('/([/')('anything')).toBe(false)
  })
})

describe('which rules a host gets', () => {
  const index = (text: string): ReturnType<typeof buildProceduralIndex> =>
    buildProceduralIndex(parseFilterList(text).procedural)

  it('gives a host its own rules and its parent domain\'s', () => {
    const built = index(
      ['shop.example.com##.a:has-text(x)', 'example.com##.b:has-text(y)'].join('\n')
    )
    expect(proceduralSelectorsFor(built, 'shop.example.com').map((s) => s.css)).toEqual([
      '.a',
      '.b'
    ])
  })

  it('does not give a parent a subdomain\'s rules', () => {
    expect(proceduralSelectorsFor(index('shop.example.com##.a:has-text(x)'), 'example.com')).toEqual(
      []
    )
  })

  it('honours a ~host exclusion', () => {
    const built = index('example.com,~shop.example.com##.a:has-text(x)')
    expect(proceduralSelectorsFor(built, 'www.example.com')).toHaveLength(1)
    expect(proceduralSelectorsFor(built, 'shop.example.com')).toEqual([])
  })

  it('drops a line two lists both carry', () => {
    // Not merely redundant: the actions are applied per match, so `:remove-class(x)` twice is two passes over
    // the same elements on every mutation burst, forever.
    const built = index('example.com##.a:has-text(x)\nexample.com##.a:has-text(x)')
    expect(proceduralSelectorsFor(built, 'example.com')).toHaveLength(1)
  })

  it('has no bucket for a rule that names no host', () => {
    /*
      uBlock Origin refuses a generic procedural filter and so does this, on cost rather than compatibility:
      script on every page for the rest of the session, re-run on every mutation burst. The refusal is what
      keeps this feature proportional to the number of sites the rules actually name.
    */
    const parsed = parseFilterList('##.a:has-text(x)')
    expect(parsed.procedural).toEqual([])
    expect(Object.keys(parsed.diagnostics.unsupportedByReason)).toContain('procedural-generic')
  })
})

describe('end to end, from list text to a filtered page', () => {
  it('hides the box containing a word, which is the rule people write by hand', () => {
    const parsed = parseFilterList('shop.example##.teaser:has-text(Anzeige):upward(1)')
    expect(parsed.diagnostics.procedural).toBe(1)
    expect(parsed.diagnostics.unsupported).toBe(0)

    const selectors = proceduralSelectorsFor(
      buildProceduralIndex(parsed.procedural),
      'www.shop.example'
    )
    documentOf(`
      <section id="wrapper"><div class="teaser"><span>Anzeige</span></div></section>
      <section id="keep"><div class="teaser"><span>Nachricht</span></div></section>
    `)
    applyProceduralRules(selectors, document as unknown as MatchableDocument)

    expect((document.querySelector('#wrapper') as HTMLElement).style.display).toBe('none')
    expect((document.querySelector('#keep') as HTMLElement).style.display).toBe('')
  })

  it('reads the #?# marker as well as ##', () => {
    // Both dialects write these. `#?#` is the explicit "extended syntax" marker; `##` carries them too, which
    // is how uAssets actually writes them.
    expect(parseFilterList('shop.example#?#.a:has-text(x)').procedural).toHaveLength(1)
    expect(parseFilterList('shop.example##.a:has-text(x)').procedural).toHaveLength(1)
  })

  it('keeps the line accounting exact', () => {
    // A seventh counter had to grow with the fourth rule kind, or the invariant that every line is accounted
    // for would have started failing on real lists.
    const parsed = parseFilterList(
      [
        'shop.example##.plain',
        'shop.example##.a:has-text(x)',
        'shop.example##.b:xpath(//div)',
        '##.c:has-text(y)',
        '! comment',
        ''
      ].join('\n')
    )
    const { diagnostics } = parsed
    expect(
      diagnostics.blank +
        diagnostics.comments +
        diagnostics.network +
        diagnostics.cosmetic +
        diagnostics.scriptlet +
        diagnostics.procedural +
        diagnostics.unsupported
    ).toBe(diagnostics.lines)
  })
})

describe('what crosses into the preload', () => {
  it('keeps a well-formed selector and drops anything else', () => {
    /*
      The answer arrives over IPC from a build that may differ from the preload's, and each entry drives a
      `querySelectorAll` and a style write. Shapes are checked; meanings are not — a nonsense `has-text`
      pattern matches nothing, which is a rule that does nothing, and that is the safe direction.
    */
    const good = { css: '.a', steps: [], action: { kind: 'hide' } }
    expect(
      asProceduralSelectors([
        good,
        { css: '', steps: [], action: { kind: 'hide' } },
        { css: '.b', steps: 'not-an-array', action: { kind: 'hide' } },
        { css: '.c', steps: [] },
        { css: '.d', steps: [], action: { kind: 42 } },
        null,
        'nonsense'
      ])
    ).toEqual([good])
  })

  it('answers with nothing for a reply that is not a list', () => {
    expect(asProceduralSelectors(undefined)).toEqual([])
    expect(asProceduralSelectors({ css: '.a' })).toEqual([])
  })
})
