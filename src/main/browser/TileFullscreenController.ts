import type { LayoutId } from '@shared/split/layout.js'
import type { SplitController } from './SplitController.js'

/**
 * Fullscreen inside a split layout, and the ladder back out of it (spec 2).
 *
 * ## The rule
 *
 * A page's fullscreen request normally takes the whole window. In a split layout that hides
 * every other tile — the opposite of what someone watching four streams wants. Marking the
 * window as not fullscreenable stops the *window* from switching while the page's request is
 * still honoured: `enter-html-full-screen` fires, `document.fullscreenElement` is set, and the
 * player switches to its fullscreen interface. The tile stays the frame of reference.
 *
 * In a single-tile layout, or when the user has asked for window-scoped fullscreen, real
 * fullscreen is allowed through.
 *
 * ## Why it is separate from the window
 *
 * `windowFullscreenPermitted` used to be reachable only through a method that needed a live
 * `BrowserWindow`, so the test suite carried its own copy of the rule with a comment saying
 * so. A rule kept in two places is a rule that will eventually be true in one of them. Behind
 * this seam the real one is testable, and the copy is gone.
 */

/**
 * Whether the window itself may go fullscreen.
 *
 * The whole of spec 2's central requirement, in one expression.
 */
export function windowFullscreenPermitted(
  layout: LayoutId,
  scope: 'tile' | 'window'
): boolean {
  return layout === '1x1' || scope === 'window'
}

export interface TileFullscreenHost {
  split: SplitController
  fullscreenScope(): 'tile' | 'window'
  setFullScreenable(allowed: boolean): void
  exitWindowFullscreen(): void
  /** Ask the page to drop out of fullscreen so its player interface switches back. */
  askPageToExitFullscreen(tabId: string): void
  /** Flip the window's own fullscreen. Only the host can read the window's real state. */
  toggleWindowFullscreen(): void
  /** Put the window back into fullscreen. Separate from the flip, which cannot express "make sure". */
  enterWindowFullscreen(): void
  /**
   * Run this once the current burst of Electron events is over.
   *
   * The one thing below that cannot be decided in the moment: whether a window that has just left
   * fullscreen did so because a page gave up *its* fullscreen, or because the user asked. The two are
   * told apart by what arrives immediately afterwards, so the answer has to be read one turn later.
   * A turn rather than a microtask, because the two events are emitted from one native stack and a
   * microtask checkpoint can fall between them.
   */
  defer(run: () => void): void
  /** Re-position the views and tell the UI. */
  changed(): void
}

export class TileFullscreenController {
  private readonly host: TileFullscreenHost

  /**
   * The tab whose *page* is currently in HTML fullscreen, or `null`.
   *
   * Deliberately not `split.fullscreenTile`, although the two usually agree, and the gap between them
   * is the whole reason this field exists: `escape()` clears the tile straight away and then *asks* the
   * page to follow, so between the press and the page's answer the tile is out of fullscreen while the
   * document is still in it. That interval is exactly when the misattribution below has to be caught.
   */
  #pageInFullscreen: string | null = null

  /**
   * True while this controller has asked for a window fullscreen that Chromium has not granted yet.
   *
   * See `onPageLeave`: on platforms where the window's `leave-full-screen` arrives *after* the page's,
   * the re-entry is requested while the exit is still animating, and the confinement must not be put
   * back on top of it — an un-fullscreenable window cannot be taken fullscreen, so restoring the policy
   * in that moment would silently swallow the re-entry.
   */
  #awaitingWindowFullscreen = false

  constructor(host: TileFullscreenHost) {
    this.host = host
  }

