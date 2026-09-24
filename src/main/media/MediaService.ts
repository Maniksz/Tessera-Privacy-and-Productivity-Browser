import { basename } from 'node:path'
import type { Locale } from '@shared/i18n/catalog.js'
import { manifestFailureSentence, refusalSentence } from '@shared/media/messages.js'
import type {
  MediaDownloadReport,
  MediaFindingList,
  MediaManifestReport
} from '@shared/media/wire.js'
import type { ForeignTransfer, ForeignTransferRequest } from '../downloads/foreign-transfer.js'
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
 * ## Where progress goes
 *
 * To the downloads list, not to the media panel (media plan R19). Once `MediaDownloader` has
 * reserved its target, the transfer is filed with `DownloadManager.track()` under the window
 * that asked, and its progress reports go there — the manager coalesces them, as it does
 * Chromium's, so a per-chunk report is not a per-chunk IPC message. The row's cancel aborts this
 * download, and this download's cancel ends the row.
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
  /** `app.getPath('downloads')`, for an empty or relative `downloads.directory`. */
  readonly fallbackDirectory?: () => string
  /** The downloads list, already bound to this service's session; see `MediaSessions`. */
  readonly transfers?: MediaTransfers
  readonly now?: () => number
}

/** A transfer as this service describes it; the session is added by whoever knows it. */
export type MediaTransferRequest = Omit<ForeignTransferRequest, 'session' | 'pausing'>

/** `DownloadManager`'s two calls, with the session bound. */
export interface MediaTransfers {
  track(request: MediaTransferRequest): ForeignTransfer | null
  cancel(id: string): boolean
}

interface RunningDownload {
  /** Through the downloads row once it has one, so both say "cancelled"; else the abort alone. */
  readonly stop: () => void
  readonly report: Promise<MediaDownloadReport>
}

export class MediaService {
  readonly #registry: MediaRegistry
  readonly #fetch: MediaFetcher
  readonly #now: () => number
  readonly #directory: () => string
  readonly #fallbackDirectory: (() => string) | undefined
  readonly #transfers: MediaTransfers | undefined
  /** In flight, keyed by finding, so a second click joins the first rather than racing it. */
  readonly #downloads = new Map<string, RunningDownload>()

  constructor(options: MediaServiceOptions) {
    this.#fetch = options.fetch
    this.#now = options.now ?? Date.now
    this.#directory = options.directory
    this.#fallbackDirectory = options.fallbackDirectory
    this.#transfers = options.transfers
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
   *
   * `windowId` is the window the request came from; the downloads row is filed under it. Without
   * one the file is still written, and no row says so.
   */
  async download(
    tabId: string,
    findingId: string,
    variantId: string | null,
    locale: Locale,
    windowId?: number
  ): Promise<MediaDownloadReport> {
    const joined = this.#downloads.get(findingId)
    if (joined !== undefined) return joined.report

    const finding = this.#registry.finding(tabId, findingId)
    if (finding === null) throw new UnknownMediaFindingError(findingId)

    const controller = new AbortController()
    const transfers = this.#transfers
    let transfer: ForeignTransfer | null = null
    // Built per download, so `downloads.directory` is read now rather than at startup.
    const downloader = new MediaDownloader({
      fetch: this.#fetch,
      now: this.#now,
      directory: this.#directory(),
      ...(this.#fallbackDirectory === undefined
        ? {}
        : { fallbackDirectory: this.#fallbackDirectory() })
    })
    const report = downloader
      .download(finding, variantId, {
        signal: controller.signal,
        onTarget: (targetPath) => {
          if (windowId === undefined || transfers === undefined) return
          transfer = transfers.track({
            windowId,
            url: finding.url,
            fileName: basename(targetPath),
            targetPath,
            cancel: () => controller.abort()
          })
        },
        onProgress: (progress) => transfer?.progress(progress)
      })
      .then((result) => {
        // After the row's own cancel both are ignored; it already reads "cancelled".
        if (result.ok) transfer?.complete()
        else transfer?.fail()
        return reportOf(result, locale)
      })
    // The row's cancel aborts this download, so going through it ends both the same way.
    const stop = (): void => {
      if (transfer !== null && transfers !== undefined) transfers.cancel(transfer.id)
      else controller.abort()
    }
    this.#downloads.set(findingId, { stop, report })
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
    running.stop()
    return true
  }

  /** For a tab that closed. Navigation is handled by the registry's own mainFrame rule. */
  forgetTab(tabId: string): void {
    this.#registry.forgetTab(tabId)
  }

  /** Every finding, each tab told. For clearing browsing data and for panic (media R5). */
  forgetAll(): void {
    this.#registry.forgetAll()
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
