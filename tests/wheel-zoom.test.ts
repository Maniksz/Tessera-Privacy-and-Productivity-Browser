import { describe, expect, it } from 'vitest'
import {
  PINCH_GRACE_MS,
  ZOOM_STEP_DELTA,
  decideZoomTarget,
  pinchInputPhase,
  stepWheelZoom,
  wheelZoomDelta,
  type WheelZoomEvent
} from '@shared/gestures/wheel-zoom.js'
import { ZOOM_STOPS } from '@shared/gestures/zoom.js'

/**
 * The zoom gesture: what counts as one, how much of one makes a step, and whose pane it is.
 *
 * `zoom-gesture.test.ts` next door covers the ladder — how far one step goes. This covers everything
 * that has to be settled before a step is taken at all.
 *
 * ## What was reported
 *
 * *"warum geht kein zoom per kachel einzeln mit der pinch geste auf einem touchpad?"*. The pinch never
 * reached this browser at all: `zoom-changed` is a mouse-wheel event by Electron's own typings, and
 * visual zoom is off by default in Electron.
 *
 * It was answered first by reading the gesture in the renderer, where Chromium delivers a trackpad
 * pinch as a `Ctrl`-wheel, and stepping the page-zoom ladder from it. That worked and was slow, and
 * the second half of the original problem — *"visual zoom is off by default"* — turned out to be the
 * answer rather than an obstacle: switching it on hands the pinch to the engine's own page-scale
 * zoom, which is per view and costs no layout. So the reading below stays, and what it decides
 * changed: a pinch is now recognised in order to be *ignored*.
 *
 * ## The two directions of failure, which are not symmetrical
 *
 * A pinch that does not zoom is the defect this exists for. But **zooming something the user did not
 * point at is worse**, and there are two ways to do it: a page synthesising a wheel event, and half a
 * gesture landing on a different pane from the other half. Both have tests here saying so, rather
 * than being left as properties somebody could tidy away.
 */

function wheel(overrides: Partial<WheelZoomEvent> = {}): WheelZoomEvent {
  return {
    isTrusted: true,
    defaultPrevented: false,
    ctrlKey: true,
    deltaY: -120,
    deltaMode: 0,
    ...overrides
  }
}

describe('what counts as a zoom gesture', () => {
  it('reads the delta out of a real Ctrl-wheel', () => {
    expect(wheelZoomDelta(wheel({ deltaY: -120 }))).toBe(-120)
    expect(wheelZoomDelta(wheel({ deltaY: 100 }))).toBe(100)
  })

  it('refuses an event the page dispatched itself', () => {
    /*
      The check that must not be dropped. `dispatchEvent` can produce a wheel event with `ctrlKey`
      set, and with the pinch routed to the *focused* pane this is worse than a nuisance: the page
      under the pointer would be zooming a pane showing somebody else's site.
    */
    expect(wheelZoomDelta(wheel({ isTrusted: false }))).toBeNull()
  })

  it('leaves the gesture to a page that handled it', () => {
    // A map, a design tool, anything with a canvas. This is what every browser does, and honouring it
    // is the whole reason the reading happens in the renderer rather than in the core.
    expect(wheelZoomDelta(wheel({ defaultPrevented: true }))).toBeNull()
  })

  it('is not a zoom without Ctrl', () => {
    // Plain scrolling, which is most wheel events on most pages.
    expect(wheelZoomDelta(wheel({ ctrlKey: false }))).toBeNull()
  })

  it('refuses a delta that is not in pixels', () => {
    // Chromium always sends pixels, so this is insurance rather than a live branch. A line- or
    // page-based delta scaled as if it were pixels would need thirty notches per stop, which reads
    // as "zoom is broken" rather than as a wrong unit.
    for (const deltaMode of [1, 2]) {
      expect(wheelZoomDelta(wheel({ deltaMode })), String(deltaMode)).toBeNull()
    }
  })

  it('refuses a delta that says nothing', () => {
    for (const deltaY of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(wheelZoomDelta(wheel({ deltaY })), String(deltaY)).toBeNull()
    }
  })
})

