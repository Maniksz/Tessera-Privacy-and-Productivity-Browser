import { describe, expect, it } from 'vitest'
import {
  MAX_ANCESTOR_DEPTH,
  MAX_ATTRIBUTES,
  asElementDescription,
  asPickerChrome,
  asSelectorProposal,
  describeElement,
  type PickerElement
} from '@shared/filters/picker-wire.js'
import { proposeSelector } from '@shared/filters/picker.js'
import { pickerChromeFor } from '@main/privacy/picker-chrome.js'

/**
 * Turning a DOM element into the plain data the picker reasons about.
 *
 * This is the half of "block this element myself" that a test can reach. `proposeSelector` already works
 * on plain data — that is what makes the hard part testable — and the transcription is where the decisions
 * that could be quietly wrong live: which attributes travel, how far up the tree, and what a positional
 * index means when the parent cannot be read.
 *
 * Written against plain objects rather than a DOM, which is the point of `PickerElement`: a real `Element`
 * satisfies it structurally, so what is tested here is what runs in the page.
 */

function node(overrides: Partial<PickerElement> = {}): PickerElement {
  return {
    tagName: 'DIV',
    id: '',
    classList: [],
    attributes: [],
    parentElement: null,
    ...overrides
  }
}

/** Builds a chain root -> ... -> leaf and returns the leaf, wiring `children` for the index. */
function chain(...tags: string[]): PickerElement {
  let parent: PickerElement | null = null
  for (const tag of tags) {
    const element: PickerElement = { ...node({ tagName: tag }), parentElement: parent }
    if (parent !== null) {
      ;(parent as { children?: Iterable<PickerElement> }).children = [element]
    }
    parent = element
  }
  // `tags` is never empty at any call site here, and the last element is what was just built.
  return parent as PickerElement
}

describe('transcribing one element', () => {
  it('lower-cases the tag, because a selector is written in lower case', () => {
    // An HTML document reports `DIV`; an XHTML one reports `div`. A selector built from the reported case
    // would match in one and not the other.
    expect(describeElement(node({ tagName: 'SECTION' })).tag).toBe('section')
  })

  it('reports a missing id as null rather than as an empty string', () => {
    /*
      Every element without an id yields `''` from the DOM, and `''` is a value `proposeSelector` would
      have to defend against on every path. `null` says "there is none" once.
    */
    expect(describeElement(node()).id).toBeNull()
    expect(describeElement(node({ id: 'masthead' })).id).toBe('masthead')
  })

  it('drops empty class names', () => {
    // `class=" a  b "` yields empty entries. A selector with `.` and nothing after it is invalid CSS.
    expect(describeElement(node({ classList: ['', 'ad', ''] })).classes).toEqual(['ad'])
  })

  it('leaves class and id out of the attribute list', () => {
    /*
      Both travel in their own fields. Repeating them would let a selector be written as `[id="x"]` when
      `#x` says the same thing more briefly and survives more page changes — and `proposeSelector` would
      have no way to prefer the shorter one.
    */
    const described = describeElement(
      node({
        id: 'x',
        classList: ['y'],
        attributes: [
          { name: 'class', value: 'y' },
          { name: 'id', value: 'x' },
          { name: 'data-ad-region', value: 'top' }
        ]
      })
    )
    expect(described.attributes).toEqual([{ name: 'data-ad-region', value: 'top' }])
  })

  it('caps the attributes it carries', () => {
    /*
      A framework-generated element can carry dozens of `data-` attributes holding serialised state, and
      this crosses a process boundary on every hover. None of that is a selector anybody wants.
    */
    const many = Array.from({ length: MAX_ATTRIBUTES + 10 }, (_value, index) => ({
      name: `data-${index}`,
      value: String(index)
    }))
    expect(describeElement(node({ attributes: many })).attributes).toHaveLength(MAX_ATTRIBUTES)
  })
})

describe('walking up the tree', () => {
  it('reports ancestors nearest first', () => {
    // `proposeSelector` scopes a weak selector under the closest ancestor that has a usable name, so the
    // order is not cosmetic: reversed, it would prefer `<html>` over the advert's own container.
    const leaf = chain('html', 'body', 'main', 'div')
    expect(describeElement(leaf).ancestors.map((a) => a.tag)).toEqual(['main', 'body', 'html'])
  })

  it('stops at the bound', () => {
    // The description crosses a process boundary with every hover, and an advert slot is two or three
    // elements below a region with a name — never fifty.
    const deep = chain(...Array.from({ length: MAX_ANCESTOR_DEPTH + 6 }, () => 'div'))
    expect(describeElement(deep).ancestors).toHaveLength(MAX_ANCESTOR_DEPTH)
  })

  it('reports no ancestors for a detached element', () => {
    // An element removed from the tree between the hover and the transcription. Ordinary on a page that
    // re-renders, so it must be a value rather than a throw inside a preload.
    expect(describeElement(node()).ancestors).toEqual([])
  })
})

