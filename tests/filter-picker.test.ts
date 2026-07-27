import { describe, expect, it } from 'vitest'
import {
  classifyAttribute,
  classifyClassName,
  classifyElementId
} from '@shared/filters/identifiers.js'
import { parseFilterList } from '@shared/filters/parse.js'
import {
  MATCH_WARNING_LIMIT,
  cosmeticExceptionFor,
  cosmeticRuleFor,
  estimateMatches,
  proposeSelector,
  renderSelectorPlan,
  type ElementAttribute,
  type ElementDescription,
  type ElementNode,
  type SelectorStep
} from '@shared/filters/picker.js'

/**
 * The element picker's two halves: is this name worth using, and does this selector
 * hit the right thing.
 *
 * The names in the rejection tests are real. `css-1a2b3c` is Emotion, `sc-bdVaJa` and
 * `hXpVsL` are styled-components, `jsx-2847` is styled-jsx, `ember1234` is Ember,
 * `mat-input-3` and `cdk-overlay-0` are Angular Material, `:r0:` is React's `useId`,
 * `Button_root__2xY9z` is a CSS-modules build, `svelte-1a2b3c` is Svelte. Every one of
 * them works when the rule is created and stops working at the next deployment, which
 * is the failure a user cannot diagnose.
 *
 * The other half is over-reach. A selector that also matches an *ancestor* of the
 * target takes the whole surrounding region out, and that case is asserted directly,
 * because a match count cannot see it: one element is one element, whether it is the
 * advert or the article containing it.
 */

function node(overrides: Partial<ElementNode>): ElementNode {
  return { tag: 'div', id: null, classes: [], attributes: [], childIndex: 1, ...overrides }
}

function element(overrides: Partial<ElementDescription>): ElementDescription {
  return { ...node({}), ancestors: [], ...overrides }
}

/** A chain from the target outwards, as the renderer would report it. */
function chain(...nodes: readonly Partial<ElementNode>[]): ElementDescription {
  const [own, ...ancestors] = nodes
  return { ...node(own ?? {}), ancestors: ancestors.map((ancestor) => node(ancestor)) }
}

function step(overrides: Partial<SelectorStep>): SelectorStep {
  return {
    tag: null,
    id: null,
    classes: [],
    attributes: [],
    childIndex: 0,
    combinator: 'descendant',
    ...overrides
  }
}

describe('classifyElementId', () => {
  it('accepts an id a person wrote', () => {
    for (const id of ['masthead', 'site-footer', 'main-content', 'searchform', 'topAdContainer']) {
      expect(classifyElementId(id), id).toBe('usable')
    }
  })

  it('refuses a counter, whatever produced it', () => {
    expect(classifyElementId('comment-4711')).toBe('digit-run')
    expect(classifyElementId('mat-input-3')).toBe('counter-suffix')
    expect(classifyElementId('cdk-overlay-0')).toBe('framework-prefix')
    expect(classifyElementId('radix-0')).toBe('framework-prefix')
    expect(classifyElementId('ember1234')).toBe('framework-prefix')
    expect(classifyElementId('mui-1234')).toBe('digit-run')
    expect(classifyElementId('post-12345')).toBe('digit-run')
  })

  it('refuses an id that would have to be escaped in a selector', () => {
    // React's `useId` produces `:r0:`, which is not a CSS identifier at all. A rule
    // built on it would need escaping, and the feature index refuses escaped
    // selectors — so the picker would produce a rule the injector declines to key.
    expect(classifyElementId(':r0:')).toBe('not-an-identifier')
    expect(classifyElementId('123-slot')).toBe('not-an-identifier')
    expect(classifyElementId('')).toBe('not-an-identifier')
  })

  it('refuses a bare hash', () => {
    expect(classifyElementId('f7a3b2e')).toBe('hash-like')
    // Same shape, but the trailing digit is caught first; the reason differs, the
    // refusal does not.
    expect(classifyElementId('a1b2c3d4')).toBe('counter-suffix')
    expect(classifyElementId('x')).toBe('too-short')
  })

  it('refuses a name with no vowel in it, which is the signal nothing else catches', () => {
    // `hdrbtn` is one long run of letters, so the case-alternation signal says nothing
    // about it and there are no digits to mix — the vowel rule is the only thing
    // refusing it. Without a case like this, that rule could be switched off entirely
    // (or inverted to "contains a consonant") and every existing name would still be
    // judged the same way, so `sc-`-style hashes with a long lower-case run would start
    // being accepted.
    expect(classifyElementId('hdrbtn')).toBe('hash-like')
  })

  it('refuses letters and digits alternating in short runs', () => {
    // What a CSS minifier emits. Three runs of one character is the whole signal here:
    // the run pattern is `a`, `1`, `b`, and neither the vowel rule nor the mixed-shape
    // rule (which wants five characters) applies. It is also the case that pins how a
    // run is measured — merging digits into the letters beside them would leave one run
    // of three and this name would be accepted.
    expect(classifyElementId('a1b')).toBe('hash-like')
  })

  it('accepts a two-character name, which `ad` and `nav` shorthands use', () => {
    expect(classifyElementId('ad')).toBe('usable')
  })
})

