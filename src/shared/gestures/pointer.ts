/**
 * Reading a pointer position out of one of Chromium's raw input events.
 *
 * ## Why this is not two lines inside the subscription
 *
 * The only way the core can learn that the pointer is near the top of a tile is
 * `webContents.on('input-event')` on the tile's own view: a tile is a native view stacked above the
 * chrome renderer, so the chrome's DOM never sees a pointer that is over a page, and the overlay
 * layer is hidden until there is something to show. Electron types that event's payload as
 * `InputEvent`, which declares `modifiers` and `type` and nothing else — the coordinates are
 * present at runtime, because the object is the serialised Blink event, but the type does not say
 * so. A subscription would therefore have to assert a shape, in a file that cannot be tested
 * without a browser process. Narrowing here instead makes the assertion a total function with
 * cases, and leaves the subscription one line long.
 *
 * ## The event this deliberately ignores, and the flicker it would cause
 *
 * `mouseLeave` looks like the obvious signal that the pointer has gone, and using it produces an
 * endless loop. Revealing the bar puts the overlay layer *under the pointer*, which is inside the
 * page view's bounds — so Chromium immediately delivers `mouseLeave` to the page. Read as a
 * departure, that hides the bar, which uncovers the page, which delivers a fresh move at the same
 * position, which reveals the bar again. The bar would strobe for as long as the pointer rested on
 * it. So a departure is only ever what a surface *reports* about itself
 * (`TILE_BAR_POINTER_AWAY`), never what a view's own leave event implies.
 */

/** The input event types this reads a position from. Only one, and the docblock says why. */
const POSITIONED_MOVE = 'mouseMove'

/**
 * The vertical position of a mouse move, relative to the view that received it, or `null` when the
 * event is anything else.
 *
 * `unknown` in, because the value comes from a type that does not describe it. Every rejection is a
 * real case rather than defensive padding: keyboard events arrive on the same subscription, and so
 * do wheel and gesture events with no coordinates at all.
 */
export function mouseMoveY(input: unknown): number | null {
  if (typeof input !== 'object' || input === null) return null
  const event: { type?: unknown; y?: unknown } = input
  if (event.type !== POSITIONED_MOVE) return null
  if (typeof event.y !== 'number' || !Number.isFinite(event.y)) return null
  return event.y
}
