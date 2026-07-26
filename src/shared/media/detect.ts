import type { MediaContainer, MediaKind } from './model.js'
import { isRetrievableUrl, mediaLabelFor, pathExtensionOf } from './url.js'

/**
 * Deciding whether a request is media, from what the interception point knows.
 *
 * Two inputs, and the reason both are needed is the ordinary case rather than an
 * exotic one: a great many media URLs have no extension at all. A CDN address
 * like `/v/12345?token=…` is an `.mp4` and says so only in its `Content-Type`,
 * while an extension on its own can be a lie — `player.mp4.js` is a script, and a
 * `?file=clip.mp4` parameter belongs to an HTML page. So the content type decides
 * when it is known, the extension decides when it is not, and the resource type
 * vetoes both when the browser has already said what the bytes are for.
 *
 * The two arrive at different moments. `onBeforeRequest` has the address and the
 * resource type; the `Content-Type` exists only once response headers come back.
 * That is why `contentType` is nullable rather than required — the same function
 * answers for both observations, and the registry merges the two views of one
 * address.
 */

/**
 * Extensions that name a whole media file.
 *
 * `.ts` is deliberately absent, and it is the most important absence in this
 * file. A ten-minute HLS stream is a few thousand `.ts` requests; treating each
 * as a finding would fill the list with segments and bury the one entry the user
 * wants. The same goes for `.m4s`: a DASH segment is not a file. Segments are
 * reached through their manifest or not at all.
 */
const CONTAINER_BY_EXTENSION: Readonly<Record<string, MediaContainer>> = {
  mp4: 'mp4',
  m4v: 'mp4',
  mov: 'mov',
  webm: 'webm',
  m4a: 'm4a',
  mp3: 'mp3',
  aac: 'aac',
  ogg: 'ogg',
  oga: 'ogg'
}

/**
 * Content types that name a whole media file.
 *
 * `video/mp2t` is absent for the same reason `.ts` is: it is what a segment
 * declares. `application/octet-stream` is absent because it means nothing —
 * accepting it would make every download on the web a media finding.
 */
const CONTAINER_BY_CONTENT_TYPE: Readonly<Record<string, MediaContainer>> = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'mp4',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/webm': 'webm',
  'audio/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'video/ogg': 'ogg'
}

/**
 * The several spellings of "this is an HLS playlist".
 *
 * `application/x-mpegurl` is the historical one and still the most common;
 * `application/vnd.apple.mpegurl` is the registered type from RFC 8216 §4;
 * the `audio/` forms are what a few older packagers emit for the same bytes.
 */
const HLS_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl'
])

const DASH_CONTENT_TYPES: ReadonlySet<string> = new Set(['application/dash+xml'])

/**
 * Resource types whose bytes are not media whatever the address says.
 *
 * A veto list rather than an allow list, and that asymmetry is deliberate.
 * Electron's resource type for media varies by how the page fetched it — `media`
 * for a `<video src>`, `xhr` for a player that assembles its own buffer, `other`
 * for a few, `mainFrame` when the user opens a file directly — so an allow list
 * would have to guess right about every player. What can be said with confidence
 * is the other direction: a stylesheet is never a video.
 */
const NON_MEDIA_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'stylesheet',
  'script',
  'image',
  'font',
  'ping',
  'cspReport',
  'csp_report',
  'webSocket'
])

export interface MediaRequestInput {
  readonly url: string
  /** Electron's resource type: `media`, `xhr`, `mainFrame`, … */
  readonly resourceType: string
  /** From the response, parameters and case irrelevant. Null before headers arrive. */
  readonly contentType: string | null
}

export interface MediaCandidate {
  readonly kind: MediaKind
  readonly container: MediaContainer
  /** The name to show, from the address. */
  readonly label: string
}

/**
 * `Content-Type: video/mp4; codecs="avc1.42E01E"` -> `video/mp4`.
 *
 * Header values carry parameters and arbitrary casing, and a `Set` lookup with
 * either still in place misses every real response.
 */
export function normalizeContentType(value: string | null): string | null {
  if (value === null) return null
  const base = value.split(';')[0]!.trim().toLowerCase()
  return base === '' ? null : base
}

/**
 * What this request is playing, or null.
 *
 * Total, and never throws: it runs inside the request pipeline's observation hook,
 * on every request the browser makes, and an exception there would surface as a
 * page that fails to load.
 */
export function classifyMediaRequest(input: MediaRequestInput): MediaCandidate | null {
  // A `blob:` or `data:` address is what a player built in the page from bytes it
  // already has. There is nothing to re-request through the session, so offering
  // it as a download would offer something that cannot work.
  if (!isRetrievableUrl(input.url)) return null
  if (NON_MEDIA_RESOURCE_TYPES.has(input.resourceType)) return null

  const label = mediaLabelFor(input.url)
  const contentType = normalizeContentType(input.contentType)

  if (contentType !== null) {
    if (HLS_CONTENT_TYPES.has(contentType)) return { kind: 'hls', container: 'unknown', label }
    if (DASH_CONTENT_TYPES.has(contentType)) return { kind: 'dash', container: 'unknown', label }
    const declared = CONTAINER_BY_CONTENT_TYPE[contentType]
    if (declared !== undefined) return { kind: 'progressive', container: declared, label }
  }

  const extension = pathExtensionOf(input.url)
  if (extension === 'm3u8' || extension === 'm3u') {
    return { kind: 'hls', container: 'unknown', label }
  }
  if (extension === 'mpd') return { kind: 'dash', container: 'unknown', label }

  const guessed = CONTAINER_BY_EXTENSION[extension]
  if (guessed !== undefined) return { kind: 'progressive', container: guessed, label }

  /*
    Nothing recognised the bytes, and that is where it stops.

    The tempting extra rule is "resourceType === 'media' means media even without
    a container", and it is wrong twice over. A page using Media Source Extensions
    issues one such request per segment, so the rule would produce thousands of
    findings for one video; and with no container there is no extension to write,
    no way to know whether concatenation would even produce a playable file, and
    nothing to tell the user. A missed finding is recoverable — the manifest
    request beside it is usually recognised — while a list of four thousand
    unnamed entries is not.
  */
  return null
}
