import {
  RESOURCE_TYPE_BITS,
  type CosmeticRule,
  type FilterListDiagnostics,
  type FilterResourceType,
  type NetworkRule
} from './model.js'

/**
 * Adblock Plus filter syntax, parsed into the rule shapes the matcher works on.
 *
 * The engine is hand-written rather than delegated to `@ghostery/adblocker`, and
 * the reason is a boundary rather than a preference. The cosmetic query has to be
 * reachable from a renderer, so it lives under `src/shared/`, where an
 * architecture test forbids Electron and Node built-ins and the renderer bundle
 * budget is 320 kB in total with 40 kB per shared chunk. `@ghostery/adblocker`
 * unpacks to 2.6 MB across seven transitive packages; it cannot go there, and
 * splitting the network half from the cosmetic half to smuggle it in would mean
 * two filter parsers with two ideas of what a rule means.
 *
 * What that trade forbids is silence. Spec 4's objection to a hand-rolled matcher
 * is a matcher that "understands a fraction of the syntax and discards the rest",
 * and the discarding is the part that hurts: a blocker that quietly implements
 * less than the user believes. So every line this parser cannot honour is counted
 * with a reason (`FilterListDiagnostics.unsupportedByReason`), and the outcome
 * counters add up to the line count exactly. Under-blocking becomes a number
 * somebody can read rather than an absence nobody notices.
 */

/**
 * Type options, including the aliases the lists actually use.
 *
 * `css` for stylesheet and `frame` for subdocument are older EasyList spellings
 * that still appear; `xhr`, `doc`, `beacon` come from uBlock's shorthand.
 */
const TYPE_OPTIONS: Readonly<Record<string, FilterResourceType>> = {
  document: 'document',
  doc: 'document',
  subdocument: 'subdocument',
  frame: 'subdocument',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  media: 'media',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  websocket: 'websocket',
  ping: 'ping',
  beacon: 'ping',
  other: 'other'
}

/**
 * Options this engine recognises and deliberately does not implement.
 *
 * A rule carrying one of these is skipped whole, never approximated. Treating
 * `$removeparam` or `$redirect=noop.js` as a plain block would change what the
 * list author asked for from "rewrite this" into "cancel this", which breaks
 * sites; treating `$popup` as a block would take out every `t.co` link because
 * Electron's `webRequest` has no popup resource type to scope it to. The honest
 * outcome is a skipped rule and a counter that says so.
 */
const UNSUPPORTED_OPTIONS: ReadonlySet<string> = new Set([
  // Needs a popup notion the interception point does not have.
  'popup',
  // Cosmetic-filtering exceptions; they belong to an element-hiding pass that
  // can distinguish generic from host-specific rules.
  'generichide',
  'genericblock',
  'elemhide',
  'specifichide',
  'ehide',
  'shide',
  // Response rewriting rather than blocking.
  'redirect',
  'redirect-rule',
  'rewrite',
  'removeparam',
  'queryprune',
  'urltransform',
  'replace',
  'empty',
  'mp4',
  // Header and policy manipulation.
  'csp',
  'header',
  'permissions',
  'referrerpolicy',
  'cookie',
  // Request predicates beyond URL, type and party.
  'method',
  'to',
  'denyallow',
  'strict1p',
  'strict3p',
  'ipaddress',
  'cname',
  'all',
  'inline-script',
  'inline-font',
  // AdGuard extensions: DNS rewriting, scriptlets, app scoping, stealth mode.
  'dnsrewrite',
  'dnstype',
  'client',
  'ctag',
  'app',
  'network',
  'extension',
  'stealth',
  'jsinject',
  'content',
  'hls',
  'jsonprune',
  'webrtc',
  'noop',
  // Cancels another rule; honouring it needs a second pass over the whole set.
  'badfilter'
])

/** `[Adblock Plus 2.0]` and friends. */
const METADATA_LINE = /^\[[^\]]*\]$/

/** `##`, `#@#`, and the extended forms `#?#`, `#$#`, `#%#` with their `@` variants. */
const COSMETIC_SEPARATOR = /#@?[?$%]?#/

/** A hosts-file line: an unroutable address followed by one or more names. */
const HOSTS_LINE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)[ \t]+(.+)$/

/** Names a hosts file points at loopback for its own sake, not to block them. */
const HOSTS_SELF_NAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'local',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback'
])

/** `name`, `~name` or `name=value` — anything else means the `$` was pattern text. */
const OPTION_TOKEN = /^~?[a-z0-9-]+(?:=.*)?$/i

const NO_HOSTS: readonly string[] = []

export interface ParsedFilterLists {
  readonly network: readonly NetworkRule[]
  readonly cosmetic: readonly CosmeticRule[]
  readonly diagnostics: FilterListDiagnostics
}

interface Counters {
  lines: number
  blank: number
  comments: number
  network: number
  cosmetic: number
  unsupported: number
  readonly reasons: Map<string, number>
}

