import type { DocumentFeatures } from './features.js'

/**
 * How cosmetic rules get from the core into a page.
 *
 * Zod-free and dependency-free, because the preload imports it: a value import of the validation
 * library there would land in a bundle that runs in every renderer, and the preload's size budget is
 * already the tightest in the project.
 *
 * ## Two channels, because there are two moments
 *
 * A page's *host-specific* rules — `example.com##.ad-slot` — are known from the address alone, so they
 * can be answered before any script runs. That has to be synchronous: `document-start` is the last
 * moment before the page's own code, and an awaited answer arrives after it, which means a visible
 * flash of the element the rule was meant to hide.
 *
 * The *generic* rules — `##.sponsored`, which apply everywhere — are a different problem. There are
 * tens of thousands of them, and sending all of them to every page would be megabytes of CSS per
 * document. So the page reports which classes, ids and tags it actually contains, and gets back only
 * the selectors that could match. That needs the DOM, so it happens after it exists, and it may happen
 * again when a single-page application builds more of itself — which makes it asynchronous, repeated,
 * and incremental.
 *
 * ## Why these are not bridge channels
 *
 * Neither goes through `shared/ipc/channels.ts`. A visited page has no bridge at all (spec 6) and
 * cannot reach `ipcRenderer`; these are spoken by the preload only. Routing them through the contract
 * would add two channels that every page uses to the surface `sender-policy.ts` has to defend, for no
 * gain — the same reasoning as `FINGERPRINT_PLAN_CHANNEL`.
 */

/** Synchronous, at `document-start`: the rules that follow from the address alone. */
export const COSMETIC_SPECIFIC_CHANNEL = 'tessera:cosmetic-specific'

/** Asynchronous, after the DOM exists and again as it grows: the generic rules that could match it. */
export const COSMETIC_GENERIC_CHANNEL = 'tessera:cosmetic-generic'

/**
 * How many distinct feature names one report may carry, per kind.
 *
 * A bound rather than trust. The report crosses a process boundary on every mutation burst, and a
 * page can hold a hundred thousand elements — an unbounded survey would be a message larger than the
 * document that produced it. Two thousand names is far past any real page's vocabulary: the largest
 * sites use a few hundred distinct classes, and a page that somehow exceeds this loses only the
 * *generic* rules for its rarest names, never the host-specific ones.
 */
export const MAX_REPORTED_FEATURES = 2_000

/** A minimal element, so the survey can be tested without a DOM. */
export interface SurveyedElement {
  readonly tagName: string
  readonly id: string
  readonly classList: Iterable<string>
}

/**
 * Turns a document's elements into the three lists the engine indexes generic selectors by.
 *
 * Deduplicated, lower-cased for tags, and bounded. The order is the order first seen, which matters
 * only for what a bound truncates: elements near the top of the document are the ones most likely to
 * be a page's chrome and its advert slots.
 *
 * Empty strings are dropped rather than reported. `class=""` and an element with no id both yield one,
 * and a selector key of `""` would match the empty-string entry in the engine's index if one ever
 * existed — a whole-page hide from a missing attribute.
 */
export function surveyFeatures(elements: Iterable<SurveyedElement>): DocumentFeatures {
  const classes = new Set<string>()
  const ids = new Set<string>()
  const tags = new Set<string>()

  for (const element of elements) {
    const tag = element.tagName.toLowerCase()
    if (tag !== '' && tags.size < MAX_REPORTED_FEATURES) tags.add(tag)
    if (element.id !== '' && ids.size < MAX_REPORTED_FEATURES) ids.add(element.id)
    for (const name of element.classList) {
      if (name !== '' && classes.size < MAX_REPORTED_FEATURES) classes.add(name)
    }
  }

  return { classes: [...classes], ids: [...ids], tags: [...tags] }
}

/**
 * Whether two surveys would produce the same answer.
 *
 * The mutation observer fires constantly on a busy page — an advert carousel rotating, a chat widget
 * appending messages — and almost none of those bursts introduce a class the page has not used before.
 * Comparing before asking turns a channel call per burst into a channel call per genuinely new name.
 *
 * Compared by size first: on the common path nothing changed, and that is one integer comparison
 * against three array walks.
 */
export function sameFeatures(left: DocumentFeatures, right: DocumentFeatures): boolean {
  return (
    sameList(left.classes, right.classes) &&
    sameList(left.ids, right.ids) &&
    sameList(left.tags, right.tags)
  )
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

/** What the core sends back. `null` means "nothing to add", which is the common answer. */
export type CosmeticStyles = string | null

/** Total, because the answer crosses a process boundary and an old build may answer anything. */
export function asCosmeticStyles(value: unknown): CosmeticStyles {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Total in the other direction: what the core receives may be anything at all. */
export function asDocumentFeatures(value: unknown): DocumentFeatures {
  if (typeof value !== 'object' || value === null) return { classes: [], ids: [], tags: [] }
  const candidate = value as Record<string, unknown>
  return {
    classes: asNameList(candidate['classes']),
    ids: asNameList(candidate['ids']),
    tags: asNameList(candidate['tags'])
  }
}

function asNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    .slice(0, MAX_REPORTED_FEATURES)
}

/**
 * Which document a filtering request is about, or `null` for one that has nothing to filter.
 *
 * Extracted from the injector so it can be tested, because it holds the one decision in that file that can
 * be wrong in a way nobody would notice: the address the *preload* reports is preferred over the view's
 * own, and the reason is a race rather than trust. At `document-start` the view's URL has already moved to
 * the page being loaded while the preload runs for it, and by the time an asynchronous report arrives the
 * view may have moved again. The preload knows which document it is; the view only knows where it is
 * heading.
 *
 * It is still checked for being a real web address, because a compromised renderer can report anything —
 * and the worst that achieves is being served another site's *hiding* rules, which hides things rather
 * than revealing them.
 *
 * `null` for `about:blank`, `data:` documents and our own internal pages: none has a host to key rules on,
 * and a downloaded list rearranging the browser's own settings screen is not a thing anybody wants.
 */
export function injectableDocumentUrl(reported: unknown, fallback: string): string | null {
  const candidate = typeof reported === 'string' && reported !== '' ? reported : fallback
  try {
    const { protocol } = new URL(candidate)
    return protocol === 'http:' || protocol === 'https:' ? candidate : null
  } catch {
    return null
  }
}
