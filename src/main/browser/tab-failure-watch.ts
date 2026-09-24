import {
  blockSourceOf,
  classifyFailure,
  type BlockSource,
  type TabFailure
} from '@shared/browser/tab-failure.js'

/**
 * The events on one tab's `WebContents` that give it a failure state, and the one that takes it away.
 *
 * Out of `Tab.ts` for the reason `window-events.ts` gives: that file cannot run outside a browser
 * process, so every argument position read here would otherwise be read where no test can put a
 * question to it. What is left there is the call site (KTD21).
 *
 * ## Set, and cleared
 *
 * Set by a main-frame `did-fail-load` or by `render-process-gone`, as `classifyFailure` decides. Cleared
 * by `did-navigate` and by nothing else: Electron emits it only for a main-frame document that committed
 * *and is not an error page*, so it is exactly "the reload worked". A new navigation starting does not
 * clear it — the panel stays until something replaced the failed page, which is what "Neu laden" means.
 *
 * ## And the omnibox's half
 *
 * `certificateRejected` is the other thing a page can get wrong, moved here from `Tab.ts` with its two
 * events: set by `certificate-error` (for any resource, as before), cleared when any navigation starts.
 * It feeds `TabState.security`, not the tile. `changed` fires when it flips too — both flips are rare, and
 * a spare relayout costs less than a second callback through `Tab`.
 */

export interface TabFailureWatchHost {
  readonly webContentsId: number
  /** Subscribes, with the way off registered by the caller (`Tab`'s `on`). */
  on(event: string, handler: (...args: unknown[]) => void): void
  /** The address the view is on, for the host of a crash. */
  url(): string
  /** True while the tab is being unloaded on purpose (U15); absent means never. */
  unloading?(): boolean
}

export interface TabFailureWatch {
  readonly current: TabFailure | undefined
  /** A certificate was rejected since the last navigation started. */
  readonly certificateRejected: boolean
}

/*
  The stage that cancelled a view's last main-frame request, until its `-20` arrives.

  Module-level because the two ends do not share an object: the request pipeline runs per session and
  knows the view only by id, the watch runs per tab. Keyed by `webContentsId`, taken once, and dropped on
  a successful commit, so an entry cannot outlive the navigation it describes; ids are never reused
  within a process, so a view that closes in between leaves one stale number behind at most.
*/
const blockedNavigations = new Map<number, BlockSource>()

/** Called by the request pipeline for every main frame a stage cancelled. */
export function noteBlockedNavigation(webContentsId: number | null, stage: string): void {
  const source = blockSourceOf(stage)
  if (webContentsId === null || source === null) return
  blockedNavigations.set(webContentsId, source)
}

function takeBlockedNavigation(webContentsId: number): BlockSource | null {
  const source = blockedNavigations.get(webContentsId) ?? null
  blockedNavigations.delete(webContentsId)
  return source
}

export function watchTabFailure(host: TabFailureWatchHost, changed: () => void): TabFailureWatch {
  let current: TabFailure | undefined
  let certificateRejected = false

  const set = (next: TabFailure | undefined): void => {
    current = next
    changed()
  }

  // Electron: (event, errorCode, errorDescription, validatedURL, isMainFrame, …).
  host.on('did-fail-load', (...args: unknown[]) => {
    const [, code, , url, isMainFrame] = args
    if (typeof code !== 'number' || isMainFrame !== true) return
    const failure = classifyFailure({
      event: 'did-fail-load',
      code,
      isMainFrame,
      url: typeof url === 'string' ? url : '',
      blockedBy: takeBlockedNavigation(host.webContentsId)
    })
    if (failure !== null) set(failure)
  })

  // Electron: (event, { reason, exitCode }). Precedent: `OverlayLayer`'s own subscription.
  host.on('render-process-gone', (...args: unknown[]) => {
    const details = (args[1] ?? {}) as { reason?: unknown; exitCode?: unknown }
    const failure = classifyFailure({
      event: 'render-process-gone',
      reason: typeof details.reason === 'string' ? details.reason : '',
      exitCode: typeof details.exitCode === 'number' ? details.exitCode : 0,
      url: host.url(),
      unloading: host.unloading?.() ?? false
    })
    if (failure !== null) set(failure)
  })

  host.on('certificate-error', () => {
    if (certificateRejected) return
    certificateRejected = true
    changed()
  })

  host.on('did-start-navigation', () => {
    if (!certificateRejected) return
    certificateRejected = false
    changed()
  })

  host.on('did-navigate', () => {
    blockedNavigations.delete(host.webContentsId)
    if (current !== undefined) set(undefined)
  })

  return {
    get current() {
      return current
    },
    get certificateRejected() {
      return certificateRejected
    }
  }
}
