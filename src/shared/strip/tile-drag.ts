/**
 * A tab dragged out of a tile by its bar's grip, as the tab strip hears of it (U10, R9, KTD14).
 *
 * ## Why the strip is told at all
 *
 * The drag begins on the overlay layer, not in the strip, so the strip holds no press of its own and
 * cannot know a tab is on its way. And whether the pointer's events reach the strip once it is over it
 * depends on which view the platform hands a held button to, which this app has not settled: the layer
 * the press began on, or the view under the pointer. So the core, which hears the pointer from both,
 * tells the strip where it is while it is over the strip — enough for the strip to show where the tab
 * would land — and, once, where it was let go. The strip is the only one that can turn a point into a
 * target and a side (`stripSpotAt`), so it answers with that, and the core releases the tab from its
 * tiled view and drops it there (`arrangements:releaseTab` with `at`).
 *
 * Pure types, zod-free: the strip is a renderer. The wire form is `tileDragReportSchema`.
 */
export interface TileDragReport {
  tabId: string
  /**
   * The pointer over the strip, in window coordinates — the chrome UI's own client space. `null` while
   * it is over the tiles, and in the first report, which only says a tile drag has begun.
   */
  point: { x: number; y: number } | null
  /** True once, for the pointer let go at `point`. Nothing is sent for a drag let go anywhere else. */
  released: boolean
}
