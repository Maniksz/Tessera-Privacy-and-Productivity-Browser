import { DEFAULT_FRACTIONS, TILE_COUNT, type LayoutId } from '../split/layout.js'
import { clampZoomPercent } from '../zoom/model.js'

/**
 * A saved browsing session: which tabs were open, in which windows, in which tiles.
 *
 * ## Why this file has no zod import
 *
 * The same rule the tab groups and the history follow. A renderer imports from `shared`,
 * and co-locating validation schemas with pure helpers dragged the whole validation
 * library into the UI bundle once already — about half a megabyte of startup parse work.
 * The persistence schema therefore lives with the store in the main process
 * (`src/main/data/SessionStore.ts`), next to the typed assignments that keep it from
 * drifting from these interfaces. See
 * `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`.
 *
 * ## What a session is, and what it is deliberately not
 *
 * It is the three facts about a tab that cannot be recovered from anywhere else: its
 * **address**, its **place in the strip** (array order), and its **tile, or none**. Plus
 * the window's layout and where its dividers sit.
 *
 * It is not a copy of the browser's state. No navigation history per tab, no scroll
 * position, no form contents — each of those would either need Chromium's own session
 * format or would be a plausible-looking half-restoration, and a back button that goes
 * somewhere unexpected is worse than one that is greyed out. No favicon either: the icon
 * cache already has it, keyed by site.
 *
 * **Zoom used to be in that list and stopped being on 29.07.2026.** The argument for
 * leaving it out was that zoom was per domain, which makes it a setting, and a setting has
 * no business in one window's slot. Per view it is window state — the same kind of fact as
 * which tile a tab sits in — so it belongs here, and it is the one thing above that a
 * restart would otherwise lose outright, because nothing else in this browser remembers it.
 * It is also not a half-restoration of anything: `zoomPercent` is a number this browser
 * chose and can apply exactly, not a fragment of Chromium's own session.
 *
 * ## Why the ids are stored, and why that is the point
 *
 * Every other document in this browser is keyed by something durable — an address, a
 * generated group id. This one stores `tab-7`, a value from a counter that restarts on
 * every launch. That looks like the mistake `retainTabs` warns about and is in fact the
 * fix for it: a stored tab group can only be reattached if the tabs come back under the
 * ids it names. `tab-ids.ts` holds the arithmetic that keeps a restored id from
 * colliding with a fresh one, which is the bug that trade risks.
 *
 * ## Why every operation is pure
 *
 * Which slot a window owns, what happens to a slot when its window closes, how a file
 * from an older build is healed — each exists once here rather than spread across a
 * store, a window and a shutdown hook. The store supplies identity and the filesystem.
 */

/**
 * Windows kept at most, oldest slot dropped first.
 *
 * Well past any believable arrangement, and it exists so a bug in a caller or a
 * hand-edited file cannot grow the document without bound rather than to stop anyone
 * doing anything.
 */
export const MAX_SESSION_WINDOWS = 20

/**
 * Tabs kept per window.
 *
 * Two hundred tabs in one window is already past the point where the strip is usable,
 * and the number bounds the file: with the address cap below, a full window is about
 * half a megabyte, and the store rewrites the whole document on every flush.
 */
export const MAX_SESSION_TABS_PER_WINDOW = 200

/** Titles are cut here, the same length the history uses. */
export const MAX_SESSION_TITLE_LENGTH = 200

/**
 * Addresses longer than this are not stored at all.
 *
 * Truncating is not an option — a cut URL is an address that no longer resolves, so the
 * tab would come back pointing at nothing. Dropping the address is the honest failure,
 * and it leaves the *tab* recoverable through its pending address if it has one.
 */
export const MAX_SESSION_URL_LENGTH = 2048

/**
 * Restores that began and never reported the browser as up, before restore is refused.
 *
 * The crash-loop guard, and the number matters in both directions. One is too strict: a
 * single crash is very often unrelated to the pages that were open, and a browser that
 * abandoned the session over one is a browser that loses it regularly. Three is too
 * lenient — it means three unusable launches in a row before anything changes.
 *
 * Two therefore: the first crash is forgiven, the second is a pattern, and the third
 * launch starts clean. See `planRestore`.
 */
export const MAX_UNFINISHED_RESTORES = 2