describe('classifyClassName', () => {
  it('accepts a class that describes what the element is', () => {
    for (const name of ['ad-slot', 'sponsored', 'newsletter-signup', 'werbung', 'reklama']) {
      expect(classifyClassName(name), name).toBe('usable')
    }
  })

  it('refuses a build hash', () => {
    expect(classifyClassName('css-1a2b3c')).toBe('framework-prefix')
    expect(classifyClassName('sc-bdVaJa')).toBe('framework-prefix')
    expect(classifyClassName('jsx-2847')).toBe('framework-prefix')
    expect(classifyClassName('svelte-1a2b3c')).toBe('framework-prefix')
    expect(classifyClassName('ng-tns-c46-1')).toBe('framework-prefix')
    // No prefix to recognise; only the shape gives it away.
    expect(classifyClassName('hXpVsL')).toBe('hash-like')
    expect(classifyClassName('bdVaJa')).toBe('hash-like')
    expect(classifyClassName('Button_root__2xY9z')).toBe('hash-like')
  })

  it('refuses a class that describes state rather than identity', () => {
    // A rule on `.is-active` blocks while the element is active and stops when it is
    // not, which the user sees as a blocker that works intermittently.
    for (const name of ['active', 'is-open', 'has-error', 'nav-open', 'v-enter-active']) {
      expect(classifyClassName(name), name).toBe('state-name')
    }
  })

  it('refuses a state prefix even when the word after it is not a state word', () => {
    /*
      Every name in the test above is caught twice — `is-open` has `open` in it, which
      the word list holds on its own. So the prefix check could be deleted, or made to
      look at the *end* of the name instead of the start, and nothing would notice.

      These four are caught only by the prefix. `.is-featured` is set while a card is
      the featured one and cleared when the next article takes over, and Vue's
      `v-leave-to` exists for the few hundred milliseconds of a transition: a rule built
      on either blocks intermittently, which is harder to report than one that never
      works at all.
    */
    for (const name of ['is-featured', 'has-dropdown', 'v-leave-to', 'ng-star-inserted']) {
      expect(classifyClassName(name), name).toBe('state-name')
    }
  })

  it('refuses a utility class, which is a counter by another name', () => {
    expect(classifyClassName('mt-4')).toBe('counter-suffix')
    expect(classifyClassName('col-md-6')).toBe('counter-suffix')
  })

  it('keeps camel case, which a hand-written page uses', () => {
    // The hash test looks for runs of one or two characters, not merely for a capital;
    // `topAdContainer` has a word in it and survives.
    expect(classifyClassName('topAdContainer')).toBe('usable')
    expect(classifyClassName('AdSlot')).toBe('usable')
    // An acronym is one run, not one run per letter. `MPU` is the ad industry's own name
    // for a mid-page unit, so `.MPUadTop` is exactly the class a publisher writes by
    // hand — and counting `M`, `P`, `U` separately would make every acronym look like
    // `bdVaJa` and cost the picker the one class that names the slot.
    expect(classifyClassName('MPUadTop')).toBe('usable')
  })

  it('needs three short runs before it reads a name as alternating case', () => {
    /*
      Both sides of the threshold, which nothing pinned: `>= 3` could have been `> 3` and
      every existing name would have been judged the same way.

      Three is where a hash starts to be distinguishable from an abbreviation. `.aBc` is
      what a minifier emits; `.IDs` is two runs and a word people write, and refusing it
      would cost a working selector for nothing.
    */
    expect(classifyClassName('aBc')).toBe('hash-like')
    expect(classifyClassName('IDs')).toBe('usable')
  })

  it('needs five characters before letters beside digits count as a hash', () => {
    /*
      The other threshold in the same file, and the same story: `>= 5` survived being
      changed to `> 5` and to `< 5`, because no test used a name of exactly five.

      `.box1a` is a CSS-modules build; `.ad-1box` is a hand-written slot name whose
      second word is too short to judge, and refusing it would send the picker to an
      ancestor or a positional step for a page that named its advert plainly.
    */
    expect(classifyClassName('box1a')).toBe('hash-like')
    expect(classifyClassName('ad-1box')).toBe('usable')
  })

  it('does not read a non-ASCII name as a hash', () => {
    expect(classifyClassName('реклама')).toBe('usable')
  })
})

