import { INTERNAL_SCHEME, internalUrl } from '../product.js'
/**
 * Address-bar input classification (spec 1).
 *
 * Lives in `shared` and is pure so that the rule exists exactly once: the
 * omnibox preview ("Search with DuckDuckGo" versus "Open example.com") and the
 * actual navigation must never reach different conclusions about the same text.
 */

export const SEARCH_ENGINES = {
  duckduckgo: { label: 'DuckDuckGo', searchUrl: 'https://duckduckgo.com/?q={query}' },
  startpage: { label: 'Startpage', searchUrl: 'https://www.startpage.com/sp/search?query={query}' },
  brave: { label: 'Brave Search', searchUrl: 'https://search.brave.com/search?q={query}' },
  mojeek: { label: 'Mojeek', searchUrl: 'https://www.mojeek.com/search?q={query}' },
  custom: { label: 'Custom', searchUrl: '' }
} as const

export type SearchEngineId = keyof typeof SEARCH_ENGINES

/** Schemes we are willing to navigate to from the address bar. */
const NAVIGABLE_SCHEMES = new Set([
  'http:',
  'https:',
  'file:',
  'about:',
  INTERNAL_SCHEME,
  'view-source:'
])

/**
 * Schemes that must never come from typed input, because they either execute
 * script in the current origin or bypass the network stack entirely.
 */
const REJECTED_SCHEMES = new Set(['javascript:', 'data:', 'blob:', 'vbscript:'])

export type OmniboxIntent =
  | { kind: 'url'; url: string }
  | { kind: 'search'; query: string }
  | { kind: 'empty' }

const HOST_LIKE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const TRAILING_TLD = /\.[a-z]{2,}$/i

function isIpv4(host: string): boolean {
  if (!IPV4.test(host)) return false
  return host.split('.').every((part) => Number(part) <= 255)
}

/**
 * Pulls the host out of raw input, before any URL parsing touches it.
 *
 * This has to work on the original text. `new URL('https://3.14').hostname`
 * returns `0.0.3.14`, because the WHATWG parser reads dotted numbers as an
 * IPv4 shorthand — so a decimal number would look like a valid address and get
 * sent to a DNS resolver. Same for `192.168.1`, which becomes `192.168.0.1`.
 * Deciding address-versus-search on the parsed hostname means deciding on a
 * value the parser invented.
 */
