import type { Rect } from '../split/layout.js'
import { viewRectOf } from '../split/tile-header.js'
import type { TabFailure } from './tab-failure.js'

/**
 * Whether a tab's view is shown, and where (KTD22).
 *
 * One rule, because `relayout` sets every view's visibility again on every layout change: a view hidden
 * anywhere else — for a failure or for an unloaded tab — would come back at the next resize. A tile
 * header (U20) is the third thing that changes a view, and it shrinks rather than hides: the view moves
 * below the header, and `tile-header.ts` says by how much. `relayout` asks this and nothing else, and
 * the chrome UI asks the same function where to draw what replaces the view, so the two cannot
 * disagree about the rectangle.
 *
 * No Electron and no validation library: the chrome renderer imports it.
 */

export interface ViewSubject {
  readonly failure?: TabFailure | undefined
  /** Nothing loaded (U15): a discarded tab's view is gone, and a deferred one's is empty. */
  readonly unloaded?: boolean
}

export interface ViewPlacement {
  visible: boolean
  /** Where the view goes, or `null` for a tab no tile holds. */
  rect: Rect | null
}

/**
 * One tile's view, and whether the chrome draws a failure in its place.
 *
 * `rect` is the tile's; with `header` the view, and the failure drawn instead of it, sit below the
 * tile's header strip.
 */
export function placeView(
  rect: Rect | null,
  subject: ViewSubject,
  header = false
): ViewPlacement & { showsFailure: boolean } {
  if (rect === null) return { visible: false, rect: null, showsFailure: false }
  const failed = subject.failure !== undefined
  return {
    visible: !failed && subject.unloaded !== true,
    rect: viewRectOf(rect, header),
    showsFailure: failed
  }
}

/**
 * Every tab's placement for one layout, in the tabs' own order.
 *
 * A tab no tile holds is hidden but stays loaded and keeps running (spec 2); a tile without a tab, or
 * naming one that is gone, places nothing.
 */
export function planViews<T extends ViewSubject>(
  tiles: ReadonlyArray<{ tabId: string | null; rect: Rect | null; header?: boolean }>,
  tabs: ReadonlyMap<string, T>
): Map<string, ViewPlacement> {
  const tiled = new Map<string, { rect: Rect; header: boolean }>()
  for (const { tabId, rect, header } of tiles) {
    if (tabId !== null && rect !== null) tiled.set(tabId, { rect, header: header === true })
  }
  const plan = new Map<string, ViewPlacement>()
  for (const [tabId, tab] of tabs) {
    const tile = tiled.get(tabId)
    const { visible, rect } = placeView(tile?.rect ?? null, tab, tile?.header)
    plan.set(tabId, { visible, rect })
  }
  return plan
}
