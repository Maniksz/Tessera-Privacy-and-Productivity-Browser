import {
  MAX_HISTORY_TITLE_LENGTH,
  MAX_HISTORY_URL_LENGTH,
  historyUrlOf
} from '../history/model.js'
import { internalUrl } from '../product.js'
import { registrableDomainOfUrl } from '../url/domain.js'

/**
 * Page thumbnails — the picture on a start-page card, so a card is recognisable
 * before it is read.
 *
 * ## Why a picture at all, and why a screenshot
 *
 * A card carrying only a favicon and a title is a list of look-alikes: six blue
 * squares that all have to be read. A picture of the page itself is recognised
 * rather than read, which is the whole reason for the feature. The favicon stays as
 * the fallback — it is cheap, already there, and always available — so the ordering
 * is: screenshot if we have one, icon if we do not, letter if neither.
 *
 * Note the vocabulary: what this decorates is a *card* (a Quick Link on the start
 * page), never a Tile. `CONCEPTS.md` reserves Tile for a split-view region, and the
 * two are unrelated.
 *
 * ## Why this is the most invasive thing in the data layer
 *
 * A favicon is a site's public logo. A thumbnail is a picture of the page as the
 * user saw it — a mailbox with subject lines, a bank page with a balance. Storing
 * that is only defensible with all four of these, and each has a mechanism rather
 * than a promise:
 *
 *   - never in a private window: `discardingThumbnailCapturer` holds no store, no
 *     directory and no capture provider, so a private window has nothing to write
 *     with (see `ThumbnailStore.capturerFor`)
 *   - only pages the user actually stopped at, once per freshness window, never a
 *     half-painted one (`THUMBNAIL_SETTLE_DELAY_MS`, `thumbnailIsStale`)
 *   - a hard cap with eviction, so the directory cannot grow into an archive
 *     (`MAX_THUMBNAIL_ENTRIES`)
 *   - removable: the files live in the discardable cache directory and go with the
 *     `cache` category of "clear data" (`ThumbnailStore.clear`)
 *
 * ## Accessibility is part of the feature, not a follow-up
 *
 * An image with no text alternative makes the card unusable with a screen reader,
 * and an image whose alternative repeats the address ("h-t-t-p-s-colon-slash…") is
 * worse than none. What a card needs is what the page *is*, which is why the page
 * title travels with the pixels — see `thumbnailAlternative`, which also refuses to
 * say the same thing twice when the card already shows a label. The image is
 * decoration on top of a label that is always rendered; it is never the only way to
 * tell one card from another.
 *
 * Everything here is pure. `src/main/data/ThumbnailStore.ts` supplies the clock, the
 * capture provider and the disk.
 *
 * ## Why this file has no zod import
 *
 * The start page is a renderer and imports this module, so a value import here would
 * land in a bundle the user waits for. The persistence schema therefore lives with
 * the store, and an architecture test keeps it that way — same division as
 * `@shared/favicons/model.ts`.
 */

// --- what gets stored --------------------------------------------------------

/**
 * The one format a capture is written in, and the type served for it.
 *
 * JPEG, because the choice is between JPEG and PNG and nothing else: the capture
 * arrives as a platform image that can encode those two, and adding a WebP encoder
 * would mean a dependency for a picture nobody looks at closely. A screenshot is
 * photographic — gradients, photos, antialiased text — so PNG would cost four to six
 * times the bytes for a difference invisible at this size. The known cost is ringing
 * around small text, which is acceptable for an image that exists to be recognised
 * rather than read.
 *
 * Recorded here as a constant rather than per entry: unlike the favicon cache, where
 * the format is whatever the site sent, every file here is written by us.
 */
export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg'

/**
 * The size a stored capture is scaled to, in device-independent pixels.
 *
 * A card is a couple of hundred pixels wide, so this is roughly double it: the
 * screenshot has to survive a HiDPI display, where a 240 px card is 480 real pixels,
 * and being downscaled by the browser costs nothing while being upscaled looks
 * broken. Anything beyond that is paid for on every capture and thrown away by the
 * renderer — a 4K capture is a hundred times this area.
 *
 * 16:10 rather than 16:9 because it is close to the proportions of the region being
 * captured, so the crop discards little, and a card can letterbox or cover-crop as
 * its layout needs.
 */
export const THUMBNAIL_TARGET: Readonly<ThumbnailSize> = { width: 480, height: 300 }

