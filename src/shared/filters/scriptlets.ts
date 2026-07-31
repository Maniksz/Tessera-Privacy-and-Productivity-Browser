/**
 * `##+js(…)` — the scriptlet half of a filter list, parsed.
 *
 * ## What a scriptlet is, and why a blocker needs them
 *
 * A network rule stops a request and a cosmetic rule hides an element. Neither can do anything about a
 * page whose *own* script decides what to show: an anti-adblock wall that reads `window.canRunAds` and
 * blanks the article if it is missing, an overlay installed by `setTimeout`, a redirect fired from a
 * click handler the page attached to the whole document. Those are defeated by changing what the page's
 * script sees, which is what a scriptlet does — a small, named, parameterised piece of code injected
 * before the page's own.
 *
 * ## How much of this browser's blocking was missing
 *
 * Measured over the three lists it ships with (fetched 31.07.2026): **2 123 `##+js(…)` lines**, against
 * 24 259 cosmetic ones. Almost all of them are in uAssets' annoyances list — on by default, and the one
 * aimed at exactly the walls and overlays described above, where scriptlets outnumber hiding rules four
 * to one. EasyList itself has none. So for that list the feature was not partly implemented; it was most
 * of the file.
 *
 * What this build now does with those 2 123 lines: **1 720 honoured**, 299 refused as a scriptlet with no
 * implementation here (each counted with its own name), and 113 lost earlier to the pre-existing
 * `domain-entity` refusal — `pelispedia.*##+js(…)` needs a public-suffix expansion this engine does not
 * do, which is a separate gap with its own counter.
 *
 * They were not merely unimplemented before this. `##` was taken to mean "a selector follows", so
 * `+js(set-constant, canRunAds, true)` was stored as a CSS selector and written into the page's
 * stylesheet, where it invalidated the entire CSS rule it was joined into and took every real hiding
 * rule in that batch down with it. See `selector-safety.ts`.
 *
 * ## Why a fixed library rather than running what the list says
 *
 * A scriptlet is *code*, and a filter list is a file downloaded over the network. uBlock Origin does not
 * execute list-supplied code either: the list names a scriptlet from a library the browser ships and
 * passes it string arguments. That is what makes the feature auditable — the worst a compromised list
 * can do is call a known function with unexpected arguments — and it is why the trusted-* family of
 * scriptlets is deliberately absent here. Those exist to inject list-author-supplied values into a page,
 * and there is no version of that this browser should offer.
 *
 * ## What is in the library and why those
 *
 * Usage counts over the same three lists, which is how the set was chosen rather than by guessing:
 *
 * | scriptlet | uses | what it defeats |
 * |---|---|---|
 * | `abort-current-script` (`acs`) | 411 | an inline script that reads a property |
 * | `addEventListener-defuser` (`aeld`) | 354 | a handler the page attaches to spy or to redirect |
 * | `abort-on-property-read` (`aopr`) | 274 | a wall that reads a variable it expects to exist |
 * | `set-constant` (`set`) | 245 | the same wall, by giving it the answer it wants |
 * | `abort-on-property-write` (`aopw`) | 184 | a script that installs a detector |
 * | `remove-attr` (`ra`) | 171 | markup attributes that drive an overlay |
 * | `prevent-setTimeout` (`nostif`) | 139 | a delayed overlay or reload |
 * | `prevent-setInterval` (`nosiif`) | 38 | the same, repeating |
 *
 * Eight implementations, 1 720 rules honoured — 85 % of every `##+js(…)` line in the three lists. The tail
 * is long and thin, and the measured order of what is left says where the next one would go:
 * `remove-node-text` (`rmnt`) at 110, `abort-on-stack-trace` at 21, `no-fetch-if` at 20, and after those
 * single digits. Forty-seven of the remainder are the trusted-* family and will stay unimplemented by
 * decision rather than by effort.
 *
 * What is not implemented stays counted with its own name, so the gap is a number in the settings rather
 * than a silence — the rule the whole of `parse.ts` is built on, and the reason this table could be
 * written from measurement instead of guesswork.
 *
 * Zod-free like the rest of this directory: the settings surface reads these types.
 */

/** One call: the library entry to run, and the string arguments the list passed it. */
export interface ScriptletCall {
  /** Canonical name — an alias in the list has already been resolved. */
  readonly name: string
  readonly args: readonly string[]
}

/** A scriptlet rule from a list, scoped like a cosmetic one. */
export interface ScriptletRule {
  readonly call: ScriptletCall
  /** Hosts the rule names; empty means every site. */
  readonly includeHosts: readonly string[]
  readonly excludeHosts: readonly string[]
  /** True for `#@#`: the rule cancels this scriptlet on the hosts it names. */
  readonly isException: boolean
}

