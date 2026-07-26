import type { ReaderBlock } from './content.js'
import type { ReaderMetadata } from './metadata.js'

/**
 * What reader mode answers with: an article, or a reason it refused.
 *
 * ## Why the refusal is a value rather than a null
 *
 * `ReaderArticle | null` would have made the refusal a nothing — an empty page, or a fallback the user
 * has to interpret. A value carrying the reason *and* the measurement lets the reader page say which
 * judgement was made and on what evidence: "found 260 of 800 characters of article text". Somebody who
 * disagrees with the refusal then knows exactly what they are disagreeing with, and the figure in front
 * of them is the figure a bug report needs.
 *
 * ## Why this is its own module
 *
 * Deliberately a leaf: the reader page imports these shapes and `refusedOutcome`, and if they lived in
 * `extract.ts` a *value* import of that one function would drag the whole extractor — scoring, name
 * vocabulary, `filters/identifiers.ts` — into a renderer bundle that never runs a line of it. The
 * project treats a shared module's import graph as a performance decision rather than a stylistic one;
 * see `ARCHITECTURE.md`. Both imports above are type-only, so this file has no runtime edges at all.
 */

export const REFUSAL_REASONS = [
  /**
   * The page did not answer with something this build recognises.
   *
   * Produced by the core rather than by the extractor: the transcription runs in the page's main
   * world, so the page's own script can replace the result, and `asReaderDocument` refuses anything
   * off-shape rather than repairing part of it.
   */
  'unreadable',
  /** The extraction this reader page was opened for is no longer held. Reload the original. */
  'expired',
  /**
   * The transcription stopped at its node or depth budget, so the document itself is partial.
   *
   * Refused rather than extracted, and this is the clearest case of the whole argument: on a partial
   * document every measurement is a measurement of a fragment, so a confident extraction would be
   * exactly the silent half-article this feature exists to avoid.
   */
  'truncated',
  /** Not one block of body copy on the page. A link directory, an application shell, a form. */
  'no-prose',
  /** Some prose, but less than `MIN_PROSE_MASS`. A cookie notice, an error page, a stub. */
  'too-little-prose'
] as const

export type ReaderRefusal = (typeof REFUSAL_REASONS)[number]

/**
 * What the judgement was made on, reported either way.
 *
 * Carried on a successful extraction too, not only on a refusal. A reader who finds the article
 * shorter than expected can see that the page held no more prose than what they are looking at, which
 * is the difference between trusting the view and wondering about it.
 */
export interface ReaderMeasurement {
  /** Characters of body text in the chosen container, link text subtracted. See `prose.ts`. */
  readonly mass: number
  /** The same measure over the whole document. `mass` is at least `DESCEND_SHARE` of it. */
  readonly documentMass: number
  /** What `mass` had to reach. Travels with the number so the page needs no copy of the threshold. */
  readonly required: number
  /** How many blocks of body copy the container holds. */
  readonly blocks: number
  /** Share of the container's block text that is link text, `0`–`1`. */
  readonly linkDensity: number
  /** The document was partial; see the `truncated` refusal. */
  readonly truncated: boolean
}

export interface ReaderArticle extends ReaderMetadata {
  readonly blocks: readonly ReaderBlock[]
}

export type ReaderOutcome =
  | {
      readonly kind: 'article'
      /** The address the article was read from, for the link back to the original. */
      readonly url: string
      readonly article: ReaderArticle
      readonly measurement: ReaderMeasurement
    }
  | {
      readonly kind: 'refused'
      readonly url: string
      readonly reason: ReaderRefusal
      readonly measurement: ReaderMeasurement
    }

/**
 * How much article text a page has to hold before reader mode will reformat it.
 *
 * Eight hundred characters of body text with link text already subtracted: about a hundred and thirty
 * words, roughly one screen at a comfortable reading width.
 *
 * **Why not lower.** Four hundred is where the false positives live. A cookie consent notice, a
 * paywall explanation, a "this article has moved" page and a subscription pitch all carry two to four
 * hundred characters of real prose in real paragraphs, and presenting one of those as an article is not
 * a small error — it hides the page's actual controls behind a confident-looking reading view.
 *
 * **Why not higher.** Above roughly a thousand, ordinary short news pieces and release notes start
 * being refused, and a feature that declines the pages it should serve gets switched off once and never
 * looked at again.
 *
 * **Why one number rather than several.** Separate minimums for paragraph count and for link density
 * were the first design, and they overlapped so thoroughly that two of the three could not be reached
 * by any realistic page — a threshold nothing can trigger is a threshold nobody has checked. Blocks
 * under `MIN_BLOCK_CHARS` contribute nothing to the measure and link text is subtracted from it, so
 * this single figure already carries both judgements, in a unit a person can hold an opinion about.
 */
export const MIN_PROSE_MASS = 800

/** Reported when there was no document to measure at all: `unreadable` and `expired`. */
export const NO_MEASUREMENT: ReaderMeasurement = {
  mass: 0,
  documentMass: 0,
  required: MIN_PROSE_MASS,
  blocks: 0,
  linkDensity: 0,
  truncated: false
}

/** A refusal reached without a document — by the core, or by the reader page itself. */
export function refusedOutcome(reason: ReaderRefusal, url: string): ReaderOutcome {
  return { kind: 'refused', url, reason, measurement: NO_MEASUREMENT }
}
