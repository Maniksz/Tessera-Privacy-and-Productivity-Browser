import { TILE_COUNT, type LayoutId } from '../split/layout.js'
import { INTERNAL_SCHEME } from '../product.js'
import { isHomeUrl } from '../url/omnibox.js'
import {
  MAX_SESSION_URL_LENGTH,
  MAX_UNFINISHED_RESTORES,
  claimTile,
  clampTile,
  keepKnownFractions,
  type SessionDocument,
  type SessionTab,
  type SessionWindow
} from './model.js'

/**
 * What to bring back, decided before anything is created.
 *
 * Separate from `model.ts` because it answers a different question. That file knows what
 * a saved session *is*; this one knows what a saved session *becomes* under the settings
 * in force right now — and those two drift apart on purpose, because the file was written
 * under yesterday's settings.
 *
 * Everything here is pure, and that is what makes the three quiet mistakes testable:
 *
 *   1. **A start-page tab restored as if it were a page.** It is the new-tab page. There
 *      is nothing to come back to, and a pinned one is worse than useless.
 *   2. **A tab caught mid-navigation, which has two addresses.** Picking the wrong one is
 *      invisible: the tab opens, it is simply somewhere the user was not.
 *   3. **A layout with more tiles than the settings now allow.** Assigning a tab to a
 *      tile the layout does not have does not fail — `SplitController.assignTab` clamps —
 *      so two tabs end up fighting over tile 0 and one of them is loaded and unreachable.
 */

/**
 * Schemes worth coming back to.
 *
 * `tessera:` is in, unlike in the history, and the difference is deliberate: an internal
 * page other than the start page is somewhere you navigated to and can copy the address
 * of, so `tessera://history` in a tile is a tab the user put there. Everything left out
 * — `about:`, `data:`, `blob:`, `javascript:`, `chrome-error:` — is either not a place or
 * not one a restore could return to honestly.
 */
export const RESTORABLE_SCHEMES: readonly string[] = ['http:', 'https:', 'file:', INTERNAL_SCHEME]

/**
 * When a restored tab fetches.
 *
 * `now` for a tab a tile is about to show, `on-activation` for one that is only in the
 * strip. See `loadTimingFor` for why that line and not another.
 */
export type LoadTiming = 'now' | 'on-activation'

export interface PlannedTab {
  /** The id it had. See `tab-ids.ts` for why that is safe and what makes it safe. */
  id: string
  /** Never empty: a tab with no address to return to is not planned at all. */
  url: string
  title: string
  pinned: boolean
  tileIndex: number | null
  /**
   * The pane's own zoom, or `null` for one that was never zoomed. See `PaneZoom`.
   *
   * Carried through unjudged, unlike the tile beside it, and the difference is the point: a tile
   * has to be re-claimed because the layout the window comes up in may be smaller than the one the
   * file describes, whereas a zoom has nothing here it could contradict. `repairSession` has
   * already held it to the range a pane can be put at.
   */
  zoomPercent: number | null
  load: LoadTiming
}

export interface PlannedWindow {
  layout: LayoutId
  fractions: Record<string, number>
  activeTile: number
  /** Strip order, never empty, and at least one of them holds a tile. */
  tabs: PlannedTab[]
}

/**
 * Why nothing is being restored. Named rather than a boolean because three of the four
 * are worth a line in the log — a user who asked for their session back and did not get
 * it deserves to be able to find out why.
 */
export type RestoreSkipReason =
  'not-requested' | 'nothing-to-restore' | 'previous-launch-crashed' | 'restore-keeps-crashing'

export type RestorePlan =
  { kind: 'restore'; windows: PlannedWindow[] } | { kind: 'skip'; reason: RestoreSkipReason }

/**
 * The settings that bear on a restore, as a shape this module can be tested against.
 *
 * Narrow and structural rather than the whole `SettingsSnapshot`, so the rules below do
 * not have to know the spelling of a settings key — and so `shared/session` stays free of
 * the module that holds the schemas. The mapping lives in
 * `src/main/session-restore/settings.ts`, where it is typed against the real snapshot and
 * a renamed key is a compile error.
 */
export interface RestoreSettings {
  /**
   * The user asked for their last session back.
   *
   * One field for what the settings express twice — see `restoreSettingsFrom` for why
   * either key is honoured.
   */
  wantsRestore: boolean
  /** `session.restoreAfterCrash`. */
  afterCrash: boolean
  /** `splitView.restoreLayoutOnStart`. */
  restoreLayout: boolean
  /** `splitView.defaultLayout`, which is the layout used when the saved one is not. */
  defaultLayout: LayoutId
}