describe('classifyAttribute', () => {
  it('accepts a publisher naming its own slot', () => {
    expect(classifyAttribute('data-ad-region', 'top')).toBe('usable')
    expect(classifyAttribute('aria-label', 'Advertisement')).toBe('usable')
  })

  it('refuses a framework marker', () => {
    // Vue's scoped-style attribute is a build hash; it changes with the deployment.
    expect(classifyAttribute('data-v-7ba5bd90', '')).toBe('framework-prefix')
    expect(classifyAttribute('data-reactroot', '')).toBe('framework-prefix')
  })

  it('refuses an attribute that says nothing about identity', () => {
    expect(classifyAttribute('style', 'display:none')).toBe('not-an-identifier')
    expect(classifyAttribute('class', 'ad')).toBe('not-an-identifier')
    expect(classifyAttribute('id', 'ad')).toBe('not-an-identifier')
  })

  it('refuses a generated value', () => {
    expect(classifyAttribute('data-ad-slot', '1234567')).toBe('digit-run')
    expect(classifyAttribute('data-slot', 'a1b2c3d')).toBe('hash-like')
    expect(classifyAttribute('data-slot', '')).toBe('too-short')
  })

  it('refuses a value it would have to escape, or a paragraph of prose', () => {
    expect(classifyAttribute('title', 'say "hello"')).toBe('not-an-identifier')
    expect(classifyAttribute('title', 'x'.repeat(65))).toBe('not-an-identifier')
    // 64 is the limit and it admits 64. Only the pair pins it: with `>= 64` a value the
    // selector can carry perfectly well would be refused, and the rule the user
    // confirmed would be built on something weaker instead. `ax` rather than `x`, because
    // sixty-four consonants are refused as a hash and would prove nothing about length.
    expect(classifyAttribute('title', 'ax'.repeat(32))).toBe('usable')
  })

  it('does not read a number with a separator as a hash', () => {
    // The mixed-shape rule asks for *letters* beside the digits. Relaxed to "any
    // non-letter" it would refuse a price or a version — values a publisher does put on
    // its own elements — and it would do so with the reason "looks generated", which is
    // the one message the picker shows the user.
    expect(classifyAttribute('data-price', '12.34')).toBe('usable')
  })
})

describe('renderSelectorPlan', () => {
  it('writes a compound step', () => {
    expect(renderSelectorPlan([step({ tag: 'div', classes: ['ad', 'wide'], childIndex: 3 })])).toBe(
      'div.ad.wide:nth-child(3)'
    )
  })

  it('writes the combinator each step was given', () => {
    expect(
      renderSelectorPlan([
        step({ id: 'sidebar' }),
        step({ tag: 'div', combinator: 'descendant' }),
        step({ tag: 'span', combinator: 'child' })
      ])
    ).toBe('#sidebar div > span')
  })

  it('writes an attribute with its value quoted', () => {
    expect(
      renderSelectorPlan([step({ tag: 'div', attributes: [{ name: 'data-ad', value: 'top' }] })])
    ).toBe('div[data-ad="top"]')
  })

  it('falls back to `*` for a step that constrains nothing', () => {
    expect(renderSelectorPlan([step({})])).toBe('*')
  })
})

