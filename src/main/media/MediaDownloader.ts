import { existsSync } from 'node:fs'
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { parseHlsPlaylist } from '@shared/media/hls.js'
import {
  NOT_PROTECTED,
  bestMuxedVariant,
  variantById,
  type DownloadRefusal,
  type DrmStatus,
  type MediaFinding,
  type MediaTrack
} from '@shared/media/model.js'
import {
  planDownload,
  type DownloadPlan,
  type PlanOutcome,
  type PlannedSegment
} from '@shared/media/plan.js'
import { mediaUrlVerdict } from '@shared/media/url-guard.js'
import { partialFileOf } from '../downloads/foreign-transfer.js'
import {
  MAX_SAVE_PATH_ATTEMPTS,
  downloadDirectoryOf,
  resolveSavePath
} from '../downloads/target-path.js'
import { fetchText, messageOf, type MediaFetchInit, type MediaFetcher } from './fetch.js'

/**
 * Moving the bytes.
 *
 * Two steps, deliberately separate, because they fail for different reasons and the
 * interface has to say which. `prepare` decides whether a download is possible at
 * all — the answer is a plan or a refusal with a reason, and it touches the network
 * only to read the chosen variant's playlist. `run` executes a plan, and can then
 * fail only for reasons of the world: a segment that 404s, a disk that says no, a
 * user who pressed stop.
 *
 * What "finished" means per format is decided in `@shared/media/plan.ts`, which is
 * also where each refusal is justified. In short: progressive files, and HLS whose
 * segments concatenate (MPEG-2 TS, packed audio, or fMP4 with an `#EXT-X-MAP`),
 * come out complete. Encrypted streams, live streams, video-only variants and DASH
 * are refused with a reason rather than half-produced.
 *
 * No ffmpeg, and none bundled either. Interleaving two tracks into one container
 * means rewriting sample tables, and a browser that shipped a pipeline to do it
 * would be shipping the larger half of a media player. The line is "what
 * concatenation can produce", and everything on the far side of it says so out
 * loud instead of handing back a silent video.
 */

export interface MediaDownloaderOptions {
  /** See `MediaFetcher`. Not optional, and not defaulted to the global. */
  readonly fetch: MediaFetcher
  /** Injected, so the timings in a result do not depend on when the test ran. */
  readonly now: () => number
  /**
   * Where files land: `downloads.directory`, which may be empty or relative. Created on first use.
   * Resolved by `downloadDirectoryOf`, the rule every download follows (media plan R23).
   */
  readonly directory: string
  /** `app.getPath('downloads')`, for a `directory` that is unusable. Defaults to `directory`. */
  readonly fallbackDirectory?: string
  readonly maxBytes?: number
  readonly maxSegments?: number
  readonly maxManifestBytes?: number
}

/**
 * Ceilings.
 *
 * Each of these bounds a number chosen by whoever serves the URL, which is why the
 * browser has to choose one too. Twelve gigabytes is past any plausible download
 * and short of filling a disk by accident; twenty thousand segments is eleven hours
 * at two seconds each.
 */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024 * 1024
export const DEFAULT_MAX_SEGMENTS = 20_000
export const DEFAULT_MAX_PLAYLIST_BYTES = 4 * 1024 * 1024

export interface DownloadProgress {
  readonly receivedBytes: number
  /** Known for a progressive download with a `Content-Length`; null for segments. */
  readonly totalBytes: number | null
  readonly completedParts: number
  readonly totalParts: number
}

export interface DownloadOptions {
  readonly onProgress?: (progress: DownloadProgress) => void
  /**
   * The target, once it is reserved and before the first byte is written.
   *
   * Where the caller files the transfer with the downloads list, which needs the path from the start
   * (media plan R19). Not called for a download refused before it had one.
   */
  readonly onTarget?: (targetPath: string) => void
  readonly signal?: AbortSignal
}

interface DownloadFailure {
  readonly ok: false
  readonly refusal: DownloadRefusal
  readonly detail: string
}

export type DownloadResult =
  | {
      readonly ok: true
      readonly filePath: string
      readonly byteLength: number
      readonly startedAt: number
      readonly finishedAt: number
    }
  | DownloadFailure

