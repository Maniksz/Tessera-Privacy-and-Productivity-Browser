/**
 * What a page is playing, described without saying how it was found or how it
 * would be retrieved.
 *
 * The whole media feature is built natively because the extensions that would do
 * it cannot exist here: Electron 43 has no `chrome.downloads`, so a
 * video-download extension has nowhere to put the bytes. Native means the
 * decisions land in this codebase, and this file is the vocabulary they are made
 * in.
 *
 * Everything under `src/shared/media/` is pure: no network, no clock, no disk, no
 * Electron, no Node. Two rules force that shape and both are checked by tests
 * rather than remembered. The renderer will render the finding list, so an
 * architecture test forbids zod in anything a renderer imports at runtime — the
 * schemas for these shapes belong with whatever persists them, not here. And a
 * manifest parser that cannot be called with a string in a unit test is a parser
 * nobody will cover, which for something reading attacker-supplied text is the
 * expensive kind of untested.
 *
 * `src/main/media/` supplies the three things these functions refuse to hold: the
 * network (an injected fetcher, so retrieval goes through the browsing session),
 * the clock, and the disk.
 */

/**
 * How the bytes are addressed, which is the only distinction that changes what a
 * download has to do.
 *
 *   - `progressive` — one address, one file. `GET` it and you have the media.
 *   - `hls`         — RFC 8216. A playlist of segments, possibly a playlist of
 *                     playlists.
 *   - `dash`        — ISO/IEC 23009-1. An XML manifest of representations, each
 *                     assembled from a segment template.
 *
 * Deliberately not a list of sites. A per-site extractor list is a maintenance
 * treadmill that breaks silently every time a page changes; what a page *asks the
 * network for* is the same three shapes everywhere.
 */