describe('proposeSelector', () => {
  it('uses the id when there is a usable one, because nothing is shorter', () => {
    const target = element({ tag: 'div', id: 'ad-leaderboard', classes: ['banner'] })
    const proposal = proposeSelector({ target, page: [target] })
    expect(proposal.selector).toBe('#ad-leaderboard')
    expect(proposal.strategy).toBe('id')
    expect(proposal.estimatedMatches).toBe(1)
    expect(proposal.warnings).toEqual([])
  })

  it('ignores a generated id and says why', () => {
    const target = element({ tag: 'div', id: 'ember1234', classes: ['ad-slot'] })
    const proposal = proposeSelector({ target, page: [target] })
    expect(proposal.selector).toBe('.ad-slot')
    expect(proposal.strategy).toBe('class')
    expect(proposal.refused).toEqual([
      { kind: 'id', name: 'ember1234', reason: 'framework-prefix' }
    ])
  })

  it('names the class that narrows the most', () => {
    // `promo` is on three elements and `sky-slot` on one; the picker has to prefer the
    // one that identifies rather than the one that comes first.
    const target = element({ tag: 'div', classes: ['promo', 'sky-slot'] })
    const others = [
      element({ tag: 'div', classes: ['promo'] }),
      element({ tag: 'section', classes: ['promo'] })
    ]
    const proposal = proposeSelector({ target, page: [target, ...others] })
    expect(proposal.selector).toBe('.sky-slot')
    expect(proposal.estimatedMatches).toBe(1)
  })

  it('adds a second class when neither one alone is narrow enough', () => {
    // A grid of cards, some of them sponsored: only the pair identifies the one the
    // user pointed at, and each class on its own would hide a screenful.
    const target = element({ tag: 'div', classes: ['card', 'sponsored'] })
    const crowd = [
      ...Array.from({ length: MATCH_WARNING_LIMIT + 1 }, () =>
        element({ tag: 'div', classes: ['card'] })
      ),
      ...Array.from({ length: MATCH_WARNING_LIMIT + 1 }, () =>
        element({ tag: 'div', classes: ['sponsored'] })
      )
    ]
    const proposal = proposeSelector({ target, page: [target, ...crowd] })
    expect(proposal.selector).toBe('div.card.sponsored')
    expect(proposal.estimatedMatches).toBe(1)
  })

  it('names every class it has when two are still not enough', () => {
    const target = element({ tag: 'div', classes: ['card', 'wide', 'sky'] })
    const crowd = [
      ...Array.from({ length: MATCH_WARNING_LIMIT + 1 }, () =>
        element({ tag: 'div', classes: ['card', 'wide'] })
      ),
      ...Array.from({ length: MATCH_WARNING_LIMIT + 1 }, () =>
        element({ tag: 'div', classes: ['card', 'sky'] })
      ),
      ...Array.from({ length: MATCH_WARNING_LIMIT + 1 }, () =>
        element({ tag: 'div', classes: ['wide', 'sky'] })
      )
    ]
    const proposal = proposeSelector({ target, page: [target, ...crowd] })
    expect(proposal.selector).toBe('div.card.wide.sky')
    expect(proposal.estimatedMatches).toBe(1)
  })

  it('combines a class with an attribute when neither alone is narrow enough', () => {
    const attribute: ElementAttribute = { name: 'data-ad-region', value: 'top' }
    const target = element({ tag: 'div', classes: ['card'], attributes: [attribute] })
    const crowd = [
      ...Array.from({ length: MATCH_WARNING_LIMIT + 1 }, () =>
        element({ tag: 'div', classes: ['card'] })
      ),
      ...Array.from({ length: MATCH_WARNING_LIMIT + 1 }, () =>
        element({ tag: 'div', attributes: [attribute] })
      )
    ]
    const proposal = proposeSelector({ target, page: [target, ...crowd] })
    expect(proposal.selector).toBe('div.card[data-ad-region="top"]')
    expect(proposal.strategy).toBe('attribute')
  })

  it('refuses a selector that would hide an ancestor of the target', () => {
    // The target and its container share a class, so `.wrap` matches both — and hiding
    // the container takes the page's whole content region with it. One match, and still
    // the wrong one.
    const target = chain({ tag: 'div', classes: ['wrap'] }, { tag: 'section', classes: ['wrap'] })
    const proposal = proposeSelector({ target, page: [target] })
    expect(proposal.warnings).not.toContain('matches-ancestor')
    expect(proposal.selector).not.toBe('.wrap')
  })

  it('would rather hide a crowd than hide the container', () => {
    // Nothing available is narrow enough, so the picker has to choose between two bad
    // answers. Hiding thirteen sibling cards is recoverable; hiding the section they
    // sit in takes the page with it, so the ancestor hit loses however few it matches.
    const card = (): ElementDescription =>
      chain(
        { tag: 'div', classes: ['wrap'], childIndex: 1 },
        { tag: 'section', classes: ['wrap'], childIndex: 1 }
      )
    const target = card()
    const proposal = proposeSelector({
      target,
      page: [target, ...Array.from({ length: MATCH_WARNING_LIMIT + 1 }, card)]
    })
    expect(proposal.selector).toBe('div.wrap')
    expect(proposal.warnings).toContain('matches-many')
    expect(proposal.warnings).not.toContain('matches-ancestor')
  })

  it('warns when nothing it can build avoids the ancestor', () => {
    // Six nested divs, all first children, none named: the truncated path is the only
    // thing left, and a self-similar chain is what a truncated path cannot tell apart.
    // The user is told, rather than being handed a rule that swallows the page.
    const target = chain(...Array.from({ length: 6 }, () => ({ tag: 'div', childIndex: 1 })))
    const proposal = proposeSelector({ target, page: [target] })
    expect(proposal.warnings).toContain('matches-ancestor')
    expect(proposal.warnings).toContain('no-stable-feature')
  })

  it('scopes under a named ancestor when the element itself has no name', () => {
    const target = chain({ tag: 'aside' }, { tag: 'div', id: 'sidebar' })
    const proposal = proposeSelector({ target, page: [target] })
    expect(proposal.selector).toBe('#sidebar > aside')
    expect(proposal.strategy).toBe('scoped')
    expect(proposal.warnings).toEqual([])
  })

  it('scopes under a named ancestor further up with a descendant combinator', () => {
    const target = chain({ tag: 'aside' }, { tag: 'div' }, { tag: 'div', classes: ['page-body'] })
    const proposal = proposeSelector({ target, page: [target] })
    expect(proposal.selector).toBe('div.page-body aside')
  })

  it('falls back to a position, and says the rule is positional', () => {
    const target = chain(
      { tag: 'div', childIndex: 4 },
      { tag: 'div', childIndex: 2 },
      { tag: 'div', id: 'root' }
    )
    // `#root div` would match the intermediate div as well, so the only thing left is
    // the path — and the user has to be told it will break when the page reorders.
    const proposal = proposeSelector({ target, page: [target] })
    expect(proposal.selector).toBe('#root > div:nth-child(2) > div:nth-child(4)')
    expect(proposal.strategy).toBe('structural')
    expect(proposal.warnings).toContain('positional')
  })

  it('keeps a positional path short enough to read', () => {
    const deep = chain(
      { tag: 'span', childIndex: 1 },
      { tag: 'div', childIndex: 2 },
      { tag: 'div', childIndex: 3 },
      { tag: 'div', childIndex: 4 },
      { tag: 'div', childIndex: 5 },
      { tag: 'body', childIndex: 1 },
      { tag: 'html', childIndex: 1 }
    )
    const proposal = proposeSelector({ target: deep, page: [deep] })
    // Truncated from the top, which only ever makes the rule broader — so it still
    // hides what the user pointed at.
    expect(proposal.selector.split('>')).toHaveLength(4)
    expect(proposal.selector.endsWith('span:nth-child(1)')).toBe(true)
  })

  it('uses an attribute when that is the only thing worth naming', () => {
    const target = element({
      tag: 'div',
      classes: ['css-1a2b3c'],
      attributes: [{ name: 'data-ad-region', value: 'top' }]
    })
    const proposal = proposeSelector({ target, page: [target] })
    expect(proposal.selector).toBe('div[data-ad-region="top"]')
    expect(proposal.strategy).toBe('attribute')
  })

  it('always matches the element it was asked about', () => {
    // The guarantee that makes the return type total: there is no "no selector found".
    const targets = [
      element({}),
      element({ tag: 'span', classes: ['css-1a2b3c', 'is-active'] }),
      chain({ tag: 'div', childIndex: 7 }, { tag: 'ul', classes: ['feed'] }),
      chain({ tag: 'li', childIndex: 2 }, { tag: 'ul' }, { tag: 'div', id: ':r0:' })
    ]
    for (const target of targets) {
      const proposal = proposeSelector({ target, page: [target] })
      expect(proposal.estimatedMatches, proposal.selector).toBeGreaterThanOrEqual(1)
    }
  })

  it('counts the target once even when the caller left it out of the page', () => {
    const target = element({ classes: ['ad'] })
    expect(proposeSelector({ target, page: [] }).estimatedMatches).toBe(1)
    expect(proposeSelector({ target, page: [target, target] }).estimatedMatches).toBe(1)
  })

  it('warns when the narrowest thing it could build still matches a crowd', () => {
    const target = element({ tag: 'div', classes: ['row'] })
    const crowd = Array.from({ length: 40 }, () => element({ tag: 'div', classes: ['row'] }))
    const proposal = proposeSelector({ target, page: [target, ...crowd] })
    expect(proposal.warnings).toContain('matches-many')
    expect(proposal.estimatedMatches).toBe(41)
  })
})

