import { describe, expect, it } from 'vitest'
import {
  MAX_ANCESTOR_DEPTH,
  MAX_ATTRIBUTES,
  MAX_PICKER_CHAIN,
  asElementDescription,
  asPickerEscape,
  asPickerFreezeReport,
  asPickerMeasureRequest,
  asPickerMeasurement,
  asPickerSelectRequest,
  asPickerStart,
  asSelectorProposal,
  describeElement,
  type PickerElement
} from '@shared/filters/picker-wire.js'
import { proposeSelector } from '@shared/filters/picker.js'
import { pickerChrome } from '@main/privacy/picker-chrome.js'

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

describe('the chrome the core builds', () => {
  it('carries a stylesheet, because the page has its own opinions about div', () => {
    // The highlight lives inside a shadow root for exactly this reason; an empty stylesheet would leave a
    // bare `<div>` to whatever the site says about unstyled elements.
    expect(pickerChrome().styles).toContain('.box')
  })

  it('sends no prose into the page at all', () => {
    /*
      It used to send four things: the stylesheet, a hint, a "no rule for this element", and a sentence for
      each selector warning — because the picker drew a confirmation bar inside the document and a preload
      cannot read the i18n catalogue. The bar is an overlay surface now, and its sentences travel on the
      bar's presentation from `picker-bar-text.ts`; this holds the wire down to the one thing still in the page.
      A second copy of the words shipped into every picked document would be a translation nobody reads.
    */
    expect(Object.keys(pickerChrome())).toEqual(['styles'])
  })

  it('styles nothing that is no longer drawn in the page', () => {
    // The bar's own rules went with the bar. Left behind they would be a stylesheet injected into every
    // picked document for elements that are never created — invisible, and impossible to notice as dead.
    for (const gone of ['.bar', '.selector', '.hint', '.warn']) {
      expect(pickerChrome().styles, gone).not.toContain(gone)
    }
  })
})

/**
 * The session's own messages, in both directions.
 *
 * Everything below crosses a process boundary, and in one direction it crosses it from a renderer —
 * which is why each one is total over `unknown` rather than typed and trusted. What a bad message
 * costs is not abstract: a chain with a hole in it answers "wider" with the wrong ancestor, a
 * fractional match count reaches the confirmation bar as the number of things about to disappear,
 * and a measurement naming the wrong attempt reports one document's state as another's.
 */
describe('the message that starts an attempt', () => {
  const chrome = { styles: '.box { border: 1px solid }' }

  it('carries the identity every answer is matched against', () => {
    expect(asPickerStart({ ...chrome, sessionId: 'picker-7' })?.sessionId).toBe('picker-7')
  })

  it('refuses a start with no session to answer for', () => {
    // Nothing could take the highlight off again: every message the page sends back names the attempt,
    // and a page holding a session the core cannot address is the divergence this rebuild removes.
    for (const sessionId of [undefined, '', 7, null]) {
      expect(asPickerStart({ ...chrome, sessionId }), JSON.stringify(sessionId)).toBeNull()
    }
  })

  it('refuses a start with nothing to draw the highlight with', () => {
    // An unstyled `<div>` over somebody's document, in a page that has its own opinions about `div`.
    expect(asPickerStart({ sessionId: 'picker-1' })).toBeNull()
    expect(asPickerStart({ sessionId: 'picker-1', styles: 7 })).toBeNull()
  })

  it('refuses anything that is not an object at all', () => {
    for (const value of [null, undefined, 'chrome', 42, []]) {
      expect(asPickerStart(value), JSON.stringify(value)).toBeNull()
    }
  })
})

