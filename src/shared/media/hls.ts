import { NOT_PROTECTED, type DrmScheme, type DrmStatus, type MediaContainer } from './model.js'
import { pathExtensionOf, resolveMediaUrl } from './url.js'

/**
 * HLS playlists, per RFC 8216.
 *
 * Two documents share one syntax, and telling them apart is the parser's first
 * job: a *Master* Playlist lists Variant Streams (the qualities a user picks
 * from), a *Media* Playlist lists Media Segments (the bytes). Nothing in the
 * header says which one you have — you know because you found `#EXT-X-STREAM-INF`
 * or `#EXTINF`. That is why this returns a discriminated union rather than one
 * struct with half its fields empty.
 *
 * Pure and offline. A playlist is text a website supplied, so it is treated as
 * hostile input: every numeric attribute may be absent or nonsense, every URI may
 * be unresolvable, and the parse always terminates with an answer rather than an
 * exception.
 */

/** A sub-range of a larger resource, from `#EXT-X-BYTERANGE`. */
export interface HlsByteRange {
  readonly offset: number
  readonly length: number
}

export interface HlsSegment {
  readonly url: string
  readonly durationSeconds: number
  readonly byteRange: HlsByteRange | null
}

/** One `#EXT-X-STREAM-INF` and the URI line that follows it. */
export interface HlsVariantStream {
  readonly url: string
  readonly bandwidthBitsPerSecond: number | null
  readonly averageBandwidthBitsPerSecond: number | null
  readonly width: number | null
  readonly height: number | null
  readonly codecs: string | null
  /**
   * The `AUDIO` attribute: the rendition group this variant takes its audio from.
   *
   * Non-null means the variant carries no audio of its own. That single fact
   * decides whether a download can finish, so it is carried all the way out of
   * the parser rather than being resolved into a boolean here.
   */
  readonly audioGroupId: string | null
}

/** An `#EXT-X-MEDIA` alternative rendition that has its own playlist. */
export interface HlsRendition {
  /** `AUDIO`, `SUBTITLES`, `VIDEO`, `CLOSED-CAPTIONS`, as written. */
  readonly type: string
  readonly groupId: string | null
  readonly name: string | null
  readonly language: string | null
  readonly url: string
}

export type HlsPlaylist =
  | {
      readonly kind: 'master'
      readonly variants: readonly HlsVariantStream[]
      readonly renditions: readonly HlsRendition[]
      /** From `#EXT-X-SESSION-KEY`, which declares encryption before any segment. */
      readonly drm: DrmStatus
    }
  | {
      readonly kind: 'media'
      readonly segments: readonly HlsSegment[]
      /** `#EXT-X-MAP`: the fMP4 initialisation segment. Null for MPEG-2 TS. */
      readonly initSegment: HlsSegment | null
      readonly targetDurationSeconds: number | null
      readonly durationSeconds: number
      readonly live: boolean
      readonly drm: DrmStatus
      readonly container: MediaContainer
    }
  | {
      readonly kind: 'invalid'
      readonly reason: HlsParseFailure
    }

export const HLS_PARSE_FAILURES = [
  /** No `#EXTM3U` on the first line — RFC 8216 §4.3.1.1 makes that mandatory. */
  'not-a-playlist',
  /** Well-formed, but lists neither a variant nor a segment. */
  'no-entries'
] as const
export type HlsParseFailure = (typeof HLS_PARSE_FAILURES)[number]

/**
 * An attribute list, per RFC 8216 §4.2.
 *
 * Splitting on commas is the trap. `CODECS="avc1.4d401e,mp4a.40.2"` is *one*
 * attribute whose value contains a comma, and a `split(',')` turns it into two
 * broken ones — which quietly loses the `AUDIO` or `RESOLUTION` that came after
 * it, because the fragments no longer parse as `NAME=VALUE`. So the scan tracks
 * whether it is inside a quoted-string.
 *
 * Names are upper-cased on the way in: the grammar says they are upper-case, and
 * a packager that disagrees should not silently lose its attributes.
 */
