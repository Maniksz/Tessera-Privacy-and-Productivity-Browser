import {
  MAX_USER_RULES,
  MAX_USER_RULE_LENGTH,
  describeUserRule,
  type UserRule
} from './user-rules.js'
import { commentBody, disabledRuleLine, sourceLines } from './user-rules-lines.js'

/**
 * The user's own rules as one text, and the way back (KTD7).
 *
 * ## The text is a projection, not the stored thing
 *
 * The rules stay what they were: records with an id, an age, an origin and a switch. The text is how they
 * are *shown and edited*, and the two directions below are what keep the records intact through it. A line
 * that comes back unchanged is traced to the rule it was written from by its text, so a round trip that
 * touched nothing touches no id, no `createdAt` and no `origin` — which is the difference between a rule
 * manager and a text box that rewrites the file every time it is saved. The age matters beyond display:
 * `repairUserRules` cuts the *oldest* first, and a save that restamped every rule would have made the rule
 * written a year ago look like the one written a minute ago.
 *
 * ## What a line can be
 *
 * Four things, and only one of them is a rule. A commented line is a switched-off rule **only if its body
 * passes the same check as an uncommented one** — `describeUserRule`, which refuses network syntax and
 * scriptlets. Anything else after a `!` is a note. That ordering is a security property rather than tidiness:
 * `UserRuleEditor.setEnabled` does not re-validate, so a line stored as "a rule that is off" could later be
 * switched on as it stands, and `! ||ads.example^` must therefore never become one.
 *
 * ## Why the text is stored as well
 *
 * Notes and blank lines are the user's own writing too, and a box that kept them until the page was
 * reloaded would lose them silently — the one failure this part of the browser is built against. So the
 * saved text is kept beside the rules, and the projection *merges* it with them rather than trusting it:
 * the rules are the truth about what exists and whether it is on, the text only contributes the notes and
 * the order. A rule the picker wrote since appears at the end; a rule deleted since loses its line; a rule
 * switched off from the blocker menu since shows as commented. There is no state in which the text claims a
 * rule the engine does not have.
 *
 * A refused line is kept in the text as well, where the user put it, and is refused again every time the
 * text is read — so it is marked on every visit until it is fixed, rather than vanishing on the first save
 * and taking with it the only copy of whatever the user was trying to write.
 */

/**
 * The answers a saved text can get.
 *
 * Two, and there is deliberately no "invalid": a refused line does not refuse the text. It is marked where
 * it stands and the lines around it are taken, because one typo in a list of forty rules must not be the
 * reason the other thirty-nine are not saved.
 */
export const APPLY_USER_RULE_SOURCE_OUTCOMES = ['applied', 'limit-reached'] as const

export type ApplyUserRuleSourceOutcome = (typeof APPLY_USER_RULE_SOURCE_OUTCOMES)[number]

/**
 * The longest text the box may send.
 *
 * Room for every rule the list can hold at its longest, commented out, twice over — the second half being
 * notes. Bounded at all because the text arrives from a page and is stored: without a bound, one paste would
 * be a file the size of whatever was on the clipboard.
 */
export const MAX_USER_RULE_SOURCE_LENGTH = 2 * MAX_USER_RULES * (MAX_USER_RULE_LENGTH + 3)

/**
 * The most rule ids a save may say it was written against.
 *
 * Twice the list, not once, because a private window's list is two lists: the stored rules read through,
 * and the session's own. Each is held to `MAX_USER_RULES` where it is written, but the session's were
 * counted against a stored set that a normal window may have grown since — so a private page can show up
 * to twice the limit, and a bound of once would refuse its every save, deletions included. Bounded at all
 * because the list arrives from a page.
 */
export const MAX_LOADED_USER_RULE_IDS = 2 * MAX_USER_RULES

/** One line, read. */
export type UserRuleLine =
  | { readonly kind: 'blank' }
  | { readonly kind: 'note' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'rule'; readonly text: string; readonly enabled: boolean }