/**
 * JPEG quality for the stored image, and the second attempt for one that came out
 * too big.
 *
 * 70 is where a downscaled screenshot stops improving visibly while the file keeps
 * growing. The retry exists because the byte cap must hold without giving up on the
 * card: a busy, photographic page can exceed it at 70, and 40 at this size still
 * reads as the page rather than as mush. Two attempts, then the cap wins — there is
 * no loop that could spend a second of CPU searching for a quality that fits.
 */
export const THUMBNAIL_QUALITY = 70
export const THUMBNAIL_FALLBACK_QUALITY = 40

/**
 * Largest stored capture, in bytes.
 *
 * A 480×300 JPEG at quality 70 is typically 20–35 kB. The cap is set well above that
 * on purpose: on a HiDPI display the platform image keeps its scale factor, so the
 * same 480×300 logical picture is encoded from four times the pixels and lands in the
 * 60–80 kB range. A tighter cap would silently push every capture on every Mac
 * through the lower-quality retry.
 *
 * With the entry cap below, this is also what bounds the directory: at worst about
 * 19 MB, in practice a third of that, in a place the platform treats as discardable.
 */
export const MAX_THUMBNAIL_BYTES = 98_304

/**
 * Pages kept at most, least recently captured evicted first.
 *
 * Deliberately far smaller than the favicon cache's thousand. Two reasons, and the
 * first is not disk: every entry is a picture of a page somebody visited, so the cap
 * is the answer to "how much of my browsing is lying around" — and 200 covers the few
 * dozen cards a start page shows plus a wide margin for churn. The second is that the
 * index is rewritten whole on every capture, so a large one would mean rewriting
 * hundreds of kilobytes to record one 30 kB image.
 */
export const MAX_THUMBNAIL_ENTRIES = 200

/**
 * How long a stored capture is considered current: 7 days.
 *
 * The trade-off is the opposite way round from the favicon cache's thirty days. A
 * logo changes once in a rebrand; the top of a page changes with every headline, so a
 * month-old picture is the wrong page rather than a slightly old one. And refreshing
 * is nearly free — no request, no server, a few milliseconds of local work — so the
 * only real cost is rewriting the index, which a week's spacing keeps to once per
 * page per week however often it is visited.
 *
 * Expiry never *removes* anything: a stale entry is still shown (see
 * `thumbnailIsStale` and the `kept` outcome), because a week-old picture of the page
 * beats a blank card.
 */
export const THUMBNAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How long the wiring waits after a page reports itself finished before capturing.
 *
 * This is the answer to *when*, and it is the decision this feature turns on. The two
 * obvious triggers are both wrong. Capturing on every navigation spends work on pages
 * the user bounced straight out of and, worse, catches the page mid-paint: a
 * screenshot taken at `did-stop-loading` is routinely a white rectangle with a header,
 * because fonts, images and the first render of client-side markup all land after the
 * load event. Capturing rarely — on a timer, or at shutdown — means the card shows
 * last week's page or nothing at all for pages visited once.
 *
 * So: a page that has settled, plus a short delay, and at most once per freshness
 * window. 1.5 seconds is long enough for web fonts and the first paint of a
 * client-rendered page, and short enough that a normal read still reaches it before
 * the user navigates on. It is also the reason the delay lives with the *wiring*
 * rather than in this store: only the wiring knows about `did-start-navigation`, so
 * only the wiring can cancel a pending capture when the user leaves — and a capture
 * that fires after a navigation would file the new page's pixels under the old page's
 * address, which is the one mistake here that leaks something.
 *
 * `ThumbnailStore.settleDelayMs` hands this number out, overridable at `open`, so
 * there is one place to change it.
 */
export const THUMBNAIL_SETTLE_DELAY_MS = 1_500

/** Longest stored address. Inherited from history, because the key is history's. */
export const MAX_THUMBNAIL_URL_LENGTH = MAX_HISTORY_URL_LENGTH

/** Longest stored title; the same cap history applies, for the same reason. */
export const MAX_THUMBNAIL_TITLE_LENGTH = MAX_HISTORY_TITLE_LENGTH

export interface ThumbnailSize {
  width: number
  height: number
}

export interface ThumbnailRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * One page's stored capture.
 *
 * `url` is the identity; the file name is derived from it by the store and is
 * deliberately not recorded here. `width` and `height` are the stored pixels, so the
 * renderer can reserve the space before the image arrives — an `<img>` without them
 * makes the whole card grid jump when the picture loads, which is a layout bug and an
 * accessibility one at the same time.
 */