export function parseAttributeList(text: string): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {}

  const add = (piece: string): void => {
    const equals = piece.indexOf('=')
    // A piece with no `=` is not an attribute: a trailing comma, or a packager's
    // stray token. Dropping it keeps the rest of the list usable.
    if (equals <= 0) return
    const name = piece.slice(0, equals).trim().toUpperCase()
    // One regex rather than startsWith/endsWith/length: fewer branches to reason
    // about, and it leaves a lone `"` from malformed input alone.
    const value = piece
      .slice(equals + 1)
      .trim()
      .replace(/^"([\s\S]*)"$/, '$1')
    attributes[name] = value
  }

  let start = 0
  let inQuotes = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"') inQuotes = !inQuotes
    else if (character === ',' && !inQuotes) {
      add(text.slice(start, index))
      start = index + 1
    }
  }
  add(text.slice(start))
  return attributes
}

function toInteger(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function toSeconds(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

interface Resolution {
  readonly width: number | null
  readonly height: number | null
}

const NO_RESOLUTION: Resolution = { width: null, height: null }

/** `RESOLUTION=1280x720` — a decimal-resolution, RFC 8216 §4.2. */
function parseResolution(value: string | undefined): Resolution {
  if (value === undefined) return NO_RESOLUTION
  const match = /^(\d+)[xX](\d+)$/.exec(value.trim())
  if (match === null) return NO_RESOLUTION
  return { width: Number(match[1]), height: Number(match[2]) }
}

/**
 * Which key system a `METHOD`/`KEYFORMAT` pair names.
 *
 * Recognised so it can be refused with a name the interface can show, not so it
 * can be handled. The UUIDs are the registered DASH/CENC system ids, which HLS
 * reuses in `KEYFORMAT` for `SAMPLE-AES-CTR`.
 */
function drmSchemeOf(method: string, keyFormat: string): DrmScheme {
  if (keyFormat.includes('edef8ba9')) return 'widevine'
  if (keyFormat.includes('9a04f079')) return 'playready'
  if (keyFormat.includes('com.apple.streamingkeydelivery')) return 'fairplay'
  if (method.startsWith('SAMPLE-AES')) return 'sample-aes'
  if (method === 'AES-128') return 'aes-128'
  return 'unknown'
}

/**
 * A key declaration read as an encryption verdict.
 *
 * `METHOD=NONE` is the only clear answer. Everything else is refused, including
 * plain `AES-128` whose key a player may fetch without any licence exchange —
 * see `DRM_SCHEMES` for why that is a deliberate refusal rather than a gap.
 */
export function drmFromKeyAttributes(attributes: Readonly<Record<string, string>>): DrmStatus {
  const method = (attributes['METHOD'] ?? 'NONE').toUpperCase()
  if (method === 'NONE') return NOT_PROTECTED
  const keyFormat = attributes['KEYFORMAT']
  const normalizedFormat = (keyFormat ?? 'identity').toLowerCase()
  const suffix = keyFormat === undefined ? '' : `, KEYFORMAT=${keyFormat}`
  return {
    protected: true,
    scheme: drmSchemeOf(method, normalizedFormat),
    detail: `METHOD=${method}${suffix}`
  }
}

/**
 * `#EXT-X-BYTERANGE:<n>[@<o>]`.
 *
 * A missing offset means "immediately after the previous sub-range of the same
 * resource" (RFC 8216 §4.3.2.2), so the previous segment has to be carried along.
 * Without one the range has no defined start, and the segment is dropped rather
 * than guessed at — a download assembled from the wrong offsets is worse than a
 * download that did not happen.
 */
function parseByteRange(
  value: string,
  url: string,
  previous: { readonly url: string; readonly end: number } | null
): HlsByteRange | null {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim())
  if (match === null) return null
  const length = Number(match[1])
  const offset = match[2]
  if (offset !== undefined) return { offset: Number(offset), length }
  if (previous !== null && previous.url === url) return { offset: previous.end, length }
  return null
}

/**
 * Segment extensions that say what the bytes are.
 *
 * `mp4`/`m4s` here mean "an MP4 of some sort"; whether it can be concatenated
 * depends on `#EXT-X-MAP`, which is a question for the download plan rather than
 * for the container name.
 */
const CONTAINER_BY_SEGMENT_EXTENSION: Readonly<Record<string, MediaContainer>> = {
  ts: 'ts',
  m2ts: 'ts',
  mp4: 'mp4',
  m4s: 'mp4',
  m4v: 'mp4',
  m4a: 'm4a',
  aac: 'aac',
  mp3: 'mp3',
  webm: 'webm'
}

/**
 * What the segments of a media playlist are.
 *
 * An `#EXT-X-MAP` settles it: RFC 8216 §3.3 requires one for fMP4 segments and
 * forbids it for MPEG-2 TS, so its presence is a stronger signal than any
 * extension. Failing that, the extension decides; and failing *that*, MPEG-2 TS
 * is the answer, because it is the format §3.1 describes as the one segments are
 * in unless something says otherwise — and extension-less segment addresses
 * (`/seg/00042?token=…`) are ordinary.
 */
function containerOfSegments(hasInitSegment: boolean, firstSegmentUrl: string): MediaContainer {
  if (hasInitSegment) return 'mp4'
  return CONTAINER_BY_SEGMENT_EXTENSION[pathExtensionOf(firstSegmentUrl)] ?? 'ts'
}

interface ParseState {
  readonly variants: HlsVariantStream[]
  readonly renditions: HlsRendition[]
  readonly segments: HlsSegment[]
  initSegment: HlsSegment | null
  targetDurationSeconds: number | null
  drm: DrmStatus
  hasEndList: boolean
  isVod: boolean
  /** Attributes of an `#EXT-X-STREAM-INF` awaiting its URI line. */
  pendingVariant: Readonly<Record<string, string>> | null
  /** Duration from an `#EXTINF` awaiting its URI line. */
  pendingDuration: number | null
  pendingByteRange: string | null
  lastRange: { readonly url: string; readonly end: number } | null
}

function applyTag(state: ParseState, line: string, playlistUrl: string): void {
  if (line.startsWith('#EXT-X-STREAM-INF:')) {
    state.pendingVariant = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length))
    return
  }
  if (line.startsWith('#EXTINF:')) {
    // `#EXTINF:9.009,title` — the title after the comma is free text.
    state.pendingDuration = toSeconds(line.slice('#EXTINF:'.length).split(',')[0]!)
    return
  }
  if (line.startsWith('#EXT-X-BYTERANGE:')) {
    state.pendingByteRange = line.slice('#EXT-X-BYTERANGE:'.length)
    return
  }
  if (line.startsWith('#EXT-X-MEDIA:')) {
    const attributes = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length))
    const uri = attributes['URI']
    // A rendition without a URI is muxed into the variant streams; there is
    // nothing separate to offer.
    if (uri === undefined) return
    const url = resolveMediaUrl(playlistUrl, uri)
    if (url === null) return
    state.renditions.push({
      type: (attributes['TYPE'] ?? 'UNKNOWN').toUpperCase(),
      groupId: attributes['GROUP-ID'] ?? null,
      name: attributes['NAME'] ?? null,
      language: attributes['LANGUAGE'] ?? null,
      url
    })
    return
  }
  if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
    const attributes = parseAttributeList(line.slice(line.indexOf(':') + 1))
    const status = drmFromKeyAttributes(attributes)
    // Any protected key wins and is never cleared by a later `METHOD=NONE`. A
    // playlist that encrypts part of its span is still a playlist this feature
    // will not produce a whole file from.
    if (status.protected) state.drm = status
    return
  }
  if (line.startsWith('#EXT-X-MAP:')) {
    const attributes = parseAttributeList(line.slice('#EXT-X-MAP:'.length))
    const uri = attributes['URI']
    if (uri === undefined) return
    const url = resolveMediaUrl(playlistUrl, uri)
    if (url === null) return
    const range = attributes['BYTERANGE']
    state.initSegment = {
      url,
      durationSeconds: 0,
      byteRange: range === undefined ? null : parseByteRange(range, url, null)
    }
    return
  }
  if (line.startsWith('#EXT-X-TARGETDURATION:')) {
    state.targetDurationSeconds = toSeconds(line.slice('#EXT-X-TARGETDURATION:'.length))
    return
  }
  if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
    state.isVod = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim().toUpperCase() === 'VOD'
    return
  }
  if (line === '#EXT-X-ENDLIST') state.hasEndList = true

  /*
    Everything else is ignored on purpose, and two omissions are worth naming.

    `#EXT-X-I-FRAME-STREAM-INF` describes a trick-play stream of I-frames only:
    it is a Variant Stream by grammar but not something anyone wants to download,
    and listing it beside the real qualities would offer the user a broken choice.

    `#EXT-X-DISCONTINUITY` and the timestamp tags matter to a player and not to a
    byte-for-byte copy, which is what this produces.
  */
}

