import { useLayoutEffect, useState } from 'react'
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
 *
 * ## Why the ref is a callback and not a `RefObject`
 *
 * Because the first version was a `RefObject` read inside an effect keyed on `[]`, and that is wrong
 * for any caller that does not render its element on the first pass. `SplitDividers` returns `null`
 * for `1x1` and for a maximised tile, so `ref.current` was still `null` when the effect ran: no
 * observer was installed, and because the dependency list was empty it never ran again. Switching to
 * a split afterwards produced no measurement at all, for the lifetime of the window — a hook that
 * silently returned `[]` forever and a feature that looked implemented.
 *
 * A callback ref is state, so mounting the element *is* the dependency change. The element arriving
 * late, leaving, or being replaced each re-runs the effect on its own.
 */
export function useTileRects(split: SplitState | null): {
  ref: (element: HTMLDivElement | null) => void
  rects: Rect[]
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    if (element === null) return

    const measure = (): void => {
      const { width, height } = element.getBoundingClientRect()
      setSize({ width, height })
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  /*
    `element` is part of the guard, not just `size`.

    A measurement outlives the element it described — clearing it in the effect would be a `setState`
    in an effect body, which the hooks lint refuses and rightly so. Requiring the element instead
    means a stale size is simply never read: no rects while nothing is mounted, and the first real
    measurement replaces it before anything can be drawn from it.
  */
  if (split === null || size === null || element === null) return { ref: setElement, rects: [] }
  return {
    ref: setElement,
    rects: computeTileRects(split.layout, split.fractions, { x: 0, y: 0, ...size }, { gutter: TILE_GUTTER })
  }
}