/** What `#writeParts` can say. The path and the timings belong to `run`. */
type WriteOutcome = { readonly ok: true; readonly byteLength: number } | DownloadFailure

function refuse(refusal: DownloadRefusal, detail: string): DownloadFailure {
  return { ok: false, refusal, detail }
}

/** A `Range` header for a segment that is a sub-range, plus the abort signal. */
function fetchInitFor(part: PlannedSegment, signal: AbortSignal | undefined): MediaFetchInit {
  const range = part.byteRange
  const headers =
    range === null
      ? undefined
      : // HTTP ranges are inclusive at both ends, so the last byte is one less than
        // offset+length. Getting that wrong shifts every subsequent byte, and
        // nothing reports it — the file simply does not play.
        { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
  return {
    ...(headers === undefined ? {} : { headers }),
    ...(signal === undefined ? {} : { signal })
  }
}

/**
 * Read through a function rather than as `signal?.aborted`, and not for taste.
 *
 * `AbortSignal.aborted` is declared readonly, so the compiler narrows it after the
 * first check and then insists a second one can never be true — while in reality
 * it flips whenever the user presses stop, which is the entire point of checking it
 * twice. A call it cannot see through keeps the check meaningful.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}

/** The first address the guard refuses, as a refusal; null when every one may be fetched (R25). */
function refusedAddress(urls: readonly string[]): DownloadFailure | null {
  for (const url of urls) {
    const verdict = mediaUrlVerdict(url)
    if (!verdict.ok) return refuse('address-not-allowed', verdict.detail)
  }
  return null
}

type Reservation =
  { readonly ok: true; readonly target: string; readonly handle: FileHandle } | DownloadFailure

/**
 * Streams a response body through a writer, returning how many bytes went.
 *
 * A reader loop rather than `arrayBuffer()`, because a progressive download is
 * routinely larger than it would be wise to hold in memory. A body of `null` — a
 * `204`, or a server that answered with nothing — takes the buffered path, which
 * for zero bytes costs nothing.
 */
async function pipeBody(
  response: Response,
  write: (chunk: Uint8Array) => Promise<void>
): Promise<number> {
  // Annotated rather than inferred: `Response.body` is declared as a bare
  // `ReadableStream`, whose element type defaults to `any`, and an `any` chunk
  // would flow straight into the file handle unchecked.
  const body: ReadableStream<Uint8Array> | null = response.body
  if (body === null) {
    const buffered = new Uint8Array(await response.arrayBuffer())
    await write(buffered)
    return buffered.byteLength
  }

  const reader = body.getReader()
  let total = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    await write(chunk.value)
    total += chunk.value.byteLength
  }
  return total
}

function contentLengthOf(response: Response): number | null {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  return Number.isFinite(declared) ? declared : null
}

/** The parts of a plan, in the order they have to be written. */
function partsOf(plan: DownloadPlan): readonly PlannedSegment[] {
  if (plan.kind === 'progressive') return [{ url: plan.url, byteRange: null }]
  // The initialisation segment first: it carries `ftyp`+`moov`, and a fragmented
  // MP4 whose header arrives second is not a file.
  const init = plan.initSegment
  return init === null ? plan.segments : [init, ...plan.segments]
}

type HlsChoice =
  { readonly ok: true; readonly playlistUrl: string; readonly track: MediaTrack } | DownloadFailure

export class MediaDownloader {
  readonly #fetch: MediaFetcher
  readonly #now: () => number
  readonly #directory: string
  readonly #fallbackDirectory: string
  readonly #maxBytes: number
  readonly #maxSegments: number
  readonly #maxManifestBytes: number

  constructor(options: MediaDownloaderOptions) {
    this.#fetch = options.fetch
    this.#now = options.now
    this.#directory = options.directory
    this.#fallbackDirectory = options.fallbackDirectory ?? options.directory
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
    this.#maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS
    this.#maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_PLAYLIST_BYTES
  }

