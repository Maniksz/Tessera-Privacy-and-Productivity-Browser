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
  /** Re-position the views and tell the UI. */
  changed(): void
}

export class TileFullscreenController {
  private readonly host: TileFullscreenHost

  constructor(host: TileFullscreenHost) {
    this.host = host
  }

  /** Re-applies the policy; call after anything that changes layout or the setting. */
  applyPolicy(): void {
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
    this.host.split.enterTileFullscreen(tile)
    this.host.split.setActiveTile(tile)
    this.host.changed()
  }

  onPageLeave(): void {
    this.host.split.leaveTileFullscreen()
    this.host.changed()
  }

  /**
   * One step back down the escalation ladder.
   *
   * Exactly one rung per press, which is what makes Escape predictable: from a page's
   * fullscreen inside a tile, out of the tile's fullscreen, then out of a maximised tile,
   * then out of the window's own fullscreen.
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
