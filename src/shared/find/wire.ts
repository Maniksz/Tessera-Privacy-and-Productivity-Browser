/**
 * Reading Chromium's own find payloads.
 *
 * ## Why these are functions rather than two lines inside a subscription
 *
 * A find session reports through `webContents.on('found-in-page')` and dies through
 * `webContents.on('did-start-navigation')`. Both handlers live in a file that speaks to a live
 * `WebContents` and therefore cannot run outside a browser process, and both have to read fields out
 * of a payload Electron's own overloads cannot be addressed generically — the same problem
 * `Tab.#wireEvents` has, and the same answer: widen the emitter to `NodeJS.EventEmitter`, take
 * `unknown` arguments, and narrow here where it can be tested.
 *
 * Every rejection below is a real case rather than defensive padding. A subframe's navigation and a
 * `pushState` arrive on the same subscription as a real page load, and reading them as one would
 * reset the user's position in the search every time an advertisement iframe refreshed itself.
 */

/** The three numbers a `found-in-page` result carries that anything here reads. */
export interface FindResultPayload {
  /** Echoed from `findInPage`, so an answer can be matched to the question. */
  requestId: number
  matches: number
  /** Chromium's `activeMatchOrdinal`, unclamped; see `normaliseFindResult`. */
  activeMatch: number
}

/**
 * A find result, or `null` for a payload that is not one.
 *
 * `unknown` in, because the value crosses an event boundary whose type Electron declares per
 * overload and this subscription cannot use.
 */
export function findResultPayload(payload: unknown): FindResultPayload | null {
  if (typeof payload !== 'object' || payload === null) return null
  const result: { requestId?: unknown; matches?: unknown; activeMatchOrdinal?: unknown } = payload
  if (!finiteNumber(result.requestId)) return null
  if (!finiteNumber(result.matches)) return null
  if (!finiteNumber(result.activeMatchOrdinal)) return null
  return {
    requestId: result.requestId,
    matches: result.matches,
    activeMatch: result.activeMatchOrdinal
  }
}

/**
 * Whether a `did-start-navigation` payload means this page's find session is gone.
 *
 * True only for a main-frame navigation to a different document, and both halves of that matter:
 *
 *  - a **subframe** navigation leaves the main document's find session intact, and treating it as a
 *    change would reset the active match whenever an embedded frame reloaded itself — on an
 *    advertisement-heavy page, every few seconds;
 *  - a **same-document** navigation is a fragment link or a `pushState`, which does not replace the
 *    document and so does not end the session either.
 *
 * A payload that cannot be read at all counts as "not a document change". The safe direction is to
 * keep believing the session is alive: a stale `scoped` costs one wrong advance, whereas
 * invalidating on every unreadable event would restart the search continuously.
 */
export function endsFindSession(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const details: { isMainFrame?: unknown; isSameDocument?: unknown } = payload
  if (details.isMainFrame !== true) return false
  return details.isSameDocument === false
}

/** `Number.isFinite` as a narrowing guard, so the three reads above stay one line each. */
function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
