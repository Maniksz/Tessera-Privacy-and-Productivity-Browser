import {
  BOOTSTRAP_SUFFIXES,
  compileSuffixRules,
  registrableDomainUnder,
  type SuffixRules
} from './domain.js'

/**
 * The downloaded Public Suffix List: what a body means, and whether it may be trusted.
 *
 * The list decides which hosts are one site, and one site is what a saved password is offered to.
 * So a list that went wrong in transit, was replaced by an error page, or was edited by somebody
 * who controls the download is not a stale-data problem but a way to have a password for
 * `bank.com.sg` offered on `evil.com.sg`. Everything here exists to refuse such a list before it is
 * stored, and to refuse it again at startup should the stored copy have changed since.
 *
 * The direction of the danger is what the checks follow. A suffix that is *kept* can only split
 * sites more finely; a suffix that is *removed*, or an exception that undoes one, merges them. So
 * removals are what is counted and bounded, and additions are free — with the one addition that
 * splits every site under a top-level domain, `*.com`, refused on its own terms.
 *
 * Pure and free of Node built-ins, like the rest of `shared/`: the caller converts Unicode rules to
 * Punycode (`domainToASCII` in the core) and hands the converter in. Imported by the core only,
 * never by a renderer — `domain.ts` is what a renderer may reach, and it carries no parser.
 */

/** A body over this many bytes is refused before it is parsed. The real list is about a quarter. */
export const PUBLIC_SUFFIX_MAX_BYTES = 1024 * 1024

/**
 * Fewer rules than this is not the list, whatever its markers say.
 *
 * The published list has held well over nine thousand rules for years; half that is a truncation,
 * a test file, or somebody's idea of a list, and none of those may decide what a site is.
 */
export const PUBLIC_SUFFIX_MIN_RULES = 5000

/**
 * The share of the baseline's rules a candidate may lack, counted as a set difference.
 *
 * A set difference rather than a change in count, so 300 rules removed and 300 others added is 300
 * removed. And against the baseline rather than against the list in force, so seven deliveries that
 * each drop a little cannot add up to a large drop: the baseline stays put for thirty days.
 */
export const PUBLIC_SUFFIX_MAX_REMOVED_FRACTION = 0.02

/**
 * The most PRIVATE rules one candidate may drop against the list in force.
 *
 * PRIVATE rules are hosting providers declaring their customers separate parties, and they do get
 * withdrawn when a service shuts down or is restructured. So losing a few is not refused outright:
 * it is held back and accepted once the same rules are still missing a week later (see
 * `isConfirmableRemoval`). Beyond this many, it is refused however often it arrives.
 */
export const PUBLIC_SUFFIX_MAX_PRIVATE_REMOVED = 150

const MARKERS = [
  '// ===BEGIN ICANN DOMAINS===',
  '// ===END ICANN DOMAINS===',
  '// ===BEGIN PRIVATE DOMAINS===',
  '// ===END PRIVATE DOMAINS==='
] as const

/** A rule as it can be looked up: labels of letters, digits and hyphens, Punycode for the rest. */
const RULE_DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/

// A character outside ASCII; spelled as a range so the source stays plain ASCII itself.
const NON_ASCII = /[\u0080-\uffff]/

/** A parsed list, its rules as the list writes them (`co.uk`, `*.ck`, `!www.ck`). */
export interface PublicSuffixList {
  readonly icann: readonly string[]
  readonly private: readonly string[]
  /**
   * False when the four section markers are missing or out of order, or a rule sits outside the
   * two sections. An error page, a truncated body and a file that merely resembles the list all
   * end up here.
   */
  readonly structured: boolean
}

/** Turns one domain into its ASCII form; `''` when it has none. `domainToASCII` in the core. */
export type ToAscii = (domain: string) => string

function normalizeRule(token: string, toAscii: ToAscii): string | null {
  const lowered = token.toLowerCase()
  const prefix = lowered.startsWith('!') ? '!' : lowered.startsWith('*.') ? '*.' : ''
  const domain = lowered.slice(prefix.length)
  // Only a Unicode rule goes through the converter, so a quirk of the converter can never change
  // the spelling of a rule that was plain ASCII to begin with.
  const ascii = NON_ASCII.test(domain) ? toAscii(domain) : domain
  // A rule this lookup cannot represent is left out rather than failing the list: it matches no
  // host a URL can produce, so leaving it out changes nothing.
  return RULE_DOMAIN.test(ascii) ? `${prefix}${ascii}` : null
}

