import { hostChain } from './cosmetic.js'
import { hostMatchesRule } from '../url/domain.js'
import type { ProceduralRule, ProceduralSelector } from './procedural.js'

/**
 * Procedural rules keyed by the host they name.
 *
 * ## Why there is no generic bucket
 *
 * Every other cosmetic index has one, and this one deliberately cannot: `parse.ts` refuses a procedural
 * rule that names no host, on uBlock Origin's own rule and for the same reason — these are evaluated by
 * script on every matching document and again on every mutation burst, so "applies everywhere" would mean
 * that work on every page for the rest of the session. The absence of the bucket is what makes the cost of
 * this feature proportional to the number of sites the user's rules actually name.
 *
 * ## Why the rule text is carried
 *
 * The settings screen shows the user their own rules back, and a rule is only auditable as the line that
 * was written: `.box:has-text(Anzeige):upward(2)` reconstructed from a parsed chain would be *a* correct
 * spelling and not necessarily the one the user typed. `user-rules.ts` makes the same argument for storing
 * the line verbatim.
 */

export interface ProceduralIndex {
  /** Host or parent domain -> the rules scoped to it. */
  readonly byHost: ReadonlyMap<string, readonly ProceduralRule[]>
  readonly ruleCount: number
}

export const EMPTY_PROCEDURAL_INDEX: ProceduralIndex = { byHost: new Map(), ruleCount: 0 }

export function buildProceduralIndex(rules: readonly ProceduralRule[]): ProceduralIndex {
  const byHost = new Map<string, ProceduralRule[]>()
  for (const rule of rules) {
    for (const host of rule.includeHosts) {
      const existing = byHost.get(host)
      if (existing === undefined) byHost.set(host, [rule])
      else existing.push(rule)
    }
  }
  return { byHost, ruleCount: rules.length }
}

/**
 * The selectors to evaluate on this host, deduplicated by the line that produced them.
 *
 * Deduplicated because two lists commonly carry the same rule, and a duplicate here is not merely
 * redundant: the actions are applied per match, so `:remove-class(x)` twice is two passes over the same
 * elements on every mutation burst, forever.
 */
export function proceduralSelectorsFor(
  index: ProceduralIndex,
  hostname: string
): ProceduralSelector[] {
  const host = hostname.toLowerCase()
  if (host === '') return []

  const selectors: ProceduralSelector[] = []
  const seen = new Set<string>()
  for (const scope of hostChain(host)) {
    for (const rule of index.byHost.get(scope) ?? []) {
      if (rule.excludeHosts.some((excluded) => hostMatchesRule(host, excluded))) continue
      if (seen.has(rule.text)) continue
      seen.add(rule.text)
      selectors.push(rule.selector)
    }
  }
  return selectors
}
