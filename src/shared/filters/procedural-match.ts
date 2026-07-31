import type { ProceduralAction, ProceduralSelector, ProceduralStep } from './procedural.js'

/**
 * Evaluating a procedural selector against a document, and doing what it asks.
 *
 * ## Why this one runs in the preload's own world
 *
 * The scriptlet runtime has to cross into the page through `executeInMainWorld`, because it redefines
 * properties the *page's* script reads — and that boundary is what forces it to be one self-contained
 * function with no imports.
 *
 * None of that applies here. `preload/cosmetic.ts` already states the fact this rests on: *"The DOM is not
 * isolated — both worlds see one document"*. Matching needs the DOM and nothing else, and hiding is a
 * style on an element. So this is an ordinary module with ordinary imports, running in the isolated world,
 * where the page cannot reach it at all — which is strictly better than the main world: a page can neither
 * observe the matcher nor patch the methods it uses.
 *
 * ## Why the elements are touched inline rather than through a stylesheet
 *
 * A stylesheet needs a selector, and the whole reason these rules exist is that they cannot be expressed
 * as one. So the matched elements are given an inline style. uBlock Origin does the same for the same
 * reason, and the cost is the same: a page can see the attribute and could remove it. That is a trade the
 * declarative path does not have to make, which is why a rule that *can* be plain CSS should stay plain
 * CSS — `parse.ts` only sends a rule here when it contains an operator no engine can evaluate.
 *
 * ## The DOM as a structural view
 *
 * `src/shared` is compiled without the DOM library on purpose (`tsconfig.node.json`), and
 * `fingerprint/mask-environment.ts` reaches the page the same way. Two things follow, and both are wanted:
 * the interfaces below are an exact list of what this file does to a document, so "what can a procedural
 * rule do to my page" is answerable by reading one type; and everything is optional, which is the truth
 * when the document may be mid-teardown.
 */

/** The parts of an element this matcher reads and writes. Nothing else is reachable from here. */
export interface MatchableElement {
  readonly textContent?: string | null
  readonly parentElement?: MatchableElement | null
  matches?: (selector: string) => boolean
  closest?: (selector: string) => MatchableElement | null
  setAttribute?: (name: string, value: string) => void
  removeAttribute?: (name: string) => void
  /** Every attribute currently on the element, for the `/regex/` form of `:remove-attr()`. */
  getAttributeNames?: () => string[]
  remove?: () => void
  /** Iterable for the `/regex/` form of `:remove-class()`; `remove` for the named form. */
  readonly classList?: { remove: (name: string) => void } & Iterable<string>
  readonly style?: { cssText: string; setProperty: (name: string, value: string, priority?: string) => void }
}

export interface MatchableDocument {
  querySelectorAll?: (selector: string) => Iterable<MatchableElement>
  defaultView?: {
    getComputedStyle?: (element: MatchableElement) => { getPropertyValue: (name: string) => string } | null
  } | null
}

/**
 * A `/pattern/flags` or plain-substring argument as a predicate.
 *
 * The same rule the scriptlet runtime uses, and stated once more because the two cannot share it: that one
 * is serialised into the page and may reference nothing outside itself. Slashes mean a regular expression,
 * anything else is a literal substring, and a malformed expression matches nothing rather than throwing —
 * a bad rule must cost its own rule and no more.
 *
 * uBO also honours `i` and `m` flags inside the slashes, which fall out of passing them to `RegExp`.
 */
export function textMatcher(pattern: string): (value: string) => boolean {
  const slashed = /^\/(.*)\/([a-z]*)$/.exec(pattern)
  if (slashed !== null) {
    try {
      const expression = new RegExp(slashed[1]!, slashed[2])
      return (value) => expression.test(value)
    } catch {
      return () => false
    }
  }
  return (value) => value.includes(pattern)
}

const textOf = (element: MatchableElement): string => element.textContent ?? ''

/** One step applied to a set of elements, yielding the next set. */
function applyStep(
  step: ProceduralStep,
  elements: readonly MatchableElement[],
  document: MatchableDocument
): MatchableElement[] {
  switch (step.op) {
    case 'has-text': {
      const matches = textMatcher(step.pattern)
      return elements.filter((element) => matches(textOf(element)))
    }

    case 'min-text-length':
      return elements.filter((element) => textOf(element).length >= step.length)

    case 'upward': {
      const next: MatchableElement[] = []
      for (const element of elements) {
        const ancestor = upward(element, step)
        // Deduplicated: two matched children commonly share one container, and hiding it twice would
        // otherwise mean two passes over the same element on every mutation burst.
        if (ancestor !== null && !next.includes(ancestor)) next.push(ancestor)
      }
      return next
    }

    case 'matches-css': {
      const view = document.defaultView
      const compute = view?.getComputedStyle
      // No computed style available — a detached document, or a stub. Matching nothing is the honest
      // answer; matching everything would hide the page.
      if (view === undefined || view === null || typeof compute !== 'function') return []
      const matches = textMatcher(step.value)
      return elements.filter((element) => {
        try {
          const style = compute.call(view, element)
          if (style === null) return false
          return matches(style.getPropertyValue(step.property).trim())
        } catch {
          return false
        }
      })
    }
  }
}

