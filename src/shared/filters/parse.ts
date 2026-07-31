import {
  RESOURCE_TYPE_BITS,
  type CosmeticRule,
  type FilterListDiagnostics,
  type FilterResourceType,
  type NetworkRule
} from './model.js'
import { selectorProblem } from './selector-safety.js'
import { lookupScriptlet, type ScriptletRule } from './scriptlets.js'
import {
  isProceduralSelector,
  parseProceduralSelector,
  type ProceduralRule
} from './procedural.js'

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
  /**
   * `##+js(…)` rules, of which the three default lists carry 2 112.
   *
   * A third list rather than a flavour of `cosmetic`, because hiding an element and running code in the
   * page are different powers and the settings screen reports them separately.
   */
  readonly scriptlet: readonly ScriptletRule[]
  /**
   * Rules whose selector no CSS engine can evaluate — `:has-text()`, `:upward()`, `:style()`.
   *
   * A fourth list, and apart from `cosmetic` for a reason that is about cost rather than tidiness: a
   * declarative rule is one line in a stylesheet the browser matches, while one of these is script running
   * on every mutation burst. Keeping them in separate lists is what stops a rule that *could* have been
   * plain CSS from quietly ending up on the expensive path.
   */
  readonly procedural: readonly ProceduralRule[]
  readonly diagnostics: FilterListDiagnostics
}

