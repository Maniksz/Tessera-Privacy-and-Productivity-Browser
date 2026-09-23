import type { UserRuleDetail, UserRuleOrigin } from './user-rules.js'

/**
 * The line conventions of the rule text, with nothing that parses a filter.
 *
 * ## Why this is its own file
 *
 * Two sides need to agree on what a commented line is: the core, which decides whether `! example.com##.ad`
 * is a switched-off rule or a note, and the settings page, which draws a mark beside the line it belongs to.
 * If each side spelled the convention for itself, they would drift the way the add outcomes once drifted —
 * and the way that drift shows up is a tag drawn on the wrong line, or on none.
 *
 * The core's half lives in `user-rules-source.ts` and imports the filter parser. This half must not: the
 * settings page imports it *by value*, and a value import is a bundle import. Nothing here imports anything
 * but types, which is what lets the renderer have it for free.
 */

/**
 * What starts a comment in Adblock Plus syntax (`parse.ts` treats it as one), and so what "off" is written as.
 *
 * Chosen over a second syntax of our own because the text is uBO's shape on purpose: a rule list copied out
 * of this box into uBlock Origin — or out of a forum post into it — means the same thing on both sides.
 */
export const COMMENT_MARK = '!'

/**
 * A text as lines, whatever ended them.
 *
 * `\r\n` because a list pasted from a file written on Windows would otherwise carry a `\r` into the last
 * character of every selector, which is a rule that looks right and matches nothing. A text of nothing
 * has no lines rather than one empty one, so an empty box is an empty list and not a list with a gap in it.
 */
export function sourceLines(text: string): string[] {
  return text === '' ? [] : text.split(/\r\n|\n|\r/)
}

/**
 * What follows the comment mark, or null for a line that is not a comment.
 *
 * Exactly one mark comes off. `!! example.com##.ad` therefore has the body `! example.com##.ad`, which is
 * itself a comment and no rule — so doubling the mark is how a rule is kept as a note on purpose.
 */
export function commentBody(line: string): string | null {
  const trimmed = line.trim()
  return trimmed.startsWith(COMMENT_MARK) ? trimmed.slice(COMMENT_MARK.length).trim() : null
}

/** A switched-off rule as a line, with the space uBO puts there so the rule is still readable. */
export function disabledRuleLine(text: string): string {
  return `${COMMENT_MARK} ${text}`
}

/** What the editor knows about a stored rule, which is all a tag beside its line can say. */
export interface AnnotatableRule {
  readonly text: string
  readonly kind: UserRuleDetail['kind']
  readonly origin: UserRuleOrigin
}

export interface LineAnnotationContext {
  readonly rules: readonly AnnotatableRule[]
  /** The lines the core refused, as it saw them — trimmed. */
  readonly rejected: readonly string[]
  /** The settings search, already trimmed and lower-cased; empty for none. */
  readonly term: string
}

/** One line of the text, and the marks to draw beside it. */
export interface AnnotatedLine {
  /** The line as typed, because it is drawn under the text box and has to sit exactly where the text does. */
  readonly text: string
  readonly rejected: boolean
  readonly procedural: boolean
  readonly picked: boolean
  readonly match: boolean
}

/**
 * The marks for every line of a text the user may still be typing into.
 *
 * ## Why marks are found by text, not by line number
 *
 * The core answers about the text as it was saved. The box holds the text as it is *now*, and one line
 * inserted above a refused line would move every mark after it onto a neighbour — a refusal drawn beside
 * a rule that is fine. Keyed by the line's own text, a mark stays with its line wherever it moves, and
 * disappears the moment the line is edited: the verdict was about that text, and the corrected one is a
 * line nobody has judged yet. The same principle the one-line box had, which dropped its verdict on the
 * first keystroke.
 *
 * A commented rule is looked up by its body, so a rule switched off in the text still says that it is
 * matched by script and that the picker wrote it — being off does not change either.
 */
export function annotateSourceLines(
  draft: string,
  context: LineAnnotationContext
): AnnotatedLine[] {
  const rules = new Map(context.rules.map((rule) => [rule.text, rule]))
  const rejected = new Set(context.rejected)
  return sourceLines(draft).map((text) => {
    const trimmed = text.trim()
    const rule = rules.get(commentBody(text) ?? trimmed)
    return {
      text,
      rejected: rejected.has(trimmed),
      procedural: rule?.kind === 'procedural',
      picked: rule?.origin === 'picker',
      match: context.term !== '' && text.toLowerCase().includes(context.term)
    }
  })
}
