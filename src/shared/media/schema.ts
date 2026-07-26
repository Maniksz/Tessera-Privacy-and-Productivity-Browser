import { z } from 'zod'
import {
  DOWNLOAD_REFUSALS,
  DRM_SCHEMES,
  MANIFEST_FAILURES,
  MEDIA_CONTAINERS,
  MEDIA_KINDS,
  MEDIA_TRACKS
} from './model.js'
import type { DrmStatus, ManifestState, MediaFinding, MediaVariant } from './model.js'
import type { MediaDownloadReport, MediaFindingList, MediaManifestReport } from './wire.js'

/**
 * Runtime validation for the media channels.
 *
 * Its own file for the reason the rest of this directory is zod-free: the panel that
 * renders a finding list imports the *types*, and a value import of the validation
 * library in that bundle is about half a megabyte of parse work on every window
 * open. An architecture test follows value imports out of `src/renderer` and forbids
 * zod anywhere they reach, so this file may only ever be imported by the contract and
 * the core. See the note at the top of `model.ts`.
 *
 * Every enumeration is built from the constant in `model.ts` rather than restated as a
 * `z.enum([...])` literal — a schema that listed the refusals by hand would go stale
 * the first time one was added, and it would go stale silently, because a value the
 * schema rejects looks to a renderer exactly like a handler that failed.
 *
 * The assignments at the bottom are the guard against the model/schema split becoming
 * a lie: two per shape, one in each direction, the same idiom as
 * `quicklinks/schema.ts`. Arrays are declared `.readonly()` so both directions are
 * expressible at all — the model's arrays are `readonly`, and a mutable array on the
 * schema side would make one of the two assignments impossible to write and quietly
 * halve the check.
 */

const drmStatusSchema = z.discriminatedUnion('protected', [
  z.object({ protected: z.literal(false) }),
  z.object({
    protected: z.literal(true),
    scheme: z.enum(DRM_SCHEMES),
    detail: z.string()
  })
])

export const mediaVariantSchema = z.object({
  id: z.string(),
  url: z.string().nullable(),
  track: z.enum(MEDIA_TRACKS),
  bandwidthBitsPerSecond: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  codecs: z.string().nullable(),
  container: z.enum(MEDIA_CONTAINERS),
  language: z.string().nullable(),
  name: z.string().nullable()
})

export const manifestStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-loaded') }),
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('ready'),
    variants: z.array(mediaVariantSchema).readonly(),
    durationSeconds: z.number().nullable(),
    live: z.boolean(),
    drm: drmStatusSchema
  }),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(MANIFEST_FAILURES),
    detail: z.string()
  })
])

export const mediaFindingSchema = z.object({
  id: z.string(),
  tabId: z.string(),
  url: z.string(),
  documentUrl: z.string().nullable(),
  kind: z.enum(MEDIA_KINDS),
  container: z.enum(MEDIA_CONTAINERS),
  contentType: z.string().nullable(),
  byteLength: z.number().nullable(),
  label: z.string(),
  discoveredAt: z.number(),
  manifest: manifestStateSchema.nullable()
})

export const mediaFindingListSchema = z.object({
  tabId: z.string(),
  findings: z.array(mediaFindingSchema).readonly()
})

export const mediaManifestReportSchema = z.object({
  manifest: manifestStateSchema.nullable(),
  message: z.string().nullable()
})

export const mediaDownloadReportSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    filePath: z.string(),
    byteLength: z.number()
  }),
  z.object({
    ok: z.literal(false),
    refusal: z.enum(DOWNLOAD_REFUSALS),
    message: z.string(),
    detail: z.string()
  })
])

/*
  Requests.

  Each one names a finding and may name a tab. Omitting the tab means "the tab in the
  active tile", which is the default every navigation channel already uses — and it is
  the useful default here for the same reason: the panel is showing what the user is
  looking at, and a renderer that had to track which tab that is would be a second copy
  of state the core already owns.

  Declared here rather than inline in the contract so the *types* are derivable without
  importing zod: `main/ipc/media-handlers.ts` needs the exact shape a validated request
  arrives in, and deriving it from these schemas is what makes the handler signatures and
  the contract impossible to disagree about.
*/
const tabScope = { tabId: z.string().optional() }

export const mediaListRequestSchema = z.object({ ...tabScope })

export const mediaDescribeRequestSchema = z.object({ ...tabScope, findingId: z.string() })

export const mediaDownloadRequestSchema = z.object({
  ...tabScope,
  findingId: z.string(),
  /**
   * Which quality, or null for "decide for me".
   *
   * Null is not the same as absent and both are accepted: absent is a caller that never
   * offered a choice, null is a user who did not make one. Both resolve to the best
   * variant that can actually be assembled — never to the best-looking one, which would
   * hand back a silent video.
   */
  variantId: z.string().nullable().optional()
})

export const mediaCancelRequestSchema = z.object({ ...tabScope, findingId: z.string() })

export type MediaListRequest = z.output<typeof mediaListRequestSchema>
export type MediaDescribeRequest = z.output<typeof mediaDescribeRequestSchema>
export type MediaDownloadRequest = z.output<typeof mediaDownloadRequestSchema>
export type MediaCancelRequest = z.output<typeof mediaCancelRequestSchema>

/** Whether there was a download to stop. See `MediaService.cancel`. */
export const mediaCancelResponseSchema = z.object({ stopped: z.boolean() })
export type MediaCancelResponse = z.output<typeof mediaCancelResponseSchema>

// Keeps each schema and its interface from drifting apart in either direction.
type SchemaVariant = z.output<typeof mediaVariantSchema>
type SchemaManifest = z.output<typeof manifestStateSchema>
type SchemaFinding = z.output<typeof mediaFindingSchema>
type SchemaDrm = z.output<typeof drmStatusSchema>
type SchemaList = z.output<typeof mediaFindingListSchema>
type SchemaReport = z.output<typeof mediaManifestReportSchema>
type SchemaDownload = z.output<typeof mediaDownloadReportSchema>

const _variantMatchesModel: SchemaVariant = null as unknown as MediaVariant
const _modelMatchesVariant: MediaVariant = null as unknown as SchemaVariant
const _drmMatchesModel: SchemaDrm = null as unknown as DrmStatus
const _modelMatchesDrm: DrmStatus = null as unknown as SchemaDrm
const _manifestMatchesModel: SchemaManifest = null as unknown as ManifestState
const _modelMatchesManifest: ManifestState = null as unknown as SchemaManifest
const _findingMatchesModel: SchemaFinding = null as unknown as MediaFinding
const _modelMatchesFinding: MediaFinding = null as unknown as SchemaFinding
const _listMatchesModel: SchemaList = null as unknown as MediaFindingList
const _modelMatchesList: MediaFindingList = null as unknown as SchemaList
const _reportMatchesModel: SchemaReport = null as unknown as MediaManifestReport
const _modelMatchesReport: MediaManifestReport = null as unknown as SchemaReport
const _downloadMatchesModel: SchemaDownload = null as unknown as MediaDownloadReport
const _modelMatchesDownload: MediaDownloadReport = null as unknown as SchemaDownload
void _variantMatchesModel
void _modelMatchesVariant
void _drmMatchesModel
void _modelMatchesDrm
void _manifestMatchesModel
void _modelMatchesManifest
void _findingMatchesModel
void _modelMatchesFinding
void _listMatchesModel
void _modelMatchesList
void _reportMatchesModel
void _modelMatchesReport
void _downloadMatchesModel
void _modelMatchesDownload
