import { beforeEach, describe, expect, it } from 'vitest'
import { FindController, type FindHost } from '@main/find/FindController.js'
import { findInPageOptions, type FindTarget, type SearchablePage } from '@main/find/page-search.js'
import type { FindInPageOptions } from '@main/find/page-search.js'
import type { FindStopAction } from '@shared/find/session.js'
import {
  departureMatters,
  mayPresentOver,
  surfaceIdentity,
  type FindBarPresentation,
  type OverlayPresentation,
  type OverlayState
} from '@shared/overlay/surface.js'
import { FIND_BAR_INSET, FIND_BAR_WIDTH } from '@shared/find/bar.js'
import type { Rect } from '@shared/ui/anchor.js'
import type { Tab } from '@main/browser/Tab.js'
import type { BrowserWindowController } from '@main/browser/BrowserWindowController.js'

/**
 * Find in page against a fake page and a fake window.
 *
 * ## Why a fake page rather than a real one
 *
 * A find session is a sequence of stateful calls whose answers arrive later and repeatedly. The
 * mistakes it invites are ordering mistakes — an advance sent where a restart was needed, a stale
 * answer applied to a new query, a session left running after its bar is gone — and none of them
 * produces an error or looks wrong in a screenshot. A fake page is what makes the *sequence* the
 * subject of the test.
 *
 * ## Why the fake window behaves like the real layer
 *
 * The thing that clears a page's highlight is not the Escape key: it is the bar *leaving the overlay
 * layer*, whatever took it off. So the fake reproduces the three properties of `OverlayLayer` this
 * depends on — presenting is replacing, a replacement is ranked, and a departure that matters is
 * announced — because a fake that merely stored a presentation would let every one of those failures
 * through.
 */

type PageCall =
  | { call: 'find'; text: string; options: FindInPageOptions | undefined }
  | { call: 'stop'; action: FindStopAction }

class FakePage implements SearchablePage {
  destroyed = false
  readonly calls: PageCall[] = []
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  #requests = 0

  isDestroyed(): boolean {
    return this.destroyed
  }

  findInPage(text: string, options?: FindInPageOptions): number {
    this.calls.push({ call: 'find', text, options })
    this.#requests += 1
    return this.#requests
  }

  stopFindInPage(action: FindStopAction): void {
    this.calls.push({ call: 'stop', action })
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.#listeners.get(event) ?? []
    list.push(listener)
    this.#listeners.set(event, list)
    return this
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.#listeners.get(event) ?? []
    this.#listeners.set(
      event,
      list.filter((candidate) => candidate !== listener)
    )
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(...args)
  }

  /** How many subscriptions are still on this page, so a released session can be proved released. */
  get subscriptions(): number {
    return [...this.#listeners.values()].reduce((total, list) => total + list.length, 0)
  }

  /** The most recent search, so a test can answer it with the id it was given. */
  get lastRequestId(): number {
    return this.#requests
  }

  found(result: { requestId?: number; matches: number; activeMatch: number }): void {
    this.emit('found-in-page', {}, {
      requestId: result.requestId ?? this.#requests,
      matches: result.matches,
      activeMatchOrdinal: result.activeMatch,
      finalUpdate: true
    })
  }
}

class FakeTab implements FindTarget {
  readonly id: string
  tileIndex: number | null
  readonly view: { getBounds(): Rect; webContents: FakePage }

  constructor(id: string, tileIndex: number | null, bounds: Rect) {
    this.id = id
    this.tileIndex = tileIndex
    const page = new FakePage()
    this.view = { getBounds: () => bounds, webContents: page }
  }

  get page(): FakePage {
    return this.view.webContents
  }
}

const TILE_ONE: Rect = { x: 0, y: 88, width: 720, height: 812 }
const TILE_TWO: Rect = { x: 720, y: 88, width: 720, height: 812 }

class FakeWindow implements FindHost {
  overlay: OverlayState = null
  readonly presented: OverlayPresentation[] = []
  activeTile = 0
  tabs: FakeTab[] = []
  controller: FindController | null = null

  activeTab(): FindTarget | undefined {
    return this.tabs.find((tab) => tab.tileIndex === this.activeTile)
  }

  tab(tabId: string): FindTarget | undefined {
    return this.tabs.find((tab) => tab.id === tabId)
  }

