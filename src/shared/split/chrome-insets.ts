import type { ChromeInsets, EscalationLevel } from '../model.js'

/**
 * How much of the window the chrome UI occupies, and the one state in which the answer is nothing.
 *
 * ## The defect this file is the fix for
 *
 * Two places need this answer and each had its own. The core computes the content rectangle and drops
 * every inset to zero in window fullscreen, because that is what F11 means — the chrome and the desktop
 * go away and the window is all page. The renderer, which draws the divider handles and the empty-tile
 * placeholders over that same area, kept using its measured chrome height regardless.
 *
 * So in fullscreen the tiles started at the top of the window and the divider layer started one chrome
 * height below it, and was that much too short. The handles therefore did not sit in the gutters between
 * the tiles — they sat *under* the tile views, and a native view above the chrome renderer receives the
 * pointer event instead. Reported as "wenn fullscreen (f11) ist das tile vergrößern verkleinern kaputt,
 * es bewegt sich nicht mit und daher nicht nutzbar", and both halves of that sentence are one cause: the
 * handles are drawn in the wrong place *and* dead, because being in the wrong place is what kills them.
 *
 * A divider is the one control whose position must agree with the geometry it divides to the pixel.
 * Two derivations of the same number cannot be relied on to agree — `SplitDividers` already carries a
 * docblock about a highlight that drifted from the divider it was decorating for exactly this reason.
 * So the rule is a function, in `shared`, where both callers reach it and a test can ask it directly.
 *
 * ## Why the whole inset object rather than a boolean
 *
 * `chromeHidden(escalation)` was the smaller change and it leaves the interesting half — *what the
 * insets become* — duplicated at both call sites, which is the thing that went wrong. Handing back the
 * insets means neither caller states the consequence, and the renderer's `top` and the core's rectangle
 * are the same value read twice rather than two values that happen to match.
 *
 * Zod-free, and it must stay that way: the renderer imports this at runtime and the architecture test
 * follows those imports. `EscalationLevel` arrives as a type only, so `model.ts`'s zod never comes with
 * it.
 */

/*
  `ChromeInsets` is imported rather than declared. The shape already exists as the request schema of
  `window:setChromeInsets` — it is what the renderer measures and sends — and a second interface of the
  same four fields is the beginning of the two drifting. Type-only, so the schema's zod stays behind.
*/

export const NO_CHROME_INSETS: ChromeInsets = { top: 0, bottom: 0, left: 0, right: 0 }

/**
 * Whether the chrome UI is on screen at all.
 *
 * Only `window-fullscreen`, and the three levels that are not it are the point. A website's fullscreen
 * request inside a tile leaves the chrome exactly where it was — that is spec 2's central requirement,
 * and the tile stays one tile among several. A maximised tile is a tile grown to the *content area*,
 * not to the window, so the chrome is still there and still measured. Getting either of those wrong
 * would move the toolbar out from under the tab strip while the tab strip was still visible.
 */
export function chromeHiddenAt(escalation: EscalationLevel): boolean {
  return escalation === 'window-fullscreen'
}

/**
 * The insets that actually apply, given what the chrome measured and where the window sits.
 *
 * `null` for the escalation is accepted and treated as "not fullscreen", because both callers can be
 * asked before any split state exists — the core lays out on window creation, and the renderer renders
 * once before its first state arrives. Answering with the measured insets there is the answer that is
 * right for every state except one, and being wrong for a frame in the direction of "the chrome is
 * visible" leaves handles that work rather than handles that do not.
 */
export function chromeInsetsFor(
  escalation: EscalationLevel | null,
  measured: ChromeInsets
): ChromeInsets {
  if (escalation !== null && chromeHiddenAt(escalation)) return NO_CHROME_INSETS
  return measured
}
