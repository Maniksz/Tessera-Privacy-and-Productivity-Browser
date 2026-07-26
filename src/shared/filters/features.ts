/**
 * Feature-keyed access to the generic cosmetic selectors.
 *
 * `cosmeticSelectorsFor` hands back the whole generic set, and from the three
 * default lists that is 28 914 selectors — 526 kB of selector text. Injected on
 * every document it would cost more parse and style-recalculation work than the
 * advertising it removes, which is not a trade a blocker gets to make silently.
 *
 * So the set is keyed by the feature a selector *needs the document to contain*.
 * `##.ad-slot` cannot match unless some element carries the class `ad-slot`;
 * `###banner img` cannot match without the id `banner`. The injector surveys what
 * the document actually presents and asks for the selectors keyed to those
 * features, which is what uBlock Origin does and the reason its generic cosmetic
 * filtering is affordable at all.
 *
 * Three rules make the keying honest rather than merely small:
 *
 *   - **A selector is filed under exactly one feature.** A selector needing both
 *     `.wrapper` and `#ad` matches only where both are present, so filing it under
 *     either one alone still finds it — and filing it under one keeps "has this
 *     feature been asked about already" a complete answer to "has this selector
 *     been served already". That is what makes the incremental query cheap.
 *   - **Only features required *outside* every parenthesis count.** `div:not(.ad)`
 *     needs no `.ad` in the document; it needs the opposite. Rather than maintain
 *     an allowlist of which pseudo-classes imply presence (`:has` does, `:not` and
 *     `:is` do not), everything inside `(…)` is ignored. Fewer keys, never a wrong
 *     one.
 *   - **A selector list is keyed on the features every branch needs.** `.a, .b`
 *     matches a page with only `.a`, so its key set is the *intersection* of the
 *     branches — usually empty, which sends it to `unkeyed`.
 *
 * The remaining direction of error is the one that must not happen: a selector
 * filed under a feature the page will never report is a selector that silently
 * stops blocking. Escapes are where that lurks — `.\31 23` is the class `123`, and
 * a naive scan reads a tag named `23` out of it — so a selector containing a
 * backslash is not keyed at all.
 */

export type SelectorFeatureKind = 'class' | 'id' | 'tag'

/** One feature a selector needs, and the axis it belongs to. */
export interface SelectorKey {
  readonly kind: SelectorFeatureKind
  readonly name: string
}

/**
 * What a document presents, as the injector surveyed it.
 *
 * Class names and ids are case-sensitive in HTML, so nothing here is lower-cased.
 * Tag names are, because the parser lower-cases them too.
 */
export interface DocumentFeatures {
  readonly classes: readonly string[]
  readonly ids: readonly string[]
  readonly tags: readonly string[]
}

export const NO_DOCUMENT_FEATURES: DocumentFeatures = { classes: [], ids: [], tags: [] }

/** Features a selector needs present, per axis; empty on every axis means unkeyable. */
export interface SelectorKeyCandidates {
  readonly classes: readonly string[]
  readonly ids: readonly string[]
  readonly tags: readonly string[]
}

const NO_CANDIDATES: SelectorKeyCandidates = { classes: [], ids: [], tags: [] }

/**
 * Bytes a selector adds to a stylesheet: its own text plus the `,\n` that joins it
 * to the next one. `cosmeticCss` is what actually builds the text; this only has to
 * agree with it closely enough for a size report to mean something.
 */
const JOIN_BYTES = 2

function isIdentifierCharacter(character: string): boolean {
  // CSS identifiers also admit everything above ASCII, and EasyList does carry
  // selectors with non-ASCII class names.
  return /[A-Za-z0-9_-]/.test(character) || character.charCodeAt(0) > 0x7f
}

function identifierAt(text: string, from: number): string {
  let end = from
  while (end < text.length && isIdentifierCharacter(text.slice(end, end + 1))) end += 1
  return text.slice(from, end)
}

