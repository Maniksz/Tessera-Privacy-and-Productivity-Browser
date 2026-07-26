import { internalUrl } from '../product.js'
import { registrableDomain, registrableDomainOfUrl } from '../url/domain.js'

/**
 * The favicon cache — what the tab strip and the start page draw their icons from.
 *
 * ## Why the cache exists at all
 *
 * Spec 1 forbids asking a third-party service for an icon on every visit, which rules
 * out the `s2/favicons`-style endpoint every other browser's start page quietly uses:
 * that endpoint receives one request per site the user cares about, which is a list of
 * favourites handed to a stranger. The alternative is to take the icon from the site
 * the user is already talking to, exactly once, and keep it.
 *
 * Everything here is pure. The store in `src/main/data/FaviconStore.ts` supplies the
 * clock, the network and the disk; these functions decide what is acceptable.
 *
 * ## Why this file has no zod import
 *
 * The start page and the chrome UI are renderers, and a value import here lands in a
 * bundle the user waits for. The persistence schema therefore lives with the store,
 * and an architecture test keeps it that way. Same division as
 * `@shared/history/model.ts`.
 */

// --- what may be stored ------------------------------------------------------

/**
 * Image formats the cache accepts, and the only `Content-Type` values it ever serves.
 *
 * Raster only, and `image/svg+xml` is deliberately absent. An SVG is a document, not a
 * picture: it may carry script, reference external resources and pull in fonts. Drawing
 * a site-supplied SVG inside the browser's own interface would reintroduce precisely
 * the third-party requests this cache exists to prevent — with the icon rendered in a
 * more trusted context than the page it came from. Losing the handful of sites that
 * offer only an SVG icon is the cheaper mistake.
 *
 * `image/x-icon` is the spelling used for stored ICO data. Servers also send
 * `image/vnd.microsoft.icon`, `application/octet-stream` or nothing at all for the same
 * bytes, which is why the declared type never decides what is stored — `sniffFaviconType`
 * does.
 */
export const FAVICON_CONTENT_TYPES = [
  'image/png',
  'image/x-icon',
  'image/gif',
  'image/jpeg',
  'image/webp'
] as const

export type FaviconContentType = (typeof FAVICON_CONTENT_TYPES)[number]

/**
 * Largest icon accepted, in bytes.
 *
 * 64 KiB holds a 192×192 PNG with room to spare and a multi-resolution ICO carrying
 * 16/32/48 px images. What it rejects is the "icon" that is really a hero image or a
 * mis-configured redirect to a page: those cost far more than the icon is worth, and
 * the cache keeps one file per site, so this number is also what bounds the directory —
 * at the entry cap below, a few tens of megabytes in a place the platform treats as
 * discardable.
 */
export const MAX_FAVICON_BYTES = 65_536

/**
 * Sites kept at most, least recently retrieved evicted first.
 *
 * A thousand distinct sites is far beyond what a person has in rotation, and the number
 * bounds two costs at once: the directory on disk, and the index document — which is
 * rewritten whole on every stored icon, so a large one would mean rewriting hundreds of
 * kilobytes to record one 3 KB image. Eviction costs a single request to a site the
 * user is visiting anyway.
 */
export const MAX_FAVICON_ENTRIES = 1_000

/**
 * How long a stored icon is considered current: 30 days.
 *
 * The two costs are asymmetric. Being stale means showing yesterday's logo after a
 * rebrand — visible, harmless, self-correcting. Refreshing means one request, to a site
 * the user has just opened anyway, so it reveals nothing that the navigation did not.
 * A month picks up a rebrand quickly enough that nobody files a bug, while a site
 * visited daily is asked about its icon roughly twelve times a year rather than
 * hundreds.
 *
 * Expiry never *removes* anything: see `faviconIsStale`, and the `kept` outcome for
 * what happens when the refresh fails.
 */
export const FAVICON_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Longest registrable domain used as a key.
 *
 * The DNS limit, applied here because the domain becomes a file name: a hostname longer
 * than any resolver would accept must not be able to produce a path an operating system
 * refuses, which would turn a strange address into a failed write.
 */
export const MAX_FAVICON_DOMAIN_LENGTH = 253

/**
 * Longest candidate address followed.
 *
 * The same limit history uses for the same reason — beyond it servers and other
 * browsers stop agreeing — and it is what keeps a page from putting an unbounded string
 * into the index by declaring an absurd icon URL.
 */
