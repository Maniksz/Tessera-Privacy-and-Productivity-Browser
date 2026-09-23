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
 * the momentum macOS keeps sending after the fingers lift is part of the same run.
 *
 * ## Why it navigates at the end and not at the threshold
 *
 * *"das zurück sollte erst triggern, wenn ich loslasse, falls ich mich umentscheide"*. Crossing the
 * threshold only **arms** the swipe; the navigation waits for the gesture to end, and a swipe brought
 * back below the threshold before then is disarmed and does nothing. Chrome does the same on the
 * fingers leaving the pad.
 *
 * The end of the run is the nearest thing to that the DOM offers, and the difference is the momentum:
 * the navigation comes when the momentum has run out rather than the instant the fingers lift. Nothing
 * is lost by it — momentum only ever carries a swipe further the way it was going, so it cannot
 * change the decision the fingers left behind; it can only delay hearing it.
 *
 * Each run is latched to what it started as, the way Chrome latches a scroll to the box it began in.
 * A run that began vertically stays a scroll however far it drifts sideways. A run that began inside
 * a scrollable *element* — a carousel, a wide table — stays that element's even after it hits its
 * edge, which is what lets a carousel be flicked to its end without the browser leaving the page on
 * the last pixel.
 *
 * The page itself is the exception, and deliberately: scrolling a wide page sideways and carrying on
 * past its edge in the same movement is how Chrome's gesture is used — *"mit zwei fingern kann man bei
 * chrome ja auch scrollen, bis man den rand trifft, dann kann man weiter wischen"*. So a run that began
 * by scrolling the viewport scrolls it for as long as it has room and becomes a swipe from the first
 * event that finds none. Only the distance past the edge counts towards the threshold.
 */

/** Preload -> core: one completed swipe, already reduced to a direction. */
export const SWIPE_GESTURE_CHANNEL = 'tessera:swipe-gesture'

/**
 * How far past the edge, in CSS pixels, a swipe has to travel before it navigates.
 *
 * A feel value, not a derived one. A deliberate two-finger swipe on a Mac trackpad, momentum
 * included, travels several hundred pixels; a sideways brush while reading travels a few dozen. Two
 * hundred sits between them.
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
 *   - `page`: an element in the page scrolled it, or the page refused it.
 *   - `viewport`: it is scrolling the page itself, which still has room; at the edge it becomes a swipe.
 *   - `swipe`: it is travelling past an edge of the page — armed once `travelled` reaches the threshold.
 */
export type SwipeLatch = 'none' | 'scroll' | 'page' | 'viewport' | 'swipe'

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
  /** Whether an element under the pointer could still scroll this event's way before it arrived. */
  readonly innerCanScroll: boolean
  /** Whether the page itself — the viewport — could, measured at the same moment. */
  readonly viewportCanScroll: boolean
  /** Whether the page called `preventDefault` on it. */
  readonly refused: boolean
}

export interface SwipeStep {
  readonly state: SwipeTracker
  /** A navigation the run just *ended* with; never one the run in progress has merely armed. */
  readonly intent: NavigationIntent | null
}

/** Whether the run is past the threshold, so that ending it now would navigate. */
export function isArmed(state: SwipeTracker): boolean {
  return state.latch === 'swipe' && state.travelled >= SWIPE_THRESHOLD_PX
}

/**
 * Ends the run: the navigation it was armed for, if it still is, and a clean slate either way.
 *
 * Called by the preload on the silence that ends a gesture. It is also what `stepSwipe` does itself
 * when an event arrives after that silence, so a timer that ran late — a busy page can starve one —
 * delays the navigation instead of losing it.
 */
export function endSwipe(state: SwipeTracker): SwipeStep {
  if (!isArmed(state)) return { state: IDLE_SWIPE, intent: null }
  return { state: IDLE_SWIPE, intent: state.direction < 0 ? 'back' : 'forward' }
}

