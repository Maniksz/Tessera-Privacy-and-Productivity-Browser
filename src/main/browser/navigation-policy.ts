import { internalPageOf, isInternalPageUrl } from '../ipc/sender-policy.js'

/**
 * Whether a navigation this browser did not start may go where it is going.
 *
 * ## The hole this closes
 *
 * An internal page is ordinary web content in a sandboxed process, but *which* page a frame is
 * decides which IPC channels it may call, and `sender-policy.ts` reads that from the frame's own
 * address. So a visited site only has to get its own tab to the settings address to end up with a
 * document holding the settings channels — `location.href = …` is enough, no exploit involved, and
 * the whole per-page privilege table is walked around rather than through.
 *
 * `setWindowOpenHandler` in `Tab.ts` already answers `{ action: 'deny' }` to every disposition, which
 * is presumably why this went unnoticed: it closes the one route that is easy to think of and none of
 * the others. A link, a redirect and an assignment to `location` are all still open without this.
 *
 * ## Why a blanket refusal is affordable
 *
 * Electron's own typings settle it. Of `will-navigate`, in `node_modules/electron/electron.d.ts:17491`:
 * *"This event will not emit when the navigation is started programmatically with APIs like
 * `webContents.loadURL` and `webContents.back`."* `will-frame-navigate` repeats the sentence at
 * `:17472`.
 *
 * That is the load-bearing fact, and everything below rests on it. Every navigation the *core* starts
 * goes through `Tab.loadUrl`, which is `webContents.loadURL` — the address bar, `history:open`,
 * `bookmarks:open`, `quicklinks:open`, the Home item, a new tab, a deferred session restore, the
 * reader — and none of them reaches this decision at all. So nothing here has to tell "our own
 * navigation" apart from a page's; ours never arrives. Had it arrived, the alternative would have been
 * a flag set before each `loadUrl` and cleared afterwards, which is a race condition wearing a
 * permission's clothes.
 *
 * ## Why `will-frame-navigate` rather than `will-navigate`
 *
 * `:17468`: *"Unlike `will-navigate`, `will-frame-navigate` is fired when the main frame or any of its
 * subframes attempts to navigate."* It is the documented superset, so it is the only one subscribed.
 * Subscribing to both was the alternative, and it lost on a small thing: every main-frame navigation
 * would then run this decision twice and log two refusals for one attempt, and the next reader would
 * have to satisfy themselves the two copies could never disagree.
 *
 * ## Why a subframe is refused too
 *
 * A subframe could not reach the channels today: `nodeIntegrationInSubFrames` is false in `Tab.ts`, so
 * a subframe gets no preload, and with no preload there is no bridge to hand it. The escalation is
 * genuinely not there. It is refused anyway, for two reasons. The protocol handler would still serve
 * the document, so a site could frame the passwords page and put its own controls over it — a
 * clickjacking surface offered for nothing. And the reason it is safe today is a single boolean: flip
 * that flag and `classifySender` would classify the subframe by its address and grant it the page's
 * channels. Nothing legitimate frames an internal page, so refusing costs nothing and removes the
 * dependency on one option staying right.
 *
 * ## Why a redirect is judged differently
 *
 * A remote server can answer with `Location:` pointing at an internal address, and that arrives as
 * `will-redirect` rather than as a fresh navigation. But so does this browser's own HTTPS-only
 * interstitial: `RequestPipeline` rewrites a top-level `http://` main-frame request to the `https-only`
 * page, and from here that is indistinguishable from a remote redirect. Refusing every internal target
 * on this event would quietly turn HTTPS-only mode off — the setting would still be on and the
 * interstitial would never appear.
 *
 * The lever is that the interstitial carries no privileges. `INTERNAL_PAGES` in `channels.ts` lists the
 * documents that get a bridge, and `https-only` and `about` are deliberately not among them; they are
 * served by `protocol.ts` and receive no IPC channels at all. So a redirect is refused exactly when its
 * target is a page `internalPageOf` recognises — the same function privileges are granted from, so the
 * two answers cannot drift apart. A redirect to an unprivileged internal address is worth no more than
 * the bytes it serves.
 *
 * The alternative was to have `RequestPipeline` mark its own redirects and have this trust the mark.
 * That means inventing a channel between the two that a remote server cannot forge, for the sole
 * purpose of re-deriving something `internalPageOf` already answers correctly.
 *
 * ## Why `initiator` is not consulted
 *
 * The payload carries an `initiator` frame, documented as null *"if the navigation was not initiated by
 * a frame"*, which reads like exactly the question being asked. It is not used, because the two failure
 * directions are not worth the same: a null initiator on a page-initiated navigation would open the
 * hole again, while mistaking a user's own gesture for page content only refuses a navigation the
 * address bar can still perform. A security decision has to fail towards refusing.
 */