export const MAX_FAVICON_SOURCE_URL_LENGTH = 2048

/** One site's icon. `domain` is the identity; the file name is derived from it. */
export interface FaviconEntry {
  /** Registrable domain, so `www.` and `blog.` share one icon. */
  domain: string
  /** Sniffed from the bytes, never taken from the response header. */
  contentType: FaviconContentType
  byteLength: number
  /** When the bytes were retrieved. Drives both expiry and the address's version. */
  fetchedAt: number
  /** The page-declared address the bytes came from, for diagnostics. */
  sourceUrl: string
}

export interface FaviconIndex {
  version: 1
  /** Most recently retrieved first; storage order is what eviction reads. */
  icons: FaviconEntry[]
}

export function emptyFaviconIndex(): FaviconIndex {
  return { version: 1, icons: [] }
}

// --- outcomes ----------------------------------------------------------------

/**
 * Why nothing new was stored.
 *
 * Every one of these is counted rather than swallowed: an icon that never appears is
 * otherwise indistinguishable from a site that has none, and "favicons do not work" is
 * not a diagnosis anybody can act on. The counters are the difference between that and
 * "eleven refused for content type, three too large".
 */
export const FAVICON_REJECTIONS = [
  /** The page has no site to key an icon on — a `file:` document, an internal page. */
  'not-a-site',
  /** The page declared no icon this cache is willing to follow. */
  'no-candidate',
  /** Retrieval already failed for this site in this session. */
  'already-tried',
  'network-error',
  'http-error',
  'unsupported-type',
  'too-large',
  'write-failed',
  /**
   * A private window asked. Counted nowhere, by construction: the cache a private
   * window holds has no reference to any store to count into. See
   * `discardingFaviconCache`.
   */
  'private-mode'
] as const

export type FaviconRejection = (typeof FAVICON_REJECTIONS)[number]

/**
 * What an `ensure` call did.
 *
 * `kept` is the interesting one. A refresh that fails leaves the previous copy in place
 * and says so, because the alternative — dropping it because a server was briefly
 * unreachable — replaces a slightly old icon with no icon at all.
 */
export type FaviconOutcome =
  | { kind: 'cached'; entry: FaviconEntry }
  | { kind: 'stored'; entry: FaviconEntry }
  | { kind: 'kept'; entry: FaviconEntry; reason: FaviconRejection }
  | { kind: 'rejected'; reason: FaviconRejection }

/**
 * The write side of the cache, and the only one a caller is ever handed.
 *
 * A private window is given `discardingFaviconCache` instead of one bound to the store,
 * so "leave no trace" is a property of the object rather than a check every call site
 * has to remember. See `FaviconStore.cacheFor`.
 */
export interface FaviconCache {
  /**
   * Makes sure a local icon for `pageUrl` exists, retrieving it at most once.
   *
   * `candidateUrls` is what the page declared — Chromium's `page-favicon-updated`
   * hands over the whole list, and `chooseFaviconCandidate` decides which one is
   * followed.
   */
  ensure(pageUrl: string, candidateUrls: readonly string[]): Promise<FaviconOutcome>
}

/**
 * The cache a private window gets: it holds no store, no directory and no fetcher.
 *
 * Forgetting a `privateMode` check cannot leak an icon here, because there is nothing
 * for it to leak into and nothing to make a request with.
 */
export const discardingFaviconCache: FaviconCache = {
  ensure: (_pageUrl: string, _candidateUrls: readonly string[]) =>
    Promise.resolve<FaviconOutcome>({ kind: 'rejected', reason: 'private-mode' })
}

export interface FaviconCounts {
  /** Requests actually sent to a site. The number spec 1 is about. */
  requests: number
  stored: number
  /** Answered from the cache, without a request. */
  reused: number
  /** Refreshes that failed and left the previous copy standing. */
  kept: number
  rejected: Record<FaviconRejection, number>
}

export function emptyFaviconCounts(): FaviconCounts {
  const rejected = Object.fromEntries(FAVICON_REJECTIONS.map((reason) => [reason, 0]))
  return {
    requests: 0,
    stored: 0,
    reused: 0,
    kept: 0,
    rejected: rejected as Record<FaviconRejection, number>
  }
}

// --- keys and addresses ------------------------------------------------------

