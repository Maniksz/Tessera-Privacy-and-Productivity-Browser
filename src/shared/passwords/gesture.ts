/**
 * Whether an input event counts as the user asking for something.
 *
 * ## Why the core decides this and not the preload
 *
 * A fill has to require a gesture — see `fill-policy.ts`, rule `no-user-gesture` — and a
 * gesture reported *by the renderer* is worth nothing, because a compromised renderer is one of
 * the things the rule defends against. Electron's `webContents.on('input-event')` fires for
 * input the browser process dispatched into the view; a page calling `element.click()` or
 * `dispatchEvent` never leaves the renderer and so never reaches it. That makes the core's own
 * record of the last input event the one trustworthy answer available.
 *
 * The payload is untyped, like every other `input-event` reader in this project, so recognising
 * it safely is a pure function with a test rather than a cast. Same shape as
 * `gestures/pointer.ts`.
 */

/**
 * Event types that mean a person acted.
 *
 * Pointer *presses* and key presses only. `mouseMove` is excluded deliberately: a pointer
 * drifting across a page while the user reads is not consent to anything, and including it
 * would make the gesture window permanently open on any page the mouse happens to be over.
 * `mouseWheel` is out for the same reason.
 */
const GESTURE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'mouseDown',
  'mouseUp',
  'keyDown',
  'char',
  'touchStart'
])

/** True when this `input-event` payload is a deliberate act by the person at the keyboard. */
export function isFillGestureInput(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false
  const event: { type?: unknown } = input
  return typeof event.type === 'string' && GESTURE_EVENT_TYPES.has(event.type)
}
