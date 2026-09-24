import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabBar } from '@renderer/components/TabBar.js'
import type { ArrangementSummary } from '@shared/arrangements/screen.js'
import type { TabState } from '@shared/model.js'
import type { TabGroup } from '@shared/tabgroups/model.js'
import type { TileDragReport } from '@shared/strip/tile-drag.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'

/**
 * The strip's half of a tab dragged out of a tile by its bar's grip (U10, R9, KTD14).
 *
 * The strip never saw that press, so it learns of the drag from the core (`strip:tileDrag`): that it
 * began, where the pointer is while it is over the strip, and where it was let go. What the strip owes in
 * return is the one thing only it can answer — which target and side lie under a point — as the place the
 * released tab goes (`arrangements:releaseTab` with `at`). What goes wrong in the product when a rule here
 * is wrong:
 *
 *   - **No answer**, and the tab stays in its tile although the user let go over the strip.
 *   - **An answer for a point off the strip**, and a drag let go over the toolbar releases the tab.
 *   - **No marker beside the view the tab came from**: a drop there moves nothing in the strip, but it
 *     still releases the tab, so the strip must still say where it lands.
 *   - **A strip deaf to its own pointer**: where the platform hands a held button to the view under it,
 *     the strip is the one that hears the pointer let go, and has to report that for the core to act.
 *
 * Geometry by hand, as in `tab-bar-drag.test.tsx`: every target 100 px wide from x = 0, in drawn order,
 * in a strip 36 px high whose client space is the window's.
 */

interface Call {
  channel: string
  payload: unknown
}

interface Bridge {
  calls: Call[]
  /** Delivers a core event, as the preload would. */
  emit(channel: string, payload: unknown): void
}

function installBridge(): Bridge {
  const calls: Call[] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      return Promise.resolve({ ok: true })
    },
    on: (channel: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    },
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
  return {
    calls,
    emit: (channel, payload) => {
      act(() => listeners.get(channel)?.forEach((listener) => listener(payload)))
    }
  }
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

function view(id: string, tabIds: string[]): ArrangementSummary {
  return {
    id,
    layoutId: '1x3',
    tabIds,
    activeTile: 0,
    activeTabId: tabIds[0] ?? null,
    visible: true
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

/** Drawn: x (0..100), the view v of b1, b2, b3 (100..200), y (200..300). */
function renderBar(groups: TabGroup[] = []): void {
  render(
    <TabBar
      tabs={['x', 'b1', 'b2', 'b3', 'y'].map(tab)}
      groups={groups}
      arrangements={[view('v', ['b1', 'b2', 'b3'])]}
      activeTabId="b1"
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

const report = (point: TileDragReport['point'], released = false): TileDragReport => ({
  tabId: 'b2',
  point,
  released
})

const releases = (calls: Call[]): unknown[] =>
  calls.filter((call) => call.channel === 'arrangements:releaseTab').map((call) => call.payload)

const markers = (): Element[] => [...document.querySelectorAll('.tab--dropbefore, .tab--dropafter')]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a tab let go over the strip from a tile', () => {
  it('answers with the place under the point, as a release from the tiled view', () => {
    const bridge = installBridge()
    renderBar()

    bridge.emit('strip:tileDrag', report(null))
    bridge.emit('strip:tileDrag', report({ x: 20, y: 10 }, true))

    expect(releases(bridge.calls)).toEqual([
      { tabId: 'b2', at: { target: { kind: 'tab', tabId: 'x' }, side: 'before' } }
    ])
    // Nothing of the strip's own drop: the core releases first and drops second, in one call.
    expect(bridge.calls.map((call) => call.channel)).not.toContain('strip:drop')
    expect(markers()).toHaveLength(0)
  })

  it('answers even when it heard of nothing before the release', () => {
    // The start and the release travel as separate messages; the release alone is enough to act on.
    const bridge = installBridge()
    renderBar()

    bridge.emit('strip:tileDrag', report({ x: 250, y: 10 }, true))

    expect(releases(bridge.calls)).toEqual([
      { tabId: 'b2', at: { target: { kind: 'tab', tabId: 'y' }, side: 'after' } }
    ])
  })

  it('answers nothing for a point off the strip', () => {
    // Over the toolbar, below the strip and above the tiles: not a place in the strip.
    const bridge = installBridge()
    renderBar()

    bridge.emit('strip:tileDrag', report({ x: 20, y: HEIGHT + 20 }, true))

    expect(releases(bridge.calls)).toEqual([])
  })
})

describe('while the tab is over the strip', () => {
  it('marks where it would land, and stops when the pointer goes back to the tiles', () => {
    const bridge = installBridge()
    renderBar()

    bridge.emit('strip:tileDrag', report(null))
    expect(markers()).toHaveLength(0)

    bridge.emit('strip:tileDrag', report({ x: 220, y: 10 }))
    expect(document.querySelector('[data-tab-id="y"]')?.className).toContain('tab--dropbefore')

    bridge.emit('strip:tileDrag', report(null))
    expect(markers()).toHaveLength(0)
  })

  it('marks a place beside the view it came from, where the strip moves nothing but the tab still lands', () => {
    const bridge = installBridge()
    renderBar()

    bridge.emit('strip:tileDrag', report(null))
    bridge.emit('strip:tileDrag', report({ x: 180, y: 10 }))

    expect(document.querySelector('[data-arrangement-id="v"]')?.className).toContain(
      'tab--dropafter'
    )
  })

  it('clears when the core ends the drag, and a later release of its own pointer sends nothing', () => {
    const bridge = installBridge()
    renderBar()

    bridge.emit('strip:tileDrag', report(null))
    bridge.emit('strip:tileDrag', report({ x: 220, y: 10 }))
    bridge.emit('overlay:presented', { presentation: null })

    expect(markers()).toHaveLength(0)
    fireEvent.pointerUp(window, { clientX: 220, clientY: 10 })
    expect(bridge.calls).toEqual([])
  })
})

describe('when the strip hears the pointer itself', () => {
  it('marks from its own samples and reports its own release to the core, which ends the drag', () => {
    const bridge = installBridge()
    renderBar()

    bridge.emit('strip:tileDrag', report(null))
    fireEvent.pointerMove(window, { clientX: 20, clientY: 10 })
    expect(document.querySelector('[data-tab-id="x"]')?.className).toContain('tab--dropbefore')

    fireEvent.pointerUp(window, { clientX: 20, clientY: 10 })

    // The core decides what a release is, from the point, and hands a release over the strip back.
    expect(bridge.calls).toContainEqual({
      channel: 'drag:end',
      payload: { x: 20, y: 10, commit: true }
    })
    expect(releases(bridge.calls)).toEqual([])
  })

  it('reports a cancelled pointer as a drag that moves nothing', () => {
    const bridge = installBridge()
    renderBar()

    bridge.emit('strip:tileDrag', report(null))
    fireEvent.pointerCancel(window, { clientX: 20, clientY: 10 })

    expect(bridge.calls).toEqual([
      { channel: 'drag:end', payload: { x: 20, y: 10, commit: false } }
    ])
  })

  it('ignores the pointer when no tile drag is live', () => {
    const bridge = installBridge()
    renderBar()

    fireEvent.pointerMove(window, { clientX: 20, clientY: 10 })
    fireEvent.pointerUp(window, { clientX: 20, clientY: 10 })

    expect(bridge.calls).toEqual([])
    expect(markers()).toHaveLength(0)
  })
})