export interface ThumbnailEntry {
  /** Normalised by `thumbnailKeyOf`. */
  url: string
  /**
   * The page's title when the picture was taken, cleaned by `thumbnailTitleOf`.
   *
   * This is the text alternative's raw material, and it is the only reason the store
   * knows anything but pixels. Empty when the page reported no title. It adds no
   * exposure that is not already there: the history store keeps titles too, and this
   * index is written through the same codec.
   */
  title: string
  width: number
  height: number
  byteLength: number
  /** When the picture was taken. Drives both expiry and the address's version. */
  capturedAt: number
}

export interface ThumbnailIndex {
  version: 1
  /** Most recently captured first; storage order is what eviction reads. */
  shots: ThumbnailEntry[]
}

export function emptyThumbnailIndex(): ThumbnailIndex {
  return { version: 1, shots: [] }
}

// --- asking for a capture ----------------------------------------------------

/**
 * What the wiring knows when a page has settled.
 *
 * `viewId` is what makes the capture provider possible without this module knowing
 * anything about the browser engine: the store passes it straight back out to the
 * injected provider, which is the only party that can turn it into pixels. Nothing
 * here interprets it.
 */
export interface ThumbnailRequest {
  /** The page's address as navigated; normalised by the store. */
  url: string
  /** The page's current title, or `''` when it has none yet. */
  title: string
  /** Identifies the content view to photograph. Opaque to this module. */
  viewId: number
}

/**
 * Why nothing new was stored.
 *
 * Counted rather than swallowed, for the same reason the favicon cache counts its
 * refusals: a card that never gets a picture is otherwise indistinguishable from one
 * whose page is simply blank, and "thumbnails do not work" is not a diagnosis.
 */
export const THUMBNAIL_REJECTIONS = [
  /** No address worth a picture: an internal page, a `file:` document, `about:blank`. */
  'not-a-page',
  /** The provider could not photograph the view — it had already gone, or it threw. */
  'capture-failed',
  /** Nothing was on screen: an empty image, or one with no usable dimensions. */
  'blank',
  /** The pixels could not be scaled or encoded. */
  'encode-failed',
  /** Past `MAX_THUMBNAIL_BYTES` even at the lower quality. */
  'too-large',
  'write-failed',
  /**
   * "Clear data" ran while this capture was in flight, so its bytes were thrown away
   * instead of being recorded after the deletion.
   */
  'discarded',
  /**
   * A private window asked. Counted nowhere, by construction: the capturer a private
   * window holds has no store to count into. See `discardingThumbnailCapturer`.
   */
  'private-mode'
] as const

export type ThumbnailRejection = (typeof THUMBNAIL_REJECTIONS)[number]

/**
 * What a `capture` call did.
 *
 * `kept` is the one worth naming: a capture that fails leaves the previous picture in
 * place and says so. Dropping it would turn a page that happened to be closing into a
 * card that lost its picture, which is a visible regression for an invisible reason.
 */
export type ThumbnailOutcome =
  | { kind: 'stored'; entry: ThumbnailEntry }
  /** Something current already exists, so no picture was taken. */
  | { kind: 'fresh'; entry: ThumbnailEntry }
  | { kind: 'kept'; entry: ThumbnailEntry; reason: ThumbnailRejection }
  | { kind: 'rejected'; reason: ThumbnailRejection }

/**
 * The write side, and the only one a caller is ever handed.
 *
 * A private window gets `discardingThumbnailCapturer` instead of one bound to the
 * store, so "a private window leaves no picture behind" is a property of the object
 * rather than a check every call site has to remember. See
 * `ThumbnailStore.capturerFor`.
 */
export interface ThumbnailCapturer {
  /**
   * Whether taking a picture of this address would be worth anything.
   *
   * Exists so the wiring can decide not to *schedule* a capture at all — no timer, no
   * delayed work, no photograph of a page that already has a current one. False in a
   * private window, always.
   */
  shouldCapture(url: string): boolean
  capture(request: ThumbnailRequest): Promise<ThumbnailOutcome>
}

/**
 * The capturer a private window gets: no store, no directory, no provider.
 *
 * Forgetting a mode check cannot leak a picture here, because there is nothing to
 * leak into and nothing to take one with.
 */
