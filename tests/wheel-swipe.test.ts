import { describe, expect, it } from 'vitest'
import {
  IDLE_SWIPE,
  SWIPE_GESTURE_GAP_MS,
  SWIPE_THRESHOLD_PX,
  hasRoomToScroll,
  isHorizontalWheel,
  stepSwipe,
  swipeWheelSample,
  type SwipeSample,
  type SwipeTracker,
  type WheelSwipeEvent
} from '@shared/gestures/wheel-swipe.js'

/**
 * The two-finger swipe: which wheel events may be one, and when a run of them navigates.
 *
 * *"Es wäre gut, wenn man mit dem Touch-Pad auch zurück gehen könnte. Wie bei Google Chrome gibt es ja
 * eine zwei finger schiebe bewegung dazu"* — the three-finger `swipe` event was wired, the two-finger
 * gesture never reached the browser as anything but scrolling.
 *
 * The failure that matters more than a swipe that does nothing is **leaving a page the user was
 * scrolling**: a carousel flicked to its end, a table scrolled sideways, a map dragged. Those cases have
 * tests of their own below.
 */

function wheel(overrides: Partial<WheelSwipeEvent> = {}): WheelSwipeEvent {
  return {
    isTrusted: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    deltaX: -20,
    deltaY: 0,
    deltaMode: 0,
    ...overrides
  }
}

/** A run of events 16 ms apart, the way a trackpad delivers one, fed from `start`. */
function run(
  deltas: ReadonlyArray<Partial<SwipeSample>>,
  start: SwipeTracker = IDLE_SWIPE,
  from = 1000
): { state: SwipeTracker; intents: string[] } {
  let state = start
  const intents: string[] = []
  deltas.forEach((overrides, index) => {
    const step = stepSwipe(state, {
      at: from + index * 16,
      deltaX: 0,
      deltaY: 0,
      pageCanScroll: false,
      refused: false,
      ...overrides
    })
    state = step.state
    if (step.intent !== null) intents.push(step.intent)
  })
  return { state, intents }
}

const sideways = (deltaX: number, count: number, extra: Partial<SwipeSample> = {}) =>
  Array.from({ length: count }, () => ({ deltaX, ...extra }))

describe('which wheel events may be a swipe', () => {
  it('takes a plain trusted pixel scroll', () => {
    expect(swipeWheelSample(wheel({ deltaX: -12, deltaY: 3 }))).toEqual({ deltaX: -12, deltaY: 3 })
  })

  it('refuses one a page synthesised, so no page can press the back button', () => {
    expect(swipeWheelSample(wheel({ isTrusted: false }))).toBeNull()
  })

  it('refuses a pinch and a Shift-scroll, and every other modifier', () => {
    // Ctrl is how Chromium reports a pinch; Shift is a mouse wheel scrolling sideways.
    for (const key of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'] as const) {
      expect(swipeWheelSample(wheel({ [key]: true })), key).toBeNull()
    }
  })

  it('refuses line and page deltas, and values that are not numbers', () => {
    expect(swipeWheelSample(wheel({ deltaMode: 1 }))).toBeNull()
    expect(swipeWheelSample(wheel({ deltaMode: 2 }))).toBeNull()
    expect(swipeWheelSample(wheel({ deltaX: Number.NaN }))).toBeNull()
    expect(swipeWheelSample(wheel({ deltaY: Number.POSITIVE_INFINITY }))).toBeNull()
  })

  it('calls an event sideways only when it is more sideways than not', () => {
    expect(isHorizontalWheel(-10, 2)).toBe(true)
    expect(isHorizontalWheel(10, -9)).toBe(true)
    // The diagonal is a scroll: a tie must not go to the gesture that leaves the page.
    expect(isHorizontalWheel(10, 10)).toBe(false)
    expect(isHorizontalWheel(0, 0)).toBe(false)
    expect(isHorizontalWheel(2, 30)).toBe(false)
  })
})

