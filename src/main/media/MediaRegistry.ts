import { parseDashManifest, type DashRepresentation } from '@shared/media/dash.js'
import { classifyMediaRequest, normalizeContentType } from '@shared/media/detect.js'
import {
  MAX_FINDINGS_PER_TAB,
  emptyMediaFindings,
  findFinding,
  findingsForTab,
  forgetTabFindings,
  recordMediaFinding,
  setManifestState,
  type MediaFindingsState
} from '@shared/media/findings.js'
import { parseHlsPlaylist, type HlsPlaylist } from '@shared/media/hls.js'
import {
  sortVariantsByQuality,
  type ManifestState,
  type MediaFinding,
  type MediaVariant
} from '@shared/media/model.js'
import { fetchText, type MediaFetcher } from './fetch.js'

/**
 * What every tab is playing, assembled from the traffic the browser already makes.
 *
 * ## Where the observations come from
 *
 * From the one interception point in `src/main/privacy/RequestPipeline.ts`, through
 * an observation hook, and from nowhere else. Electron keeps a *single* listener
 * per `webRequest` event — a second registration silently replaces the first — so a
 * media detector that registered its own `onBeforeRequest` would not add a stage,
 * it would delete the ad blocker. An architecture test counts the registrations for
 * exactly that reason. This class therefore has no Electron import at all: it is
 * fed, it does not subscribe.
 *
 * Two hooks, because one moment does not have both facts. `onBeforeRequest` knows
 * the address and the resource type; the `Content-Type` exists only when response
 * headers come back. The second is what finds the ordinary case of an `.mp4` behind
 * an extension-less CDN address, and `findings.ts` folds the two views of one
 * address into one finding.
 *
 * ## Per tab, and gone when the page goes
 *
 * A `webRequest` listener is installed per *session*, and one session serves every
 * tab in a window — including four tiles playing four different videos. The
 * observation therefore carries a `webContentsId`, and `resolveTabId` maps it to
 * the tab that owns it; a request that belongs to no known tab is dropped rather
 * than attributed to a guess.
 *
 * A top-level document request for a tab is taken as that tab leaving its page, and
 * its findings go at that moment. The alternative — subscribing to navigation
 * events — would need this class to know about `Tab`, and it would still be the same
 * signal one step later.
 *
 * ## Manifests are parsed on demand
 *
 * Noticing a playlist costs nothing; *reading* it is a second request to an address
 * the page already asked for. Doing that eagerly for every manifest on a page with
 * four players would double that traffic for a panel the user may never open, so
 * `describe()` is what triggers it, and a finding sits at `not-loaded` until
 * someone asks.
 */

export interface MediaRequestObservation {
  readonly url: string
  /** Electron's resource type: `mainFrame`, `media`, `xhr`, … */
  readonly resourceType: string
  /** The document the request belongs to, when known. */
  readonly documentUrl: string | null
  /** `details.webContents?.id`, which is how the request is attributed to a tab. */
  readonly webContentsId: number | null
}

export interface MediaResponseObservation extends MediaRequestObservation {
  /** Raw header value; parameters and casing are dealt with here. */
  readonly contentType: string | null
  /** From `Content-Length`, when the server sent a usable one. */
  readonly contentLength: number | null
  readonly statusCode: number
}

export interface MediaRegistryOptions {
  /** See `MediaFetcher`. Deliberately not optional and deliberately not defaulted. */
  readonly fetch: MediaFetcher
  /** Injected so a finding's timestamp does not depend on when the test ran. */
  readonly now: () => number
  /**
   * Which tab owns a web contents.
   *
   * Supplied by the wiring, because the tab registry is the only thing that knows.
   * Returning null for an unknown id is expected and correct — a request from a
   * devtools window or a view being torn down belongs to no tab.
   */
  readonly resolveTabId: (webContentsId: number | null) => string | null
  readonly maxFindingsPerTab?: number
  readonly maxManifestBytes?: number
}

/**
 * Largest manifest body read.
 *
 * A media playlist for a three-hour film with two-second segments is a few hundred
 * kilobytes; four megabytes is far past anything legitimate. The ceiling exists
 * because the length is chosen by whoever serves the URL, and "parse whatever
 * arrives" is how a page turns a click into an out-of-memory crash.
 */
export const DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export interface MediaRegistryDiagnostics {
  /** Observations that threw. Non-zero means the wiring is handing over bad data. */
  readonly failedObservations: number
  readonly manifestsLoaded: number
}

type ChangeListener = (tabId: string, findings: readonly MediaFinding[]) => void