/** Records a skipped line and its reason. Returns `null` so callers can tail-call it. */
function reject(counters: Counters, reason: string): null {
  counters.unsupported += 1
  counters.reasons.set(reason, (counters.reasons.get(reason) ?? 0) + 1)
  return null
}

function isComment(line: string): boolean {
  if (line.startsWith('!')) return true
  if (METADATA_LINE.test(line)) return true
  // Hosts-style lists comment with `#`, which collides with the cosmetic
  // separator. Only a `#` that does not open a separator is a comment.
  return line.startsWith('#') && !/^#@?[?$%]?#/.test(line)
}

interface HostList {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

/**
 * A domain list, either comma-separated (cosmetic prefix) or `|`-separated
 * (`$domain=`). Returns null for an entity pattern like `example.*`, which needs
 * a public-suffix expansion this engine does not do.
 */
function parseHostList(text: string, separator: string): HostList | null {
  if (text === '') return { include: NO_HOSTS, exclude: NO_HOSTS }
  const include: string[] = []
  const exclude: string[] = []
  for (const entry of text.split(separator)) {
    const host = entry.trim().toLowerCase()
    if (host === '') continue
    if (host.includes('*')) return null
    if (host.startsWith('~')) exclude.push(host.slice(1))
    else include.push(host)
  }
  return { include, exclude }
}

interface SplitRule {
  readonly pattern: string
  readonly options: readonly string[]
}

/**
 * Separates the pattern from its `$options`.
 *
 * The separator is the last `$`, but a `$` also occurs inside URLs. Requiring
 * every comma-separated piece after it to have an option's shape is what tells
 * the two apart, and getting it wrong silently turns a rule into one that can
 * never match.
 */
function splitOptions(body: string): SplitRule {
  const marker = body.lastIndexOf('$')
  if (marker < 0) return { pattern: body, options: [] }
  const tokens = body.slice(marker + 1).split(',')
  if (!tokens.every((token) => OPTION_TOKEN.test(token))) return { pattern: body, options: [] }
  return { pattern: body.slice(0, marker), options: tokens }
}

interface Anchors {
  hostAnchor: boolean
  leftAnchor: boolean
  rightAnchor: boolean
  core: string
}

function stripAnchors(pattern: string): Anchors {
  let core = pattern
  let hostAnchor = false
  let leftAnchor = false
  let rightAnchor = false
  if (core.startsWith('||')) {
    hostAnchor = true
    core = core.slice(2)
  } else if (core.startsWith('|')) {
    leftAnchor = true
    core = core.slice(1)
  }
  if (core.endsWith('|')) {
    rightAnchor = true
    core = core.slice(0, -1)
  }
  // A `*` beside an anchor makes that anchor vacuous: `|*ads` is "start, then
  // anything, then ads", which is exactly an unanchored `ads`. Dropping the
  // anchor is an equivalence, not an approximation — and keeping it would pin
  // the segment to position 0 and make the rule match nothing.
  if (core.startsWith('*')) {
    hostAnchor = false
    leftAnchor = false
  }
  if (core.endsWith('*')) rightAnchor = false
  return { hostAnchor, leftAnchor, rightAnchor, core }
}

function parseNetworkRule(line: string, counters: Counters): NetworkRule | null {
  const isException = line.startsWith('@@')
  const body = isException ? line.slice(2) : line
  const { pattern, options } = splitOptions(body)

  // `/…/` is a regular expression in this syntax. Compiling one from a
  // downloaded list would put an attacker-supplied pattern in the hot path of
  // every request, so these are skipped and counted instead.
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    return reject(counters, 'regex-pattern')
  }
  if (pattern === '') return reject(counters, 'empty-pattern')

  let types = 0
  let excludedTypes = 0
  let thirdParty: boolean | null = null
  let matchCase = false
  let important = false
  let includeDomains: readonly string[] = NO_HOSTS
  let excludeDomains: readonly string[] = NO_HOSTS

  for (const token of options) {
    const negated = token.startsWith('~')
    const rest = negated ? token.slice(1) : token
    const equals = rest.indexOf('=')
    const name = (equals < 0 ? rest : rest.slice(0, equals)).toLowerCase()

    const type = TYPE_OPTIONS[name]
    if (type !== undefined) {
      if (negated) excludedTypes |= RESOURCE_TYPE_BITS[type]
      else types |= RESOURCE_TYPE_BITS[type]
      continue
    }
    if (name === 'third-party' || name === '3p') {
      thirdParty = !negated
      continue
    }
    if (name === 'first-party' || name === '1p') {
      thirdParty = negated
      continue
    }
    if (name === 'domain' || name === 'from') {
      if (negated || equals < 0) return reject(counters, `unknown-option:${name}`)
      const hosts = parseHostList(rest.slice(equals + 1), '|')
      if (hosts === null) return reject(counters, 'domain-entity')
      includeDomains = hosts.include
      excludeDomains = hosts.exclude
      continue
    }
    if (name === 'match-case') {
      matchCase = !negated
      continue
    }
    if (name === 'important') {
      important = !negated
      continue
    }
    const kind = UNSUPPORTED_OPTIONS.has(name) ? 'unsupported-option' : 'unknown-option'
    return reject(counters, `${kind}:${name}`)
  }

