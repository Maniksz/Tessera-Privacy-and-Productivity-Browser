import { useRef, type PointerEvent } from 'react'
import type { SplitState } from '@shared/model.js'
import { DEFAULT_FRACTIONS, TILE_GUTTER, dividersFor } from '@shared/split/layout.js'
import { invoke } from '../bridge.js'

/**
 * Draggable dividers between tiles (spec 2).
 *
 * These sit in the gutters `computeTileRects` leaves between tiles. That gap is
 * the whole reason they can be dragged: tab content is rendered by native views
 * layered above the chrome UI, so a handle anywhere else in the content area
 * would never receive a pointer event.
 *
 * Positions come from `dividersFor`, the same function the core uses to compute
 * tile bounds — the handle a user grabs is always where the actual boundary is.
 */

interface SplitDividersProps {
  split: SplitState
  /** Height of the chrome above the content area, in CSS px. */
  contentTop: number
}

export function SplitDividers({ split, contentTop }: SplitDividersProps): React.ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<string | null>(null)

  // A maximised tile has no visible boundaries to drag.
  if (split.maximizedTile !== null) return null

  const dividers = dividersFor(split.layout, split.fractions)
  if (dividers.length === 0) return null

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, id: string): void => {
    event.preventDefault()
    dragging.current = id
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>, orientation: 'vertical' | 'horizontal'): void => {
    const id = dragging.current
    const container = containerRef.current
    if (id === null || container === null) return

    const bounds = container.getBoundingClientRect()
    const fraction =
      orientation === 'vertical'
        ? (event.clientX - bounds.left) / bounds.width
        : (event.clientY - bounds.top) / bounds.height

    // The core clamps to the minimum tile size and snaps to the even split, so
    // the raw value is safe to send; it is the single authority on where a
    // divider may end up.
    void invoke('split:setFractions', { fractions: { [id]: fraction } })
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    dragging.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  /** Double-click restores the layout's default split (spec 2). */
  const onDoubleClick = (id: string): void => {
    const fallback = DEFAULT_FRACTIONS[split.layout][id]
    if (fallback === undefined) return
    void invoke('split:setFractions', { fractions: { [id]: fallback } })
  }

  return (
    <div
      ref={containerRef}
      className="dividers"
      style={{ top: contentTop }}
      // Only the handles are interactive; the rest of this layer must not
      // swallow clicks meant for the content views behind it.
      aria-hidden={false}
    >
      {dividers.map((divider) => {
        const fraction = split.fractions[divider.id] ?? DEFAULT_FRACTIONS[split.layout][divider.id] ?? 0.5
        const vertical = divider.orientation === 'vertical'

        const style = vertical
          ? {
              left: `calc(${fraction * 100}% - ${TILE_GUTTER / 2}px)`,
              top: `${divider.region.y * 100}%`,
              width: `${TILE_GUTTER}px`,
              height: `${divider.region.height * 100}%`
            }
          : {
              top: `calc(${fraction * 100}% - ${TILE_GUTTER / 2}px)`,
              left: `${divider.region.x * 100}%`,
              height: `${TILE_GUTTER}px`,
              width: `${divider.region.width * 100}%`
            }

        return (
          <div
            key={divider.id}
            role="separator"
            aria-orientation={divider.orientation}
            aria-valuenow={Math.round(fraction * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            tabIndex={0}
            className={`divider divider--${divider.orientation}`}
            style={style}
            onPointerDown={(event) => onPointerDown(event, divider.id)}
            onPointerMove={(event) => onPointerMove(event, divider.orientation)}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => onDoubleClick(divider.id)}
            onKeyDown={(event) => {
              // Keyboard resizing, because every control has to be reachable
              // without a pointer (spec 7).
              const step = event.shiftKey ? 0.05 : 0.01
              const decrease = vertical ? 'ArrowLeft' : 'ArrowUp'
              const increase = vertical ? 'ArrowRight' : 'ArrowDown'
              if (event.key !== decrease && event.key !== increase) return
              event.preventDefault()
              const next = fraction + (event.key === increase ? step : -step)
              void invoke('split:setFractions', { fractions: { [divider.id]: next } })
            }}
          />
        )
      })}
    </div>
  )
}
