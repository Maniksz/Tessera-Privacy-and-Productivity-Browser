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
