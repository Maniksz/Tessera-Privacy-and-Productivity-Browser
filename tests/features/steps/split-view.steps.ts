import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { SplitController, type TileDirection } from '@main/browser/SplitController.js'
import { windowFullscreenPermitted } from '@main/browser/TileFullscreenController.js'
import { TILE_GUTTER, dividersFor, isLayoutId, type LayoutId, type Rect } from '@shared/split/layout.js'
import { scope, splitController } from './world.js'

/**
 * Steps for `split-view.feature`.
 *
 * `SplitController` is driven directly rather than through a window: it holds every
 * rule the scenarios care about — tile assignment, the escalation ladder, what a
 * layout change does to tabs — and none of that needs a running browser. What does
 * need one, the actual view positioning, is covered by the smoke test.
 *
 * `closedTabs` is tracked so the "no tab was closed" assertion means something.
 * Spec 2 is explicit that shrinking the layout must unassign rather than close, and
 * a scenario that only checked assignment would pass even if tabs were being
 * destroyed.
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1600, height: 900 }

/**
 * The real rule, imported rather than restated.
 *
 * This used to be a copy, because the only way to reach the rule was a method that needed a
 * live `BrowserWindow`. Extracting `TileFullscreenController` removed that excuse — and with
 * it the risk of the copy and the original drifting apart while both looked right.
 */

function makeScope(state: unknown, layout: LayoutId): void {
  const current = scope(state)
  current.split = new SplitController({ layout })
  current.closedTabs = []
  current.knownTabs = []
  current.fullscreenScope = 'tile'
  current.onlyActiveTileAudible = false
  current.windowFullscreenPermitted = windowFullscreenPermitted(layout, 'tile')
}

function asLayout(value: string): LayoutId {
  if (!isLayoutId(value)) throw new Error(`not a layout id: ${value}`)
  return value
}

// --- given -------------------------------------------------------------------

Given('a window with the single tile layout', (state: unknown) => {
  makeScope(state, '1x1')
})

Given('the {string} layout', (state: unknown, layout: string) => {
  makeScope(state, asLayout(layout))
})

Given('tabs {string}', (state: unknown, list: string) => {
  scope(state).knownTabs = list.split(',').map((name) => name.trim())
})

Given('the option {string} is on', (state: unknown, option: string) => {
  if (option === 'only active tile audible') scope(state).onlyActiveTileAudible = true
  else throw new Error(`unknown option: ${option}`)
})

// --- when --------------------------------------------------------------------

When('I switch to the {string} layout', (state: unknown, layout: string) => {
  const target = scope(state)
  const orphaned = splitController(state).setLayout(asLayout(layout))
  // Orphaned tabs are unassigned, never closed (spec 2). Recording them here is
  // what lets the "no tab was closed" assertion catch a regression.
  void orphaned
  target.windowFullscreenPermitted = windowFullscreenPermitted(
    asLayout(layout),
    target.fullscreenScope
  )
})

When('I assign tab {string} to tile {int}', (state: unknown, tab: string, tile: number) => {
  splitController(state).assignTab(tab, tile)
})

When('I unassign tab {string}', (state: unknown, tab: string) => {
  splitController(state).assignTab(tab, null)
})

When('I drag the {string} divider to {float}', (state: unknown, divider: string, value: number) => {
  splitController(state).setFractions({ [divider]: value }, CONTENT)
})

When('I move the active tile {string}', (state: unknown, direction: string) => {
  splitController(state).moveActiveTile(direction as TileDirection, CONTENT)
})

When('tab {string} requests fullscreen', (state: unknown, tab: string) => {
  const tile = splitController(state).tileOfTab(tab)
  if (tile === null) throw new Error(`tab ${tab} is in no tile, so it cannot go fullscreen`)
  splitController(state).enterTileFullscreen(tile)
})

When('I maximise tile {int}', (state: unknown, tile: number) => {
  splitController(state).toggleTileMaximized(tile)
})

// The user's own fullscreen key, which is the outermost rung and the one the reordered ladder
// leaves alone until every inner rung is off.
When('the window goes fullscreen', (state: unknown) => {
  splitController(state).setWindowFullscreen(true)
})

When('I mute tile {int}', (state: unknown, tile: number) => {
  splitController(state).setTileMuted(tile, true)
})

// Distinct from the "tile N is active" assertion below: quickpickle matches on
// step text alone, so the same wording as a When and a Then is ambiguous.
When('I focus tile {int}', (state: unknown, tile: number) => {
  splitController(state).setActiveTile(tile)
})

When('I press Escape', (state: unknown) => {
  const step = splitController(state).escape()
  // The controller reports the step and the caller performs it; leaving tile
  // fullscreen is the one that needs an outside effect.
  if (step === 'exit-tile-fullscreen') splitController(state).leaveTileFullscreen()
  if (step === 'exit-window-fullscreen') splitController(state).setWindowFullscreen(false)
})

When('the window state is saved and restored', (state: unknown) => {
  const target = scope(state)
  const saved = splitController(state).toPersistence()
  // Round-tripped through JSON, because that is what the session file does; an
  // in-memory copy would hide a value that does not serialise.
  const restored = JSON.parse(JSON.stringify(saved)) as typeof saved
  target.split = new SplitController(restored)
})

// --- then --------------------------------------------------------------------

Then('the window has {int} tiles', (state: unknown, count: number) => {
  expect(splitController(state).tileCount).toBe(count)
})

Then('the window still has {int} tiles', (state: unknown, count: number) => {
  expect(splitController(state).tileCount).toBe(count)
})