/**
 * The address a tab comes back at, or `null` when it does not come back.
 *
 * ## The start page is not a page
 *
 * `tessera://start` is the new-tab page, and `''` and `about:blank` are the same thing
 * before anything has loaded. None of them is a destination: restoring one produces
 * exactly what a window produces by itself, because a window with no tabs opens a start
 * page anyway. So they are dropped — **including when the tab was pinned.** Pinning is a
 * promise to keep a page to hand, and the start page is already to hand; a pinned tile
 * holding the new-tab page is a slot the user cannot use and would have to unpin to
 * reclaim.
 *
 * ## A tab caught mid-navigation
 *
 * Such a tab has two candidate addresses and they can be very different: the page it is
 * showing, and the one it is on the way to. The committed address wins, for three
 * reasons that all point the same way.
 *
 * It is the address that actually loaded, so we know it resolves and we have its title
 * to label the strip with. The pending one is unverified by definition. And it is the
 * pending address that is most likely to be *why* the browser is being restarted — a
 * page that hung or crashed the tab was, at that moment, a navigation in flight. A
 * restore that preferred it would walk straight back into the crash it is recovering
 * from, twice, and then be refused by the crash-loop guard.
 *
 * The pending address is still the fallback, and it has to be: a tab opened straight onto
 * a link has committed nothing at all, and dropping it would lose the tab entirely rather
 * than merely restore it one page behind.
 */
export function restorableAddressOf(tab: SessionTab): string | null {
  const committed = restorableAddress(tab.url)
  if (committed !== null) return committed
  return restorableAddress(tab.pendingUrl ?? '')
}

/**
 * When a restored tab is allowed to make a request.
 *
 * ## Restoring must not fetch
 *
 * A restore of twenty tabs that loaded all twenty is twenty requests nobody asked for, on
 * whatever connection the user happens to be on — and, on the hardware this browser
 * targets, twenty renderer processes at once, which is the binding constraint long before
 * the bandwidth is. It also gets the privacy story wrong: launching the browser would
 * announce the user's presence to twenty sites before they had decided to visit any.
 *
 * So a restored tab comes back **discarded**: in the strip, with its title and its
 * address, having fetched nothing. `TabState.unloaded` already exists for exactly this
 * state, and activating such a tab loads it the way a click always has.
 *
 * ## Except the ones a tile is about to show
 *
 * A tile is a *visible* pane. A restored layout whose tiles were all empty would be a
 * window showing nothing, and there would be no way to tell it from a broken restore.
 * So the tabs the layout displays load immediately — at most `TILE_COUNT[layout]` of
 * them, four in the largest arrangement — and those are precisely the pages the user is
 * about to be looking at. Everything else waits to be asked for.
 */
export function loadTimingFor(tileIndex: number | null): LoadTiming {
  return tileIndex === null ? 'on-activation' : 'now'
}

/**
 * The whole decision, in the order the reasons apply.
 *
 * Refusals come before any per-window work, so a document that is not going to be used
 * is not walked — and so the reason a user gets told is the *first* one that applied
 * rather than whichever happened to be checked last.
 *
 * ## The crash loop
 *
 * If restoring the session is what crashes the browser, restoring it again next launch
 * means the user can never start — and the more tabs they had, the more certain it is
 * that they cannot get in to close the offending one. The guard is a counter written to
 * disk *before* the first restored page loads: `MAX_UNFINISHED_RESTORES` launches that
 * began a restore without the browser ever reporting itself up, and the next one starts
 * clean.
 *
 * Two consequences are worth stating plainly rather than discovering.
 *
 * The refusal **resets** the counter (`startedRun(document, false)`), so the guard cannot
 * lock a user out of restore permanently. It does not need to hold, because the clean
 * launch's own window records itself over the document within a second — the session that
 * crashed twice is then simply gone. That is deliberate: it costs a tab list, and the
 * alternative costs the browser. A tab list is retypable and a browser that will not
 * start is not.
 *
 * `session.restoreAfterCrash` is honoured *before* the cap, and it is the stricter of the
 * two: a user who turned it off is asking not to be given the previous session back after
 * any crash, not after two.
 */
export function planRestore(document: SessionDocument, settings: RestoreSettings): RestorePlan {
  if (!settings.wantsRestore) return { kind: 'skip', reason: 'not-requested' }
  if (document.pendingRestores >= MAX_UNFINISHED_RESTORES) {
    return { kind: 'skip', reason: 'restore-keeps-crashing' }
  }
  if (document.pendingRestores > 0 && !settings.afterCrash) {
    return { kind: 'skip', reason: 'previous-launch-crashed' }
  }

  const windows = document.windows
    .map((window) => planWindow(window, settings))
    .filter((window): window is PlannedWindow => window !== null)

  // A session of nothing but start pages reaches here as no windows at all, and that is
  // the same outcome as an empty file: the caller opens a window the ordinary way.
  if (windows.length === 0) return { kind: 'skip', reason: 'nothing-to-restore' }
  return { kind: 'restore', windows }
}