export const MEDIA_KINDS = ['progressive', 'hls', 'dash'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

/**
 * The container the bytes are in, as far as anything knows.
 *
 * `unknown` is a real state, not a placeholder for a bug: a request seen before
 * its response headers has an address and a resource type and nothing else, and a
 * playlist reveals its container only once parsed. Keeping it in the type is what
 * stops the file-naming code from inventing an extension it cannot justify.
 */
export const MEDIA_CONTAINERS = [
  'mp4',
  'webm',
  'm4a',
  'mp3',
  'aac',
  'ogg',
  'mov',
  /** MPEG-2 Transport Stream — HLS segments, never a whole-file download. */
  'ts',
  'unknown'
] as const
export type MediaContainer = (typeof MEDIA_CONTAINERS)[number]

/**
 * Which tracks a variant carries.
 *
 * This is the field that decides whether a download can finish, so it is part of
 * the vocabulary rather than a detail of the HLS parser. `video` means video
 * *only*, with the audio in a separate rendition — joining the two needs a muxer
 * that rewrites sample tables, which is ffmpeg's job and not something this
 * browser ships. `muxed` means one stream with everything in it, which is the
 * case that can be assembled by concatenation alone.
 */
export const MEDIA_TRACKS = ['muxed', 'video', 'audio'] as const
export type MediaTrack = (typeof MEDIA_TRACKS)[number]

/** One quality a manifest offers. */
export interface MediaVariant {
  /** Stable within one finding; `v0`/`a0` rather than an index, so a UI can key on it. */
  readonly id: string
  /**
   * Where the variant's own playlist lives, or null when it has no single
   * address. DASH representations are assembled from a segment template and have
   * no one URL, and pretending otherwise would put a URL in the UI that leads
   * nowhere.
   */
  readonly url: string | null
  readonly track: MediaTrack
  readonly bandwidthBitsPerSecond: number | null
  readonly width: number | null
  readonly height: number | null
  readonly codecs: string | null
  readonly container: MediaContainer
  /** `LANGUAGE`/`@lang`, for telling three audio renditions apart. */
  readonly language: string | null
  /** `NAME`/`@id`, as the manifest wrote it. */
  readonly name: string | null
}

/**
 * Content-protection schemes, recognised in order to refuse them.
 *
 * Circumventing DRM is not part of this feature. What is part of it: saying so
 * before the user waits for a download that could only ever produce an
 * undecryptable file. `aes-128` is in the list because RFC 8216's plain AES mode
 * is technically decryptable with a key the player is allowed to fetch — and it
 * is still refused, because "the key is available to the player" is not the same
 * as "the user may keep a copy", and this browser does not get to decide that on
 * a rights holder's behalf.
 */
export const DRM_SCHEMES = [
  'aes-128',
  'sample-aes',
  'fairplay',
  'widevine',
  'playready',
  /** ISO Common Encryption, declared without naming a key system. */
  'cenc',
  'unknown'
] as const
export type DrmScheme = (typeof DRM_SCHEMES)[number]

export type DrmStatus =
  | { readonly protected: false }
  | {
      readonly protected: true
      readonly scheme: DrmScheme
      /** What was found, verbatim enough to debug with: the METHOD, the schemeIdUri. */
      readonly detail: string
    }

/** Shared, so the common answer does not allocate on every parse. */
export const NOT_PROTECTED: DrmStatus = { protected: false }

export const MANIFEST_FAILURES = [
  /** The request failed, or answered with something other than 2xx. */
  'unreachable',
  /** Retrieved, but not a playlist or an MPD. */
  'not-a-manifest',
  /** A playlist with neither variants nor segments; an MPD with no representations. */
  'no-variants',
  /** Larger than a manifest has any business being. */
  'too-large'
] as const
export type ManifestFailure = (typeof MANIFEST_FAILURES)[number]

/**
 * What is known about a finding's manifest.
 *
 * `not-loaded` is the state a finding starts in and usually stays in, and that is
 * deliberate. Fetching every manifest the moment it is noticed would double the
 * page's manifest traffic for a feature the user may never open — measurable on a
 * page with four players, and a second request to the same address is exactly the
 * kind of thing a privacy browser should not do speculatively. The parse happens
 * when someone asks to see the qualities.
 */
export type ManifestState =
  | { readonly status: 'not-loaded' }
  | { readonly status: 'pending' }
  | {
      readonly status: 'ready'
      /** Best first, per `sortVariantsByQuality`. Empty means "one quality: the finding itself". */
      readonly variants: readonly MediaVariant[]
      readonly durationSeconds: number | null
      /** A stream still being written to. There is no last segment to wait for. */
      readonly live: boolean
      readonly drm: DrmStatus
    }
  | { readonly status: 'failed'; readonly reason: ManifestFailure; readonly detail: string }

/** One thing a tab is playing, or has played since it last navigated. */
export interface MediaFinding {
  /** Unique within the registry; the UI addresses a finding by this. */
  readonly id: string
  readonly tabId: string
  readonly url: string
  /** The page that asked for it, for showing where a finding came from. */
  readonly documentUrl: string | null
  readonly kind: MediaKind
  readonly container: MediaContainer
  /** As the server declared it, parameters stripped, or null when not seen yet. */
  readonly contentType: string | null
  /** From `Content-Length`, when there was one. */
  readonly byteLength: number | null
  /**
   * A human-recognisable name taken from the address.
   *
   * Informational only. The name a download is *written* to is computed from the
   * chosen container at plan time, because a `master.m3u8` produces a file that
   * is not called `master.m3u8`.
   */
  readonly label: string
  readonly discoveredAt: number
  /** Null for `progressive`, which has no manifest to load. */
  readonly manifest: ManifestState | null
}

/**
 * Why a download cannot be produced.
 *
 * Every value is a decision the interface has to be able to explain, so each one
 * is distinct even where two could have been merged: "this is encrypted" and
 * "this needs a muxer we do not ship" call for different words to the user, and a
 * single `unsupported` would have made the interface guess.
 */
export const DOWNLOAD_REFUSALS = [
  /** Encrypted. Not circumvented — see `DRM_SCHEMES`. */
  'drm-protected',
  /** No `#EXT-X-ENDLIST`: the stream has no end to download up to. */
  'live-stream',
  /** Video-only variant; joining it to its audio rendition needs a muxer. */
  'separate-audio-track',
  /** DASH representations are single-track and template-addressed. */
  'dash-needs-muxer',
  /** Complete files per segment: concatenating them yields something unplayable. */
  'segments-not-concatenable',
  /**
   * The playlist could not be retrieved, did not parse, or was not the kind of
   * playlist it was reached as. "Lists no segments" lands here too, because the
   * parser refuses to produce a media playlist with nothing in it.
   */
  'manifest-unavailable',
  /** Not http(s) — a `blob:` or `data:` address the session cannot re-request. */
  'unsupported-scheme',
  /** One segment failed; a file with a hole in it is not a download. */
  'segment-unavailable',
  /** Past the byte ceiling. */
  'too-large',
  /** The user stopped it. */
  'cancelled',
  /** The bytes arrived and the disk refused them. */
  'write-failed'
] as const
export type DownloadRefusal = (typeof DOWNLOAD_REFUSALS)[number]

/**
 * Best first: taller before shorter, and at equal height the fatter bitrate.
 *
 * Height rather than bandwidth as the primary key, because that is what a person
 * chooses by. Bandwidth breaks the tie because two 1080p variants at different
 * bitrates are a real thing in a master playlist, and a stable order matters more
 * than which of the two wins.
 *
 * Track order comes last and puts `muxed` first, so the default choice is the one
 * that can actually be assembled.
 */
export function sortVariantsByQuality(variants: readonly MediaVariant[]): readonly MediaVariant[] {
  const rank: Readonly<Record<MediaTrack, number>> = { muxed: 0, video: 1, audio: 2 }
  return [...variants].sort((a, b) => {
    if (rank[a.track] !== rank[b.track]) return rank[a.track] - rank[b.track]
    if ((b.height ?? 0) !== (a.height ?? 0)) return (b.height ?? 0) - (a.height ?? 0)
    return (b.bandwidthBitsPerSecond ?? 0) - (a.bandwidthBitsPerSecond ?? 0)
  })
}

/**
 * The variant to use when the user asked for a download without choosing one.
 *
 * Only a `muxed` variant qualifies. Silently picking the best video-only stream
 * would hand back a file with no sound, which looks like a bug in the browser
 * rather than a property of the stream — so this returns null instead and the
 * caller refuses with a reason the interface can show.
 */
export function bestMuxedVariant(variants: readonly MediaVariant[]): MediaVariant | null {
  return sortVariantsByQuality(variants).find((variant) => variant.track === 'muxed') ?? null
}

/** The variant with this id, or null. */
export function variantById(variants: readonly MediaVariant[], id: string): MediaVariant | null {
  return variants.find((variant) => variant.id === id) ?? null
}
