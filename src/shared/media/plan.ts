import type { HlsByteRange, HlsPlaylist } from './hls.js'
import type { DownloadRefusal, DrmStatus, MediaContainer, MediaTrack } from './model.js'
import { isRetrievableUrl, mediaFileNameFor } from './url.js'

/**
 * Turning "the user asked for this" into "these bytes, in this order, into this
 * file" — or into a refusal with a reason.
 *
 * This is where the honest boundary of the feature is drawn, and it is drawn in
 * one place on purpose. What can be finished:
 *
 *   - **Progressive** files. One request, one file, byte-identical.
 *   - **HLS with MPEG-2 TS segments.** A transport stream is a sequence of
 *     188-byte packets with no global header, so concatenating segments *is* the
 *     file. Same for packed ADTS/MP3 audio playlists.
 *   - **HLS with fMP4 segments**, when the playlist has an `#EXT-X-MAP`. The
 *     initialisation segment carries `ftyp`+`moov` and each media segment is a
 *     `moof`+`mdat` fragment, so init followed by fragments is a valid fragmented
 *     MP4. It plays; it has no `sidx` index, so some players seek through it
 *     linearly.
 *
 * What cannot, and why each is a refusal rather than a half-finished file:
 *
 *   - **Anything encrypted.** Not circumvented. See `DRM_SCHEMES`.
 *   - **Live streams.** There is no last segment, so there is no "done".
 *   - **A video-only variant.** Its audio is a separate rendition, and interleaving
 *     two streams into one container means rewriting sample tables — ffmpeg's job.
 *     Handing over a silent video would look like a bug in the browser.
 *   - **DASH.** Representations are single-track by construction, so every DASH
 *     download is the previous case.
 *   - **Self-contained MP4 segments** (MP4 segments with no `#EXT-X-MAP`). Each is
 *     a complete file with its own `moov`; concatenating them produces something
 *     no player reads past the first one.
 */

export interface PlannedSegment {
  readonly url: string
  /** Fetched with a `Range` header when present. */
  readonly byteRange: HlsByteRange | null
}

export type DownloadPlan =
  | {
      readonly kind: 'progressive'
      readonly url: string
      readonly fileName: string
      readonly container: MediaContainer
    }
  | {
      readonly kind: 'segments'
      readonly fileName: string
      readonly container: MediaContainer
      /** Written first when present; the fMP4 header. */
      readonly initSegment: PlannedSegment | null
      readonly segments: readonly PlannedSegment[]
    }

export type PlanOutcome =
  | { readonly ok: true; readonly plan: DownloadPlan }
  | { readonly ok: false; readonly refusal: DownloadRefusal; readonly detail: string }

export type DownloadRequest =
  | { readonly source: 'progressive'; readonly url: string; readonly container: MediaContainer }
  | {
      readonly source: 'hls'
      /** The address the playlist was retrieved from; segment URIs resolve against it. */
      readonly playlistUrl: string
      readonly playlist: HlsPlaylist
      /** From the chosen variant. `muxed` for a playlist found on its own. */
      readonly track: MediaTrack
    }
  | { readonly source: 'dash'; readonly drm: DrmStatus }

/**
 * Containers whose segments are a byte stream rather than a file each.
 *
 * MPEG-2 TS is self-synchronising, ADTS frames and MPEG audio frames carry their
 * own headers: in all three, "the file" is the concatenation and nothing has to be
 * rewritten.
 */
const CONCATENABLE_WITHOUT_HEADER: ReadonlySet<MediaContainer> = new Set(['ts', 'aac', 'mp3'])

function refuse(refusal: DownloadRefusal, detail: string): PlanOutcome {
  return { ok: false, refusal, detail }
}

function planHls(playlist: HlsPlaylist, playlistUrl: string, track: MediaTrack): PlanOutcome {
  if (playlist.kind === 'invalid') {
    return refuse('manifest-unavailable', `playlist did not parse: ${playlist.reason}`)
  }
  if (playlist.kind === 'master') {
    // A variant URI that points at another master playlist. RFC 8216 forbids it,
    // and following it would mean an unbounded chase through documents a site
    // controls.
    return refuse('manifest-unavailable', 'expected a media playlist, found a master playlist')
  }
  if (playlist.drm.protected) {
    return refuse('drm-protected', `${playlist.drm.scheme}: ${playlist.drm.detail}`)
  }
  if (playlist.live) {
    return refuse('live-stream', 'no #EXT-X-ENDLIST: the playlist is still growing')
  }
  if (track === 'video') {
    return refuse(
      'separate-audio-track',
      'the variant carries video only; its audio is a separate rendition'
    )
  }

  const initSegment = playlist.initSegment
  if (initSegment === null && !CONCATENABLE_WITHOUT_HEADER.has(playlist.container)) {
    return refuse(
      'segments-not-concatenable',
      `${playlist.container} segments without an #EXT-X-MAP are complete files, not fragments`
    )
  }

  return {
    ok: true,
    plan: {
      kind: 'segments',
      fileName: mediaFileNameFor(playlistUrl, playlist.container),
      container: playlist.container,
      initSegment:
        initSegment === null ? null : { url: initSegment.url, byteRange: initSegment.byteRange },
      segments: playlist.segments.map((segment) => ({
        url: segment.url,
        byteRange: segment.byteRange
      }))
    }
  }
}

/**
 * The one entry point, total by construction.
 *
 * A single function over a tagged request rather than three exported planners: the
 * caller then has no branch of its own to get wrong, and every refusal is
 * reachable from one call site, which is what makes them all testable.
 */
export function planDownload(request: DownloadRequest): PlanOutcome {
  if (request.source === 'progressive') {
    if (!isRetrievableUrl(request.url)) {
      return refuse('unsupported-scheme', 'only http and https can be re-requested')
    }
    return {
      ok: true,
      plan: {
        kind: 'progressive',
        url: request.url,
        fileName: mediaFileNameFor(request.url, request.container),
        container: request.container
      }
    }
  }

  if (request.source === 'hls') {
    return planHls(request.playlist, request.playlistUrl, request.track)
  }

  if (request.drm.protected) {
    return refuse('drm-protected', `${request.drm.scheme}: ${request.drm.detail}`)
  }
  return refuse(
    'dash-needs-muxer',
    'DASH representations are single-track; combining video and audio needs a muxer'
  )
}