function upward(element: MatchableElement, step: { levels: number | null; selector: string | null }): MatchableElement | null {
  if (step.selector !== null) {
    /*
      `closest` on the *parent*, not on the element.

      `:upward(selector)` means the nearest **ancestor** matching it, and `element.closest()` includes the
      element itself — so a rule like `.ad:upward(.ad)` would select the thing it started from and hide
      exactly what a plain selector would have hidden, silently turning a container rule into a no-op.
    */
    const parent = element.parentElement
    if (parent === null || parent === undefined) return null
    return typeof parent.closest === 'function' ? parent.closest(step.selector) : null
  }

  /*
    The parent read into a local and checked before it is kept, rather than reassigning and testing.

    The reassigning version needed `current?.parentElement` and `current ?? null`, and both were dead: after
    the check at the bottom of one iteration the compiler knows the value is non-nullish at the top of the
    next, so the optional chain and the fallback were noise a reader has to disprove.
  */
  let current: MatchableElement = element
  for (let level = 0; level < (step.levels ?? 0); level++) {
    const parent = current.parentElement
    if (parent === null || parent === undefined) return null
    current = parent
  }
  return current
}

/** Everything a procedural selector selects, in document order. */
export function matchProcedural(
  selector: ProceduralSelector,
  document: MatchableDocument
): MatchableElement[] {
  const query = document.querySelectorAll
  if (typeof query !== 'function') return []

  let elements: MatchableElement[]
  try {
    elements = [...query.call(document, selector.css)]
  } catch {
    // An invalid CSS prefix. One rule's problem, and it stays one rule's problem.
    return []
  }

  for (const step of selector.steps) {
    if (elements.length === 0) return []
    elements = applyStep(step, elements, document)
  }
  return elements
}

/** The attribute the hidden elements are marked with, so a second pass can skip them. */
export const PROCEDURAL_MARK = 'data-tessera-hidden'

/**
 * Does what the rule asks to one element.
 *
 * Every branch is guarded on its own. This runs on every mutation burst over every matching rule, so one
 * element that cannot be touched — detached between the match and the action, frozen, a stub in a test —
 * must cost itself and not the rest of the pass.
 */
export function applyProceduralAction(element: MatchableElement, action: ProceduralAction): void {
  try {
    switch (action.kind) {
      case 'hide':
        /*
          `setProperty` with `important` rather than assigning `cssText`, because assigning would discard
          the element's own inline styles — a layout the page set up for itself, thrown away to hide a box
          inside it.
        */
        element.style?.setProperty('display', 'none', 'important')
        element.setAttribute?.(PROCEDURAL_MARK, '')
        break
      case 'style':
        // Appended, for the same reason: whatever the page had stays.
        if (element.style !== undefined) {
          element.style.cssText = `${element.style.cssText};${action.declarations}`
        }
        element.setAttribute?.(PROCEDURAL_MARK, '')
        break
      case 'remove':
        element.remove?.()
        break
      case 'remove-attr': {
        /*
          The named form and the pattern form, and the pattern form is the one that matters for what these
          rules are for: a site that randomises an attribute name per session cannot be named literally, which
          is why uBO accepts a regular expression here at all.

          The names are read first and iterated from a copy, because removing an attribute while walking the
          live list would skip the next one.
        */
        for (const name of namesToRemove(element.getAttributeNames?.() ?? [], action)) {
          element.removeAttribute?.(name)
        }
        break
      }
      case 'remove-class': {
        const present = element.classList === undefined ? [] : [...element.classList]
        for (const name of namesToRemove(present, action)) element.classList?.remove(name)
        break
      }
    }
  } catch {
    // See above: this element only.
  }
}

/**
 * Which of the names present should go.
 *
 * The literal list is returned as-is — an attribute the element does not have is a `removeAttribute` that does
 * nothing, so filtering it would be work to avoid work. A pattern has to be matched against what is actually
 * there, which is why the caller reads the names first.
 */
function namesToRemove(
  present: readonly string[],
  action: { readonly names: readonly string[]; readonly pattern: string | null }
): readonly string[] {
  if (action.pattern === null) return action.names
  const matches = textMatcher(action.pattern)
  return present.filter((name) => matches(name))
}

/**
 * Applies every rule to a document, and says how many elements it touched.
 *
 * The count is not decoration: it is what the caller uses to decide whether a pass was worth its cost, and
 * it is the number a settings screen could report as "this rule is doing something". A rule that matches
 * nothing for the lifetime of a page is a rule the user wrote wrongly, and that is worth being able to say.
 */
export function applyProceduralRules(
  selectors: readonly ProceduralSelector[],
  document: MatchableDocument
): number {
  let touched = 0
  for (const selector of selectors) {
    for (const element of matchProcedural(selector, document)) {
      applyProceduralAction(element, selector.action)
      touched += 1
    }
  }
  return touched
}
