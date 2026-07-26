import { hostMatchesRule, registrableDomain } from '../url/domain.js'
import {
  RESOURCE_TYPE_BITS,
  hostnameOfUrl,
  type FilterRequest,
  type NetworkRule
} from './model.js'

/**
 * Network matching: given a URL, its document and its resource type, block or not.
 *
 * This runs for every request every page makes, so a walk over a hundred thousand
 * rules is out. Two indexes carry it, and the split between them came from
 * measuring the three default lists (113 280 network rules) rather than from
 * taste:
 *
 *   - **A hostname map** for `||domain^`, which is 99 284 of those rules — 88 %.
 *     For that shape the map lookup *is* the pattern test: `||example.com^`
 *     matches exactly when the request's host is `example.com` or a subdomain of
 *     it, so walking the request host's own label suffixes and probing the map
 *     answers it outright. No pattern is scanned at all.
 *   - **Token buckets** for everything else, the idea uBlock Origin uses: each
 *     rule is filed under one alphanumeric run of at least three characters taken
 *     from its own pattern, and a request examines only the rules filed under
 *     tokens its URL actually contains.
 *
 * Two details decide whether the token index is honest rather than merely fast:
 *
 *   - **A token is only usable when the pattern pins both of its boundaries.**
 *     `adserver.` has to match `myadserver.com/x`, whose own tokens are
 *     `myadserver` and `com` — so filing that rule under `adserver` would lose it
 *     silently. Rules whose tokens are unpinned go to `untokenised` and are
 *     checked on every request. From the default lists that is 84 rules, so the
 *     fallback stays cheap while staying correct.
 *   - **Each rule is filed under its rarest token, not its first.** Filing under
 *     the first piles thousands of rules under `com` and turns the lookup back
 *     into the scan it replaced.
 *
 * Everything a request needs that does not depend on the rule — the lower-cased
 * URL, its tokens, the host's label suffixes, the positions a `||` may anchor at —
 * is computed once per request in `contextOf`. Recomputing the host's dot
 * positions per candidate rule was this matcher's first draft and cost 18 µs a
 * request against 1 µs now.
 */

const TOKEN_PATTERN = /[a-z0-9%]{3,}/g

/** `example.com^`: the shape the hostname map can answer without scanning. */
const PLAIN_HOST_PATTERN = /^[a-z0-9.-]+\^$/

const CARET = 0x5e
const DOT = 0x2e
const SLASH = 0x2f
const QUESTION = 0x3f
const HASH = 0x23

export interface RuleBucket {
  /** `||domain^` rules keyed by their domain. */
  readonly byHost: ReadonlyMap<string, readonly NetworkRule[]>
  readonly byToken: ReadonlyMap<string, readonly NetworkRule[]>
  /** Rules with no pinned token; examined for every request. */
  readonly untokenised: readonly NetworkRule[]
  readonly size: number
}

export interface NetworkIndex {
  /** `$important` blocks, which outrank exceptions and so are settled first. */
  readonly important: RuleBucket
  readonly block: RuleBucket
  readonly allow: RuleBucket
  readonly ruleCount: number
}

export interface NetworkMatch {
  readonly rule: NetworkRule
  /** False when an exception rule won over a block. */
  readonly blocked: boolean
}

/**
 * The domain a rule reduces to for the hostname map, or null when it does not
 * reduce.
 *
 * The trailing `^` is what makes the reduction exact. `||example.com` without it
 * also matches `example.community` and `example.com.evil.net`, so those rules stay
 * with the pattern matcher.
 */
function plainHostOf(rule: NetworkRule): string | null {
  if (!rule.hostAnchor || rule.rightAnchor || rule.parts.length !== 1) return null
  const part = rule.parts[0]!
  return PLAIN_HOST_PATTERN.test(part) ? part.slice(0, -1) : null
}

/**
 * The tokens a rule may be filed under.
 *
 * Exported because it is the load-bearing half of the token index: a mistake here
 * shows up as requests that quietly stop being blocked, which no coverage number
 * would reveal, so it is tested directly.
 */
export function safeTokensOf(rule: NetworkRule): readonly string[] {
  const tokens: string[] = []
  const last = rule.parts.length - 1
  for (let index = 0; index <= last; index++) {
    // Lower-cased first, and that is load-bearing rather than tidy. `$match-case`
    // leaves a pattern's own case intact, so scanning `/Advert.gif` with a
    // lower-case alphabet would find the *fragment* `dvert`, judge its left
    // boundary pinned because a character precedes it, and file the rule under a
    // token no URL ever produces — a rule that silently never matches again.
    const part = rule.parts[index]!.toLowerCase()
    TOKEN_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TOKEN_PATTERN.exec(part)) !== null) {
      const start = match.index
      const end = start + match[0].length
      // Inside a part, a boundary is a character outside the token alphabet, and a
      // URL's own tokens break at exactly the same characters. At a part edge the
      // neighbour is either `*` or the pattern's edge, and only an anchor pins that.
      const leftPinned = start > 0 || (index === 0 && (rule.hostAnchor || rule.leftAnchor))
      const rightPinned = end < part.length || (index === last && rule.rightAnchor)
      if (leftPinned && rightPinned) tokens.push(match[0])
    }
  }
  return tokens
}

