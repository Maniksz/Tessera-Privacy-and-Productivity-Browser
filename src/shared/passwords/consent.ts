/**
 * Where the permission to fill a password comes from, and how long it is worth anything.
 *
 * ## Why this is its own file, and its own type
 *
 * `decideFill` used to take a bare `lastGestureAt: number | null`, which said "an input event in the
 * page view, at this time" and could say nothing else. That was the whole of the fill trigger, and it
 * had one producer — and that producer sat *behind* the offer, which the same rule refused. No
 * gesture, no offer; no offer, no listener; no listener, no gesture. The feature could not fill
 * anything, ever, and nothing failed. A single untyped number is what let a circle like that be
 * written: there was nowhere to put a second producer except a second code path, and a second code
 * path around a security rule is the thing this whole area is built to refuse.
 *
 * So consent is a value with a named source. Two producers, one rule, and every other rule in
 * `fill-policy.ts` untouched.
 *
 * ## The two sources, and why the second one has to be one-shot
 *
 * **A page-view input event** is the original, and it stays exactly as it was: the browser process
 * saw a real press in this view, within `FILL_GESTURE_WINDOW_MS`. Nothing the renderer says produces
 * one — see `gesture.ts`.
 *
 * **An action in browser chrome** — a toolbar button, a shortcut, a context-menu item — cannot be
 * shown as a page-view input event, because it is not one: it happens in a view the page cannot
 * reach and does not touch the page's input pipeline at all. Its proof is its provenance. But
 * provenance alone would be permanent: once granted, the view would satisfy `no-user-gesture` for
 * good, and a hidden form could be filled minutes later by a page that simply waited. So a chrome
 * consent is minted **for one request**, carries that request's id, and holds only while the core
 * still has that exact request open. The core discards the request when it is answered, when the
 * surface leaves the overlay layer, when the view navigates its main frame, when the vault locks and
 * when the view is forgotten — and the first authorised fill spends it.
 *
 * Overlay input is deliberately *not* a page-view gesture, and the distinction is the reason this
 * file says "page-input" rather than "input": the overlay view carries every surface kind there is,
 * so counting typing in the find bar or an answer to a permission prompt as consent would hold the
 * window open for the page underneath, continuously, for as long as the user used the browser.
 *
 * ## Why it is here rather than in `fill-policy.ts`
 *
 * The preload and the renderer may both reach this file; neither may reach the public-suffix table
 * that `fill-policy.ts` imports. Same split as `wire.ts`, for the same measured reason.
 */

/**
 * How long after a real input event a fill still counts as user-initiated.
 *
 * Long enough that clicking our own suggestion is inside the window even on a slow machine,
 * short enough that a page cannot bank a gesture from a minute ago and spend it later on a
 * form the user never touched.
 */
export const FILL_GESTURE_WINDOW_MS = 5_000

/**
 * The browser's own reason for believing the user asked for this fill.
 *
 * Never built from anything a renderer sent: `page-input` is timed by the core from Electron's
 * `input-event`, and `chrome-action` is minted by the core when it opens a request of its own.
 */
export type FillConsent =
  /** The browser process saw a press in this page view, at `at`. */
  | { readonly source: 'page-input'; readonly at: number }
  /** The user acted in browser chrome, and this is the request that action opened. */
  | { readonly source: 'chrome-action'; readonly requestId: string }

/** What the core knows about a view when it comes to decide whether consent exists. */
export interface ConsentRecord {
  /** When the core last saw a real input event in this view, or `null` for never. */
  readonly lastGestureAt: number | null
  /** The chrome-side fill request open for this view, or `null` when there is none. */
  readonly openRequestId: string | null
}

/** The moment a consent is being weighed at, and what the core still holds open. */
export interface ConsentMoment {
  readonly now: number
  /** The chrome-side request open for this view *now*, which a chrome consent must still match. */
  readonly openRequestId: string | null
}

function pageInputHolds(at: number, now: number): boolean {
  if (now - at > FILL_GESTURE_WINDOW_MS) return false
  // A gesture timestamp in the future is a clock that moved — an NTP correction, a resumed laptop —
  // and not a gesture. Treating it as one would make the window unbounded.
  if (at > now) return false
  return true
}

/**
 * Whether this consent still authorises anything, at this moment.
 *
 * The only reader of a `FillConsent`, so the two sources cannot be weighed by two different rules.
 * A chrome consent is checked against the request the core has open *now* rather than trusted for
 * the id it carries: that is what makes it one-shot rather than a token a renderer could replay,
 * and it is why a forged `{ source: 'chrome-action' }` value buys nothing.
 */
export function consentHolds(consent: FillConsent | null, moment: ConsentMoment): boolean {
  if (consent === null) return false
  if (consent.source === 'page-input') return pageInputHolds(consent.at, moment.now)
  return moment.openRequestId !== null && moment.openRequestId === consent.requestId
}

/**
 * The consent a view has right now, or `null`.
 *
 * A live page-view gesture is preferred over an open chrome request, and that ordering matters: the
 * chrome one is spent by the fill it authorises, so spending it while an ordinary press would have
 * done would cost the user their second fill for no reason.
 */
export function consentFor(record: ConsentRecord, now: number): FillConsent | null {
  if (record.lastGestureAt !== null && pageInputHolds(record.lastGestureAt, now)) {
    return { source: 'page-input', at: record.lastGestureAt }
  }
  if (record.openRequestId !== null) {
    return { source: 'chrome-action', requestId: record.openRequestId }
  }
  return null
}
