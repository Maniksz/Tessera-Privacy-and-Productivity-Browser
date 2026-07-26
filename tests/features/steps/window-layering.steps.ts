import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { anchorSurface, type Rect, type Size } from '@shared/ui/anchor.js'
import { overlayRegionRect, regionOf } from '@shared/overlay/surface.js'
import { dropZonesFor, zoneAt, type DropZone } from '@shared/split/dropzones.js'
import { isLayoutId } from '@shared/split/layout.js'
import { scope } from './world.js'

/**
 * Steps for `window-layering.feature`.
 *
 * Driven through the placement and region functions directly. The behaviour the feature
 * describes is a geometric decision — where a surface goes and how much of the window it
 * claims — and none of it needs a running window. That the decision is *applied* to a real
 * view above the tab views is what the smoke test checks, by opening the menu in the built
 * app and asserting it renders on the overlay target.
 */

function viewportOf(state: unknown): Size {
  const viewport = scope(state).viewport
  if (viewport === null) throw new Error('this scenario has no window; add the Background Given')
  return viewport
}

function anchorOf(state: unknown): Rect {
  const anchor = scope(state).anchorRect
  if (anchor === null) throw new Error('this scenario has no button; add a Given for it')
  return anchor
}

function placedIn(state: unknown): Rect {
  const placed = scope(state).anchoredSurface
  if (placed === null) throw new Error('nothing has been anchored yet; add a When for it')
  return placed.rect
}

Given(
  'a window {int} by {int} with an {int} pixel chrome inset',
  (state: unknown, width: number, height: number, inset: number) => {
    const current = scope(state)
    current.viewport = { width, height }
    current.chromeInset = inset
  }
)

Given(
  'a toolbar button {int} by {int} at {int}, {int}',
  (state: unknown, width: number, height: number, x: number, y: number) => {
    scope(state).anchorRect = { x, y, width, height }
  }
)

When(
  'a menu {int} by {int} is anchored to that button',
  (state: unknown, width: number, height: number) => {
    const current = scope(state)
    current.scratch['requestedHeight'] = height
    current.anchoredSurface = anchorSurface(
      anchorOf(state),
      { width, height },
      viewportOf(state)
    )
  }
)

Then('the menu opens below the button', (state: unknown) => {
  expect(scope(state).anchoredSurface?.placement).toBe('below')
})

Then('the menu opens above the button', (state: unknown) => {
  expect(scope(state).anchoredSurface?.placement).toBe('above')
})

Then('the menu lies entirely inside the window', (state: unknown) => {
  const rect = placedIn(state)
  const viewport = viewportOf(state)
  expect(rect.x, 'left edge').toBeGreaterThanOrEqual(0)
  expect(rect.y, 'top edge').toBeGreaterThanOrEqual(0)
  expect(rect.x + rect.width, 'right edge').toBeLessThanOrEqual(viewport.width)
  expect(rect.y + rect.height, 'bottom edge').toBeLessThanOrEqual(viewport.height)
})

Then('the menu reaches past the chrome inset', (state: unknown) => {
  // The point of the whole feature: a toolbar menu unavoidably extends into the region the
  // tab views occupy. That is fine — as long as it is drawn on the layer above them.
  const rect = placedIn(state)
  expect(rect.y + rect.height).toBeGreaterThan(scope(state).chromeInset)
})

Then("the menu's right edge meets the button's right edge", (state: unknown) => {
  const rect = placedIn(state)
  const anchor = anchorOf(state)
  expect(rect.x + rect.width).toBe(anchor.x + anchor.width)
})

Then('the menu is shorter than it asked to be', (state: unknown) => {
  const requested = scope(state).scratch['requestedHeight']
  expect(typeof requested).toBe('number')
  expect(placedIn(state).height).toBeLessThan(requested as number)
})

Then('the layout menu takes the whole window while it is up', (state: unknown) => {
  const viewport = viewportOf(state)
  const contentRect: Rect = {
    x: 0,
    y: scope(state).chromeInset,
    width: viewport.width,
    height: viewport.height - scope(state).chromeInset
  }

  // A click anywhere outside a menu has to dismiss it, and the only surface left to
  // notice that click is the overlay layer itself.
  expect(regionOf('layout-menu')).toBe('window')
  expect(overlayRegionRect('window', viewport, contentRect)).toEqual({
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height
  })
})