function tokensOfUrl(url: string): readonly string[] {
  const tokens: string[] = []
  TOKEN_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_PATTERN.exec(url)) !== null) tokens.push(match[0])
  return tokens
}

function rarest(tokens: readonly string[], frequency: ReadonlyMap<string, number>): string | null {
  let best: string | null = null
  let bestCount = Number.POSITIVE_INFINITY
  for (const token of tokens) {
    // Every token here was counted into `frequency` a few lines above, so there is
    // no missing-key case to guard: a `?? 0` fallback would be a branch no test
    // could ever reach.
    const count = frequency.get(token)!
    if (count < bestCount) {
      best = token
      bestCount = count
    }
  }
  return best
}

function fileUnder(map: Map<string, NetworkRule[]>, key: string, rule: NetworkRule): void {
  const existing = map.get(key)
  if (existing === undefined) map.set(key, [rule])
  else existing.push(rule)
}

function buildBucket(rules: readonly NetworkRule[]): RuleBucket {
  const byHost = new Map<string, NetworkRule[]>()
  const patterned: Array<{ rule: NetworkRule; tokens: readonly string[] }> = []

  for (const rule of rules) {
    const host = plainHostOf(rule)
    if (host === null) patterned.push({ rule, tokens: safeTokensOf(rule) })
    else fileUnder(byHost, host, rule)
  }

  const frequency = new Map<string, number>()
  for (const candidate of patterned) {
    for (const token of candidate.tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1)
  }

  const byToken = new Map<string, NetworkRule[]>()
  const untokenised: NetworkRule[] = []
  for (const { rule, tokens } of patterned) {
    const token = rarest(tokens, frequency)
    if (token === null) untokenised.push(rule)
    else fileUnder(byToken, token, rule)
  }

  return { byHost, byToken, untokenised, size: rules.length }
}

export function buildNetworkIndex(rules: readonly NetworkRule[]): NetworkIndex {
  const important: NetworkRule[] = []
  const block: NetworkRule[] = []
  const allow: NetworkRule[] = []
  for (const rule of rules) {
    if (rule.isException) allow.push(rule)
    else if (rule.important) important.push(rule)
    else block.push(rule)
  }
  return {
    important: buildBucket(important),
    block: buildBucket(block),
    allow: buildBucket(allow),
    ruleCount: rules.length
  }
}

/**
 * An Adblock Plus separator: anything that is not a letter, a digit, `_`, `-`, `.`
 * or `%`. Upper case counts as a letter too, because `$match-case` rules are
 * matched against the URL as it arrived rather than a lower-cased copy.
 *
 * A table rather than a chain of range comparisons. This is consulted once per
 * character of every `^` in every candidate rule of every request, and a lookup has
 * no boundary conditions to get subtly wrong.
 */
const SEPARATOR_BY_CODE: readonly boolean[] = Array.from({ length: 0x80 }, (_unused, code) =>
  !/[0-9a-z_.%-]/i.test(String.fromCharCode(code))
)

function isSeparatorCode(code: number): boolean {
  // Beyond ASCII there is nothing to decide: a URL from the network stack has a
  // punycode host and a percent-encoded path, so anything else came from a caller
  // rather than the browser, and "separator" is the reading that cannot over-block.
  return SEPARATOR_BY_CODE[code] ?? true
}

/**
 * End index of `segment` if it matches `url` at `at`, otherwise -1.
 *
 * `^` stands for a separator, and the end of the URL counts as one — which is why
 * `||example.com^` matches `https://example.com` with nothing after it.
 */
function segmentEnd(url: string, segment: string, at: number): number {
  let position = at
  for (let index = 0; index < segment.length; index++) {
    const expected = segment.charCodeAt(index)
    if (expected === CARET) {
      if (position === url.length) return index === segment.length - 1 ? position : -1
      if (!isSeparatorCode(url.charCodeAt(position))) return -1
      position += 1
      continue
    }
    if (position === url.length || url.charCodeAt(position) !== expected) return -1
    position += 1
  }
  return position
}

