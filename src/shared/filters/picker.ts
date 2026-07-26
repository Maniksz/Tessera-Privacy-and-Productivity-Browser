import {
  classifyAttribute,
  classifyClassName,
  classifyElementId,
  type IdentifierVerdict
} from './identifiers.js'

/**
 * Selector generation for the element picker.
 *
 * The user points at something and the browser has to write the rule. Two things
 * decide whether that rule is any good, and they pull against each other: it has to
 * match the thing pointed at *tomorrow* (so it must not be built on names a build
 * step regenerates — `identifiers.ts` is that half) and it must not match anything
 * else (so it has to be checked against the page, not merely constructed).
 *
 * The second half is why this file counts. A selector that matches too little is a
 * rule that does nothing, which the user notices immediately and can retry. A
 * selector that matches too much takes the article out along with the advertisement,
 * and the worst version of that is a selector matching an *ancestor* of the target:
 * hiding it removes the whole region including everything the user wanted to keep.
 * That case is checked directly rather than guessed at from a match count, because
 * it is the one where a count says nothing — an ancestor selector can match exactly
 * one element and still be catastrophic.
 *
 * The picker runs in a renderer, so nothing here takes an `Element`. The renderer
 * flattens what it sees into `ElementDescription`s — tag, id, classes, attributes,
 * position among siblings, ancestor chain — and this module reads and scores them.
 * That keeps the interesting logic testable without a DOM, and it keeps the DOM
 * traversal (which needs a real document) down to a transcription with no decisions
 * in it.
 *
 * The estimate is deliberately taken against *the description the caller supplied*
 * rather than against the live document. The renderer could of course run
 * `querySelectorAll` and count exactly; the reason not to is that the count then
 * comes from a different mechanism than the choice, and the two would disagree the
 * first time either changed. Here the same matcher that scores a candidate is the one
 * that reports what the user is about to hide.
 */

export interface ElementAttribute {
  readonly name: string
  readonly value: string
}

/** One element, as the renderer transcribed it. */
export interface ElementNode {
  /** Lower-cased tag name. */
  readonly tag: string
  readonly id: string | null
  readonly classes: readonly string[]
  readonly attributes: readonly ElementAttribute[]
  /** 1-based position among the parent's element children; 0 for the root. */
  readonly childIndex: number
}

export interface ElementDescription extends ElementNode {
  /** Nearest first, up to the document element. */
  readonly ancestors: readonly ElementNode[]
}

/** How the relation to the previous step in a plan is written. */
export type Combinator = 'descendant' | 'child'

/**
 * One compound selector in a plan.
 *
 * A plan rather than a string, so that the same structure can be rendered for the
 * user and matched against descriptions. Generating text and then parsing it back to
 * score it would be two implementations of one selector language.
 */
export interface SelectorStep {
  readonly tag: string | null
  readonly id: string | null
  readonly classes: readonly string[]
  readonly attributes: readonly ElementAttribute[]
  /** `:nth-child(n)`; 0 when the step does not constrain position. */
  readonly childIndex: number
  /** Relation to the step before it; ignored for the first step. */
  readonly combinator: Combinator
}

/** Outermost step first, the target last. */
export type SelectorPlan = readonly SelectorStep[]

export type SelectorStrategy =
  /** `#masthead` — one element, shortest possible rule. */
  | 'id'
  /** `.ad-slot`, `div.ad-slot.wide` */
  | 'class'
  /** `div[data-ad-region="top"]` */
  | 'attribute'
  /** Scoped under an ancestor that has a usable name of its own. */
  | 'scoped'
  /** A positional path. Works now, breaks when the page reorders. */
  | 'structural'

export type SelectorWarning =
  /** Would hide an ancestor of the target: the surrounding region goes with it. */
  | 'matches-ancestor'
  /** Matches more elements than a single ad slot plausibly is. */
  | 'matches-many'
  /** Relies on `:nth-child`, so it breaks when the page reorders. */
  | 'positional'
  /** Nothing on the element or its ancestors survived `identifiers.ts`. */
  | 'no-stable-feature'

/** A name the picker declined to use, and why, so the interface can say so. */
export interface RefusedFeature {
  readonly kind: 'id' | 'class'
  readonly name: string
  readonly reason: IdentifierVerdict
}

