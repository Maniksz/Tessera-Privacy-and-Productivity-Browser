import { NOT_PROTECTED, type DrmScheme, type DrmStatus, type MediaTrack } from './model.js'
import { childrenNamed, descendantsNamed, parseXml, type XmlNode } from './xml.js'

/**
 * DASH manifests, per ISO/IEC 23009-1.
 *
 * The shape that matters: an `MPD` holds `Period`s, a Period holds
 * `AdaptationSet`s (one per track — video here, audio there), and an AdaptationSet
 * holds `Representation`s, which are the same track at different bitrates. So
 * "the qualities" a user chooses from are the video AdaptationSet's
 * Representations, and their `@bandwidth`, `@width` and `@height` are what the
 * choice is made on.
 *
 * ## What is parsed and what is not
 *
 * Enough to *describe* the manifest — representations, duration, whether it is
 * live, whether it is encrypted — and deliberately not enough to fetch it. Segment
 * addresses are not resolved, `SegmentTemplate` is not expanded and
 * `SegmentTimeline` is not walked, because a DASH download cannot be completed
 * here anyway: representations are single-track by design, so a finished file needs
 * a video stream and an audio stream interleaved into one container, and that is
 * a muxer. Writing the segment enumeration would produce a feature that gets
 * 90 % of the way and then hands the user a silent video.
 *
 * The refusal is in `plan.ts` and carries the reason, so the interface can say
 * "recognised, listed, and not downloadable without ffmpeg" rather than failing
 * silently.
 */

export interface DashRepresentation {
  /** `@id`, as written. Null when the manifest omitted it. */
  readonly id: string | null
  readonly bandwidthBitsPerSecond: number | null
  readonly width: number | null
  readonly height: number | null
  readonly codecs: string | null
  readonly mimeType: string | null
  readonly track: MediaTrack
  readonly language: string | null
}

export const DASH_PARSE_FAILURES = [
  /** No `MPD` root element: not a manifest, whatever it is. */
  'not-an-mpd',
  /** An MPD with no audio or video representation in it. */
  'no-representations'
] as const
export type DashParseFailure = (typeof DASH_PARSE_FAILURES)[number]

export type DashManifest =
  | {
      readonly kind: 'manifest'
      /** `@type="dynamic"` — the manifest is still being extended. */
      readonly live: boolean
      readonly durationSeconds: number | null
      readonly representations: readonly DashRepresentation[]
      readonly drm: DrmStatus
    }
  | { readonly kind: 'invalid'; readonly reason: DashParseFailure }

/**
 * `PT0H3M1.63S` and friends — the xs:duration in `@mediaPresentationDuration`.
 *
 * Years and months are rejected rather than approximated: they have no fixed
 * length, and nothing shorter than a calendar can convert them. No media duration
 * uses them, so returning null costs nothing and guessing 30 days for a month
 * would put a wrong number in front of the user.
 */
const ISO_DURATION =
  /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/

export function parseIsoDuration(value: string): number | null {
  const match = ISO_DURATION.exec(value.trim())
  if (match === null) return null
  const parts = [match[1], match[2], match[3], match[4]]
  // `P`, `PT` and the empty designator all match the pattern with nothing in it.
  if (parts.every((part) => part === undefined)) return null
  const [days, hours, minutes, seconds] = parts.map((part) =>
    part === undefined ? 0 : Number(part)
  )
  return days! * 86400 + hours! * 3600 + minutes! * 60 + seconds!
}

type ProtectedDrm = Extract<DrmStatus, { protected: true }>

/**
 * Registered key-system identifiers, lowercased for comparison.
 *
 * `urn:mpeg:dash:mp4protection:2011` is not a key system but the declaration that
 * the content is encrypted at all — it accompanies the specific ones, and on its
 * own it still means encrypted. It is matched last so a manifest that names
 * Widevine reports Widevine rather than the generic scheme.
 */
const KEY_SYSTEMS: ReadonlyArray<readonly [string, DrmScheme]> = [
  ['edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', 'widevine'],
  ['9a04f079-9840-4286-ab92-e65be0885f95', 'playready'],
  ['94ce86fb-07ff-4f43-adb8-93d2fa968ca2', 'fairplay'],
  ['urn:mpeg:dash:mp4protection:2011', 'cenc']
]