export const discardingThumbnailCapturer: ThumbnailCapturer = {
  shouldCapture: (_url: string) => false,
  capture: (_request: ThumbnailRequest) =>
    Promise.resolve<ThumbnailOutcome>({ kind: 'rejected', reason: 'private-mode' })
}

export interface ThumbnailCounts {
  /** Pictures actually taken, successful or not. */
  captures: number
  stored: number
  /** Answered by something current, without taking a picture. */
  fresh: number
  /** Failed captures that left the previous picture standing. */
  kept: number
  rejected: Record<ThumbnailRejection, number>
}

export function emptyThumbnailCounts(): ThumbnailCounts {
  const rejected = Object.fromEntries(THUMBNAIL_REJECTIONS.map((reason) => [reason, 0]))
  return {
    captures: 0,
    stored: 0,
    fresh: 0,
    kept: 0,
    rejected: rejected as Record<ThumbnailRejection, number>
  }
}

// --- keys and addresses ------------------------------------------------------

/**
 * Page schemes worth a picture.
 *
 * Narrower than history's, which also keeps `file:` addresses. A screenshot of a
 * local document is a copy of that document's contents in the cache directory, where
 * a backup or a sync tool will pick it up — the user put the file somewhere
 * deliberately, and this would put part of it somewhere else.
 */
const CAPTURABLE_SCHEMES: readonly string[] = ['http:', 'https:']

/**
 * The key for a page, or `null` when it has none.
 *
 * Keyed per address rather than per site, unlike the favicon cache: the point is to
 * show *this page*, and a site-wide key would mean the card for a project page shows
 * whichever page of that host was photographed last.
 *
 * The normalisation is history's, deliberately. A card is built from a Quick Link or
 * from a history row, and if the two normalised differently the lookup would miss
 * for exactly the pages the user cares most about. It also buys history's two good
 * decisions for free: the fragment goes (same document, same picture) and tracking
 * parameters go (one campaign link and another are one page). The coupling is real —
 * if history ever narrows this, stored keys shift and the pictures are taken again —
 * and cheap, because that costs one local capture per page and nothing the user typed.
 */
export function thumbnailKeyOf(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  // Checked before delegating rather than on the result: a scheme test against a
  // normalised string is the prefix-matching mistake `isInternalScheme` warns about.
  if (!CAPTURABLE_SCHEMES.includes(parsed.protocol)) return null
  return historyUrlOf(parsed.toString())
}

/**
 * The site a stored entry belongs to, or `null`.
 *
 * Used as the text alternative's fallback, and it can genuinely fail: entries are
 * read back from a file the user can edit, and the schema only asks for a non-empty
 * string.
 */
export function thumbnailSiteOf(url: string): string | null {
  return registrableDomainOfUrl(url)
}

/**
 * Titles arrive from pages, so they arrive with newlines, tabs and padding. The
 * alternative text is one line, so the whitespace is collapsed once, here.
 */
export function thumbnailTitleOf(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_THUMBNAIL_TITLE_LENGTH)
}

/** Internal page the stored pictures are served from. */
export const THUMBNAIL_PAGE = 'thumbnail'
/** Query parameter naming the page. */
export const THUMBNAIL_URL_PARAM = 'url'
/** Query parameter carrying the capture time, so a new picture is a new address. */
export const THUMBNAIL_VERSION_PARAM = 'v'

/**
 * The address a renderer puts in an `<img>`.
 *
 * Built from the entry rather than from the address alone, because the version
 * parameter is the load-bearing part: the file name is stable per page, so without it
 * a freshly captured picture would keep the address it already had and Chromium would
 * go on drawing the copy in its memory cache — the card would keep last week's
 * picture until the browser restarted. The handler ignores the parameter; its only
 * job is to change.
 */
export function thumbnailUrl(entry: Pick<ThumbnailEntry, 'url' | 'capturedAt'>): string {
  return internalUrl(THUMBNAIL_PAGE, {
    [THUMBNAIL_URL_PARAM]: entry.url,
    [THUMBNAIL_VERSION_PARAM]: entry.capturedAt.toString(36)
  })
}

/**
 * The page a thumbnail address asks for, or `null`.
 *
 * The counterpart of `thumbnailUrl`, for the protocol handler. It normalises through
 * `thumbnailKeyOf`, so what comes back is a key to look up in the index and never a
 * path fragment — an internal page is reachable from a link, so this string is
 * untrusted input.
 */
