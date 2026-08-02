import { clampZoomPercent } from './model.js'

/**
 * How a pane's zoom gets from the core into the document it belongs to.
 *
 * ## Why this file exists at all: the one part Chromium would not give us
 *
 * `model.ts` used to end on a limitation and a shrug. Zoom was `webContents.setZoomFactor`, and
 * Electron's own typings say what that means: *"the zoom policy at the Chromium level is same-origin,
 * meaning that the zoom level for a specific domain propagates across all instances of windows with
 * the same domain"*. In a browser whose whole point is a split view, that is not a footnote — it is
 * the feature failing at exactly the moment it is being used. Two tiles on the same site zoomed
 * together, the last one touched winning, and a new tab on a host somebody had zoomed dragged the
 * other pane with it. Reported as *"der zoom gilt pro domain, nicht pro kachel"*, which is precisely
 * what it was.
 *
 * The escape written down in that docblock was Chromium's isolated zoom mode, which Electron 43 does
 * not expose — there is no `setZoomMode` on `WebContents`, and the temporary per-view zoom level the
 * mode rests on is not reachable from JavaScript. So the choice was between living with a
 * per-*domain* zoom in a per-*pane* browser, or zooming the document rather than the view. **The user
 * chose the document**, and this is that route: a stylesheet, inserted by the content preload, that
 * puts `zoom` on the page's root element.
 *
 * ## What it costs, stated plainly rather than discovered later
 *
 * CSS `zoom` is not browser zoom, and three differences are visible on real sites:
 *
 *   - **Media queries do not move.** Browser zoom shrinks the viewport in CSS pixels, so a responsive
 *     site switches to its narrower layout as you zoom in. CSS zoom leaves the viewport alone, so the
 *     desktop layout is simply drawn larger.
 *   - **Viewport units do not move either**, for the same reason: a `100vh` hero becomes taller than
 *     the window once the zoom is above 100 %, and the page scrolls where it used to fit.
 *   - **The page can see it.** `getComputedStyle(document.documentElement).zoom` reads back, and any
 *     measurement the page takes is in the zoomed coordinate space. Browser zoom is comparatively
 *     invisible.
 *
 * Against that, the thing it buys is the thing that was asked for: two tiles showing one site at two
 * different sizes, which no arrangement of `setZoomFactor` can produce in one session.
 *
 * ## Why a stylesheet rather than a style attribute
 *
 * The preload inserts it with `webFrame.insertCSS`, which needs no DOM. That matters more than it
 * sounds: a preload runs before the parser has produced `<html>`, so anything that appends an element
 * has to either find a parent that may not exist yet or wait for one — and waiting is a visible jump
 * from unzoomed to zoomed on every page load. `insertCSS` applies to the document being created, at
 * the earliest moment there is one, and hands back a key so the next value can replace it.
 *
 * ## Why the channel is not in the IPC contract
 *
 * The same reason `FINGERPRINT_PLAN_CHANNEL` and the cosmetic channels are not. A visited page has no
 * bridge (spec 6) and cannot reach `ipcRenderer`; only its preload can. Putting this in
 * `shared/ipc/channels.ts` would add a name every page uses to the surface `sender-policy.ts` has to
 * defend, and defending it would mean allowing every content view to call it — which a per-view
 * listener achieves already, without widening anything.
 */

/**
 * Both directions on one name.
 *
 * `sendSync` from the preload at document-start asks *"what is this pane's zoom"*, and `webContents.send`
 * from the core pushes a new value when the user zooms or changes `appearance.defaultZoom`. One channel
 * because it is one question; the pull is what covers the first paint and the push is what covers a
 * change while the page is open, and a document needs both.
 */
export const PAGE_ZOOM_CHANNEL = 'tessera:page-zoom'

/**
 * The stylesheet for a percentage, or the empty string for a page that should not be zoomed at all.
 *
 * `:root` rather than `body`, because a page's background, its scrollbars and anything positioned
 * outside `<body>` are part of what a person means by "make this bigger". `!important` because the
 * point is to beat the page's own rule — the same reason `cosmeticCss` uses it.
 *
 * The empty string at 100 % is load-bearing rather than an optimisation: it is what lets the preload
 * *remove* its stylesheet instead of inserting a no-op one, so a page at the default zoom carries no
 * trace of this at all and `zoom` reads back as the page left it.
 *
 * A percentage rather than a factor, so the text is an integer and no float formatting has to be
 * agreed on between this and whatever reads it.
 */
export function zoomCss(percent: number): string {
  const applied = clampZoomPercent(percent)
  return applied === 100 ? '' : `:root{zoom:${String(applied)}%!important}`
}

/**
 * A percentage from an answer that crossed a process boundary, or 100 for one that makes no sense.
 *
 * Total, like every other `as…` at this boundary, and for a sharper reason than most: the preload
 * asks with `sendSync`, which answers `undefined` when nothing is listening — an older core, or a
 * view created outside a hardened session. 100 is the right reading of "no answer", because it is the
 * size the page would be if this feature did not exist.
 *
 * Clamped as well as checked, so a core that somehow reports 5000 cannot produce a page the user
 * cannot read their way out of. `clampZoomPercent` rounds too, which keeps the value an integer all
 * the way to the stylesheet.
 */
export function asZoomPercent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? clampZoomPercent(value) : 100
}

/**
 * A client-rectangle coordinate, translated into the space an overlay of ours is positioned in.
 *
 * The one piece of arithmetic CSS zoom forces on the rest of the browser, and it is worth stating why
 * rather than leaving two divisions to be puzzled over. `getBoundingClientRect()` reports where an
 * element actually is on screen, which already includes the zoom. Our own surfaces — the element
 * picker's highlight, the autofill list — are elements *inside* the zoomed page, so a length written
 * into their `left` is multiplied by the zoom on the way to the screen. Writing the rectangle back
 * unchanged therefore puts the highlight at 150 % of the distance it should be, and the error grows
 * with the zoom, which reads as the picker being broken rather than as a unit mismatch.
 *
 * Dividing here is what keeps them scaled *with* the page — the alternative was exempting them from
 * the zoom, which would have left the browser's own surfaces at a fixed size on a page the user
 * enlarged because they could not read it.
 */
export function inPageCoordinates(clientPixels: number, zoomPercent: number): number {
  return (clientPixels * 100) / clampZoomPercent(zoomPercent)
}