function variantsFromMaster(playlist: Extract<HlsPlaylist, { kind: 'master' }>): MediaVariant[] {
  const streams = playlist.variants.map((stream, index) => ({
    id: `v${index}`,
    url: stream.url,
    // The `AUDIO` attribute is the whole verdict on whether this can be
    // downloaded: it says the audio lives in a separate rendition.
    track: stream.audioGroupId === null ? ('muxed' as const) : ('video' as const),
    // `BANDWIDTH` is mandatory and is the peak rate; `AVERAGE-BANDWIDTH` is
    // optional. Preferring the mandatory one and falling back keeps a number in
    // front of the user for playlists that omit either.
    bandwidthBitsPerSecond: stream.bandwidthBitsPerSecond ?? stream.averageBandwidthBitsPerSecond,
    width: stream.width,
    height: stream.height,
    codecs: stream.codecs,
    // Not knowable from a master playlist; the media playlist decides it.
    container: 'unknown' as const,
    language: null,
    name: null
  }))

  /*
    Audio renditions are offered as their own qualities, and that is not a
    consolation prize.

    An alternative-audio playlist is self-contained, so it is one of the few things
    on a page with separate tracks that *can* be downloaded to a complete file. A
    user who wants the German commentary track, or the audio of a talk, gets it —
    while the video variants beside it are refused with a reason.
  */
  const audio = playlist.renditions
    .filter((rendition) => rendition.type === 'AUDIO')
    .map((rendition, index) => ({
      id: `a${index}`,
      url: rendition.url,
      track: 'audio' as const,
      bandwidthBitsPerSecond: null,
      width: null,
      height: null,
      codecs: null,
      container: 'unknown' as const,
      language: rendition.language,
      name: rendition.name
    }))

  return [...streams, ...audio]
}

function variantsFromDash(representations: readonly DashRepresentation[]): MediaVariant[] {
  return representations.map((representation, index) => ({
    id: `r${index}`,
    // No single address exists: a representation is assembled from a segment
    // template. Null says so rather than putting a URL in the interface that
    // leads nowhere.
    url: null,
    track: representation.track,
    bandwidthBitsPerSecond: representation.bandwidthBitsPerSecond,
    width: representation.width,
    height: representation.height,
    codecs: representation.codecs,
    container: 'unknown' as const,
    language: representation.language,
    name: representation.id
  }))
}

function manifestFromHls(text: string, url: string): ManifestState {
  const playlist = parseHlsPlaylist(text, url)
  if (playlist.kind === 'invalid') {
    return playlist.reason === 'not-a-playlist'
      ? { status: 'failed', reason: 'not-a-manifest', detail: 'no #EXTM3U on the first line' }
      : { status: 'failed', reason: 'no-variants', detail: 'neither a variant nor a segment' }
  }
  if (playlist.kind === 'master') {
    return {
      status: 'ready',
      variants: sortVariantsByQuality(variantsFromMaster(playlist)),
      // A master playlist states neither; its variants do.
      durationSeconds: null,
      live: false,
      drm: playlist.drm
    }
  }
  return {
    status: 'ready',
    // Empty means "one quality, at the finding's own address". A media playlist
    // found directly is exactly that, and inventing a single variant for it would
    // put a redundant choice in front of the user.
    variants: [],
    durationSeconds: playlist.durationSeconds,
    live: playlist.live,
    drm: playlist.drm
  }
}

function manifestFromDash(text: string): ManifestState {
  const manifest = parseDashManifest(text)
  if (manifest.kind === 'invalid') {
    return manifest.reason === 'not-an-mpd'
      ? { status: 'failed', reason: 'not-a-manifest', detail: 'no MPD element' }
      : { status: 'failed', reason: 'no-variants', detail: 'no audio or video representation' }
  }
  return {
    status: 'ready',
    variants: sortVariantsByQuality(variantsFromDash(manifest.representations)),
    durationSeconds: manifest.durationSeconds,
    live: manifest.live,
    drm: manifest.drm
  }
}

export class MediaRegistry {
  readonly #fetch: MediaFetcher
  readonly #now: () => number
  readonly #resolveTabId: (webContentsId: number | null) => string | null
  readonly #maxFindingsPerTab: number
  readonly #maxManifestBytes: number

  #state: MediaFindingsState = emptyMediaFindings()
  #sequence = 0
  #failedObservations = 0
  #manifestsLoaded = 0
  readonly #listeners = new Set<ChangeListener>()
  /** In-flight manifest loads, keyed by finding id, so a second ask joins the first. */
  readonly #loading = new Map<string, Promise<ManifestState>>()

  constructor(options: MediaRegistryOptions) {
    this.#fetch = options.fetch
    this.#now = options.now
    this.#resolveTabId = options.resolveTabId
    this.#maxFindingsPerTab = options.maxFindingsPerTab ?? MAX_FINDINGS_PER_TAB
    this.#maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES
  }

  get diagnostics(): MediaRegistryDiagnostics {
    return {
      failedObservations: this.#failedObservations,
      manifestsLoaded: this.#manifestsLoaded
    }
  }

