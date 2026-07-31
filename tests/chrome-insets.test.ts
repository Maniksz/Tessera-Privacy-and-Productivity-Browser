import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NO_CHROME_INSETS,
  chromeHiddenAt,
  chromeInsetsFor
} from '@shared/split/chrome-insets.js'
import { escalationLevelSchema } from '@shared/model.js'
import { computeTileRects, dividersFor, TILE_GUTTER } from '@shared/split/layout.js'

/**
 * Where the content area begins, which is the number the divider handles are placed from.
 *
 * ## The defect
 *
 * In window fullscreen the core gives the whole window to content: every inset drops to zero and the
 * tiles are laid out from the top edge. The renderer kept using its measured chrome height for the
 * layer it draws the divider handles on, so that layer began one chrome height too low and was that
 * much too short. The handles therefore missed the gutters between the tiles — and a handle outside a
 * gutter is *underneath* a tile view, which is a native view above the chrome renderer and takes the
 * pointer event instead. Reported as tile resizing being unusable in full screen, and the two symptoms
 * in that report ("bewegt sich nicht mit", "nicht nutzbar") are one cause.
 *
 * ## What is tested here rather than at the call sites
 *
 * The rule, and the property that made the bug possible: the same function answers for both callers.
 * The last test in this file is a fitness function rather than a unit test, because the failure mode
 * was never a wrong value — each side's arithmetic was right — it was two sides deriving the same
 * value separately. A unit test on either one passes in that state.
 */

const ROOT = process.cwd()
const measured = { top: 88, bottom: 0, left: 0, right: 0 }

describe('which escalation hides the chrome', () => {
  it('hides it for window fullscreen and for nothing else', () => {
    expect(chromeHiddenAt('window-fullscreen')).toBe(true)
    expect(chromeHiddenAt('none')).toBe(false)
    /*
      The two that matter, and the reason this is not simply "fullscreen".

      A page's fullscreen request inside a tile is spec 2's central case: the page is told it is
      fullscreen so its player switches, and the surrounding tiles stay visible and keep playing. The
      chrome stays with them. A maximised tile is grown to the *content area*, not to the window, so
      the tab strip and toolbar are still there and still measured. Treating either as "chrome gone"
      would slide the whole layout up under a tab strip that is still on screen.
    */
    expect(chromeHiddenAt('tile-fullscreen')).toBe(false)
    expect(chromeHiddenAt('tile-maximized')).toBe(false)
  })

  it('has an answer for every escalation level the model defines', () => {
    // A level added to the schema without a decision here would default to "chrome visible" — which is
    // the safe direction, but silently. This makes adding one a deliberate act.
    for (const level of escalationLevelSchema.options) {
      expect(typeof chromeHiddenAt(level), level).toBe('boolean')
    }
  })
})

describe('the insets that actually apply', () => {
  it('gives content the whole window in fullscreen', () => {
    expect(chromeInsetsFor('window-fullscreen', measured)).toEqual(NO_CHROME_INSETS)
  })

  it('hands back what the chrome measured in every other state', () => {
    expect(chromeInsetsFor('none', measured)).toEqual(measured)
    expect(chromeInsetsFor('tile-fullscreen', measured)).toEqual(measured)
    expect(chromeInsetsFor('tile-maximized', measured)).toEqual(measured)
  })

  it('treats "no split state yet" as chrome visible', () => {
    /*
      Both callers can ask before any split state exists — the core lays out on window creation, the
      renderer renders once before its first state arrives. Answering with the measured insets is right
      for three of the four levels, and being wrong for one frame in this direction leaves handles that
      work rather than handles that do not.
    */
    expect(chromeInsetsFor(null, measured)).toEqual(measured)
  })

  it('does not hand back the caller\'s own object', () => {
    // The core keeps its insets in a field and passes it straight in. Returning it would let a caller
    // that mutated the result quietly change what the chrome reported.
    const insets = { ...measured }
    const applied = chromeInsetsFor('window-fullscreen', insets)
    expect(applied).not.toBe(insets)
    expect(insets).toEqual(measured)
  })
})

