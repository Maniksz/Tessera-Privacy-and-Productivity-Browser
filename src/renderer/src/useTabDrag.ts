import { useEffect, useMemo, useRef, useState } from 'react'
import type { TargetedPointerEvent } from 'preact'
import type { StripDropSide, StripDropSubject, StripDropTarget } from '@shared/strip/drop.js'
import { DRAG_THRESHOLD } from '@renderer-shared/drag-threshold.js'
import { invoke, subscribe } from './bridge.js'
import { rafThrottle } from './rafThrottle.js'

/**
 * Dragging a tab, either to reorder it in the strip or to drop it into a tile — and dragging a tiled
 * view's entry, which only ever reorders (U9).
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
 *
 * ## A drag this strip did not start
 *
 * A tab dragged out of a tile by its bar's grip (U10, KTD14) is a press on the overlay layer, so this
 * strip learns of it from the core (`strip:tileDrag`, see `TileDragReport`): that it began, where the
 * pointer is while it is over the strip, and where it was let go. It marks the place the way it marks
 * its own drags, and answers a release with the place under the point, which is a release from the
 * tiled view (`arrangements:releaseTab` with `at`). Where the platform hands the held button to the view
 * under the pointer instead, the pointer is heard here directly, and reported to the core the way the
 * overlay would have reported it — so both ways the core ends the drag and hands the release back.
 */

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
 * How much of a folded chip, from its left edge, counts as before it.
 *
 * The rest of the chip is "onto" it, which puts the drop last in its group (KTD7). A narrow strip
 * rather than half, because the chip is the whole of a folded group and dropping onto it is the point;
 * before it is still reachable, for placing a tab just in front of the group.
 */
const FOLDED_CHIP_BEFORE_SHARE = 0.25

/** Where a drop would land: the target under the pointer and the side of it (KTD7). */
export interface StripSpot {
  target: StripDropTarget
  side: StripDropSide
}

/**
 * What a drawn element offers as a drop target, read from its `data-strip-target` and `data-strip-id`.
 * The strip writes both; see `stripTargetProps` in `TabBar`.
 */
function targetOf(element: HTMLElement): StripDropTarget | null {
  const id = element.dataset['stripId'] ?? ''
  switch (element.dataset['stripTarget']) {
    case 'tab':
      return { kind: 'tab', tabId: id }
    case 'split':
      return { kind: 'split', arrangementId: id }
    case 'group':
      return { kind: 'group', groupId: id }
    default:
      return null
  }
}

/**
 * The target and side under the pointer, or null when the pointer is not over the strip.
 *
 * The first target whose right edge is past the pointer, and its left or right half — a folded chip
 * split by `FOLDED_CHIP_BEFORE_SHARE` instead. Past the last target is the end of the strip. Targets
 * rather than an index, so a folded group's hidden tabs and a tiled view's members cannot be
 * miscounted: the core resolves the spot against its own order (`resolveStripDrop`).
 *
 * From each target's own rectangle, which is in viewport coordinates, so the answer stays right while
 * the strip is scrolled: the rectangles move with the scroll, and the pointer is compared with where
 * each target is drawn now rather than with where it would be unscrolled.
 */
export function stripSpotAt(
  strip: HTMLElement | null,
  clientX: number,
  clientY: number
): StripSpot | null {
  if (strip === null) return null
  const box = strip.getBoundingClientRect()
  if (clientY < box.top || clientY > box.bottom) return null

  for (const element of strip.querySelectorAll<HTMLElement>('[data-strip-target]')) {
    const target = targetOf(element)
    const rect = element.getBoundingClientRect()
    if (target === null || clientX >= rect.right) continue
    const share = element.dataset['stripFolded'] === 'true' ? FOLDED_CHIP_BEFORE_SHARE : 0.5
    return { target, side: clientX < rect.left + rect.width * share ? 'before' : 'after' }
  }
  return { target: { kind: 'end' }, side: 'after' }
}

/** Two spots are the same drop, so a pointer moving within one half re-renders nothing. */
function sameSpot(a: StripSpot | null, b: StripSpot | null): boolean {
  return a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b))
}

export interface TabDrag {
  /** The tab or entry being dragged, once the press has passed the threshold. */
  dragging: StripDropSubject | null
  /** True while that is a tab dragged out of a tile (U10): let go over the strip, it leaves its view. */
  fromTile: boolean
  /** Where it would land in the strip, or null while it is over the tiles. */
  spot: StripSpot | null
  begin(event: TargetedPointerEvent<HTMLElement>, subject: StripDropSubject): void
}