describe('estimateMatches', () => {
  it('counts what a plan would hide', () => {
    const page = [
      element({ tag: 'div', classes: ['ad'] }),
      element({ tag: 'span', classes: ['ad'] }),
      element({ tag: 'div', classes: ['content'] })
    ]
    expect(estimateMatches([step({ classes: ['ad'] })], page)).toBe(2)
    expect(estimateMatches([step({ tag: 'div', classes: ['ad'] })], page)).toBe(1)
  })

  it('honours a child combinator where a descendant one would match', () => {
    const target = chain({ tag: 'span' }, { tag: 'div' }, { tag: 'section', id: 'main' })
    expect(estimateMatches([step({ id: 'main' }), step({ tag: 'span' })], [target])).toBe(1)
    expect(
      estimateMatches([step({ id: 'main' }), step({ tag: 'span', combinator: 'child' })], [target])
    ).toBe(0)
  })

  it('matches an attribute by name and value together', () => {
    const attributes: readonly ElementAttribute[] = [{ name: 'data-ad', value: 'top' }]
    const page = [element({ attributes })]
    expect(estimateMatches([step({ attributes: [{ name: 'data-ad', value: 'top' }] })], page)).toBe(
      1
    )
    expect(
      estimateMatches([step({ attributes: [{ name: 'data-ad', value: 'bottom' }] })], page)
    ).toBe(0)
  })

  it('places a chain of descendant steps by trying every ancestor', () => {
    // Greedy placement would fail here: the first `.a` it meets is the wrong one.
    const target = chain(
      { tag: 'span', classes: ['b'] },
      { tag: 'div', classes: ['a'] },
      { tag: 'div', classes: ['a'] },
      { tag: 'div', id: 'top' }
    )
    expect(
      estimateMatches(
        [step({ id: 'top' }), step({ classes: ['a'] }), step({ classes: ['b'] })],
        [target]
      )
    ).toBe(1)
  })
})

