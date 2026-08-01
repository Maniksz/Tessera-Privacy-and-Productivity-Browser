import { ipcRenderer } from 'electron'
import {
  ZOOM_GESTURE_CHANNEL,
  stepWheelZoom,
  wheelZoomDelta
} from '@shared/gestures/wheel-zoom.js'

/**
 * The trackpad pinch, and `Ctrl`-wheel with it, read where a page can still refuse them.
 *
 * Every decision is in `shared/gestures/wheel-zoom.ts`, including why this lives in the preload at
 * all rather than in the core. What is left here is the part that can only happen here: the
 * listener, and the two properties of its registration that are not decoration.
 *
 * ## Why the listener captures, and why it answers a tick later
 *
 * Both come from one requirement — the page must get first refusal — and neither is obvious.
 *
 * **Capture, on `window`.** A page that calls `stopPropagation` in its own handler would otherwise
 * stop this one from ever running, and a page must not be able to *suppress* the browser's zoom any
 * more than it can steal it. In the capture phase this runs before anything in the document, so the
 * event is always seen.
 *
 * **But `defaultPrevented` is only final once the dispatch is over**, and running first is exactly
 * what makes it unreadable at that moment. Deferring the answer by a turn is what reconciles the
 * two: by then every listener on the path has had the event, and the page's verdict is in.
 *
 * A timer rather than a microtask, and this is the same trap as `TileFullscreenController.defer`:
 * the browser performs a microtask checkpoint *between two event listeners*, so a microtask would
 * still run before the page's handler.
 *
 * ## Why `passive`
 *
 * This never calls `preventDefault` — it is not this listener's business to cancel a page's
 * scrolling — and saying so lets Chromium keep the fast path for a wheel event on every page in
 * every tab. A wheel listener that quietly costs a frame of scrolling is the kind of tax nobody
 * traces back to the browser.
 */
export function installZoomGesture(): void {
  /** Wheel delta not yet spent on a step; see `stepWheelZoom`. */
  let carry = 0

  const report = (event: WheelEvent): void => {
    const delta = wheelZoomDelta(event)
    if (delta === null) return

    const step = stepWheelZoom(carry, delta)
    carry = step.carry
    if (step.steps === 0) return

    /*
      One message per stop rather than one carrying a count.

      The core applies the ladder in `gestures/zoom.ts`, which clamps at both ends, so a count would
      have to be either re-derived or trusted — and the only caller that could produce a large one is
      a wheel spun hard, where the stops are the point. Sending each keeps the wire the same shape as
      the menu's zoom, which also asks for one stop at a time.
    */
    const direction = step.steps < 0 ? 'in' : 'out'
    for (let taken = 0; taken < Math.abs(step.steps); taken += 1) {
      ipcRenderer.send(ZOOM_GESTURE_CHANNEL, direction)
    }
  }

  window.addEventListener(
    'wheel',
    (event) => {
      // Cheap and synchronous, so a page that scrolls without `Ctrl` never reaches the timer at all.
      if (!event.ctrlKey || !event.isTrusted) return
      setTimeout(() => report(event), 0)
    },
    { capture: true, passive: true }
  )
}
