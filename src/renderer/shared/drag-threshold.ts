/**
 * Movement, in CSS pixels, before a press becomes a drag: a click with a shaky hand stays a click.
 *
 * One number for both places a tab can be picked up — a tab or a tiled view's entry in the strip
 * (`useTabDrag`), and a tile bar's grip on the overlay layer (`TileBarSurface`). They are one gesture
 * as far as the user can tell: a tab dragged out of a tile goes on to be dropped in the strip, and a
 * grip that needed more travel than a tab — or less — would be the one control that felt different.
 * Two declarations of the same six were free to drift apart; one import each is not.
 *
 * Here, and alone in its file, because the chrome UI and the overlay are separate bundles and this is
 * the one directory both of them import from without dragging the other's modules along. A constant
 * in `useTabDrag.ts` would have put that hook's imports in the overlay's chunk.
 */
export const DRAG_THRESHOLD = 6