/**
 * The selector with every `[…]` and `(…)` group replaced by a single space, or null
 * when it cannot be read with confidence.
 *
 * Blanking the groups is what lets the rest be scanned with a flat loop: attribute
 * values and pseudo-class arguments are exactly the places where a `.`, a `#` or a
 * comma means something other than what it means outside them. A space rather than
 * nothing, so `div[data-ad]` still shows `div` as the start of a compound.
 *
 * Null for an unbalanced or unterminated selector. That is a filter list this engine
 * does not understand, and an unkeyed selector is injected everywhere — correct, if
 * more expensive — where a misread one would be filed under a feature no page ever
 * reports and would quietly stop blocking.
 */
function maskedSelector(selector: string): string | null {
  // A CSS escape can hide any character inside an identifier, including the space
  // that terminates a hex escape. Nothing downstream would notice.
  if (selector.includes('\\')) return null

  let masked = ''
  let depth = 0
  let quote = ''
  for (const character of selector) {
    if (quote !== '') {
      if (character === quote) quote = ''
      continue
    }
    if (depth > 0) {
      if (character === '"' || character === "'") quote = character
      else if (character === '(' || character === '[') depth += 1
      else if (character === ')' || character === ']') {
        depth -= 1
        if (depth === 0) masked += ' '
      }
      continue
    }
    if (character === '(' || character === '[') {
      depth += 1
      continue
    }
    if (character === ')' || character === ']') return null
    masked += character
  }
  return depth === 0 && quote === '' ? masked : null
}

interface BranchCandidates {
  readonly classes: ReadonlySet<string>
  readonly ids: ReadonlySet<string>
  readonly tags: ReadonlySet<string>
}

/**
 * Features one branch of a selector list needs.
 *
 * Every simple selector in a branch has to match something, whatever combinator
 * joins them: `#a > .b ~ .c` needs all three present. So a branch's requirements
 * are simply everything the scan finds.
 */
function scanBranch(text: string): BranchCandidates {
  const classes = new Set<string>()
  const ids = new Set<string>()
  const tags = new Set<string>()
  let position = 0
  // A bare identifier is a tag name only where a compound selector starts;
  // elsewhere it is the name of a pseudo-class.
  let compoundStart = true

  while (position < text.length) {
    const character = text.slice(position, position + 1)
    if (character === '.' || character === '#') {
      const name = identifierAt(text, position + 1)
      position += 1 + name.length
      if (name === '') continue
      if (character === '.') classes.add(name)
      else ids.add(name)
      compoundStart = false
      continue
    }
    if (character === ':') {
      position += 1 + identifierAt(text, position + 1).length
      compoundStart = false
      continue
    }
    if (isIdentifierCharacter(character)) {
      const name = identifierAt(text, position)
      position += name.length
      if (compoundStart) tags.add(name.toLowerCase())
      compoundStart = false
      continue
    }
    position += 1
    if (character === '*') {
      compoundStart = false
      continue
    }
    // Combinators and whitespace begin the next compound. Anything else — a `|`
    // namespace separator, say — leaves the position where it was.
    if (/[\s>+~]/.test(character)) compoundStart = true
  }

  return { classes, ids, tags }
}

/**
 * Names present in every branch.
 *
 * Counted rather than folded with an accumulator, so there is no "no branches yet"
 * case to seed — `String.split` always yields at least one branch, and a seed would
 * add a state no test could reach.
 */
