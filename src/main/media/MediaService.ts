import type { Locale } from '@shared/i18n/catalog.js'
import { manifestFailureSentence, refusalSentence } from '@shared/media/messages.js'
import type {
  MediaDownloadReport,
  MediaFindingList,
  MediaManifestReport
} from '@shared/media/wire.js'
import type { ObservedRequest } from '../privacy/RequestPipeline.js'
import type { ObservedResponse } from '../session/hardening.js'
import { MediaDownloader, type DownloadResult } from './MediaDownloader.js'
import { MediaRegistry } from './MediaRegistry.js'
import type { MediaFetcher } from './fetch.js'
import { mediaResponseObservation } from './observation.js'

/**
 * The media feature for one browsing session, assembled.
 *
 * Everything below the seams is already built and tested: `MediaRegistry` decides what
 * a tab is playing, `MediaDownloader` moves the bytes, and `@shared/media/**` holds the
 * pure decisions both are made of. What this class adds is the three things none of them
 * may hold — the network, the locale and the identity of a tab — and the two states that
 * only exist once a user is involved: a download in flight, and a second click on the
 * same one.
 *
 * ## Why one of these per session and not one per browser
 *
 * Because of the fetcher. Retrieval goes through `session.fetch`, and *which* session is
 * a privacy decision rather than a detail: reading a private window's playlist through
 * the default session would send that profile's cookies to a host the user deliberately
 * visited in a window whose whole purpose is that it cannot be linked to them. It would
 * also fail on most authenticated streams, so the bug would be reported as "downloads do
 * not work in private windows" and fixed by whoever noticed — with the leak still in
 * place. One service per session makes the correct answer the only expressible one; see
 * `MediaSessions`.
 *
 * ## Why the locale is a parameter
 *
 * A refusal has to reach the user as a sentence, and the rule on this boundary is that the
 * core writes it: an enumeration crosses already translated, because the alternative is a
 * mapping table in every renderer that renders one — see `shared/media/wire.ts`. But the
 * locale belongs to the settings store, and a media service that read settings would need
 * them injected for the sake of one string — so the caller, which is the IPC layer that
 * has settings anyway, passes it in per call. That also means a language change applies to
 * the next refusal rather than to the next restart.
 *
 * ## Not here yet: progress
 *
 * `MediaDownloader` reports progress and nothing consumes it. Publishing it needs
 * coalescing — a per-chunk event is thousands of IPC messages for one file — and a
 * downloads surface to render it. Wiring an uncoalesced event now would be the kind of
 * "it works on my machine" that is only visible on the hardware this browser is aimed at.
 */

/** A tab named a request cannot be attributed to. Distinct from a refusal, which is a decision. */
export class UnknownMediaFindingError extends Error {
  constructor(findingId: string) {
    super(`No media finding ${findingId} in this tab`)
    this.name = 'UnknownMediaFindingError'
  }
}

export interface MediaServiceOptions {
  /** See `MediaFetcher`: session-bound, never the global. `MediaSessions` supplies it. */
  readonly fetch: MediaFetcher
  /**
   * Where downloads land, read per download rather than captured.
   *
   * `downloads.directory` is a live setting, and a downloader constructed once at startup
   * would keep writing to the old folder until the browser restarted — a setting that
   * silently does nothing is the failure spec 5 forbids.
   */
  readonly directory: () => string
  /**
   * Which tab owns a web contents.
   *
   * The registry refuses to answer this itself and the reason is worth restating: a store
   * that reached for `webContents.fromId` would be a data structure with an Electron
   * dependency, untestable without a browser, and it would still be guessing — only the
   * window registry knows which of its tabs holds a view. So the answer comes in as a
   * callback from the wiring, and `null` for an unknown id is a correct answer rather
   * than a failure: devtools, a view being torn down, and a session-level fetch all
   * belong to no tab.
   */
  readonly resolveTabId: (webContentsId: number | null) => string | null
  readonly now?: () => number
}

interface RunningDownload {
  readonly controller: AbortController
  readonly report: Promise<MediaDownloadReport>
}

export class MediaService {
  readonly #registry: MediaRegistry
  readonly #fetch: MediaFetcher
  readonly #now: () => number
  readonly #directory: () => string
  /** In flight, keyed by finding, so a second click joins the first rather than racing it. */
  readonly #downloads = new Map<string, RunningDownload>()