  /** Whether a page's fullscreen is confined to its tile, which is when the window's own is the user's. */
  get #confined(): boolean {
    return !windowFullscreenPermitted(this.host.split.layout, this.host.fullscreenScope())
  }

  /**
   * Take the window fullscreen, lifting the confinement for exactly this request.
   *
   * The lift is not optional: `applyPolicy` may already have marked the window un-fullscreenable on the
   * way out, and `setFullScreen` on such a window is silence rather than an error — the same trap the
   * fullscreen key documents above.
   */
  #takeWindowFullscreen(): void {
    this.host.setFullScreenable(true)
    this.host.enterWindowFullscreen()
  }

  /**
   * Re-applies the policy; call after anything that changes layout or the setting.
   *
   * ## Why a fullscreen window is left alone
   *
   * The confinement is `setFullScreenable(false)`, and `window-events.ts` already says what that
   * does at the wrong moment: "Restoring it on the way *in* would trap the user in fullscreen."
   * Every other caller of this runs while the window is not fullscreen, so the guard used to be
   * unnecessary and there was nothing to write it against. Reordering `escape()` to take the
   * innermost rung first created the case: leaving a tile's fullscreen, or un-maximising a tile,
   * now happens *inside* a window that is still fullscreen, and both call this on the way out.
   * Without the guard the second `Escape` — the one that is supposed to leave the window's
   * fullscreen — would be asking an un-fullscreenable window to change its fullscreen, which is the
   * silence this whole file is about.
   *
   * Nothing is lost by waiting: `leave-full-screen` re-applies the policy, and that is the moment a
   * page could take the window and therefore the moment the confinement has to be back.
   */
  applyPolicy(): void {
    if (this.host.split.isWindowFullscreen) return
    this.host.setFullScreenable(
      windowFullscreenPermitted(this.host.split.layout, this.host.fullscreenScope())
    )
  }

  /**
   * The fullscreen key — F11, or Ctrl+Cmd+F on macOS (spec 9).
   *
   * **The window goes fullscreen. Always, in every layout.** That is what the key means in every
   * browser: the chrome and the desktop go away and the window fills the screen, with whatever
   * arrangement of tiles it was showing still inside it.
   *
   * ## Why this needs a line of its own rather than just calling the window
   *
   * `applyPolicy` marks a split window **not fullscreenable**, and `setFullScreen` on such a window is
   * not an error — it is silence. That policy exists for one requester: a *page*. A video asking for
   * fullscreen in one pane must not blank the other three, and marking the window un-fullscreenable is
   * the mechanism that confines it. But `fullScreenable` is one window-level flag and cannot tell a
   * person pressing a key from a page calling an API, so the flag has to be lifted for the request the
   * person made.
   *
   * A first version of this read the flag instead of lifting it, and put the key on the *tile's*
   * fullscreen in a split layout. That is a coherent reading of "the fullscreen scope is the tile" and
   * it is not what the key means: reported as "with F11 I meant the browser itself goes fullscreen, not
   * videos/content".
   *
   * ## Why the policy is not restored here
   *
   * Leaving the window fullscreenable while it *is* fullscreen is what lets the user out again — by the
   * key, the green button, or the escape ladder. `BrowserWindowController` re-applies the policy on
   * `leave-full-screen`, which is the moment a page could take the window and therefore the moment the
   * confinement has to be back.
   */
  toggleFullscreen(): void {
    this.host.setFullScreenable(true)
    this.host.toggleWindowFullscreen()
  }

  /** A page asked for fullscreen. The tile it lives in becomes the fullscreen one. */
  onPageEnter(tabId: string): void {
    const tile = this.host.split.tileOfTab(tabId)
    if (tile === null) return
    this.#pageInFullscreen = tabId
    this.host.split.enterTileFullscreen(tile)
    this.host.split.setActiveTile(tile)
    this.host.changed()
  }

  /**
   * A page dropped out of fullscreen — and must not take the window's fullscreen with it.
   *
   * ## What was reported
   *
   * *"wenn ich ein video in full screen mache und dann f11 drücke und in einer kachel das video wieder
   * aus dem fullscreen für die kachel beende, beendet es auch den f11 fullscreen"*. In that order, and
   * the order is the whole of it.
   *
   * ## Why the order decides it
   *
   * Chromium keeps one fullscreen state per window, so it has to remember whether a page's fullscreen
   * request was the thing that took the window there — otherwise giving the request up would leave a
   * window fullscreen that the page had made fullscreen. Electron records that at the moment the request
   * arrives, by asking whether the window is *already* fullscreen. Press F11 first and the answer is yes,
   * the page's exit leaves the window alone, and everything is well.
   *
   * Confined to a tile, the page's request never moves the window at all — that is what
   * `setFullScreenable(false)` is for — so the window is not fullscreen when it is recorded, and the
   * later F11 cannot change a record already written. Giving the fullscreen up then reads as "the page
   * brought this window here", and the user's F11 goes with it.
   *
   * ## Why the answer is re-entry rather than prevention
   *
   * There is nothing to prevent: no event stands between the page's exit and Chromium acting on it, and
   * the record that misattributes the window's fullscreen is Electron's own. So the rule is stated as an
   * outcome instead — **a page giving up its fullscreen never changes the window's** — and enforced by
   * putting back what was taken. Confined layouts only: with the confinement lifted a page's fullscreen
   * genuinely *is* the window's, and there Chromium's own bookkeeping is right.
   *
   * The two events can arrive in either order, which is why the same rule is written twice. Here it is
   * read from `isWindowFullscreen`, for the platforms where the window's `leave-full-screen` has not
   * arrived yet; `onWindowLeftFullscreen` reads it from `#pageInFullscreen`, for the platforms where it
   * already has.
   */
  onPageLeave(): void {
    const heldWindowFullscreen = this.#confined && this.host.split.isWindowFullscreen
    this.#pageInFullscreen = null
    this.host.split.leaveTileFullscreen()
    if (heldWindowFullscreen) {
      this.#awaitingWindowFullscreen = true
      this.#takeWindowFullscreen()
    }
    this.host.changed()
  }

  /**
   * The window left fullscreen. Whose doing that was is not yet knowable.
   *
   * Three cases, and only the first two can be told apart in the moment:
   *
   *   - **We asked for it back.** `onPageLeave` has already requested the re-entry and the exit it is
   *     racing is the one being reported here. The confinement stays lifted until Chromium has settled,
   *     and `applyPolicy` is deferred rather than skipped so that a re-entry which never happens still
   *     ends with the window confined.
   *   - **A page is still in fullscreen.** Then this exit may be Chromium giving the window up on that
   *     page's behalf — or it may be the user, by the key or the green button, with a fullscreen video
   *     carrying on inside a tile. The difference is whether the page releases its fullscreen in the
   *     same breath, which is a question only the next turn can answer.
   *   - **Anything else** is the plain case, and the confinement goes straight back.
   */
  onWindowLeftFullscreen(): void {
    if (this.#awaitingWindowFullscreen) {
      this.#awaitingWindowFullscreen = false
      this.host.defer(() => this.applyPolicy())
      return
    }

    if (this.#confined && this.#pageInFullscreen !== null) {
      this.host.defer(() => {
        // Released in the same breath: the page was giving up its fullscreen, so this exit was not the
        // user's and the window goes back where they left it.
        if (this.#pageInFullscreen === null) this.#takeWindowFullscreen()
        else this.applyPolicy()
      })
      return
    }

    this.applyPolicy()
  }

  /**
   * One step back down the escalation ladder.
   *
   * Exactly one rung per press, which is what makes Escape predictable: from a page's
   * fullscreen inside a tile, out of the tile's fullscreen, then out of a maximised tile,
   * then out of the window's own fullscreen.
   *
   * That sentence was here before the code did it. `SplitController.escape` read the ladder from
   * the other end and took the window's fullscreen first, which is the defect this order fixes —
   * see the docblock there for the report and the reasoning. Kept as a switch over the *named*
   * step rather than a second copy of the priority, so there is one place the order can be wrong.
   */
  escape(): void {
    const step = this.host.split.escape()
    switch (step) {
      case 'exit-window-fullscreen':
        this.host.exitWindowFullscreen()
        break
      case 'exit-tile-fullscreen': {
        const tile = this.host.split.fullscreenTile
        this.host.split.leaveTileFullscreen()
        if (tile !== null) {
          /*
            Now the *first* rung, which is the point — and it is also the rung most likely to be
            asking a page for something it has already done. The press that got here reached the
            page too, and a player that handles `Escape` itself has left fullscreen before this
            runs. `askPageToExitFullscreen` is safe either way: it is a request, `document
            .exitFullscreen()` on a document that is not fullscreen rejects rather than throwing,
            and the seam swallows that on purpose (see `window-seams.ts`). Skipping the ask when the
            page "looks" already out was rejected — the main process cannot see
            `document.fullscreenElement`, so the check would be a guess, and the case it gets wrong
            is the player that ignored the key and stays fullscreen with no way back.
          */
          const tabId = this.host.split.tabIdAt(tile)
          if (tabId !== null) this.host.askPageToExitFullscreen(tabId)
        }
        break
      }
      case 'restore-tile':
      case 'none':
        break
    }
    this.applyPolicy()
    this.host.changed()
  }
}
