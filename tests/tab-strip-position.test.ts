import { describe, expect, it } from 'vitest'
import { entryForStripPosition } from '@main/browser/tab-strip-position.js'
import type { StripArrangement } from '@shared/strip/model.js'
import type { TabGroup } from '@shared/tabgroups/model.js'

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

/**
 * The same keys once a tiled view is one entry (U5, R13).
 *
 * A tiled view is drawn as one entry, so it is one position: with X, the view A and Y drawn, `Ctrl+3` is
 * Y — counting tabs would make it A's second member, a key for something the strip does not draw as a
 * place of its own. The entry comes back whole, so the window can bring the view back rather than pull
 * one page out of it.
 */
describe('entryForStripPosition', () => {
  const view: StripArrangement = { id: 'A', tabIds: ['A1', 'A2'], activeTabId: 'A2' }
  const folded: TabGroup = {
    id: 'F',
    name: '',
    color: 'blue',
    collapsed: true,
    tabIds: ['f1', 'f2'],
    createdAt: 1
  }
  const order = ['X', 'A1', 'A2', 'Y']

  it('counts a tiled view as one position', () => {
    // The plan's scenario: Ctrl+3 on X, entry A, Y is Y, and Ctrl+2 is A.
    expect(entryForStripPosition(order, [], [view], 3)).toEqual({
      kind: 'tab',
      tabId: 'Y',
      group: null,
      position: null
    })
    expect(entryForStripPosition(order, [], [view], 2)).toEqual({
      kind: 'split',
      arrangementId: 'A',
      tabIds: ['A1', 'A2'],
      activeTabId: 'A2',
      group: null,
      position: null
    })
  })

  it('reads the order through the strip model, so members apart in the order are one entry', () => {
    expect(entryForStripPosition(['A1', 'X', 'A2'], [], [view], 2)).toMatchObject({ tabId: 'X' })
  })

  it('answers the last entry for the ninth key, a tiled view included', () => {
    expect(entryForStripPosition(['X', 'A1', 'A2'], [], [view], 'last')).toMatchObject({
      kind: 'split',
      arrangementId: 'A'
    })
    expect(entryForStripPosition(order, [], [view], 'last')).toMatchObject({ tabId: 'Y' })
  })

  it('counts neither a chip nor the tabs a folded group hides', () => {
    const withFold = ['X', 'f1', 'f2', 'A1', 'A2']
    expect(entryForStripPosition(withFold, [folded], [view], 2)).toMatchObject({ kind: 'split' })
    expect(entryForStripPosition(withFold, [folded], [view], 3)).toBeNull()
    expect(entryForStripPosition(['f1', 'f2'], [folded], [], 'last')).toBeNull()
  })

  it('does nothing for a position the strip does not have', () => {
    expect(entryForStripPosition(order, [], [view], 4)).toBeNull()
    expect(entryForStripPosition(order, [], [view], 0)).toBeNull()
    expect(entryForStripPosition(order, [], [view], -1)).toBeNull()
    expect(entryForStripPosition([], [], [], 1)).toBeNull()
    expect(entryForStripPosition([], [], [], 'last')).toBeNull()
  })

  it('counts from one, left to right, when there is no tiled view', () => {
    expect(entryForStripPosition(order, [], [], 1)).toMatchObject({ tabId: 'X' })
    expect(entryForStripPosition(order, [], [], 3)).toMatchObject({ tabId: 'A2' })
  })
})