  const { hostAnchor, leftAnchor, rightAnchor, core } = stripAnchors(pattern)
  if (core === '') return reject(counters, 'empty-pattern')

  const segments = core.split('*').filter((part) => part !== '')
  const parts = matchCase ? segments : segments.map((part) => part.toLowerCase())

  return {
    raw: line,
    parts,
    hostAnchor,
    leftAnchor,
    rightAnchor,
    hasSeparator: parts.some((part) => part.includes('^')),
    matchCase,
    isException,
    important,
    types,
    excludedTypes,
    thirdParty,
    includeDomains,
    excludeDomains
  }
}

function parseCosmeticRule(
  line: string,
  separator: RegExpExecArray,
  counters: Counters
): CosmeticRule | null {
  const marker = separator[0]
  if (marker !== '##' && marker !== '#@#') {
    // `#?#` needs a selector engine for `:has-text` and `:upward`; `#$#`, `#%#`
    // and their `@` variants inject CSS or a scriptlet rather than hiding.
    return reject(counters, marker.includes('?') ? 'extended-cosmetic' : 'cosmetic-snippet')
  }
  const selector = line.slice(separator.index + marker.length).trim()
  if (selector === '') return reject(counters, 'cosmetic-empty-selector')
  const hosts = parseHostList(line.slice(0, separator.index), ',')
  if (hosts === null) return reject(counters, 'domain-entity')
  return {
    selector,
    isException: marker === '#@#',
    includeHosts: hosts.include,
    excludeHosts: hosts.exclude
  }
}

/**
 * Hostnames from a hosts-file line, or null when the line is not one.
 *
 * An empty array means it *is* a hosts line but names nothing worth blocking:
 * every hosts file opens by pointing the machine's own names at loopback, and
 * turning those into rules would make `localhost` unreachable.
 */
function hostsFileNames(line: string): readonly string[] | null {
  const match = HOSTS_LINE.exec(line)
  if (match === null) return null
  return match[1]!
    .split('#')[0]!
    .split(/[ \t]+/)
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '' && !HOSTS_SELF_NAMES.has(name))
}

/** A hosts-file name compiled to the rule `||name^` would have produced. */
function hostNameRule(raw: string, name: string): NetworkRule {
  return {
    raw,
    parts: [`${name}^`],
    hostAnchor: true,
    leftAnchor: false,
    rightAnchor: false,
    hasSeparator: true,
    matchCase: false,
    isException: false,
    important: false,
    types: 0,
    excludedTypes: 0,
    thirdParty: null,
    includeDomains: NO_HOSTS,
    excludeDomains: NO_HOSTS
  }
}

/** Parses several list bodies into one rule set with combined diagnostics. */
export function parseFilterLists(texts: readonly string[]): ParsedFilterLists {
  const network: NetworkRule[] = []
  const cosmetic: CosmeticRule[] = []
  const counters: Counters = {
    lines: 0,
    blank: 0,
    comments: 0,
    network: 0,
    cosmetic: 0,
    unsupported: 0,
    reasons: new Map()
  }

  for (const text of texts) {
    for (const raw of text.split('\n')) {
      counters.lines += 1
      const line = raw.trim()
      if (line === '') {
        counters.blank += 1
        continue
      }
      if (isComment(line)) {
        counters.comments += 1
        continue
      }

      // A regular-expression rule may contain `#`, so it is ruled out before the
      // cosmetic separator is looked for.
      const separator = line.startsWith('/') || line.startsWith('@@/')
        ? null
        : COSMETIC_SEPARATOR.exec(line)
      if (separator !== null) {
        const rule = parseCosmeticRule(line, separator, counters)
        if (rule !== null) {
          cosmetic.push(rule)
          counters.cosmetic += 1
        }
        continue
      }

      const names = hostsFileNames(line)
      if (names !== null) {
        if (names.length === 0) {
          reject(counters, 'hosts-loopback-name')
          continue
        }
        for (const name of names) network.push(hostNameRule(line, name))
        counters.network += 1
        continue
      }

      const rule = parseNetworkRule(line, counters)
      if (rule !== null) {
        network.push(rule)
        counters.network += 1
      }
    }
  }

  return {
    network,
    cosmetic,
    diagnostics: {
      lines: counters.lines,
      blank: counters.blank,
      comments: counters.comments,
      network: counters.network,
      cosmetic: counters.cosmetic,
      unsupported: counters.unsupported,
      unsupportedByReason: Object.fromEntries(counters.reasons)
    }
  }
}

/** Convenience for one list body. */
export function parseFilterList(text: string): ParsedFilterLists {
  return parseFilterLists([text])
}