/**
 * Every spelling a list may use, mapped to the one the library implements.
 *
 * The short forms are what the lists actually contain — `acs` outnumbers
 * `abort-current-script` by a wide margin — so an implementation keyed on the long name alone would
 * match almost nothing. uBlock Origin treats a trailing `.js` as insignificant and so does the
 * resolution below, because both spellings occur.
 *
 * `abort-current-inline-script` is uBO's older name for `abort-current-script`, kept because older list
 * snapshots and hand-written user rules still use it.
 */
const SCRIPTLET_ALIASES: Readonly<Record<string, string>> = {
  acs: 'abort-current-script',
  acis: 'abort-current-script',
  'abort-current-script': 'abort-current-script',
  'abort-current-inline-script': 'abort-current-script',

  aeld: 'addEventListener-defuser',
  'addeventlistener-defuser': 'addEventListener-defuser',
  'prevent-addeventlistener': 'addEventListener-defuser',

  aopr: 'abort-on-property-read',
  'abort-on-property-read': 'abort-on-property-read',

  aopw: 'abort-on-property-write',
  'abort-on-property-write': 'abort-on-property-write',

  set: 'set-constant',
  'set-constant': 'set-constant',

  ra: 'remove-attr',
  'remove-attr': 'remove-attr',

  nostif: 'prevent-setTimeout',
  'no-settimeout-if': 'prevent-setTimeout',
  'prevent-settimeout': 'prevent-setTimeout',
  'settimeout-defuser': 'prevent-setTimeout',

  nosiif: 'prevent-setInterval',
  'no-setinterval-if': 'prevent-setInterval',
  'prevent-setinterval': 'prevent-setInterval',
  'setinterval-defuser': 'prevent-setInterval'
}

/** Canonical names the runtime implements, for tests and for the diagnostics. */
export const IMPLEMENTED_SCRIPTLETS: readonly string[] = [
  ...new Set(Object.values(SCRIPTLET_ALIASES))
]

/**
 * The library name for a list's spelling, or `null` when this browser has no implementation.
 *
 * `null` is a refusal rather than a fallback, and the diagnostics record it as
 * `scriptlet-unimplemented:<name>` — with the name, so the counter answers *which* scriptlet is
 * missing. A near-miss substitution would be worse than nothing: these change what a page's own script
 * observes, and running approximately the wrong one breaks pages in ways nobody can trace back to a
 * filter list.
 */
export function canonicalScriptletName(name: string): string | null {
  const key = name.trim().toLowerCase().replace(/\.js$/, '')
  return SCRIPTLET_ALIASES[key] ?? null
}

/**
 * Arguments out of a scriptlet's parameter text.
 *
 * Commas separate, `\,` is a literal comma, and a surrounding pair of matching quotes is stripped —
 * lists use quoting to pass an argument that contains a comma or leading space, and `set-constant`'s
 * value argument is where that turns up.
 *
 * Empty arguments are preserved rather than dropped: `+js(set-constant, foo, '')` means "set it to the
 * empty string", which is a different instruction from "set it to nothing".
 */
export function parseScriptletArgs(text: string): string[] {
  const args: string[] = []
  let current = ''
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (character === '\\' && index + 1 < text.length) {
      // Only a comma is escapable here; anything else keeps its backslash, because a scriptlet
      // argument is frequently a regular expression source and `\d` must survive.
      const next = text[index + 1]!
      if (next === ',') {
        current += ','
        index += 1
        continue
      }
      current += character
      continue
    }
    if (character === ',') {
      args.push(unquote(current))
      current = ''
      continue
    }
    current += character
  }
  args.push(unquote(current))
  return args
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]!
  const last = trimmed[trimmed.length - 1]!
  if ((first === "'" || first === '"') && first === last) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * A `+js(…)` payload as a call, or `null` for anything that is not one.
 *
 * `null` covers three different situations and the caller distinguishes them by asking again — a
 * payload that is not a scriptlet at all (so it is a selector), an unclosed `+js(`, and a scriptlet
 * whose name this browser does not implement. `parse.ts` needs the distinction to count the third with
 * its name, and `scriptletPayload` below is what lets it.
 */
export function scriptletPayload(payload: string): string | null {
  const text = payload.trim()
  if (!text.startsWith('+js(')) return null
  if (!text.endsWith(')')) return null
  return text.slice('+js('.length, -1)
}

/**
 * The call a payload asks for, plus the raw name when there is no implementation.
 *
 * One return shape rather than two functions, so a caller cannot check the name and then forget to
 * report it.
 */
export type ScriptletLookup =
  | { readonly kind: 'call'; readonly call: ScriptletCall }
  /** Recognised as a scriptlet, but not one this browser has. `name` is what the list asked for. */
  | { readonly kind: 'unimplemented'; readonly name: string }
  /** Not a scriptlet payload at all. */
  | { readonly kind: 'none' }

export function lookupScriptlet(payload: string): ScriptletLookup {
  const inner = scriptletPayload(payload)
  if (inner === null) return { kind: 'none' }

  const args = parseScriptletArgs(inner)
  const rawName = args[0] ?? ''
  if (rawName === '') return { kind: 'unimplemented', name: '' }

  const name = canonicalScriptletName(rawName)
  if (name === null) return { kind: 'unimplemented', name: rawName.toLowerCase() }
  return { kind: 'call', call: { name, args: args.slice(1) } }
}

