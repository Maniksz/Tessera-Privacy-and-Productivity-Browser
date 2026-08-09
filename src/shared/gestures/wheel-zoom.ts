/**
 * The zoom *gesture*: what one is, and which pane it means.
 *
 * `zoom.ts` next door answers "how far" — the ladder of stops both this and the menu walk. This file
 * answers the two questions before that one, and they are the ones that were wrong.
 *
 * ## What was reported
 *
 * *"warum geht kein zoom per kachel einzeln mit der pinch geste auf einem touchpad?"* — and the
 * answer was that a trackpad pinch never reached this browser at all. `Tab.ts` subscribed to
 * Electron's `zoom-changed`, whose own typings say it is *"emitted when the user is requesting to
 * change the zoom level using the **mouse wheel**"*; and `webContents.setVisualZoomLevelLimits`,
 * whose typings note that *"visual zoom is disabled by default in Electron"*, is called nowhere. So
 * `Ctrl`-wheel worked, the pinch did nothing, and the docblocks that said "pinch and `Ctrl`-wheel"
 * described an intention rather than a path.
 *
 * ## Why the renderer is the only place the gesture can be read
 *
 * Chromium delivers a touchpad pinch to the *page* as a `wheel` event with `ctrlKey` set — on
 * Windows, macOS and Linux alike. That is the mechanism every canvas application on the web uses,
 * and it is why this is not a macOS feature: nothing below is platform-specific.
 *
 * It is also the only place the decisive fact is knowable. Whether a page **handles the pinch
 * itself** — a map, a design tool, anything with a canvas — is `defaultPrevented`, which exists only
 * in the renderer. The main process sees the raw gesture and would zoom the browser while the page
 * zoomed its own canvas. Reading it here means this browser does what every other browser does:
 * the page gets first refusal, and only what it declines becomes browser zoom.
 *
 * The same now holds for `Ctrl`-wheel, which is a change: `zoom-changed` did not respect a page's
 * refusal. One source for both is also what `zoom.ts` asks for in its own docblock — two ladders in
 * one browser is drift nobody reports and everybody feels.
 *
 * ## Why the pinch no longer arrives here at all
 *
 * It used to be routed to the focused tile, because on a trackpad the hand is on the pad and the
 * pointer names nothing. That is still true and it is now the engine's problem: `setVisualZoomLevelLimits`
 * turns on Chromium's own pinch-to-zoom, which scales in the compositor, applies to the view the
 * gesture is over, and costs nothing per step. What still reaches this file is the *report* of the
 * same gesture — Chromium delivers a trackpad pinch to the page as a `Ctrl`-wheel as well — and
 * `decideZoomTarget` drops it, so one gesture cannot be applied twice by two mechanisms.
 *
 * `Ctrl`-wheel from a mouse is unaffected and still zooms the pane under the pointer, which is the
 * user's decision of 29.07.2026.
 */

/** Preload -> core: one step of gesture zoom, already reduced to a direction. */
export const ZOOM_GESTURE_CHANNEL = 'tessera:zoom-gesture'

/**
 * How much accumulated wheel delta makes one step on the ladder.
 *
 * One hundred, because that is what Chromium sends for a single notch of a mouse wheel: one notch
 * has to be one stop, or the wheel that worked before this change would suddenly need three turns.
 * A pinch arrives as a dense stream of much smaller values and is therefore *summed* to the same
 * threshold, which is what keeps the two gestures on one ladder — see the file docblock.
 */
export const ZOOM_STEP_DELTA = 100

/**
 * The parts of a `WheelEvent` this decision needs.
 *
 * A structural type rather than `unknown`, unlike `mouseMoveY` next door, and the difference is
 * where the value comes from: that one narrows a payload Electron hands over with no type at all,
 * while this one is a DOM event the caller already holds. There is nothing to discover, so the
 * listener stays typed and the test writes an object literal.
 */
export interface WheelZoomEvent {
  readonly isTrusted: boolean
  readonly defaultPrevented: boolean
  readonly ctrlKey: boolean
  readonly deltaY: number
  /** `0` is `DOM_DELTA_PIXEL`; see `wheelZoomDelta` for why the others are refused. */
  readonly deltaMode: number
}

/** `WheelEvent.DOM_DELTA_PIXEL`, named rather than spelled `0` at the comparison. */
const DOM_DELTA_PIXEL = 0

/**
 * The zoom delta in a wheel event, or `null` when it is not one.
 *
 * Each rejection is a rule rather than defensive padding:
 *
 *   - **`isTrusted`** is the one that must not be dropped. A page can `dispatchEvent` a wheel event
 *     with `ctrlKey` set, and without this check that is a page reaching the browser's zoom. With
 *     the pinch routed to the *focused* pane it would be worse than a nuisance: the page under the
 *     pointer could zoom a pane belonging to a different site.
 *   - **`defaultPrevented`** is the page's own answer, and honouring it is the whole reason this
 *     runs in the renderer. See the file docblock.
 *   - **`ctrlKey`** is what makes a wheel event a zoom at all — it is set by the person holding
 *     `Ctrl`, and synthesised by Chromium for a trackpad pinch.
 *   - **`deltaMode`** must be pixels. Chromium always sends pixels, so this is insurance rather
 *     than a live branch; a line- or page-based delta silently scaled as if it were pixels would
 *     need thirty notches per stop, which reads as "zoom is broken" rather than as a wrong unit.
 */
export function wheelZoomDelta(event: WheelZoomEvent): number | null {
  if (!event.isTrusted) return null
  if (event.defaultPrevented) return null
  if (!event.ctrlKey) return null
  if (event.deltaMode !== DOM_DELTA_PIXEL) return null
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return null
  return event.deltaY
}

