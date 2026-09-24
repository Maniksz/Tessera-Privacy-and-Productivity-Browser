import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { invoke, subscribe } from './bridge.js'
import { rafThrottle } from './rafThrottle.js'

/**
 * Dragging a tab, either to reorder it in the strip or to drop it into a tile.
 *
 * ## Why pointer events rather than HTML5 drag and drop
 *
 * A tile is a native view stacked above this renderer. It produces no `dragover` and no
 * `drop` for us, so an HTML5 drag can only ever be received by the tab strip itself — which
 * is exactly why dropping a tab into a tile did not work: there was no target that could
 * hear it. Pointer events, reported to the core, work across the boundary.
 *
 * ## Why the core is told about the drag immediately
 *
 * Once the pointer crosses into the content area, the overlay layer receives it and this
 * renderer stops seeing the gesture. Both halves report to the core, which owns the drag.
 * That also makes "the pointer is over the tab strip" a real state rather than a gap: no
 * tile is targeted, the indicator shows no highlight, and the reorder preview shows here.
 */

/** Movement before a press becomes a drag, so a click with a shaky hand stays a click. */
const DRAG_THRESHOLD = 6

/** How far in from either end of the strip a dragged tab starts scrolling it. */
export const EDGE_SCROLL_ZONE = 32

/** Pixels per frame at the very edge and beyond it: about a tab's width every quarter second. */
export const EDGE_SCROLL_MAX_STEP = 16

/**
 * How far to scroll the strip this frame for a pointer at `x`, `y`: negative toward the start, positive
 * toward the end, zero outside both edge zones or above or below the strip (U22, R32).
 *
 * Faster the deeper into the zone, and at full speed past the edge — over the window controls, or
 * outside the window — because that is where somebody pushes when they want the strip to hurry. Pure, so
 * the speed curve is checked without a frame loop.
 */
export function edgeScrollStep(
  box: { left: number; right: number; top: number; bottom: number },
  x: number,
  y: number
): number {
  if (y < box.top || y > box.bottom) return 0
  const depth = (distance: number): number =>
    Math.ceil(
      (EDGE_SCROLL_MAX_STEP * Math.min(EDGE_SCROLL_ZONE, EDGE_SCROLL_ZONE - distance)) /
        EDGE_SCROLL_ZONE
    )
  if (x - box.left < EDGE_SCROLL_ZONE) return -depth(x - box.left)
  if (box.right - x < EDGE_SCROLL_ZONE) return depth(box.right - x)
  return 0
}

/**
 * Insertion index within the strip, or null when the pointer is outside it.
 *
 * From each tab's own rectangle, which is in viewport coordinates, so the answer stays right while the
 * strip is scrolled: the rectangles move with the scroll, and the pointer is compared with where each
 * tab is drawn now rather than with where it would be unscrolled.
 */
function stripIndexAt(strip: HTMLElement | null, clientX: number, clientY: number): number | null {
  if (strip === null) return null
  const box = strip.getBoundingClientRect()
  if (clientY < box.top || clientY > box.bottom) return null

  const tabs = [...strip.querySelectorAll<HTMLElement>('[data-tab-id]')]
  if (tabs.length === 0) return 0
  for (const [index, element] of tabs.entries()) {
    const rect = element.getBoundingClientRect()
    if (clientX < rect.left + rect.width / 2) return index
  }
  return tabs.length - 1
}

export interface TabDrag {
  /** The tab being dragged, once the press has passed the threshold. */
  draggingId: string | null
  /** Where it would be inserted in the strip, or null while it is over the tiles. */
  reorderIndex: number | null
  begin(event: ReactPointerEvent<HTMLElement>, tabId: string): void
}

