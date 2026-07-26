/**
 * Where an anchored surface (a menu, a popover) goes relative to the control that
 * opened it.
 *
 * Pure geometry in window coordinates, deliberately separate from the component that
 * renders it. A menu that lands half off-screen only misbehaves at particular window
 * sizes and anchor positions — the kind of defect that is tedious to find by dragging a
 * window around and trivial to pin down with a table of cases.
 *
 * Zod-free and dependency-free: both the chrome UI and the overlay surface import it at
 * runtime. See `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export type MenuPlacement = 'below' | 'above'

export interface AnchorOptions {
  /** Distance between the control and the surface. */
  gap?: number
  /** Smallest distance the surface keeps from the window edge. */
  margin?: number
  /**
   * Which of the anchor's vertical edges the surface lines up with.
   *
   * `end` (the default) suits toolbar buttons on the right: the surface grows leftwards
   * into the window instead of towards the edge it is already touching.
   */
  align?: 'start' | 'end'
}

export interface AnchoredSurface {
  rect: Rect
  /** Which side of the control the surface ended up on. */
  placement: MenuPlacement
}

const DEFAULT_GAP = 6
const DEFAULT_MARGIN = 8

/**
 * Places `surface` against `anchor` inside `viewport`.
 *
 * Prefers below the anchor and flips above only when that genuinely helps — flipping to a
 * side with even less room would move the surface without making more of it visible. The
 * result is always clamped into the viewport, so the caller never has to handle an
 * off-screen rect.
 */
export function anchorSurface(
  anchor: Rect,
  surface: Size,
  viewport: Size,
  options: AnchorOptions = {}
): AnchoredSurface {
  const gap = options.gap ?? DEFAULT_GAP
  const margin = options.margin ?? DEFAULT_MARGIN
  const align = options.align ?? 'end'

  /**
   * The anchor is clamped into the viewport before anything is measured against it.
   *
   * An anchor can legitimately sit partly or wholly outside — a toolbar button in a window
   * that just got shorter, a stale rect from before a resize. Measuring the room "above" an
   * anchor at y=900 in an 800px window yields 886px of space that does not exist, and the
   * surface is then placed off-screen. Clamping first makes every case below sound.
   */
  const anchorTop = Math.min(Math.max(anchor.y, 0), viewport.height)
  const anchorBottom = Math.min(Math.max(anchor.y + anchor.height, 0), viewport.height)

  const roomBelow = Math.max(0, viewport.height - anchorBottom - gap - margin)
  const roomAbove = Math.max(0, anchorTop - gap - margin)

  // Flip only when above is both insufficient-below *and* the better of the two.
  const placement: MenuPlacement =
    surface.height > roomBelow && roomAbove > roomBelow ? 'above' : 'below'

  const available = placement === 'below' ? roomBelow : roomAbove
  const height = Math.min(surface.height, available)
  const y = placement === 'below' ? anchorBottom + gap : anchorTop - gap - height

  // A surface wider than the window is clamped rather than allowed to overhang; the
  // component decides whether that means wrapping or scrolling.
  const width = Math.min(surface.width, Math.max(0, viewport.width - margin * 2))
  const preferredX = align === 'end' ? anchor.x + anchor.width - width : anchor.x
  const maxX = viewport.width - margin - width
  const x = Math.min(Math.max(preferredX, margin), Math.max(margin, maxX))

  return {
    placement,
    rect: {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    }
  }
}
