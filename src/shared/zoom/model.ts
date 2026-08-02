/**
 * A pane's zoom: the value it holds, and what "no value" means.
 *
 * ## Zoom belongs to the pane, not to the site
 *
 * Spec 1 said the opposite — "the same page open twice must look the same in both tabs" — and it
 * was built that way: a `Map` from registrable domain to percentage, in memory, lost on every
 * restart. **The user reversed that on 29.07.2026**, and the consequence belongs in the same breath
 * as the decision: *two tiles showing the same page no longer zoom together*. A pane left at 200 %
 * stays at 200 % for whatever is opened in it, because what was zoomed is the pane and not the
 * page; the way back is Reset Zoom, which returns it to following `appearance.defaultZoom`.
 *
 * Rejected on the way, explicitly: seeding a new pane from the last zoom of its domain. It reads as
 * a kindness and it is the domain register again, kept invisibly — the exact thing being abolished.
 * A new pane starts at the setting.
 *
 * ## The part Chromium would not give us, and what was done about it
 *
 * For a while only the *value* here was per pane. The rendering was not: `setZoomFactor` writes into
 * a zoom map Chromium keys by origin and shares across the session, so two panes showing the same
 * host tracked each other and the last one zoomed won. Reported, in exactly those words — *"der zoom
 * gilt pro domain, nicht pro kachel"*.
 *
 * Chromium's isolated zoom mode would have fixed it and Electron 43 does not expose it. So zoom moved
 * off the view and onto the document: the content preload inserts a stylesheet that puts `zoom` on
 * the page's root element, which is per document by construction and touches no shared map.
 * `shared/zoom/injection.ts` holds that decision, what it costs — media queries and viewport units do
 * not move with it — and why the preload channel is not a bridge (spec 6).
 *
 * Nothing in *this* file changed when that happened, which is the point of it having been separated
 * out: the clamp, the fallback and the sentinel are the same rules whoever applies them.
 *
 * ## Why zoom needed a file at all
 *
 * It had none. That `Map` lived in `Tab.ts`, which cannot load outside a browser process and is on
 * the coverage exclude list, and the two rules that actually matter — the clamp and the fallback to
 * the setting — were expressions buried in methods on a live `WebContents`. Nothing about zoom could
 * be asked a question. Only what can be decided without a window is here: putting a factor on a view
 * is still the tab's job, and the step from one percentage to the next is `gestures/zoom.ts`.
 *
 * ## Why the absence of a value is itself a value
 *
 * `null` is a pane nobody has zoomed, and it is deliberately not the same as 100 %.
 * `appearance.defaultZoom` applies live (spec 5), so changing it has to move the panes the user
 * never touched and leave the ones they did — and a pane a user deliberately set to 100 % is one
 * they touched. A plain number cannot tell those two apart, so the setting would have had to
 * either stomp deliberate zooms or stop reaching open panes at all, and the second is a visible
 * behaviour change nobody asked for. The price is one nullable field in the session file.
 *
 * The sentinel is also what makes Reset Zoom mean something a number could not express: it puts a
 * pane back to *following the setting*, not to whatever the setting happens to say today.
 */

/**
 * The ends of the range, and the only place they are written down.
 *
 * They are the ends of `ZOOM_STOPS` as well, held to it by a test rather than by an import: the
 * ladder is a list of steps and this is a clamp, and a clamp that read `ZOOM_STOPS[0]` would need
 * a fallback branch for a non-empty literal that no test could reach. That directory's coverage
 * gate is absolute, so an unreachable branch is what makes somebody lower a gate.
 */
export const MIN_ZOOM_PERCENT = 30
export const MAX_ZOOM_PERCENT = 300

/**
 * One pane's own zoom, or `null` for a pane that has never been zoomed.
 *
 * The type is named rather than spelled out at each use because the `null` carries a meaning that
 * `number | null` does not: it is not "unknown" and not "100", it is "still following
 * `appearance.defaultZoom`". See the module docblock for why that distinction is load-bearing.
 */
export type PaneZoom = number | null

/**
 * A percentage this browser will actually apply.
 *
 * Rounded as well as bounded, because the value can arrive from a hand-edited session file or from
 * a setting, and a factor of 1.234 is a page at a size nobody chose.
 */
export function clampZoomPercent(percent: number): number {
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, Math.round(percent)))
}

/**
 * What a pane is showing at: its own zoom, or the setting when it has never been zoomed.
 *
 * The clamp is applied to whichever of the two wins, so the answer is total: a session file with a
 * zoom of 5000 in it cannot produce a pane the user is unable to read their way out of, and
 * neither can a settings file. Both are validated elsewhere, which is exactly why doing it again
 * here costs one call and no branch.
 */
export function effectiveZoomPercent(zoom: PaneZoom, defaultZoom: number): number {
  return clampZoomPercent(zoom ?? defaultZoom)
}
