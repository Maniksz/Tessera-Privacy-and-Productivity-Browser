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
 * things most visibly; `configurePublicSuffixes` exists so the real list can be
 * loaded at startup and kept up to date without touching this logic.
 */

/**
 * Multi-label public suffixes. Single-label suffixes (`com`, `de`, …) need no
 * entry: they are the default assumption.
 */
const BOOTSTRAP_SUFFIXES: readonly string[] = [
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

let publicSuffixes: ReadonlySet<string> = new Set(BOOTSTRAP_SUFFIXES)

/**
 * Replaces the suffix set, e.g. with a freshly downloaded Public Suffix List.
 * Entries are expected lower-case and without a leading dot.
 */
export function configurePublicSuffixes(suffixes: Iterable<string>): void {
  publicSuffixes = new Set([...suffixes].map((s) => s.toLowerCase().replace(/^\./, '')))
}

export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
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
  const normalized = normalizeHost(host)
  if (normalized === '' || isIpAddress(normalized) || normalized === 'localhost') return normalized

  const labels = normalized.split('.')
  if (labels.length < 2) return normalized

  // Longest matching public suffix wins, so `co.uk` beats `uk`.
  for (let start = 0; start < labels.length - 1; start++) {
    const candidate = labels.slice(start).join('.')
    if (publicSuffixes.has(candidate)) {
      // Need one label in front of the suffix to have a registrable domain.
      return start === 0 ? normalized : labels.slice(start - 1).join('.')
    }
  }

  return labels.slice(-2).join('.')
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
