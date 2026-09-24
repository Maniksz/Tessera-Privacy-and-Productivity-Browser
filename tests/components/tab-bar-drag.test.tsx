import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabBar } from '@renderer/components/TabBar.js'
import type { ArrangementSummary } from '@shared/arrangements/screen.js'
import type { TabState } from '@shared/model.js'
import type { TabGroup } from '@shared/tabgroups/model.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'

/**
 * Dragging in the tab strip (U9, R12, KTD7): what the strip reports when a tab or a tiled view's entry
 * is let go over it.
 *
 * What goes wrong in the product when a rule here is wrong:
 *
 *   - **An index counted over drawn tabs** lands the drop one place per folded tab too far left; the
 *     strip reports the tab, entry or chip under the pointer and a side instead, and the core resolves
 *     that against its own order.
 *   - **An entry's drag that starts the tile drag** puts drop zones over the tiles, and letting go on
 *     one would merge two tiled views — which the plan rules out.
 *   - **A marker that does not say "joins"** leaves the user guessing whether the tab they let go
 *     between two members is now in the group.
 *
 * The bridge is replaced, as in `tab-bar-groups.test.tsx`. The geometry is laid out by hand: every
 * target 100 px wide from x = 0, in the order the strip draws them, in a strip 36 px high.
 */

interface Call {
  channel: string
  payload: unknown
}

function installBridge(): Call[] {
  const calls: Call[] = []
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      return Promise.resolve({ ok: true })
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
  return calls
}

function tab(id: string): TabState {
  return {
    id,
    url: `https://example.com/${id}`,
    pendingInput: null,
    title: id,
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    pinned: false,
    muted: false,
    audible: false,
    security: 'secure',
    blockedRequests: 0,
    zoomPercent: 100,
    tileIndex: null,
    unloaded: false
  }
}

function group(overrides: Partial<TabGroup> & { id: string; tabIds: string[] }): TabGroup {
  return { name: 'Sport', color: 'green', collapsed: false, createdAt: 1, ...overrides }
}

function view(id: string, tabIds: string[]): ArrangementSummary {
  return {
    id,
    layoutId: '1x2',
    tabIds,
    activeTile: 0,
    activeTabId: tabIds[0] ?? null,
    visible: false
  }
}

const WIDTH = 100
const HEIGHT = 36

function rect(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    top: 0,
    bottom: HEIGHT,
    x: left,
    y: 0,
    width,
    height: HEIGHT,
    toJSON: () => ({})
  }
}

/** Renders the strip and lays its targets out left to right, `WIDTH` each. */
function renderBar(
  tabIds: string[],
  groups: TabGroup[] = [],
  arrangements: ArrangementSummary[] = []
): void {
  render(
    <TabBar
      tabs={tabIds.map(tab)}
      groups={groups}
      arrangements={arrangements}
      activeTabId={tabIds[0] ?? null}
      leftInset={0}
      rightInset={0}
      titleWithShortcut={shortcutTitles('win32')}
    />
  )
  const strip = document.querySelector<HTMLElement>('.tabbar__strip')!
  vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(rect(0, 1200))
  document.querySelectorAll<HTMLElement>('[data-strip-target]').forEach((element, index) => {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(index * WIDTH, WIDTH))
  })
}

function tabElement(tabId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)!
}

function entryElement(arrangementId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-arrangement-id="${arrangementId}"]`)!
}

function chipElement(groupId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-tab-group-id="${groupId}"]`)!
}

/** Press on `element`, move past the threshold to `x`, and optionally let go there. */
function dragTo(element: HTMLElement, x: number, y = 10): void {
  const box = element.getBoundingClientRect()
  fireEvent.pointerDown(element, { button: 0, clientX: box.left + 10, clientY: 10 })
  fireEvent.pointerMove(window, { clientX: x, clientY: y })
}

function release(x: number, y = 10): void {
  fireEvent.pointerUp(window, { clientX: x, clientY: y })
}