/**
 * What one line of the text is.
 *
 * The commented case runs its *body* through `describeUserRule`, never the line: see the module docblock
 * for why a comment is only a switched-off rule once the rule inside it would have been accepted on its own.
 */
export function readUserRuleLine(line: string): UserRuleLine {
  const trimmed = line.trim()
  if (trimmed === '') return { kind: 'blank' }
  const body = commentBody(trimmed)
  if (body !== null) {
    return describeUserRule(body) === null
      ? { kind: 'note' }
      : { kind: 'rule', text: body, enabled: false }
  }
  return describeUserRule(trimmed) === null
    ? { kind: 'rejected' }
    : { kind: 'rule', text: trimmed, enabled: true }
}

function ruleLine(text: string, enabled: boolean): string {
  return enabled ? text : disabledRuleLine(text)
}

/** The text as the editor shows it, and which of its lines the browser refuses. */
export interface UserRuleSourceView {
  readonly source: string
  /** Each refused line as it was read — trimmed — so the editor can find it by its text. */
  readonly rejected: string[]
}

/**
 * The rules as one text, merged into the text last saved.
 *
 * With no saved text — every document written before the box existed — this is one line per rule in
 * storage order, a switched-off one commented out. With one, the saved lines lead: notes and blank lines as
 * they were, a rule line replaced by the rule's state *now* or dropped if the rule has gone, and every rule
 * the saved text does not mention added at the end.
 */
export function projectUserRuleSource(
  rules: readonly UserRule[],
  source: string | undefined
): UserRuleSourceView {
  const byText = new Map(rules.map((rule) => [rule.text, rule]))
  const shown = new Set<string>()
  const lines: string[] = []
  const rejected: string[] = []

  for (const raw of sourceLines(source ?? '')) {
    const line = readUserRuleLine(raw)
    if (line.kind !== 'rule') {
      lines.push(raw)
      if (line.kind === 'rejected') rejected.push(raw.trim())
      continue
    }
    const rule = byText.get(line.text)
    if (rule === undefined || shown.has(rule.id)) continue
    shown.add(rule.id)
    lines.push(ruleLine(rule.text, rule.enabled))
  }

  for (const rule of rules) {
    if (!shown.has(rule.id)) lines.push(ruleLine(rule.text, rule.enabled))
  }
  return { source: lines.join('\n'), rejected }
}

export interface UserRuleSourceState {
  readonly rules: readonly UserRule[]
  readonly source?: string | undefined
}

export interface ApplyUserRuleSourceContext {
  /** Asked once per rule that is new, and only once the text is known to fit. */
  readonly nextId: () => string
  readonly now: number
  /**
   * The ids of the rules the text was written against — what the page was showing when it loaded.
   *
   * Only these can be deleted by a missing line; see "A text is written against a list" below.
   */
  readonly loaded: ReadonlySet<string>
}

export interface ApplyUserRuleSourceResult {
  readonly outcome: ApplyUserRuleSourceOutcome
  readonly rules: UserRule[]
  readonly source: string | undefined
  /** False when there is nothing to write, which is also what a refusal is. */
  readonly changed: boolean
}

