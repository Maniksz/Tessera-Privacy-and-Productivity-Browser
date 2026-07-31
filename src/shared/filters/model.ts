/**
 * Filter-list vocabulary: resource types, rule shapes, parse diagnostics.
 *
 * Types, constants and total functions only — no runtime validation library. The
 * cosmetic query is meant to be reachable from a renderer (it decides what to hide
 * in a page), and a module a renderer imports at runtime has to stay free of zod;
 * see docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md.
 * An architecture test walks the renderer's value-import graph and enforces it.
 */

/**
 * Resource types in Adblock Plus spelling, which is what the lists are written
 * in. Deliberately *not* Electron's spelling: the lists are the source of truth
 * for these names, and translating at the boundary keeps one vocabulary inside.
 */
export const FILTER_RESOURCE_TYPES = [
  'document',
  'subdocument',
  'stylesheet',
  'script',
  'image',
  'font',
  'media',
  'object',
  'xmlhttprequest',
  'websocket',
  'ping',
  'other'
] as const

export type FilterResourceType = (typeof FILTER_RESOURCE_TYPES)[number]

/**
 * One bit per resource type.
 *
 * A rule's type restriction is then a single integer test instead of a set
 * lookup, which matters because it is the first thing checked for every
 * candidate rule of every request.
 */
export const RESOURCE_TYPE_BITS: Readonly<Record<FilterResourceType, number>> = Object.fromEntries(
  FILTER_RESOURCE_TYPES.map((type, index) => [type, 1 << index])
) as Record<FilterResourceType, number>

/**
 * Electron's resource names mapped onto the list vocabulary.
 *
 * `favicon` and `fetch` are folded into the neighbours a list author would have
 * meant, because no filter syntax names them separately.
 */
const ELECTRON_RESOURCE_TYPES: Readonly<Record<string, FilterResourceType>> = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  favicon: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  fetch: 'xmlhttprequest',
  ping: 'ping',
  media: 'media',
  webSocket: 'websocket'
}

/**
 * `other` for anything unrecognised, never a guess.
 *
 * A new Chromium release can add a resource name, and mapping it to something
 * plausible would silently apply rules the list author never scoped to it. Rules
 * with no type restriction still match, which is the large majority.
 */
export function filterResourceTypeOf(electronResourceType: string): FilterResourceType {
  return ELECTRON_RESOURCE_TYPES[electronResourceType] ?? 'other'
}

/**
 * Lower-cased hostname of a URL, or null when it has no usable host.
 *
 * `shared/url/domain.ts` deals in registrable domains, and `$domain=` has to be
 * matched against the full host — `domain=news.yahoo.com` must not be satisfied by
 * any other `yahoo.com` subdomain — so the raw hostname is what is needed here.
 */
export function hostnameOfUrl(url: string): string | null {
  try {
    const { hostname } = new URL(url)
    return hostname === '' ? null : hostname.toLowerCase()
  } catch {
    return null
  }
}

/** What the matcher is asked about. */
export interface FilterRequest {
  readonly url: string
  /** URL of the frame that made the request; decides first- versus third-party. */
  readonly documentUrl: string | null
  readonly type: FilterResourceType
}

/**
 * A compiled network rule.
 *
 * The pattern is stored as its wildcard-free `parts` rather than as a regular
 * expression. Two reasons: a downloaded list would otherwise inject arbitrary
 * regular expressions into the hot path of every request, and a segment walk has
 * predictable cost where a regex engine's backtracking does not.
 */
export interface NetworkRule {
  /** The line this came from, so a block can be explained rather than guessed at. */
  readonly raw: string
  /** Literal segments, in order; the gaps between them are `*`. */
  readonly parts: readonly string[]
  /** `||` — anchored to a domain-label boundary in the host. */
  readonly hostAnchor: boolean
  /** `|` — anchored to the start of the URL. */
  readonly leftAnchor: boolean
  /** Trailing `|` — anchored to the end of the URL. */
  readonly rightAnchor: boolean
  /** Whether any part contains `^`, which needs the slower separator-aware scan. */
  readonly hasSeparator: boolean
  /** `$match-case`; patterns are lower-cased at parse time unless this is set. */
  readonly matchCase: boolean
  /** `@@` — an allow rule that overrides a block. */
  readonly isException: boolean
  /** `$important` — a block that overrides an exception. */
  readonly important: boolean
  /** Bitmask of permitted types; 0 means every type. */
  readonly types: number
  /** Bitmask of `~type` exclusions. */
  readonly excludedTypes: number
  /** `$third-party` / `$first-party`; null when the rule does not care. */
  readonly thirdParty: boolean | null
  /** `$domain=` inclusions, matched against the document host on whole labels. */
  readonly includeDomains: readonly string[]
  /** `$domain=~…` exclusions, which take precedence over the inclusions. */
  readonly excludeDomains: readonly string[]
}

/** A compiled cosmetic rule: one selector plus the hosts it applies to. */
export interface CosmeticRule {
  readonly selector: string
  /** `#@#` — cancels the same selector for the hosts it names. */
  readonly isException: boolean
  /** Hosts the rule is scoped to; empty means every host. */
  readonly includeHosts: readonly string[]
  /** `~host` exclusions. */
  readonly excludeHosts: readonly string[]
}

/**
 * What a parse pass did with each line.
 *
 * Counted in **lines**, and that is the point: the five outcome counters add up
 * to `lines` exactly, so "nothing was silently swallowed" is a checkable
 * invariant rather than a hope. A blocker that understands less than the user
 * believes is worse than one that says so, so `unsupportedByReason` names what
 * was skipped and why.
 */
export interface FilterListDiagnostics {
  readonly lines: number
  readonly blank: number
  readonly comments: number
  /** Lines that produced at least one network rule. */
  readonly network: number
  /** Lines that produced a cosmetic rule. */
  readonly cosmetic: number
  /**
   * Lines that produced a scriptlet rule.
   *
   * Its own counter rather than folded into `cosmetic`, because the two are different powers and the
   * numbers are what the settings screen reports: hiding an element and running code in the page are not
   * the same promise, and a single figure covering both would say neither.
   *
   * A sixth counter, so `accountedLines` had to grow with it — a counter added without that is a counter
   * that breaks the invariant it exists to support.
   */
  readonly scriptlet: number
  /** Lines recognised as filter syntax that this engine does not implement. */
  readonly unsupported: number
  /**
   * Reason -> line count. Keys are stable strings, either a bare reason
   * (`regex-pattern`) or a reason with the offending name
   * (`unsupported-option:popup`), so a settings page can list them.
   */
  readonly unsupportedByReason: Readonly<Record<string, number>>
}

/** Sum of the outcome counters; equals `lines` for a well-behaved parser. */
export function accountedLines(diagnostics: FilterListDiagnostics): number {
  return (
    diagnostics.blank +
    diagnostics.comments +
    diagnostics.network +
    diagnostics.cosmetic +
    diagnostics.scriptlet +
    diagnostics.unsupported
  )
}
