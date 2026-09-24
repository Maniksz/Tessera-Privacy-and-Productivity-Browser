import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '@renderer/App.js'
import type { TabGroup } from '@shared/tabgroups/model.js'
import type { TabState } from '@shared/model.js'

/**
 * Ctrl+Tab against a collapsed group.
 *
 * `App.tsx` used to cycle over `state.tabs` unfiltered, which is `displayOrder()` — the strip's
 * order *including* a collapsed group's members (see `useBrowserState`'s doc comment). That put a
 * hidden tab's page on screen with nothing in the strip to show where it came from, exactly what
 * `setCollapsed` is supposed to prevent. `activateTabAtStripPosition` already filters with
 * `tabsHiddenByCollapse` on the core side; this is the renderer side of the same fix.
 *
 * A bare `installBridge` rather than the full privilege-checked fixture other files use: the
 * claim under test is the cycling arithmetic, not App's IPC allowlist.
 */

interface Call {
  channel: string
  payload: unknown
}

function installBridge(): {
  calls: Call[]
  emit: (channel: string, payload: unknown) => void
  listenerCount: (channel: string) => number
} {
  const calls: Call[] = []
  const listeners = new Map<string, Array<(payload: unknown) => void>>()

  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      switch (channel) {
        case 'window:getState':
          return Promise.resolve({
            windowId: 1,
            platform: 'darwin',
            focused: true,
            maximized: false,
            fullscreen: false,
            privateMode: false,
            windowControlsInset: { left: 0, right: 0 }
          })
        case 'settings:getAll':
          return Promise.resolve({})
        default:
          return Promise.resolve(undefined)
      }
    },
    on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
      const existing = listeners.get(channel) ?? []
      listeners.set(channel, [...existing, listener])
      return () => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((entry) => entry !== listener)
        )
      }
    },
    channels: { invoke: [], event: [] }
  }

  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })

  return {
    calls,
    emit: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload)
    },
    listenerCount: (channel) => (listeners.get(channel) ?? []).length
  }
}

function tab(id: string, overrides: Partial<TabState> = {}): TabState {
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
    unloaded: false,
    ...overrides
  }
}

function group(overrides: Partial<TabGroup> & { id: string; tabIds: string[] }): TabGroup {
  return { name: '', color: 'blue', collapsed: false, createdAt: 1, ...overrides }
}

afterEach(cleanup)

describe('Ctrl+Tab / Ctrl+Shift+Tab with a collapsed group in the strip', () => {
  it('skips a hidden member when cycling forward', () => {
    const bridge = installBridge()
    render(<App />)

    act(() => {
      bridge.emit('tabs:changed', {
        tabs: [tab('t1'), tab('t2'), tab('t3')],
        activeTabId: 't1'
      })
      bridge.emit('tabgroups:changed', {
        groups: [group({ id: 'g1', tabIds: ['t2'], collapsed: true })]
      })
    })

    act(() => {
      bridge.emit('shortcut:triggered', { action: 'nextTab' })
    })

    // Unfiltered, index 0 -> 1 would land on 't2', the hidden member.
    expect(bridge.calls).toContainEqual({ channel: 'tabs:activate', payload: { tabId: 't3' } })
  })

  it('skips the same member when wrapping backward', () => {
    const bridge = installBridge()
    render(<App />)

    act(() => {
      bridge.emit('tabs:changed', {
        tabs: [tab('t1'), tab('t2'), tab('t3')],
        activeTabId: 't1'
      })
      bridge.emit('tabgroups:changed', {
        groups: [group({ id: 'g1', tabIds: ['t2'], collapsed: true })]
      })
    })

    act(() => {
      bridge.emit('shortcut:triggered', { action: 'previousTab' })
    })

    // Visible order is [t1, t3]; wrapping back from t1 must land on t3, not the hidden t2.
    expect(bridge.calls).toContainEqual({ channel: 'tabs:activate', payload: { tabId: 't3' } })
  })

  it('still cycles normally once the group is expanded again', () => {
    const bridge = installBridge()
    render(<App />)

    act(() => {
      bridge.emit('tabs:changed', {
        tabs: [tab('t1'), tab('t2'), tab('t3')],
        activeTabId: 't1'
      })
      bridge.emit('tabgroups:changed', {
        groups: [group({ id: 'g1', tabIds: ['t2'], collapsed: false })]
      })
    })

    act(() => {
      bridge.emit('shortcut:triggered', { action: 'nextTab' })
    })

    expect(bridge.calls).toContainEqual({ channel: 'tabs:activate', payload: { tabId: 't2' } })
  })
})

/*
  A tiled view is one entry, so Ctrl+Tab steps over it once (U7, R13). Counting tabs instead would
  land on its second member as if that were its own entry — and, since the strip has no tab for it,
  put a page on screen the user cannot find in the strip.
*/
describe('Ctrl+Tab / Ctrl+Shift+Tab with a tiled view in the strip', () => {
  const tabs = [tab('X'), tab('A1'), tab('A2'), tab('Y')]
  const view = {
    id: 'A',
    layoutId: '1x2',
    tabIds: ['A1', 'A2'],
    activeTile: 1,
    activeTabId: 'A2',
    visible: false
  }

  function showing(bridge: ReturnType<typeof installBridge>, activeTabId: string): void {
    act(() => {
      bridge.emit('tabs:changed', { tabs, activeTabId })
      bridge.emit('arrangements:changed', { arrangements: [view] })
    })
  }

  function press(bridge: ReturnType<typeof installBridge>, action: string): unknown {
    bridge.calls.length = 0
    act(() => {
      bridge.emit('shortcut:triggered', { action })
    })
    return bridge.calls.find((call) => call.channel === 'tabs:activate')?.payload
  }

  it('goes round X, the entry and Y in three steps', () => {
    const bridge = installBridge()
    render(<App />)

    showing(bridge, 'X')
    // The entry is landed on through its active tile's tab, which brings the view back focused there.
    expect(press(bridge, 'nextTab')).toEqual({ tabId: 'A2' })
    showing(bridge, 'A2')
    expect(press(bridge, 'nextTab')).toEqual({ tabId: 'Y' })
    showing(bridge, 'Y')
    expect(press(bridge, 'nextTab')).toEqual({ tabId: 'X' })
  })

  it('steps off the entry from whichever member has focus, and back onto it', () => {
    const bridge = installBridge()
    render(<App />)

    // A1 is a member too: the entry is where the strip is, whichever tile is focused.
    showing(bridge, 'A1')
    expect(press(bridge, 'nextTab')).toEqual({ tabId: 'Y' })
    showing(bridge, 'Y')
    expect(press(bridge, 'previousTab')).toEqual({ tabId: 'A2' })
  })

  it('stops listening to the tiled views once the window is gone', () => {
    const bridge = installBridge()
    const { unmount } = render(<App />)
    showing(bridge, 'X')
    unmount()
    // Emitting after unmount must reach no listener, which is what a missing unsubscribe would break.
    expect(() => bridge.emit('arrangements:changed', { arrangements: [view] })).not.toThrow()
    expect(bridge.listenerCount('arrangements:changed')).toBe(0)
  })
})