const drops = (calls: Call[]): unknown[] =>
  calls.filter((call) => call.channel === 'strip:drop').map((call) => call.payload)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('letting a tab go over the strip', () => {
  it('reports the tab under the pointer and the side, not an index', () => {
    const calls = installBridge()
    // Drawn: [G chip] a b X — X dragged into the left half of b.
    renderBar(['a', 'b', 'X'], [group({ id: 'G', tabIds: ['a', 'b'] })])

    dragTo(tabElement('X'), 220)
    release(220)

    expect(drops(calls)).toEqual([
      { subject: { kind: 'tab', tabId: 'X' }, target: { kind: 'tab', tabId: 'b' }, side: 'before' }
    ])
    expect(calls.map((call) => call.channel)).not.toContain('tabs:move')
    // Released over the strip: the tile drag is cancelled, so no tile takes the tab as well.
    expect(calls).toContainEqual({ channel: 'drag:end', payload: { x: 220, y: 10, commit: false } })
  })

  it('is not shifted by a folded group to the left of the pointer', () => {
    const calls = installBridge()
    // Drawn: [G chip, folded] X Y — the folded a and b draw nothing. Y into the left half of X.
    renderBar(['a', 'b', 'X', 'Y'], [group({ id: 'G', tabIds: ['a', 'b'], collapsed: true })])

    dragTo(tabElement('Y'), 110)
    release(110)

    expect(drops(calls)).toEqual([
      { subject: { kind: 'tab', tabId: 'Y' }, target: { kind: 'tab', tabId: 'X' }, side: 'before' }
    ])
  })

  it('reads the right half of a target as its after side', () => {
    const calls = installBridge()
    renderBar(['X', 'Y', 'Z'])

    dragTo(tabElement('X'), 170)
    release(170)

    expect(drops(calls)).toEqual([
      { subject: { kind: 'tab', tabId: 'X' }, target: { kind: 'tab', tabId: 'Y' }, side: 'after' }
    ])
  })

  it('reports a chip as the target, and most of a folded chip as its after side', () => {
    const calls = installBridge()
    // Drawn: X [G chip, folded] — the chip is 100..200.
    renderBar(['X', 'a'], [group({ id: 'G', tabIds: ['a'], collapsed: true })])

    dragTo(tabElement('X'), 140)
    release(140)
    dragTo(tabElement('X'), 110)
    release(110)

    expect(drops(calls)).toEqual([
      {
        subject: { kind: 'tab', tabId: 'X' },
        target: { kind: 'group', groupId: 'G' },
        side: 'after'
      },
      {
        subject: { kind: 'tab', tabId: 'X' },
        target: { kind: 'group', groupId: 'G' },
        side: 'before'
      }
    ])
  })

  it('reports the end of the strip past the last target', () => {
    const calls = installBridge()
    renderBar(['X', 'a', 'b'], [group({ id: 'G', tabIds: ['a', 'b'] })])

    dragTo(tabElement('X'), 450)
    release(450)

    expect(drops(calls)).toEqual([
      { subject: { kind: 'tab', tabId: 'X' }, target: { kind: 'end' }, side: 'after' }
    ])
  })

  it('reports no strip drop when the tab is let go over the tiles, and leaves that to the core', () => {
    const calls = installBridge()
    renderBar(['X', 'Y'])

    dragTo(tabElement('X'), 150, 300)
    release(150, 300)

    expect(drops(calls)).toEqual([])
    expect(calls).toContainEqual({ channel: 'drag:start', payload: { tabId: 'X' } })
    expect(calls).toContainEqual({ channel: 'drag:end', payload: { x: 150, y: 300, commit: true } })
  })
})

