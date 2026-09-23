/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSwipeIndicator } from '../../src/preload/swipe-indicator.js'

/**
 * The arrow's lifetime in the page: there while a swipe is, and gone — from the DOM, not merely
 * hidden — once it is not. What it looks like is `swipeIndicatorOf`, tested in `wheel-swipe.test.ts`;
 * the shadow root is closed, so this file reads only the host, which is also all a page can see.
 */

const host = (): HTMLElement | null => document.getElementById('tessera-swipe')
const back = (progress: number, armed = false) => ({ side: 'left' as const, progress, armed })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  host()?.remove()
})

describe('the swipe arrow in the page', () => {
  it('adds nothing to the document until there is something to show', () => {
    const view = createSwipeIndicator()
    view.show(null)
    expect(host()).toBeNull()
  })

  it('appears on the edge the swipe is heading for, above anything the page draws', () => {
    const view = createSwipeIndicator()
    view.show(back(0.4))
    expect(host()?.style.getPropertyValue('left')).toBe('0px')
    expect(host()?.style.getPropertyPriority('position')).toBe('important')
    expect(host()?.style.getPropertyValue('z-index')).toBe('2147483647')
    expect(host()?.style.getPropertyValue('pointer-events')).toBe('none')

    view.show({ side: 'right', progress: 0.4, armed: false })
    expect(host()?.style.getPropertyValue('right')).toBe('0px')
  })

  it('stays one element however many steps a swipe takes', () => {
    const view = createSwipeIndicator()
    for (let step = 1; step <= 10; step += 1) view.show(back(step / 10, step === 10))
    expect(document.querySelectorAll('#tessera-swipe')).toHaveLength(1)
  })

  it('slides out and then leaves the document', () => {
    const view = createSwipeIndicator()
    view.show(back(0.6))
    view.show(null)
    expect(host()).not.toBeNull()
    vi.runAllTimers()
    expect(host()).toBeNull()
  })

  it('is kept when the swipe resumes during the slide-out', () => {
    const view = createSwipeIndicator()
    view.show(back(0.6))
    view.show(null)
    view.show(back(0.7))
    vi.runAllTimers()
    expect(host()).not.toBeNull()
  })

  it('goes at once when the page is being left', () => {
    const view = createSwipeIndicator()
    view.show(back(1, true))
    view.dispose()
    expect(host()).toBeNull()
  })
})