describe('the click, as the page reports it', () => {
  const proposal = { selector: '.ad', estimatedMatches: 1, strategy: 'id', warnings: [] }
  const rung = { tag: 'div', proposal, matches: 3 }

  it('accepts a chain of measured rungs', () => {
    const report = asPickerFreezeReport({ sessionId: 'picker-1', chain: [rung, rung] })
    expect(report?.chain).toHaveLength(2)
    expect(report?.chain[0]?.matches).toBe(3)
  })

  it('refuses a click that names no attempt', () => {
    expect(asPickerFreezeReport({ chain: [rung] })).toBeNull()
  })

  it('refuses an empty chain, because there is nothing there to freeze on', () => {
    expect(asPickerFreezeReport({ sessionId: 'picker-1', chain: [] })).toBeNull()
    expect(asPickerFreezeReport({ sessionId: 'picker-1', chain: 'div' })).toBeNull()
  })

  it('refuses a chain longer than an element and its ancestors', () => {
    // Every rung is presented, previewed and measured. Without a bound, a renderer sending ten
    // thousand of them is a great deal of work in the core for a gesture that produced eight.
    const chain = Array.from({ length: MAX_PICKER_CHAIN + 1 }, () => rung)
    expect(asPickerFreezeReport({ sessionId: 'picker-1', chain })).toBeNull()
  })

  it('refuses the whole click for one unreadable rung rather than skipping it', () => {
    /*
      The rungs are *positions*: index 0 is the clicked element and widening counts outwards. A chain
      with a hole quietly closed would answer "wider" with an ancestor two steps away, which is the
      one mistake in this feature a person cannot see before they confirm it.
    */
    for (const bad of [
      { tag: '', proposal, matches: 1 },
      { tag: 'div', proposal, matches: -1 },
      { tag: 'div', proposal, matches: 1.5 },
      { tag: 'div', proposal, matches: Number.NaN },
      { tag: 'div', matches: 1 },
      { tag: 'div', proposal: { selector: '', estimatedMatches: 1 }, matches: 1 },
      null,
      'div'
    ]) {
      expect(
        asPickerFreezeReport({ sessionId: 'picker-1', chain: [rung, bad] }),
        JSON.stringify(bad)
      ).toBeNull()
    }
  })
})

describe('the correction and the measurement', () => {
  it('accepts a rung index, including the clicked element itself', () => {
    expect(asPickerSelectRequest({ sessionId: 'picker-1', index: 0 })?.index).toBe(0)
  })

  it('refuses an index that is not a position', () => {
    for (const index of [-1, 1.5, '2', undefined, Number.POSITIVE_INFINITY]) {
      expect(asPickerSelectRequest({ sessionId: 'picker-1', index }), String(index)).toBeNull()
    }
  })

  it('asks for a selector and never for rule text', () => {
    expect(asPickerMeasureRequest({ sessionId: 'picker-1', selector: '.ad' })?.selector).toBe('.ad')
    expect(asPickerMeasureRequest({ sessionId: 'picker-1', selector: '' })).toBeNull()
    expect(asPickerMeasureRequest({ sessionId: 'picker-1' })).toBeNull()
  })

  it('refuses a measurement request that names no attempt', () => {
    expect(asPickerMeasureRequest({ selector: '.ad' })).toBeNull()
    expect(asPickerMeasureRequest({ sessionId: '', selector: '.ad' })).toBeNull()
    expect(asPickerMeasureRequest(null)).toBeNull()
  })

  it('accepts two counts and no verdict', () => {
    // "It worked" is a decision, and decisions belong to the session module: a hidden element still
    // matches its selector, so a count alone proves nothing either way.
    const measured = asPickerMeasurement({ sessionId: 'picker-1', matches: 3, visible: 0 })
    expect(measured).toEqual({ sessionId: 'picker-1', matches: 3, visible: 0 })
  })

  it('refuses a measurement with a missing or unusable field', () => {
    for (const value of [
      { sessionId: 'picker-1', matches: 3 },
      { sessionId: 'picker-1', visible: 0 },
      { sessionId: '', matches: 3, visible: 0 },
      { sessionId: 'picker-1', matches: -1, visible: 0 },
      { sessionId: 'picker-1', matches: 3, visible: 1.5 },
      { sessionId: 'picker-1', matches: '3', visible: 0 },
      null,
      42
    ]) {
      expect(asPickerMeasurement(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('takes an Escape only from a page that names the attempt it is escaping', () => {
    expect(asPickerEscape({ sessionId: 'picker-1' })?.sessionId).toBe('picker-1')
    expect(asPickerEscape({})).toBeNull()
    expect(asPickerEscape(null)).toBeNull()
  })
})