  presentOverlay(presentation: OverlayPresentation): void {
    // Ranked, exactly as the real layer ranks it: a declined claim must leave the layer alone.
    if (!mayPresentOver(presentation.kind, this.overlay)) return
    const outgoing = this.overlay
    this.overlay = presentation
    this.presented.push(presentation)
    if (outgoing === null) return
    // An update is not a departure; see `surfaceIdentity`.
    if (surfaceIdentity(outgoing) === surfaceIdentity(presentation)) return
    this.#vacate(outgoing)
  }

  dismissOverlay(): void {
    const outgoing = this.overlay
    if (outgoing === null) return
    this.overlay = null
    this.#vacate(outgoing)
  }

  overlayPresentation(): OverlayState {
    return this.overlay
  }

  /** What the window controller does on a resize, on blur, and on a layout change. */
  dismissForItsOwnReasons(): void {
    this.dismissOverlay()
  }

  #vacate(presentation: OverlayPresentation): void {
    if (!departureMatters(presentation)) return
    this.controller?.overlayVacated(presentation)
  }
}

function windowWithTwoTiles(): { host: FakeWindow; first: FakeTab; second: FakeTab } {
  const host = new FakeWindow()
  const first = new FakeTab('tab-1', 0, TILE_ONE)
  const second = new FakeTab('tab-2', 1, TILE_TWO)
  host.tabs = [first, second]
  return { host, first, second }
}

function bar(host: FakeWindow): FindBarPresentation {
  const presentation = host.overlay
  if (presentation?.kind !== 'find-bar') throw new Error('no find bar is up')
  return presentation
}

function searches(page: FakePage): Array<Extract<PageCall, { call: 'find' }>> {
  return page.calls.filter((call): call is Extract<PageCall, { call: 'find' }> => call.call === 'find')
}

let find: FindController

beforeEach(() => {
  find = new FindController()
})

function open(host: FakeWindow): void {
  host.controller = find
  find.open(host)
}

describe('which tile Ctrl+F searches', () => {
  it('searches the active tile, not the first one', () => {
    /*
      The decision the whole feature turns on. With four pages on screen, a find bar that opened over
      a tile the user is not reading would be worse than none — and this call is identical in every
      visible respect either way, so only reading the payload can see it.
    */
    const { host, second } = windowWithTwoTiles()
    host.activeTile = 1
    open(host)

    expect(bar(host).tabId).toBe('tab-2')
    expect(bar(host).tileIndex).toBe(1)
    expect(searches(second.page)).toHaveLength(0)
  })

  it('anchors the bar to the tile it searches', () => {
    // Read from the searched view's own rectangle rather than recomputed from a layout, so the bar
    // cannot end up over a tile the page is not in.
    const { host } = windowWithTwoTiles()
    host.activeTile = 1
    open(host)

    expect(bar(host).bounds).toEqual({
      x: TILE_TWO.x + TILE_TWO.width - FIND_BAR_WIDTH - FIND_BAR_INSET,
      y: TILE_TWO.y + FIND_BAR_INSET,
      width: FIND_BAR_WIDTH,
      height: 40
    })
  })

  it('keeps searching its own tab when the active tile changes underneath it', () => {
    /*
      The tab is fixed when the bar opens. Resolved at message time instead, a keystroke typed into a
      bar over tile 1 would search tile 2 the moment something else made tile 2 active — and leave
      the highlight there, on a page whose bar nobody can close.
    */
    const { host, first, second } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, bar(host).tabId, 'needle')

    host.activeTile = 1
    find.setQuery(host, bar(host).tabId, 'needles')
    find.step(host, { forward: true })

    expect(searches(second.page)).toHaveLength(0)
    expect(searches(first.page).map((call) => call.text)).toEqual(['needle', 'needles', 'needles'])
  })

  it('declines the shortcut while a permission prompt holds the layer', () => {
    /*
      And searches nothing, which is the half that matters. `presentOverlay` refuses silently, so a
      search run before the refusal would leave the page scoped and highlighted with no bar anywhere
      to explain it — and a surface that was never presented never departs, so nothing would ever
      clear it.
    */
    const { host, first } = windowWithTwoTiles()
    host.controller = find
    host.presentOverlay({
      kind: 'permission-request',
      requestId: 'r1',
      origin: 'https://example.com',
      subject: 'camera',
      devices: ['camera'],
      waiting: 0
    })

    find.open(host)

    expect(host.overlay?.kind).toBe('permission-request')
    expect(first.page.calls).toEqual([])
    expect(find.sessionFor(host)).toBeNull()
  })

  it('does nothing at all when the active tile holds no tab', () => {
    // A find bar over an empty tile would be a text field whose every keystroke did nothing.
    const host = new FakeWindow()
    host.controller = find
    find.open(host)
    expect(host.overlay).toBeNull()
  })

  it('moves to the other tile when the shortcut is pressed there, clearing the first', () => {
    const { host, first, second } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')

    host.activeTile = 1
    find.open(host)

    expect(bar(host).tabId).toBe('tab-2')
    // Nothing else would ever stop the session on the tile left behind.
    expect(first.page.calls.at(-1)).toEqual({ call: 'stop', action: 'clearSelection' })
    expect(searches(second.page).map((call) => call.text)).toEqual(['needle'])
  })
})