function intersectionOf(
  branches: readonly BranchCandidates[],
  axis: (branch: BranchCandidates) => ReadonlySet<string>
): readonly string[] {
  const counts = new Map<string, number>()
  for (const branch of branches) {
    for (const name of axis(branch)) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const shared: string[] = []
  for (const [name, count] of counts) {
    if (count === branches.length) shared.push(name)
  }
  return shared
}

/**
 * The features a selector needs the document to contain.
 *
 * Exported because it is the load-bearing half of the index: a mistake here shows up
 * as advertising that quietly reappears, which no coverage figure would reveal.
 */
export function selectorKeyCandidatesOf(selector: string): SelectorKeyCandidates {
  const masked = maskedSelector(selector)
  if (masked === null) return NO_CANDIDATES
  const branches = masked.split(',').map(scanBranch)
  return {
    classes: intersectionOf(branches, (branch) => branch.classes),
    ids: intersectionOf(branches, (branch) => branch.ids),
    tags: intersectionOf(branches, (branch) => branch.tags)
  }
}

export interface GenericFeatureIndex {
  readonly byClass: ReadonlyMap<string, readonly string[]>
  readonly byId: ReadonlyMap<string, readonly string[]>
  readonly byTag: ReadonlyMap<string, readonly string[]>
  /**
   * Selectors no feature an injector can cheaply survey will narrow — `[data-ad]`,
   * `a[href*="/click?"]`, or anything written with a CSS escape.
   */
  readonly unkeyed: readonly string[]
  /** Distinct selectors held; duplicates across lists are folded on the way in. */
  readonly selectorCount: number
  /** Approximate stylesheet bytes for everything held. */
  readonly byteCount: number
  /** Of those, the bytes every document pays regardless of what it contains. */
  readonly unkeyedByteCount: number
}

function keyString(key: SelectorKey): string {
  return `${key.kind}:${key.name}`
}

function bytesOf(selectors: readonly string[]): number {
  let bytes = 0
  for (const selector of selectors) bytes += selector.length + JOIN_BYTES
  return bytes
}

/**
 * The candidate keys of a selector, ids first.
 *
 * Ids before classes so that a tie in list frequency is broken towards the id: a
 * document holds one element per id and many per class, so the id is the key more
 * likely to be absent — and an absent key is a selector not sent.
 */
function namedKeysOf(candidates: SelectorKeyCandidates): readonly SelectorKey[] {
  return [
    ...[...candidates.ids].sort().map((name): SelectorKey => ({ kind: 'id', name })),
    ...[...candidates.classes].sort().map((name): SelectorKey => ({ kind: 'class', name }))
  ]
}

function tagKeysOf(candidates: SelectorKeyCandidates): readonly SelectorKey[] {
  return [...candidates.tags].sort().map((name): SelectorKey => ({ kind: 'tag', name }))
}

/**
 * The candidate that fewest other selectors share.
 *
 * Same reasoning as the network index's rarest-token choice: filing under the
 * commonest name piles thousands of selectors under `ad` or `banner`, and a single
 * such class on the page then drags all of them in — which is the cost this index
 * exists to avoid. Ties go to the first candidate, and `namedKeysOf` orders them so
 * that is deterministic.
 */
function rarest(
  keys: readonly SelectorKey[],
  frequency: ReadonlyMap<string, number>
): SelectorKey | null {
  let best: SelectorKey | null = null
  let bestCount = Number.POSITIVE_INFINITY
  for (const key of keys) {
    // Every candidate was counted into `frequency` in the pass before this one, so
    // there is no missing-key case to guard — a `?? 0` would be a branch no test
    // could reach.
    const count = frequency.get(keyString(key))!
    if (count < bestCount) {
      best = key
      bestCount = count
    }
  }
  return best
}

/**
 * The key a selector is filed under, or null when nothing usable was found.
 *
 * A class or an id is preferred over a tag name even when the tag is rarer in the
 * lists, because rarity in the lists is only a proxy: every document has a `div` and
 * most have an `iframe`, so a tag key is close to always-on, while a class or id key
 * is genuinely absent most of the time.
 */
function chosenKeyOf(
  candidates: SelectorKeyCandidates,
  frequency: ReadonlyMap<string, number>
): SelectorKey | null {
  return rarest(namedKeysOf(candidates), frequency) ?? rarest(tagKeysOf(candidates), frequency)
}

function fileUnder(buckets: Map<string, string[]>, name: string, selector: string): void {
  const existing = buckets.get(name)
  if (existing === undefined) buckets.set(name, [selector])
  else existing.push(selector)
}

/**
 * Files a set of generic selectors by the feature each one needs.
 *
 * Duplicates are folded here rather than at query time. Two lists carrying
 * `##.ad-banner` would otherwise put the same selector in a page twice, and — worse
 * — would break the guarantee that "this feature was already answered" implies
 * "these selectors were already sent".
 */
export function buildGenericFeatureIndex(selectors: readonly string[]): GenericFeatureIndex {
  const seen = new Set<string>()
  const entries: Array<{ selector: string; candidates: SelectorKeyCandidates }> = []
  for (const selector of selectors) {
    if (seen.has(selector)) continue
    seen.add(selector)
    entries.push({ selector, candidates: selectorKeyCandidatesOf(selector) })
  }

  const frequency = new Map<string, number>()
  for (const entry of entries) {
    for (const key of [...namedKeysOf(entry.candidates), ...tagKeysOf(entry.candidates)]) {
      const name = keyString(key)
      frequency.set(name, (frequency.get(name) ?? 0) + 1)
    }
  }

  const byClass = new Map<string, string[]>()
  const byId = new Map<string, string[]>()
  const byTag = new Map<string, string[]>()
  const unkeyed: string[] = []
  let byteCount = 0

  for (const entry of entries) {
    byteCount += entry.selector.length + JOIN_BYTES
    const key = chosenKeyOf(entry.candidates, frequency)
    if (key === null) {
      unkeyed.push(entry.selector)
      continue
    }
    if (key.kind === 'class') fileUnder(byClass, key.name, entry.selector)
    else if (key.kind === 'id') fileUnder(byId, key.name, entry.selector)
    else fileUnder(byTag, key.name, entry.selector)
  }

  return {
    byClass,
    byId,
    byTag,
    unkeyed,
    selectorCount: entries.length,
    byteCount,
    unkeyedByteCount: bytesOf(unkeyed)
  }
}

export const EMPTY_GENERIC_FEATURE_INDEX: GenericFeatureIndex = buildGenericFeatureIndex([])

/**
 * One document's progress through a feature index.
 *
 * A page grows: a script inserts a slot, an infinite list appends rows, and each
 * time the injector surveys it there are features it has not asked about before. The
 * cursor is what makes asking again cheap and non-repeating — it remembers the
 * *features* it has answered, and because every selector is filed under exactly one
 * feature, remembering features is a complete account of the selectors served. The
 * alternative, holding every served selector in a set, costs the memory of a second
 * copy of the corpus for the same guarantee.
 *
 * So the caller needs no bookkeeping of its own, and needs no way to recognise a
 * repeat: an empty answer *is* the recognition. One cursor per document, dropped
 * when the document navigates.
 */
export class GenericFeatureCursor {
  readonly #index: GenericFeatureIndex
  readonly #answered = new Set<string>()
  #unkeyedServed = false
  #selectorCount = 0
  #byteCount = 0

  constructor(index: GenericFeatureIndex) {
    this.#index = index
  }

  /**
   * Selectors keyed to features this cursor has not answered before.
   *
   * Empty means there is nothing new to inject, which is the common case after the
   * first survey and the reason a caller can afford to survey often.
   *
   * The unkeyed residue rides along with the first answer. It cannot be narrowed by
   * anything a survey can report, and the honest choices are "always" or "never":
   * never would under-block silently, so it is always, once, and its size is a
   * number the caller can read off `GenericFeatureIndex.unkeyedByteCount`.
   */
  take(features: DocumentFeatures): readonly string[] {
    const selectors: string[] = []
    if (!this.#unkeyedServed) {
      this.#unkeyedServed = true
      selectors.push(...this.#index.unkeyed)
    }
    this.#collect(selectors, 'id', this.#index.byId, features.ids)
    this.#collect(selectors, 'class', this.#index.byClass, features.classes)
    this.#collect(selectors, 'tag', this.#index.byTag, features.tags)

    this.#selectorCount += selectors.length
    this.#byteCount += bytesOf(selectors)
    return selectors
  }

  /** Selectors handed out so far, for a settings page that reports what was saved. */
  get servedSelectorCount(): number {
    return this.#selectorCount
  }

  get servedByteCount(): number {
    return this.#byteCount
  }

  #collect(
    into: string[],
    kind: SelectorFeatureKind,
    buckets: ReadonlyMap<string, readonly string[]>,
    names: readonly string[]
  ): void {
    for (const name of names) {
      const key = `${kind}:${name}`
      if (this.#answered.has(key)) continue
      this.#answered.add(key)
      const bucket = buckets.get(name)
      if (bucket === undefined) continue
      into.push(...bucket)
    }
  }
}
