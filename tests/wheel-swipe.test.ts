import { describe, expect, it } from 'vitest'
import {
  IDLE_SWIPE,
  SWIPE_GESTURE_GAP_MS,
  SWIPE_THRESHOLD_PX,
  endSwipe,
  hasRoomToScroll,
  isHorizontalWheel,
  stepSwipe,
  swipeIndicatorOf,
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

/**
 * A run of events 16 ms apart, the way a trackpad delivers one, fed from `start` — and then, unless
 * told otherwise, let go: `endSwipe`, which is what the preload calls on the silence after it.
 *
 * `state` is the run as it stood *before* letting go, so a test can ask what the arrow showed.
 */
function run(
  deltas: ReadonlyArray<Partial<SwipeSample>>,
  start: SwipeTracker = IDLE_SWIPE,
  from = 1000,
  release = true
): { state: SwipeTracker; intents: string[]; after: SwipeTracker } {
  let state = start
  const intents: string[] = []
  deltas.forEach((overrides, index) => {
    const step = stepSwipe(state, {
      at: from + index * 16,
      deltaX: 0,
      deltaY: 0,
      innerCanScroll: false,
      viewportCanScroll: false,
      refused: false,
      ...overrides
    })
    state = step.state
    if (step.intent !== null) intents.push(step.intent)
  })
  if (!release) return { state, intents, after: state }
  const end = endSwipe(state)
  if (end.intent !== null) intents.push(end.intent)
  return { state, intents, after: end.state }
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
      first.after,
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

  it('a carousel flicked to its end: the element scrolled first, so the whole run is the element’s', () => {
    // Room for the first events, none after — the edge arriving mid-gesture must not become a swipe.
    const flick = [...sideways(-20, 3, { innerCanScroll: true }), ...sideways(-20, plenty)]
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
    const later = run(sideways(-20, plenty), scrolled.after, 1000 + SWIPE_GESTURE_GAP_MS + 1)
    expect(later.intents).toEqual(['back'])
  })
})

describe('changing your mind before letting go', () => {
  const enough = Math.ceil(SWIPE_THRESHOLD_PX / 20) + 1

  it('does not navigate while the fingers are still on the pad, however far past the threshold', () => {
    expect(run(sideways(-20, enough * 3), IDLE_SWIPE, 1000, false).intents).toEqual([])
  })

  it('does nothing when brought back below the threshold before letting go', () => {
    expect(run([...sideways(-20, enough), ...sideways(20, 3)]).intents).toEqual([])
  })

  it('navigates after all when pushed past it again', () => {
    expect(
      run([...sideways(-20, enough), ...sideways(20, 3), ...sideways(-20, 3)]).intents
    ).toEqual(['back'])
  })

  it('does not navigate when the page takes the wheel over while armed', () => {
    expect(run([...sideways(-20, enough), ...sideways(-20, 1, { refused: true })]).intents).toEqual(
      []
    )
  })

  it('still navigates when the release timer ran late and the next gesture arrived first', () => {
    // A busy page can starve a timer. The late navigation beats a lost one.
    const armed = run(sideways(-20, enough), IDLE_SWIPE, 1000, false)
    const next = stepSwipe(armed.state, {
      at: armed.state.lastAt + SWIPE_GESTURE_GAP_MS + 1,
      deltaX: 0,
      deltaY: 30,
      innerCanScroll: false,
      viewportCanScroll: false,
      refused: false
    })
    expect(next.intent).toBe('back')
    expect(next.state.latch).toBe('scroll')
  })

  it('ends with a clean slate, armed or not', () => {
    expect(endSwipe(run(sideways(-20, enough), IDLE_SWIPE, 1000, false).state).state).toEqual(
      IDLE_SWIPE
    )
    expect(endSwipe(run(sideways(-20, 2), IDLE_SWIPE, 1000, false).state)).toEqual({
      state: IDLE_SWIPE,
      intent: null
    })
  })
})

