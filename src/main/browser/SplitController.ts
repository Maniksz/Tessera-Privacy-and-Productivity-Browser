import type { EscalationLevel, SplitState, TileAudio } from '@shared/model.js'
import {
  clampFractions,
  computeTileRects,
  DEFAULT_FRACTIONS,
  TILE_COUNT,
  TILE_GUTTER,
  tileInDirection,
  type Fractions,
  type LayoutId,
  type Rect
} from '@shared/split/layout.js'

/**
 * Split-view state machine (spec 2).
 *
 * Owns which tab sits in which tile, where the dividers are, which tile is
 * active, and where the window sits on the escalation ladder. Geometry itself
 * comes from `@shared/split/layout`, so the divider handles the renderer draws
 * and the bounds the native views get are computed by the same code.
 */

export type TileDirection = 'left' | 'right' | 'up' | 'down'

export interface SplitSnapshotForPersistence {
  layout: LayoutId
  fractions: Record<string, number>
  activeTile: number
  tileAudio: TileAudio[]
}

export class SplitController {
  #layout: LayoutId
  #fractions: Record<string, number>
  #activeTile = 0
  /** Tab id per tile index; `null` for an empty tile. */
  #tileTabIds: Array<string | null>
  #tileAudio: TileAudio[]
  #maximizedTile: number | null = null
  #fullscreenTile: number | null = null
  #windowFullscreen = false

  constructor(initial?: Partial<SplitSnapshotForPersistence>) {
    this.#layout = initial?.layout ?? '1x1'
    this.#fractions = { ...DEFAULT_FRACTIONS[this.#layout], ...(initial?.fractions ?? {}) }
    this.#tileTabIds = new Array<string | null>(TILE_COUNT[this.#layout]).fill(null)
    this.#tileAudio = makeAudio(TILE_COUNT[this.#layout], initial?.tileAudio)
    this.#activeTile = clampIndex(initial?.activeTile ?? 0, TILE_COUNT[this.#layout])
  }

  get layout(): LayoutId {
    return this.#layout
  }