export interface SelectorProposal {
  readonly selector: string
  readonly strategy: SelectorStrategy
  /**
   * How many of the described elements this would hide. Always at least 1: the
   * target itself is counted whether or not the caller included it.
   */
  readonly estimatedMatches: number
  readonly warnings: readonly SelectorWarning[]
  readonly refused: readonly RefusedFeature[]
}

/**
 * Above this, a candidate is treated as too broad and the search keeps looking.
 *
 * Chosen as "more than a screenful of slots": a carousel of adverts or a column of
 * sponsored rows is a dozen elements, a whole article's paragraphs are not. It is a
 * threshold on a warning rather than on a refusal — the user is shown the count and
 * confirms — so being slightly wrong costs a warning, not a broken page.
 */
export const MATCH_WARNING_LIMIT = 12

const NO_ATTRIBUTES: readonly ElementAttribute[] = []

function renderStep(step: SelectorStep): string {
  const attributes = step.attributes.map((attribute) => `[${attribute.name}="${attribute.value}"]`)
  const position = step.childIndex === 0 ? '' : `:nth-child(${step.childIndex})`
  const head =
    step.id === null
      ? (step.tag ?? '') + step.classes.map((name) => `.${name}`).join('')
      : `#${step.id}`
  // A step that constrains nothing but position still needs something to hang the
  // pseudo-class on, and `*` is what that is.
  const body = `${head}${attributes.join('')}${position}`
  return body === '' ? '*' : body
}

export function renderSelectorPlan(plan: SelectorPlan): string {
  return plan
    .map((step, index) =>
      index === 0
        ? renderStep(step)
        : `${step.combinator === 'child' ? ' > ' : ' '}${renderStep(step)}`
    )
    .join('')
}

function stepMatches(step: SelectorStep, element: ElementNode): boolean {
  if (step.tag !== null && step.tag !== element.tag) return false
  if (step.id !== null && step.id !== element.id) return false
  if (step.childIndex !== 0 && step.childIndex !== element.childIndex) return false
  if (!step.classes.every((name) => element.classes.includes(name))) return false
  return step.attributes.every((wanted) =>
    element.attributes.some(
      (actual) => actual.name === wanted.name && actual.value === wanted.value
    )
  )
}

/**
 * Whether a plan matches an element.
 *
 * Right to left, with backtracking over descendant steps. Greedy matching would be
 * wrong for a plan like `.a .a .b` on a chain with three `.a`s, and while the picker
 * does not currently generate such a plan, a matcher that is only correct for the
 * plans one generator happens to produce is a trap for the next change.
 */
function planMatches(plan: SelectorPlan, element: ElementDescription): boolean {
  const last = plan.slice(-1)
  const rest = plan.slice(0, -1)
  return last.every(
    (step) => stepMatches(step, element) && ancestorsMatch(rest, step.combinator, element.ancestors)
  )
}

function ancestorsMatch(
  plan: SelectorPlan,
  combinator: Combinator,
  ancestors: readonly ElementNode[]
): boolean {
  const last = plan.slice(-1)
  const rest = plan.slice(0, -1)
  // Nothing left to place: the remaining ancestors are free.
  if (last.length === 0) return true
  const limit = combinator === 'child' ? 1 : ancestors.length
  return last.some((step) =>
    ancestors
      .slice(0, limit)
      .some(
        (ancestor, offset) =>
          stepMatches(step, ancestor) &&
          ancestorsMatch(rest, step.combinator, ancestors.slice(offset + 1))
      )
  )
}

/** The target's ancestors, each as a description in its own right. */
function ancestorDescriptions(target: ElementDescription): readonly ElementDescription[] {
  return target.ancestors.map((ancestor, offset) => ({
    ...ancestor,
    ancestors: target.ancestors.slice(offset + 1)
  }))
}

function countMatches(plan: SelectorPlan, elements: readonly ElementDescription[]): number {
  return elements.filter((element) => planMatches(plan, element)).length
}

export interface SelectorRequest {
  readonly target: ElementDescription
  /**
   * Elements the estimate is taken against — in practice every element the picker
   * surveyed. May be empty, and may or may not include the target; the target is
   * counted exactly once either way.
   */
  readonly page: readonly ElementDescription[]
}