// --- dragging a tab into a tile ---------------------------------------------

function contentAreaOf(state: unknown): Rect {
  const viewport = viewportOf(state)
  const inset = scope(state).chromeInset
  return { x: 0, y: inset, width: viewport.width, height: viewport.height - inset }
}

function zonesOf(state: unknown): DropZone[] {
  const zones = scope(state).dropZones
  if (zones === null) throw new Error('no drag is in progress; add a When for it')
  return zones
}

When('a tab is dragged in the {string} layout', (state: unknown, layout: string) => {
  if (!isLayoutId(layout)) throw new Error(`not a layout: ${layout}`)
  scope(state).dropZones = dropZonesFor(layout, contentAreaOf(state))
})

When('the pointer is at {int}, {int}', (state: unknown, x: number, y: number) => {
  scope(state).dropTarget = zoneAt(zonesOf(state), { x, y }, contentAreaOf(state))
})

When(
  'the pointer is {int} pixels inside the left edge of the tile area',
  (state: unknown, offset: number) => {
    const content = contentAreaOf(state)
    scope(state).dropTarget = zoneAt(
      zonesOf(state),
      { x: content.x + offset, y: content.y + content.height / 2 },
      content
    )
  }
)

When('the pointer is in the tab strip', (state: unknown) => {
  // Above the tile area: a live drag with no tile targeted, which the indicator shows as no
  // highlight while the strip shows the reorder preview instead.
  scope(state).dropTarget = zoneAt(zonesOf(state), { x: 600, y: 8 }, contentAreaOf(state))
})

Then('the drop targets are {string}', (state: unknown, expected: string) => {
  const kinds = zonesOf(state).map((zone) => zone.kind)
  expect(kinds.join(', ')).toBe(expected)
})

Then('the drop target is {string}', (state: unknown, expected: string) => {
  expect(scope(state).dropTarget?.kind).toBe(expected)
})

Then('there is a drop target', (state: unknown) => {
  expect(scope(state).dropTarget, 'no zone was selected').not.toBeNull()
})

Then('there is no drop target', (state: unknown) => {
  expect(scope(state).dropTarget).toBeNull()
})

Then('every drop target previews a rectangle inside the tile area', (state: unknown) => {
  const content = contentAreaOf(state)
  for (const zone of zonesOf(state)) {
    expect(zone.preview.x, zone.id).toBeGreaterThanOrEqual(content.x)
    expect(zone.preview.y, zone.id).toBeGreaterThanOrEqual(content.y)
    expect(zone.preview.x + zone.preview.width, zone.id).toBeLessThanOrEqual(content.x + content.width)
    expect(zone.preview.y + zone.preview.height, zone.id).toBeLessThanOrEqual(content.y + content.height)
  }
})

Then('the promised rectangle is larger than the region hovered', (state: unknown) => {
  // A narrow target promising a large, accurate result is the point of an edge zone.
  const target = scope(state).dropTarget
  expect(target, 'no zone was selected').not.toBeNull()
  expect(target!.preview.width).toBeGreaterThan(target!.hit.width)
})

Then('a content region leaves the chrome inset untouched', (state: unknown) => {
  const viewport = viewportOf(state)
  const inset = scope(state).chromeInset
  const contentRect: Rect = {
    x: 0,
    y: inset,
    width: viewport.width,
    height: viewport.height - inset
  }

  // What a drag indicator needs: the tab strip must keep receiving the drag it started.
  const rect = overlayRegionRect('content', viewport, contentRect)
  expect(rect.y).toBe(inset)
  expect(rect.y).toBeGreaterThan(0)
})

Then('a drop target leads to the {string} layout', (state: unknown, layout: string) => {
  // The gap this closes: edge zones used to exist only in a single-tile layout, so a drag
  // could produce two tiles and never three or four.
  expect(zonesOf(state).map((zone) => zone.layout)).toContain(layout)
})
