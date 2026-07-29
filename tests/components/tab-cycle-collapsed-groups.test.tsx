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

function installBridge(): { calls: Call[]; emit: (channel: string, payload: unknown) => void } {
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
        listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== listener))
      }
    },
    channels: { invoke: [], event: [] }
  }

  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })

  return {
    calls,
    emit: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload)
    }
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
