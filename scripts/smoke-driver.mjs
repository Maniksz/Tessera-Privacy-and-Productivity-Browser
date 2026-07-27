/**
 * The handful of operations the checks in `smoke-checks.mjs` need, from inside the application.
 *
 * This file is the adapter that replaced the debugging protocol. The checks used to reach a running
 * Tessera from outside: a debugging port on the command line, a WebSocket per renderer,
 * `Runtime.evaluate` and `Input.dispatchMouseEvent`. Starting a Chromium process with such a port open
 * and driving it over CDP *is* the standard way cookies and saved passwords are read out of a browser,
 * so endpoint protection flags that shape wherever it appears — the port number is not the problem.
 *
 * From inside the main process every one of those operations has a first-class equivalent and neither
 * a port nor a socket exists. The checks above this layer did not have to change to gain that.
 *
 * ## What each renderer is here
 *
 * A CDP "target" was a renderer found by its URL. That is still how they are told apart — identity by
 * address, as `getAllWebContents` reports it — but there is no discovery step and no handshake, so
 * every lookup is synchronous and cannot fail for being early.
 *
 *   chrome   the window's own web contents, where the tab strip and the toolbar are drawn
 *   overlay  the layer stacked above the tab views, where menus and the drop indicator live
 *   page     an internal page or a tab's own view, addressed by URL like the others
 */

/** The window's own web contents: the bottom layer, drawing the chrome UI. */
const isChrome = (url) => url.includes('renderer/index.html')

/** The layer above the tab views. Its own entry point, hence its own address. */
const isOverlay = (url) => url.includes('overlay.html')

/**
 * A mouse event in the shape Electron's input pipeline takes.
 *
 * Three differences from `Input.dispatchMouseEvent`, and every one of them produces a failure that
 * reads as a product bug rather than as a harness fault:
 *
 *  - the type names are Chromium's, not the protocol's: `mouseDown`, `mouseMove`, `mouseUp`
 *  - a held button is a **modifier**, not a `buttons` bitmask, and it is spelled in lower case —
 *    `leftbuttondown` is what the converter compares against
 *  - `clickCount` has to be 1 on the press and the release, or Blink sees no click at all, and the
 *    checks that open a menu by clicking a button would report a dead button
 *
 * The held button is set on the move because that is what makes it a drag rather than a hover: it is
 * what `event.buttons` is computed from in the page.
 */
export function mouse(type, x, y) {
  const electronType = { down: 'mouseDown', move: 'mouseMove', up: 'mouseUp' }[type]
  if (electronType === undefined) throw new Error(`unknown mouse event: ${type}`)
  return {
    type: electronType,
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    ...(type === 'move' ? { modifiers: ['leftbuttondown'] } : { clickCount: 1 })
  }
}

/**
 * Builds the driver the checks are written against.
 *
 * Throws if the chrome renderer is not loaded, which is the one precondition it cannot work around:
 * the core waits for the first window's document before loading this module, so reaching that error
 * means something else is wrong and every check after it would report the same thing.
 */
export function createDriver({ webContents, focus }) {
  const live = () => webContents.getAllWebContents().filter((contents) => !contents.isDestroyed())

  const find = (matches) => live().find((contents) => matches(contents.getURL())) ?? null

  /**
   * The chrome renderer, resolved once and held.
   *
   * Not looked up per call, and this is a correctness matter rather than a saving. One of the checks
   * navigates a *tab* to `file://…/out/renderer/index.html` — the built chrome document, used there as
   * a real address that needs no network — and from that moment two web contents match the address.
   * A per-call lookup would start driving that tab instead: `window.tessera` is undefined in it, so
   * every later check would fail with something that looks nothing like its cause. The debugging
   * protocol bound to one target at the start for the same reason; this holds the same object.
   */
  const chrome = find(isChrome)
  if (chrome === null) throw new Error('the chrome renderer is not loaded')

  /**
   * The overlay layer, resolved on first use and then held.
   *
   * Lazily, because the layer is created when something is first presented on it — there is nothing to
   * find before the first menu or drag. Held afterwards for the reason above.
   */
  let overlay = null
  const overlayContents = () => {
    if (overlay !== null && !overlay.isDestroyed()) return overlay
    overlay = find(isOverlay)
    return overlay
  }

  const requiredOverlay = () => {
    const contents = overlayContents()
    if (contents === null) throw new Error('the overlay layer is not loaded')
    return contents
  }

  /**
   * Delivers one input event, having made sure the window can receive it.
   *
   * The focus call is not belt and braces: `sendInputEvent` reaches a focused window only — Electron
   * says so on the method — and an event sent to an unfocused one is dropped in silence, which shows
   * up as a zone that did not highlight or a drop that did nothing. Done per event rather than once at
   * the start because the run lasts minutes, and anything that takes the foreground in the middle of
   * it would otherwise void every check after that moment with no clue as to why.
   */
  const sendTo = (contents, event) => {
    focus()
    contents.sendInputEvent(event)
  }

  /**
   * Runs an expression in a renderer's own world and answers with its value.
   *
   * `true` is `userGesture`: several checks click a button or a menu item, and a click without one
   * behind it is refused by anything gated on user activation.
   *
   * Unlike `Runtime.evaluate`, this *rejects* when the expression throws or its promise rejects
   * instead of quietly answering `undefined`. That is the better failure — an expression that threw
   * used to become a check comparing `undefined` against what was expected, which named the wrong
   * thing — and it is why no check needs to say whether to await a promise: this always does.
   */
  const evaluateIn = (contents, expression) => contents.executeJavaScript(expression, true)

  return {
    /** Every address currently loaded, for the checks that ask what the browser is serving. */
    urls: () => live().map((contents) => contents.getURL()),

    chromeEvaluate: (expression) => evaluateIn(chrome, expression),
    chromeSend: (event) => sendTo(chrome, event),

    overlayEvaluate: (expression) => evaluateIn(requiredOverlay(), expression),
    overlaySend: (event) => sendTo(requiredOverlay(), event),

    /**
     * Whether the overlay layer exists at all.
     *
     * The layer is created on first use, so its absence is a real answer rather than a timing
     * accident: a check that expected a menu or a drop indicator and finds no layer has learned
     * something. Synchronous, where CDP needed a poll of the target list to ask the same question.
     */
    overlayPresent: () => overlayContents() !== null,

    /**
     * A renderer other than those two: an internal page, or a tab's own view.
     *
     * `null` when nothing is loaded at that address, which several checks assert on directly — "the
     * history page is served" is exactly this question. Resolved per call, as the target list was:
     * these come and go with the tabs the checks open.
     */
    page: (matches) => {
      const contents = find(matches)
      if (contents === null) return null
      return {
        evaluate: (expression) => evaluateIn(contents, expression),
        send: (event) => sendTo(contents, event)
      }
    }
  }
}