function applyUri(state: ParseState, line: string, playlistUrl: string): void {
  const url = resolveMediaUrl(playlistUrl, line)
  if (url === null) {
    state.pendingVariant = null
    state.pendingDuration = null
    state.pendingByteRange = null
    return
  }

  const variant = state.pendingVariant
  if (variant !== null) {
    const resolution = parseResolution(variant['RESOLUTION'])
    state.variants.push({
      url,
      bandwidthBitsPerSecond: toInteger(variant['BANDWIDTH']),
      averageBandwidthBitsPerSecond: toInteger(variant['AVERAGE-BANDWIDTH']),
      width: resolution.width,
      height: resolution.height,
      codecs: variant['CODECS'] ?? null,
      audioGroupId: variant['AUDIO'] ?? null
    })
    state.pendingVariant = null
    return
  }

  const duration = state.pendingDuration
  // A URI with no `#EXTINF` before it is not a Media Segment (RFC 8216 §4.3.2.1
  // makes the tag mandatory). Skipping it keeps a malformed playlist from
  // producing a segment of unknown length in the middle of a download.
  if (duration === null) {
    state.pendingByteRange = null
    return
  }

  const pendingRange = state.pendingByteRange
  const byteRange =
    pendingRange === null ? null : parseByteRange(pendingRange, url, state.lastRange)
  state.segments.push({ url, durationSeconds: duration, byteRange })
  state.lastRange = byteRange === null ? null : { url, end: byteRange.offset + byteRange.length }
  state.pendingDuration = null
  state.pendingByteRange = null
}

