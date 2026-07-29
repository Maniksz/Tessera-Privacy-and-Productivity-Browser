import type { EscalationLevel, Platform } from '@shared/model.js'

/**
 * Keys arriving in a page, and what the browser is allowed to do about them (spec 2, spec 9).
 *
 * `Escape` and macOS's `Command+.` are here because they *cannot* be menu accelerators; the close-tab
 * chord is here for the opposite reason and is a late addition — it has a menu item, and this is the
 * second route to it for the one state where that item stops being reached. `CloseTabFallback` at the
 * foot of the file carries that argument on its own; everything below is about the first two.
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

/**
 * What the browser does with the keystroke. `nothing` means the page is the only one that reacts.
 *
 * `close-tab` is the odd one out, and `CloseTabFallback` at the foot of this file says why it is here
 * at all and why it cannot close a tab on its own.
 */
export type PageKeyAction = 'stop-load' | 'escape-ladder' | 'close-tab' | 'nothing'

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
  /*
    Answered before the load, and unlike the two below it is not a question about state.

    `Escape` has to choose between stopping and descending, so it consults what the window is doing.
    The close-tab chord means one thing; someone pressing it on a page that is still fetching has
    asked to close that page, and stopping the load instead would be this browser inventing a
    meaning for a key the table already spells out.

    The narrowing is the *window's* fullscreen, and only that, because outside it the menu
    accelerator demonstrably works — see `CloseTabFallback`.
  */
  if (meaning === 'close-tab') {
    return state.escalation === 'window-fullscreen' ? 'close-tab' : 'nothing'
  }
  // See the docblock: the load wins, because the ladder is still one press away and a load that has
  // finished arriving cannot be un-fetched.
  if (state.loading) return 'stop-load'
  if (meaning === 'stop-only') return 'nothing'
  // Nothing to climb down from, so nothing happens — not even a broadcast.
  return state.escalation === 'none' ? 'nothing' : 'escape-ladder'
}

/**
 * Which of the actions the keystroke could name, before any state is consulted.
 *
 * `stop-only` is macOS's `Command+.`, which `bindings.ts` gives `stop` as its *primary* key there. It
 * is deliberately not a route into the ladder: `Escape` is the key spec 9 gives `escape`, and a mac
 * user pressing the stop key while in fullscreen has asked to stop a load, not to leave a tile.
 *
 * `close-tab` is `Command+W` on macOS and `Control+W` everywhere else — one accelerator per platform,
 * straight out of `bindings.ts`, so `alternative-accelerators.ts` gives it no hidden sibling to match
 * as well. It is matched here and nowhere else because it is *not* one of the keys this module was
 * built for: it has a perfectly good menu item, and this is a fallback for the one state in which
 * that menu item stops being reached. See `CloseTabFallback`.
 */
function keyMeaning(
  keystroke: PageKeystroke,
  platform: Platform
): 'escape-or-stop' | 'stop-only' | 'close-tab' | 'none' {
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
  /*
    Lower-cased rather than compared to `'w'` directly.

    `Shift+W` is already refused above, so the letter arrives lower case in the ordinary run. Caps
    Lock is the case that is not ordinary: it reports `key: 'W'` with `shift: false`, and someone who
    has left it on would otherwise find `Command+W` dead in fullscreen and nowhere else — a bug
    report nobody could reproduce.
  */
  const closeTabModifier = platform === 'darwin' ? keystroke.meta : keystroke.control
  const wrongModifier = platform === 'darwin' ? keystroke.control : keystroke.meta
  if (keystroke.key.toLowerCase() === 'w' && closeTabModifier && !wrongModifier) return 'close-tab'
  return 'none'
}

/**
 * How long the fallback waits for the menu to do the job instead.
 *
 * One renderer round trip is what it has to outlast; see `CloseTabFallback` for why that is the
 * quantity. Long enough that a healthy renderer's "I did not handle this" always beats it, short
 * enough that a person who has just pressed the key does not see a pause.
 */
export const CLOSE_TAB_FALLBACK_DELAY_MS = 150

export interface CloseTabFallbackHost {
  /** Close the tab the keystroke arrived in. */
  closeTab(tabId: string): void
  /** `setTimeout`, injected: the delay is then a value a test can advance rather than wait out. */
  after(delayMs: number, run: () => void): () => void
}