function rawHostOf(input: string): string {
  const authority = input.split(/[/?#]/, 1)[0] ?? ''
  // Drop any userinfo, which may itself contain '@' and ':'.
  const afterUserinfo = authority.slice(authority.lastIndexOf('@') + 1)

  if (afterUserinfo.startsWith('[')) {
    const end = afterUserinfo.indexOf(']')
    return end === -1 ? afterUserinfo : afterUserinfo.slice(0, end + 1)
  }

  // Strip a trailing port only when it really is one; `example.com:abc` keeps
  // the suffix so it fails host validation instead of quietly resolving.
  const colon = afterUserinfo.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(afterUserinfo.slice(colon + 1))) {
    return afterUserinfo.slice(0, colon)
  }
  return afterUserinfo
}

/**
 * Decides whether typed text is an address or a search term.
 *
 * The bias is towards searching: guessing "address" wrongly sends the user's
 * text to a DNS resolver, which leaks it. Guessing "search" wrongly costs one
 * extra keystroke.
 */
export function classifyOmniboxInput(raw: string): OmniboxIntent {
  const input = raw.trim()
  if (input === '') return { kind: 'empty' }

  // Explicit search prefix, so a user can search for something that looks like
  // a host name.
  if (input.startsWith('?')) {
    const query = input.slice(1).trim()
    return query === '' ? { kind: 'empty' } : { kind: 'search', query }
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(input)
  // `localhost:5173` matches the scheme pattern but is a host and a port. Treat
  // a prefix as a scheme only when we recognise it, or when `//` follows — the
  // alternative is refusing to open every `host:port` a developer types.
  const looksLikeScheme =
    schemeMatch !== null &&
    (NAVIGABLE_SCHEMES.has(`${schemeMatch[1]!.toLowerCase()}:`) ||
      REJECTED_SCHEMES.has(`${schemeMatch[1]!.toLowerCase()}:`) ||
      input.slice(schemeMatch[0].length).startsWith('//'))

  if (schemeMatch && looksLikeScheme) {
    const scheme = `${schemeMatch[1]!.toLowerCase()}:`
    if (REJECTED_SCHEMES.has(scheme)) return { kind: 'search', query: input }
    if (NAVIGABLE_SCHEMES.has(scheme)) {
      // `about:` and `tessera:` are opaque; hand them through untouched.
      if (scheme === 'about:' || scheme === INTERNAL_SCHEME) return { kind: 'url', url: input }
      try {
        return { kind: 'url', url: new URL(input).toString() }
      } catch {
        return { kind: 'search', query: input }
      }
    }
    // An unknown scheme is more likely a typo or a search than a protocol we
    // should hand to the OS.
    return { kind: 'search', query: input }
  }

  // Anything with whitespace is a search: no valid bare host contains a space.
  if (/\s/.test(input)) return { kind: 'search', query: input }

  const withScheme = `https://${input}`
  // Final validity gate, but the *decision* below is made on the raw host.
  try {
    new URL(withScheme)
  } catch {
    return { kind: 'search', query: input }
  }

  const host = rawHostOf(input).toLowerCase()
  if (host === '') return { kind: 'search', query: input }

  // localhost and bare IPs are addresses even without a dotted TLD.
  if (host === 'localhost' || host.endsWith('.localhost')) return { kind: 'url', url: withScheme }
  if (host.startsWith('[') && host.endsWith(']')) return { kind: 'url', url: withScheme }
  if (isIpv4(host)) return { kind: 'url', url: withScheme }

  // A single label with no dot ("news", "settings") is a search term, not a
  // host — intranet single-label hosts are handled by the explicit `http://`
  // form instead of guessed at.
  if (!host.includes('.')) return { kind: 'search', query: input }

  // Requires a plausible alphabetic TLD, so "3.14" and "192.168.1" stay
  // searches rather than becoming DNS lookups.
  if (!HOST_LIKE.test(host) || !TRAILING_TLD.test(host)) {
    return { kind: 'search', query: input }
  }

  return { kind: 'url', url: withScheme }
}

/**
 * The address of the start page, which doubles as the new-tab page.
 *
 * Exported because three layers need to agree on it: the core decides what a new
 * tab loads, the address bar decides when to show nothing, and a Home button
 * navigates to it.
 */
export const HOME_URL = internalUrl('start')

/**
 * Addresses that are noise in the address bar rather than information.
 *
 * The start page is the new-tab page, and showing `tessera://start/` there tells
 * the user nothing while occupying the field they are about to type into. Other
 * internal pages keep their address — `tessera://history` is somewhere you can
 * navigate to and copy, so hiding it would be a loss.
 */
export function isHomeUrl(url: string): boolean {
  if (url === '' || url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== INTERNAL_SCHEME) return false
    // `tessera://start` and `tessera://start/` are the same page.
    return parsed.hostname === 'start' && (parsed.pathname === '' || parsed.pathname === '/')
  } catch {
    return false
  }
}

/**
 * What the address bar should display for a given page address.
 *
 * Returns an empty string for the home page so the field is ready to type in, and
 * the address itself for everything else.
 */
export function omniboxDisplayValue(url: string): string {
  return isHomeUrl(url) ? '' : url
}

export interface SearchConfig {
  engine: SearchEngineId
  /** Used when `engine` is `custom`; must contain `{query}`. */
  customUrl: string
}

export function buildSearchUrl(query: string, config: SearchConfig): string {
  const template =
    config.engine === 'custom' ? config.customUrl : SEARCH_ENGINES[config.engine].searchUrl
  const fallback = SEARCH_ENGINES.duckduckgo.searchUrl
  const chosen = template.includes('{query}') ? template : fallback
  return chosen.replace('{query}', encodeURIComponent(query))
}

/**
 * Turns raw address-bar text into the URL to navigate to. Returns `null` for
 * empty input so the caller can leave the current page alone.
 */
export function resolveOmniboxInput(raw: string, config: SearchConfig): string | null {
  const intent = classifyOmniboxInput(raw)
  switch (intent.kind) {
    case 'empty':
      return null
    case 'url':
      return intent.url
    case 'search':
      return buildSearchUrl(intent.query, config)
  }
}
