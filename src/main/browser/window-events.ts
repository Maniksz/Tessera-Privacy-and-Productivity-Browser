import type { GestureSource } from '@shared/gestures/navigation.js'

/**
 * What the outside tells a window, and what the window does about it.
 *
 * ## Why this is a file and not a method
 *
 * Nine subscriptions, and not one of them is plumbing. A resize cancels the drag in progress rather than
 * silently retargeting its drop zones. A blur cancels it too, because a pointer released outside the window
 * leaves no `pointerup` behind for either renderer to see. Leaving fullscreen is the single moment at which
 * the tile confinement can be put back without trapping the user. Every one of those is a decision with a
 * reason, and while they lived in `BrowserWindowController` each could only ever be *read*: asserting that a
 * resize cancels the drag before it relayouts, or that leaving fullscreen restores the policy before the
 * relayout rather than after it, meant opening a window.
 *
 * Once the subscription itself is the only thing left that needs Electron — and it arrives as `on` — all nine
 * can be driven from a test with an object literal.
 *
 * ## What belongs here, and what does not
 *
 * Reactions to something the outside raised, answered through the seams. Two events registered in the same
 * breath deliberately stayed in the controller:
 *
 *   - **`closed`** is the named exclusion. It disposes the listeners, destroys the overlay and every tab,
 *     closes the window's session slot and hands the window back to whoever opened it. That is the window's
 *     own teardown rather than a reaction with a policy in it, and a module able to do it would have to be
 *     handed the tab map and the session slot — which is the whole window, the exact reach the host below
 *     exists to refuse.
 *   - **`did-finish-load`** is the chrome renderer reporting in, not the OS speaking. It is registered on the
 *     window's `webContents` rather than on the window, and it is the tail of loading the chrome.
 *
 * A future event earns a place here if it comes from outside and is answered through a seam. One that reaches
 * into the window's private state belongs where that state is.
 */

/**
 * The window, as narrowly as these nine handlers see it.
 *
 * ## Why not `WindowInternals`
 *
 * Tempting, and it was the obvious candidate: it already exists, it sits in this directory, and it was written
 * to be precisely this kind of narrow view. It loses for a structural reason rather than a stylistic one.
 * `WindowInternals` is what a window exposes *to* its seams — and three of the things wanted here **are**
 * seams: `drag`, `fullscreen` and `tileInput`. Putting them on `WindowInternals` makes it circular, because
 * `createWindowSeams(internals)` builds those three controllers out of `internals`; nothing could construct
 * the argument.
 *
 * It also carries neither the subscription helper nor `broadcastWindowState`, and widening it for those two
 * would hand all six seams the ability to subscribe to window events and to push chrome state — reach that
 * none of them has today and none of them has asked for.
 *
 * So, a narrow host, which is this repo's usual answer anyway (`TileInputHost`, `TileOccupancyHost`). Members
 * are declared as the smallest shape that satisfies them rather than as the classes that do, so a test writes
 * `{ cancel() {} }` instead of building a `TabDragController`.
 */
export interface WindowEventHost {
  /**
   * Subscribes, and registers the way off in the same call.
   *
   * Injected rather than done here, and that is spec 6 rather than convenience: the disposers belong to the
   * window, which is the thing that knows when it is gone. See `BrowserWindowController.#on` for why the
   * subscribe and the unsubscribe are written as one act.
   */
  on(event: string, handler: (...args: unknown[]) => void): void

  /** The tab drag in progress, if any. Nothing here starts one; a window event can only end one. */
  drag: { cancel(): void }
  /** The layer above the tab views. Only taking it down is a window event's business. */
  overlay: { dismiss(): void }
  /** The split layout's own record of whether the window is fullscreen, which changes what it may draw. */
  split: { setWindowFullscreen(fullscreen: boolean): void }
  /** Re-derives whether the window may be taken fullscreen at all; see `TileFullscreenController`. */
  fullscreen: { applyPolicy(): void }
  /** Which tile a hardware navigation gesture meant, decided from the cursor; see `TileInputController`. */
  tileInput: { navigateByGesture(source: GestureSource, name: string): void }

  /** Puts the tab views and the overlay back where the new geometry says they go. */
  relayout(): void
  /** Maximised, fullscreen and focused, sent to the chrome UI straight away. */
  broadcastWindowState(): void
  /** The coalesced everything-else broadcast: tabs, groups, split. One message per tick. */
  scheduleBroadcast(): void
}

/**
 * Subscribes the window to the nine events it reacts to.
 *
 * Returns nothing on purpose. Every subscription goes through `host.on`, which is already the pairing of a
 * listener with its removal — a disposer handed back from here would be a second, parallel way to unsubscribe,
 * and two of those is how one of them ends up not being called.
 */
export function wireWindowEvents(host: WindowEventHost): void {
  // Resizing moves the button an anchored surface was placed against, so the surface
  // goes rather than hanging in the wrong spot.
  const onResize = (): void => {
    // A resize moves every drop zone, and the zones were computed at the start of the
    // drag on purpose. Rather than silently retargeting under the pointer, the drag goes.
    host.drag.cancel()
    host.overlay.dismiss()
    host.relayout()
  }
  const onWindowState = (): void => host.broadcastWindowState()
  const onBlur = (): void => {
    // Covers the drag that ended somewhere neither renderer could see — a pointer
    // released outside the window leaves no pointerup behind.
    host.drag.cancel()
    host.overlay.dismiss()
    host.broadcastWindowState()
  }
  const onEnterFullscreen = (): void => {
    host.split.setWindowFullscreen(true)
    host.relayout()
    host.scheduleBroadcast()
  }
  const onLeaveFullscreen = (): void => {
    host.split.setWindowFullscreen(false)
    /*
      The confinement comes back here, and this is the only place it can.

      `toggleFullscreen` lifts `fullScreenable` so the *user's* key can take the window — the flag cannot
      tell a person from a page, so it has to be lifted for the request the person made. Left lifted, a
      video in one pane could then take the whole window and blank the other three, which is the thing
      spec 2 is about. Restoring it on the way *in* would trap the user in fullscreen; on the way out is
      both the earliest safe moment and the one that needs no second flag to remember why.
    */
    host.fullscreen.applyPolicy()
    host.relayout()
    host.scheduleBroadcast()
  }

  host.on('resize', onResize)
  host.on('maximize', onWindowState)
  host.on('unmaximize', onWindowState)
  host.on('focus', onWindowState)
  host.on('blur', onBlur)
  host.on('enter-full-screen', onEnterFullscreen)
  host.on('leave-full-screen', onLeaveFullscreen)

  /*
    Back and forward from hardware that has its own buttons for it.

    `app-command` is the mouse's fourth and fifth buttons on Windows and Linux, `swipe` is the macOS
    trackpad. Subscribed together so neither platform's half can be added without the other being visible,
    and both hand the decision to `decideNavigationGesture` — which direction means "back" is a convention
    that reads backwards from first principles, and one negation would invert every gesture on one platform.
  */
  host.on('app-command', (...args) => {
    const [, command] = args
    if (typeof command === 'string') host.tileInput.navigateByGesture('app-command', command)
  })
  host.on('swipe', (...args) => {
    const [, direction] = args
    if (typeof direction === 'string') host.tileInput.navigateByGesture('swipe', direction)
  })
}
