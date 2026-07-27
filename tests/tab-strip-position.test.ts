import { describe, expect, it } from 'vitest'
import { tabForStripPosition } from '@main/browser/tab-strip-position.js'

/**
 * Which tab `Ctrl+1`…`Ctrl+9` names (spec 9).
 *
 * What breaks in the product if these rules are wrong:
 *
 *   - **Counting a collapsed group's members** makes `Ctrl+3` activate a tab that is not drawn — and
 *     `activateTab` gives a tab with no tile one, so the result is a pane showing a page with nothing in
 *     the strip to close it, mute it or switch away from it. That is the exact state
 *     `TabGroupController.setCollapsed` releases a tile to avoid, reached from the other direction.
 *   - **Clamping a position past the end** makes one key mean different tabs depending on how many are
 *     open: `Ctrl+8` would be the eighth tab with eight open and the third with three.
 *   - **Taking the order from anywhere but the display order** puts the key out of step with the strip
 *     the moment a group is created, because a group is drawn as one run of tabs.
 */

describe('tabForStripPosition', () => {
  const order = ['tab-1', 'tab-2', 'tab-3', 'tab-4']

  it('counts from one, left to right', () => {
    expect(tabForStripPosition(order, [], 1)).toBe('tab-1')
    expect(tabForStripPosition(order, [], 3)).toBe('tab-3')
  })

  it('answers the last drawn tab for the ninth key', () => {
    expect(tabForStripPosition(order, [], 'last')).toBe('tab-4')
  })

  it('does nothing for a position the strip does not have', () => {
    expect(tabForStripPosition(order, [], 5)).toBeNull()
    expect(tabForStripPosition(['tab-1'], [], 8)).toBeNull()
  })

  it('skips the tabs a collapsed group hides', () => {
    /*
      The rule that matters. With `tab-2` and `tab-3` folded away, the strip draws two tabs and
      `Ctrl+2` must be the second of *those* — not the second entry of an order that still contains
      the hidden pair.
    */
    expect(tabForStripPosition(order, ['tab-2', 'tab-3'], 2)).toBe('tab-4')
  })

  it('never names a hidden tab, whichever position is asked for', () => {
    const hidden = ['tab-2', 'tab-3']
    const named = [1, 2, 3, 4, 'last' as const].map((position) =>
      tabForStripPosition(order, hidden, position)
    )
    expect(named).toEqual(['tab-1', 'tab-4', null, null, 'tab-4'])
  })

  it('answers the last drawn tab, not the last one in the order', () => {
    // A collapsed group at the right-hand end of the strip: `Ctrl+9` must land on the last tab the
    // user can see, which is the one before it.
    expect(tabForStripPosition(order, ['tab-4'], 'last')).toBe('tab-3')
  })

  it('does nothing when every tab is hidden', () => {
    expect(tabForStripPosition(order, order, 'last')).toBeNull()
    expect(tabForStripPosition(order, order, 1)).toBeNull()
  })

  it('does nothing for a position below one', () => {
    /*
      Not reachable from the menu items, which pass 1…8, and asserted because the arithmetic makes the
      wrong answer plausible rather than absent: an index of −2 handed to `slice` would count backwards
      from the right-hand end and quietly return the second-to-last tab.
    */
    expect(tabForStripPosition(order, [], 0)).toBeNull()
    expect(tabForStripPosition(order, [], -1)).toBeNull()
  })

  it('does nothing in a window whose strip is empty', () => {
    // A window mid-teardown, or one whose last tab has just closed and whose replacement is not there
    // yet. `Ctrl+9` in it must be silence rather than an id nobody holds.
    expect(tabForStripPosition([], [], 'last')).toBeNull()
    expect(tabForStripPosition([], [], 1)).toBeNull()
  })

  it('reads the order it is given rather than sorting it', () => {
    // The display order is already the answer to "what does the strip look like" — a group gathered
    // into one run, a dragged tab where the user dropped it. Re-deriving anything here would be a
    // second opinion about the strip.
    expect(tabForStripPosition(['tab-9', 'tab-2', 'tab-40'], [], 1)).toBe('tab-9')
    expect(tabForStripPosition(['tab-9', 'tab-2', 'tab-40'], [], 'last')).toBe('tab-40')
  })
})