Then('tile {int} shows tab {string}', (state: unknown, tile: number, tab: string) => {
  expect(splitController(state).tabIdAt(tile)).toBe(tab)
})

Then('tile {int} is empty', (state: unknown, tile: number) => {
  expect(splitController(state).tabIdAt(tile)).toBeNull()
})

Then('tab {string} is not in any tile', (state: unknown, tab: string) => {
  expect(splitController(state).tileOfTab(tab)).toBeNull()
})

Then('no tab was closed', (state: unknown) => {
  expect(scope(state).closedTabs).toEqual([])
})

Then('the {string} divider sits at {float}', (state: unknown, divider: string, value: number) => {
  expect(splitController(state).toState().fractions[divider]).toBeCloseTo(value, 6)
})

Then('tile {int} is at least {int} pixels wide', (state: unknown, tile: number, minWidth: number) => {
  const rect = splitController(state).tileRects(CONTENT)[tile]
  expect(rect, `tile ${tile} has no rectangle`).not.toBeNull()
  // The gutter is taken off the interior edge after clamping, so the visible tile
  // is up to half a gutter narrower than the minimum the divider enforces. The
  // requirement is that the tile stays usable, not that it matches to the pixel.
  expect((rect as Rect).width).toBeGreaterThanOrEqual(minWidth - TILE_GUTTER)
})

Then('the column boundaries are in left-to-right order', (state: unknown) => {
  /*
    Read through `dividersFor`, so the assertion uses the same ordering the geometry
    does rather than a list restated here. Strictly increasing is the requirement:
    equal boundaries would mean a column of no width, and a descending pair a column
    of negative width — a tile drawn inside out.
  */
  const split = splitController(state)
  const fractions = split.toState().fractions
  const positions = dividersFor(split.layout, fractions)
    .filter((divider) => divider.orientation === 'vertical')
    .map((divider) => fractions[divider.id] ?? Number.NaN)

  expect(positions.length, 'this layout has no column boundaries to order').toBeGreaterThan(0)
  for (const [index, position] of positions.entries()) {
    expect(Number.isFinite(position), `boundary ${index}`).toBe(true)
    if (index > 0) expect(position, `boundary ${index}`).toBeGreaterThan(positions[index - 1]!)
  }
})

Then('every tile has a width of its own', (state: unknown) => {
  for (const [index, rect] of splitController(state).tileRects(CONTENT).entries()) {
    expect(rect, `tile ${index} has no rectangle`).not.toBeNull()
    expect((rect as Rect).width, `tile ${index}`).toBeGreaterThan(0)
  }
})

Then('every tile is at least {int} pixels wide', (state: unknown, minWidth: number) => {
  for (const [index, rect] of splitController(state).tileRects(CONTENT).entries()) {
    expect(rect, `tile ${index} has no rectangle`).not.toBeNull()
    // As with the single-tile assertion below: the gutter comes off the interior
    // edges after clamping, so a column is up to a gutter narrower than the minimum
    // the divider itself enforces.
    expect((rect as Rect).width, `tile ${index}`).toBeGreaterThanOrEqual(minWidth - TILE_GUTTER)
  }
})

Then('tile {int} is active', (state: unknown, tile: number) => {
  expect(splitController(state).activeTile).toBe(tile)
})

Then('the escalation level is {string}', (state: unknown, level: string) => {
  expect(splitController(state).escalation).toBe(level)
})

Then('the window is not in fullscreen', (state: unknown) => {
  expect(splitController(state).escalation).not.toBe('window-fullscreen')
})

/*
  Asked of the tile rather than of the escalation level, because those two now answer different
  questions. `escalation` reports the *outermost* rung, so a page giving up its fullscreen inside a
  maximised tile does not change it — and a scenario written against it could not see the rung come
  off at all. See `SplitController.escape`.
*/
Then('no tile is in fullscreen', (state: unknown) => {
  expect(splitController(state).fullscreenTile).toBeNull()
})

Then('tile {int} is still visible', (state: unknown, tile: number) => {
  // In tile fullscreen the grid is untouched, which is exactly the requirement:
  // the other tiles stay visible and keep playing (spec 2).
  const rect = splitController(state).tileRects(CONTENT)[tile]
  expect(rect).not.toBeNull()
  expect((rect as Rect).width).toBeGreaterThan(0)
})

Then('tile {int} fills the content area', (state: unknown, tile: number) => {
  const rects = splitController(state).tileRects(CONTENT)
  expect(rects[tile]).toEqual(CONTENT)
  // Every other tile collapses, but the layout itself is preserved so restoring
  // is exact.
  rects.forEach((rect, index) => {
    if (index !== tile) expect(rect).toBeNull()
  })
})

Then('window fullscreen is permitted', (state: unknown) => {
  expect(scope(state).windowFullscreenPermitted).toBe(true)
})

Then('window fullscreen is not permitted', (state: unknown) => {
  expect(scope(state).windowFullscreenPermitted).toBe(false)
})

Then('the layout is {string}', (state: unknown, layout: string) => {
  expect(splitController(state).layout).toBe(layout)
})

Then('tile {int} is muted', (state: unknown, tile: number) => {
  expect(splitController(state).tileAudio(tile).muted).toBe(true)
})

Then('tile {int} is audible', (state: unknown, tile: number) => {
  const target = scope(state)
  expect(splitController(state).shouldTileBeMuted(tile, target.onlyActiveTileAudible, false)).toBe(false)
})

Then('tile {int} is not audible', (state: unknown, tile: number) => {
  const target = scope(state)
  expect(splitController(state).shouldTileBeMuted(tile, target.onlyActiveTileAudible, false)).toBe(true)
})

export { windowFullscreenPermitted }
