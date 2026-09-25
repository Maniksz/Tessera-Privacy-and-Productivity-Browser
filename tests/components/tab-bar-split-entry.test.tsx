import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { TabBar } from '@renderer/components/TabBar.js'
import type { ArrangementSummary } from '@shared/arrangements/screen.js'
import type { TabState } from '@shared/model.js'
import type { TabGroup } from '@shared/tabgroups/model.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'

/**
 * A tiled view in the tab strip: one entry for all of its pages (U7, R1, R2, R5, R6).
 *
 * What goes wrong in the product when a rule here is wrong:
 *
 *   - **Members drawn as tabs** bring back the "three tabs numbered 1, 2, 3" between the user's other
 *     tabs that the plan exists to remove (R1).
 *   - **An entry that asks for a tab** rather than for its view by id would bring the view back on
 *     whichever member was clicked last, not on the tile that had focus (R4).
 *   - **A speaker that reads one member** would say "loud" while the page playing is muted, and a
 *     click would then unmute the one the user had silenced on purpose (R6, KTD11).
 *
 * The bridge is replaced, as in `tab-bar-groups.test.tsx`: `bridge.ts` reads `window.tessera` on every
 * call, which is the seam a sandboxed renderer actually has.
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

function view(
  id: string,
  tabIds: string[],
  overrides: Partial<ArrangementSummary> = {}
): ArrangementSummary {
  return {
    id,
    layoutId: '1x2',
    tabIds,
    activeTile: 0,
    activeTabId: tabIds[0] ?? null,
    visible: false,
    ...overrides
  }
}

function renderBar(
  tabs: TabState[],
  arrangements: ArrangementSummary[],
  activeTabId: string | null = tabs[0]?.id ?? null,
  groups: TabGroup[] = []
): void {
  render(
    <TabBar
      tabs={tabs}
      groups={groups}
      arrangements={arrangements}
      activeTabId={activeTabId}
      leftInset={0}
      rightInset={0}
      titleWithShortcut={shortcutTitles('win32')}
    />
  )
}

function entry(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-arrangement-id]')
  if (element === null) throw new Error('no tiled-view entry rendered')
  return element
}

afterEach(cleanup)

describe('a tiled view in the strip', () => {
  it('is one entry beside the loose tab, with a favicon per member and the active tile title', () => {
    installBridge()
    renderBar(
      [
        tab('X', { title: 'Mail' }),
        tab('A1', { title: 'YouTube' }),
        tab('A2', { title: 'Twitch' })
      ],
      [view('A', ['A1', 'A2'], { activeTile: 1, activeTabId: 'A2' })]
    )

    // One loose tab and one entry, and the members are not tabs of their own.
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(document.querySelector('[data-tab-id="A1"]')).toBeNull()
    expect(document.querySelector('[data-tab-id="A2"]')).toBeNull()

    expect(entry().dataset.arrangementId).toBe('A')
    expect(entry().querySelectorAll('.tab__favicon')).toHaveLength(2)
    expect(entry().querySelector('.tab__title')?.textContent).toBe('Twitch')
  })

  it('draws the favicons in tile order', () => {
    installBridge()
    renderBar(
      [
        tab('A2', { faviconUrl: 'tessera://favicon?site=two' }),
        tab('A1', { faviconUrl: 'tessera://favicon?site=one' })
      ],
      [view('A', ['A1', 'A2'])]
    )
    const sources = [...entry().querySelectorAll('img')].map((image) => image.getAttribute('src'))
    expect(sources).toEqual(['tessera://favicon?site=one', 'tessera://favicon?site=two'])
  })

  it('shows no tile number anywhere, also in a 2x2 layout', () => {
    installBridge()
    const tabs = ['A1', 'A2', 'A3', 'A4'].map((id, index) =>
      tab(id, { tileIndex: index, title: 'Page' })
    )
    renderBar([tab('X'), ...tabs], [view('A', ['A1', 'A2', 'A3', 'A4'], { layoutId: '2x2' })])

    expect(document.querySelector('.tab__tile')).toBeNull()
    const strip = document.querySelector('.tabbar__strip')?.textContent ?? ''
    expect(strip).not.toMatch(/[1-4]/)
    expect(document.body.innerHTML).not.toMatch(/In tile/)
  })

  it('names every title in its tooltip and its accessible name, and marks the active one', () => {
    installBridge()
    renderBar(
      [tab('A1', { title: 'YouTube' }), tab('A2', { title: 'Twitch' })],
      [view('A', ['A1', 'A2'], { activeTile: 1, activeTabId: 'A2' })]
    )

    expect(entry().getAttribute('title')).toBe('YouTube\nTwitch')
    const name = entry().getAttribute('aria-label') ?? ''
    expect(name).toMatch(/YouTube/)
    expect(name).toMatch(/Twitch \(active tile\)/)
    expect(name).not.toMatch(/YouTube \(active tile\)/)
    expect(screen.getByRole('tab', { name: /Tiled view/ })).toBe(entry())
  })

  it('is selected and focusable while one of its members is the active tab', () => {
    installBridge()
    renderBar([tab('X'), tab('A1'), tab('A2')], [view('A', ['A1', 'A2'])], 'A2')

    expect(entry().getAttribute('aria-selected')).toBe('true')
    expect(entry().tabIndex).toBe(0)
    expect(entry().className).toContain('tab--active')
    const loose = document.querySelector<HTMLElement>('[data-tab-id="X"]')
    expect(loose?.getAttribute('aria-selected')).toBe('false')
    expect(loose?.tabIndex).toBe(-1)
  })

  it('is neither while a loose tab is active', () => {
    installBridge()
    renderBar([tab('X'), tab('A1'), tab('A2')], [view('A', ['A1', 'A2'])], 'X')
    expect(entry().getAttribute('aria-selected')).toBe('false')
    expect(entry().tabIndex).toBe(-1)
  })

  it('counts as one on the chip of a folded group', () => {
    installBridge()
    renderBar([tab('A1'), tab('A2'), tab('g1'), tab('X')], [view('A', ['A1', 'A2'])], 'X', [
      group({ id: 'G', tabIds: ['A1', 'A2', 'g1'], collapsed: true, name: 'Sport' })
    ])
    expect(document.querySelector('.tabgroup__count')?.textContent).toBe('2')
    expect(document.querySelector('[data-arrangement-id]')).toBeNull()
  })

  it('wears its group band like a tab', () => {
    installBridge()
    renderBar([tab('A1'), tab('A2')], [view('A', ['A1', 'A2'])], 'A1', [
      group({ id: 'G', tabIds: ['A1', 'A2'], color: 'green' })
    ])
    expect(entry().className).toContain('tab--grouped')
    expect(entry().className).toContain('tab--group-only')
    expect(entry().style.getPropertyValue('--tab-group-current')).toBe('var(--tab-group-green)')
  })
})

describe('acting on the entry', () => {
  it('brings the view back by its id on a click', () => {
    const calls = installBridge()
    renderBar([tab('X'), tab('A1'), tab('A2')], [view('A', ['A1', 'A2'])], 'X')
    fireEvent.click(entry())
    expect(calls).toEqual([{ channel: 'arrangements:activate', payload: { id: 'A' } }])
  })

  it('brings it back from the keyboard too', () => {
    const calls = installBridge()
    renderBar([tab('X'), tab('A1'), tab('A2')], [view('A', ['A1', 'A2'])], 'X')
    fireEvent.keyDown(entry(), { key: 'Enter' })
    expect(calls).toContainEqual({ channel: 'arrangements:activate', payload: { id: 'A' } })
  })

  it('closes the whole view from its close button, without bringing it back first', () => {
    const calls = installBridge()
    renderBar([tab('X'), tab('A1'), tab('A2')], [view('A', ['A1', 'A2'])], 'X')
    const close = entry().querySelector<HTMLButtonElement>('.tab__close')
    fireEvent.click(close!)
    expect(calls).toEqual([{ channel: 'arrangements:close', payload: { id: 'A' } }])
  })

  it('closes the whole view on a middle click', () => {
    const calls = installBridge()
    renderBar([tab('X'), tab('A1'), tab('A2')], [view('A', ['A1', 'A2'])], 'X')
    fireEvent(entry(), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(calls).toEqual([{ channel: 'arrangements:close', payload: { id: 'A' } }])
  })

  it("opens the view's own menu on a right-click and suppresses Chromium's", () => {
    const calls = installBridge()
    renderBar([tab('X'), tab('A1'), tab('A2')], [view('A', ['A1', 'A2'])], 'X')
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    entry().dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(calls).toEqual([{ channel: 'arrangements:contextMenu', payload: { id: 'A' } }])
  })
})

describe("the entry's speaker", () => {
  function speaker(): HTMLButtonElement | null {
    return entry().querySelector<HTMLButtonElement>('.tab__mute')
  }

  it('is absent while no member plays sound', () => {
    installBridge()
    renderBar([tab('A1'), tab('A2')], [view('A', ['A1', 'A2'])])
    expect(speaker()).toBeNull()
  })

  it('appears for one audible member, and a click mutes the whole view', () => {
    const calls = installBridge()
    renderBar([tab('A1'), tab('A2', { audible: true })], [view('A', ['A1', 'A2'])])

    expect(speaker()?.getAttribute('aria-label')).toBe('Mute tiled view')
    fireEvent.click(speaker()!)
    expect(calls).toEqual([{ channel: 'arrangements:setMuted', payload: { id: 'A', muted: true } }])
  })

  it('says loud while one audible member is muted and another is not, and mutes all', () => {
    const calls = installBridge()
    renderBar(
      [tab('A1', { audible: true, muted: true }), tab('A2', { audible: true })],
      [view('A', ['A1', 'A2'])]
    )
    expect(speaker()?.getAttribute('aria-label')).toBe('Mute tiled view')
    fireEvent.click(speaker()!)
    expect(calls).toEqual([{ channel: 'arrangements:setMuted', payload: { id: 'A', muted: true } }])
  })

  it('says muted once every audible member is, a silent one aside, and unmutes all', () => {
    const calls = installBridge()
    renderBar(
      [
        tab('A1', { audible: true, muted: true }),
        tab('A2'),
        tab('A3', { audible: true, muted: true })
      ],
      [view('A', ['A1', 'A2', 'A3'])]
    )
    expect(speaker()?.getAttribute('aria-label')).toBe('Unmute tiled view')
    fireEvent.click(speaker()!)
    expect(calls).toEqual([
      { channel: 'arrangements:setMuted', payload: { id: 'A', muted: false } }
    ])
  })
})

describe('the loose tabs beside it', () => {
  it('carry no tile label and no "not shown" dimming any more', () => {
    installBridge()
    renderBar([tab('X', { title: 'Mail', tileIndex: null }), tab('Y', { tileIndex: 0 })], [])
    const loose = document.querySelector<HTMLElement>('[data-tab-id="X"]')
    expect(loose?.getAttribute('title')).toBe('Mail')
    expect(loose?.className).not.toContain('tab--unassigned')
  })
})
