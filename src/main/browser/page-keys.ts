import type { EscalationLevel, Platform } from '@shared/model.js'

/**
 * `Escape` — and macOS's `Command+.` — arriving in a page, and which of the two actions that share it
 * the browser is allowed to take (spec 2, spec 9).
 *
 * ## Why this is not a menu accelerator
 *
 * Every other shortcut in this browser is a menu item, because an accelerator only fires where one
 * declares it (see `alternative-accelerators.ts`, which exists for the same reason one level in).
 * `escape` and `stop` are the two that must not be: a `MenuItem` carrying `Escape` claims the key
 * globally, so every text field on every page and every dialogue a website closes with it would lose
 * it. A browser that cannot close a website's own dialogue is worse than one whose fullscreen needs a
 * second press. So these two are read on `webContents.on('before-input-event')` of the view that has
 * the focus, which is the same mechanism `OverlayLayer` uses and for a related reason — see
 * `passwords/overlay-keys.ts`.
 *
 * ## The precedence, and why the page always wins the key
 *
 * `before-input-event` *can* consume a keystroke, and this decision deliberately never does.
 * `preventDefault` is not called on any path.
 *
 * The two things that outrank the browser here — a caret in one of the page's text fields, and the
 * page's own `Escape` handler — are both invisible from the main process at the moment the decision
 * has to be made. The event carries the key and the modifiers and nothing about the focused element,
 * and there is no "after input event" to learn from. A rule that consumed the key would therefore be
 * guessing, and the guess it gets wrong is exactly the one that matters. `webContents.isLoading()`
 * makes that concrete: it stays true for a page with one hanging subresource, so "consume while
 * loading" would take `Escape` away from such a page's search box indefinitely.
 *
 * What is left is safe to do alongside the page rather than instead of it, and that is the other half
 * of the rule: the browser only acts where its action is additive and idempotent — cancelling a load
 * that is genuinely in flight, or descending exactly one rung of the escalation ladder when there is
 * a rung to descend. With nothing loading and nothing escalated, `Escape` in a page does not reach
 * this browser at all: no stop, no ladder, no state broadcast.
 *
 * The chrome UI's own fields never come through here, which is what makes that affordable. This is
 * the *tab view's* `webContents`; the omnibox, the find bar and the overlay surfaces are other
 * renderers, and the chrome renderer has had its own `Escape` handler over `split:escape` all along
 * (see `App.tsx`). Focus is in exactly one web contents, so the two paths can never both fire for one
 * press.
 *
 * ## Why the order is stop first
 *
 * `bindings.ts` says it: "`Escape` is intentionally shared between `stop` and `escape`: which one
 * applies depends on whether a load is in flight, and the window resolves that at press time."
 * Cancelling a load is the answer that cannot be had any other way once the page has arrived; the
 * ladder is still one press away. The cost is one press: someone in a fullscreen tile with a load in
 * flight stops the load first and leaves fullscreen with the second press.
 */

/** The fields of Electron's `before-input-event` payload this decision reads. */
export interface PageKeystroke {
  type: string
  key: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  isAutoRepeat: boolean
}

/**
 * A keystroke read out of Electron's `before-input-event` payload, or `null` for anything that is not
 * one.
 *
 * `unknown` in, for the same reason as `mouseMoveY`: the subscription lives in a file that cannot run
 * outside a browser process, so narrowing there would be an assertion no test can see.
 *
 * Only `type` and `key` are rejections, because only they are real cases — every kind of input arrives
 * on this subscription, most of it not a keystroke at all. The modifier flags are read as `=== true`
 * instead: they are the same object's own booleans, an absent one means "not held", and refusing a
 * whole keystroke over a missing modifier would trade a working `Escape` for a field that has never
 * been absent.
 */
export function pageKeystrokeOf(input: unknown): PageKeystroke | null {
  if (typeof input !== 'object' || input === null) return null
  /*
    A declaration rather than a cast, exactly as in `mouseMoveY`: `object` is assignable to a type
    whose every field is optional, so this narrows without asserting anything the compiler has not
    checked.
  */
  const event: {
    type?: unknown
    key?: unknown
    control?: unknown
    alt?: unknown
    shift?: unknown
    meta?: unknown
    isAutoRepeat?: unknown
  } = input
  const { type, key } = event
  if (typeof type !== 'string' || typeof key !== 'string') return null

  return {
    type,
    key,
    control: event.control === true,
    alt: event.alt === true,
    shift: event.shift === true,
    meta: event.meta === true,
    isAutoRepeat: event.isAutoRepeat === true
  }
}

/** What the browser does with the keystroke. `nothing` means the page is the only one that reacts. */
export type PageKeyAction = 'stop-load' | 'escape-ladder' | 'nothing'

/** The window state the resolution depends on, and nothing else. */
export interface PageKeyState {
  /** `webContents.isLoading()` of the tab the keystroke arrived in. */
  loading: boolean
  escalation: EscalationLevel
}

/**
 * What the browser does about a keystroke that has arrived in a page.
 *
 * The whole resolution between `stop` and `escape`, in one expression a test can ask questions of.
 * Written here rather than in the subscription for the reason `windowFullscreenPermitted` gives one
 * file along: a rule kept where no test can reach it is a rule that will eventually be true in the
 * comment and false in the code.
 */
export function pageKeyAction(
  keystroke: PageKeystroke,
  platform: Platform,
  state: PageKeyState
): PageKeyAction {
  const meaning = keyMeaning(keystroke, platform)
  if (meaning === 'none') return 'nothing'
  // See the docblock: the load wins, because the ladder is still one press away and a load that has
  // finished arriving cannot be un-fetched.
  if (state.loading) return 'stop-load'
  if (meaning === 'stop-only') return 'nothing'
  // Nothing to climb down from, so nothing happens — not even a broadcast.
  return state.escalation === 'none' ? 'nothing' : 'escape-ladder'
}

/**
 * Which of the two actions the keystroke could name, before any state is consulted.
 *
 * `stop-only` is macOS's `Command+.`, which `bindings.ts` gives `stop` as its *primary* key there. It
 * is deliberately not a route into the ladder: `Escape` is the key spec 9 gives `escape`, and a mac
 * user pressing the stop key while in fullscreen has asked to stop a load, not to leave a tile.
 */
function keyMeaning(keystroke: PageKeystroke, platform: Platform): 'escape-or-stop' | 'stop-only' | 'none' {
  /*
    The press only.

    `before-input-event` reports `keyUp` on the same subscription, and auto-repeat reports a keyDown
    per repeat while the key is held. Either read as a press turns "exactly one rung per press" — the
    property that makes the ladder predictable — into "as many rungs as the keyboard sends", so a held
    `Escape` would fall out of fullscreen, un-maximise a tile and leave the window's fullscreen in one
    gesture.
  */
  if (keystroke.type !== 'keyDown' || keystroke.isAutoRepeat) return 'none'
  /*
    Bare keys, matched the way an accelerator would be.

    `Escape` in the table means `Escape`, not `Shift+Escape` (Chromium's task manager) or
    `Control+Escape` (the Windows Start menu). Accepting a modified press would have this browser
    answering to keys it never claimed, and the settings screen would name none of them.
  */
  if (keystroke.shift || keystroke.alt) return 'none'
  if (keystroke.key === 'Escape' && !keystroke.control && !keystroke.meta) return 'escape-or-stop'
  if (platform === 'darwin' && keystroke.key === '.' && keystroke.meta && !keystroke.control) {
    return 'stop-only'
  }
  return 'none'
}