describe("Electron's find options", () => {
  it('begins a new session for a restart and continues one for an advance', () => {
    /*
      `findNext` is Chromium's `new_session` flag under a name that reads like its opposite, so this is
      the mapping pinned. Backwards, every press of "next" would begin a fresh session and the
      highlight would return to the first match on the page each time — nothing would throw and the
      count would be right.
    */
    expect(findInPageOptions({ do: 'restart', tabId: 't', query: 'q', forward: true })).toEqual({
      forward: true,
      findNext: true
    })
    expect(findInPageOptions({ do: 'advance', tabId: 't', query: 'q', forward: false })).toEqual({
      forward: false,
      findNext: false
    })
  })

  it('never leaves the option to its default', () => {
    // The documented default has been the opposite of the implementation's before now, so both
    // directions are always stated.
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    first.page.found({ matches: 4, activeMatch: 1 })
    find.step(host, { forward: true })

    expect(searches(first.page)).toEqual([
      { call: 'find', text: 'needle', options: { forward: true, findNext: true } },
      { call: 'find', text: 'needle', options: { forward: true, findNext: false } }
    ])
  })
})

describe('a query changed mid-search', () => {
  it('restarts the search rather than advancing it', () => {
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'need')
    first.page.found({ matches: 9, activeMatch: 1 })
    find.setQuery(host, 'tab-1', 'needl')

    expect(searches(first.page).at(-1)).toEqual({
      call: 'find',
      text: 'needl',
      options: { forward: true, findNext: true }
    })
  })

  it('drops the previous count instead of showing it against the new text', () => {
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'need')
    first.page.found({ matches: 9, activeMatch: 4 })
    expect(bar(host).matches).toBe(9)

    find.setQuery(host, 'tab-1', 'needl')
    expect(bar(host).matches).toBeNull()
    expect(bar(host).activeMatch).toBe(0)
  })

  it('stops the search when the field is emptied', () => {
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    find.setQuery(host, 'tab-1', '')

    expect(first.page.calls.at(-1)).toEqual({ call: 'stop', action: 'clearSelection' })
    // The bar stays: the field is empty, not gone.
    expect(bar(host).query).toBe('')
  })

  it('keeps the search on one session, so the caret is not thrown out of the field', () => {
    const { host } = windowWithTwoTiles()
    open(host)
    const opened = bar(host).sessionId
    find.setQuery(host, 'tab-1', 'need')
    find.setQuery(host, 'tab-1', 'needl')
    expect(bar(host).sessionId).toBe(opened)
  })
})

