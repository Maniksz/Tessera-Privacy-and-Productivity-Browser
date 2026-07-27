import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabBar } from '@renderer/components/TabBar.js'
import type { TabState } from '@shared/model.js'
import type { TabGroup } from '@shared/tabgroups/model.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'

/**
 * The tab strip with groups in it.
 *
 * Two behaviours here are reachable no other way. The chip's own affordances — click to fold,
 * double-click to rename, Escape to abandon — have no channel to assert from the smoke test, and the
 * band's rounded ends are a class the running browser cannot be asked about without reading the class
 * back, which is what this does directly.
 *
 * The bridge is replaced rather than mocked at the module level, for the same reason as the history
 * page's test: `bridge.ts` reads `window.tessera` on every call, which is the seam a sandboxed
 * renderer actually has.
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
  Object.defineProperty(window, 'tessera', {
    value: bridge,
    configurable: true,
    writable: true
  })
  return calls
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

function renderBar(tabs: TabState[], groups: TabGroup[]): void {
  render(
    <TabBar
      tabs={tabs}
      groups={groups}
      activeTabId={tabs[0]?.id ?? null}
      split={null}
      leftInset={0}
      rightInset={0}
      // The real writer, built for a known platform. A stub returning the label would let a call site
      // stop asking for the key without this file noticing.
      titleWithShortcut={shortcutTitles('win32')}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a group in the strip', () => {
  it('draws a chip before its members', () => {
    installBridge()
    renderBar([tab('t1'), tab('t2')], [group({ id: 'g1', tabIds: ['t2'], name: 'Work' })])

    const chip = screen.getByRole('button', { name: /Collapse group Work/i })
    const member = document.querySelector('[data-tab-id="t2"]')
    // `compareDocumentPosition`: the chip must precede its member, which is the whole point of the
    // sequence and cannot be seen from a class name.
    expect(chip.compareDocumentPosition(member!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('bands the members and marks the ends of the run', () => {
    installBridge()
    renderBar([tab('t1'), tab('t2'), tab('t3')], [group({ id: 'g1', tabIds: ['t1', 't2', 't3'] })])
    const classes = ['t1', 't2', 't3'].map(
      (id) => document.querySelector(`[data-tab-id="${id}"]`)?.className ?? ''
    )
    expect(classes[0]).toContain('tab--group-first')
    expect(classes[1]).toContain('tab--group-middle')
    expect(classes[2]).toContain('tab--group-last')
  })

  it('gives a lone member both ends, so its band is a single rounded shape', () => {
    installBridge()
    renderBar([tab('t1')], [group({ id: 'g1', tabIds: ['t1'] })])
    expect(document.querySelector('[data-tab-id="t1"]')?.className).toContain('tab--group-only')
  })

  it('bands nothing when there are no groups', () => {
    installBridge()
    renderBar([tab('t1')], [])
    expect(document.querySelectorAll('.tab--grouped')).toHaveLength(0)
  })

  it('carries the group colour as a custom property rather than a class per colour', () => {
    installBridge()
    renderBar([tab('t1')], [group({ id: 'g1', tabIds: ['t1'], color: 'green' })])
    const member = document.querySelector<HTMLElement>('[data-tab-id="t1"]')
    expect(member?.style.getPropertyValue('--tab-group-current')).toBe('var(--tab-group-green)')
  })
})

describe('folding a group', () => {
  it('asks the core rather than hiding the tabs itself', () => {
    // The core owns it because folding also releases the tabs' tiles. A renderer that merely stopped
    // drawing them would leave a page on screen with nothing in the strip to act on.
    const calls = installBridge()
    renderBar([tab('t1')], [group({ id: 'g1', tabIds: ['t1'], name: 'Work' })])

    screen.getByRole('button', { name: /Collapse group Work/i }).click()
    expect(calls).toContainEqual({
      channel: 'tabgroups:setCollapsed',
      payload: { id: 'g1', collapsed: true }
    })
  })

  it('draws the chip and none of its tabs when folded', () => {
    installBridge()
    renderBar(
      [tab('t1'), tab('t2')],
      [group({ id: 'g1', tabIds: ['t1'], collapsed: true, name: 'Work' })]
    )
    expect(document.querySelector('[data-tab-id="t1"]')).toBeNull()
    expect(document.querySelector('[data-tab-id="t2"]')).not.toBeNull()
  })

  it('says how many are hidden, so they do not look closed', () => {
    installBridge()
    renderBar(
      [tab('t1'), tab('t2')],
      [group({ id: 'g1', tabIds: ['t1', 't2'], collapsed: true, name: 'Work' })]
    )
    expect(screen.getByRole('button', { name: /2 tabs hidden/i })).toBeTruthy()
  })
})

describe('renaming a group', () => {
  it('turns the chip into an input on a double-click', () => {
    installBridge()
    renderBar([tab('t1')], [group({ id: 'g1', tabIds: ['t1'], name: 'Work' })])

    fireEvent.doubleClick(screen.getByRole('button', { name: /Collapse group Work/i }))
    const input = screen.getByRole('textbox', { name: /Rename group/i })
    expect((input as HTMLInputElement).value).toBe('Work')
  })

  it('commits on Enter', () => {
    const calls = installBridge()
    renderBar([tab('t1')], [group({ id: 'g1', tabIds: ['t1'], name: 'Work' })])

    fireEvent.doubleClick(screen.getByRole('button', { name: /Collapse group Work/i }))
    const input = screen.getByRole('textbox', { name: /Rename group/i })
    fireEvent.change(input, { target: { value: 'Reading' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(calls).toContainEqual({
      channel: 'tabgroups:rename',
      payload: { id: 'g1', name: 'Reading' }
    })
  })

  it('abandons on Escape without renaming', () => {
    // Without this the only way out of the edit is to accept a name.
    const calls = installBridge()
    renderBar([tab('t1')], [group({ id: 'g1', tabIds: ['t1'], name: 'Work' })])

    fireEvent.doubleClick(screen.getByRole('button', { name: /Collapse group Work/i }))
    const input = screen.getByRole('textbox', { name: /Rename group/i })
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(calls.some((call) => call.channel === 'tabgroups:rename')).toBe(false)
    expect(screen.getByRole('button', { name: /Collapse group Work/i })).toBeTruthy()
  })

  it('accepts an empty name, which is a group drawn as a bare colour', () => {
    // Legal on purpose: an unnamed group is the useful state while the user is still deciding, so it
    // has to be reachable again after naming one.
    const calls = installBridge()
    renderBar([tab('t1')], [group({ id: 'g1', tabIds: ['t1'], name: 'Work' })])

    fireEvent.doubleClick(screen.getByRole('button', { name: /Collapse group Work/i }))
    const input = screen.getByRole('textbox', { name: /Rename group/i })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(calls).toContainEqual({ channel: 'tabgroups:rename', payload: { id: 'g1', name: '' } })
  })
})

describe('reaching the group commands at all', () => {
  it('opens the native context menu on a right-click and suppresses Chromium own', () => {
    /*
      The only entry point to tab groups. Without it the whole feature is unreachable, which is a
      failure no unit test of the model would ever show.
    */
    const calls = installBridge()
    renderBar([tab('t1')], [])

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    document.querySelector('[data-tab-id="t1"]')?.dispatchEvent(event)

    expect(calls).toContainEqual({ channel: 'tabs:contextMenu', payload: { tabId: 't1' } })
    expect(event.defaultPrevented).toBe(true)
  })
})
