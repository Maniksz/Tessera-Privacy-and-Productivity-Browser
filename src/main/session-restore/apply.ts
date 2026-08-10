import type { LayoutId } from '@shared/split/layout.js'
import type { PlannedTab, PlannedWindow } from '@shared/session/restore.js'

/**
 * Carrying out a restore plan: the order, and nothing else.
 *
 * Behind a seam rather than written into the entry point, because every line of it is an
 * ordering rule whose violation is silent, and none of them can be tested through
 * `BrowserWindowController` without a live Electron window. What is decided *here* is
 * decided once and pinned by a test; what is left to the caller is the operations it
 * already has.
 *
 * There is deliberately no state and no pass-through method: this is not a layer over the
 * window, it is the sequence a window has to be driven in.
 */

/** One window being restored, once it exists in the right layout. */
export interface RestoreTarget {
  /**
   * Creates the tab **with the id it had**, in the tile the plan gives it, loading it only
   * when the plan says `now`.
   *
   * The id is the whole point — see `shared/session/tab-ids.ts` — and it has to be adopted
   * through `adoptTabId`, which raises the counter past it in the same call. A restore that
   * created tabs with fresh ids would leave every stored tab group unattachable, which is
   * the state this feature exists to end.
   */
  openTab(tab: PlannedTab): void
  setActiveTile(index: number): void
}

export interface RestoreHost {
  /**
   * Opens a normal-mode window **already in** the restored layout, with its dividers where
   * they were.
   *
   * The layout is part of creating the window rather than something set afterwards, and
   * that turns the two worst mistakes in a restore from "avoided" into "unreachable".
   *
   *   - `SplitController.assignTab` clamps an out-of-range tile index instead of refusing
   *     it. A window still in `1x1` when its tabs arrive would put every one of them in
   *     tile 0, each displacing the last, and end up looking like it restored one tab out
   *     of four.
   *   - `BrowserWindowController.setLayout` **fills empty tiles with new start-page tabs**
   *     when `splitView.adaptLayoutToTabs` is on, which it is by default. Growing the
   *     layout after the window exists would therefore fetch pages nobody asked for — the
   *     exact cost the deferred loading below exists to avoid — and then those fillers
   *     would be displaced by the restored tabs a moment later.
   *
   * `SplitController` takes a layout and its fractions in its constructor for this reason,
   * so nothing new has to be invented to satisfy it.
   */
  openWindow(layout: LayoutId, fractions: Readonly<Record<string, number>>): RestoreTarget
  /**
   * `TabGroupBook.retainTabs`, called **once** with every id every window brought back.
   *
   * Once, and that is not an optimisation. Normal windows share one tab-group document on
   * purpose — a group survives a tab moving between windows — so calling this per window
   * would have the second window's restore empty the groups belonging to the first. The
   * launch would end with the groups of exactly one window intact and no sign of what
   * happened to the others.
   */
  retainTabs(ids: readonly string[]): void
  /**
   * `ArrangementBook.retainTabs`, called **once** with the same ids, for the same reason.
   *
   * The recordings of every ordinary window live in one document too — that is why the book's
   * `retainTabs` is the one method on it that is not window-scoped — so a call per window would
   * empty the first window's arrangements as the second came back. A user with two tiled windows
   * would then find one of them unable to bring its panes back, with nothing to say why.
   */
  retainArrangementTabs(ids: readonly string[]): void
}

/**
 * Opens every planned window and reconciles the tab groups and arrangements with what came back.
 *
 * What is left for this function to get right, once the layout is settled at creation:
 *
 *   1. **Tabs in strip order.** A window appends each new tab to `#tabOrder`, so the order
 *      they are opened in *is* the strip, and there is no later call that could put it
 *      right.
 *   2. **The active tile after the tabs.** Activating a tile focuses the tab in it, so
 *      doing it first would focus an empty pane.
 *   3. **Both reconciliations last, and once each.** Every restored id must exist before the
 *      groups and the arrangements are reconciled: a group naming a tab that has not been
 *      created yet would be emptied, and a recording naming one would lose that seat — which
 *      is precisely the loss session restore is meant to stop. And they must run before the
 *      user can see anything, so nobody watches groups appear and then vanish.
 *
 * Called with no windows as well — a launch that restored nothing still has to reconcile, or
 * the stored groups would keep members that do not exist in this run and the stored recordings
 * would seat this run's unrelated fresh tabs. That is also how a launch with session restore
 * switched off clears both documents (R8): it is the same statement — nothing came back — and
 * it is answered here rather than at each call site.
 *
 * Returns the ids actually brought back: the same list `retainTabs` was given, so a caller
 * can log or assert on it without recomputing it from the plan.
 */
export function applySessionRestore(
  windows: readonly PlannedWindow[],
  host: RestoreHost
): string[] {
  const restored: string[] = []

  for (const window of windows) {
    const target = host.openWindow(window.layout, window.fractions)
    for (const tab of window.tabs) {
      target.openTab(tab)
      restored.push(tab.id)
    }
    target.setActiveTile(window.activeTile)
  }

  host.retainTabs(restored)
  host.retainArrangementTabs(restored)
  return restored
}
