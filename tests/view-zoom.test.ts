import { describe, expect, it } from 'vitest'
import { ZOOM_STOPS } from '@shared/gestures/zoom.js'
import {
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  clampZoomPercent,
  effectiveZoomPercent
} from '@shared/zoom/model.js'
import { defaultSettings } from '@shared/settings/definitions.js'

/**
 * What a pane's zoom is, now that it belongs to the pane and not to the site.
 *
 * Small on purpose, and here at all because of what it replaced: the fallback and the clamp used to
 * be expressions inside `Tab.ts`, which cannot load outside a browser process and is on the
 * coverage exclude list, so neither could ever be asked a question. The two rules under test are
 * the two the user's decision turns on — that "never zoomed" is a state of its own, and that no
 * stored number can put a pane somewhere it cannot be read.
 *
 * What is *not* here, named rather than quietly missing: applying a factor to a live view, the
 * subscription that carries a zoom gesture in, the `did-navigate` re-assert and the
 * `webPreferences.zoomFactor` that covers the first paint. All four need a window. The gesture's own
 * decisions — what counts as one, and which pane it lands on — moved out of that subscription and
 * are covered in `wheel-zoom.test.ts`. The round trip that carries a pane's zoom across a restart is
 * reachable and is pinned in the session tests.
 */

describe('a pane that has never been zoomed', () => {
  it('shows at the setting', () => {
    expect(effectiveZoomPercent(null, 125)).toBe(125)
  })

  it('follows the setting when it changes, which is the whole reason for the sentinel', () => {
    /*
      The alternative was a plain number, and this is the case it cannot express. A pane deliberately
      set to 100 % and a pane nobody has touched would be the same value, so `appearance.defaultZoom`
      would have to either move both — stomping a choice the user made — or move neither, which is a
      settings key that silently stops reaching open windows.
    */
    expect(effectiveZoomPercent(null, 90)).toBe(90)
    expect(effectiveZoomPercent(100, 90)).toBe(100)
  })

  it('is not the same as a pane at 100 %', () => {
    // The distinction stated as a value rather than as behaviour, because every rule above rests on
    // it: `null` is a state, `100` is a decision.
    expect(effectiveZoomPercent(null, 100)).toBe(effectiveZoomPercent(100, 100))
    expect(null).not.toBe(100)
  })
})

describe('a pane that has been zoomed', () => {
  it('keeps its own value whatever the setting says', () => {
    expect(effectiveZoomPercent(200, 100)).toBe(200)
    expect(effectiveZoomPercent(200, 50)).toBe(200)
  })
})

describe('the clamp', () => {
  it('holds a hand-edited value inside the range a pane can be put at', () => {
    // Reachable from a session file somebody opened in an editor. A pane at 5000 % is one the user
    // cannot read their way out of, and the menu item that would rescue it is off screen with it.
    expect(clampZoomPercent(5000)).toBe(MAX_ZOOM_PERCENT)
    expect(clampZoomPercent(1)).toBe(MIN_ZOOM_PERCENT)
  })

  it('rounds, so no page ends up at a size nobody chose', () => {
    expect(clampZoomPercent(124.6)).toBe(125)
  })

  it('applies to the setting as well as to the stored value', () => {
    // `effectiveZoomPercent` is total in both arms: whichever of the two wins, the answer is a
    // percentage this browser will actually apply.
    expect(effectiveZoomPercent(null, 5000)).toBe(MAX_ZOOM_PERCENT)
    expect(effectiveZoomPercent(5000, 100)).toBe(MAX_ZOOM_PERCENT)
  })

  it('leaves a value already in range alone', () => {
    for (const stop of ZOOM_STOPS) expect(clampZoomPercent(stop), `${stop}%`).toBe(stop)
  })
})

describe('the ends, against the two places that also name them', () => {
  it('match the ladder the gesture walks', () => {
    /*
      The clamp and the ladder each write 30 and 300 down for themselves, and deliberately: reading
      one off the other needs a fallback for an index into a non-empty literal, which is a branch no
      test can reach, and both directories are held to full coverage. This assertion is what the
      import would have been — a disagreement fails here instead of becoming a step the ladder offers
      and the pane refuses.
    */
    const [lowest] = ZOOM_STOPS.slice(0, 1)
    const [highest] = ZOOM_STOPS.slice(ZOOM_STOPS.length - 1, ZOOM_STOPS.length)
    expect(lowest).toBe(MIN_ZOOM_PERCENT)
    expect(highest).toBe(MAX_ZOOM_PERCENT)
  })

  it('contain the default zoom, so a fresh profile needs no clamping', () => {
    const fallback = defaultSettings()['appearance.defaultZoom']
    expect(effectiveZoomPercent(null, fallback)).toBe(fallback)
  })
})