/**
 * Reads the list's text format.
 *
 * One rule per line, read up to the first whitespace; `//` starts a comment. The sections are
 * recognised by their exact marker lines, in their fixed order.
 */
export function parsePublicSuffixList(text: string, toAscii: ToAscii): PublicSuffixList {
  const icann: string[] = []
  const privateRules: string[] = []
  let markersSeen = 0
  let outsideSections = false

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === MARKERS[markersSeen]) {
      markersSeen += 1
      continue
    }
    if (trimmed === '' || trimmed.startsWith('//')) continue
    const rule = normalizeRule(trimmed.split(/\s/)[0]!, toAscii)
    if (rule === null) continue
    if (markersSeen === 1) icann.push(rule)
    else if (markersSeen === 3) privateRules.push(rule)
    else outsideSections = true
  }

  return {
    icann,
    private: privateRules,
    structured: markersSeen === MARKERS.length && !outsideSections
  }
}

/** Every rule of a list, both sections, for putting it in force. */
export function rulesOf(list: PublicSuffixList): readonly string[] {
  return [...list.icann, ...list.private]
}

/**
 * Why a candidate was refused. Stable strings, so a log line can be searched for.
 *
 * `icann-removed` and `private-removed` are the only ones that are not final: see
 * `isConfirmableRemoval`.
 */
export type PublicSuffixRejection =
  | 'too-large'
  | 'structure'
  | 'too-few-rules'
  | 'icann-removed'
  | 'private-removed'
  | 'private-removed-beyond-limit'
  | 'baseline-drift'
  | 'orphan-exception'
  | 'bootstrap-override'
  | 'tld-wildcard'
  | 'canary'

export interface PublicSuffixHistory {
  /** The list in force, or null before any was accepted. */
  readonly current: PublicSuffixList | null
  /** The oldest good list of the last thirty days, or null before any was accepted. */
  readonly baseline: PublicSuffixList | null
}

/** No history: what a stored copy is checked against at startup. */
export const NO_PUBLIC_SUFFIX_HISTORY: PublicSuffixHistory = { current: null, baseline: null }

/** The rules of the list in force a candidate lacks, per section, each sorted. */
export interface PublicSuffixRemovals {
  readonly icann: readonly string[]
  readonly private: readonly string[]
}

export interface PublicSuffixVerdict {
  /** Null when the text was not parsed at all (too large). */
  readonly list: PublicSuffixList | null
  /** Empty when the list may be used. */
  readonly rejections: readonly PublicSuffixRejection[]
  /**
   * What the candidate drops against the list in force; empty without one, or for a body that is
   * not the list.
   *
   * Sorted, so two bodies that lack the same rules name them identically however else they differ:
   * that is what a held-back removal is recognised by on a later delivery.
   */
  readonly removed: PublicSuffixRemovals
}

const NO_REMOVALS: PublicSuffixRemovals = { icann: [], private: [] }

/**
 * Hosts whose site any real list agrees on, checked against the candidate alone.
 *
 * Alone rather than joined with the bootstrap, which is stricter: the list in force is the union,
 * but a candidate that needs the bootstrap to get `github.io` right is not the list.
 */
const CANARIES: ReadonlyArray<readonly [host: string, site: string]> = [
  ['www.example.com', 'example.com'],
  ['www.bbc.co.uk', 'bbc.co.uk'],
  ['www.bank.com.sg', 'bank.com.sg'],
  ['a.github.io', 'a.github.io'],
  ['a.b.kawasaki.jp', 'a.b.kawasaki.jp'],
  // `www.` in front, because a host that is itself a suffix is returned unchanged either way.
  ['www.city.kawasaki.jp', 'city.kawasaki.jp']
]

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function missingFrom(before: readonly string[], after: ReadonlySet<string>): string[] {
  return before.filter((rule) => !after.has(rule))
}

/** Whether `domain` is `ancestor` or sits beneath it, on whole labels. */
function isAtOrBelow(domain: string, ancestor: string): boolean {
  return domain === ancestor || domain.endsWith(`.${ancestor}`)
}

/**
 * The rules that can make two sites one, looked at one by one.
 *
 * An exception undoes a suffix, so it needs the wildcard it is an exception to, and it may not
 * reach a suffix the bootstrap has — `!github.io`, or `!amazonaws.com` above `s3.amazonaws.com`,
 * would otherwise win over the bootstrap entry in the union, because an exception prevails over
 * every other match. A wildcard on a single label splits every site under that top-level domain;
 * the published list has a handful for country domains that register only at the third level
 * (`*.ck`, `*.jm`), so one is refused only where the bootstrap shows a registry that does register
 * below the second level, or where it is new against the list in force.
 */