describe('the rule a proposal becomes', () => {
  it('scopes the rule to the host it was created on', () => {
    // A generic `##.ad-slot` from a picker would apply one judgement about one page to
    // every site the user ever visits, which is not what "block this" claims.
    expect(cosmeticRuleFor('WWW.Example.COM', '.ad-slot')).toBe('www.example.com##.ad-slot')
    expect(cosmeticExceptionFor('example.com', '.ad-slot')).toBe('example.com#@#.ad-slot')
  })

  it('produces a line the lists’ own parser reads back unchanged', () => {
    // The point of using ABP syntax: the rule goes through the same parser as
    // everything else, so there is no second element-hiding implementation to test.
    const target = chain({ tag: 'div', id: 'ad-leaderboard' }, { tag: 'body' })
    const proposal = proposeSelector({ target, page: [target] })
    const parsed = parseFilterList(cosmeticRuleFor('example.com', proposal.selector))
    expect(parsed.cosmetic).toEqual([
      {
        selector: '#ad-leaderboard',
        isException: false,
        includeHosts: ['example.com'],
        excludeHosts: []
      }
    ])
    expect(parsed.diagnostics.cosmetic).toBe(1)
    expect(parsed.diagnostics.unsupported).toBe(0)
  })

  it('produces a selector the feature index can key', () => {
    // A picker rule that the injector could not key would be a rule sent to every page
    // — which is exactly what the index exists to avoid.
    const target = element({ tag: 'div', classes: ['ad-slot'] })
    const proposal = proposeSelector({ target, page: [target] })
    const parsed = parseFilterList(cosmeticRuleFor('example.com', proposal.selector))
    expect(parsed.cosmetic.map((rule) => rule.selector)).toEqual(['.ad-slot'])
  })
})
