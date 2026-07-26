import { hostChain } from './cosmetic.js'
import { parseFilterList } from './parse.js'

/**
 * The user's own hiding rules: the model, with no storage in it.
 *
 * Every rule is a line of Adblock Plus syntax, exactly as a downloaded list would
 * write it, and that is the whole design decision here. The picker could have stored a
 * selector plus a host in two fields and applied them with bespoke code; then there
 * would be two element-hiding implementations, one of which is only ever exercised by
 * the user's own rules — the least-tested path in the blocker holding the rules the
 * user cares most about. Instead a rule goes through `parseFilterList` like anything
 * else, which also means `#@#` works: the user can cancel a selector a list applied,
 * which is the escape hatch for the day a filter list breaks a page.
 *
 * The three operations that matter are not "add": they are **see, disable, delete**.
 * A blocker the user can add to but not audit becomes a page that is broken for
 * reasons nobody can reconstruct, and the usual outcome is that the whole blocker gets
 * turned off. So `enabled` is stored rather than implied by presence, the original
 * line is kept verbatim so the list can be read, and `createdAt` is there so the most
 * recent rule — the one most likely to be the culprit — can be found first.
 */

/**
 * How a rule came to exist.
 *
 * A list rather than a bare union, so the wire schema can enumerate it. Worth distinguishing because the two
 * deserve different treatment in an interface: a rule the picker wrote can be shown with the element it came
 * from, and a rule typed by hand is one the user can be trusted to have meant.
 */
export const USER_RULE_ORIGINS = ['picker', 'manual'] as const

export type UserRuleOrigin = (typeof USER_RULE_ORIGINS)[number]

export interface UserRule {
  readonly id: string
  /** The filter line, verbatim: `example.com##.ad-slot`. */
  readonly text: string
  /** False keeps the line but stops applying it, which is how a page gets un-broken. */
  readonly enabled: boolean
  readonly createdAt: number
  readonly origin: UserRuleOrigin
}

export interface UserRuleDocument {
  version: 1
  rules: UserRule[]
}

export function emptyUserRuleDocument(): UserRuleDocument {
  return { version: 1, rules: [] }
}

/**
 * Beyond this the list is no longer something a person can audit, and the point of
 * these rules is that they are auditable. Reached only by a script, and the oldest go
 * first because the newest are the ones being worked on.
 */
export const MAX_USER_RULES = 500

/** Long enough for a scoped selector, short enough that a paste accident is caught. */
export const MAX_USER_RULE_LENGTH = 512

/** What a stored line means, once the parser has read it. */
export interface UserRuleDetail {
  /** Hosts the rule is scoped to; empty for a rule that applies everywhere. */
  readonly hosts: readonly string[]
  readonly selector: string
  /** True for `#@#`: the rule cancels a selector rather than adding one. */
  readonly isException: boolean
}

/**
 * What the parser makes of a line, or null when it makes nothing of it.
 *
 * The same parser the lists go through, so a rule that stores cleanly is a rule that
 * will be applied — there is no second opinion to disagree with. Network syntax is
 * refused: `||ads.example.com^` is a perfectly good filter line, but it belongs to a
 * blocking list the user chose, and letting an element picker write request-blocking
 * rules would put "hide this box" and "cut this site off" behind the same button.
 */
export function describeUserRule(text: string): UserRuleDetail | null {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > MAX_USER_RULE_LENGTH) return null
  const parsed = parseFilterList(trimmed)
  if (parsed.network.length > 0) return null
  const detail = parsed.cosmetic.map((rule): UserRuleDetail => ({
    hosts: rule.includeHosts,
    selector: rule.selector,
    isException: rule.isException
  }))
  // Exactly one: a line producing none is not a rule, and the parser cannot produce
  // more than one from a single line — insisting on it here is what makes that stay
  // true rather than assumed.
  for (const only of detail.length === 1 ? detail : []) return only
  return null
}