export function thumbnailPageOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const page = parsed.searchParams.get(THUMBNAIL_URL_PARAM)
  if (page === null) return null
  return thumbnailKeyOf(page)
}

// --- scaling -----------------------------------------------------------------

/**
 * What to do with a captured image before storing it.
 *
 * Two optional steps rather than one resize, because a straight resize to the target
 * would squash a portrait window and stretch an ultrawide one. `null` means "this
 * step is unnecessary", which keeps the store from asking the platform to crop an
 * image to its own bounds or resize it to the size it already is.
 */
export interface ThumbnailPlan {
  /** The region to keep, or `null` when the source already has the proportions. */
  crop: ThumbnailRect | null
  /** The size to scale to, or `null` when the region is already small enough. */
  resize: ThumbnailSize | null
  /** What the stored image will measure. Never larger than the target. */
  size: ThumbnailSize
}

function isUsableSize(size: ThumbnailSize): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  )
}

/**
 * How to turn a captured window into a card-sized picture, or `null` when there is
 * nothing to work with.
 *
 * Crop first, then scale. The crop takes the largest region of the source with the
 * target's proportions, anchored to the *top* — the top of a page is its header,
 * logo and headline, which is what makes it recognisable, while the bottom is
 * whatever happened to be below the fold. Horizontally it is centred, because a very
 * wide window usually has the page's content in the middle with margins either side.
 *
 * Never upscales. A small window photographed at 300 px wide is stored at 300 px:
 * inflating it to the target would spend three times the bytes on pixels that were
 * invented, and the renderer can scale a small picture up perfectly well if it
 * decides to.
 *
 * `null` for a degenerate size rather than a throw: a view that has never painted
 * reports one, and it is a normal thing to happen rather than a fault.
 */
export function planThumbnail(
  source: ThumbnailSize,
  target: Readonly<ThumbnailSize>
): ThumbnailPlan | null {
  if (!isUsableSize(source)) return null

  const wanted = target.width / target.height
  const region = coverRegion(source, wanted)
  const crop =
    region.width === source.width && region.height === source.height ? null : region

  // `min` is what makes this a downscale-only step.
  const scale = Math.min(1, target.width / region.width)
  if (scale === 1) {
    return { crop, resize: null, size: { width: region.width, height: region.height } }
  }
  const size = { width: target.width, height: target.height }
  return { crop, resize: size, size }
}

/**
 * The largest region of `source` with the given aspect ratio: full width and a slice
 * off the top for anything taller, a centred column for anything wider.
 *
 * Rounding leaves the region's proportions a fraction off the target's, and the
 * resize step then squashes it by less than a pixel. Correcting that would cost a
 * second rounding decision to fix an error nothing can see.
 */
function coverRegion(source: ThumbnailSize, aspect: number): ThumbnailRect {
  const have = source.width / source.height
  if (have > aspect) {
    const width = Math.round(source.height * aspect)
    return { x: Math.round((source.width - width) / 2), y: 0, width, height: source.height }
  }
  if (have < aspect) {
    const height = Math.round(source.width / aspect)
    return { x: 0, y: 0, width: source.width, height }
  }
  return { x: 0, y: 0, width: source.width, height: source.height }
}

// --- the text alternative ----------------------------------------------------

/**
 * Why an alternative text is what it is.
 *
 * Returned alongside the text instead of leaving the caller to guess, because "empty"
 * has two very different meanings — deliberately decorative, or nothing to say — and
 * a renderer that cannot tell them apart ends up inventing filler for the second.
 */
export type ThumbnailAlternativeReason =
  /** The text names the page and belongs in `alt`. */
  | 'describes'
  /** The card already says this in text, so the image must be `alt=""`. */
  | 'duplicate'
  /** Nothing is known about the page beyond its address, which is not an answer. */
  | 'nothing-to-say'

export interface ThumbnailAlternative {
  /** Goes straight into `alt`. Empty is a deliberate answer, never an oversight. */
  text: string
  reason: ThumbnailAlternativeReason
}