export interface WheelZoomStep {
  /** What is left over, to be carried into the next event of the same gesture. */
  carry: number
  /**
   * Whole steps to take, signed the way a wheel is: **negative is towards the user and zooms in**,
   * which is `Ctrl` and scrolling up, and fingers spreading on a trackpad.
   */
  steps: number
}

/**
 * Turns a stream of wheel deltas into whole steps on the ladder.
 *
 * ## Why anything accumulates at all
 *
 * A mouse wheel arrives in notches and a pinch arrives as thirty or forty events per second. Applied
 * one stop each, a single pinch would run the ladder from 25 % to 500 % and back before the fingers
 * stopped moving. `zoom.ts` says the same thing from the other end: the ladder exists because a
 * gesture "sends a stream of events, so ten per notch either crawls or overshoots".
 *
 * ## Why a reversal discards the carry rather than subtracting it
 *
 * Pinching in and then out again is two gestures in one motion, and the leftover from the first is
 * not evidence about the second: subtracting it would make the first stop of the way back need less
 * movement than every stop after it, so the ladder would feel loose in one direction and tight in
 * the other. Discarding costs at most one stop's worth of movement at the moment the fingers change
 * their mind, which is the moment nobody is measuring.
 */
export function stepWheelZoom(carry: number, deltaY: number): WheelZoomStep {
  const reversed = carry !== 0 && Math.sign(carry) !== Math.sign(deltaY)
  const total = reversed ? deltaY : carry + deltaY
  const whole = Math.trunc(total / ZOOM_STEP_DELTA)
  /*
    `Math.trunc` answers `-0` for anything that has not yet reached a step in the zooming-in
    direction, which is the commonest result this function has. It behaves as zero everywhere it is
    read here, so this is tidiness rather than a fix — but a negative zero handed out of a pure
    function is a value that compares equal to zero right up until somebody uses `Object.is` or
    writes it into a snapshot, and then it is a puzzle.
  */
  const steps = whole === 0 ? 0 : whole
  return { carry: total - steps * ZOOM_STEP_DELTA, steps }
}

/**
 * Whether one of Chromium's raw input events is part of a trackpad pinch.
 *
 * `unknown` in, because this one *is* the untyped Electron payload — the same reason `mouseMoveY`
 * takes `unknown` and the reason `WheelZoomEvent` above does not.
 *
 * Only the two brackets are read. `gesturePinchUpdate` may or may not reach `input-event` at all,
 * which is precisely why the state below is a bracket and not a stream: `begin` and `end` are the
 * two the browser process is documented to dispatch, and a rule that needed the updates would be a
 * rule resting on something unverified.
 */
export function pinchInputPhase(input: unknown): 'begin' | 'end' | null {
  if (typeof input !== 'object' || input === null) return null
  const event: { type?: unknown } = input
  if (event.type === 'gesturePinchBegin') return 'begin'
  if (event.type === 'gesturePinchEnd') return 'end'
  return null
}

/**
 * How long after a pinch ends a zoom report still counts as part of it.
 *
 * Not a feel decision: it covers a race the design creates. The wheel events are read in the
 * renderer and reported over IPC, while `gesturePinchEnd` reaches the core directly — so the last
 * step or two of a pinch routinely arrives *after* the browser process has been told the pinch is
 * over. Without the grace those steps would land on the pane under the pointer while the rest of
 * the same gesture landed on the focused one, which is the single worst outcome available: one
 * gesture zooming two different pages.
 *
 * Quarter of a second is far longer than the round trip and far shorter than the gap to a
 * deliberate second gesture.
 */
export const PINCH_GRACE_MS = 250

export interface ZoomTargetRequest {
  /**
   * Whether a trackpad pinch is what produced this step.
   *
   * The only reason this is still asked. It used to choose *between* two panes; now it decides
   * whether there is a pane at all, because a pinch has already been applied by the engine.
   */
  pinch: boolean
  /** The tab whose page reported it, which is the tab under the pointer. */
  senderTabId: string
}

/**
 * Which tab a zoom step applies to, or `null` for none.
 *
 * ## A pinch is now nobody's, and that is the change
 *
 * It used to be the focused tile's, on the user's instruction that the pinch should apply to *"die
 * aktuell fokussierte kachel"*. That instruction is honoured better by not answering it here at all.
 *
 * The pinch is Chromium's now. `setVisualZoomLevelLimits` turns on the engine's own pinch-to-zoom —
 * page *scale*, which lives in the compositor rather than in layout, so it is per view by
 * construction and costs no style recalc, no relayout and no round trip. It is the same mechanism a
 * trackpad pinch drives in Safari, and it is why that feels instant while a zoom rebuilt out of
 * stylesheets does not.
 *
 * So a step reported during a pinch is a *duplicate* of something the engine has already done, and
 * applying it would zoom the pane twice by two different mechanisms at once. Returning `null` is what
 * keeps the two from fighting. `PINCH_GRACE_MS` matters more than ever for the same reason: the last
 * reports of a gesture routinely arrive after the browser process has seen `gesturePinchEnd`, and
 * without the grace they would land on the page zoom as an unexplained jump at the end of every
 * pinch.
 *
 * `Ctrl`-wheel is untouched and still lands here: Electron's own note says visual zoom *"only applies
 * to pinch-to-zoom behavior"*, so a mouse wheel reaches nothing in the engine and is still this
 * browser's to apply — to the pane under the pointer, which is the user's decision of 29.07.2026.
 */
export function decideZoomTarget(request: ZoomTargetRequest): string | null {
  return request.pinch ? null : request.senderTabId
}