function protectionOf(element: XmlNode): ProtectedDrm {
  const declared = element.attributes['schemeIdUri'] ?? ''
  const needle = declared.toLowerCase()
  const value = element.attributes['value']
  const detail = `schemeIdUri=${declared}${value === undefined ? '' : `, value=${value}`}`
  const known = KEY_SYSTEMS.find(([uuid]) => needle.includes(uuid))
  return { protected: true, scheme: known === undefined ? 'unknown' : known[1], detail }
}

/**
 * Whether the presentation is encrypted, and by what.
 *
 * The presence of a `ContentProtection` element anywhere is the verdict —
 * ISO/IEC 23009-1 puts it on the AdaptationSet or the Representation, and either
 * placement means the same thing for this purpose. A named system is preferred
 * over the generic CENC declaration when both are present, because that is the
 * one worth showing.
 */
function drmOf(root: XmlNode): DrmStatus {
  const found = descendantsNamed(root, 'ContentProtection').map(protectionOf)
  return (
    found.find((status) => status.scheme !== 'cenc' && status.scheme !== 'unknown') ??
    found.find((status) => status.scheme === 'cenc') ??
    found.at(0) ??
    NOT_PROTECTED
  )
}

function toInteger(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Which track a representation carries, or null when it is neither audio nor
 * video.
 *
 * Subtitle and thumbnail AdaptationSets are dropped rather than listed: they are
 * not what "what is this page playing" asks about, and offering `text/vtt` beside
 * the video qualities would make the choice noisier for no gain.
 *
 * `@contentType` is consulted as well as `@mimeType` because a manifest may carry
 * either — 23009-1 defines both, and packagers disagree about which to emit.
 */
function trackOf(attributes: Readonly<Record<string, string>>): MediaTrack | null {
  const mimeType = (attributes['mimeType'] ?? '').toLowerCase()
  const contentType = (attributes['contentType'] ?? '').toLowerCase()
  if (mimeType.startsWith('video/') || contentType === 'video') return 'video'
  if (mimeType.startsWith('audio/') || contentType === 'audio') return 'audio'
  return null
}

function representationsOf(root: XmlNode): readonly DashRepresentation[] {
  const found: DashRepresentation[] = []
  for (const period of childrenNamed(root, 'Period')) {
    for (const set of childrenNamed(period, 'AdaptationSet')) {
      for (const representation of childrenNamed(set, 'Representation')) {
        /*
          Attribute inheritance in one line.

          23009-1 lets the common properties sit on the AdaptationSet and be
          overridden per Representation, and real manifests use that freely:
          `mimeType` and `codecs` on the set, `bandwidth` and the resolution on
          each representation. Merging the two before reading anything means no
          field has to remember to look in both places.
        */
        const attributes = { ...set.attributes, ...representation.attributes }
        const track = trackOf(attributes)
        if (track === null) continue
        found.push({
          id: representation.attributes['id'] ?? null,
          bandwidthBitsPerSecond: toInteger(attributes['bandwidth']),
          width: toInteger(attributes['width']),
          height: toInteger(attributes['height']),
          codecs: attributes['codecs'] ?? null,
          mimeType: attributes['mimeType'] ?? null,
          track,
          language: attributes['lang'] ?? null
        })
      }
    }
  }
  return found
}

/**
 * The presentation's length.
 *
 * `@mediaPresentationDuration` when it is there. A single-Period manifest may
 * instead state the length on the Period, which is common enough in the on-demand
 * profile to be worth the second look.
 */
function durationOf(root: XmlNode): number | null {
  const declared = root.attributes['mediaPresentationDuration']
  if (declared !== undefined) return parseIsoDuration(declared)
  const period = childrenNamed(root, 'Period').at(0)
  const periodDuration = period?.attributes['duration']
  if (periodDuration === undefined) return null
  return parseIsoDuration(periodDuration)
}

export function parseDashManifest(text: string): DashManifest {
  const root = parseXml(text)
  if (root?.name !== 'MPD') return { kind: 'invalid', reason: 'not-an-mpd' }

  const representations = representationsOf(root)
  if (representations.length === 0) return { kind: 'invalid', reason: 'no-representations' }

  return {
    kind: 'manifest',
    live: root.attributes['type'] === 'dynamic',
    durationSeconds: durationOf(root),
    representations,
    drm: drmOf(root)
  }
}
