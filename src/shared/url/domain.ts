/**
 * Registrable-domain handling for the redirect blocker and state partitioning.
 *
 * Spec 4 calls this out specifically: matching on name fragments like `track.`
 * or `click.` breaks parcel tracking and newsletter links, and naive
 * "last two labels" logic gets `.co.uk` wrong — it would treat `bbc.co.uk` and
 * `evil.co.uk` as the same site.
 *
 * The correct data source is the Public Suffix List. The set below is a
 * deliberately small bootstrap covering the multi-label suffixes that break
 * things most visibly; the real list is downloaded by the core, checked by
 * `public-suffix.ts`, and put in force at startup through
 * `configurePublicSuffixes` — once per run, see there.
 *
 * Only the lookup lives here, not the parser or the checks. This module is
 * imported by renderer bundles (the history page groups by site), and they have
 * no business carrying the machinery that decides whether a download may be
 * trusted.
 */

/**
 * Multi-label public suffixes. Single-label suffixes (`com`, `de`, …) need no
 * entry: they are the default assumption.
 *
 * Exported because the downloaded list is checked against it: a list that would
 * undo one of these is refused (`public-suffix.ts`), since what is in force is
 * always the union of the two.
 */
export const BOOTSTRAP_SUFFIXES: readonly string[] = [
  // United Kingdom
  'co.uk',
  'org.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'net.uk',
  'sch.uk',
  'ac.uk',
  'gov.uk',
  'nhs.uk',
  'police.uk',
  // Australia / New Zealand
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'id.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'govt.nz',
  'ac.nz',
  // Japan / Korea / China / India
  'co.jp',
  'or.jp',
  'ne.jp',
  'ac.jp',
  'go.jp',
  'co.kr',
  'or.kr',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.in',
  'net.in',
  'org.in',
  'gov.in',
  'ac.in',
  // Brazil / Mexico / Argentina
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'com.mx',
  'org.mx',
  'com.ar',
  'org.ar',
  // Europe
  'co.at',
  'or.at',
  'ac.at',
  'gv.at',
  'com.tr',
  'org.tr',
  'gov.tr',
  'co.il',
  'org.il',
  'com.pl',
  'net.pl',
  'org.pl',
  'gov.pl',
  'com.es',
  'org.es',
  'gob.es',
  'com.pt',
  'org.pt',
  'gov.pt',
  'co.hu',
  'com.gr',
  'org.gr',
  'gov.gr',
  'com.ua',
  'co.za',
  'org.za',
  'gov.za',
  // Common hosting suffixes where each subdomain is a separate party
  'github.io',
  'gitlab.io',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'blogspot.com',
  's3.amazonaws.com'
]

/**
 * A rule set compiled for lookup, in the three shapes the Public Suffix List has.
 *
 * `exact` holds `co.uk`; `wildcards` holds `kawasaki.jp` for the rule
 * `*.kawasaki.jp`; `exceptions` holds `city.kawasaki.jp` for `!city.kawasaki.jp`.
 * The fourth rule, the implicit `*` that makes every top-level label a suffix,
 * is not stored: it is what the lookup answers when nothing else matches.
 */
export interface SuffixRules {
  readonly exact: ReadonlySet<string>
  readonly wildcards: ReadonlySet<string>
  readonly exceptions: ReadonlySet<string>
}

/**
 * Sorts rule lines into the three sets. Entries are lower-cased and lose a
 * leading dot; anything else about their spelling is the caller's business.
 */
export function compileSuffixRules(rules: Iterable<string>): SuffixRules {
  const exact = new Set<string>()
  const wildcards = new Set<string>()
  const exceptions = new Set<string>()
  for (const raw of rules) {
    const rule = raw.toLowerCase().replace(/^\./, '')
    if (rule.startsWith('!')) exceptions.add(rule.slice(1))
    else if (rule.startsWith('*.')) wildcards.add(rule.slice(2))
    else exact.add(rule)
  }
  return { exact, wildcards, exceptions }
}

/**
 * How many trailing labels of `labels` are the public suffix.
 *
 * The algorithm the list itself specifies: an exception rule prevails over every
 * other match, wherever it sits, and its suffix is the exception minus its
 * leftmost label. Otherwise the longest exact or wildcard match wins, and with no
 * match at all the implicit `*` makes the last label the suffix.
 */
