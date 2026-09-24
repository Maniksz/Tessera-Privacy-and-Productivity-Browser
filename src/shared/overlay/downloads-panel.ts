import type { DownloadEntry } from '../downloads/model.js'
import type { Rect } from '../ui/anchor.js'
import type { OverlayState } from './surface.js'

/**
 * The toolbar's downloads panel on the overlay layer: its payload, the request that asks for it, and the
 * two functions the core builds it with.
 *
 * ## Why it lives beside the overlay surface rather than in it
 *
 * The same reason `picker-bar.ts` and `autofill-suggest.ts` do: the per-kind tables in `surface.ts` have
 * to name every kind, but how one kind's payload is shaped and filled is that kind's business.
 * `surface.ts` imports the types for its unions and re-exports everything here, so callers keep importing
 * the overlay vocabulary from there. The import of `OverlayState` back from it is type-only, so the
 * runtime edge runs one way.
 *
 * Zod-free and Electron-free, like everything both renderers import at runtime.
 */

/**
 * How many downloads the panel lists: the newest few, and the page for the rest (KTD7).
 */
export const DOWNLOADS_PANEL_ROWS = 6

/**
 * The toolbar's downloads panel: the newest few rows of the list the downloads page shows this window.
 *
 * ## Why the rows are here and not in the request
 *
 * The chrome UI asks for the panel with a kind and an anchor and nothing else (`DownloadsPanelRequest`);
 * the core puts the rows in. Two reasons, both about where the list is allowed to go (KTD2). The chrome UI
 * is never sent the list — its button is told numbers and states, not names — so it has no rows to give;
 * and a panel whose rows came from the asker would be a panel that could show a list the window may not
 * see. The core builds the rows from the window's own snapshot, the same one the page and the button are
 * computed from, so the three views cannot describe two different moments (R9).
 *
 * ## Why it is re-sent while it is open
 *
 * A download moves while somebody watches it, and the core owns what is on screen here as everywhere
 * else on this layer. So the core re-presents the panel on every coalesced change while the panel is the
 * window's current surface — the find bar's rule, for the find bar's reason. The identity never changes
 * (`surfaceIdentity`), so each of those is an update and not a departure, and the layer leaves the
 * keyboard where it is (`OVERLAY_REFOCUSES_ON_UPDATE`).
 */
export interface DownloadsPanelPresentation {
  kind: 'downloads-panel'
  /** The button's rect in window coordinates, kept by the core for every re-presentation. */
  anchor: Rect
  /** Newest first, at most `DOWNLOADS_PANEL_ROWS`. Empty is a real state: everything was removed. */
  downloads: DownloadEntry[]
}

/** What the chrome UI sends to open the panel: which kind, and where its button is. Never rows. */
export interface DownloadsPanelRequest {
  kind: 'downloads-panel'
  anchor: Rect
}

/**
 * The panel for a window's list: its newest rows, hung from the button at `anchor`.
 *
 * `entries` is the window's list as the downloads page is shown it, newest first — the manager's order —
 * so the panel is the head of the page and never a second opinion about it (KTD7).
 */
export function downloadsPanelPresentation(
  anchor: Rect,
  entries: readonly DownloadEntry[]
): DownloadsPanelPresentation {
  return { kind: 'downloads-panel', anchor, downloads: entries.slice(0, DOWNLOADS_PANEL_ROWS) }
}

/**
 * The panel re-presented with fresh rows, or `null` when there is no panel up to re-present.
 *
 * `null` for everything but the panel itself, and that is the rule rather than a shortcut (KTD8). A
 * coalesced change arrives whether or not anybody is looking: a closed panel that came back on the next
 * progress tick would be a panel nobody asked for, and because equal ranks replace, one presented over a
 * menu would take the menu down — while one presented over a find bar would destroy a search somebody
 * typed. The anchor is the one the user opened it at, kept by the layer rather than asked for again.
 */
export function downloadsPanelUpdate(
  current: OverlayState,
  entries: readonly DownloadEntry[]
): DownloadsPanelPresentation | null {
  if (current?.kind !== 'downloads-panel') return null
  return downloadsPanelPresentation(current.anchor, entries)
}