function ruleShapeRejections(
  rules: SuffixRules,
  current: SuffixRules | null
): PublicSuffixRejection[] {
  const rejections = new Set<PublicSuffixRejection>()
  for (const exception of rules.exceptions) {
    // `!city.kawasaki.jp` is an exception to `*.kawasaki.jp`; a single label has no wildcard above it.
    const dot = exception.indexOf('.')
    if (dot < 0 || !rules.wildcards.has(exception.slice(dot + 1)))
      rejections.add('orphan-exception')
    if (BOOTSTRAP_SUFFIXES.some((suffix) => isAtOrBelow(suffix, exception))) {
      rejections.add('bootstrap-override')
    }
  }
  for (const wildcard of rules.wildcards) {
    if (wildcard.includes('.')) continue
    const underBootstrap = BOOTSTRAP_SUFFIXES.some((suffix) => isAtOrBelow(suffix, wildcard))
    const isNew = current !== null && !current.wildcards.has(wildcard)
    if (underBootstrap || isNew) rejections.add('tld-wildcard')
  }
  return [...rejections]
}

/**
 * Everything R6 asks of a list, in one verdict.
 *
 * Every reason is collected rather than stopping at the first, except for a body that is too large
 * or not the list at all: parsing a megabyte of something else to count its rules would say nothing
 * more. Collecting matters for one reason in particular — only a candidate whose *sole* problems are
 * removals within the limits may be accepted a week later, and that cannot be known from the first
 * problem found.
 */
export function checkPublicSuffixList(
  text: string,
  toAscii: ToAscii,
  history: PublicSuffixHistory
): PublicSuffixVerdict {
  if (byteLength(text) > PUBLIC_SUFFIX_MAX_BYTES) {
    return { list: null, rejections: ['too-large'], removed: NO_REMOVALS }
  }
  const list = parsePublicSuffixList(text, toAscii)
  if (!list.structured) return { list, rejections: ['structure'], removed: NO_REMOVALS }

  const rejections: PublicSuffixRejection[] = []
  const all = rulesOf(list)
  const allSet = new Set(all)
  if (all.length < PUBLIC_SUFFIX_MIN_RULES) rejections.push('too-few-rules')

  const { current, baseline } = history
  let removed = NO_REMOVALS
  if (current !== null) {
    removed = {
      icann: missingFrom(current.icann, new Set(list.icann)).sort(),
      private: missingFrom(current.private, new Set(list.private)).sort()
    }
    if (removed.icann.length > 0) rejections.push('icann-removed')
    if (removed.private.length > PUBLIC_SUFFIX_MAX_PRIVATE_REMOVED) {
      rejections.push('private-removed-beyond-limit')
    } else if (removed.private.length > 0) {
      rejections.push('private-removed')
    }
  }
  if (baseline !== null) {
    const before = rulesOf(baseline)
    if (missingFrom(before, allSet).length > before.length * PUBLIC_SUFFIX_MAX_REMOVED_FRACTION) {
      rejections.push('baseline-drift')
    }
  }

  const rules = compileSuffixRules(all)
  rejections.push(
    ...ruleShapeRejections(rules, current === null ? null : compileSuffixRules(rulesOf(current)))
  )
  if (CANARIES.some(([host, site]) => registrableDomainUnder(rules, host) !== site)) {
    rejections.push('canary')
  }
  return { list, rejections, removed }
}

const CONFIRMABLE: ReadonlySet<PublicSuffixRejection> = new Set([
  'icann-removed',
  'private-removed'
])

/**
 * Whether the reasons leave room for acceptance once the same rules have stayed missing for a week:
 * rules removed within the limits, ICANN or PRIVATE, and nothing else.
 *
 * Upstream does retire rules — a PRIVATE entry when a hosting service closes, an ICANN one when a
 * brand top-level domain is terminated — and a list that refused every such removal for good would
 * freeze at the last list before it, so new PRIVATE suffixes would never arrive and their tenants
 * would stay one site. A removal that one delivery makes and the next ones do not is what a
 * manipulated download looks like; the same removal, delivery after delivery for a week, is what a
 * real change looks like (see `PublicSuffixSubscription`). Everything else — a broken body, a failed
 * canary, a wildcard on a top-level domain, drift past the baseline, PRIVATE losses past their cap —
 * is wrong however long it persists.
 */
export function isConfirmableRemoval(rejections: readonly PublicSuffixRejection[]): boolean {
  return rejections.length > 0 && rejections.every((reason) => CONFIRMABLE.has(reason))
}