function findSegment(url: string, segment: string, from: number, hasSeparator: boolean): number {
  // Without `^` the segment is literal, and the engine's own search beats a
  // hand-written scan by a wide margin. Only 19 unanchored rules in the default
  // lists take the slow path.
  if (!hasSeparator) return url.indexOf(segment, from)
  for (let at = from; at <= url.length; at++) {
    if (segmentEnd(url, segment, at) >= 0) return at
  }
  return -1
}

/** True when `part` occurs at or after `from` and can end exactly at the URL's end. */
function matchesToEnd(url: string, part: string, from: number, hasSeparator: boolean): boolean {
  let at = from
  for (;;) {
    const start = findSegment(url, part, at, hasSeparator)
    if (start < 0) return false
    if (segmentEnd(url, part, start) === url.length) return true
    at = start + 1
  }
}

/**
 * Matches the whole pattern with its first part pinned at `at`.
 *
 * Later parts take their earliest possible position, which is complete for
 * `*`-separated literals — a solution further right is never lost by choosing the
 * leftmost occurrence first. The end anchor is the one exception, and it gets its
 * own scan.
 */
function matchFrom(rule: NetworkRule, url: string, at: number): boolean {
  const parts = rule.parts
  let position = segmentEnd(url, parts[0]!, at)
  if (position < 0) return false

  const last = parts.length - 1
  for (let index = 1; index <= last; index++) {
    const part = parts[index]!
    if (index === last && rule.rightAnchor) {
      return matchesToEnd(url, part, position, rule.hasSeparator)
    }
    const start = findSegment(url, part, position, rule.hasSeparator)
    if (start < 0) return false
    position = segmentEnd(url, part, start)
  }
  return rule.rightAnchor ? position === url.length : true
}

function matchPattern(rule: NetworkRule, url: string, anchors: readonly number[]): boolean {
  // A pattern of nothing but `*` restricts the URL not at all; whatever the rule
  // says is carried entirely by its options.
  if (rule.parts.length === 0) return true

  if (rule.hostAnchor) {
    for (const start of anchors) {
      if (matchFrom(rule, url, start)) return true
    }
    return false
  }

  if (rule.leftAnchor) return matchFrom(rule, url, 0)

  const first = rule.parts[0]!
  let from = 0
  for (;;) {
    const start = findSegment(url, first, from, rule.hasSeparator)
    if (start < 0) return false
    if (matchFrom(rule, url, start)) return true
    // A later occurrence can still satisfy an end anchor: `/oo/cl.js|` against
    // `…/oo/cl.js?x=/oo/cl.js` matches only at the second one.
    from = start + 1
  }
}

interface Parties {
  readonly thirdParty: boolean
  readonly documentHost: string | null
}

interface MatchContext {
  readonly lowerUrl: string
  readonly rawUrl: string
  /** Positions a `||` may anchor at: the host's start and each label boundary. */
  readonly hostAnchorStarts: readonly number[]
  /** The host and each of its parent domains, for the hostname map. */
  readonly hostSuffixes: readonly string[]
  readonly typeBit: number
  readonly tokens: readonly string[]
  readonly documentUrl: string | null
  parties: Parties | null
}

/**
 * Party and document host, resolved on first need.
 *
 * Most requests match no rule, and most rules name neither a party nor a domain,
 * so this parses two URLs for a small minority of requests rather than for all.
 */
function partiesOf(context: MatchContext): Parties {
  const known = context.parties
  if (known !== null) return known

  const documentHost = context.documentUrl === null ? null : hostnameOfUrl(context.documentUrl)
  const requestHost = hostnameOfUrl(context.rawUrl)
  const resolved: Parties = {
    documentHost,
    // With no usable document there is no cross-site relationship to assert, and
    // "same party" is the reading that cannot over-block.
    thirdParty:
      documentHost !== null &&
      requestHost !== null &&
      registrableDomain(documentHost) !== registrableDomain(requestHost)
  }
  context.parties = resolved
  return resolved
}

/** Everything about a rule except its pattern: type, party, document domain. */
function optionsApply(rule: NetworkRule, context: MatchContext): boolean {
  // Cheapest first: two integer tests settle the resource type before any string
  // work happens.
  if (rule.types !== 0 && (rule.types & context.typeBit) === 0) return false
  if ((rule.excludedTypes & context.typeBit) !== 0) return false
  if (rule.thirdParty !== null && rule.thirdParty !== partiesOf(context).thirdParty) return false

  if (rule.includeDomains.length > 0) {
    const host = partiesOf(context).documentHost
    if (host === null) return false
    if (!rule.includeDomains.some((domain) => hostMatchesRule(host, domain))) return false
  }
  if (rule.excludeDomains.length > 0) {
    const host = partiesOf(context).documentHost
    // An exclusion-only rule ("everywhere except these") still applies when the
    // document is unknown; there is nothing to exclude it from.
    if (host !== null && rule.excludeDomains.some((domain) => hostMatchesRule(host, domain))) {
      return false
    }
  }
  return true
}