  /**
   * A request the pipeline let through.
   *
   * Called from inside `session.webRequest.onBeforeRequest`, which means it runs
   * before a `callback` the page is waiting on. An exception here would stall that
   * request and look like a page that never loads, so the whole body is guarded —
   * a media panel that misses an entry is a small failure, and a browser that
   * cannot load a page is not.
   */
  observeRequest(observation: MediaRequestObservation): void {
    this.#guard(() => {
      const tabId = this.#resolveTabId(observation.webContentsId)
      if (tabId === null) return

      // A top-level document request means this tab is leaving its page. What the
      // old page was playing is no longer on offer.
      if (observation.resourceType === 'mainFrame') {
        this.forgetTab(tabId)
        return
      }
      this.#record(tabId, observation, null, null)
    })
  }

  /** Response headers for a request that was let through. */
  observeResponse(observation: MediaResponseObservation): void {
    this.#guard(() => {
      const tabId = this.#resolveTabId(observation.webContentsId)
      if (tabId === null) return
      // An error page is not media, whatever its address ends in. Offering a
      // download of a 404 body is worse than offering nothing.
      if (observation.statusCode >= 400) return
      this.#record(
        tabId,
        observation,
        normalizeContentType(observation.contentType),
        observation.contentLength
      )
    })
  }

  /** In discovery order. Empty for a tab that is playing nothing. */
  findingsFor(tabId: string): readonly MediaFinding[] {
    return findingsForTab(this.#state, tabId)
  }

  finding(tabId: string, findingId: string): MediaFinding | null {
    return findFinding(this.#state, tabId, findingId)
  }

  /**
   * Loads and parses a finding's manifest, once.
   *
   * Idempotent in the way that matters: a ready or failed result is returned as it
   * stands, and two callers arriving while a load is in flight share the one
   * request rather than making two. A progressive finding has no manifest, and
   * saying so through the return value keeps the caller from having to know which
   * kinds have one.
   */
  async describe(tabId: string, findingId: string): Promise<ManifestState | null> {
    const finding = this.finding(tabId, findingId)
    if (finding === null) return null
    if (finding.manifest === null) return null
    if (finding.manifest.status !== 'not-loaded') {
      const inFlight = this.#loading.get(findingId)
      return inFlight ?? finding.manifest
    }

    const load = this.#load(finding)
    this.#loading.set(findingId, load)
    this.#apply(tabId, setManifestState(this.#state, tabId, findingId, { status: 'pending' }))
    try {
      const manifest = await load
      this.#apply(tabId, setManifestState(this.#state, tabId, findingId, manifest))
      return manifest
    } finally {
      this.#loading.delete(findingId)
    }
  }

  /** Everything this tab found, discarded. For navigation and for closing a tab. */
  forgetTab(tabId: string): void {
    this.#apply(tabId, forgetTabFindings(this.#state, tabId))
  }

  onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Settles once no manifest load is outstanding.
   *
   * Exists for tests and for shutdown: without it a test would have to sleep, and a
   * sleep in a test is a flake with a delay built in.
   */
  async whenIdle(): Promise<void> {
    while (this.#loading.size > 0) {
      // `allSettled`: a failed load is a result, not a reason to reject here.
      await Promise.allSettled([...this.#loading.values()])
    }
  }

  #guard(action: () => void): void {
    try {
      action()
    } catch {
      // Counted rather than logged: this runs on every request, and a per-request
      // log line for a systematic fault would flood the terminal. The count is on
      // `diagnostics`, where a test can assert on it.
      this.#failedObservations += 1
    }
  }

  #record(
    tabId: string,
    observation: MediaRequestObservation,
    contentType: string | null,
    contentLength: number | null
  ): void {
    const candidate = classifyMediaRequest({
      url: observation.url,
      resourceType: observation.resourceType,
      contentType
    })
    if (candidate === null) return

    const finding: MediaFinding = {
      id: `media-${(this.#sequence += 1)}`,
      tabId,
      url: observation.url,
      documentUrl: observation.documentUrl,
      kind: candidate.kind,
      container: candidate.container,
      contentType,
      byteLength: contentLength,
      label: candidate.label,
      discoveredAt: this.#now(),
      manifest: candidate.kind === 'progressive' ? null : { status: 'not-loaded' }
    }
    this.#apply(tabId, recordMediaFinding(this.#state, finding, this.#maxFindingsPerTab))
  }

  /**
   * Installs a new state and wakes the listeners, but only if it *is* new.
   *
   * The identity check is the whole reason `findings.ts` returns the same object
   * when nothing changed: a player re-requesting its playlist on every seek would
   * otherwise redraw the interface dozens of times a minute with the same list.
   */
  #apply(tabId: string, next: MediaFindingsState): void {
    if (next === this.#state) return
    this.#state = next
    const findings = findingsForTab(next, tabId)
    for (const listener of [...this.#listeners]) listener(tabId, findings)
  }

  /**
   * Retrieves and parses one manifest.
   *
   * Takes no tab id, and that is deliberate: `setManifestState` drops a result
   * whose finding is gone, so a navigation during the load is handled by the
   * write rather than by a check here that could only race it.
   */
  async #load(finding: MediaFinding): Promise<ManifestState> {
    const fetched = await fetchText(this.#fetch, finding.url, this.#maxManifestBytes)
    if (!fetched.ok) {
      return {
        status: 'failed',
        reason: fetched.tooLarge ? 'too-large' : 'unreachable',
        detail: fetched.detail
      }
    }

    this.#manifestsLoaded += 1
    return finding.kind === 'hls'
      ? manifestFromHls(fetched.text, finding.url)
      : manifestFromDash(fetched.text)
  }
}
