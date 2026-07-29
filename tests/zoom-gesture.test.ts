import { describe, expect, it } from 'vitest'
import { ZOOM_STOPS, nextZoomPercent } from '@shared/gestures/zoom.js'

/**
 * The zoom ladder, shared by the pinch gesture and the keyboard.
 *
 * Two requirements, and only the second is obvious. The steps have to be values a browser shows —
 * a trackpad pinch produces a stream of events, and ten per notch lands on 83 % and 117 %, sizes
 * nobody chose and at which text reflows oddly. And the two routes have to walk the *same* ladder,
 * because a browser where `Ctrl+` and the trackpad take different-sized steps does not come back to
 * where it started, which is a thing people feel and never report.
 *
 * The awkward case is a value that is not on the ladder at all, and it is not hypothetical: the menu
 * moved in tens for as long as this browser has existed, so a pane sitting at 120 % — left there by
 * that period and brought back out of the session file — is ordinary, and so is any
 * `appearance.defaultZoom` the user typed. Landing that on the wrong side is a first press that
 * appears to go backwards.
 */

describe('the ladder itself', () => {
  it('rises without repeating', () => {
    // A duplicate or a dip would make one press a no-op or a reversal, depending on direction.
    for (let index = 1; index < ZOOM_STOPS.length; index += 1) {
      const [previous] = ZOOM_STOPS.slice(index - 1, index)
      const [current] = ZOOM_STOPS.slice(index, index + 1)
      expect(current, `stop ${index}`).toBeGreaterThan(previous ?? 0)
    }
  })

  it('holds 100 %, which is the one stop that has to be reachable', () => {
    // Reachable by pinching rather than something the user has to hit exactly.
    expect(ZOOM_STOPS).toContain(100)
  })

  it('stays inside the range the rest of the browser clamps to', () => {
    // `clampZoomPercent` holds every stored zoom to 30–300. A stop outside that would be a step the
    // ladder offers and the pane silently refuses, which reads as a stuck gesture. Cross-checked
    // against the clamp's own constants in `view-zoom.test.ts`.
    for (const stop of ZOOM_STOPS) {
      expect(stop).toBeGreaterThanOrEqual(30)
      expect(stop).toBeLessThanOrEqual(300)
    }
  })
})

describe('one step', () => {
  it('moves to the next stop up and the next stop down', () => {
    expect(nextZoomPercent(100, 'in')).toBe(110)
    expect(nextZoomPercent(100, 'out')).toBe(90)
  })

  it('returns to where it started after in and out', () => {
    // The property that matters more than any single step, and the one two ladders would break.
    for (const stop of ZOOM_STOPS.slice(1, ZOOM_STOPS.length - 1)) {
      expect(nextZoomPercent(nextZoomPercent(stop, 'in'), 'out'), `${stop}%`).toBe(stop)
      expect(nextZoomPercent(nextZoomPercent(stop, 'out'), 'in'), `${stop}%`).toBe(stop)
    }
  })

  it('steps forward from a value that is not on the ladder', () => {
    /*
      120 % is what years of `± 10` left behind in panes and in saved sessions. Zooming in from there has
      to reach 125, not 110: the nearest stop is *below*, so an implementation that snapped to the
      nearest would make the first press after an upgrade go the wrong way.
    */
    expect(nextZoomPercent(120, 'in')).toBe(125)
    expect(nextZoomPercent(120, 'out')).toBe(110)
    expect(nextZoomPercent(83, 'in')).toBe(90)
    expect(nextZoomPercent(83, 'out')).toBe(80)
  })

  it('stops at the top and the bottom rather than wrapping', () => {
    expect(nextZoomPercent(300, 'in')).toBe(300)
    expect(nextZoomPercent(30, 'out')).toBe(30)
  })

  it('leaves a value beyond either end where it is', () => {
    // Reachable from a hand-edited settings file. Pulled to a stop, the gesture would appear to work
    // and would change the zoom by 200 points on one notch.
    expect(nextZoomPercent(400, 'in')).toBe(400)
    expect(nextZoomPercent(10, 'out')).toBe(10)
  })

  it('brings an out-of-range value back towards the ladder', () => {
    // The other direction from the same state: stepping *towards* the ladder is how a page recovers
    // from a value the ladder does not contain.
    expect(nextZoomPercent(400, 'out')).toBe(300)
    expect(nextZoomPercent(10, 'in')).toBe(30)
  })
})

describe('the ends of the ladder', () => {
  it('are the two constants the clamp uses', () => {
    /*
      `nextZoomPercent` names 30 and 300 directly rather than reading `ZOOM_STOPS[0]`, because an index
      needs a fallback and a fallback on a non-empty literal is a branch no test can reach — and this
      directory's coverage gate is absolute, so an unreachable branch is what makes somebody lower a
      gate. This assertion is what the fallback used to be: if the ladder's ends ever move, the clamp
      goes wrong and this fails, rather than the clamp silently disagreeing with the ladder.
    */
    const [lowest] = ZOOM_STOPS.slice(0, 1)
    const [highest] = ZOOM_STOPS.slice(ZOOM_STOPS.length - 1, ZOOM_STOPS.length)
    expect(lowest, 'the lowest stop moved; the clamp in nextZoomPercent still says 30').toBe(30)
    expect(highest, 'the highest stop moved; the clamp in nextZoomPercent still says 300').toBe(300)
  })
})
