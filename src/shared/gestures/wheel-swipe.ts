import type { NavigationIntent } from './navigation.js'

/**
 * Back and forward by sliding two fingers sideways on a trackpad, the way Chrome does it.
 *
 * ## Why `navigation.ts` did not already cover this
 *
 * It covers the *three*-finger swipe. Electron's `swipe` event is AppKit's `swipeWithEvent:`, which
 * macOS sends only for three fingers — and only when "Swipe between pages" admits three. The
 * two-finger gesture people know from Chrome is not a system gesture at all: it is ordinary
 * horizontal scrolling that Chrome's own browser layer turns into navigation once the page has
 * nowhere left to scroll. That layer is Chrome's, not Chromium's content layer, so Electron does not
 * have it, and `scroll-touch-begin`/`-edge`, the events an Electron app once rebuilt it from, are gone.
 *
 * ## Why the renderer reads it
 *
 * For the same reason the zoom gesture is read there (`wheel-zoom.ts`): the two facts that decide
 * whether a sideways scroll is a navigation exist only in the page. Whether anything under the
 * pointer **can still scroll that way** — a carousel, a wide table, a code block — and whether the
 * page **refused the wheel** with `preventDefault` because it handles it itself, like a map or a
 * spreadsheet. The core sees neither, and a browser that navigated away from a half-scrolled table
 * would be worse than one without the gesture.
 *
 * And for the same reason it is right that a page reports it: the page reporting is the page under
 * the pointer, which is the tile the user is looking at — the rule `navigation.ts` spends a section
 * arguing for, satisfied without any geometry.
 *
 * ## What one gesture is
 *
 * The DOM gives a wheel event no phase — no "fingers down", no "fingers up", no "momentum". So a
 * gesture is a run of wheel events with no gap longer than `SWIPE_GESTURE_GAP_MS` between them, and
 * the momentum macOS keeps sending after the fingers lift is part of the same run. That is what makes
 * one flick navigate once rather than once per threshold's worth of momentum.
 *
 * Each run is decided once, at its first event, and kept: Chrome latches a scroll to what it started
 * as, and so does this. A run that began vertically stays a scroll however far it drifts sideways;
 * a run that began by scrolling something in the page stays the page's even after that something hits
 * its edge — which is what lets a carousel be flicked to its end without the browser leaving the page
 * on the last pixel.
 */

/** Preload -> core: one completed swipe, already reduced to a direction. */
export const SWIPE_GESTURE_CHANNEL = 'tessera:swipe-gesture'

/**
 * How far past the edge, in CSS pixels, a swipe has to travel before it navigates.
 *
 * A feel value, not a derived one. A deliberate two-finger swipe on a Mac trackpad, momentum
 * included, travels several hundred pixels; a sideways brush while reading travels a few dozen. Two
 * hundred sits between them, and there is no visual feedback yet to make a lower one forgiving.
 */
export const SWIPE_THRESHOLD_PX = 200

/**
 * The silence that ends one gesture and lets the next begin.
 *
 * macOS delivers a scroll, and its momentum, at display rate — sixteen milliseconds apart at 60 Hz —
 * so a fifth of a second is a pause no running gesture produces and short enough that a second swipe
 * straight after the first is not swallowed.
 */
export const SWIPE_GESTURE_GAP_MS = 200

/** The parts of a `WheelEvent` read up front; `defaultPrevented` is read a turn later. */
export interface WheelSwipeEvent {
  readonly isTrusted: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaMode: number
}

/** `WheelEvent.DOM_DELTA_PIXEL`. */
const DOM_DELTA_PIXEL = 0

/**
 * The deltas of a wheel event that may be part of a swipe, or `null` when it cannot be.
 *
 *   - **`isTrusted`**: a page that could `dispatchEvent` its way into the back button could trap the
 *     user in a redirect loop of its own choosing, or throw them off a page they meant to stay on.
 *   - **Any modifier**: `Ctrl` is how Chromium reports a pinch, and `Shift` is how a mouse wheel
 *     scrolls sideways on Windows and Linux. Neither is a swipe, and a Shift-scroll across a wide
 *     table that navigated at the table's edge would be exactly the accident this must not have.
 *   - **Pixels only**: Chromium sends nothing else, and a line-based delta read as pixels would make
 *     the threshold mean something different per device.
 */
export function swipeWheelSample(
  event: WheelSwipeEvent
): { deltaX: number; deltaY: number } | null {
  if (!event.isTrusted) return null
  if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return null
  if (event.deltaMode !== DOM_DELTA_PIXEL) return null
  if (!Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) return null
  return { deltaX: event.deltaX, deltaY: event.deltaY }
}

/**
 * Whether one event is sideways. Strictly, so the diagonal is a scroll: reading drifts, and a tie
 * going to the gesture that can leave the page would be a tie going the wrong way.
 */