function stepFor(overrides: Partial<SelectorStep>): SelectorStep {
  return {
    tag: null,
    id: null,
    classes: [],
    attributes: NO_ATTRIBUTES,
    childIndex: 0,
    combinator: 'descendant',
    ...overrides
  }
}

function usableClassesOf(node: ElementNode): readonly string[] {
  return node.classes.filter((name) => classifyClassName(name) === 'usable')
}

function usableIdOf(node: ElementNode): string | null {
  return node.id !== null && classifyElementId(node.id) === 'usable' ? node.id : null
}

function usableAttributesOf(node: ElementNode): readonly ElementAttribute[] {
  return node.attributes.filter(
    (attribute) => classifyAttribute(attribute.name, attribute.value) === 'usable'
  )
}

function refusedFeaturesOf(node: ElementNode): readonly RefusedFeature[] {
  const refused: RefusedFeature[] = []
  for (const id of node.id === null ? [] : [node.id]) {
    const reason = classifyElementId(id)
    if (reason !== 'usable') refused.push({ kind: 'id', name: id, reason })
  }
  for (const name of node.classes) {
    const reason = classifyClassName(name)
    if (reason !== 'usable') refused.push({ kind: 'class', name, reason })
  }
  return refused
}

interface Candidate {
  readonly plan: SelectorPlan
  readonly strategy: SelectorStrategy
}

/**
 * Classes ordered by how much they narrow, most selective first.
 *
 * The ordering matters because "minimal" and "specific" are both wanted and a single
 * class has to be picked before two are tried. Source order would be arbitrary; the
 * match count is the same measure the proposal is judged by, so the choice and the
 * judgement cannot drift apart.
 */
function classesBySelectivity(
  classes: readonly string[],
  universe: readonly ElementDescription[]
): readonly string[] {
  return classes
    .map((name, order) => ({
      name,
      order,
      matches: countMatches([stepFor({ classes: [name] })], universe)
    }))
    .sort((left, right) => left.matches - right.matches || left.order - right.order)
    .map((entry) => entry.name)
}

/**
 * Candidate selectors, least specific first.
 *
 * Order *is* the policy: the first candidate that does not overreach wins, so putting
 * the short readable ones first is what makes the result minimal, and putting the
 * positional ones last is what keeps `:nth-child` out of a rule that did not need it.
 */
function candidatesFor(
  request: SelectorRequest,
  universe: readonly ElementDescription[]
): readonly Candidate[] {
  const { target } = request
  const candidates: Candidate[] = []
  const id = usableIdOf(target)
  if (id !== null) candidates.push({ plan: [stepFor({ id })], strategy: 'id' })

  const classes = classesBySelectivity(usableClassesOf(target), universe)
  const attributes = usableAttributesOf(target)

  for (const name of classes.slice(0, 1)) {
    candidates.push({ plan: [stepFor({ classes: [name] })], strategy: 'class' })
    candidates.push({ plan: [stepFor({ tag: target.tag, classes: [name] })], strategy: 'class' })
  }
  for (const pair of classes.length >= 2 ? [classes.slice(0, 2)] : []) {
    candidates.push({ plan: [stepFor({ tag: target.tag, classes: pair })], strategy: 'class' })
  }
  if (classes.length > 2) {
    candidates.push({ plan: [stepFor({ tag: target.tag, classes })], strategy: 'class' })
  }

  for (const attribute of attributes) {
    candidates.push({
      plan: [stepFor({ tag: target.tag, attributes: [attribute] })],
      strategy: 'attribute'
    })
    for (const name of classes.slice(0, 1)) {
      candidates.push({
        plan: [stepFor({ tag: target.tag, classes: [name], attributes: [attribute] })],
        strategy: 'attribute'
      })
    }
  }

  const own = ownStepOf(target, classes, attributes)
  candidates.push(...scopedCandidates(target, own))
  candidates.push({ plan: structuralPlan(target, own), strategy: 'structural' })
  return candidates
}

/** The most specific description of the target itself, without any scoping. */
function ownStepOf(
  target: ElementDescription,
  classes: readonly string[],
  attributes: readonly ElementAttribute[]
): SelectorStep {
  return stepFor({
    tag: target.tag,
    classes: classes.slice(0, 2),
    attributes: attributes.slice(0, 1)
  })
}