/** One tab, as the file holds it. */
export interface SessionTab {
  /** The id the tab had. See the module docblock and `tab-ids.ts`. */
  id: string
  /** The address that had committed, or empty for a tab that never committed one. */
  url: string
  /**
   * The address a navigation was in flight to, or `null`.
   *
   * Kept beside `url` rather than replacing it, because the two answer different
   * questions and a tab caught mid-navigation has both. Which one comes back is
   * `restorableAddressOf`'s decision, and the reasoning is there.
   */
  pendingUrl: string | null
  /** Empty until the page reported one. Shown so a restored strip is not a row of blanks. */
  title: string
  pinned: boolean
  /** The tile that showed this tab, or `null` for a tab that was loaded but not displayed. */
  tileIndex: number | null
  /**
   * The pane's own zoom, or `null` for a pane that was never zoomed.
   *
   * The sentinel is the field's whole point and is documented once, at `PaneZoom`: `null` means
   * "follows `appearance.defaultZoom`", which is a different statement from 100 % and is what lets
   * a change to that setting move the panes nobody touched. Written as `number | null` rather than
   * through the alias so this interface stays readable as the file's own shape — the zod mirror in
   * `SessionStore` is checked against it in both directions either way.
   */
  zoomPercent: number | null
}

/**
 * One window's slot.
 *
 * `id` is opaque and lives only as long as the run that allocated it: it exists to say
 * *which* slot a given open window owns, so a window recording its state replaces its
 * own entry instead of appending a second one on every navigation.
 */
export interface SessionWindow {
  id: string
  /**
   * False once the window has closed.
   *
   * A closed slot is normally removed outright. The exception — the last one — is what
   * makes quitting work at all: on Windows and Linux, closing the final window *is* how
   * most people quit, and that close arrives before `before-quit`. A rule that simply
   * removed the slot would therefore empty the document on the commonest exit path and
   * the next launch would restore nothing. So the last slot is kept and marked closed,
   * and a window opened later while every slot is closed drops them — see
   * `recordWindow`.
   */
  open: boolean
  layout: LayoutId
  /** Divider positions, by divider id. Only the ids this layout has; see `repairSession`. */
  fractions: Record<string, number>
  activeTile: number
  /** Strip order. The array *is* the order — there is no position field to disagree with it. */
  tabs: SessionTab[]
}

export interface SessionDocument {
  version: 1
  /** Restore order. Array order is the order the windows come back in. */
  windows: SessionWindow[]
  /**
   * Restores that began and have not reported success. See `MAX_UNFINISHED_RESTORES`.
   *
   * Written to disk *before* a restored page is allowed to load, which is the only
   * ordering that works: a counter incremented after the crash was never a counter.
   */
  pendingRestores: number
}

export function emptySessionDocument(): SessionDocument {
  return { version: 1, windows: [], pendingRestores: 0 }
}

// --- the write side a window is handed --------------------------------------

/**
 * A window's live state, in the shape the window already has it.
 *
 * Structural rather than a named conversion, so a window can pass the values from
 * `Tab.toState()` and `SplitController` straight in. `pendingInput` keeps the name it
 * has on `TabState` for the same reason — a rename at this boundary would be a place for
 * the two sides to disagree about which address is which.
 */
export interface CapturedTab {
  id: string
  url: string
  pendingInput: string | null
  title: string
  pinned: boolean
  tileIndex: number | null
  /** See `SessionTab.zoomPercent`. `TabState` carries the same field with the same sentinel. */
  zoomPercent: number | null
}

export interface CapturedWindow {
  layout: LayoutId
  fractions: Readonly<Record<string, number>>
  activeTile: number
  /** In strip order. */
  tabs: readonly CapturedTab[]
}

/**
 * The write side of the session, and the only one a caller ever gets handed.
 *
 * A private window is given `discardingSessionRecorder` instead of a recorder bound to
 * the store, so "a private window records nothing" is a property of what the window
 * holds rather than a check every call site has to remember. See
 * `SessionStore.recorderFor`.
 */
export interface SessionRecorder {
  /** Replaces this window's slot. Called whenever its tabs or its layout change. */
  record(window: CapturedWindow): void
  /** This window closed. */
  close(): void
}

/**
 * A recorder that keeps nothing, for private windows.
 *
 * It holds no reference to any store and allocates no slot, which is the point twice
 * over. Forgetting to check `privateMode` cannot leak an address, because there is
 * nothing here to leak it into — and because no slot is ever allocated, the *fact* that
 * a private window existed leaves no trace either. A recorder that wrote an empty slot
 * would satisfy "no addresses stored" and still put the count of private windows on
 * disk.
 */
export const discardingSessionRecorder: SessionRecorder = {
  record: (_window: CapturedWindow) => {},
  close: () => {}
}

// --- capture -----------------------------------------------------------------

/**
 * Turns a window's live state into the slot the file holds.
 *
 * Faithful on purpose: what is worth *restoring* is decided at restore time by
 * `planRestore`, not here. The settings that govern it can change between the two
 * moments, and a capture that had already dropped everything it thought uninteresting
 * would make that impossible — a user turning "restore my layout" back on would find
 * the layout gone from a file written while it was off.
 *
 * The two things applied here are the ones that bound the file rather than judge its
 * contents: the title length and the address length. Both are quantities, and both are
 * cheaper to enforce once at the source than to carry around.
 */
