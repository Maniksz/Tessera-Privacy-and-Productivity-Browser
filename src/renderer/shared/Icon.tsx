/**
 * The line icons every surface draws its small buttons with.
 *
 * ## Why drawings and not characters
 *
 * The buttons used to carry emoji and dingbats — 🔒, 🔇, 📂, ✎, ⏸ — and each of those is a picture
 * the *font* chooses. The same code point is a flat glyph on one platform, a colour emoji on another
 * and a missing-character box on a Linux install without the right font, at a size and baseline that
 * matches nothing next to it. The toolbar already drew its icons as 20-pixel line drawings; this puts
 * everything else in the same hand.
 *
 * ## Why here, and why inline
 *
 * `renderer/shared` because the chrome, the overlay and the internal pages all draw them, and a
 * second copy of the pencil would be a second pencil. Inline paths rather than an icon library: the
 * set is small, a dependency would cost more bundle than the drawings, and none of these renderers
 * may fetch anything anyway.
 *
 * Stroke, colour and caps come from attributes, so a surface with no stylesheet rule for them still
 * gets a line drawing in the text colour. A surface's own `svg` rule wins over the attributes — the
 * toolbar's thicker stroke, for one — which is intended. The size is set as a style for the opposite
 * reason: `.iconbutton svg` sizes every toolbar drawing at 20 pixels, and a caret beside the layout
 * preview must not grow to match.
 *
 * Always `aria-hidden`. The button carries the name; an icon that also announced itself would read
 * every label twice.
 */

/** 16 × 16 drawings, each one or more stroked paths. */
const PATHS = {
  close: ['M4 4l8 8', 'M12 4l-8 8'],
  edit: ['M10.5 2.5l3 3L6 13H3v-3z', 'M9 4l3 3'],
  'arrow-up': ['M8 13V3', 'M4 7l4-4 4 4'],
  'arrow-down': ['M8 3v10', 'M4 9l4 4 4-4'],
  'arrow-left': ['M13 8H3', 'M7 4 3 8l4 4'],
  swap: ['M3 5.5h9.5', 'M10 3l2.5 2.5L10 8', 'M13 10.5H3.5', 'M6 8l-2.5 2.5L6 13'],
  folder: [
    'M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z'
  ],
  'open-file': [
    'M9.5 2.5h4v4',
    'M13.5 2.5 8 8',
    'M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3'
  ],
  reset: ['M3 8a5 5 0 1 0 1.46-3.54', 'M3 2.5V5h2.5'],
  'chevron-down': ['M4 6l4 4 4-4'],
  lock: [
    'M4.5 7.5h7a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z',
    'M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2'
  ],
  warning: ['M8 2.5 14 13H2z', 'M8 6.5v3', 'M8 11.3v.2'],
  blocked: ['M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z', 'M4.1 4.1l7.8 7.8'],
  internal: ['M8 2.5 13.5 8 8 13.5 2.5 8z'],
  volume: ['M2.5 6H5l3.5-3v10L5 10H2.5z', 'M11 5.5a3.5 3.5 0 0 1 0 5', 'M12.8 3.6a6 6 0 0 1 0 8.8'],
  'volume-off': ['M2.5 6H5l3.5-3v10L5 10H2.5z', 'M10.5 6l4 4', 'M14.5 6l-4 4'],
  play: ['M5 3.5v9l7-4.5z'],
  pause: ['M6 3.5v9', 'M10 3.5v9'],
  stop: ['M5 4h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z'],
  trash: ['M3 4.5h10', 'M6.5 4.5V3h3v1.5', 'M4.5 4.5l.7 8.5h5.6l.7-8.5']
} as const satisfies Record<string, readonly string[]>

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 14 }: { name: IconName; size?: number }): React.ReactNode {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: size, height: size, flex: 'none', verticalAlign: 'middle' }}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