function ruleApplies(rule: NetworkRule, context: MatchContext): boolean {
  return (
    optionsApply(rule, context) &&
    matchPattern(
      rule,
      rule.matchCase ? context.rawUrl : context.lowerUrl,
      context.hostAnchorStarts
    )
  )
}

function findInBucket(bucket: RuleBucket, context: MatchContext): NetworkRule | null {
  // The hostname map first: no pattern is scanned, and 88 % of rules live here.
  for (const host of context.hostSuffixes) {
    const candidates = bucket.byHost.get(host)
    if (candidates === undefined) continue
    for (const rule of candidates) {
      if (optionsApply(rule, context)) return rule
    }
  }
  for (const rule of bucket.untokenised) {
    if (ruleApplies(rule, context)) return rule
  }
  for (const token of context.tokens) {
    const candidates = bucket.byToken.get(token)
    if (candidates === undefined) continue
    for (const rule of candidates) {
      if (ruleApplies(rule, context)) return rule
    }
  }
  return null
}

interface HostBounds {
  /** -1 when the URL has no host, e.g. `data:` — then no `||` rule can apply. */
  readonly start: number
  readonly end: number
}

/** Host bounds within a URL string, so `||` can be anchored without parsing it. */
function hostBounds(url: string): HostBounds {
  const scheme = url.indexOf('://')
  if (scheme < 0) return { start: -1, end: -1 }
  const start = scheme + 3
  for (let index = start; index < url.length; index++) {
    const code = url.charCodeAt(index)
    if (code === SLASH || code === QUESTION || code === HASH) return { start, end: index }
  }
  return { start, end: url.length }
}

function hostAnchorStartsOf(url: string, bounds: HostBounds): readonly number[] {
  if (bounds.start < 0) return []
  const starts: number[] = [bounds.start]
  for (let index = bounds.start; index < bounds.end; index++) {
    if (url.charCodeAt(index) === DOT) starts.push(index + 1)
  }
  return starts
}

/**
 * The host and each parent domain, as keys for the hostname map.
 *
 * The port is dropped first. `||example.com^` does match
 * `https://example.com:8443/` — `:` is a separator, so the `^` is satisfied — and
 * the suffix walk has to agree with the pattern matcher rather than quietly
 * disagree with it on non-default ports.
 */
function hostSuffixesOf(url: string, bounds: HostBounds): readonly string[] {
  if (bounds.start < 0) return []
  let stop = bounds.end
  const bracket = url.lastIndexOf(']', bounds.end - 1)
  const colon = url.lastIndexOf(':', bounds.end - 1)
  // `colon > bracket` keeps an IPv6 literal's own colons from being read as a port.
  if (colon >= bounds.start && colon > bracket) stop = colon

  const host = url.slice(bounds.start, stop)
  const suffixes: string[] = [host]
  for (let index = 0; index < host.length; index++) {
    if (host.charCodeAt(index) === DOT) suffixes.push(host.slice(index + 1))
  }
  return suffixes
}

function contextOf(request: FilterRequest): MatchContext {
  // URLs from the network stack are ASCII — hosts are punycode and paths are
  // percent-encoded — so lower-casing preserves length and the host bounds
  // computed here are valid for the raw URL too.
  const lowerUrl = request.url.toLowerCase()
  const bounds = hostBounds(lowerUrl)
  return {
    lowerUrl,
    rawUrl: request.url,
    hostAnchorStarts: hostAnchorStartsOf(lowerUrl, bounds),
    hostSuffixes: hostSuffixesOf(lowerUrl, bounds),
    typeBit: RESOURCE_TYPE_BITS[request.type],
    tokens: tokensOfUrl(lowerUrl),
    documentUrl: request.documentUrl,
    parties: null
  }
}

/**
 * The winning rule for a request, or null when nothing matched.
 *
 * The rule is returned rather than a bare boolean so a block can be explained —
 * "which line did this" is the first question about any false positive.
 */
export function matchNetworkRequest(
  index: NetworkIndex,
  request: FilterRequest
): NetworkMatch | null {
  const context = contextOf(request)

  const important = findInBucket(index.important, context)
  if (important !== null) return { rule: important, blocked: true }

  const block = findInBucket(index.block, context)
  if (block === null) return null

  const allow = findInBucket(index.allow, context)
  return allow === null ? { rule: block, blocked: true } : { rule: allow, blocked: false }
}