describe('answers arriving from the page', () => {
  it('shows the count it is given', () => {
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    first.page.found({ matches: 12, activeMatch: 3 })

    expect(bar(host).matches).toBe(12)
    expect(bar(host).activeMatch).toBe(3)
  })

  it('ignores an answer to a search that has been superseded', () => {
    /*
      Type "abc" and the answers for "ab" are still on their way, carrying a count for text that is no
      longer in the field. Without the request id the bar would settle on whichever arrived last.
    */
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'ab')
    const stale = first.page.lastRequestId
    find.setQuery(host, 'tab-1', 'abc')

    first.page.found({ requestId: stale, matches: 99, activeMatch: 7 })
    expect(bar(host).matches).toBeNull()
  })

  it('does not present again for the repeat Chromium sends as its final update', () => {
    // Every presentation focuses the layer, which is a keystroke's worth of interference for no
    // change on screen.
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    first.page.found({ matches: 4, activeMatch: 1 })
    const shown = host.presented.length
    first.page.found({ matches: 4, activeMatch: 1 })

    expect(host.presented.length).toBe(shown)
  })

  it('drops an answer that arrives after the search was stopped', () => {
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    find.setQuery(host, 'tab-1', '')
    first.page.found({ matches: 5, activeMatch: 2 })

    expect(bar(host).matches).toBeNull()
  })
})

describe('walking through matches', () => {
  it('advances the search that is running', () => {
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    first.page.found({ matches: 4, activeMatch: 1 })
    find.step(host, { forward: true })
    first.page.found({ matches: 4, activeMatch: 2 })

    expect(bar(host).activeMatch).toBe(2)
  })

  it('opens the bar when the shortcut is pressed with none up', () => {
    // `F3` before `Ctrl+F` should find the last thing searched for rather than doing nothing.
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    host.dismissForItsOwnReasons()
    expect(host.overlay).toBeNull()

    host.controller = find
    find.step(host, { forward: true })

    expect(bar(host).query).toBe('needle')
    expect(searches(first.page).at(-1)?.text).toBe('needle')
  })

  it('ignores a step naming a tab that is not the one being searched', () => {
    const { host, second } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    find.step(host, { tabId: 'tab-2', forward: true })

    expect(searches(second.page)).toHaveLength(0)
  })
})

describe('the page navigating under an open bar', () => {
  it('restarts the search on the new document rather than advancing into it', () => {
    /*
      Chromium keeps a find session per document, so the one running before the navigation is gone.
      An advance against the new page steps through a search that was never started there.
    */
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    first.page.found({ matches: 4, activeMatch: 1 })

    first.page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(bar(host).matches).toBeNull()

    find.step(host, { forward: true })
    expect(searches(first.page).at(-1)?.options).toEqual({ forward: true, findNext: true })
  })

  it('searches the new document by itself once it has loaded', () => {
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    first.page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    first.page.emit('did-stop-loading')

    expect(searches(first.page)).toHaveLength(2)
    expect(searches(first.page).at(-1)?.options).toEqual({ forward: true, findNext: true })
  })

  it('is unmoved by a subframe navigating', () => {
    // On an advertisement-heavy page an iframe reloads every few seconds; read as a document change,
    // the user's position in the search would reset each time.
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    first.page.found({ matches: 4, activeMatch: 2 })
    first.page.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })

    expect(bar(host).matches).toBe(4)
    expect(bar(host).activeMatch).toBe(2)
  })
})