export function isHorizontalWheel(deltaX: number, deltaY: number): boolean {
  return deltaX !== 0 && Math.abs(deltaX) > Math.abs(deltaY)
}

/** A scrollable box, as the DOM describes it. */
export interface ScrollBox {
  readonly scrollLeft: number
  readonly scrollWidth: number
  readonly clientWidth: number
  /** Right-to-left boxes count `scrollLeft` from zero at the right edge towards negative values. */
  readonly rtl: boolean
}

/**
 * Whether a box can still scroll in a direction: `-1` is leftwards, `+1` rightwards.
 *
 * The one-pixel tolerance is for fractional positions: at a zoom level other than 100 % a box
 * scrolled fully to its end routinely reports half a pixel short of it, and a box that thinks it
 * has half a pixel of room left would claim every swipe for itself.
 */
export function hasRoomToScroll(box: ScrollBox, towards: -1 | 1): boolean {
  const range = box.scrollWidth - box.clientWidth
  if (range <= 1) return false
  const min = box.rtl ? -range : 0
  const max = box.rtl ? 0 : range
  return towards < 0 ? box.scrollLeft > min + 1 : box.scrollLeft < max - 1
}

/**
 * What the run of wheel events in progress has been decided to be.
 *
 *   - `none`: nothing yet — the next event decides.
 *   - `scroll`: it began vertically.
 *   - `page`: something in the page scrolled it or refused it.
 *   - `swipe`: it began sideways at an edge and is travelling towards the threshold.
 *   - `spent`: it already navigated; the rest of it, momentum included, is ignored.
 */
export type SwipeLatch = 'none' | 'scroll' | 'page' | 'swipe' | 'spent'

export interface SwipeTracker {
  readonly latch: SwipeLatch
  /** Distance travelled in the swipe's own direction, never negative. */
  readonly travelled: number
  /** `-1` for a leftward swipe, which is back; `+1` for rightward, which is forward. */
  readonly direction: -1 | 1
  /** When the latest event of this run arrived, in the events' own clock. */
  readonly lastAt: number
}

export const IDLE_SWIPE: SwipeTracker = {
  latch: 'none',
  travelled: 0,
  direction: -1,
  lastAt: Number.NEGATIVE_INFINITY
}

export interface SwipeSample {
  /** `WheelEvent.timeStamp`. */
  readonly at: number
  readonly deltaX: number
  readonly deltaY: number
  /** Whether something under the pointer could still scroll this event's way before it arrived. */
  readonly pageCanScroll: boolean
  /** Whether the page called `preventDefault` on it. */
  readonly refused: boolean
}

/**
 * Feeds one wheel event into the run it belongs to, and says whether the run just became a
 * navigation.
 *
 * Negative `deltaX` is scrolling leftwards, which is back — the same in Chrome, and independent of
 * the "natural scrolling" setting, because that setting has already been applied to the delta by the
 * time a page sees it. Leftwards past the left edge uncovers what came before, as `navigation.ts`
 * says of the three-finger swipe.
 *
 * Travel back towards the start shortens the swipe but cannot turn it around. Chrome does the same,
 * and the alternative is worse than it sounds: a swipe begun at the left edge and reversed would
 * scroll the page rightwards *and* count towards going forward, both at once.
 */
export function stepSwipe(
  state: SwipeTracker,
  sample: SwipeSample
): { state: SwipeTracker; intent: NavigationIntent | null } {
  const current = sample.at - state.lastAt > SWIPE_GESTURE_GAP_MS ? IDLE_SWIPE : state
  // Never backwards: events are read in two passes (see the preload), so they can land out of order.
  const lastAt = Math.max(current.lastAt, sample.at)
  const settle = (
    next: Partial<SwipeTracker>
  ): { state: SwipeTracker; intent: NavigationIntent | null } => ({
    state: { ...current, ...next, lastAt },
    intent: null
  })

  if (current.latch === 'none') {
    if (!isHorizontalWheel(sample.deltaX, sample.deltaY)) return settle({ latch: 'scroll' })
    if (sample.pageCanScroll || sample.refused) return settle({ latch: 'page' })
    return advance(
      { latch: 'swipe', travelled: 0, direction: sample.deltaX < 0 ? -1 : 1, lastAt },
      sample.deltaX
    )
  }

  if (current.latch !== 'swipe') return settle({})
  // A page that takes the wheel over halfway through gets it. It asked; the user is inside its widget.
  if (sample.refused) return settle({ latch: 'page' })
  return advance({ ...current, lastAt }, sample.deltaX)
}

function advance(
  state: SwipeTracker,
  deltaX: number
): { state: SwipeTracker; intent: NavigationIntent | null } {
  const travelled = Math.max(0, state.travelled + deltaX * state.direction)
  if (travelled < SWIPE_THRESHOLD_PX) return { state: { ...state, travelled }, intent: null }
  return {
    state: { ...state, latch: 'spent', travelled },
    intent: state.direction < 0 ? 'back' : 'forward'
  }
}