export function isStorableUserRule(text: string): boolean {
  return describeUserRule(text) !== null
}

export interface UserRuleInput {
  readonly text: string
  readonly origin: UserRuleOrigin
}

export interface AddUserRuleContext {
  readonly id: string
  readonly now: number
}

export type AddUserRuleOutcome = 'added' | 'invalid' | 'duplicate'

export interface AddUserRuleResult {
  readonly rules: UserRule[]
  /** The stored rule, or null when nothing was stored. */
  readonly added: UserRule | null
  readonly outcome: AddUserRuleOutcome
}

/**
 * Adds a rule, or says why it did not.
 *
 * A duplicate is reported rather than stored twice, and rather than silently ignored:
 * the picker's answer to "you already have this rule" is to point at the existing one,
 * which it cannot do if the call merely succeeded. A duplicate that was *disabled*
 * counts as a duplicate too — re-blocking something is a change to the rule that is
 * already there, not a new one.
 */
export function addUserRule(
  rules: readonly UserRule[],
  input: UserRuleInput,
  context: AddUserRuleContext
): AddUserRuleResult {
  const text = input.text.trim()
  if (!isStorableUserRule(text)) return { rules: [...rules], added: null, outcome: 'invalid' }
  if (rules.some((rule) => rule.text === text)) {
    return { rules: [...rules], added: null, outcome: 'duplicate' }
  }
  const added: UserRule = {
    id: context.id,
    text,
    enabled: true,
    createdAt: context.now,
    origin: input.origin
  }
  return { rules: trimToLimit([...rules, added]), added, outcome: 'added' }
}

/** Oldest first out, because the newest rule is the one being worked on. */
function trimToLimit(rules: readonly UserRule[]): UserRule[] {
  return rules.slice(Math.max(0, rules.length - MAX_USER_RULES))
}

export function setUserRuleEnabled(
  rules: readonly UserRule[],
  id: string,
  enabled: boolean
): UserRule[] {
  return rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule))
}

export function removeUserRule(rules: readonly UserRule[], id: string): UserRule[] {
  return rules.filter((rule) => rule.id !== id)
}

/**
 * Makes a stored list usable again after a hand edit, an older build, or a crash.
 *
 * Unparseable lines are dropped rather than kept and skipped: a line the engine cannot
 * apply is a line the user believes is protecting them. Duplicates are folded onto the
 * first occurrence, which keeps the id that any interface is already showing.
 */
export function repairUserRules(rules: readonly UserRule[]): UserRule[] {
  const seenText = new Set<string>()
  const seenId = new Set<string>()
  const repaired: UserRule[] = []
  for (const rule of rules) {
    const text = rule.text.trim()
    if (!isStorableUserRule(text)) continue
    if (seenText.has(text) || seenId.has(rule.id)) continue
    seenText.add(text)
    seenId.add(rule.id)
    repaired.push(text === rule.text ? rule : { ...rule, text })
  }
  return trimToLimit(repaired)
}

/**
 * The enabled rules as one list body, ready for the same compiler the downloaded
 * lists go through.
 */
export function enabledUserRuleText(rules: readonly UserRule[]): string {
  return rules
    .filter((rule) => rule.enabled)
    .map((rule) => rule.text)
    .join('\n')
}

/**
 * The rules that have any bearing on a host, newest first.
 *
 * This is the list the user is shown when a site looks wrong, so it has to include the
 * rules that are easy to forget: one written for the parent domain, and one written
 * with no host at all. Newest first because the rule added a minute ago is the
 * suspect.
 */
export function userRulesForHost(rules: readonly UserRule[], hostname: string): UserRule[] {
  const chain = new Set(hostChain(hostname))
  return rules
    .filter((rule) => {
      const detail = describeUserRule(rule.text)
      if (detail === null) return false
      return detail.hosts.length === 0 || detail.hosts.some((host) => chain.has(host))
    })
    .sort((left, right) => right.createdAt - left.createdAt)
}
