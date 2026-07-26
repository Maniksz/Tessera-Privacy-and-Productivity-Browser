import { describe, expect, it } from 'vitest'
import { anchorSurface } from '@shared/ui/anchor.js'

/**
 * Placement of anchored surfaces.
 *
 * Worth testing directly because the failures are position-dependent: a menu that is fine
 * on a maximised window slides off the edge on a narrow one, and nothing about the code
 * looks wrong when it does. A table of cases finds those in a second.
 */

const VIEWPORT = { width: 1200, height: 800 }
/** A toolbar button near the top right, which is where these actually open from. */
const TOOLBAR_BUTTON = { x: 1000, y: 60, width: 40, height: 32 }

describe('anchorSurface', () => {
  it('opens below the anchor when there is room', () => {
    const { rect, placement } = anchorSurface(TOOLBAR_BUTTON, { width: 220, height: 190 }, VIEWPORT)
    expect(placement).toBe('below')
    expect(rect.y).toBe(TOOLBAR_BUTTON.y + TOOLBAR_BUTTON.height + 6)
    expect(rect.height).toBe(190)
  })

  it('lines its right edge up with the anchor by default', () => {
    // A toolbar button sits near the right edge, so the surface has to grow inwards.
    const { rect } = anchorSurface(TOOLBAR_BUTTON, { width: 220, height: 190 }, VIEWPORT)
    expect(rect.x + rect.width).toBe(TOOLBAR_BUTTON.x + TOOLBAR_BUTTON.width)
  })

  it('lines its left edge up when asked', () => {
    const { rect } = anchorSurface({ x: 20, y: 60, width: 40, height: 32 }, { width: 220, height: 190 }, VIEWPORT, {
      align: 'start'
    })
    expect(rect.x).toBe(20)
  })

  it('flips above when there is no room below and more room above', () => {
    const nearBottom = { x: 1000, y: 700, width: 40, height: 32 }
    const { rect, placement } = anchorSurface(nearBottom, { width: 220, height: 190 }, VIEWPORT)
    expect(placement).toBe('above')
    expect(rect.y + rect.height).toBe(nearBottom.y - 6)
  })

  it('stays below when above would be even tighter', () => {
    // Flipping to a side with less room moves the surface without revealing more of it.
    const nearTop = { x: 1000, y: 10, width: 40, height: 32 }
    const { placement } = anchorSurface(nearTop, { width: 220, height: 2000 }, VIEWPORT)
    expect(placement).toBe('below')
  })

  it('clamps to the left margin rather than overhanging the edge', () => {
    const nearLeft = { x: 4, y: 60, width: 40, height: 32 }
    const { rect } = anchorSurface(nearLeft, { width: 220, height: 190 }, VIEWPORT)
    expect(rect.x).toBe(8)
  })

  it('clamps to the right margin rather than overhanging the edge', () => {
    const atRightEdge = { x: 1190, y: 60, width: 40, height: 32 }
    const { rect } = anchorSurface(atRightEdge, { width: 220, height: 190 }, VIEWPORT)
    expect(rect.x + rect.width).toBeLessThanOrEqual(VIEWPORT.width - 8)
  })

  it('narrows a surface wider than the window', () => {
    const { rect } = anchorSurface(TOOLBAR_BUTTON, { width: 4000, height: 190 }, VIEWPORT)
    expect(rect.width).toBe(VIEWPORT.width - 16)
    expect(rect.x).toBe(8)
  })

  it('caps the height at the room available, so the surface can scroll instead', () => {
    const { rect } = anchorSurface(TOOLBAR_BUTTON, { width: 220, height: 5000 }, VIEWPORT)
    expect(rect.y + rect.height).toBeLessThanOrEqual(VIEWPORT.height - 8)
    expect(rect.height).toBeGreaterThan(0)
  })

  it('never returns a rect outside the viewport, whatever it is handed', () => {
    // The caller should not have to sanity-check the result, so this covers the awkward
    // combinations in one sweep rather than one case at a time.
    for (const x of [-50, 0, 600, 1199, 1400]) {
      for (const y of [-20, 0, 400, 799, 900]) {
        for (const size of [
          { width: 220, height: 190 },
          { width: 1, height: 1 },
          { width: 3000, height: 3000 }
        ]) {
          const { rect } = anchorSurface({ x, y, width: 40, height: 32 }, size, VIEWPORT)
          const where = `anchor(${x},${y}) surface(${size.width}x${size.height})`
          expect(rect.x, `${where} x`).toBeGreaterThanOrEqual(0)
          expect(rect.y, `${where} y`).toBeGreaterThanOrEqual(0)
          expect(rect.x + rect.width, `${where} right`).toBeLessThanOrEqual(VIEWPORT.width)
          expect(rect.y + rect.height, `${where} bottom`).toBeLessThanOrEqual(VIEWPORT.height)
        }
      }
    }
  })

  it('honours a custom gap and margin', () => {
    const { rect } = anchorSurface(TOOLBAR_BUTTON, { width: 220, height: 190 }, VIEWPORT, {
      gap: 0,
      margin: 0
    })
    expect(rect.y).toBe(TOOLBAR_BUTTON.y + TOOLBAR_BUTTON.height)
  })

  it('returns whole pixels', () => {
    const { rect } = anchorSurface(
      { x: 100.4, y: 60.7, width: 40.2, height: 32.9 },
      { width: 220.5, height: 190.3 },
      VIEWPORT
    )
    for (const value of Object.values(rect)) {
      expect(Number.isInteger(value)).toBe(true)
    }
  })
})