/** Which event the attempt arrived on, because the two are not judged alike. */
export type NavigationSource = 'frame' | 'redirect'

/** The three fields of Electron's navigation payload this decision reads, and nothing else. */
export interface NavigationAttempt {
  /** Where the frame is going. */
  url: string
  source: NavigationSource
  /**
   * False for a subframe.
   *
   * Not part of the rule — both are refused — but part of the refusal: "a subframe tried to reach the
   * settings page" and "this tab tried to" are different events to whoever is reading the log.
   */
  isMainFrame: boolean
}

/**
 * An attempt together with the veto that belongs to it.
 *
 * The veto travels with the attempt rather than being read out of the payload a second time at the call
 * site: one read, one place the payload's shape is assumed. `decideTabNavigation` below takes the plain
 * `NavigationAttempt`, so the decision itself is still asked with data alone and a test needs no
 * function to construct one.
 */
export interface PendingNavigation extends NavigationAttempt {
  /** Electron's own `event.preventDefault`, already bound to its event. */
  prevent: () => void
}

/** Why it was refused, for the log and for the tests. The shape `decideAccess` uses. */
export interface NavigationDecision {
  allowed: boolean
  reason: string | null
}

/**
 * A pending navigation read out of Electron's event payload, or `null` for anything that is not one.
 *
 * `unknown` in, for the reason `pageKeystrokeOf` gives one file along: the subscription lives in
 * `Tab.ts`, which cannot run outside a browser process and is excluded from coverage, so narrowing
 * there would be an assertion no test can see.
 *
 * A declaration rather than a cast, again as in `pageKeystrokeOf`: `object` is assignable to a type
 * whose every field is optional, so this narrows without asserting anything the compiler has not
 * checked.
 *
 * Only `url` is a rejection. A payload with no address is not a navigation this can judge, and letting
 * it through as an empty string would put every such event through the internal-scheme test for
 * nothing. `isMainFrame` is read as `=== true` because an absent flag means "not the main frame" and
 * refusing the whole attempt over it would let the navigation proceed — the one outcome this file
 * exists to avoid.
 */
export function pendingNavigationOf(
  details: unknown,
  source: NavigationSource
): PendingNavigation | null {
  if (typeof details !== 'object' || details === null) return null

  const event: { url?: unknown; isMainFrame?: unknown; preventDefault?: () => void } = details
  const { url } = event
  if (typeof url !== 'string') return null

  return {
    url,
    source,
    isMainFrame: event.isMainFrame === true,
    /*
      Called as a method on its own event, so Electron's `preventDefault` sets `defaultPrevented` on the
      object it belongs to. A detached reference would set it on nothing and the navigation would
      proceed while the log said it had been stopped — a refusal that reports success is worse than no
      refusal at all.

      Optional rather than required above: a payload without it yields a veto that does nothing, which
      is the honest outcome for an event shape this build does not recognise. Refusing to build the
      attempt at all would be worse, because then the refusal would never be logged either.
    */
    prevent: () => {
      event.preventDefault?.()
    }
  }
}

/**
 * Whether the tab may follow this navigation.
 *
 * Reads as three lines because the argument is all in the docblock above: anything that is not an
 * internal address is none of this file's business, a redirect is refused only towards a page that
 * carries privileges, and page content is refused towards any internal address whatsoever.
 */
export function decideTabNavigation(attempt: NavigationAttempt): NavigationDecision {
  if (!isInternalPageUrl(attempt.url)) return { allowed: true, reason: null }

  if (attempt.source === 'redirect') {
    // Null here is the HTTPS-only interstitial and the about page: served, but on no privilege list.
    const page = internalPageOf(attempt.url)
    if (page === null) return { allowed: true, reason: null }
    return { allowed: false, reason: `a redirect may not reach the ${page} page (${attempt.url})` }
  }

  const frame = attempt.isMainFrame ? 'the main frame' : 'a subframe'
  return {
    allowed: false,
    reason: `page content in ${frame} may not navigate to an internal address (${attempt.url})`
  }
}