describe('scrolling the page itself up to its edge, then on', () => {
  const enough = Math.ceil(SWIPE_THRESHOLD_PX / 20) + 1
  const scrolling = (count: number) => sideways(-20, count, { viewportCanScroll: true })

  it('goes back in the same movement once the page has no room left', () => {
    // How Chrome's gesture is used on a wide page: scroll to the edge, keep going.
    expect(run([...scrolling(10), ...sideways(-20, enough)]).intents).toEqual(['back'])
  })

  it('counts only the distance past the edge', () => {
    const short = Math.floor(SWIPE_THRESHOLD_PX / 20) - 1
    expect(run([...scrolling(30), ...sideways(-20, short)]).intents).toEqual([])
  })

  it('does nothing while the page still has room, however far it scrolls', () => {
    expect(run(scrolling(100)).intents).toEqual([])
  })

  it('does not start a swipe from an event that drifted vertical at the edge', () => {
    const drift = Array.from({ length: 40 }, () => ({ deltaX: -5, deltaY: 12 }))
    expect(run([...scrolling(3), ...drift]).intents).toEqual([])
  })

  it('finds the edge afresh after the swipe is undone by scrolling back', () => {
    const near = Math.floor(SWIPE_THRESHOLD_PX / 20) - 1
    const { intents } = run([
      ...sideways(-20, near),
      // Back the other way, where the page has room: this is scrolling again, not a shorter swipe.
      ...sideways(20, near + 5, { viewportCanScroll: true }),
      ...scrolling(near + 5),
      // At the edge once more: only what comes now counts.
      ...sideways(-20, near)
    ])
    expect(intents).toEqual([])
  })

  it('yields to a page that refuses the wheel on the way to the edge', () => {
    expect(run([...scrolling(3), ...sideways(-20, enough * 3, { refused: true })]).intents).toEqual(
      []
    )
  })
})

describe('events that arrive out of order', () => {
  it('does not move the clock backwards, so a late event cannot end a gesture early', () => {
    const { state } = run([{ deltaY: 30 }], IDLE_SWIPE, 5000, false)
    const late = stepSwipe(state, {
      at: 4990,
      deltaX: -20,
      deltaY: 0,
      innerCanScroll: false,
      viewportCanScroll: false,
      refused: false
    })
    expect(late.state.lastAt).toBe(5000)
    expect(late.state.latch).toBe('scroll')
  })
})

describe('what the arrow shows', () => {
  const at = (latch: SwipeTracker['latch'], travelled: number, direction: -1 | 1 = -1) => ({
    ...IDLE_SWIPE,
    latch,
    travelled,
    direction
  })

  it('shows nothing while scrolling, in an element, or before the edge', () => {
    for (const latch of ['none', 'scroll', 'page', 'viewport'] as const) {
      expect(swipeIndicatorOf(at(latch, 50)), latch).toBeNull()
    }
    // A swipe undone to where it began.
    expect(swipeIndicatorOf(at('swipe', 0))).toBeNull()
  })

  it('comes in from the left for back and from the right for forward', () => {
    expect(swipeIndicatorOf(at('swipe', 50, -1))?.side).toBe('left')
    expect(swipeIndicatorOf(at('swipe', 50, 1))?.side).toBe('right')
  })

  it('follows the distance past the edge up to the threshold, and no further', () => {
    expect(swipeIndicatorOf(at('swipe', SWIPE_THRESHOLD_PX / 2))).toEqual({
      side: 'left',
      progress: 0.5,
      armed: false
    })
    expect(swipeIndicatorOf(at('swipe', SWIPE_THRESHOLD_PX * 3))?.progress).toBe(1)
  })

  it('is armed from the threshold on, which is when letting go would navigate', () => {
    expect(swipeIndicatorOf(at('swipe', SWIPE_THRESHOLD_PX - 1))?.armed).toBe(false)
    expect(swipeIndicatorOf(at('swipe', SWIPE_THRESHOLD_PX))).toEqual({
      side: 'left',
      progress: 1,
      armed: true
    })
  })

  it('says armed exactly when letting go navigates', () => {
    for (const count of [5, 9, 10, 11, 30]) {
      const { state, intents } = run(sideways(-20, count))
      expect(swipeIndicatorOf(state)?.armed, `${count} steps`).toBe(intents.length === 1)
    }
  })
})