/**
 * Parses a playlist body.
 *
 * `playlistUrl` is needed because playlists reference segments relatively far more
 * often than absolutely, and resolution has to happen where the base is known.
 * Taking it as an argument rather than storing relative URIs keeps every URL that
 * leaves this module directly usable.
 */
export function parseHlsPlaylist(text: string, playlistUrl: string): HlsPlaylist {
  // A BOM is common on playlists written on Windows, and it would make the first
  // line fail the `#EXTM3U` test with no other symptom.
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const firstMeaningful = lines.map((line) => line.trim()).find((line) => line !== '')
  if (firstMeaningful !== '#EXTM3U') return { kind: 'invalid', reason: 'not-a-playlist' }

  const state: ParseState = {
    variants: [],
    renditions: [],
    segments: [],
    initSegment: null,
    targetDurationSeconds: null,
    drm: NOT_PROTECTED,
    hasEndList: false,
    isVod: false,
    pendingVariant: null,
    pendingDuration: null,
    pendingByteRange: null,
    lastRange: null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) applyTag(state, line, playlistUrl)
    else applyUri(state, line, playlistUrl)
  }

  // Master wins when a malformed playlist contains both: a variant list is a
  // description of other documents, and following it is recoverable, whereas
  // downloading segments from a document that also claims to be a master is not.
  if (state.variants.length > 0) {
    return {
      kind: 'master',
      variants: state.variants,
      renditions: state.renditions,
      drm: state.drm
    }
  }

  if (state.segments.length === 0) return { kind: 'invalid', reason: 'no-entries' }

  const durationSeconds = state.segments.reduce(
    (total, segment) => total + segment.durationSeconds,
    0
  )
  return {
    kind: 'media',
    segments: state.segments,
    initSegment: state.initSegment,
    targetDurationSeconds: state.targetDurationSeconds,
    durationSeconds,
    // `#EXT-X-ENDLIST` is the authority: it is what says the playlist will not
    // grow. `PLAYLIST-TYPE:VOD` is honoured as a second signal because a VOD
    // playlist promises the same thing, and a packager that omits the end tag
    // should not turn a finished film into an un-downloadable live stream.
    live: !state.hasEndList && !state.isVod,
    drm: state.drm,
    container: containerOfSegments(state.initSegment !== null, state.segments[0]!.url)
  }
}
