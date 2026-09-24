import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabBar } from '@renderer/components/TabBar.js'
import { edgeScrollStep } from '@renderer/useTabDrag.js'
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
  vi.unstubAllGlobals()
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

describe("a tab's icon", () => {
  it('cannot be dragged out, because the address carries the cache token', () => {
    /*
      Here rather than in a file of its own because this file already has the strip's bridge and
      fixtures. The icon cache answers only an address carrying this run's token, which is what keeps
      a web page from asking it which sites the user has been to; an icon dragged into a page would
      hand that address over.
    */
    installBridge()
    renderBar([tab('t1', { faviconUrl: 'tessera://favicon?site=example.com&v=1&t=token' })], [])

    const icon = document.querySelector('[data-tab-id="t1"] img.tab__faviconImage')
    expect(icon?.getAttribute('src')).toContain('tessera://favicon')
    expect(icon?.getAttribute('draggable')).toBe('false')
  })
})

describe('an unloaded tab in the strip (U15)', () => {
  it('is drawn dimmed and says why, a loaded one is not', () => {
    installBridge()
    renderBar([tab('t1'), tab('t2', { unloaded: true })], [])
    const loaded = document.querySelector('[data-tab-id="t1"]')
    const unloaded = document.querySelector('[data-tab-id="t2"]')
    expect(loaded?.className).not.toContain('tab--unloaded')
    expect(unloaded?.className).toContain('tab--unloaded')
    expect(unloaded?.getAttribute('title')).toMatch(/Unloaded/)
    expect(loaded?.getAttribute('title')).not.toMatch(/Unloaded/)
  })

  it('keeps an unloaded member of a folded group counted on its chip', () => {
    installBridge()
    renderBar(
      [tab('t1'), tab('t2', { unloaded: true })],
      [group({ id: 'g1', tabIds: ['t2'], name: 'Later', collapsed: true })]
    )
    expect(document.querySelector('[data-tab-id="t2"]')).toBeNull()
    expect(screen.getByRole('button', { name: /Expand group Later/i }).textContent).toContain('1')
  })
})

// --- a strip with more tabs than room (U22, R32) ------------------------------------------------------

function bar(tabs: TabState[], groups: TabGroup[], activeTabId: string | null): React.ReactElement {
  return (
    <TabBar
      tabs={tabs}
      groups={groups}
      activeTabId={activeTabId}
      split={null}
      leftInset={0}
      rightInset={0}
      titleWithShortcut={shortcutTitles('win32')}
    />
  )
}

function strip(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.tabbar__strip')
  if (element === null) throw new Error('no strip rendered')
  return element
}

/**
 * The strip's scroll geometry, which happy-dom does not lay out: every element is zero wide there.
 *
 * On the prototype rather than on the element, so the numbers are already true for the measurement the
 * strip takes as it mounts. Only the strip is given a size; every other element keeps happy-dom's own.
 */
function stripGeometry(geometry: { scrollWidth: number; clientWidth: number }): void {
  const isStrip = (element: Element): boolean => element.classList.contains('tabbar__strip')
  const scrollWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
    return isStrip(this) ? geometry.scrollWidth : (scrollWidth?.get?.call(this) as number)
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return isStrip(this) ? geometry.clientWidth : (clientWidth?.get?.call(this) as number)
  })
}

const edges = (): string[] =>
  ['tabbar__strip--more-left', 'tabbar__strip--more-right'].filter((name) =>
    strip().classList.contains(name)
  )

describe('keeping the active tab in sight', () => {
  it('scrolls the tab that becomes active into view, along the strip only', () => {
    installBridge()
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    const tabs = [tab('t1'), tab('t2'), tab('t3')]
    const { rerender } = render(bar(tabs, [], 't1'))
    scrolled.mockClear()

    rerender(bar(tabs, [], 't3'))

    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' })
    expect(scrolled.mock.contexts[0]).toBe(document.querySelector('[data-tab-id="t3"]'))
  })

  it('does not scroll the strip back while the active tab stays the same', () => {
    installBridge()
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { rerender } = render(bar([tab('t1'), tab('t2')], [], 't1'))
    scrolled.mockClear()

    // A tab opened in the background, or a title arriving: the user may be looking elsewhere.
    rerender(bar([tab('t1'), tab('t2', { title: 'Loaded' }), tab('t3')], [], 't1'))

    expect(scrolled).not.toHaveBeenCalled()
  })

  it('scrolls to the active tab once the folded group that hid it opens', () => {
    installBridge()
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    const tabs = [tab('t1'), tab('t2')]
    const folded = group({ id: 'g1', tabIds: ['t2'], collapsed: true })
    const { rerender } = render(bar(tabs, [folded], 't2'))
    // Not drawn, so there is nothing to scroll to yet.
    expect(scrolled).not.toHaveBeenCalled()

    rerender(bar(tabs, [{ ...folded, collapsed: false }], 't2'))

    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled.mock.contexts[0]).toBe(document.querySelector('[data-tab-id="t2"]'))
  })
})

