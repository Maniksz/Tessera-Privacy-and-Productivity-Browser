/**
 * How a find bar words what it found.
 *
 * ## Why this is not an expression inside the component
 *
 * "0 of 0" is what falls out of rendering the two numbers Chromium reports, and it is the one
 * wording a find bar must not use: a person who has just mistyped a word needs to be told there is
 * nothing there, not shown a fraction whose numerator happens to be zero. "1 of 1" is the same
 * mistake in miniature — a count offered where there is nothing to count through.
 *
 * So the three cases are named, decided here, and tested here. The component maps a name onto a
 * message key and nothing else, which also keeps the plural rules where the catalogue can see them
 * (spec 7) instead of in a ternary in a JSX attribute.
 *
 * A descriptor rather than a `MessageKey`: this module is imported by the core as well, and the
 * wording of a count is a fact about the search rather than about the catalogue.
 */

export type FindWording =
  /** Nothing has been typed, so there is no count to show and no "nothing found" to claim either. */
  | { say: 'nothing' }
  /** A search is running and the page has not answered. Never rendered as a zero. */
  | { say: 'searching' }
  | { say: 'no-matches' }
  /** Exactly one, which is a statement rather than a position. */
  | { say: 'one-match' }
  | { say: 'ordinal'; active: number; total: number }

/**
 * The wording for a search's current state.
 *
 * `matches: null` is the distinction that stops the flicker: between sending a search and the page
 * answering, a bar that treated "no count yet" as zero would announce "no matches" on every
 * keystroke and then correct itself — so a page full of hits reads as empty while it is being
 * counted.
 */
export function findWording(state: {
  query: string
  matches: number | null
  activeMatch: number
}): FindWording {
  if (state.query === '') return { say: 'nothing' }
  if (state.matches === null) return { say: 'searching' }
  if (state.matches === 0) return { say: 'no-matches' }
  if (state.matches === 1) return { say: 'one-match' }
  return { say: 'ordinal', active: state.activeMatch, total: state.matches }
}
