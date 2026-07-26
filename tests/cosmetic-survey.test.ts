import { describe, expect, it } from 'vitest'
import {
  MAX_REPORTED_FEATURES,
  asCosmeticStyles,
  asDocumentFeatures,
  injectableDocumentUrl,
  sameFeatures,
  surveyFeatures,
  type SurveyedElement
} from '@shared/filters/injection.js'

/**
 * How a page tells the core what it contains, so it can be sent only the hiding rules that could match.
 *
 * The whole point is proportion. There are tens of thousands of generic cosmetic selectors — around
 * fifty thousand in the four lists this browser ships with — and sending all of them to every document
 * would be megabytes of CSS per page. So the page reports its vocabulary, and that report crosses a
 * process boundary on every mutation burst, which makes its size and its repetition the two things worth
 * testing.
 *
 * The matching itself is `filter-features.test.ts` and `filter-cosmetic.test.ts`; the engine-side seam is
 * `filter-injection.test.ts`. This is only the transport.
 */

function element(overrides: Partial<SurveyedElement> = {}): SurveyedElement {
  return { tagName: 'DIV', id: '', classList: [], ...overrides }
}

describe('surveying a document', () => {
  it('lower-cases tag names, because a selector is written in lower case', () => {
    // `document.querySelectorAll` reports `DIV` in an HTML document and `div` in an XHTML one. An index
    // keyed on the reported case would miss every selector on one of the two.
    expect(surveyFeatures([element({ tagName: 'DIV' })]).tags).toEqual(['div'])
  })

  it('leaves ids and classes exactly as written, because CSS matching is case-sensitive there', () => {
    const features = surveyFeatures([element({ id: 'Masthead', classList: ['AdSlot'] })])
    expect(features.ids).toEqual(['Masthead'])
    expect(features.classes).toEqual(['AdSlot'])
  })

  it('deduplicates', () => {
    // A page with a thousand `<li class="row">` must report one name, not a thousand.
    const features = surveyFeatures([
      element({ classList: ['row'] }),
      element({ classList: ['row'] }),
      element({ classList: ['row', 'row'] })
    ])
    expect(features.classes).toEqual(['row'])
    expect(features.tags).toEqual(['div'])
  })

  it('drops empty names', () => {
    /*
      `class=""` yields one, and every element without an id yields one. A key of `""` would look up the
      empty-string entry in the engine's index — and if such an entry ever existed, the page would be
      served whatever selectors it held. A whole-page hide from a missing attribute.
    */
    const features = surveyFeatures([element({ id: '', classList: ['', 'real'], tagName: '' })])
    expect(features.ids).toEqual([])
    expect(features.classes).toEqual(['real'])
    expect(features.tags).toEqual([])
  })

  it('reports several kinds from one element', () => {
    const features = surveyFeatures([
      element({ tagName: 'SECTION', id: 'promo', classList: ['ad', 'wide'] })
    ])
    expect(features).toEqual({ classes: ['ad', 'wide'], ids: ['promo'], tags: ['section'] })
  })

  it('handles an empty document', () => {
    expect(surveyFeatures([])).toEqual({ classes: [], ids: [], tags: [] })
  })

  it('caps each kind, so a report cannot exceed the document that produced it', () => {
    /*
      A bound rather than trust. A page can hold a hundred thousand elements, and this crosses a process
      boundary. What a cap costs is the *generic* rules for a page's rarest names; the host-specific ones
      are unaffected, because they never depend on the survey.
    */
    const many = Array.from({ length: MAX_REPORTED_FEATURES + 50 }, (_value, index) =>
      element({ id: `id-${index}`, classList: [`class-${index}`] })
    )
    const features = surveyFeatures(many)
    expect(features.ids).toHaveLength(MAX_REPORTED_FEATURES)
    expect(features.classes).toHaveLength(MAX_REPORTED_FEATURES)
  })

  it('keeps the first names it saw when it caps', () => {
    // Elements near the top of a document are a page's chrome and its advert slots. Truncating from the
    // end keeps those and drops whatever a long tail of generated names produced.
    const many = Array.from({ length: MAX_REPORTED_FEATURES + 5 }, (_value, index) =>
      element({ classList: [`class-${index}`] })
    )
    expect(surveyFeatures(many).classes[0]).toBe('class-0')
  })
})