  get tileCount(): number {
    return TILE_COUNT[this.#layout]
  }

  get activeTile(): number {
    return this.#activeTile
  }

  get maximizedTile(): number | null {
    return this.#maximizedTile
  }

  get fullscreenTile(): number | null {
    return this.#fullscreenTile
  }

  /** True while a website's fullscreen must stay inside its own tile. */
  get isTileScopedFullscreen(): boolean {
    return this.#fullscreenTile !== null && this.#layout !== '1x1'
  }

  // --- layout --------------------------------------------------------------

  /**
   * Switches layout.
   *
   * Shrinking the grid does **not** close the tabs that lose their tile
   * (spec 2): they are unassigned and stay loaded, so switching back restores
   * them and a mis-click never costs a video's playback position.
   */
  setLayout(layout: LayoutId): string[] {
    if (layout === this.#layout) return []

    const previous = this.#tileTabIds
    const count = TILE_COUNT[layout]

    this.#layout = layout
    this.#fractions = { ...DEFAULT_FRACTIONS[layout], ...pickKnown(this.#fractions, layout) }
    this.#tileTabIds = Array.from({ length: count }, (_, index) => previous[index] ?? null)
    this.#tileAudio = makeAudio(count, this.#tileAudio)
    this.#activeTile = clampIndex(this.#activeTile, count)

    // Maximising and tile fullscreen do not survive a layout change: both refer
    // to a specific tile that may no longer exist.
    this.#maximizedTile = null
    this.#fullscreenTile = null

    // Tabs beyond the new tile count, for the caller to unassign.
    return previous.slice(count).filter((id): id is string => id !== null)
  }

  setFractions(next: Fractions, content: { width: number; height: number }): void {
    this.#fractions = { ...clampFractions(this.#layout, { ...this.#fractions, ...next }, content) }
  }

  resetFractions(): void {
    this.#fractions = { ...DEFAULT_FRACTIONS[this.#layout] }
  }

  // --- active tile ---------------------------------------------------------

  setActiveTile(index: number): void {
    this.#activeTile = clampIndex(index, this.tileCount)
  }

  /** Arrow-key tile navigation, resolved geometrically (see `tileInDirection`). */
  moveActiveTile(direction: TileDirection, content: Rect): boolean {
    const rects = computeTileRects(this.#layout, this.#fractions, content)
    const next = tileInDirection(rects, this.#activeTile, direction)
    if (next === null) return false
    this.#activeTile = next
    return true
  }

  // --- tab assignment ------------------------------------------------------

  tabIdAt(tileIndex: number): string | null {
    return this.#tileTabIds[tileIndex] ?? null
  }

  activeTabId(): string | null {
    return this.tabIdAt(this.#activeTile)
  }

  tileOfTab(tabId: string): number | null {
    const index = this.#tileTabIds.indexOf(tabId)
    return index === -1 ? null : index
  }

  /**
   * Puts a tab in a tile, or removes it from the grid when `tileIndex` is null.
   * A tab already shown elsewhere is moved, not duplicated — one tab cannot be
   * in two tiles.
   */
  assignTab(tabId: string, tileIndex: number | null): void {
    const existing = this.tileOfTab(tabId)
    if (existing !== null) this.#tileTabIds[existing] = null
    if (tileIndex === null) return

    const index = clampIndex(tileIndex, this.tileCount)
    this.#tileTabIds[index] = tabId
  }

  /** Drops a closed tab out of the grid. */
  forgetTab(tabId: string): void {
    const index = this.tileOfTab(tabId)
    if (index !== null) this.#tileTabIds[index] = null
  }

  /** First tile with no tab, or null when the grid is full. */
  firstEmptyTile(): number | null {
    const index = this.#tileTabIds.findIndex((id) => id === null)
    return index === -1 ? null : index
  }

  // --- audio ---------------------------------------------------------------

  tileAudio(index: number): TileAudio {
    return this.#tileAudio[index] ?? { muted: false, volume: 1 }
  }

  setTileMuted(index: number, muted: boolean): void {
    const audio = this.#tileAudio[index]
    if (audio) audio.muted = muted
  }

  /**
   * Resolves "only the active tile is audible" and "mute all but active" into a
   * concrete mute decision per tile, so the caller applies one rule rather than
   * three overlapping ones.
   */
  shouldTileBeMuted(index: number, onlyActiveAudible: boolean, muteAllButActive: boolean): boolean {
    if (this.tileAudio(index).muted) return true
    if (onlyActiveAudible || muteAllButActive) return index !== this.#activeTile
    return false
  }

  // --- escalation ladder ---------------------------------------------------
  /*
    Climbing up: tile fullscreen -> tile maximised -> window fullscreen (spec 2). Each rung
    encloses the one before it, so a page's fullscreen inside a tile is the innermost and the
    window's own fullscreen is the outermost.

    Two questions get asked of that ladder, and they are answered from opposite ends on purpose:
    `escalation` reads it from the top, `escape()` from the bottom. Both say why below, because a
    reader finding the two orders side by side will otherwise assume one of them is a mistake.
  */

  enterTileFullscreen(tileIndex: number): void {
    this.#fullscreenTile = clampIndex(tileIndex, this.tileCount)
  }

  leaveTileFullscreen(): void {
    this.#fullscreenTile = null
  }

  /**
   * Grows one tile to the whole window without discarding the layout — the
   * commoner wish when watching several streams than a website's own fullscreen
   * (spec 2).
   */
  toggleTileMaximized(tileIndex?: number): void {
    const target = clampIndex(tileIndex ?? this.#activeTile, this.tileCount)
    this.#maximizedTile = this.#maximizedTile === target ? null : target
    if (this.#maximizedTile !== null) this.#activeTile = target
  }

  setWindowFullscreen(fullscreen: boolean): void {
    this.#windowFullscreen = fullscreen
  }

  /** Whether the window itself is fullscreen, separate from anything a tile is doing. */
  get isWindowFullscreen(): boolean {
    return this.#windowFullscreen
  }

  /**
   * How escalated the window is: the **outermost** rung it is standing on.
   *
   * Read from the top, and deliberately not in the same order as `escape()` below. The question
   * this answers is "how much of the window has been given to content", which is a different
   * question from "what comes off next". `BrowserWindowController.#contentRect` uses it to decide
   * the chrome is hidden, and `pageKeyAction` uses it to tell that the window is in fullscreen — a
   * window that is fullscreen *and* has a fullscreen video in one of its tiles has hidden its
   * chrome, and reporting the tile instead would put the toolbar back over a fullscreen window.
   *
   * The consequence is worth stating, because it is the thing that looks like a bug and is not: one
   * `escape()` need not change this value. Leaving a page's fullscreen inside a maximised tile is a
   * real rung, and this still reports `tile-maximized` afterwards, because the window is still
   * giving all of its content area to one tile.
   */
  get escalation(): EscalationLevel {
    if (this.#windowFullscreen) return 'window-fullscreen'
    if (this.#maximizedTile !== null) return 'tile-maximized'
    if (this.#fullscreenTile !== null) return 'tile-fullscreen'
    return 'none'
  }

  /**
   * One rung back down the ladder, from the **inside** out. Returns the step that was taken so the
   * caller can carry out the side effect it owns — leaving a page's fullscreen needs the tab,
   * leaving window fullscreen needs the window.
   *
   * ## Why the innermost rung comes off first
   *
   * This used to read `#windowFullscreen` first. The docblock over `TileFullscreenController.escape`
   * has described the opposite order all along — **the comment was right and the code was wrong** —
   * and the report that found it says what that cost: "wenn f11 gedrückt und ich mache ein video
   * klein, schließt sich f11". Press F11, then make a fullscreen video small again, and the window
   * drops out of fullscreen too.
   *
   * Making a video small **is** an `Escape` press, and that press reaches this browser through
   * `Tab`'s `before-input-event` at the same moment it reaches the page. The page's own handling
   * takes the video out of fullscreen; taking the *outermost* rung alongside it spends a press the
   * user has already spent on something else, and they see only the second effect. Read from the
   * inside out, the rung this press consumes is the one the page has just given up, so the two
   * agree instead of stacking and the window's fullscreen is still there for the next press.
   *
   * The same reasoning applies one rung down and is why `restore-tile` did not simply move to the
   * front: a fullscreen video inside a maximised tile must give up the video first, or one press
   * un-maximises the tile *and* shrinks the video.
   *
   * `escalation` above reads from the other end. That is not a disagreement; see there.
   */
  escape(): 'exit-tile-fullscreen' | 'restore-tile' | 'exit-window-fullscreen' | 'none' {
    if (this.#fullscreenTile !== null) return 'exit-tile-fullscreen'
    if (this.#maximizedTile !== null) {
      this.#maximizedTile = null
      return 'restore-tile'
    }
    if (this.#windowFullscreen) return 'exit-window-fullscreen'
    return 'none'
  }

  // --- geometry ------------------------------------------------------------

  /**
   * Where each tile's view goes.
   *
   * A maximised tile takes the whole content area and the others collapse — but
   * the layout and the divider positions are untouched, so restoring is exact.
   *
   * A tile in website fullscreen keeps its normal rectangle on purpose: spec 2
   * requires the other tiles to stay visible and keep playing. The page is told
   * it is fullscreen and fills the tile; the tile is the frame of reference.
   */
  tileRects(content: Rect): Array<Rect | null> {
    if (this.#maximizedTile !== null) {
      return Array.from({ length: this.tileCount }, (_, index) =>
        index === this.#maximizedTile ? content : null
      )
    }
    return computeTileRects(this.#layout, this.#fractions, content, { gutter: TILE_GUTTER })
  }

  toState(): SplitState {
    return {
      layout: this.#layout,
      fractions: { ...this.#fractions },
      activeTile: this.#activeTile,
      tileTabIds: [...this.#tileTabIds],
      tileAudio: this.#tileAudio.map((audio) => ({ ...audio })),
      maximizedTile: this.#maximizedTile,
      fullscreenTile: this.#fullscreenTile,
      escalation: this.escalation
    }
  }

  toPersistence(): SplitSnapshotForPersistence {
    return {
      layout: this.#layout,
      fractions: { ...this.#fractions },
      activeTile: this.#activeTile,
      tileAudio: this.#tileAudio.map((audio) => ({ ...audio }))
    }
  }
}

function clampIndex(value: number, count: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.trunc(value), 0), Math.max(0, count - 1))
}

function makeAudio(count: number, previous?: readonly TileAudio[]): TileAudio[] {
  return Array.from({ length: count }, (_, index) => {
    const existing = previous?.[index]
    return existing ? { ...existing } : { muted: false, volume: 1 }
  })
}

/** Keeps only the divider ids a layout actually has. */
function pickKnown(fractions: Record<string, number>, layout: LayoutId): Record<string, number> {
  const allowed = Object.keys(DEFAULT_FRACTIONS[layout])
  const out: Record<string, number> = {}
  for (const id of allowed) {
    const value = fractions[id]
    if (typeof value === 'number' && Number.isFinite(value)) out[id] = value
  }
  return out
}