/**
 * A text the user saved, read back into rules.
 *
 * ## Which rule a line is
 *
 * A line whose text a stored rule has *is* that rule, and keeps its id, age and origin; only its switch
 * follows the comment mark. A line nobody has is a new rule, typed by hand, stamped now. A stored rule no
 * line names is gone — if the text was written against it, which the next section is about. There is no
 * fuzzier matching than that, deliberately: an edited line is the old rule deleted and a new one written,
 * because a line in a text box has no identity except its text — and guessing that `.advert` "is" the rule
 * that used to say `.ad` would carry a picker origin onto a rule somebody typed.
 *
 * ## A text is written against a list, and the list moves on
 *
 * The page loads the rules, the user edits for a minute, and meanwhile the element picker writes a rule in
 * another window. The text has no line for that rule because there was none to show, not because the user
 * deleted one — and a save that read the missing line as a deletion lost a rule the user had just made and
 * never saw. So a stored rule is only deleted by its absence when its id is in `context.loaded`; a rule
 * that appeared since is kept as it stands, switch included, and the projection adds its line at the end
 * the next time the text is read. A loaded id that no stored rule has any more is a rule deleted elsewhere
 * in the meantime: already gone, nothing to do.
 *
 * What stays last-write-wins is every line the text *does* name. A loaded rule switched on or off
 * elsewhere since follows its line here; a loaded rule deleted elsewhere whose line is still in the text is
 * written again, as a new rule typed by hand, because the text says it should exist and its old record is
 * gone.
 *
 * ## Order
 *
 * The rules come out in storage order with the new ones at the end, not in the order of the text. Storage
 * order is age order, and `repairUserRules` cuts from the front — so a text reordered for reading must not
 * reorder which rule is the oldest. The text keeps its own order, which is what the saved source is for.
 *
 * ## The limit
 *
 * Counted over everything that would be kept, switched off included — a switched-off rule is still a rule
 * the list holds. Past it, nothing is written and nothing is deleted (R18), for the reason `addUserRule`
 * gives: to take "as many as fit" the browser would have to choose which of the user's lines to lose.
 * Notes and refused lines are not counted; they are not rules.
 *
 * ## Repeats
 *
 * A rule written twice is one rule, decided by its first line — the same fold `repairUserRules` makes — and
 * the later line is dropped from the text, so the box shows what is kept.
 */
export function applyUserRuleSource(
  state: UserRuleSourceState,
  text: string,
  context: ApplyUserRuleSourceContext
): ApplyUserRuleSourceResult {
  const wanted = new Map<string, boolean>()
  const lines: string[] = []

  for (const raw of sourceLines(text)) {
    const line = readUserRuleLine(raw)
    if (line.kind === 'blank') lines.push('')
    else if (line.kind !== 'rule') lines.push(raw.trimEnd())
    else if (!wanted.has(line.text)) {
      wanted.set(line.text, line.enabled)
      lines.push(ruleLine(line.text, line.enabled))
    }
  }
  // Trailing blank lines are the box's own — the line the cursor was left on — and not the user's layout.
  while (lines.at(-1) === '') lines.pop()

  const stored = new Set(state.rules.map((rule) => rule.text))
  const fresh = [...wanted].filter(([ruleText]) => !stored.has(ruleText))
  const kept = state.rules.filter((rule) => wanted.has(rule.text) || !context.loaded.has(rule.id))

  if (kept.length + fresh.length > MAX_USER_RULES) {
    return {
      outcome: 'limit-reached',
      rules: [...state.rules],
      source: state.source,
      changed: false
    }
  }

  const rules: UserRule[] = [
    ...kept.map((rule) => {
      // No line for it is a rule the page never showed, and it is kept exactly as it is.
      const enabled = wanted.get(rule.text) ?? rule.enabled
      return rule.enabled === enabled ? rule : { ...rule, enabled }
    }),
    ...fresh.map(([ruleText, enabled]): UserRule => ({
      id: context.nextId(),
      text: ruleText,
      enabled,
      createdAt: context.now,
      origin: 'manual'
    }))
  ]
  const source = lines.join('\n')
  const changed =
    source !== state.source ||
    rules.length !== state.rules.length ||
    rules.some((rule, index) => rule !== state.rules[index])
  return { outcome: 'applied', rules, source, changed }
}

/**
 * A saved text that is no longer usable, let go.
 *
 * Only for length: a text past the bound was not written by this build. What is lost is the arrangement —
 * the notes and the order — and never a rule, because the rules are stored and healed separately.
 */
export function repairUserRuleSource(source: string | undefined): string | undefined {
  return source !== undefined && source.length > MAX_USER_RULE_SOURCE_LENGTH ? undefined : source
}
