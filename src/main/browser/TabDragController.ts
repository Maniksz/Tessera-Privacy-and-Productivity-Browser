import {
  dropZonesFor,
  relativeTo,
  zoneAt,
  type DropZone,
  type Point
} from '@shared/split/dropzones.js'
import type { TabDropPresentation } from '@shared/overlay/surface.js'
import type { LayoutId, Rect } from '@shared/split/layout.js'

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
 */

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

  start(tabId: string): void {
    const title = this.host.titleOf(tabId)
    if (title === null) return

    const zones = dropZonesFor(this.host.layout(), this.host.contentRect())
    if (zones.length === 0) return

    this.#state = { tabId, title, zones, activeZoneId: null }
    this.#present()
  }

  move(point: Point): void {
    const state = this.#state
    if (state === null) return

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
    if (zone === null) return
    // The tab may have been closed while it was being dragged.
    if (this.host.titleOf(state.tabId) === null) return

    this.host.drop(state.tabId, zone)
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
