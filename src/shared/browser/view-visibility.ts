import type { Rect } from '../split/layout.js'
import type { TabFailure } from './tab-failure.js'

/**
 * Whether a tab's view is shown, and where (KTD22).
 *
 * One rule, because `relayout` sets every view's visibility again on every layout change: a view hidden
 * anywhere else — for a failure today, for an unloaded tab and a tile header later (U15, U20) — would
 * come back at the next resize. `relayout` asks this and nothing else, and the chrome UI asks the same
 * function where to draw what replaces the view, so the two cannot disagree about the rectangle.
 *
 * No Electron and no validation library: the chrome renderer imports it.
 */

export interface ViewSubject {
  readonly failure?: TabFailure | undefined
}

export interface ViewPlacement {
  visible: boolean
  /** Where the view goes, or `null` for a tab no tile holds. */
  rect: Rect | null
}

/** One tile's view, and whether the chrome draws a failure in its place. */
export function placeView(
  rect: Rect | null,
  subject: ViewSubject
): ViewPlacement & { showsFailure: boolean } {
  if (rect === null) return { visible: false, rect: null, showsFailure: false }
  const failed = subject.failure !== undefined
  return { visible: !failed, rect, showsFailure: failed }
}

/**
 * Every tab's placement for one layout, in the tabs' own order.
 *
 * A tab no tile holds is hidden but stays loaded and keeps running (spec 2); a tile without a tab, or
 * naming one that is gone, places nothing.
 */
export function planViews<T extends ViewSubject>(
  tiles: ReadonlyArray<{ tabId: string | null; rect: Rect | null }>,
  tabs: ReadonlyMap<string, T>
): Map<string, ViewPlacement> {
  const tiled = new Map<string, Rect>()
  for (const { tabId, rect } of tiles) {
    if (tabId !== null && rect !== null) tiled.set(tabId, rect)
  }
  const plan = new Map<string, ViewPlacement>()
  for (const [tabId, tab] of tabs) {
    const { visible, rect } = placeView(tiled.get(tabId) ?? null, tab)
    plan.set(tabId, { visible, rect })
  }
  return plan
}