/**
 * One window, reconciled with the layout the settings actually give it.
 *
 * ## A saved layout with more tiles than the settings now allow
 *
 * With `splitView.restoreLayoutOnStart` off, the window comes up in
 * `splitView.defaultLayout` — which may be `1x1` while the file describes a `2x2` with
 * four tabs in it. Three things follow, and each is a separate mistake if it is missed:
 *
 *   - **Tabs in tiles that no longer exist come back unassigned**, not closed and not
 *     silently squeezed into a tile that does exist. `SplitController.assignTab` clamps
 *     an out-of-range index rather than refusing it, so "squeezed in" is exactly what
 *     happens if nobody reconciles: four tabs all claim tile 0 and the last one wins,
 *     while three sit loaded and unreachable. Spec 2 settled the principle — a tab that
 *     loses its place is detached, never closed.
 *   - **The saved divider positions are filtered to the dividers the new layout has**,
 *     with the rest of its defaults filled in. A `1x4` saved with three vertical
 *     dividers restored into `1x2` keeps the one they share and forgets the others.
 *   - **The active tile is re-chosen** rather than clamped blindly: a clamp can land on
 *     an empty tile, and then every toolbar button acts on nothing.
 *
 * Returns `null` for a window with nothing worth restoring, which the caller drops. An
 * empty window is not a lesser restore, it is a window the user has to close.
 */
function planWindow(window: SessionWindow, settings: RestoreSettings): PlannedWindow | null {
  const layout = settings.restoreLayout ? window.layout : settings.defaultLayout
  const tileCount = TILE_COUNT[layout]
  const taken = new Set<number>()

  const planned: PlannedTab[] = []
  for (const saved of window.tabs) {
    const url = restorableAddressOf(saved)
    if (url === null) continue
    const tileIndex = claimTile(saved.tileIndex, tileCount, taken)
    planned.push({
      id: saved.id,
      url,
      title: saved.title,
      pinned: saved.pinned,
      tileIndex,
      zoomPercent: saved.zoomPercent,
      load: loadTimingFor(tileIndex)
    })
  }

  if (planned.length === 0) return null
  const tabs = withFirstTileFilled(planned)

  return {
    layout,
    fractions: settings.restoreLayout
      ? keepKnownFractions(window.fractions, layout)
      : keepKnownFractions({}, layout),
    activeTile: activeTileFor(window.activeTile, tabs, tileCount),
    tabs
  }
}

/**
 * Guarantees the window shows something.
 *
 * Reachable in two ways, and neither is exotic: every tab in the file was unassigned —
 * which is what a window whose group was collapsed at quit looks like — or every tile it
 * did use has been taken away by a smaller layout. Either way the restored window would
 * come up blank, and a blank window is indistinguishable from a restore that failed.
 *
 * The first tab in strip order takes tile 0, which is also the one the user would reach
 * for. `slice(0, 1)` rather than an index read, so there is no "the tab I just counted is
 * missing" branch that no test can reach.
 */
function withFirstTileFilled(tabs: readonly PlannedTab[]): PlannedTab[] {
  if (tabs.some((tab) => tab.tileIndex !== null)) return [...tabs]
  return [
    ...tabs.slice(0, 1).map((tab) => ({ ...tab, tileIndex: 0, load: loadTimingFor(0) })),
    ...tabs.slice(1)
  ]
}

/**
 * The tile the window comes up focused on.
 *
 * The saved one when it still has a tab, because that is where the user was. Otherwise
 * the lowest tile that does — clamping alone would happily land on an empty tile, and the
 * toolbar, the address bar and every keyboard command then act on no tab at all, which
 * reads as a browser that has stopped responding.
 *
 * The fold starts at the last tile rather than at 0 so that `Math.min` finds the real
 * lowest instead of always answering 0, and it needs no "nothing occupied" case:
 * `withFirstTileFilled` has already guaranteed one, and a starting value inside the
 * layout is a safe answer even if it had not.
 */
function activeTileFor(saved: number, tabs: readonly PlannedTab[], tileCount: number): number {
  const clamped = clampTile(saved, tileCount)
  if (tabs.some((tab) => tab.tileIndex === clamped)) return clamped
  return tabs.reduce(
    (lowest, tab) => (tab.tileIndex === null ? lowest : Math.min(lowest, tab.tileIndex)),
    tileCount - 1
  )
}

/** One address, judged. See `restorableAddressOf` for the reasoning. */
function restorableAddress(url: string): string | null {
  if (url.length > MAX_SESSION_URL_LENGTH) return null
  // Covers `''` and `about:blank` as well as the start page itself, and covers them with
  // the same function the address bar uses, so "this is the home page" cannot mean two
  // different things in two places.
  if (isHomeUrl(url)) return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!RESTORABLE_SCHEMES.includes(parsed.protocol)) return null
  return url
}