describe('dragging a tiled view by its entry', () => {
  it('reports the whole view as the subject', () => {
    const calls = installBridge()
    // Drawn: X {A: A1|A2} [G chip] a — the entry into the right half of the chip, first in G.
    renderBar(
      ['X', 'A1', 'A2', 'a'],
      [group({ id: 'G', tabIds: ['a'] })],
      [view('A', ['A1', 'A2'])]
    )

    dragTo(entryElement('A'), 260)
    release(260)

    expect(drops(calls)).toEqual([
      {
        subject: { kind: 'split', arrangementId: 'A' },
        target: { kind: 'group', groupId: 'G' },
        side: 'after'
      }
    ])
  })

  it('starts no tile drag, so no drop zones appear over the tiles', () => {
    const calls = installBridge()
    renderBar(['X', 'A1', 'A2'], [], [view('A', ['A1', 'A2'])])

    dragTo(entryElement('A'), 150, 300)
    release(150, 300)

    const channels = calls.map((call) => call.channel)
    expect(channels).not.toContain('drag:start')
    expect(channels).not.toContain('drag:move')
    expect(channels).not.toContain('drag:end')
    expect(drops(calls)).toEqual([])
  })

  it('draws the entry as dragged while it is', () => {
    installBridge()
    renderBar(['X', 'A1', 'A2'], [], [view('A', ['A1', 'A2'])])

    dragTo(entryElement('A'), 60)
    expect(entryElement('A').className).toContain('tab--dragging')
    release(60)
    expect(entryElement('A').className).not.toContain('tab--dragging')
  })

  it('does not start from the entry’s close button', () => {
    const calls = installBridge()
    renderBar(['X', 'A1', 'A2'], [], [view('A', ['A1', 'A2'])])

    const close = entryElement('A').querySelector<HTMLElement>('.tab__close')!
    fireEvent.pointerDown(close, { button: 0, clientX: 190, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 10 })
    release(20)

    expect(drops(calls)).toEqual([])
  })
})

describe('the insertion marker', () => {
  it('marks the side of the target, and says when the drop joins a group', () => {
    installBridge()
    // Drawn: X [G chip] a b.
    renderBar(['X', 'a', 'b'], [group({ id: 'G', tabIds: ['a', 'b'] })])

    dragTo(tabElement('X'), 320)
    expect(tabElement('b').className).toContain('tab--dropbefore')
    expect(tabElement('b').className).toContain('tab--dropjoin')

    fireEvent.pointerMove(window, { clientX: 390, clientY: 10 })
    expect(tabElement('b').className).toContain('tab--dropafter')
    expect(tabElement('b').className).toContain('tab--dropjoin')

    // Before the chip is outside the group: a marker, but not the joining one.
    fireEvent.pointerMove(window, { clientX: 110, clientY: 10 })
    expect(chipElement('G').className).toContain('tab--dropbefore')
    expect(chipElement('G').className).not.toContain('tab--dropjoin')
    expect(tabElement('b').className).not.toContain('tab--drop')

    release(110)
    expect(document.querySelectorAll('.tab--dropbefore, .tab--dropafter')).toHaveLength(0)
  })

  it('marks the new-tab button for the end of the strip, and nothing for a drop onto itself', () => {
    installBridge()
    renderBar(['X', 'Y'])

    dragTo(tabElement('X'), 450)
    expect(document.querySelector('.tabbar__new')?.className).toContain('tab--dropbefore')

    fireEvent.pointerMove(window, { clientX: 30, clientY: 10 })
    expect(document.querySelectorAll('.tab--dropbefore, .tab--dropafter')).toHaveLength(0)
    release(30)
  })

  it('clears when the core ends the drag on its own', () => {
    let presented: ((payload: unknown) => void) | null = null
    const calls: Call[] = []
    Object.defineProperty(window, 'tessera', {
      value: {
        invoke: (channel: string, payload?: unknown) => {
          calls.push({ channel, payload })
          return Promise.resolve({ ok: true })
        },
        on: (channel: string, listener: (payload: unknown) => void) => {
          if (channel === 'overlay:presented') presented = listener
          return () => {}
        },
        channels: { invoke: [], event: [] }
      },
      configurable: true,
      writable: true
    })
    renderBar(['X', 'Y'])

    dragTo(tabElement('X'), 160)
    expect(tabElement('Y').className).toContain('tab--drop')
    act(() => presented?.({ presentation: null }))

    expect(document.querySelectorAll('.tab--dropbefore, .tab--dropafter')).toHaveLength(0)
    release(160)
    expect(drops(calls)).toEqual([])
  })
})