describe('showing that the strip goes on', () => {
  it('shows no edge while every tab fits', () => {
    installBridge()
    stripGeometry({ scrollWidth: 400, clientWidth: 400 })
    render(bar([tab('t1'), tab('t2')], [], 't1'))
    expect(edges()).toEqual([])
  })

  it('shows the right edge when the tabs are wider than the strip', () => {
    installBridge()
    stripGeometry({ scrollWidth: 900, clientWidth: 400 })
    render(bar([tab('t1'), tab('t2')], [], 't1'))
    expect(edges()).toEqual(['tabbar__strip--more-right'])
  })

  it('follows the scroll position: both edges in the middle, only the left at the end', () => {
    installBridge()
    stripGeometry({ scrollWidth: 900, clientWidth: 400 })
    render(bar([tab('t1'), tab('t2')], [], 't1'))

    strip().scrollLeft = 200
    fireEvent.scroll(strip())
    expect(edges()).toEqual(['tabbar__strip--more-left', 'tabbar__strip--more-right'])

    strip().scrollLeft = 500
    fireEvent.scroll(strip())
    expect(edges()).toEqual(['tabbar__strip--more-left'])
  })

  it('measures again when the tabs change, not only when the strip is scrolled', () => {
    installBridge()
    const geometry = { scrollWidth: 400, clientWidth: 400 }
    stripGeometry(geometry)
    const { rerender } = render(bar([tab('t1')], [], 't1'))
    expect(edges()).toEqual([])

    geometry.scrollWidth = 700
    rerender(bar([tab('t1'), tab('t2'), tab('t3')], [], 't1'))

    expect(edges()).toEqual(['tabbar__strip--more-right'])
  })
})

describe('scrolling the strip with a mouse wheel', () => {
  /*
    A wheel turns vertically and the strip only scrolls sideways, so without this a mouse user could
    reach the hidden tabs only by dragging one there. A trackpad's sideways swipe is left to Chromium,
    which scrolls an overflowing strip along its own axis already.
  */
  it('turns a vertical wheel into a sideways scroll when the tabs do not fit', () => {
    installBridge()
    stripGeometry({ scrollWidth: 900, clientWidth: 400 })
    render(bar([tab('t1'), tab('t2')], [], 't1'))
    fireEvent.wheel(strip(), { deltaY: 120, deltaX: 0 })
    expect(strip().scrollLeft).toBe(120)
    fireEvent.wheel(strip(), { deltaY: -40, deltaX: 0 })
    expect(strip().scrollLeft).toBe(80)
  })

  it('leaves a sideways gesture, and a strip where everything fits, alone', () => {
    installBridge()
    const geometry = { scrollWidth: 900, clientWidth: 400 }
    stripGeometry(geometry)
    render(bar([tab('t1'), tab('t2')], [], 't1'))
    fireEvent.wheel(strip(), { deltaY: 10, deltaX: 60 })
    expect(strip().scrollLeft).toBe(0)
    geometry.scrollWidth = 400
    fireEvent.wheel(strip(), { deltaY: 120, deltaX: 0 })
    expect(strip().scrollLeft).toBe(0)
  })
})

describe('scrolling the strip while a tab is dragged to its edge', () => {
  const BOX = { left: 0, right: 400, top: 0, bottom: 36 }
  const stripBox = (): DOMRect => ({
    ...BOX,
    x: 0,
    y: 0,
    width: 400,
    height: 36,
    toJSON: () => ({})
  })

  it('scrolls toward an edge the pointer is near, faster the nearer it is', () => {
    expect(edgeScrollStep(BOX, 200, 10)).toBe(0)
    const near = edgeScrollStep(BOX, 390, 10)
    const nearer = edgeScrollStep(BOX, 399, 10)
    expect(near).toBeGreaterThan(0)
    expect(nearer).toBeGreaterThan(near)
    expect(edgeScrollStep(BOX, 10, 10)).toBeLessThan(0)
    expect(edgeScrollStep(BOX, 10, 10)).toBe(-near)
  })

  it('scrolls at full speed past the edge, and not at all above or below the strip', () => {
    expect(edgeScrollStep(BOX, 460, 10)).toBe(edgeScrollStep(BOX, 400, 10))
    expect(edgeScrollStep(BOX, -60, 10)).toBe(-edgeScrollStep(BOX, 400, 10))
    expect(edgeScrollStep(BOX, 399, 80)).toBe(0)
    expect(edgeScrollStep(BOX, 399, -5)).toBe(0)
  })

  it('keeps scrolling while the pointer rests at the edge, and stops when it leaves or lets go', () => {
    installBridge()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const runFrames = (): void => {
      for (const callback of frames.splice(0)) callback(0)
    }

    render(bar([tab('t1'), tab('t2')], [], 't1'))
    vi.spyOn(strip(), 'getBoundingClientRect').mockReturnValue(stripBox())

    const first = document.querySelector('[data-tab-id="t1"]') as HTMLElement
    fireEvent.pointerDown(first, { button: 0, clientX: 20, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 398, clientY: 10 })

    runFrames()
    const once = strip().scrollLeft
    expect(once).toBeGreaterThan(0)
    // No further pointer movement: the pointer is resting at the edge, and the strip keeps going.
    runFrames()
    expect(strip().scrollLeft).toBeGreaterThan(once)

    fireEvent.pointerMove(window, { clientX: 200, clientY: 10 })
    const resting = strip().scrollLeft
    runFrames()
    runFrames()
    expect(strip().scrollLeft).toBe(resting)

    fireEvent.pointerMove(window, { clientX: 2, clientY: 10 })
    fireEvent.pointerUp(window, { clientX: 2, clientY: 10 })
    runFrames()
    expect(strip().scrollLeft).toBe(resting)
  })

  it('does not scroll for a press that never became a drag', () => {
    installBridge()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    render(bar([tab('t1')], [], 't1'))
    vi.spyOn(strip(), 'getBoundingClientRect').mockReturnValue(stripBox())
    const first = document.querySelector('[data-tab-id="t1"]') as HTMLElement
    fireEvent.pointerDown(first, { button: 0, clientX: 398, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 399, clientY: 10 })
    for (const callback of frames.splice(0)) callback(0)
    expect(frames).toEqual([])
    expect(strip().scrollLeft).toBe(0)
  })
})