describe('whether a box can still scroll', () => {
  const box = { scrollWidth: 1000, clientWidth: 400, rtl: false }

  it('has room both ways in the middle, and none past either edge', () => {
    expect(hasRoomToScroll({ ...box, scrollLeft: 300 }, -1)).toBe(true)
    expect(hasRoomToScroll({ ...box, scrollLeft: 300 }, 1)).toBe(true)
    expect(hasRoomToScroll({ ...box, scrollLeft: 0 }, -1)).toBe(false)
    expect(hasRoomToScroll({ ...box, scrollLeft: 600 }, 1)).toBe(false)
  })

  it('treats a box half a pixel from its end as at its end', () => {
    // Fractional positions at zoom levels other than 100 %: otherwise the box claims every swipe.
    expect(hasRoomToScroll({ ...box, scrollLeft: 0.5 }, -1)).toBe(false)
    expect(hasRoomToScroll({ ...box, scrollLeft: 599.5 }, 1)).toBe(false)
  })

  it('has no room at all when nothing overflows', () => {
    expect(
      hasRoomToScroll({ scrollLeft: 0, scrollWidth: 400, clientWidth: 400, rtl: false }, 1)
    ).toBe(false)
  })

  it('reads a right-to-left box from its right edge', () => {
    const rtl = { ...box, rtl: true }
    // At its start — the right edge — a right-to-left box can only scroll leftwards.
    expect(hasRoomToScroll({ ...rtl, scrollLeft: 0 }, 1)).toBe(false)
    expect(hasRoomToScroll({ ...rtl, scrollLeft: 0 }, -1)).toBe(true)
    expect(hasRoomToScroll({ ...rtl, scrollLeft: -600 }, -1)).toBe(false)
    expect(hasRoomToScroll({ ...rtl, scrollLeft: -600 }, 1)).toBe(true)
  })
})

describe('a swipe at the edge of the page', () => {
  const enough = Math.ceil(SWIPE_THRESHOLD_PX / 20) + 1

  it('goes back when scrolled leftwards past the threshold', () => {
    expect(run(sideways(-20, enough)).intents).toEqual(['back'])
  })

  it('goes forward when scrolled rightwards past it', () => {
    expect(run(sideways(20, enough)).intents).toEqual(['forward'])
  })

  it('does nothing short of the threshold', () => {
    expect(run(sideways(-20, Math.floor(SWIPE_THRESHOLD_PX / 20) - 1)).intents).toEqual([])
  })

  it('navigates once, however much momentum follows', () => {
    // The momentum macOS sends after the fingers lift is part of the same run.
    expect(run(sideways(-20, enough * 5)).intents).toEqual(['back'])
  })

  it('navigates again after a pause, which starts a new gesture', () => {
    const first = run(sideways(-20, enough))
    const second = run(
      sideways(-20, enough),
      first.state,
      1000 + enough * 16 + SWIPE_GESTURE_GAP_MS + 1
    )
    expect([...first.intents, ...second.intents]).toEqual(['back', 'back'])
  })

  it('shortens when the fingers come back, but never turns around', () => {
    // Back most of the way, then all the way the other way: neither direction navigates.
    const half = Math.floor(SWIPE_THRESHOLD_PX / 20) - 1
    expect(run([...sideways(-20, half), ...sideways(20, half * 3)]).intents).toEqual([])
  })

  it('keeps going sideways even when single events drift vertical', () => {
    const wobbly = Array.from({ length: enough + 2 }, (_, index) =>
      index % 3 === 1 ? { deltaX: -5, deltaY: 12 } : { deltaX: -20 }
    )
    expect(run(wobbly).intents).toEqual(['back'])
  })
})

describe('what must not navigate', () => {
  const plenty = Math.ceil(SWIPE_THRESHOLD_PX / 20) * 4

  it('a run that began as vertical scrolling, however far it drifts sideways', () => {
    expect(run([{ deltaY: 30 }, ...sideways(-20, plenty)]).intents).toEqual([])
  })

  it('a carousel flicked to its end: the page scrolled first, so the whole run is the page’s', () => {
    // Room for the first events, none after — the edge arriving mid-gesture must not become a swipe.
    const flick = [...sideways(-20, 3, { pageCanScroll: true }), ...sideways(-20, plenty)]
    expect(run(flick).intents).toEqual([])
  })

  it('a page that handles the wheel itself, like a map', () => {
    expect(run(sideways(-20, plenty, { refused: true })).intents).toEqual([])
  })

  it('a page that takes the wheel over halfway through', () => {
    const near = Math.floor(SWIPE_THRESHOLD_PX / 20) - 1
    expect(
      run([...sideways(-20, near), ...sideways(-20, plenty, { refused: true })]).intents
    ).toEqual([])
  })

  it('but a latch ends with its gesture: the next swipe is judged afresh', () => {
    const scrolled = run([{ deltaY: 30 }])
    const later = run(sideways(-20, plenty), scrolled.state, 1000 + SWIPE_GESTURE_GAP_MS + 1)
    expect(later.intents).toEqual(['back'])
  })
})

describe('events that arrive out of order', () => {
  it('does not move the clock backwards, so a late event cannot end a gesture early', () => {
    const { state } = run([{ deltaY: 30 }], IDLE_SWIPE, 5000)
    const late = stepSwipe(state, {
      at: 4990,
      deltaX: -20,
      deltaY: 0,
      pageCanScroll: false,
      refused: false
    })
    expect(late.state.lastAt).toBe(5000)
    expect(late.state.latch).toBe('scroll')
  })
})