/**
 * The text alternative for a card's picture, given whatever label the card already
 * shows.
 *
 * Three decisions, and the reasons matter more than the code:
 *
 * *It is never the address.* A screen reader given
 * `alt="https://example.com/a/b?c=d"` spells the punctuation out; the user learns
 * nothing and cannot skip it. The title is what the page calls itself, and that is
 * what a person would say.
 *
 * *It is never prose.* "Screenshot of …" would be an English sentence built in the
 * core, which spec 7 forbids for good reason — it cannot be translated from here —
 * and it describes the medium rather than the page. A screen reader already announces
 * that this is an image.
 *
 * *It is empty when the card already says it.* An image inside a link whose visible
 * text is "Wikipedia" must not also announce "Wikipedia": the user hears it twice and
 * cannot tell whether there are two links. `alt=""` is the correct markup for a
 * picture that adds nothing a sighted user gets from it either — nobody can describe
 * a screenshot in five words, and the label is the real information. Compared by
 * containment in both directions, because "GitHub" beside "GitHub · Where software is
 * built" is the same duplication with extra words.
 */
export function thumbnailAlternative(
  entry: Pick<ThumbnailEntry, 'url' | 'title'>,
  cardLabel: string
): ThumbnailAlternative {
  const described = entry.title === '' ? (thumbnailSiteOf(entry.url) ?? '') : entry.title
  if (described === '') return { text: '', reason: 'nothing-to-say' }

  const label = comparableText(cardLabel)
  const subject = comparableText(described)
  if (label !== '' && (label.includes(subject) || subject.includes(label))) {
    return { text: '', reason: 'duplicate' }
  }
  return { text: described, reason: 'describes' }
}

/** Case and spacing are not differences a listener would notice. */
function comparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

// --- aging and bookkeeping ---------------------------------------------------

/**
 * Whether a picture should be taken again on the next visit.
 *
 * A timestamp in the future counts as stale, exactly as in the favicon cache and for
 * the same reasons: a profile copied between machines, a resume from suspend or an NTP
 * correction all produce one, and the alternative reading — current for the next week
 * plus however far the clock jumped — could pin a wrong picture in place indefinitely.
 */
export function thumbnailIsStale(
  entry: Pick<ThumbnailEntry, 'capturedAt'>,
  now: number,
  maxAgeMs: number = THUMBNAIL_MAX_AGE_MS
): boolean {
  if (entry.capturedAt > now) return true
  return now - entry.capturedAt >= maxAgeMs
}

function byCaptureRecency(left: ThumbnailEntry, right: ThumbnailEntry): number {
  return right.capturedAt - left.capturedAt
}

export interface ThumbnailIndexChange {
  shots: ThumbnailEntry[]
  /** Entries pushed out by the cap. Their files are the store's to remove. */
  evicted: ThumbnailEntry[]
}

/**
 * Adds or replaces one page's entry and reports what the cap pushed out.
 *
 * The evicted entries come back rather than being dropped silently, because each one
 * has a picture behind it: a pure function cannot delete a file, and an index that
 * forgot the entry existed would leave that picture on disk for good — which for this
 * particular kind of file is not a housekeeping detail.
 */
export function putThumbnailEntry(
  shots: readonly ThumbnailEntry[],
  entry: ThumbnailEntry,
  limit: number = MAX_THUMBNAIL_ENTRIES
): ThumbnailIndexChange {
  const others = shots.filter((shot) => shot.url !== entry.url)
  const merged = [entry, ...others].sort(byCaptureRecency)
  return { shots: merged.slice(0, limit), evicted: merged.slice(limit) }
}

/** One page's entry, or `null`. Takes a raw or a normalised address. */
export function findThumbnailEntry(
  shots: readonly ThumbnailEntry[],
  pageUrl: string
): ThumbnailEntry | null {
  const key = thumbnailKeyOf(pageUrl)
  if (key === null) return null
  return shots.find((shot) => shot.url === key) ?? null
}

/**
 * Makes a loaded index obey what the write path maintains: one entry per page, most
 * recently captured first, no more than the cap.
 *
 * Duplicates keep the newer entry. Nothing is worth reconstructing from the older one
 * — both name the same file, and the newer picture has already overwritten it.
 */
export function repairThumbnailIndex(
  shots: readonly ThumbnailEntry[],
  limit: number = MAX_THUMBNAIL_ENTRIES
): ThumbnailEntry[] {
  const byUrl = new Map<string, ThumbnailEntry>()
  for (const shot of shots) {
    const existing = byUrl.get(shot.url)
    const winner = existing !== undefined && existing.capturedAt > shot.capturedAt ? existing : shot
    byUrl.set(shot.url, winner)
  }
  return [...byUrl.values()].sort(byCaptureRecency).slice(0, limit)
}