/**
 * `Command+W` / `Control+W` in a page, for the one state in which the menu item stops answering.
 *
 * ## The bug
 *
 * Reported from real use: "in f11 funktioniert kein strg+w" — confirmed as `Command+W` on macOS,
 * working normally, and dead once the window is in fullscreen. Everything on this side of the
 * mechanism was ruled out first, and none of it is the cause: `closeTab` has exactly one accelerator
 * per platform, the menu item is built unconditionally, `Menu.setApplicationMenu` is process-wide,
 * and nothing in this repository hides, replaces or nulls the menu in fullscreen — no
 * `setMenuBarVisibility`, no `setAutoHideMenuBar`, no `setMenu(null)`, no `globalShortcut`, no
 * `setIgnoreMenuShortcuts`. What is left is Electron's promotion of an unhandled key from a child
 * `WebContentsView` to the application menu, which is C++ in the prebuilt binary. So this is a
 * second route to the same command rather than a fix.
 *
 * It is narrowed to `escalation === 'window-fullscreen'` on purpose. Outside fullscreen the menu
 * works, and a second route there would be a second tab closing.
 *
 * ## Why it waits, rather than closing and guarding
 *
 * The two routes cannot be told apart by anything but time. A menu item's `click` carries nothing
 * that identifies the keystroke behind it — a key equivalent and a mouse click on the item are the
 * same callback with the same arguments — so there is no id, no token and no shared object to
 * correlate them with. Every design here is therefore a timing one, and the choice is only about
 * *which way the timing fails*.
 *
 * **Rejected: a suppression window** — close the tab now, then ignore any close-tab request for the
 * next few milliseconds. Its failure mode is that it swallows a request the user genuinely made: two
 * quick `Command+W` presses close one tab, and the second press is simply gone. It also has to guess
 * *which* later request to swallow, and it cannot: the menu item resolves its target lazily, through
 * `controller.split.activeTabId()` at click time, so by then the active tab is a different tab and a
 * guard keyed on "the same tab" would not fire at all.
 *
 * **Chosen: a cancellation.** The keystroke arms a close and the menu route, if it ever arrives,
 * cancels it — because any close at all means the command has been carried out. Its failure mode is
 * that a close is late by the delay, and only in the broken state where nothing else would have
 * happened. A cancellation can only ever drop a request the other route has already served; a
 * suppression can only ever drop one nobody served. That asymmetry is the whole argument.
 *
 * ## Why the delay is one renderer round trip
 *
 * The order of the two routes is not symmetric, and that is what makes the wait sufficient rather
 * than merely likely. `before-input-event` fires in the browser process on the way *to* the
 * renderer, and Chromium only offers an unhandled key to the accelerator table on the way *back*.
 * So when both fire, this one is always first, and the gap between them is one round trip. On macOS
 * the ordering is stronger still: a main-menu key equivalent is consumed by AppKit before the key is
 * routed to a web contents at all, so a working menu means `before-input-event` never runs and
 * nothing is ever armed.
 */
export class CloseTabFallback {
  readonly #host: CloseTabFallbackHost
  /** The way to call off the armed close, or `null` when nothing is armed. */
  #pending: (() => void) | null = null

  constructor(host: CloseTabFallbackHost) {
    this.#host = host
  }

  /** True while a close is waiting to see whether the menu gets there first. Tests read this. */
  get armed(): boolean {
    return this.#pending !== null
  }

  /**
   * The close-tab chord arrived in a page.
   *
   * Re-arming replaces the pending close rather than queueing a second, and the honest cost is a
   * real one: two deliberate presses less than `CLOSE_TAB_FALLBACK_DELAY_MS` apart close one tab,
   * where outside fullscreen they would close two. Auto-repeat is not the reason — `keyMeaning`
   * already drops that at the `isAutoRepeat` check, so a held key never reaches here.
   *
   * The reason is that a queue cannot be cancelled correctly. `cancel()` learns only that *a* tab
   * closed, never which press it belonged to, because a menu click and a key equivalent are the
   * same callback with the same arguments. With two closes pending it would have to cancel one and
   * guess, and the guess that goes wrong closes a page the user is reading with no way back.
   * Replacing keeps the error on the recoverable side: the worst outcome is a tab that stays open
   * and a key that can be pressed again.
   */
  arm(tabId: string): void {
    this.cancel()
    this.#pending = this.#host.after(CLOSE_TAB_FALLBACK_DELAY_MS, () => {
      // Cleared before the call, not after: closing goes back through the window, which cancels on
      // every close, and a still-armed fallback would be cancelling itself mid-flight.
      this.#pending = null
      this.#host.closeTab(tabId)
    })
  }

  /**
   * A tab closed by some other route, so whatever this was waiting to do has been done.
   *
   * Not keyed on the tab id, deliberately. The menu closes whichever tab is active *at click time*,
   * which after any intervening change need not be the one the keystroke arrived in — and the user
   * pressed the key once and meant one tab to close. Any close within the window is that close.
   */
  cancel(): void {
    const stop = this.#pending
    this.#pending = null
    stop?.()
  }
}