/**
 * Feeds one wheel event into the run it belongs to.
 *
 * Negative `deltaX` is scrolling leftwards, which is back — the same in Chrome, and independent of
 * the "natural scrolling" setting, because that setting has already been applied to the delta by the
 * time a page sees it. Leftwards past the left edge uncovers what came before, as `navigation.ts`
 * says of the three-finger swipe.
 *
 * Travel back towards the start shortens the swipe, below the threshold disarms it, and it cannot
 * turn it around. Chrome does the same, and the alternative is worse than it sounds: a swipe begun at
 * the left edge and reversed would scroll the page rightwards *and* count towards going forward, both
 * at once. On a page that does scroll back that way, a swipe undone completely is scrolling again,
 * and the edge is found afresh.
 */
export function stepSwipe(state: SwipeTracker, sample: SwipeSample): SwipeStep {
  const ended = sample.at - state.lastAt > SWIPE_GESTURE_GAP_MS ? endSwipe(state) : null
  const current = ended?.state ?? state
  const intent = ended?.intent ?? null
  // Never backwards: events are read in two passes (see the preload), so they can land out of order.
  const lastAt = Math.max(current.lastAt, sample.at)
  const settle = (next: Partial<SwipeTracker>): SwipeStep => ({
    state: { ...current, ...next, lastAt },
    intent
  })
  const travel = (from: SwipeTracker): SwipeStep => ({
    state: {
      ...from,
      lastAt,
      travelled: Math.max(0, from.travelled + sample.deltaX * from.direction)
    },
    intent
  })

  const sideways = isHorizontalWheel(sample.deltaX, sample.deltaY)
  const beginSwipe = (): SwipeStep =>
    travel({ latch: 'swipe', travelled: 0, direction: sample.deltaX < 0 ? -1 : 1, lastAt })

  if (current.latch === 'none') {
    if (!sideways) return settle({ latch: 'scroll' })
    if (sample.innerCanScroll || sample.refused) return settle({ latch: 'page' })
    if (sample.viewportCanScroll) return settle({ latch: 'viewport' })
    return beginSwipe()
  }

  // A page that takes the wheel over halfway through gets it. It asked; the user is inside its widget.
  if ((current.latch === 'viewport' || current.latch === 'swipe') && sample.refused) {
    return settle({ latch: 'page', travelled: 0 })
  }

  if (current.latch === 'viewport') {
    // Still room, or an event that drifted vertical: the page scrolls and nothing counts yet.
    if (sample.viewportCanScroll || !sideways) return settle({})
    return beginSwipe()
  }

  if (current.latch !== 'swipe') return settle({})
  const step = travel(current)
  if (step.state.travelled === 0 && sample.viewportCanScroll) {
    return settle({ latch: 'viewport', travelled: 0 })
  }
  return step
}

/**
 * What the swipe looks like on screen at this moment, or `null` for nothing.
 *
 * The indicator is the answer to *"sollte aber eher eine animation haben"*: without it the gesture
 * is invisible until the page is suddenly gone, and a user who stops short has no way to learn how
 * far "far enough" is. It follows the fingers past the edge and fills at the threshold, which is
 * what Chrome's arrow does — and since the navigation now waits for the end of the gesture, it is
 * also the only way to see that letting go *now* will navigate, and that coming back will not.
 */
export interface SwipeIndicator {
  /** The edge it comes in from: the left for back, where the fingers are heading. */
  readonly side: 'left' | 'right'
  /** `0` just past the edge, `1` at the threshold. */
  readonly progress: number
  /** Past the threshold: ending the gesture now navigates. */
  readonly armed: boolean
}

export function swipeIndicatorOf(state: SwipeTracker): SwipeIndicator | null {
  // Nothing past the edge yet — a swipe scrolled back to where it began — is nothing to show.
  if (state.latch !== 'swipe' || state.travelled === 0) return null
  return {
    side: state.direction < 0 ? 'left' : 'right',
    progress: Math.min(1, state.travelled / SWIPE_THRESHOLD_PX),
    armed: isArmed(state)
  }
}
