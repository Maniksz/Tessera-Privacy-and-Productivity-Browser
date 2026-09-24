import type { Session } from 'electron'
import { mediaUrlVerdict } from '@shared/media/url-guard.js'
import type { MediaFindingList } from '@shared/media/wire.js'
import type { ForeignTransfer } from '../downloads/foreign-transfer.js'
import type { ObservedRequest } from '../privacy/RequestPipeline.js'
import type { ObservedResponse } from '../session/hardening.js'
import { MediaService, type MediaTransferRequest } from './MediaService.js'
import type { MediaFetchInit, MediaFetcher } from './fetch.js'

/**
 * One media service per browsing session, and the tab lookup they all share.
 *
 * ## The two things the feature could not work out for itself
 *
 * **Which session.** `MediaService` explains why retrieval must go through the session
 * the media was played in. This is where that is enforced: a service is only reachable by
 * naming a session, so there is no call that could accidentally use the wrong one.
 *
 * **Which tab.** A `webRequest` listener is installed per *session*, and one session
 * serves every tab in a window — four tiles playing four videos are four tabs behind one
 * listener. So an observation carries a web-contents id and something has to map it to a
 * tab. That something is the window registry, and it stays the window registry: this file
 * takes a `hosts()` callback and walks it, rather than importing `webContents` and asking
 * Electron. The difference matters twice over — a store that resolved ids itself would be
 * untestable without a running browser, and it would answer for views that are not tabs
 * at all, such as devtools or the chrome UI.
 */

/**
 * The part of Electron's `Session` this feature uses.
 *
 * Structural rather than the `Session` type itself, so a test can supply a fetcher and
 * nothing else. The assignment at the bottom of this file is what keeps that honest: it
 * fails to compile if Electron's session stops satisfying this shape, which is the only
 * way a structural seam can be trusted.
 */
export interface MediaSession {
  fetch(input: string, init?: MediaFetchInit): Promise<Response>
}

/** What a window can answer about its own tabs. `BrowserWindowController` satisfies it. */
export interface MediaTabHost {
  /** Undefined for an id this window does not hold, including a view already destroyed. */
  tabForWebContents(webContentsId: number): { readonly id: string } | undefined
}

/**
 * Which tab a web-contents id belongs to, across every open window.
 *
 * Total: `null` for no id, for an id no window claims, and for a tab whose view has been
 * destroyed — `tabForWebContents` already skips those, which is what makes a response
 * arriving for a closed tab a dropped observation rather than one attributed to whichever
 * tab happens to be next.
 */
export function tabIdForWebContents(
  hosts: readonly MediaTabHost[],
  webContentsId: number | null
): string | null {
  if (webContentsId === null) return null
  for (const host of hosts) {
    const tab = host.tabForWebContents(webContentsId)
    if (tab !== undefined) return tab.id
  }
  return null
}

/**
 * Retrieval bound to one session.
 *
 * The whole reason `MediaFetcher` has no default: Node's global `fetch` would compile,
 * work, and bypass Chromium's network stack — and with it the session's proxy rule, the DNS
 * settings, and the request pipeline with its kill-switch stage (`main/session/proxy.ts`).
 * `session.fetch` is indistinguishable from the page's own traffic.
 *
 * And guarded (media plan R25): every address the feature asks for — a manifest, a variant, a
 * segment — goes through `url-guard.ts` first, and so does the address a redirect ended at, before
 * a byte of its body is read. The downloader checks a plan whole before writing; this is the line
 * that also holds for the registry's manifest reads and for where the network stack was sent.
 */
export function sessionFetcher(session: MediaSession): MediaFetcher {
  return async (url, init) => {
    refuseLocal(url)
    const response = await session.fetch(url, {
      // Rebuilt rather than forwarded: `exactOptionalPropertyTypes` makes a present
      // `headers: undefined` a different type from an absent one, and passing the first
      // to a fetch implementation is how an empty header set becomes a header named
      // "undefined" in some layer downstream.
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
      ...(init?.signal === undefined ? {} : { signal: init.signal })
    })
    // Empty for a response nobody fetched, which is what a test constructs.
    if (response.url !== '') refuseLocal(response.url)
    return response
  }
}

function refuseLocal(url: string): void {
  const verdict = mediaUrlVerdict(url)
  if (!verdict.ok) throw new Error(`Not fetched for a page: ${verdict.detail}`)
}

/** The two observers a session's request pipeline and hardening call; see `MediaSessions.observe`. */
export interface MediaObservers {
  onRequest(observation: ObservedRequest): void
  onResponse(observation: ObservedResponse): void
}