export function useTabDrag(stripRef: React.RefObject<HTMLElement | null>): TabDrag {
  const press = useRef<{ tabId: string; x: number; y: number; active: boolean } | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [reorderIndex, setReorderIndex] = useState<number | null>(null)

  const moves = useMemo(
    () =>
      rafThrottle<{ x: number; y: number }>((point) => {
        void invoke('drag:move', point)
      }),
    []
  )

  /**
   * The core is what ends a drag, not this renderer.
   *
   * A drop over a tile is reported by the overlay layer, because the pointer is over *its*
   * surface by then — so no `pointerup` ever reaches here and the tab would stay visibly
   * mid-drag forever. The same applies to a drag the core cancels on its own, when the window
   * is resized or loses focus. Listening to what the core says is on screen is the only
   * account of the drag that sees all of its endings.
   */
  useEffect(() => {
    return subscribe('overlay:presented', ({ presentation }) => {
      if (presentation?.kind === 'tab-drop') return
      press.current = null
      moves.cancel()
      setDraggingId(null)
      setReorderIndex(null)
    })
  }, [moves])

  useEffect(() => {
    /*
      Scrolling at the edge, one step per frame for as long as the pointer rests there (U22, R32).

      A loop rather than a step per pointer move, because a pointer held still at the edge produces no
      moves and is exactly the gesture that asks the strip to keep going. It stops by itself when the
      pointer leaves the zone, when the drag ends by any route — the check on `press` covers the endings
      the core decides, which clear it — and when this unmounts. Each step asks again where the tab would
      land, because the tabs moved under a pointer that did not.
    */
    let edge: { step: number; x: number; y: number } | null = null
    let frame: number | null = null

    const stopEdgeScroll = (): void => {
      edge = null
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
    }

    const tick = (): void => {
      frame = null
      const strip = stripRef.current
      if (edge === null || strip === null || press.current?.active !== true) return
      strip.scrollLeft += edge.step
      setReorderIndex(stripIndexAt(strip, edge.x, edge.y))
      frame = requestAnimationFrame(tick)
    }

    const steer = (x: number, y: number): void => {
      const strip = stripRef.current
      const step = strip === null ? 0 : edgeScrollStep(strip.getBoundingClientRect(), x, y)
      if (step === 0) {
        stopEdgeScroll()
        return
      }
      edge = { step, x, y }
      frame ??= requestAnimationFrame(tick)
    }

    const onMove = (event: PointerEvent): void => {
      const current = press.current
      if (current === null) return

      if (!current.active) {
        const travelled = Math.hypot(event.clientX - current.x, event.clientY - current.y)
        if (travelled < DRAG_THRESHOLD) return
        current.active = true
        setDraggingId(current.tabId)
        void invoke('drag:start', { tabId: current.tabId })
      }

      moves.post({ x: event.clientX, y: event.clientY })
      setReorderIndex(stripIndexAt(stripRef.current, event.clientX, event.clientY))
      steer(event.clientX, event.clientY)
    }

    const finish = (event: PointerEvent, commit: boolean): void => {
      const current = press.current
      press.current = null
      stopEdgeScroll()
      // A press that never passed the threshold was a click; the click handler owns it.
      if (current?.active !== true) return

      moves.cancel()
      setDraggingId(null)
      const target = stripIndexAt(stripRef.current, event.clientX, event.clientY)
      setReorderIndex(null)

      // Released over the strip: this was a reorder, so the tile drag is cancelled and the
      // tab keeps whatever tile it already had.
      const dropInTile = commit && target === null
      void invoke('drag:end', { x: event.clientX, y: event.clientY, commit: dropInTile })
      if (commit && target !== null) {
        void invoke('tabs:move', { tabId: current.tabId, toIndex: target })
      }
    }

    const onUp = (event: PointerEvent): void => finish(event, true)
    const onCancel = (event: PointerEvent): void => finish(event, false)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      moves.cancel()
      stopEdgeScroll()
    }
  }, [moves, stripRef])

  return {
    draggingId,
    reorderIndex,
    begin: (event, tabId) => {
      // Left button only, and never from a control inside the tab: the close and mute
      // buttons have their own jobs and must not start a drag.
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest('button') !== null) return
      press.current = { tabId, x: event.clientX, y: event.clientY, active: false }
    }
  }
}