interface Counters {
  lines: number
  blank: number
  comments: number
  network: number
  cosmetic: number
  scriptlet: number
  procedural: number
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

/**
 * A `##+js(…)` line as a scriptlet rule, `null` when it is one this browser cannot run, and the sentinel
 * `'not-a-scriptlet'` when the line is an ordinary cosmetic rule.
 *
 * Three outcomes rather than two, and the sentinel is what keeps the caller honest: `null` already means
 * "recognised and refused, and counted", so reusing it for "this is not mine" would make the caller fall
 * through to the cosmetic parser on a *rejected* scriptlet and count the same line twice.
 *
 * ## Which markers carry a scriptlet
 *
 * `##` and `#@#`. uBlock Origin also writes the exception form, `#@#+js(…)`, to cancel a scriptlet the
 * list applied elsewhere — that is the escape hatch for a site the scriptlet breaks, so refusing it while
 * honouring the positive form would leave the browser applying a scriptlet the list itself had withdrawn.
 * The other markers (`#?#`, `#$#`, `#%#`) are rejected by `parseCosmeticRule` as before.
 */
function parseScriptletRule(
  line: string,
  separator: RegExpExecArray,
  counters: Counters
): ScriptletRule | null | 'not-a-scriptlet' {
  const marker = separator[0]
  if (marker !== '##' && marker !== '#@#') return 'not-a-scriptlet'

  const payload = line.slice(separator.index + marker.length).trim()
  const lookup = lookupScriptlet(payload)
  if (lookup.kind === 'none') return 'not-a-scriptlet'

  if (lookup.kind === 'unimplemented') {
    /*
      Named in the reason, which is the difference between a number and a work item.

      `scriptlet-unimplemented: 296` says the browser is missing something. `scriptlet-unimplemented:aost`
      repeated twenty times says *which* one and how much it would buy — and that is what the library in
      `scriptlets.ts` was chosen from. Same shape as `unsupported-option:popup`, which is where the idea
      of putting the name in the key came from.
    */
    const name = lookup.name === '' ? 'unnamed' : lookup.name
    return reject(counters, `scriptlet-unimplemented:${name}`)
  }

  const hosts = parseHostList(line.slice(0, separator.index), ',')
  if (hosts === null) return reject(counters, 'domain-entity')

  return {
    call: lookup.call,
    isException: marker === '#@#',
    includeHosts: hosts.include,
    excludeHosts: hosts.exclude
  }
}

/**
 * A procedural cosmetic rule, `null` for one that cannot be honoured, and `'not-procedural'` when the
 * selector is ordinary CSS.
 *
 * Three outcomes for the reason `parseScriptletRule` needs three: `null` already means "recognised,
 * refused and counted", so reusing it for "not mine" would send a *rejected* procedural rule on to the
 * declarative parser and count the same line twice.
 *
 * ## Why an exception is not procedural
 *
 * `#@#` cancels a selector by its text, and the declarative index does that by string comparison. A
 * procedural exception would have to cancel a *chain*, which needs the two to be compared structurally —
 * a different mechanism for six lines across the three default lists. So `#@#` stays with
 * `parseCosmeticRule`, where an exception carrying procedural syntax is refused by the selector check and
 * counted like any other.
 *
 * ## Why a generic procedural rule is refused
 *
 * uBlock Origin refuses one too, and the reason is cost rather than compatibility: these are evaluated by
 * script on every matching document and re-evaluated on every mutation burst, so a rule naming no host is
 * that work on every page for the rest of the session. See `PROCEDURAL_NEEDS_HOST`.
 */
function parseProceduralRule(
  line: string,
  separator: RegExpExecArray,
  counters: Counters
): ProceduralRule | null | 'not-procedural' {
  const marker = separator[0]
  // `#?#` is AdGuard's and uBO's explicit "this is extended syntax" marker; `##` carries them too.
  if (marker !== '##' && marker !== '#?#') return 'not-procedural'

  const payload = line.slice(separator.index + marker.length).trim()
  if (payload === '' || !isProceduralSelector(payload)) return 'not-procedural'

  const parsed = parseProceduralSelector(payload)
  if ('problem' in parsed) return reject(counters, parsed.problem)

  const hosts = parseHostList(line.slice(0, separator.index), ',')
  if (hosts === null) return reject(counters, 'domain-entity')
  if (hosts.include.length === 0) return reject(counters, 'procedural-generic')

  return {
    selector: parsed,
    text: line,
    includeHosts: hosts.include,
    excludeHosts: hosts.exclude
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
  /*
    `##` says the rest is a *selector*; it does not make it one.

    uBlock Origin puts three different instructions behind this separator: plain hiding, scriptlet
    injection (`##+js(set-constant, …)`) and procedural selectors (`##.box:has-text(Anzeige)`). Only the
    first is CSS. Checking the marker alone — which is all this function used to do — stored the other
    two as selectors, and `cosmeticCss` then joined them into the same CSS rule as the real ones. A CSS
    selector list is all-or-nothing, so one scriptlet line took down every hiding rule it was sent with;
    on any site covered by uAssets' annoyances list, that was most of them, silently.

    Refused here rather than filtered later so the cost lands in the diagnostics, where the settings
    page can show it. `selectorProblem` returns the reason, and the reason is the point: a five-figure
    `procedural-cosmetic` count names a feature to build, where `unsupported` alone would not.
  */
  const problem = selectorProblem(selector)
  if (problem !== null) return reject(counters, problem)
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
  const scriptlet: ScriptletRule[] = []
  const procedural: ProceduralRule[] = []
  const counters: Counters = {
    lines: 0,
    blank: 0,
    comments: 0,
    network: 0,
    cosmetic: 0,
    scriptlet: 0,
    procedural: 0,
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
        /*
          A scriptlet before a selector, because both arrive behind `##` and only one of them is CSS.

          uBlock Origin overloads the separator: `##.ad-slot` hides an element and
          `##+js(set-constant, canRunAds, true)` runs a named piece of code. Asking about the scriptlet
          form first is what stops the second from being read as the first — which is what happened, and
          it did not merely fail: the payload went into the page's stylesheet and invalidated the whole
          CSS rule it was joined into. See `selector-safety.ts`.
        */
        const asScriptlet = parseScriptletRule(line, separator, counters)
        if (asScriptlet !== 'not-a-scriptlet') {
          if (asScriptlet !== null) {
            scriptlet.push(asScriptlet)
            counters.scriptlet += 1
          }
          continue
        }

        /*
          A procedural selector before a declarative one, for the same reason a scriptlet is checked before
          both: `##` says nothing about which of the three the payload is.

          Asked *before* `parseCosmeticRule` because that function's selector check refuses these — it has
          to, since a `:has-text()` written into a stylesheet invalidates the rule it is joined into. So the
          order here is what turns 718 refusals into 718 working rules.
        */
        const asProcedural = parseProceduralRule(line, separator, counters)
        if (asProcedural !== 'not-procedural') {
          if (asProcedural !== null) {
            procedural.push(asProcedural)
            counters.procedural += 1
          }
          continue
        }

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
    scriptlet,
    procedural,
    diagnostics: {
      lines: counters.lines,
      blank: counters.blank,
      comments: counters.comments,
      network: counters.network,
      cosmetic: counters.cosmetic,
      scriptlet: counters.scriptlet,
      procedural: counters.procedural,
      unsupported: counters.unsupported,
      unsupportedByReason: Object.fromEntries(counters.reasons)
    }
  }
}

/** Convenience for one list body. */
export function parseFilterList(text: string): ParsedFilterLists {
  return parseFilterLists([text])
}