// --- which scriptlets run on which host -------------------------------------

/**
 * A call as one comparable string.
 *
 * Needed twice: to drop the duplicate a second list produces for the same site, and to decide what a
 * `#@#+js(…)` exception cancels. A separator that cannot occur in a filter line, so two different calls
 * can never collide into one signature — `name` plus a tab-joined argument list would be ambiguous the
 * moment an argument contained a tab.
 */
export function scriptletSignature(call: ScriptletCall): string {
  return [call.name, ...call.args].join(' ')
}

export interface ScriptletIndex {
  /** Host or parent domain -> the rules scoped to it. */
  readonly byHost: ReadonlyMap<string, readonly ScriptletRule[]>
  /** Rules naming no host, so they apply everywhere. */
  readonly global: readonly ScriptletRule[]
  /** Host -> signatures cancelled there. A bare name cancels every call of it; see `scriptletsFor`. */
  readonly exceptionsByHost: ReadonlyMap<string, ReadonlySet<string>>
  readonly globalExceptions: ReadonlySet<string>
  readonly ruleCount: number
}

export const EMPTY_SCRIPTLET_INDEX: ScriptletIndex = {
  byHost: new Map(),
  global: [],
  exceptionsByHost: new Map(),
  globalExceptions: new Set(),
  ruleCount: 0
}

export function buildScriptletIndex(rules: readonly ScriptletRule[]): ScriptletIndex {
  const byHost = new Map<string, ScriptletRule[]>()
  const global: ScriptletRule[] = []
  const exceptionsByHost = new Map<string, Set<string>>()
  const globalExceptions = new Set<string>()

  for (const rule of rules) {
    if (rule.isException) {
      const signature = scriptletSignature(rule.call)
      if (rule.includeHosts.length === 0) {
        globalExceptions.add(signature)
        continue
      }
      for (const host of rule.includeHosts) {
        const existing = exceptionsByHost.get(host)
        if (existing === undefined) exceptionsByHost.set(host, new Set([signature]))
        else existing.add(signature)
      }
      continue
    }

    if (rule.includeHosts.length === 0) {
      global.push(rule)
      continue
    }
    for (const host of rule.includeHosts) {
      const existing = byHost.get(host)
      if (existing === undefined) byHost.set(host, [rule])
      else existing.push(rule)
    }
  }

  return {
    byHost,
    global,
    exceptionsByHost,
    globalExceptions,
    ruleCount: rules.length
  }
}

/** Whole-label host matching, as `hostMatchesRule` does it, without importing the URL module. */
function hostCovers(host: string, pattern: string): boolean {
  if (pattern === '') return false
  return host === pattern || host.endsWith(`.${pattern}`)
}

/**
 * The scriptlets to run on this host, deduplicated, with exceptions applied.
 *
 * ## Two shapes of exception
 *
 * A `#@#+js(set-constant, foo, true)` exception cancels exactly that call — same name, same arguments.
 * A `#@#+js(set-constant)` exception, with no arguments, cancels **every** call of that scriptlet on the
 * host. uBlock Origin compares the token text, which makes the second form match nothing; that reading is
 * rejected here because the bare form is what a list author writes to withdraw a scriptlet from a site it
 * breaks, and honouring only the exact form would leave this browser running something the list itself had
 * taken back. The broader reading errs towards running *less* code in a page, which is the right direction
 * for the one feature here that executes anything.
 *
 * ## Why the global rules come last
 *
 * Order decides nothing about behaviour — each call is independent — but it decides which duplicate
 * survives, and a host-scoped rule is the more specific statement about this site.
 */
export function scriptletsFor(index: ScriptletIndex, hostname: string): ScriptletCall[] {
  const host = hostname.toLowerCase()
  if (host === '') return []

  const chain: string[] = [host]
  const labels = host.split('.')
  for (let start = 1; start <= labels.length - 2; start++) chain.push(labels.slice(start).join('.'))

  const cancelled = new Set(index.globalExceptions)
  for (const scope of chain) {
    for (const signature of index.exceptionsByHost.get(scope) ?? []) cancelled.add(signature)
  }

  const calls: ScriptletCall[] = []
  const seen = new Set<string>()

  const consider = (rule: ScriptletRule): void => {
    if (rule.excludeHosts.some((excluded) => hostCovers(host, excluded))) return
    const signature = scriptletSignature(rule.call)
    // The bare-name form, which cancels every call of this scriptlet here.
    if (cancelled.has(signature) || cancelled.has(rule.call.name)) return
    if (seen.has(signature)) return
    seen.add(signature)
    calls.push(rule.call)
  }

  for (const scope of chain) {
    for (const rule of index.byHost.get(scope) ?? []) consider(rule)
  }
  for (const rule of index.global) consider(rule)

  return calls
}