  /**
   * Whether this finding can be downloaded, and as what.
   *
   * `variantId` names one of the qualities `MediaRegistry.describe` reported, or
   * null for "decide for me" — which resolves to the best variant that can
   * actually be assembled, never to the best-looking one.
   */
  async prepare(finding: MediaFinding, variantId: string | null): Promise<PlanOutcome> {
    if (finding.kind === 'progressive') {
      return planDownload({
        source: 'progressive',
        url: finding.url,
        container: finding.container
      })
    }

    const declared = this.#declaredDrm(finding)
    if (finding.kind === 'dash') return planDownload({ source: 'dash', drm: declared })

    // A master playlist can declare encryption for the whole presentation with
    // `#EXT-X-SESSION-KEY`, before any media playlist has been read. Checking it
    // here saves a request that could only end in the same refusal.
    if (declared.protected) {
      return refuse('drm-protected', `${declared.scheme}: ${declared.detail}`)
    }

    const chosen = this.#chooseHlsPlaylist(finding, variantId)
    if (!chosen.ok) return chosen
    // A variant's address is the master playlist's choice, and is not asked if it names the local network.
    const refused = refusedAddress([chosen.playlistUrl])
    if (refused !== null) return refused

    const fetched = await fetchText(this.#fetch, chosen.playlistUrl, this.#maxManifestBytes)
    if (!fetched.ok) return refuse('manifest-unavailable', fetched.detail)

    const playlist = parseHlsPlaylist(fetched.text, chosen.playlistUrl)
    if (playlist.kind === 'media' && playlist.segments.length > this.#maxSegments) {
      return refuse(
        'too-large',
        `${playlist.segments.length} segments, ceiling is ${this.#maxSegments}`
      )
    }
    return planDownload({
      source: 'hls',
      playlistUrl: chosen.playlistUrl,
      playlist,
      track: chosen.track
    })
  }

  /** `prepare` then `run`, for the ordinary case where the caller wants both. */
  async download(
    finding: MediaFinding,
    variantId: string | null,
    options: DownloadOptions = {}
  ): Promise<DownloadResult> {
    const prepared = await this.prepare(finding, variantId)
    if (!prepared.ok) return refuse(prepared.refusal, prepared.detail)
    return this.run(prepared.plan, options)
  }

  /**
   * Writes a plan to disk.
   *
   * Into `<name>.part`, renamed on success — the same discipline the stores use.
   * An interrupted download leaves a file whose name says it is incomplete rather
   * than a plausible-looking video that stops halfway through, and a failure
   * removes it so a retry has nothing to reason about.
   *
   * Every address is checked before the first is asked and before anything is written: a playlist
   * that sends its last segment to `127.0.0.1` is refused whole, not after forty seconds of video.
   */
  async run(plan: DownloadPlan, options: DownloadOptions = {}): Promise<DownloadResult> {
    const startedAt = this.#now()
    const refused = refusedAddress(partsOf(plan).map((part) => part.url))
    if (refused !== null) return refused

    const reserved = await this.#reserve(plan.fileName)
    if (!reserved.ok) return reserved
    const { target, handle } = reserved
    const partial = partialFileOf(target)
    options.onTarget?.(target)

    let written: WriteOutcome
    try {
      written = await this.#writeParts(plan, handle, options)
    } finally {
      await handle.close()
    }

    if (!written.ok) {
      try {
        await unlink(partial)
      } catch {
        // The partial could not be removed. The download has already failed for a
        // reason worth reporting, and replacing that reason with this one would
        // hide it.
      }
      return written
    }

    try {
      await rename(partial, target)
    } catch (error) {
      return refuse('write-failed', messageOf(error))
    }
    return {
      ok: true,
      filePath: target,
      byteLength: written.byteLength,
      startedAt,
      finishedAt: this.#now()
    }
  }

  /**
   * A target by the rule every download follows, with its `.part` created before anything else can.
   *
   * The name comes from `resolveSavePath`: sanitised, numbered with `numberedFileName`, inside the
   * directory `downloadDirectoryOf` settles on (R23). A name whose `.part` exists counts as taken,
   * because two downloads from one page routinely share a name — `index.m3u8` from two players is
   * the ordinary case — and two writers on one `.part` interleave their bytes, both succeed, and
   * leave one file that plays for a few seconds.
   *
   * Created with `wx`, so "free" is decided by the file system and not by a look a moment earlier:
   * two downloads starting in the same tick both see the name free, only one creates the file, and
   * the other takes the next name.
   */
  async #reserve(fileName: string): Promise<Reservation> {
    const request = {
      directory: this.#directory,
      fallbackDirectory: this.#fallbackDirectory,
      fileName
    }
    try {
      await mkdir(downloadDirectoryOf(request), { recursive: true })
    } catch (error) {
      return refuse('write-failed', messageOf(error))
    }
    const exists = (path: string): boolean => existsSync(path) || existsSync(partialFileOf(path))
    for (let attempt = 0; attempt < MAX_SAVE_PATH_ATTEMPTS; attempt += 1) {
      const target = resolveSavePath(request, { exists })
      if (target === null) break
      try {
        return { ok: true, target, handle: await open(partialFileOf(target), 'wx') }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          return refuse('write-failed', messageOf(error))
        }
      }
    }
    return refuse('write-failed', 'no free name in the downloads folder')
  }

  /** What the manifest said about encryption, when it has been read at all. */
  #declaredDrm(finding: MediaFinding): DrmStatus {
    const manifest = finding.manifest
    if (manifest?.status !== 'ready') return NOT_PROTECTED
    return manifest.drm
  }

  #chooseHlsPlaylist(finding: MediaFinding, variantId: string | null): HlsChoice {
    const manifest = finding.manifest
    // Not described yet, or described as a media playlist with no variants: the
    // finding's own address *is* the playlist, and it is muxed until it says
    // otherwise.
    if (manifest?.status !== 'ready' || manifest.variants.length === 0) {
      return { ok: true, playlistUrl: finding.url, track: 'muxed' }
    }

    const chosen =
      variantId === null
        ? bestMuxedVariant(manifest.variants)
        : variantById(manifest.variants, variantId)

    if (chosen === null) {
      // Two situations, two answers. An unknown id is a caller mistake; no muxed
      // variant at all is a property of the stream, and what the user needs to
      // hear about then is the audio, not an id.
      return variantId === null
        ? refuse('separate-audio-track', 'every video variant carries video only')
        : refuse('manifest-unavailable', `no variant ${variantId}`)
    }
    if (chosen.url === null) {
      return refuse('manifest-unavailable', `variant ${chosen.id} has no address of its own`)
    }
    return { ok: true, playlistUrl: chosen.url, track: chosen.track }
  }

  async #writeParts(
    plan: DownloadPlan,
    handle: FileHandle,
    options: DownloadOptions
  ): Promise<WriteOutcome> {
    const parts = partsOf(plan)
    const signal = options.signal
    const onProgress = options.onProgress
    let received = 0
    let completed = 0
    let totalBytes: number | null = null

    for (const part of parts) {
      if (isAborted(signal)) return refuse('cancelled', 'stopped before finishing')

      let written: number
      try {
        const response = await this.#fetch(part.url, fetchInitFor(part, signal))
        if (!response.ok) {
          // A hole in the middle is not a download. Stopping at the first failure
          // and naming it beats a file that plays for forty seconds and then stops
          // for no visible reason.
          return refuse('segment-unavailable', `HTTP ${response.status} for ${part.url}`)
        }
        // Only a progressive download has a knowable total. A segment's
        // `Content-Length` describes that segment, and reporting it as the total
        // would show a progress bar that finishes on the first of nine hundred.
        if (plan.kind === 'progressive') totalBytes = contentLengthOf(response)
        written = await pipeBody(response, async (chunk) => {
          await handle.write(chunk)
        })
      } catch (error) {
        /*
          One catch for the retrieval and the write, and the label leans towards
          the network.

          A disk error during the copy lands here too and is reported as a segment
          failure carrying the operating system's message. Telling the two apart
          would mean tagging every write with a wrapper exception, and at this
          point in a download the distinction changes nothing the user can act on —
          whereas `cancelled` does, so that one is separated out.
        */
        return isAborted(signal)
          ? refuse('cancelled', 'stopped while fetching')
          : refuse('segment-unavailable', messageOf(error))
      }

      received += written
      completed += 1
      if (received > this.#maxBytes) {
        return refuse('too-large', `${received} bytes, ceiling is ${this.#maxBytes}`)
      }
      onProgress?.({
        receivedBytes: received,
        totalBytes,
        completedParts: completed,
        totalParts: parts.length
      })
    }

    return { ok: true, byteLength: received }
  }
}