export function useTabDrag(stripRef: React.RefObject<HTMLElement | null>): TabDrag {
  const press = useRef<{ subject: StripDropSubject; x: number; y: number; active: boolean } | null>(
    null
  )
  const [dragging, setDragging] = useState<StripDropSubject | null>(null)
  // The tab of a drag from a tile bar's grip, while the core says one is live; see the header.
  const tileDrag = useRef<string | null>(null)
  const [fromTile, setFromTile] = useState(false)
  const [spot, setSpotState] = useState<StripSpot | null>(null)
  const setSpot = useMemo(
    () =>
      (next: StripSpot | null): void =>
        setSpotState((previous) => (sameSpot(previous, next) ? previous : next)),
    []
  )

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
      tileDrag.current = null
      moves.cancel()
      setDragging(null)
      setFromTile(false)
      setSpot(null)
    })
  }, [moves, setSpot])

  /*
    A tab dragged out of a tile, as the core reports it (U10).

    The release is answered whether or not the start was heard: it carries the tab and the point, which
    is all the answer needs. It arrives after the core has taken the drop zones down, so the marker has
    already gone by the time the place is read — from where each target is drawn now, as for a drag of
    the strip's own. Nothing is answered for a point off the strip: that is not a place in it.
  */
  useEffect(() => {
    return subscribe('strip:tileDrag', ({ tabId, point, released }) => {
      // The strip's own drag is watched here already; the core never reports one, and must not start to.
      if (press.current !== null) return
      const landed = point === null ? null : stripSpotAt(stripRef.current, point.x, point.y)
      if (released) {
        tileDrag.current = null
        moves.cancel()
        setDragging(null)
        setFromTile(false)
        setSpot(null)
        if (landed !== null) void invoke('arrangements:releaseTab', { tabId, at: landed })
        return
      }
      if (tileDrag.current !== tabId) {
        tileDrag.current = tabId
        setDragging({ kind: 'tab', tabId })
        setFromTile(true)
      }
      setSpot(landed)
    })
  }, [moves, setSpot, stripRef])

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
      setSpot(stripSpotAt(strip, edge.x, edge.y))
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
      if (current === null) {
        // A tile's drag whose pointer this strip hears itself: reported on, and marked, as the core would.
        if (tileDrag.current === null) return
        moves.post({ x: event.clientX, y: event.clientY })
        setSpot(stripSpotAt(stripRef.current, event.clientX, event.clientY))
        return
      }

      const { subject } = current
      if (!current.active) {
        const travelled = Math.hypot(event.clientX - current.x, event.clientY - current.y)
        if (travelled < DRAG_THRESHOLD) return
        current.active = true
        setDragging(subject)
        /*
          Only a tab starts the tile drag. A tiled view's entry has nowhere to go among the tiles —
          dropping it there would merge two views, which the plan rules out — so the core is not told,
          and no drop zone appears over the tiles.
        */
        if (subject.kind === 'tab') void invoke('drag:start', { tabId: subject.tabId })
      }

      if (subject.kind === 'tab') moves.post({ x: event.clientX, y: event.clientY })
      setSpot(stripSpotAt(stripRef.current, event.clientX, event.clientY))
      steer(event.clientX, event.clientY)
    }

    const finish = (event: PointerEvent, commit: boolean): void => {
      const current = press.current
      /*
        A tile's drag let go where this strip hears it. Reported, not applied: the core decides what the
        point means and, for a place over the strip, hands the release back through the report above.
      */
      if (current === null && tileDrag.current !== null) {
        moves.cancel()
        void invoke('drag:end', { x: event.clientX, y: event.clientY, commit })
        return
      }
      press.current = null
      stopEdgeScroll()
      // A press that never passed the threshold was a click; the click handler owns it.
      if (current?.active !== true) return

      moves.cancel()
      setDragging(null)
      const landed = stripSpotAt(stripRef.current, event.clientX, event.clientY)
      setSpot(null)

      // Released over the strip: this was a reorder, so the tile drag is cancelled and the
      // tab keeps whatever tile it already had.
      if (current.subject.kind === 'tab') {
        const dropInTile = commit && landed === null
        void invoke('drag:end', { x: event.clientX, y: event.clientY, commit: dropInTile })
      }
      if (commit && landed !== null) {
        void invoke('strip:drop', { subject: current.subject, ...landed })
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
  }, [moves, setSpot, stripRef])

  return {
    dragging,
    fromTile,
    spot,
    begin: (event, subject) => {
      // Left button only, and never from a control inside the tab: the close and mute
      // buttons have their own jobs and must not start a drag.
      if (event.button !== 0) return
      if ((event.target as HTMLElement).closest('button') !== null) return
      press.current = { subject, x: event.clientX, y: event.clientY, active: false }
    }
  }
}