export function publicSuffixLength(rules: SuffixRules, labels: readonly string[]): number {
  const tails = labels.map((_, start) => labels.slice(start).join('.'))
  for (let start = 0; start < labels.length; start++) {
    if (rules.exceptions.has(tails[start]!)) return labels.length - start - 1
  }
  for (let start = 0; start < labels.length; start++) {
    // `*.kawasaki.jp` makes `b.kawasaki.jp` a suffix: the label in front of the parent is the
    // wildcard, so the match is one label longer than the tail — and is checked first for that.
    if (start > 0 && rules.wildcards.has(tails[start]!)) return labels.length - start + 1
    if (rules.exact.has(tails[start]!)) return labels.length - start
  }
  return 1
}

let activeRules: SuffixRules = compileSuffixRules(BOOTSTRAP_SUFFIXES)
let configured = false

/**
 * Puts a checked Public Suffix List in force, as a union with the bootstrap.
 *
 * Union rather than replacement, so a list that lost an entry the bootstrap has
 * cannot merge sites this build has always kept apart.
 *
 * Once per run, and a second call throws rather than being ignored. Every site
 * key computed during a run — a partition, a permission origin, a password's
 * site — has to stay what it was when it was computed, so a list downloaded
 * mid-run waits for the next start (R7). Making that a property of the seam
 * rather than of its one caller means a future caller cannot quietly break it.
 */
export function configurePublicSuffixes(rules: Iterable<string>): void {
  if (configured) throw new Error('The public suffix rules are set once per run')
  activeRules = compileSuffixRules([...BOOTSTRAP_SUFFIXES, ...rules])
  configured = true
}

/**
 * Back to the bootstrap, with the once-per-run guard lifted. For tests only:
 * nothing in the application undoes the rules it started with.
 */
export function resetPublicSuffixes(): void {
  activeRules = compileSuffixRules(BOOTSTRAP_SUFFIXES)
  configured = false
}

export function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

export function isIpAddress(host: string): boolean {
  const normalized = normalizeHost(host)
  if (IPV4.test(normalized)) return normalized.split('.').every((p) => Number(p) <= 255)
  return normalized.includes(':')
}

/**
 * The registrable domain ("site") for a host: one label above the public
 * suffix. Returns the host itself for IP addresses and single-label hosts,
 * which have no registrable domain to derive.
 */
export function registrableDomain(host: string): string {
  return registrableDomainUnder(activeRules, host)
}

/** `registrableDomain` against a rule set of the caller's, e.g. a list being checked. */
export function registrableDomainUnder(rules: SuffixRules, host: string): string {
  const normalized = normalizeHost(host)
  if (normalized === '' || isIpAddress(normalized) || normalized === 'localhost') return normalized

  const labels = normalized.split('.')
  if (labels.length < 2) return normalized

  const suffix = publicSuffixLength(rules, labels)
  // Need one label in front of the suffix to have a registrable domain.
  if (suffix >= labels.length) return normalized
  return labels.slice(labels.length - suffix - 1).join('.')
}

/**
 * Whether a host is itself a public suffix under the rules in force: `co.uk`,
 * `github.io`, and — with the full list — `com.sg`.
 *
 * False for IP addresses and single-label names. An intranet name is a site in
 * its own right, which is how `registrableDomain` has always treated it, and a
 * key derived from one is not "too broad" for being a single label.
 */
export function isPublicSuffix(host: string): boolean {
  const normalized = normalizeHost(host)
  if (isIpAddress(normalized)) return false
  const labels = normalized.split('.')
  if (labels.length < 2) return false
  return publicSuffixLength(activeRules, labels) >= labels.length
}

/** Registrable domain of a URL, or `null` when it has no host. */
export function registrableDomainOfUrl(url: string): string | null {
  try {
    const { hostname } = new URL(url)
    if (hostname === '') return null
    return registrableDomain(hostname)
  } catch {
    return null
  }
}

/** True when both URLs belong to the same registrable domain. */
export function isSameSite(a: string, b: string): boolean {
  const left = registrableDomainOfUrl(a)
  const right = registrableDomainOfUrl(b)
  return left !== null && right !== null && left === right
}

/**
 * Whether `host` is covered by `pattern`, matching on whole labels only.
 *
 * `doubleclick.net` matches `ad.doubleclick.net` but not `notdoubleclick.net`;
 * this is the check that keeps a blocklist from taking out `track.dhl.de`
 * because some entry mentioned `track`.
 */
export function hostMatchesRule(host: string, pattern: string): boolean {
  const h = normalizeHost(host)
  const p = normalizeHost(pattern)
  if (p === '') return false
  return h === p || h.endsWith(`.${p}`)
}

/** First rule in `patterns` that covers `host`, or `null`. */
export function matchHostRule(host: string, patterns: Iterable<string>): string | null {
  for (const pattern of patterns) {
    if (hostMatchesRule(host, pattern)) return pattern
  }
  return null
}
