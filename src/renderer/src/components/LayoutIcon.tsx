import type { LayoutId } from '@shared/split/layout.js'

/**
 * The split layouts drawn as tile previews.
 *
 * Shared by the toolbar button, which shows the *current* arrangement, and the layout menu
 * on the overlay surface, which shows every one of them. The two live in different
 * renderers, so this module is the only thing keeping their previews identical.
 */

/** Re-exported so call sites keep one import for the icon and its label. */
export { LAYOUT_LABELS } from '@shared/split/labels.js'

/** Tile rectangles in a 16x16 box, with a 1px gutter so tiles read as separate. */
const PREVIEW: Readonly<Record<LayoutId, ReadonlyArray<[number, number, number, number]>>> = {
  '1x1': [[0, 0, 16, 16]],
  '1x2': [
    [0, 0, 7.5, 16],
    [8.5, 0, 7.5, 16]
  ],
  '2x1': [
    [0, 0, 16, 7.5],
    [0, 8.5, 16, 7.5]
  ],
  '2x2': [
    [0, 0, 7.5, 7.5],
    [8.5, 0, 7.5, 7.5],
    [0, 8.5, 7.5, 7.5],
    [8.5, 8.5, 7.5, 7.5]
  ],
  '1+2': [
    [0, 0, 9.5, 16],
    [10.5, 0, 5.5, 7.5],
    [10.5, 8.5, 5.5, 7.5]
  ],
  /*
    The wide rows keep the same 1px gutter and still reach 0 and 16, so their outer
    silhouette matches every other preview: three columns leave 14 to share, four
    leave 13. Rounder column widths would either overflow the box or float inside
    it, and a preview that does not line up with its neighbours in the menu reads
    as a different kind of thing rather than a different arrangement.
  */
  '1x3': [
    [0, 0, 4.6667, 16],
    [5.6667, 0, 4.6666, 16],
    [11.3333, 0, 4.6667, 16]
  ],
  '1x4': [
    [0, 0, 3.25, 16],
    [4.25, 0, 3.25, 16],
    [8.5, 0, 3.25, 16],
    [12.75, 0, 3.25, 16]
  ]
}

export function LayoutIcon({
  layout,
  size = 18
}: {
  layout: LayoutId
  size?: number
}): React.ReactNode {
  /*
    The box is a pixel larger than the tiles on every side.

    The rects sit flush against 0 and 16, and a stroke is centred on the edge it draws — without
    the margin, half of every outline would be clipped away. It matters now that the previews are
    outlined rather than filled.
  */
  return (
    <svg viewBox="-1 -1 18 18" width={size} height={size} aria-hidden="true">
      {PREVIEW[layout].map(([x, y, width, height], index) => (
        <rect key={index} x={x} y={y} width={width} height={height} rx="1.5" />
      ))}
    </svg>
  )
}