/** Page schemes worth an icon. Everything else has no site, or is ours already. */
const ICONABLE_PAGE_SCHEMES: readonly string[] = ['http:', 'https:']

/**
 * The cache key for a page, or `null` when it has none.
 *
 * Keyed on the registrable domain rather than the address: a site's icon belongs to the
 * site, and keying per URL would store one copy per article and ask the server again for
 * every subpage — the very traffic the cache is meant to remove.
 */
export function faviconDomainOf(pageUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(pageUrl)
  } catch {
    return null
  }
  if (!ICONABLE_PAGE_SCHEMES.includes(parsed.protocol)) return null
  const domain = registrableDomain(parsed.hostname)
  return domain.length > MAX_FAVICON_DOMAIN_LENGTH ? null : domain
}

/**
 * The cache key for a lookup, which may arrive as an address or as a bare domain.
 *
 * Both callers exist: the tab strip has a URL, the protocol handler has whatever was in
 * the query string. Nothing derived from this is ever joined into a path — the key is
 * only ever compared against the index — so a crafted value finds nothing rather than
 * finding a file elsewhere on the disk.
 */
export function faviconDomainKey(domainOrUrl: string): string | null {
  const fromUrl = registrableDomainOfUrl(domainOrUrl)
  if (fromUrl !== null) return fromUrl
  const bare = registrableDomain(domainOrUrl)
  return bare === '' ? null : bare
}

/*
  The cache file name is deliberately *not* derived here.

  It moved to `main/data/FaviconStore.ts` for a reason worth stating: this file used to name each
  icon after its site, so `example.com.icon` sat in the directory. The index is encrypted; file
  names are not — so a directory listing was a reading list, readable without any key at all. In a
  browser whose whole point is that local data stays private, that undid a good part of the work.

  The name is now a hash of the domain, which needs `node:crypto`, and `shared` must stay free of
  Node built-ins because a renderer imports this module. The renderer never needs the name anyway:
  it builds `tessera://favicon?site=…` from `faviconUrl`, and the core resolves that to a path.
*/

/** Internal page the cached bytes are served from. */
export const FAVICON_PAGE = 'favicon'
/** Query parameter naming the site. */
export const FAVICON_SITE_PARAM = 'site'
/** Query parameter carrying the retrieval time, so a refreshed icon is a new address. */
export const FAVICON_VERSION_PARAM = 'v'

/**
 * The address a renderer puts in an `<img>`.
 *
 * Built from the entry rather than from the domain alone, because the version parameter
 * matters: the file name is stable per site, so without it a refreshed icon would keep
 * the address it already had and Chromium would go on drawing the copy in its memory
 * cache. The handler ignores the parameter; its only job is to change.
 */
export function faviconUrl(entry: Pick<FaviconEntry, 'domain' | 'fetchedAt'>): string {
  return internalUrl(FAVICON_PAGE, {
    [FAVICON_SITE_PARAM]: entry.domain,
    [FAVICON_VERSION_PARAM]: entry.fetchedAt.toString(36)
  })
}

/**
 * The site an icon address asks for, or `null`.
 *
 * The counterpart of `faviconUrl`, for the protocol handler. It normalises through
 * `faviconDomainKey`, so what comes back is a key to look up and never a path fragment.
 */
export function faviconSiteOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const site = parsed.searchParams.get(FAVICON_SITE_PARAM)
  if (site === null) return null
  return faviconDomainKey(site)
}

// --- choosing which candidate to follow --------------------------------------

/** Schemes a candidate may use. */
const FETCHABLE_ICON_SCHEMES: readonly string[] = ['http:', 'https:']

/**
 * Assumed size of a candidate that advertises none, typically `/favicon.ico`.
 *
 * Not zero, on purpose. A bare `favicon.ico` is usually a multi-resolution file holding
 * 32 and 48 px images, so it is a better source for a start-page card than a link that
 * explicitly says `16x16`. Treating "unknown" as the smallest would pick the 16 px one.
 */
const ASSUMED_ICON_SIZE = 32

/** Apple's touch icon is 180×180 when the address does not say so. */
const APPLE_TOUCH_ICON_SIZE = 180

/**
 * Above this, an icon is more download than it is worth.
 *
 * Consumers draw at 16 px in the tab strip and around 48 px on a start-page card, so
 * anything past a couple of hundred pixels is downscaled immediately — and, worse, a
 * 512 px PNG is exactly the candidate most likely to exceed `MAX_FAVICON_BYTES` and be
 * refused. Since a site is asked once, spending that request on a candidate that will
 * be thrown away is the mistake this bound prevents.
 */
