import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '@renderer/App.js'
import { TabSearchPanel } from '@renderer/components/TabSearchPanel.js'
import type { TabState } from '@shared/model.js'
import type { TabGroup } from '@shared/tabgroups/model.js'

/**
 * The tab search (U22, R31), rendered.
 *
 * Two halves. The panel on its own — typing, the arrows, Enter and Escape — because those are the whole
 * of what a person does with it and none of them has a channel the smoke test could watch. And the panel
 * inside `App`, because the shortcut arrives as a `shortcut:triggered` the menu item emits, the panel is
 * fetched on first use, and the content views have to be suspended while it is up (KTD16): three
 * seams, each of which could be missing while the panel itself works perfectly.
 *
 * Unfolding a group is the core's: `activateTab` brings a folded group's member back through
 * `TabDiscards.wake`, which opens the group. So what the renderer owes that scenario is to find the tab
 * — the strip does not draw it — and to ask for exactly that tab; `tab-groups.feature` holds the rest.
 */

interface Call {
  channel: string
  payload: unknown
}

interface Bridge {
  calls: Call[]
  emit: (channel: string, payload: unknown) => void
}

function installBridge(): Bridge {
  const calls: Call[] = []
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      switch (channel) {
        case 'window:getState':
          return Promise.resolve({
            windowId: 1,
            platform: 'win32',
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
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
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
    }
  }
}

function tab(id: string, url: string, title: string): TabState {
  return {
    id,
    url,
    pendingInput: null,
    title,
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
  return { name: '', color: 'blue', collapsed: false, createdAt: 1, ...overrides }
}

const TABS = [
  tab('mail', 'https://mail.example/inbox', 'Inbox'),
  tab('docs', 'https://docs.example/q3', 'Quarterly report'),
  tab('news', 'https://news.example/', 'Morning briefing')
]

const activations = (bridge: Bridge): unknown[] =>
  bridge.calls.filter((call) => call.channel === 'tabs:activate').map((call) => call.payload)

const rowTitles = (): string[] =>
  screen
    .getAllByRole('option')
    .map((row) => row.querySelector('.tabsearch__title')?.textContent ?? '')

afterEach(cleanup)

describe('the tab search panel', () => {
  it('lists every tab of the window while nothing is typed, and has the field focused', () => {
    installBridge()
    render(<TabSearchPanel tabs={TABS} onClose={() => {}} />)
    expect(rowTitles()).toEqual(['Inbox', 'Quarterly report', 'Morning briefing'])
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('filters by title as the user types', () => {
    installBridge()
    render(<TabSearchPanel tabs={TABS} onClose={() => {}} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'report' } })
    expect(rowTitles()).toEqual(['Quarterly report'])
  })

  it('filters by address as the user types', () => {
    installBridge()
    render(<TabSearchPanel tabs={TABS} onClose={() => {}} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mail.ex' } })
    expect(rowTitles()).toEqual(['Inbox'])
    expect(screen.getByRole('option').textContent).toContain('mail.example/inbox')
  })

  it('activates the first row on Enter and closes', () => {
    const bridge = installBridge()
    const onClose = vi.fn()
    render(<TabSearchPanel tabs={TABS} onClose={onClose} />)
    const field = screen.getByRole('combobox')
    fireEvent.change(field, { target: { value: 'e' } })
    const first = screen.getAllByRole('option')[0]
    expect(first?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(activations(bridge)).toEqual([{ tabId: first?.dataset.tabId }])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape without activating anything', () => {
    const bridge = installBridge()
    const onClose = vi.fn()
    render(<TabSearchPanel tabs={TABS} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(activations(bridge)).toEqual([])
  })

  it('moves the selection with the arrows, wrapping at both ends', () => {
    const bridge = installBridge()
    render(<TabSearchPanel tabs={TABS} onClose={() => {}} />)
    const field = screen.getByRole('combobox')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(field.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]?.id)
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(activations(bridge)).toEqual([{ tabId: 'news' }])
  })

  it('starts at the first row again when the text changes', () => {
    const bridge = installBridge()
    render(<TabSearchPanel tabs={TABS} onClose={() => {}} />)
    const field = screen.getByRole('combobox')
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.change(field, { target: { value: 'example' } })
    const first = screen.getAllByRole('option')[0]?.dataset.tabId
    expect(first).toBeDefined()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(activations(bridge)).toEqual([{ tabId: first }])
  })

  it('activates a row that is clicked', () => {
    const bridge = installBridge()
    const onClose = vi.fn()
    render(<TabSearchPanel tabs={TABS} onClose={onClose} />)
    fireEvent.click(screen.getByText('Morning briefing'))
    expect(activations(bridge)).toEqual([{ tabId: 'news' }])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('says so when no tab matches, and Enter then does nothing', () => {
    const bridge = installBridge()
    const onClose = vi.fn()
    render(<TabSearchPanel tabs={TABS} onClose={onClose} />)
    const field = screen.getByRole('combobox')
    fireEvent.change(field, { target: { value: 'zzz' } })
    expect(screen.queryAllByRole('option')).toEqual([])
    expect(screen.getByText('No tab matches')).toBeDefined()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(activations(bridge)).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
  })

  it('names a tab without a title the way the strip does', () => {
    installBridge()
    render(<TabSearchPanel tabs={[tab('blank', 'about:blank', '')]} onClose={() => {}} />)
    expect(rowTitles()).toEqual(['Untitled'])
  })

  it('closes when the backdrop is pressed, and not when the panel is', () => {
    installBridge()
    const onClose = vi.fn()
    const { container } = render(<TabSearchPanel tabs={TABS} onClose={onClose} />)
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(container.querySelector('.overlay') as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('the tab search inside the window', () => {
  async function openSearch(bridge: Bridge): Promise<HTMLElement> {
    act(() => {
      bridge.emit('shortcut:triggered', { action: 'searchTabs' })
    })
    return screen.findByRole('combobox')
  }

  it('opens from the shortcut the menu item sends, over suspended content views', async () => {
    const bridge = installBridge()
    render(<App />)
    act(() => {
      bridge.emit('tabs:changed', { tabs: TABS, activeTabId: 'mail' })
    })
    await openSearch(bridge)
    expect(bridge.calls).toContainEqual({
      channel: 'window:setOverlay',
      payload: { active: true }
    })
  })

  it('finds a tab the strip hides in a folded group, and asks for exactly that tab', async () => {
    const bridge = installBridge()
    render(<App />)
    act(() => {
      bridge.emit('tabs:changed', { tabs: TABS, activeTabId: 'mail' })
      bridge.emit('tabgroups:changed', {
        groups: [group({ id: 'later', name: 'Later', tabIds: ['news'], collapsed: true })]
      })
    })
    // The strip draws the chip and not the tab: the search is the only list that still has it.
    expect(document.querySelector('.tabbar [data-tab-id="news"]')).toBeNull()

    const field = await openSearch(bridge)
    fireEvent.change(field, { target: { value: 'briefing' } })
    expect(rowTitles()).toEqual(['Morning briefing'])
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(activations(bridge)).toEqual([{ tabId: 'news' }])
    // Closed again, and the views back.
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(bridge.calls.at(-1)).toEqual({
      channel: 'window:setOverlay',
      payload: { active: false }
    })
  })

  it('leaves the text field alone for the window Escape, which would otherwise leave a layout', async () => {
    const bridge = installBridge()
    render(<App />)
    act(() => {
      bridge.emit('tabs:changed', { tabs: TABS, activeTabId: 'mail' })
    })
    const field = await openSearch(bridge)
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(bridge.calls.map((call) => call.channel)).not.toContain('split:escape')
  })
})