export function captureWindow(id: string, input: CapturedWindow): SessionWindow {
  return {
    id,
    open: true,
    layout: input.layout,
    fractions: { ...input.fractions },
    activeTile: input.activeTile,
    tabs: input.tabs.map((tab) => ({
      id: tab.id,
      url: storableAddress(tab.url),
      pendingUrl: tab.pendingInput === null ? null : storableAddress(tab.pendingInput),
      title: cleanSessionTitle(tab.title),
      pinned: tab.pinned,
      tileIndex: tab.tileIndex,
      zoomPercent: tab.zoomPercent
    }))
  }
}

// --- writes ------------------------------------------------------------------

/**
 * Replaces a window's slot, or adds it.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 *   - A **known slot is replaced in place**, so the restore order does not shuffle every
 *     time a page navigates.
 *   - A **new slot drops every closed one**. A window opening while all the stored slots
 *     are closed means the user came back to a browser with no windows and started
 *     again; the slot kept as "the session to come back to" is no longer that, and
 *     leaving it would restore a phantom window alongside the real one next launch.
 *     Closed slots kept *beside* open ones are left alone, because that combination
 *     cannot arise — see `forgetWindow`.
 *
 * The result goes through `repairSession`, so the invariants hold on the way in as well
 * as on the way out and there is one place that knows them.
 */
export function recordWindow(document: SessionDocument, window: SessionWindow): SessionDocument {
  const known = document.windows.some((existing) => existing.id === window.id)
  const windows = known
    ? document.windows.map((existing) => (existing.id === window.id ? window : existing))
    : [...document.windows.filter((existing) => existing.open), window]
  return repairSession({ ...document, windows })
}

/**
 * A window closed.
 *
 * Removed while another window is still open — the user shut that one deliberately and
 * would not expect it back. Kept, and marked closed, when it is the last: see the
 * comment on `SessionWindow.open` for why the commonest way of quitting depends on it.
 */
export function forgetWindow(document: SessionDocument, id: string): SessionDocument {
  const openElsewhere = document.windows.some((window) => window.open && window.id !== id)
  const windows = openElsewhere
    ? document.windows.filter((window) => window.id !== id)
    : document.windows.map((window) => (window.id === id ? { ...window, open: false } : window))
  return repairSession({ ...document, windows })
}

/**
 * Opens a fresh run: the previous run's slots are handed over and the attempt is counted.
 *
 * Clearing `windows` is not tidiness. The windows a restore opens get *new* slots, so a
 * document that kept the old ones would hold both and the launch after that would open
 * twice as many windows, then four times as many. This has to happen after the plan has
 * been read out and before the first window records anything, which is why
 * `SessionStore.beginRun` does both in one call rather than exposing two.
 *
 * `restoring: false` resets the counter to zero, which is what makes the crash-loop
 * guard self-clearing: a launch that did not restore cannot have been broken by the
 * session, so it must not hold the next one back.
 */
export function startedRun(document: SessionDocument, restoring: boolean): SessionDocument {
  return {
    version: 1,
    windows: [],
    pendingRestores: restoring ? document.pendingRestores + 1 : 0
  }
}

/** The browser stayed up long enough that the restore cannot be what breaks it. */
export function finishedRestore(document: SessionDocument): SessionDocument {
  return { ...document, pendingRestores: 0 }
}

// --- repair ------------------------------------------------------------------

/**
 * Makes a loaded document obey the invariants the write path maintains.
 *
 * Runs when the file is read, and heals rather than rejects — a file written by an older
 * build, edited by hand or cut short by a crash must not cost the user their session.
 * What it fixes, and why each is a repair and not a rejection:
 *
 *   - **A duplicate window id.** Two slots claiming one id are one slot as far as every
 *     lookup here is concerned; the later one goes rather than shadowing the earlier one
 *     in half the operations.
 *   - **A tab id claimed twice, anywhere in the document.** First claim wins. This is
 *     the most consequential repair in the file: two tabs answering to one id is the
 *     failure `tab-ids.ts` exists to prevent, and a document that carries it would
 *     reproduce it on every launch until someone deleted the file.
 *   - **A tile claimed twice in one window**, and **a tile the layout does not have.**
 *     Both become "no tile", so the tab comes back loaded but unassigned — spec 2's
 *     rule that a tab losing its place is detached, never closed.
 *   - **An `activeTile` outside the layout**, clamped, so the toolbar does not act on a
 *     tile that is not there.
 *   - **Fractions** for dividers this layout has no notion of, and values outside
 *     `(0, 1)`. A divider at 0 or 1 is a tile with no width.
 *   - **A zoom outside the range this browser applies**, clamped and never dropped. A
 *     hand-edited 5000 is a pane the user cannot read their way out of, and turning it into
 *     `null` would be the wrong repair twice over: "never zoomed" is a different statement
 *     from "zoomed further than the ladder goes", and the pane would silently start
 *     following a setting it was deliberately taken off.
 *   - **A window with no tabs**, dropped: there is nothing to draw, and a restore would
 *     open an empty window the user then has to close.
 *   - **An over-long title**, and **more windows or tabs than the caps.** All three are
 *     quantities, and a quantity must never reach the schema: validation failure
 *     replaces the whole document with defaults, so a `.max()` there would turn "grew
 *     larger than expected" into "lost the whole session".
 *
 * What stays strict is identity — the tab and window ids — and it stays in the schema.
 * A slot whose id is a number is not a document this browser wrote.
 */
