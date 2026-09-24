import {
  dropZonesFor,
  relativeTo,
  zoneAt,
  type DropZone,
  type Point
} from '@shared/split/dropzones.js'
import type { TabDropPresentation } from '@shared/overlay/surface.js'
import type { LayoutId, Rect } from '@shared/split/layout.js'
import type { TileDragReport } from '@shared/strip/tile-drag.js'

/**
 * Owns a tab drag from press to drop.
 *
 * ## Why the core owns it at all
 *
 * No single renderer sees the whole gesture. It begins in the tab strip, and the moment the
 * pointer crosses into the content area a native view takes it — from there the overlay
 * layer reports it instead. Two halves of one drag, reported by two processes, only add up
 * if something in the middle is keeping score.
 *
 * ## Why it is separate from the window
 *
 * Everything here is a decision — which zones exist, which one the pointer selects, what a
 * drop does — and none of it needs a `BrowserWindow`. Behind the `TabDragHost` seam it can be
 * driven directly by a test, so the rules are checked by assertions rather than only by
 * dragging a mouse across a running application.
 *
 * ## Two places a drag begins
 *
 * In the strip, or at a tile bar's grip (U10, KTD14). Over the tiles the two are the same drag. Over
 * the strip they are not: the strip's own drag is watched by the strip, which reorders on its own
 * release, while a tile's drag is a press the strip never saw. So for that one the strip is told —
 * that it began, where the pointer is while it is over the strip, and where it was let go there
 * (`TileDragReport`) — and the strip answers with the place under that point, which releases the tab
 * from its tiled view.
 */

/** Where the press began: the tab strip, or a tile bar's grip. */
export type DragOrigin = 'strip' | 'tile'

export interface TabDragHost {
  layout(): LayoutId
  /** The tile area in window coordinates. */
  contentRect(): Rect
  /** Null when the tab has gone — closed mid-drag, or from another window. */
  titleOf(tabId: string): string | null
  present(presentation: TabDropPresentation): void
  dismiss(): void
  /** Apply the drop: switch layout if the zone asks for one, then place the tab. */
  drop(tabId: string, zone: DropZone): void
  /** Tell the strip about a drag from a tile bar's grip; never called for the strip's own drag. */
  reportToStrip(report: TileDragReport): void
}

interface DragState {
  tabId: string
  title: string
  /**
   * Computed once, at the start.
   *
   * Recomputing per move would let the targets shift under a pointer that has not moved —
   * a page finishing its load must not change where a drop would land.
   */
  zones: DropZone[]
  activeZoneId: string | null
  origin: DragOrigin
  /** Whether the strip was last told the pointer is over it, so going back is told exactly once. */
  overStrip: boolean
}

export class TabDragController {
  #state: DragState | null = null

  private readonly host: TabDragHost

  constructor(host: TabDragHost) {
    this.host = host
  }

  get active(): boolean {
    return this.#state !== null
  }

  /** The zone currently targeted, for tests and for diagnostics. */
  get activeZoneId(): string | null {
    return this.#state?.activeZoneId ?? null
  }

  start(tabId: string, origin: DragOrigin = 'strip'): void {
    const title = this.host.titleOf(tabId)
    if (title === null) return

    const zones = dropZonesFor(this.host.layout(), this.host.contentRect())
    if (zones.length === 0) return

    this.#state = { tabId, title, zones, activeZoneId: null, origin, overStrip: false }
    this.#present()
    if (origin === 'tile') this.host.reportToStrip({ tabId, point: null, released: false })
  }

  move(point: Point): void {
    const state = this.#state
    if (state === null) return
    if (state.origin === 'tile') this.#followOverStrip(state, point)

    // Null while the pointer is still in the tab strip. That is a real state, not a gap: the
    // drag is live, no tile is targeted, and the indicator shows no highlight.
    const next = zoneAt(state.zones, point, this.host.contentRect())?.id ?? null
    // Pushed only when the target changes, so moving within one zone costs nothing. A pointer
    // produces samples far faster than the indicator can meaningfully change.
    if (next === state.activeZoneId) return
    state.activeZoneId = next
    this.#present()
  }

  end(point: Point, commit: boolean): void {
    const state = this.#state
    this.#state = null
    this.host.dismiss()
    if (state === null || !commit) return

    const zone = zoneAt(state.zones, point, this.host.contentRect())
    // The tab may have been closed while it was being dragged.
    if (this.host.titleOf(state.tabId) === null) return

    if (zone !== null) {
      this.host.drop(state.tabId, zone)
      return
    }
    /*
      Let go over the strip, from a tile: a release, which the strip places. After the dismissal above,
      so the strip has already dropped its marker when it is asked where the tab goes, and the answer
      it sends back cannot race a drag the core still thinks is live.
    */
    if (state.origin === 'tile' && this.#aboveTiles(point)) {
      this.host.reportToStrip({ tabId: state.tabId, point, released: true })
    }
  }

  /**
   * Drops the drag without moving anything.
   *
   * For the endings neither renderer reports: a pointer released outside the window leaves no
   * `pointerup` behind, and a resize moves every zone out from under the one the user aimed at.
   */
  cancel(): void {
    if (this.#state === null) return
    this.#state = null
    this.host.dismiss()
  }

  /**
   * Tells the strip where the pointer is while it is over it, and once when it goes back to the tiles.
   *
   * Every sample over the strip rather than only changes: the strip turns the point into a target and a
   * side, which only it can, and it already ignores a sample that lands on the same place. Over the tiles
   * the strip has nothing to show, so it hears that once and then nothing.
   */
  #followOverStrip(state: DragState, point: Point): void {
    const over = this.#aboveTiles(point)
    if (!over && !state.overStrip) return
    state.overStrip = over
    this.host.reportToStrip({ tabId: state.tabId, point: over ? point : null, released: false })
  }

  /** Above the tile area is where the strip is; `zoneAt` finds no zone there either. */
  #aboveTiles(point: Point): boolean {
    return point.y < this.host.contentRect().y
  }

  #present(): void {
    const state = this.#state
    if (state === null) return
    const contentRect = this.host.contentRect()
    this.host.present({
      kind: 'tab-drop',
      origin: { x: contentRect.x, y: contentRect.y },
      // Into the overlay's own coordinate space, whose origin is the tile area. Converting
      // once here beats every component doing its own arithmetic against an inset.
      zones: state.zones.map((zone) => ({
        ...zone,
        hit: relativeTo(zone.hit, contentRect),
        preview: relativeTo(zone.preview, contentRect)
      })),
      activeZoneId: state.activeZoneId,
      title: state.title
    })
  }
}