  constructor(options: MediaServiceOptions) {
    this.#fetch = options.fetch
    this.#now = options.now ?? Date.now
    this.#directory = options.directory
    this.#registry = new MediaRegistry({
      fetch: options.fetch,
      now: this.#now,
      resolveTabId: options.resolveTabId
    })
  }

  /** From `PipelineHooks.onRequest`, straight through: the shapes are the same by assertion. */
  observeRequest(observation: ObservedRequest): void {
    this.#registry.observeRequest(observation)
  }

  /** From `HardeningOptions.onResponse`, via the header lookup in `observation.ts`. */
  observeResponse(observation: ObservedResponse): void {
    this.#registry.observeResponse(mediaResponseObservation(observation))
  }

  list(tabId: string): MediaFindingList {
    return { tabId, findings: this.#registry.findingsFor(tabId) }
  }

  /**
   * Reads a manifest, once, and says why in words if it could not be read.
   *
   * The `null` manifest is two situations that need no distinction here: a progressive
   * file has none, and a finding that is gone has none either. Both mean "there are no
   * qualities to choose from", which is what the caller asked.
   */
  async describe(tabId: string, findingId: string, locale: Locale): Promise<MediaManifestReport> {
    const manifest = await this.#registry.describe(tabId, findingId)
    return {
      manifest,
      message:
        manifest?.status === 'failed' ? manifestFailureSentence(locale, manifest.reason) : null
    }
  }

  /**
   * Produces a file, or a refusal the interface can read out.
   *
   * A second call for the same finding joins the first instead of starting a second
   * download. Two downloads of one video would race for the same `.part` file and
   * interleave their bytes into it — and the user who double-clicked would get one
   * corrupt file and no error, because both writes succeed.
   *
   * Throws for a finding this tab does not have. That is not a refusal: every value in
   * `DOWNLOAD_REFUSALS` is a decision about media that exists, and answering "you named
   * something that is not here" with one of them would put a sentence about encryption
   * or muxers in front of a user whose tab merely navigated mid-click.
   */
  async download(
    tabId: string,
    findingId: string,
    variantId: string | null,
    locale: Locale
  ): Promise<MediaDownloadReport> {
    const joined = this.#downloads.get(findingId)
    if (joined !== undefined) return joined.report

    const finding = this.#registry.finding(tabId, findingId)
    if (finding === null) throw new UnknownMediaFindingError(findingId)

    const controller = new AbortController()
    // Built per download, so `downloads.directory` is read now rather than at startup.
    const downloader = new MediaDownloader({
      fetch: this.#fetch,
      now: this.#now,
      directory: this.#directory()
    })
    const report = downloader
      .download(finding, variantId, { signal: controller.signal })
      .then((result) => reportOf(result, locale))
    this.#downloads.set(findingId, { controller, report })
    try {
      return await report
    } finally {
      this.#downloads.delete(findingId)
    }
  }

  /**
   * Stops a download in flight.
   *
   * Answers whether there was one, rather than throwing when there was not: the user
   * pressing stop as a download finishes is a race the interface should not have to win.
   */
  cancel(findingId: string): boolean {
    const running = this.#downloads.get(findingId)
    if (running === undefined) return false
    running.controller.abort()
    return true
  }

  /** For a tab that closed. Navigation is handled by the registry's own mainFrame rule. */
  forgetTab(tabId: string): void {
    this.#registry.forgetTab(tabId)
  }

  onChange(listener: (list: MediaFindingList) => void): () => void {
    return this.#registry.onChange((tabId, findings) => {
      listener({ tabId, findings })
    })
  }

  /** Settles once no manifest read is outstanding. For tests and for shutdown. */
  whenIdle(): Promise<void> {
    return this.#registry.whenIdle()
  }
}

function reportOf(result: DownloadResult, locale: Locale): MediaDownloadReport {
  return result.ok
    ? { ok: true, filePath: result.filePath, byteLength: result.byteLength }
    : {
        ok: false,
        refusal: result.refusal,
        // The code stays alongside the sentence: the interface branches on `cancelled`
        // rather than showing it as a failure, and it can only do that on the value.
        message: refusalSentence(locale, result.refusal),
        detail: result.detail
      }
}