/**
 * The target scoped under the nearest ancestor that has a name of its own.
 *
 * This is the case that saves a rule from `:nth-child`: the element itself may carry
 * nothing usable while its container is an unmistakable `#sidebar`, and
 * `#sidebar > div` is both stable and narrow.
 */
function scopedCandidates(target: ElementDescription, own: SelectorStep): readonly Candidate[] {
  const candidates: Candidate[] = []
  target.ancestors.forEach((ancestor, offset) => {
    const combinator: Combinator = offset === 0 ? 'child' : 'descendant'
    const id = usableIdOf(ancestor)
    for (const named of id === null ? [] : [id]) {
      candidates.push({
        plan: [stepFor({ id: named }), { ...own, combinator }],
        strategy: 'scoped'
      })
    }
    for (const name of usableClassesOf(ancestor).slice(0, 1)) {
      candidates.push({
        plan: [stepFor({ tag: ancestor.tag, classes: [name] }), { ...own, combinator }],
        strategy: 'scoped'
      })
    }
  })
  return candidates
}

/** A step naming an ancestor by id or class, or null when it has neither. */
function namedStepOf(node: ElementNode): SelectorStep | null {
  const id = usableIdOf(node)
  if (id !== null) return stepFor({ id })
  for (const name of usableClassesOf(node).slice(0, 1)) {
    return stepFor({ tag: node.tag, classes: [name] })
  }
  return null
}

interface Anchor {
  /** How far up the ancestor is; the chain's length when there is none. */
  readonly offset: number
  /** The step naming it, as a plan of one — or of none, when nothing was named. */
  readonly step: SelectorPlan
}

/**
 * The nearest ancestor worth naming.
 *
 * Returns the step along with the distance rather than the distance alone, so that no
 * caller has to look the ancestor up again and handle a "named ancestor with no name"
 * case that cannot occur.
 */
function anchorOf(target: ElementDescription): Anchor {
  for (const [offset, ancestor] of target.ancestors.entries()) {
    const step = namedStepOf(ancestor)
    if (step !== null) return { offset, step: [step] }
  }
  return { offset: target.ancestors.length, step: [] }
}

/**
 * How many steps a positional path may have.
 *
 * A path from `html` down records every layer of a page's structure, so any one of
 * them changing breaks it — and a rule that long is also unreadable in the list the
 * user is supposed to be able to audit. Truncating is safe because the first step of a
 * plan is matched against the target's ancestors rather than against the document
 * root: cutting the top makes the rule broader, never narrower, so it still hides what
 * the user pointed at.
 */
const MAX_STRUCTURAL_STEPS = 4

/**
 * The last resort: the target's position under the nearest named ancestor.
 *
 * Anchored at that ancestor rather than at the document, because `#sidebar >
 * div:nth-child(2)` survives changes elsewhere on the page and a path from the root
 * does not.
 */
function structuralPlan(target: ElementDescription, own: SelectorStep): SelectorPlan {
  const { offset, step: anchor } = anchorOf(target)
  const climb = target.ancestors
    .slice(0, offset)
    .reverse()
    .map((ancestor) =>
      stepFor({ tag: ancestor.tag, childIndex: ancestor.childIndex, combinator: 'child' })
    )
  const steps = [
    ...anchor,
    ...climb,
    { ...own, childIndex: target.childIndex, combinator: 'child' as Combinator }
  ]
  return steps.slice(-MAX_STRUCTURAL_STEPS)
}

interface Score {
  readonly matches: number
  readonly hitsAncestor: boolean
}

function scoreOf(
  plan: SelectorPlan,
  universe: readonly ElementDescription[],
  ancestors: readonly ElementDescription[]
): Score {
  return {
    matches: countMatches(plan, universe),
    hitsAncestor: ancestors.some((ancestor) => planMatches(plan, ancestor))
  }
}

function isPositional(plan: SelectorPlan): boolean {
  return plan.some((step) => step.childIndex !== 0)
}

function warningsOf(
  plan: SelectorPlan,
  score: Score,
  anchored: boolean
): readonly SelectorWarning[] {
  const warnings: SelectorWarning[] = []
  if (score.hitsAncestor) warnings.push('matches-ancestor')
  if (score.matches > MATCH_WARNING_LIMIT) warnings.push('matches-many')
  if (isPositional(plan)) warnings.push('positional')
  if (!anchored) warnings.push('no-stable-feature')
  return warnings
}