describe('the divider layer and the tiles are the same box', () => {
  /**
   * The invariant the bug broke, stated as a box comparison.
   *
   * A divider handle is positioned in *percentages of the layer it sits on* — see `SplitDividers`,
   * where a vertical handle is `left: calc(fraction * 100% - gutter/2)`. The tiles are positioned in
   * *pixels of the content rectangle* by `computeTileRects`, which is what the core uses for the real
   * views. Percentages of one box and pixels of another coincide on exactly one condition: the two
   * boxes are the same. That condition is the whole of this feature, and the insets are what decide it.
   *
   * So this compares the boxes rather than re-deriving the handle positions. Mirroring the CSS
   * arithmetic here would put a third copy of it in the tree — the copy that agrees with whichever side
   * the test author was looking at — and the defect being guarded against is precisely two copies
   * disagreeing.
   */
  const size = { width: 1440, height: 900 }

  /** The box the core lays the tiles out in, exactly as `#contentRect` builds it from the insets. */
  const contentRect = (
    insets: typeof measured
  ): { x: number; y: number; width: number; height: number } => ({
    x: insets.left,
    y: insets.top,
    width: size.width - insets.left - insets.right,
    height: size.height - insets.top - insets.bottom
  })

  /**
   * The box the chrome renderer draws the handles on.
   *
   * `.dividers` is `position: absolute; inset: 0` with its `top` overridden inline, so it runs from
   * that top to the bottom of the window and the full width. That is the layer, in window coordinates.
   */
  const layerRect = (top: number): { x: number; y: number; width: number; height: number } => ({
    x: 0,
    y: top,
    width: size.width,
    height: size.height - top
  })

  it('agrees in window fullscreen, which is where it did not', () => {
    const insets = chromeInsetsFor('window-fullscreen', measured)
    expect(layerRect(insets.top)).toEqual(contentRect(insets))

    /*
      What the disagreement was, kept as an assertion so the numbers are on record rather than in a
      commit message. The renderer used its measured chrome height regardless of escalation, so the
      layer began at 88 and was 812 tall while the tiles ran from 0 for the full 900: every handle was
      88 pixels below its gutter and 88 pixels short at the bottom.
    */
    expect(layerRect(measured.top)).not.toEqual(contentRect(insets))
  })

  it('agrees with the chrome on screen, which is where it always did', () => {
    // The ordinary case, so the fix cannot have traded one broken state for another.
    const insets = chromeInsetsFor('none', measured)
    expect(layerRect(insets.top)).toEqual(contentRect(insets))
  })

  it('agrees for a page that went fullscreen inside its tile', () => {
    // The case most easily got wrong in the other direction: this one keeps the chrome, so dropping the
    // insets here would break the common state to fix the rare one.
    const insets = chromeInsetsFor('tile-fullscreen', measured)
    expect(insets.top).toBe(measured.top)
    expect(layerRect(insets.top)).toEqual(contentRect(insets))
  })

  it('leaves a real gutter for the handle to sit in, in both states', () => {
    /*
      And the reason the boxes matching is worth anything: the handle is only clickable because
      `computeTileRects` leaves a gap no tile covers. If the gutter were ever zero the handles would be
      under the views in every state, fullscreen or not — which is the same symptom from a different
      cause, so it is worth pinning here too.
    */
    for (const escalation of ['none', 'window-fullscreen'] as const) {
      const insets = chromeInsetsFor(escalation, measured)
      const [left, right] = computeTileRects('1x2', {}, contentRect(insets), { gutter: TILE_GUTTER })
      expect(left, escalation).toBeDefined()
      expect(right, escalation).toBeDefined()
      expect(right!.x - (left!.x + left!.width), escalation).toBe(TILE_GUTTER)
      // The divider this gutter belongs to exists, or the handle would have nothing to be.
      expect(dividersFor('1x2', {}).length, escalation).toBe(1)
    }
  })
})

describe('one rule, not two', () => {
  it('has both sides ask the shared function instead of testing the escalation themselves', () => {
    /*
      The fitness function, and the only check here that could have caught the original defect.

      Every value involved was correct on both sides; what was wrong was that there were two sides. So
      what is asserted is the absence of a second derivation: neither the core's layout path nor the
      chrome renderer may compare an escalation to `'window-fullscreen'` on its own — they call
      `chromeInsetsFor`/`chromeHiddenAt` and use the answer.

      Scoped to these two files rather than the whole tree: `SplitController` owns the escalation chain
      and necessarily names its levels, and `TileFullscreenController` reasons about them by name too.
      Those are the levels' home. The two files below are the ones that only *consume* the answer.
    */
    for (const relative of [
      'src/main/browser/BrowserWindowController.ts',
      'src/renderer/src/App.tsx'
    ]) {
      const text = readFileSync(join(ROOT, relative), 'utf8')
      // Comments stripped: both files explain the rule in prose, and the prose names the level.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
      expect(
        code,
        `${relative} decides for itself whether the chrome is hidden. That is how the divider ` +
          'handles and the tile views came to disagree in fullscreen — call chromeInsetsFor or ' +
          'chromeHiddenAt from @shared/split/chrome-insets.js instead.'
      ).not.toMatch(/'window-fullscreen'/)
      expect(code, `${relative} no longer reads the shared rule`).toMatch(
        /chromeInsetsFor|chromeHiddenAt/
      )
    }
  })
})