const MAX_USEFUL_ICON_SIZE = 256

const SIZE_PAIR = /(\d{2,4})x(\d{2,4})/
const SIZE_SUFFIX = /[-_](\d{2,4})\.(?:png|ico|jpe?g|gif|webp)(?:$|[?#])/

/**
 * The pixel size an address advertises, or 0 when it says nothing.
 *
 * Read from the address because that is all there is: nothing here knows the real
 * dimensions without downloading the file, and the point is to choose *before*
 * downloading. `sizes="32x32"` on the link element would be better evidence, but
 * Chromium's `page-favicon-updated` hands over bare URLs.
 */
export function advertisedIconSize(url: string): number {
  const text = url.toLowerCase()
  const pair = SIZE_PAIR.exec(text)
  if (pair !== null) return Number(pair[1])
  const suffix = SIZE_SUFFIX.exec(text)
  if (suffix !== null) return Number(suffix[1])
  if (text.includes('apple-touch-icon')) return APPLE_TOUCH_ICON_SIZE
  return 0
}

/**
 * How much a candidate is worth. Larger wins.
 *
 * Oversized candidates get a negative rank, ordered so that a 512 px icon still beats a
 * 1024 px one: they lose to every usable candidate but remain preferable to giving up.
 */
export function iconCandidateRank(url: string): number {
  const advertised = advertisedIconSize(url)
  const size = advertised === 0 ? ASSUMED_ICON_SIZE : advertised
  return size > MAX_USEFUL_ICON_SIZE ? MAX_USEFUL_ICON_SIZE - size : size
}

function isFollowableCandidate(url: string): boolean {
  if (url.length > MAX_FAVICON_SOURCE_URL_LENGTH) return false
  try {
    return FETCHABLE_ICON_SCHEMES.includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * The one candidate that gets followed, or `null` when none may be.
 *
 * `data:` and `blob:` candidates are dropped rather than decoded. They cost no request,
 * so allowing them looks free — but it means a second path into the cache with its own
 * decoding, its own size accounting and its own way to be wrong about what the bytes
 * are, to serve the small minority of sites that inline their icon. The site is being
 * asked anyway.
 *
 * Ties keep the earliest candidate, which is the page's own declared order.
 */
export function chooseFaviconCandidate(candidateUrls: readonly string[]): string | null {
  return candidateUrls
    .filter(isFollowableCandidate)
    .reduce<string | null>(
      (best, url) =>
        best === null || iconCandidateRank(url) > iconCandidateRank(best) ? url : best,
      null
    )
}

// --- judging the response ----------------------------------------------------

/**
 * Whether a declared type is worth reading a body for.
 *
 * Cheap first pass, and not the decision: a soft 404 answering with `text/html` is by
 * far the most common non-image response, and refusing it here avoids reading the page
 * at all. An absent or empty header is *accepted*, because plenty of servers send no
 * type for `.ico` files and the bytes are checked either way — refusing on a header
 * nobody guarantees would drop real icons.
 */
export function looksLikeImageType(declaredType: string | null): boolean {
  if (declaredType === null) return true
  const type = declaredType
    .split(';')
    .slice(0, 1)
    .map((part) => part.trim().toLowerCase())
    .join('')
  return type === '' || type.startsWith('image/')
}

/**
 * The length a response claims, or `null` when it claims nothing usable.
 *
 * Used to refuse an oversized body before reading it. The claim is never trusted as a
 * fact — the bytes are measured too — so a missing or nonsensical header only costs the
 * early exit.
 */
export function declaredLengthOf(header: string | null): number | null {
  if (header === null) return null
  const value = Number(header.trim())
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** "GIF8", covering both 87a and 89a. */
const GIF_SIGNATURE: readonly number[] = [0x47, 0x49, 0x46, 0x38]
const JPEG_SIGNATURE: readonly number[] = [0xff, 0xd8, 0xff]
const RIFF_SIGNATURE: readonly number[] = [0x52, 0x49, 0x46, 0x46]
/** "WEBP", at offset 8 inside a RIFF container. */
const WEBP_TAG: readonly number[] = [0x57, 0x45, 0x42, 0x50]
/** Type 1 is an icon; type 2 is a cursor and is not one. */
const ICO_SIGNATURE: readonly number[] = [0x00, 0x00, 0x01, 0x00]

/**
 * Reads past the end as "no match" rather than guarding the length separately, which
 * keeps a short or empty body on the same path as a wrong one.
 */
function beginsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  return signature.every((byte, index) => bytes[at + index] === byte)
}

/**
 * What the bytes actually are, or `null` when they are nothing this cache accepts.
 *
 * This, and not the `Content-Type` header, is what decides. An image arriving from a
 * visited site is untrusted input: the header is whatever the server felt like saying,
 * and a mismatch between it and the content is either a mis-configured server or an
 * attempt to have the browser's own interface render something unexpected. Sniffing
 * answers both at once and is the reason `image/svg+xml` cannot slip through — an SVG
 * has no signature to match.
 */
export function sniffFaviconType(bytes: Uint8Array): FaviconContentType | null {
  if (beginsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  if (beginsWith(bytes, GIF_SIGNATURE)) return 'image/gif'
  if (beginsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg'
  if (beginsWith(bytes, RIFF_SIGNATURE) && beginsWith(bytes, WEBP_TAG, 8)) return 'image/webp'
  if (beginsWith(bytes, ICO_SIGNATURE)) return 'image/x-icon'
  return null
}

// --- aging and bookkeeping ---------------------------------------------------

/**
 * Whether an entry should be refreshed on the next visit.
 *
 * A timestamp in the future counts as stale too. That is not paranoia about clocks for
 * its own sake: a profile copied between machines, a laptop resumed after a suspend or
 * an NTP correction all produce one, and the alternative reading — "fresh for the next
 * thirty days plus however far the clock jumped" — could pin a wrong icon in place
 * indefinitely.
 */
export function faviconIsStale(
  entry: Pick<FaviconEntry, 'fetchedAt'>,
  now: number,
  maxAgeMs: number = FAVICON_MAX_AGE_MS
): boolean {
  if (entry.fetchedAt > now) return true
  return now - entry.fetchedAt >= maxAgeMs
}

function byRetrievalRecency(left: FaviconEntry, right: FaviconEntry): number {
  return right.fetchedAt - left.fetchedAt
}

export interface FaviconIndexChange {
  icons: FaviconEntry[]
  /** Entries pushed out by the cap. Their files are the store's to remove. */
  evicted: FaviconEntry[]
}

/**
 * Adds or replaces one site's entry and reports what the cap pushed out.
 *
 * The evicted entries come back rather than being dropped silently, because each one
 * has a file behind it: a pure function cannot delete it, and an index that forgets an
 * entry existed would leave the file behind forever.
 */
export function putFaviconEntry(
  icons: readonly FaviconEntry[],
  entry: FaviconEntry,
  limit: number = MAX_FAVICON_ENTRIES
): FaviconIndexChange {
  const others = icons.filter((icon) => icon.domain !== entry.domain)
  const merged = [entry, ...others].sort(byRetrievalRecency)
  return { icons: merged.slice(0, limit), evicted: merged.slice(limit) }
}

/** One site's entry, or `null`. Accepts an address or a bare domain. */
export function findFaviconEntry(
  icons: readonly FaviconEntry[],
  domainOrUrl: string
): FaviconEntry | null {
  const domain = faviconDomainKey(domainOrUrl)
  if (domain === null) return null
  return icons.find((icon) => icon.domain === domain) ?? null
}

/**
 * Makes a loaded index obey what the write path maintains: one entry per site, most
 * recently retrieved first, no more than the cap.
 *
 * Duplicates keep the newer entry. Unlike history, where merging protects a visit count
 * a user would miss, nothing here is worth reconstructing — the older row describes
 * bytes the newer one has already overwritten in the same file.
 */
export function repairFaviconIndex(
  icons: readonly FaviconEntry[],
  limit: number = MAX_FAVICON_ENTRIES
): FaviconEntry[] {
  const byDomain = new Map<string, FaviconEntry>()
  for (const icon of icons) {
    const existing = byDomain.get(icon.domain)
    const winner = existing !== undefined && existing.fetchedAt > icon.fetchedAt ? existing : icon
    byDomain.set(icon.domain, winner)
  }
  return [...byDomain.values()].sort(byRetrievalRecency).slice(0, limit)
}