describe('the positional index', () => {
  it('is 1-based among the parent element children', () => {
    const first = node({ tagName: 'LI' })
    const second = node({ tagName: 'LI' })
    const parent = node({ tagName: 'UL', children: [first, second] })
    const wired = { ...second, parentElement: parent }
    ;(parent as { children?: Iterable<PickerElement> }).children = [first, wired]
    expect(describeElement(wired).childIndex).toBe(2)
  })

  it('is 0 for an element with no parent', () => {
    /*
      `0` is what `SelectorStep` uses for "does not constrain position", so an unknown index degrades into
      a *less specific* selector rather than a wrong one. That direction is the whole reason it is not an
      error: a picker that refused to describe the document element would simply do nothing on a click.
    */
    expect(describeElement(node()).childIndex).toBe(0)
  })

  it('is 0 when the parent will not enumerate its children', () => {
    // A shadow host, or a minimal stand-in. Same degradation, same reason.
    const parent = node({ tagName: 'UL' })
    expect(describeElement({ ...node(), parentElement: parent }).childIndex).toBe(0)
  })

  it('is 0 when the element is not among the children its parent reports', () => {
    // The tree changed between reading the parent and reading its children.
    const other = node({ tagName: 'LI' })
    const parent = node({ tagName: 'UL', children: [other] })
    expect(describeElement({ ...node(), parentElement: parent }).childIndex).toBe(0)
  })
})

describe('the description feeding the real proposer', () => {
  it('produces a selector for an element with a usable class', () => {
    // The end-to-end shape: transcription in, real proposal out. If the two disagreed about a field name
    // this is what would catch it — everything else here tests the halves separately.
    const parent = node({ tagName: 'MAIN', id: 'content' })
    const target = { ...node({ classList: ['ad-slot'] }), parentElement: parent }
    const description = describeElement(target)
    const proposal = proposeSelector({ target: description, page: [description] })
    expect(proposal.selector).toContain('ad-slot')
    expect(proposal.estimatedMatches).toBeGreaterThanOrEqual(1)
  })
})

describe('what crosses the boundary', () => {
  it('reads a proposal', () => {
    expect(asSelectorProposal({ selector: '.ad', estimatedMatches: 1 })).toMatchObject({
      selector: '.ad'
    })
  })

  it('refuses a proposal with no selector', () => {
    // Answered by our own core, so this is totality rather than trust: an old build must lead to "no rule
    // for this element" instead of a throw inside a preload, which would take the page with it.
    for (const value of [null, undefined, 42, {}, { selector: '' }, { selector: '.a' }]) {
      expect(asSelectorProposal(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('reads a description', () => {
    expect(asElementDescription({ tag: 'div', ancestors: [] })).toMatchObject({ tag: 'div' })
  })

  it('refuses a description that is not one', () => {
    /*
      This one *is* a trust boundary: it arrives from a renderer, and a compromised renderer can send
      anything. `null` means the picker proposes nothing for it — the safe direction, since the only thing
      a rule can do is hide something on the site it was written for.
    */
    for (const value of [null, undefined, 'div', 42, {}, { tag: '' }, { tag: 'div' }]) {
      expect(asElementDescription(value), JSON.stringify(value)).toBeNull()
    }
  })
})

describe('the picker chrome the core sends', () => {
  const chrome = {
    styles: '.box { border: 1px solid }',
    hint: 'Click to hide',
    noRule: 'No rule for this element',
    warnings: { 'matches-ancestor': 'Would hide the surrounding region' }
  }

  it('reads what the core built', () => {
    expect(asPickerChrome(chrome)).toMatchObject({ hint: 'Click to hide' })
  })

  it('refuses a chrome missing any part it must draw with', () => {
    /*
      All or nothing, deliberately. A picker with styles and no words is a bar of unlabelled buttons over
      somebody's page; one with words and no styles is unstyled text in the corner of a document that has its
      own opinions about `div`. Either is worse than not entering the mode — so a build mismatch leaves the
      page alone instead of drawing something the user cannot interpret.
    */
    for (const missing of ['styles', 'hint', 'noRule', 'warnings']) {
      // Rebuilt without the key rather than deleted from a copy: a dynamic `delete` is banned here, and
      // filtering says the same thing without reaching for one.
      const partial = Object.fromEntries(
        Object.entries(chrome).filter(([key]) => key !== missing)
      )
      expect(asPickerChrome(partial), missing).toBeNull()
    }
  })

  it('refuses anything that is not an object at all', () => {
    for (const value of [null, undefined, 'chrome', 42, []]) {
      expect(asPickerChrome(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('accepts a warnings table that words only some of them', () => {
    // The renderer falls back to the warning's own key for one it has no sentence for, so a partial table is a
    // menu that says something rather than one that says nothing — silence would read as safe.
    expect(asPickerChrome({ ...chrome, warnings: {} })).not.toBeNull()
  })
})

describe('the chrome the core builds', () => {
  it('words every warning the picker can produce', () => {
    /*
      The table is keyed by the `SelectorWarning` names the picker's model defines, and a warning added there
      without a sentence here shows its bare key. That is deliberate — a caveat with no words would read as
      "nothing to worry about" — but it is not something to ship, so this holds the two lists together.
    */
    const chrome = pickerChromeFor('en')
    for (const warning of ['matches-ancestor', 'matches-many', 'positional', 'no-stable-feature']) {
      expect(chrome.warnings[warning], warning).toBeTruthy()
    }
  })

  it('answers in the language it was asked for', () => {
    // Read per start rather than once, so a language change reaches the next picker session. If this ever
    // returned one language for both, that setting would silently stop working for this feature alone.
    expect(pickerChromeFor('de').hint).not.toBe(pickerChromeFor('en').hint)
  })

  it('carries a stylesheet, because the page has its own opinions about div', () => {
    // The picker lives inside a shadow root for exactly this reason; an empty stylesheet would leave the bar
    // to whatever the site says about unstyled elements.
    expect(pickerChromeFor('en').styles.length).toBeGreaterThan(100)
  })
})