export function repairSession(document: SessionDocument): SessionDocument {
  const claimedTabs = new Set<string>()
  const seenWindows = new Set<string>()
  const windows: SessionWindow[] = []

  for (const window of document.windows) {
    if (seenWindows.has(window.id)) continue

    const tileCount = TILE_COUNT[window.layout]
    const takenTiles = new Set<number>()
    const tabs: SessionTab[] = []

    for (const tab of window.tabs) {
      if (tabs.length >= MAX_SESSION_TABS_PER_WINDOW) break
      if (claimedTabs.has(tab.id)) continue
      claimedTabs.add(tab.id)
      tabs.push({
        ...tab,
        title: cleanSessionTitle(tab.title),
        tileIndex: claimTile(tab.tileIndex, tileCount, takenTiles),
        zoomPercent: healZoom(tab.zoomPercent)
      })
    }

    if (tabs.length === 0) continue
    seenWindows.add(window.id)
    windows.push({
      ...window,
      fractions: keepKnownFractions(window.fractions, window.layout),
      activeTile: clampTile(window.activeTile, tileCount),
      tabs
    })
  }

  // The newest slots survive a document that grew past the cap: the oldest are the ones
  // the user is least likely to be missing.
  return { ...document, windows: windows.slice(-MAX_SESSION_WINDOWS) }
}

// --- shared internals --------------------------------------------------------

/**
 * Takes a tile for a tab, or answers "no tile".
 *
 * Shared by the repair pass and the restore plan, because both are answering the same
 * question against a different tile count — the repair against the layout the file
 * names, the plan against the layout the settings end up choosing. Two copies would
 * agree until one of them learned about a case the other did not, and the symptom would
 * be two tabs in one tile: one visible, the other loaded and unreachable.
 *
 * `taken` is mutated, which is what makes "at most one tab per tile" hold across a whole
 * window rather than per call.
 */
export function claimTile(
  index: number | null,
  tileCount: number,
  taken: Set<number>
): number | null {
  if (index === null || index < 0 || index >= tileCount || taken.has(index)) return null
  taken.add(index)
  return index
}

/** Keeps an index inside `[0, tileCount - 1]`, treating anything non-numeric as the first tile. */
export function clampTile(index: number, tileCount: number): number {
  if (!Number.isFinite(index)) return 0
  return Math.min(Math.max(Math.trunc(index), 0), Math.max(0, tileCount - 1))
}

/**
 * Divider positions this layout actually has, with the rest of its defaults filled in.
 *
 * The filling matters as much as the filtering: switching from a two-column layout to a
 * grid adds a divider the file has no value for, and a missing fraction is not a
 * position of zero — it is a divider in the middle. Values outside `(0, 1)` go the same
 * way as an unknown id, because a fraction of 0, 1 or infinity is a tile with no size,
 * and `NaN` fails the comparison rather than needing a test of its own.
 */
export function keepKnownFractions(
  fractions: Readonly<Record<string, number>>,
  layout: LayoutId
): Record<string, number> {
  const kept: Record<string, number> = { ...DEFAULT_FRACTIONS[layout] }
  for (const id of Object.keys(kept)) {
    const value = fractions[id]
    if (value === undefined) continue
    if (!(value > 0 && value < 1)) continue
    kept[id] = value
  }
  return kept
}

/**
 * A stored zoom, held to the range a pane can actually be put at.
 *
 * `null` stays `null` — see the repair pass's own note on why that is not a value to heal *to*.
 * Only the write path reaches this with a value the browser did not choose, which is the point of
 * doing it in the repair rather than in `captureWindow`: the same call covers a file somebody
 * edited and a slot this run recorded.
 */
function healZoom(percent: number | null): number | null {
  return percent === null ? null : clampZoomPercent(percent)
}

/**
 * Titles arrive from pages, so they arrive with newlines and padding in them. The strip
 * shows a single line, so the whitespace is collapsed once here.
 */
function cleanSessionTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_SESSION_TITLE_LENGTH)
}

/** An address short enough to keep, or nothing. See `MAX_SESSION_URL_LENGTH`. */
function storableAddress(url: string): string {
  return url.length > MAX_SESSION_URL_LENGTH ? '' : url
}