describe('the highlight is taken off the page whenever the bar leaves the layer', () => {
  it('clears it on Escape, rather than only closing the bar', () => {
    /*
      The trap this is here for. `findInPage` marks its match in the document and only
      `stopFindInPage` unmarks it — and only with `clearSelection`: `keepSelection` translates the
      match into an ordinary selection, so the highlight stays on a page whose bar has gone. Escape
      reaches the core as a plain overlay dismissal, exactly like every other way out, and the
      clearing hangs off the departure.
    */
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')

    host.dismissOverlay()

    expect(first.page.calls.at(-1)).toEqual({ call: 'stop', action: 'clearSelection' })
    expect(find.sessionFor(host)).toBeNull()
  })

  it('clears it when the window resizes or loses focus', () => {
    // The window controller dismisses this layer on both, and knows nothing about find in page.
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')

    host.dismissForItsOwnReasons()

    expect(first.page.calls.at(-1)).toEqual({ call: 'stop', action: 'clearSelection' })
  })

  it('clears it when a permission prompt takes the layer', () => {
    /*
      A prompt outranks the bar, so the bar is displaced rather than declined — and a displaced bar is
      a bar whose page keeps its highlight unless the departure is acted on.
    */
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')

    host.presentOverlay({
      kind: 'permission-request',
      requestId: 'r1',
      origin: 'https://example.com',
      subject: 'camera',
      devices: ['camera'],
      waiting: 0
    })

    expect(first.page.calls.at(-1)).toEqual({ call: 'stop', action: 'clearSelection' })
    // The prompt keeps the layer: nothing here dismisses it on the bar's way out.
    expect(host.overlay?.kind).toBe('permission-request')
  })

  it('does not clear it for its own count updates', () => {
    // The same surface presented again is an update, not a departure. Announced as one, the bar would
    // clear its own highlight on its first result.
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    first.page.found({ matches: 4, activeMatch: 1 })
    first.page.found({ matches: 4, activeMatch: 2 })

    expect(first.page.calls.filter((call) => call.call === 'stop')).toEqual([])
    expect(bar(host).activeMatch).toBe(2)
  })

  it('ignores the departure of a surface that is not a find bar', () => {
    // The announcement is shared with the permission arbiter, so every listener has to recognise its
    // own surfaces. Acted on, an answered prompt leaving the layer would clear a live search.
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')

    find.overlayVacated({
      kind: 'permission-request',
      requestId: 'r1',
      origin: 'https://example.com',
      subject: 'camera',
      devices: [],
      waiting: 0
    })

    expect(first.page.calls.filter((call) => call.call === 'stop')).toEqual([])
    expect(find.sessionFor(host)).not.toBeNull()
  })

  it('ignores the departure of a bar from another window', () => {
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')

    find.overlayVacated({ ...bar(host), sessionId: 'find-elsewhere' })

    expect(first.page.calls.filter((call) => call.call === 'stop')).toEqual([])
  })

  it('ignores a found-in-page payload it cannot read', () => {
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    first.page.emit('found-in-page', {}, { matches: 3 })

    expect(bar(host).matches).toBeNull()
  })

  it('gives the page back its own event handlers', () => {
    // Every subscription gets a way off (spec 6): a closed session must not leave a listener
    // reporting into a bar that is gone.
    const { host, first } = windowWithTwoTiles()
    open(host)
    expect(first.page.subscriptions).toBeGreaterThan(0)

    host.dismissOverlay()
    expect(first.page.subscriptions).toBe(0)
  })

  it('remembers the query for the next time the shortcut is pressed', () => {
    const { host } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    host.dismissOverlay()

    host.controller = find
    find.open(host)
    expect(bar(host).query).toBe('needle')
  })
})

describe('the page going away under the bar', () => {
  it('takes the bar down when the searched tab leaves its tile', () => {
    // A bar over a page that is no longer on screen would be counting matches in something invisible.
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')

    first.tileIndex = null
    find.step(host, { forward: true })

    expect(host.overlay).toBeNull()
    expect(find.sessionFor(host)).toBeNull()
  })

  it('takes the bar down when the searched tab is closed', () => {
    const { host } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')

    host.tabs = host.tabs.filter((tab) => tab.id !== 'tab-1')
    find.step(host, { forward: true })

    expect(host.overlay).toBeNull()
  })

  it('asks nothing of a destroyed page', () => {
    const { host, first } = windowWithTwoTiles()
    open(host)
    find.setQuery(host, 'tab-1', 'needle')
    const calls = first.page.calls.length

    first.page.destroyed = true
    host.dismissOverlay()

    // Its document, its find session and its highlight went together.
    expect(first.page.calls.length).toBe(calls)
  })

  it('opens with no subscription at all when the tab has already gone', () => {
    const host = new FakeWindow()
    const tab = new FakeTab('tab-1', 0, TILE_ONE)
    host.tabs = [tab]
    host.controller = find
    tab.page.destroyed = true

    find.open(host)
    expect(tab.page.subscriptions).toBe(0)
    // Nothing was searched, so there is no bar claiming a count it can never get.
    expect(searches(tab.page)).toHaveLength(0)
  })
})

describe('the shapes the core actually passes in', () => {
  it('accepts a real tab as something to search', () => {
    // A compile-time check with a runtime assertion to hold it: if `Tab` ever stops satisfying
    // `FindTarget`, this file fails to build rather than the wiring failing to compile somewhere else.
    const asTarget: (tab: Tab) => FindTarget = (tab) => tab
    expect(typeof asTarget).toBe('function')
  })

  it('accepts a real window as somewhere to show a bar', () => {
    const asHost: (controller: BrowserWindowController) => FindHost = (controller) => controller
    expect(typeof asHost).toBe('function')
  })
})