/** `DownloadManager`, as far as media transfers need it. */
export interface MediaDownloads<S> {
  track(request: MediaTransferRequest & { readonly session: S }): ForeignTransfer | null
  cancel(id: string): boolean
}

export interface MediaSessionsOptions<S extends MediaSession> {
  /** Every window that can answer "which of your tabs owns this view". */
  readonly hosts: () => readonly MediaTabHost[]
  /** `downloads.directory`, empty or relative included. Read per download, so it stays live. */
  readonly directory: () => string
  /** `app.getPath('downloads')`, for a `directory` that is unusable; see `downloadDirectoryOf`. */
  readonly fallbackDirectory?: () => string
  /** Where a media download is filed as an ordinary one (media plan R19). */
  readonly downloads?: MediaDownloads<S>
  readonly now?: () => number
}

/**
 * Generic over the session so the entry point can hand over Electron's and the download manager
 * can take it back: the session is what files a transfer under the right browsing mode.
 */
export class MediaSessions<S extends MediaSession = MediaSession> {
  readonly #options: MediaSessionsOptions<S>
  /**
   * Strong references, deliberately, with `release` as the counterpart.
   *
   * A private session's findings name the addresses a page fetched, which is browsing
   * history by another route — so they have to go when its window does, at a moment
   * something decides, not whenever a garbage collector gets round to it. A `WeakMap`
   * would have made that unobservable and untestable.
   */
  readonly #services = new Map<S, MediaService>()
  readonly #listeners = new Set<(list: MediaFindingList) => void>()

  constructor(options: MediaSessionsOptions<S>) {
    this.#options = options
  }

  /** The service for this session, created on first use. */
  forSession(session: S): MediaService {
    const existing = this.#services.get(session)
    if (existing !== undefined) return existing

    const { downloads, fallbackDirectory, now } = this.#options
    const service = new MediaService({
      fetch: sessionFetcher(session),
      directory: this.#options.directory,
      resolveTabId: (webContentsId) => tabIdForWebContents(this.#options.hosts(), webContentsId),
      ...(fallbackDirectory === undefined ? {} : { fallbackDirectory }),
      ...(downloads === undefined
        ? {}
        : {
            transfers: {
              track: (request) => downloads.track({ ...request, session }),
              cancel: (id) => downloads.cancel(id)
            }
          }),
      ...(now === undefined ? {} : { now })
    })
    // Fanned in here rather than subscribed per service by the caller: a window is created
    // long after the first session, and a subscriber that had to be told about each new
    // session would miss the ones it was not told about.
    service.onChange((list) => {
      for (const listener of [...this.#listeners]) listener(list)
    })
    this.#services.set(session, service)
    return service
  }

  /**
   * Findings for a tab that closed, dropped from whichever session held them.
   *
   * Asked of every service because the caller knows a tab id and not a session. That is
   * safe: tab ids are unique across the browser, so at most one service has anything to
   * forget, and the rest return unchanged state without notifying anyone.
   */
  forgetTab(tabId: string): void {
    for (const service of this.#services.values()) service.forgetTab(tabId)
  }

  /**
   * The observers `WindowRegistry` installs for a session (media plan R1), bound to its service once.
   *
   * Once, because the pipeline and the hardening each install a single listener per session for its
   * whole life. That is also why clearing data calls `forgetAll` rather than `release`: a released
   * service would go on being fed by these, while `forSession` handed out a new, empty one.
   */
  observe(session: S): MediaObservers {
    const service = this.forSession(session)
    return {
      onRequest: (observation) => service.observeRequest(observation),
      onResponse: (observation) => service.observeResponse(observation)
    }
  }

  /**
   * Every finding of `session`, or of every session when none is named, dropped and announced.
   *
   * For clearing browsing data with the cookies, which is per session, and for panic, which is all
   * of them (media plan R5). The services stay: their sessions' observers still feed them.
   */
  forgetAll(session?: S): void {
    for (const [owner, service] of this.#services) {
      if (session === undefined || owner === session) service.forgetAll()
    }
  }

  /** A session that is going away, with everything observed through it: a private window's. */
  release(session: S): void {
    this.#services.delete(session)
  }

  /** How many sessions have been observed. For tests and for a diagnostics surface. */
  get size(): number {
    return this.#services.size
  }

  onChange(listener: (list: MediaFindingList) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}

// Electron's session really does satisfy the seam above.
const _electronSessionIsAMediaSession: MediaSession = null as unknown as Session
void _electronSessionIsAMediaSession
