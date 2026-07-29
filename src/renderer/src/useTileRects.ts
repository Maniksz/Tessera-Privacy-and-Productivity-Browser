import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { SplitState } from '@shared/model.js'
import { TILE_GUTTER, computeTileRects, type Rect } from '@shared/split/layout.js'

/**
 * Where each tile's edges actually fall, in this element's own pixel space.
 *
 * Two surfaces need this and would otherwise measure it twice: the active-tile frame
 * (`SplitDividers`) and the per-tile empty-state placeholder (`App`). Both sit over the same
 * native-view area — `.dividers` and `.content` are the same box, one on top of the other — so
 * one measurement serves both.
 *
 * Computed with `computeTileRects`, the function the core uses to position the real views, rather
 * than re-deriving tile bounds from the layout id here. A highlight or a placeholder built from a
 * second implementation would drift from the tile it names the first time the gutter or the
 * minimum tile size changed; a `ResizeObserver` on the caller's own element is what keeps this one
 * in step without the core having to push pixel geometry down a channel that does not exist.
 */
export function useTileRects(split: SplitState | null): {
  ref: RefObject<HTMLDivElement | null>
  rects: Rect[]
} {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return

    const measure = (): void => {
      const { width, height } = element.getBoundingClientRect()
      setSize({ width, height })
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  if (split === null || size === null) return { ref, rects: [] }
  return {
    ref,
    rects: computeTileRects(split.layout, split.fractions, { x: 0, y: 0, ...size }, { gutter: TILE_GUTTER })
  }
}
