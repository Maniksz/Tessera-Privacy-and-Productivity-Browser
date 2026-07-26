import { tileBarStep, type TileBarMode, type TileBarRequest } from '@shared/split/tile-bar.js'
import { decideNavigationGesture, type GestureSource } from '@shared/gestures/navigation.js'
import type { OverlayPresentation, OverlayState } from '@shared/overlay/surface.js'
import type { Point } from '@shared/split/dropzones.js'
import type { Rect } from '@shared/split/layout.js'
import type { TileBarTab } from '@shared/split/tile-bar.js'

/**
 * Input that arrives at the window and belongs to a *tile*.
 *
 * Three things arrived within a day of each other and turned out to be one idea: a pointer nearing a tile's top
 * edge, a shortcut asking for that tile's navigation bar, and a mouse's thumb button or a trackpad swipe meaning
 * back. All three share the question that makes them hard — *which tile did the user mean?* — and all three
 * answer it the same way: from geometry, not from which tile last had focus.
 *
 * That answer is the reason this is a seam rather than three methods on the window. With four pages on screen the
 * hand is on the mouse over the tile being read, which is frequently not the tile that last had focus; a thumb
 * button that navigates the neighbour is indistinguishable from a bug. Getting it wrong is invisible in review
 * and obvious in use, which is exactly the kind of rule that has to be reachable from a test.
 *
 * The decisions themselves are already pure and tested — `tileBarStep` and `decideNavigationGesture`. What is
 * here is the part that needs a window's rectangles, its overlay and its tabs, expressed as a host so it needs
 * none of them.
 */

export interface TileInputHost {
  /** Tile rectangles in content coordinates, `null` for a tile the layout does not have. */
  tileRects(): ReadonlyArray<Rect | null>
  activeTile(): number
  /** Whether each tile shows its own bar, and on what. */
  tileBarMode(): TileBarMode
  /** What is on the overlay layer now, so a bar can tell whether it is already up. */
  overlayPresentation(): OverlayState
  present(presentation: OverlayPresentation): void
  /** Takes down only the bar. Never a plain dismiss: a prompt that leaves the layer is settled as refused. */
  dismissTileBar(): void
  /** The tab in a tile, or `null` for an empty one. Only the host knows the tabs. */
  tabIn(tileIndex: number): TileBarTab | null
  /** The pointer in content coordinates, or `null` when it cannot be read. */
  cursor(): Point | null
  goBack(tileIndex: number): void
  goForward(tileIndex: number): void
}

export class TileInputController {
  private readonly host: TileInputHost

  constructor(host: TileInputHost) {
    this.host = host
  }

  /**
   * Reveals, moves or hides a tile's navigation bar (spec 2).
   *
   * Three cases and no arithmetic: every rule about which tile a report is about, whether the setting admits it,
   * and whether that tile even has a tab lives in `tileBarStep`.
   */
  requestTileBar(request: TileBarRequest): void {
    const current = this.host.overlayPresentation()
    const action = tileBarStep({
      current:
        current?.kind === 'tile-bar'
          ? { tileIndex: current.tileIndex, invokedBy: current.invokedBy }
          : null,
      mode: this.host.tileBarMode(),
      request,
      rects: this.host.tileRects(),
      tabOf: (tileIndex) => this.host.tabIn(tileIndex)
    })

    if (action.do === 'present') this.host.present(action.presentation)
    /*
      By kind, not a plain dismiss. A pointer leaving a tile must not take down a permission prompt — and a
      prompt that leaves the layer is settled the safe way, which is refused. `tileBarStep` does not know what
      else the layer might be showing and should not have to.
    */
    else if (action.do === 'hide') this.host.dismissTileBar()
  }

  /**
   * A navigation gesture from hardware that has its own buttons for it.
   *
   * Applied to the tile the pointer is in rather than the active one, which is also what Chromium already does
   * with wheel and swipe input: it routes by cursor rather than by focus.
   */
  navigateByGesture(source: GestureSource, name: string): void {
    const decision = decideNavigationGesture({
      source,
      name,
      pointer: this.host.cursor(),
      tiles: this.host.tileRects(),
      activeTile: this.host.activeTile()
    })
    if (decision === null) return
    if (decision.intent === 'back') this.host.goBack(decision.tileIndex)
    else this.host.goForward(decision.tileIndex)
  }
}