describe('accumulating a stream into steps', () => {
  it('makes one notch of a mouse wheel exactly one step', () => {
    /*
      The calibration that keeps a working feature working. `Ctrl`-wheel zoomed one stop per notch
      before the gesture moved into the preload, and a threshold needing two turns would be reported
      as a regression by everyone who has a mouse.
    */
    expect(stepWheelZoom(0, -ZOOM_STEP_DELTA)).toEqual({ carry: 0, steps: -1 })
    expect(stepWheelZoom(0, ZOOM_STEP_DELTA)).toEqual({ carry: 0, steps: 1 })
  })

  it('sums a pinch, which arrives in far smaller pieces', () => {
    // The defect this prevents, as arithmetic: applied one stop each, these ten events would run the
    // ladder most of the way to its end while the fingers were still moving.
    let carry = 0
    let taken = 0
    for (let event = 0; event < 10; event += 1) {
      const step = stepWheelZoom(carry, -12)
      carry = step.carry
      taken += step.steps
    }
    expect(taken, 'ten pinch events are one stop, not ten').toBe(-1)
    expect(ZOOM_STOPS.length, 'a ladder short enough for ten steps to matter').toBeGreaterThan(5)
  })

  it('carries the remainder into the next event', () => {
    const first = stepWheelZoom(0, -60)
    expect(first).toEqual({ carry: -60, steps: 0 })
    expect(stepWheelZoom(first.carry, -60)).toEqual({ carry: -20, steps: -1 })
  })

  it('takes several steps from one hard turn of a wheel', () => {
    expect(stepWheelZoom(0, 250)).toEqual({ carry: 50, steps: 2 })
  })

  it('discards the carry when the fingers change their mind', () => {
    /*
      Pinching in and then out again is two gestures in one motion. Subtracting the leftover instead
      would make the first stop of the way back need less movement than every stop after it — loose
      in one direction and tight in the other.
    */
    const inwards = stepWheelZoom(0, -90)
    expect(inwards.carry).toBe(-90)
    expect(stepWheelZoom(inwards.carry, 40), 'the reversal kept the old carry').toEqual({
      carry: 40,
      steps: 0
    })
  })

  it('keeps the sign a wheel has: towards the user zooms in', () => {
    // Ctrl and scrolling up, and fingers spreading on a trackpad. One convention, and reversing it
    // is a single negation away — which is why it is asserted rather than assumed.
    expect(stepWheelZoom(0, -ZOOM_STEP_DELTA).steps).toBeLessThan(0)
    expect(stepWheelZoom(0, ZOOM_STEP_DELTA).steps).toBeGreaterThan(0)
  })
})

describe('recognising the pinch bracket', () => {
  it('reads the two ends Chromium dispatches', () => {
    expect(pinchInputPhase({ type: 'gesturePinchBegin' })).toBe('begin')
    expect(pinchInputPhase({ type: 'gesturePinchEnd' })).toBe('end')
  })

  it('ignores everything else on the same subscription', () => {
    // Keyboard, pointer and wheel events all arrive here — and so does `gesturePinchUpdate`, which is
    // deliberately not read, because whether it is dispatched at all is unverified.
    for (const type of ['mouseDown', 'mouseWheel', 'keyDown', 'gesturePinchUpdate']) {
      expect(pinchInputPhase({ type }), type).toBeNull()
    }
  })

  it('survives a payload that is not one', () => {
    // The value is Electron's untyped `input-event` argument; nothing guarantees its shape.
    const shapes: Array<[string, unknown]> = [
      ['null', null],
      ['undefined', undefined],
      ['a number', 42],
      ['the type as a bare string', 'gesturePinchBegin'],
      ['an object with no type', {}]
    ]
    for (const [name, input] of shapes) {
      expect(pinchInputPhase(input), name).toBeNull()
    }
  })
})

describe('which pane a step lands on', () => {
  it('gives a wheel to the pane it landed on, active or not', () => {
    // The user's own decision of 29.07.2026, unchanged: on a mouse the hand is on the pointer, so
    // the pointer names the pane.
    expect(decideZoomTarget({ pinch: false, senderTabId: 'tab-hovered' })).toBe('tab-hovered')
  })

  it('gives a pinch to nobody, because the engine has already applied it', () => {
    /*
      The pinch is Chromium's now: `setVisualZoomLevelLimits` turns on the engine's own pinch-to-zoom,
      which is the page *scale* factor — per view, in the compositor, no layout. What still arrives
      here is the same gesture reported to the page as a `Ctrl`-wheel, and applying it would zoom the
      pane a second time by a second mechanism.

      The sender is the tempting fallback and is the whole of what this refuses: the pane under the
      pointer is a real tab, so returning it would type-check, run, and double every pinch.
    */
    expect(decideZoomTarget({ pinch: true, senderTabId: 'tab-hovered' })).toBeNull()
  })

  it('leaves room for the report that arrives after the pinch has ended', () => {
    /*
      Not a feel decision but a race, which is why the constant is asserted at all: the wheel events
      are read in the renderer and reported over IPC, while `gesturePinchEnd` reaches the core
      directly — so the last step or two of a pinch routinely arrives after the core has been told
      the fingers lifted. Without the grace those steps would land on the pane under the pointer
      while the rest of the same gesture landed on the focused one.
    */
    expect(PINCH_GRACE_MS, 'shorter than the IPC round trip it exists to cover').toBeGreaterThan(50)
    expect(PINCH_GRACE_MS, 'long enough to swallow a second, deliberate gesture').toBeLessThan(1000)
  })
})