/**
 * A selector for the element the user pointed at.
 *
 * Total: every element has a description, and the last candidate — a positional step
 * under the nearest named ancestor — always matches it, so there is no "could not
 * find a selector" answer to handle. What varies is the `warnings`, and the picker is
 * expected to show them before the user confirms.
 */
export function proposeSelector(request: SelectorRequest): SelectorProposal {
  const { target } = request
  // The target is counted once whether or not the caller included it, so the estimate
  // is never 0 and a caller cannot make it wrong by being helpful.
  const universe = [target, ...request.page.filter((element) => element !== target)]
  const ancestors = ancestorDescriptions(target)
  const refused = refusedFeaturesOf(target)
  const anchored =
    usableIdOf(target) !== null ||
    usableClassesOf(target).length > 0 ||
    usableAttributesOf(target).length > 0 ||
    anchorOf(target).step.length > 0

  const scored = candidatesFor(request, universe).map((candidate) => ({
    candidate,
    score: scoreOf(candidate.plan, universe, ancestors)
  }))
  // Reduced without a seed on purpose: `candidatesFor` always ends with the positional
  // path, and every candidate is built from the target's own name, attributes or
  // position, so each one matches it. There is no "found no selector" answer, and a
  // seed would introduce one that no test could reach.
  const chosen = scored.reduce((best, candidate) => (preferred(candidate, best) ? candidate : best))
  return proposalOf(chosen.candidate, chosen.score, refused, anchored)
}

interface ScoredCandidate {
  readonly candidate: Candidate
  readonly score: Score
}

function isAcceptable(score: Score): boolean {
  return !score.hitsAncestor && score.matches <= MATCH_WARNING_LIMIT
}

/**
 * Ancestor hits sort behind everything else, however few elements they match.
 *
 * A selector matching one element can still be the wrong one element. The penalty is
 * larger than any plausible match count so the two criteria cannot trade against each
 * other.
 */
const ANCESTOR_PENALTY = 1_000_000

function rankOf(score: Score): number {
  return (score.hitsAncestor ? ANCESTOR_PENALTY : 0) + score.matches
}

/**
 * Whether a later candidate should displace the incumbent.
 *
 * The first acceptable candidate in ladder order wins, which is what makes the result
 * minimal — later candidates are more specific, and specificity nobody needed is just
 * a longer rule. When nothing is acceptable the narrowest is taken instead, so the
 * proposal shown to the user is the least bad rather than the last tried.
 */
function preferred(candidate: ScoredCandidate, incumbent: ScoredCandidate): boolean {
  if (isAcceptable(incumbent.score)) return false
  if (isAcceptable(candidate.score)) return true
  return rankOf(candidate.score) < rankOf(incumbent.score)
}

function proposalOf(
  candidate: Candidate,
  score: Score,
  refused: readonly RefusedFeature[],
  anchored: boolean
): SelectorProposal {
  return {
    selector: renderSelectorPlan(candidate.plan),
    strategy: candidate.strategy,
    estimatedMatches: score.matches,
    warnings: warningsOf(candidate.plan, score, anchored),
    refused
  }
}

/**
 * How many of the described elements a plan would hide.
 *
 * The same measure `proposeSelector` judges its own candidates by, exported so the
 * picker can score a plan the user adjusted — dropping a class, widening a scope —
 * without a second implementation of what "matches" means. Plans only; a selector
 * typed as text would need a CSS parser, and a parser that understood less than the
 * browser would report a rule as narrower than it is.
 */
export function estimateMatches(
  plan: SelectorPlan,
  elements: readonly ElementDescription[]
): number {
  return countMatches(plan, elements)
}

/**
 * The filter-list line for a proposal.
 *
 * Always scoped to a host. A generic `##selector` from a picker would apply the user's
 * one-off judgement about one page to every site they ever visit, and the person
 * clicking "block this" is not making that claim. The syntax is the lists' own, so the
 * rule goes through the same parser and gains nothing bespoke.
 */
export function cosmeticRuleFor(hostname: string, selector: string): string {
  return `${hostname.toLowerCase()}##${selector}`
}

/** `host#@#selector` — the line that undoes a rule a list applied to this host. */
export function cosmeticExceptionFor(hostname: string, selector: string): string {
  return `${hostname.toLowerCase()}#@#${selector}`
}