describe('deciding whether to ask again', () => {
  const features = (classes: string[]): ReturnType<typeof surveyFeatures> =>
    surveyFeatures(classes.map((name) => element({ classList: [name] })))

  it('sees an identical survey as identical', () => {
    /*
      The check that makes a mutation observer affordable. An advert carousel rotating or a chat appending
      messages fires constantly and introduces no new class — without this, each burst would be a channel
      call and a lookup over fifty thousand selectors.
    */
    expect(sameFeatures(features(['a', 'b']), features(['a', 'b']))).toBe(true)
  })

  it('sees a new name as different', () => {
    expect(sameFeatures(features(['a']), features(['a', 'b']))).toBe(false)
  })

  it('sees a removed name as different', () => {
    expect(sameFeatures(features(['a', 'b']), features(['a']))).toBe(false)
  })

  it('sees a replaced name as different even at the same length', () => {
    // Comparing sizes alone would call these equal, and the page would never be told about `c`.
    expect(sameFeatures(features(['a', 'b']), features(['a', 'c']))).toBe(false)
  })

  it('notices a change in ids or tags, not only in classes', () => {
    const withId = surveyFeatures([element({ id: 'x' })])
    const withoutId = surveyFeatures([element()])
    expect(sameFeatures(withId, withoutId)).toBe(false)

    const asSpan = surveyFeatures([element({ tagName: 'SPAN' })])
    expect(sameFeatures(asSpan, withoutId)).toBe(false)
  })

  it('treats two empty surveys as identical', () => {
    expect(sameFeatures(surveyFeatures([]), surveyFeatures([]))).toBe(true)
  })
})

describe('what crosses the boundary', () => {
  it('reads a stylesheet, and treats an empty one as nothing', () => {
    // `''` and `null` mean the same thing to the caller — "add no rules" — so collapsing them here saves
    // every call site a second check it could forget.
    expect(asCosmeticStyles('.ad { display: none }')).toBe('.ad { display: none }')
    expect(asCosmeticStyles('')).toBeNull()
    expect(asCosmeticStyles(null)).toBeNull()
  })

  it('refuses anything that is not a stylesheet', () => {
    // The answer comes from our own core, so this is a totality boundary rather than a trust one: an old
    // build, or no responder at all, must lead to "hide nothing" instead of a throw inside a preload —
    // which would take the whole page with it.
    for (const value of [undefined, 42, {}, [], true]) {
      expect(asCosmeticStyles(value), JSON.stringify(value)).toBeNull()
    }
  })

  it('reads a survey, however it arrives', () => {
    expect(asDocumentFeatures({ classes: ['a'], ids: ['b'], tags: ['div'] })).toEqual({
      classes: ['a'],
      ids: ['b'],
      tags: ['div']
    })
  })

  it('answers with empty lists for anything unrecognisable', () => {
    /*
      This one *is* a trust boundary: the survey comes from a renderer, and a compromised renderer can
      send anything. Empty lists mean "no generic rules apply", which is the safe direction — the page
      loses hiding, it does not gain anything.
    */
    for (const value of [undefined, null, 'features', 42, []]) {
      expect(asDocumentFeatures(value), String(value)).toEqual({ classes: [], ids: [], tags: [] })
    }
  })

  it('drops non-string and empty entries from a reported list', () => {
    expect(asDocumentFeatures({ classes: ['a', 42, '', null, 'b'] }).classes).toEqual(['a', 'b'])
  })

  it('caps a reported list, so a renderer cannot make the core do unbounded work', () => {
    const oversized = Array.from({ length: MAX_REPORTED_FEATURES + 100 }, (_v, i) => `c-${i}`)
    expect(asDocumentFeatures({ classes: oversized }).classes).toHaveLength(MAX_REPORTED_FEATURES)
  })

  it('tolerates a partial survey', () => {
    // A build that reported only classes, or a message truncated in transit. Each kind stands alone.
    expect(asDocumentFeatures({ classes: ['a'] })).toEqual({ classes: ['a'], ids: [], tags: [] })
  })
})

describe('which document a request is about', () => {
  it('prefers what the preload reported over the view own address', () => {
    /*
      A race, not a trust decision. At `document-start` the view URL has already moved to the page being
      loaded while the preload runs for it; by the time an asynchronous report arrives the view may have
      moved again. The preload knows which document it *is*.
    */
    expect(injectableDocumentUrl('https://real.example/page', 'https://stale.example/')).toBe(
      'https://real.example/page'
    )
  })

  it('falls back to the view address when nothing was reported', () => {
    for (const reported of [undefined, null, '', 42, {}]) {
      expect(injectableDocumentUrl(reported, 'https://fallback.example/'), JSON.stringify(reported)).toBe(
        'https://fallback.example/'
      )
    }
  })

  it('refuses anything that is not a web page', () => {
    /*
      `about:blank` and a `data:` document have no host to key rules on, and an internal page must never be
      restyled by a downloaded list — that would be a filter list rearranging the browser own settings
      screen. Refusing here rather than at each call site means there is one place to get it right.
    */
    for (const url of [
      'about:blank',
      'data:text/html,<p>x',
      'tessera://settings',
      'file:///tmp/page.html',
      'not a url',
      ''
    ]) {
      expect(injectableDocumentUrl(url, 'about:blank'), url).toBeNull()
    }
  })

  it('accepts plain http as well as https', () => {
    // A local development server is an ordinary page and gets the same treatment.
    expect(injectableDocumentUrl('http://127.0.0.1:3000/app', '')).toBe('http://127.0.0.1:3000/app')
  })
})
