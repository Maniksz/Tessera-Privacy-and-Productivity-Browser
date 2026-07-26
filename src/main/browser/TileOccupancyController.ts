import { emptyTiles, shrunkLayout, tabsToCloseOnShrink } from '@shared/split/tile-fill.js'
import type { DropZone } from '@shared/split/dropzones.js'
import type { LayoutId } from '@shared/split/layout.js'
import type { SplitController } from './SplitController.js'

/**
 * Keeps the tiles and the tabs in them matched.
 *
 * Three complaints turned out to be the same idea. Choosing a four-tile layout while holding one
 * tab left three panes reading "drag a tab here" — an instruction rather than a browser. Closing
 * a tab left its pane behind, empty, waiting. And a new tab took the *active* pane, so it
 * replaced whatever was in front of the user while empty panes sat beside it.
 *
 * Underneath all three: nothing owned the question "which tab belongs in which tile, and how many
 * tiles should there be". This does.
 *
 * Behind the host seam it is testable without a window, which matters because the rules interact:
 * shrinking a layout can close a tab, closing a tab can shrink a layout, and getting that wrong
 * is either an infinite loop or a pane that will not go away.
 */

export interface TileOccupancyHost {
  split: SplitController
  /** Whether the user wants the layout to follow the tabs. Off means panes stay as they are. */
  adaptEnabled(): boolean
  /** Tab-bar order, which is independent of tile assignment. */
  tabOrder(): readonly string[]
  /** True for a tab the browser opened to fill a tile and the user never navigated. */
  isEphemeral(tabId: string): boolean
  /** Take a tab out of the grid without closing it (spec 2). */
  unassign(tabId: string): void
  assignTabToTile(tabId: string, tileIndex: number): void
  closeTab(tabId: string): void
  /** Make a tile active, with the focus, audio and reposition work that goes with it. */
  setActiveTile(tileIndex: number): void
  /** Open a start-page tab for an empty tile, marked as a filler. */
  openFiller(tileIndex: number): void
  applyLayout(layout: LayoutId, options: { fill: boolean }): void
}

export class TileOccupancyController {
  private readonly host: TileOccupancyHost

  constructor(host: TileOccupancyHost) {
    this.host = host
  }

  /**
   * Settles who lives where after the layout changed.
   *
   * `orphaned` are the tabs whose tile no longer exists. They stay loaded and stay in the tab
   * strip, which spec 2 requires — with exactly one exception, below.
   */
  afterLayoutChange(orphaned: readonly string[], options: { fill: boolean }): void {
    for (const tabId of orphaned) this.host.unassign(tabId)

    /**
     * The exception, and the only one.
     *
     * A filler the browser opened by itself and the user never navigated was never a tab they
     * asked for. Keeping it would leave an unused start page behind after every trip through a
     * wide layout, one renderer process each. Spec 2's protection stays in full force for every
     * tab the user actually touched.
     */
    for (const tabId of tabsToCloseOnShrink(orphaned, this.#ephemeral())) {
      this.host.closeTab(tabId)
    }

    this.#rehomeHiddenTabs()
    if (options.fill) this.fillEmptyTiles()
  }

  /**
   * Settles the tile a closed tab left behind.
   *
   * First choice is a tab that is loaded but not currently shown: moving it in keeps the layout
   * the user chose. Only when there is nothing left to show does the tile itself go, which is
   * what "close" means for the pane you were looking at.
   */
  afterTabClosed(vacatedTile: number | null): void {
    if (vacatedTile === null) return

    const candidate = this.#firstHiddenTab()
    if (candidate !== undefined) {
      this.host.assignTabToTile(candidate, vacatedTile)
      return
    }

    if (!this.host.adaptEnabled()) return
    const smaller = shrunkLayout(this.host.split.layout)
    // `fill: false` is load-bearing: filling here would immediately open a replacement for the
    // tab that was just closed, and the pane would never go away.
    if (smaller !== null) this.host.applyLayout(smaller, { fill: false })
  }

  /**
   * Gives every still-empty tile a tab of its own.
   *
   * Only for a layout the user chose. A layout the browser shrank into must not be refilled.
   */
  fillEmptyTiles(): void {
    if (!this.host.adaptEnabled()) return
    for (const index of emptyTiles(this.host.split.toState().tileTabIds)) {
      this.host.openFiller(index)
    }
  }

  /**
   * Which tile a newly created tab should take.
   *
   * An empty tile always wins over an occupied one. Using the active tile first meant a new tab
   * in a split layout replaced whatever was in front of the user while empty panes sat next to
   * it — the tab arrived and their page vanished.
   */
  tileForNewTab(): number {
    return this.host.split.firstEmptyTile() ?? this.host.split.activeTile
  }

  /** Where a completed drop puts the tab, including a layout change if the zone asks for one. */
  applyDrop(tabId: string, zone: DropZone): void {
    // Layout first: switching it rehomes hidden tabs into the new tiles, and the explicit
    // assignment below has to be the one that wins for the tile the user aimed at.
    if (zone.layout !== null && zone.layout !== this.host.split.layout) {
      this.host.applyLayout(zone.layout, { fill: false })
    }
    this.host.assignTabToTile(tabId, zone.tileIndex)
    // The window's own method, so the drop lands with focus, audio and layout settled — the
    // same path a user clicking into the tile would take.
    this.host.setActiveTile(zone.tileIndex)
  }

  // --- internals -----------------------------------------------------------

  #ephemeral(): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const tabId of this.host.tabOrder()) {
      if (this.host.isEphemeral(tabId)) ids.add(tabId)
    }
    return ids
  }

  #firstHiddenTab(): string | undefined {
    return this.host.tabOrder().find((id) => this.host.split.tileOfTab(id) === null)
  }

  /** Moves loaded-but-hidden tabs into tiles that have nothing in them. */
  #rehomeHiddenTabs(): void {
    for (let index = 0; index < this.host.split.tileCount; index++) {
      if (this.host.split.tabIdAt(index) !== null) continue
      const candidate = this.#firstHiddenTab()
      if (candidate === undefined) break
      this.host.assignTabToTile(candidate, index)
    }
  }
}
