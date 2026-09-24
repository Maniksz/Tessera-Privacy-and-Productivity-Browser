import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import {
  registerOmniboxHandlers,
  type OmniboxHandle,
  type OmniboxTab,
  type OmniboxWindow
} from '@main/ipc/omnibox-handlers.js'
import { queryHistory, type HistoryVisit } from '@shared/history/model.js'
import { queryBookmarks, type Bookmark } from '@shared/bookmarks/model.js'
import type { QuickLink } from '@shared/quicklinks/model.js'
import type {
  OmniboxSuggestRequest,
  OmniboxSuggestionsPresentation
} from '@shared/omnibox/model.js'
import {
  mayPresentOver,
  type OverlayPresentation,
  type OverlayState
} from '@shared/overlay/surface.js'
import { FIND_BAR_HEIGHT, FIND_BAR_WIDTH } from '@shared/find/bar.js'
import {
  defaultSettings,
  type SettingsKey,
  type SettingsSnapshot,
  type SettingValue
} from '@shared/settings/definitions.js'

/**
 * `omnibox:suggest` and `omnibox:close` (U18, R28–R30, KTD12).
 *
 * Driven through the registrar with a fake window, fake stores and the real overlay precedence, so what
 * is pinned is what a keystroke actually does: which stores are read under which switches, what a private
 * window is offered, that a stale number changes nothing, and that an open find bar keeps its layer.
 */

const EVENT = undefined as unknown as IpcMainInvokeEvent
const NOW = Date.UTC(2026, 8, 24, 12)
const DAY = 86_400_000
const ANCHOR = { x: 200, y: 44, width: 600, height: 28 }

function visit(url: string, title: string, visitCount = 1, daysAgo = 1): HistoryVisit {
  const at = NOW - daysAgo * DAY
  return { url, title, firstVisitedAt: at, lastVisitedAt: at, visitCount }
}

function bookmark(id: string, url: string, title: string): Bookmark {
  return { id, kind: 'bookmark', title, url, parentId: 'bar', createdAt: NOW }
}

function tab(id: string, url: string, title: string): OmniboxTab {
  return { id, toState: () => ({ url, title }) }
}

interface FakeWindow extends OmniboxWindow {
  shown: OverlayState
  presented: OmniboxSuggestionsPresentation[]
}

/** Two tabs; `front` is the active one, the tab the address bar speaks for. */
function fakeWindow(options: { privateMode?: boolean; tabs?: OmniboxTab[] } = {}): FakeWindow {
  const tabs = options.tabs ?? [
    tab('front', 'https://front.example/', 'Front page'),
    tab('t2', 'https://wiki.team.example/', 'Team wiki')
  ]
  const window: FakeWindow = {
    privateMode: options.privateMode ?? false,
    tabs,
    shown: null,
    presented: [],
    activeTab: () => tabs[0],
    overlayPresentation: () => window.shown,
    // The real ranking, so a list that may not take the layer is declined exactly as the layer would.
    presentOverlay: (presentation) => {
      window.presented.push(presentation)
      if (mayPresentOver(presentation.kind, window.shown)) window.shown = presentation
    },
    dismissOverlayKind: (kind) => {
      if (window.shown?.kind !== kind) return false
      window.shown = null
      return true
    }
  }
  return window
}

interface Stores {
  history: HistoryVisit[]
  bookmarks: Bookmark[]
  quickLinks: QuickLink[]
}

interface Harness {
  window: FakeWindow
  reads: string[]
  suggest(request: Partial<OmniboxSuggestRequest> & { text: string }): void
  close(): void
  rows(): string[]
}

function harness(
  options: {
    window?: FakeWindow | undefined
    settings?: Partial<SettingsSnapshot>
    stores?: Partial<Stores>
    /** Leaves the clock out, so the handler ranks against the real one. */
    realClock?: boolean
  } = {}
): Harness {
  const window = options.window ?? fakeWindow()
  const values: SettingsSnapshot = { ...defaultSettings(), ...options.settings }
  const stores: Stores = {
    history: [visit('https://en.wikipedia.org/wiki/Main_Page', 'Wikipedia', 5)],
    bookmarks: [bookmark('b1', 'https://wiki.example.org/', 'Company wiki')],
    quickLinks: [],
    ...options.stores
  }
  const reads: string[] = []
  const handlers = new Map<string, (payload: unknown, event: IpcMainInvokeEvent) => unknown>()
  const handle = ((
    channel: string,
    handler: (payload: unknown, event: IpcMainInvokeEvent) => unknown
  ) => handlers.set(channel, handler)) as unknown as OmniboxHandle

  registerOmniboxHandlers<FakeWindow>({
    handle,
    windows: { resolve: () => ('window' in options ? options.window : window) },
    settings: { get: <K extends SettingsKey>(key: K): SettingValue<K> => values[key] },
    history: {
      query: (criteria) => {
        reads.push(`history:${criteria.text ?? ''}:${criteria.limit ?? ''}`)
        return queryHistory(stores.history, criteria)
      }
    },
    bookmarks: {
      query: (criteria) => {
        reads.push(`bookmarks:${criteria.text ?? ''}`)
        return queryBookmarks(stores.bookmarks, criteria)
      }
    },
    quickLinks: {
      list: () => {
        reads.push('quicklinks')
        return stores.quickLinks
      }
    },
    ...(options.realClock === true ? {} : { now: () => NOW })
  })

  let seq = 0
  return {
    window,
    reads,
    suggest: (request) => {
      seq = request.seq ?? seq + 1
      const payload = { seq, anchor: ANCHOR, selected: 0, ...request }
      expect(handlers.get('omnibox:suggest')?.(payload, EVENT)).toEqual({ ok: true })
    },
    close: () => {
      expect(handlers.get('omnibox:close')?.(undefined, EVENT)).toEqual({ ok: true })
    },
    rows: () => {
      const shown = window.shown
      if (shown?.kind !== 'omnibox-suggestions') throw new Error('no list is up')
      return shown.rows.map((row) => `${row.source} ${row.url}`)
    }
  }
}

function listOf(window: FakeWindow): OmniboxSuggestionsPresentation {
  const shown = window.shown
  if (shown?.kind !== 'omnibox-suggestions') throw new Error('no list is up')
  return shown
}

describe('omnibox:suggest — what a keystroke is offered (R28)', () => {
  it('shows the first row plus a history and a bookmark hit for "wiki"', () => {
    const world = harness()
    world.suggest({ text: 'wiki' })
    const list = listOf(world.window)
    expect(list.lead).toEqual({ action: 'search', engine: 'DuckDuckGo' })
    expect(list.text).toBe('wiki')
    expect(list.selected).toBe(0)
    expect(world.rows()).toEqual(
      expect.arrayContaining([
        'history https://en.wikipedia.org/wiki/Main_Page',
        'bookmark https://wiki.example.org/'
      ])
    )
  })

  it('offers the open tabs of this window, but not the one in front', () => {
    const world = harness()
    world.suggest({ text: 'wiki' })
    const rows = listOf(world.window).rows
    expect(rows.find((row) => row.source === 'tab')).toEqual({
      source: 'tab',
      title: 'Team wiki',
      url: 'https://wiki.team.example/',
      tabId: 't2'
    })
    world.suggest({ text: 'front' })
    expect(world.rows()).toEqual([])
  })

  it('offers quick links under the bookmarks switch, and folders never', () => {
    const quickLinks: QuickLink[] = [
      {
        id: 'q1',
        kind: 'link',
        title: 'Wiki start',
        url: 'https://start.example/',
        parentId: null,
        createdAt: NOW
      },
      { id: 'q2', kind: 'folder', title: 'Wiki folder', url: '', parentId: null, createdAt: NOW }
    ]
    const world = harness({ stores: { quickLinks } })
    world.suggest({ text: 'wiki' })
    expect(world.rows()).toContain('quicklink https://start.example/')
    expect(world.rows().some((row) => row.startsWith('quicklink '))).toBe(true)
    expect(world.rows().filter((row) => row.startsWith('quicklink '))).toHaveLength(1)
  })

  it('opens an address as typed rather than searching for it', () => {
    const world = harness()
    world.suggest({ text: 'example.com' })
    expect(listOf(world.window).lead).toEqual({ action: 'open', url: 'https://example.com' })
  })

  it('sizes the list under the field for the rows it has', () => {
    const world = harness()
    world.suggest({ text: 'wiki' })
    const list = listOf(world.window)
    expect(list.bounds.x).toBe(ANCHOR.x)
    expect(list.bounds.width).toBe(ANCHOR.width)
    expect(list.bounds.y).toBeGreaterThan(ANCHOR.y + ANCHOR.height - 1)
  })
})

describe('omnibox:suggest — the switches and the private window (R28, R29)', () => {
  it('draws no history rows with suggestFromHistory off, and does not read the history', () => {
    const world = harness({ settings: { 'search.suggestFromHistory': false } })
    world.suggest({ text: 'wiki' })
    expect(world.rows().some((row) => row.startsWith('history '))).toBe(false)
    expect(world.rows()).toContain('bookmark https://wiki.example.org/')
    expect(world.reads.some((read) => read.startsWith('history'))).toBe(false)
  })

  it('draws no bookmark or quick-link rows with suggestFromBookmarks off', () => {
    const world = harness({ settings: { 'search.suggestFromBookmarks': false } })
    world.suggest({ text: 'wiki' })
    expect(world.rows().some((row) => /^(bookmark|quicklink) /.test(row))).toBe(false)
    expect(world.reads.filter((read) => /^(bookmarks|quicklinks)/.test(read))).toEqual([])
  })

  it('draws no tab rows with suggestFromOpenTabs off', () => {
    const world = harness({ settings: { 'search.suggestFromOpenTabs': false } })
    world.suggest({ text: 'wiki' })
    expect(world.rows().some((row) => row.startsWith('tab '))).toBe(false)
  })

  it('offers a private window no history, but its bookmarks and its own tabs', () => {
    const window = fakeWindow({ privateMode: true })
    const world = harness({ window })
    world.suggest({ text: 'wiki' })
    expect(world.rows().some((row) => row.startsWith('history '))).toBe(false)
    expect(world.rows()).toContain('bookmark https://wiki.example.org/')
    expect(world.rows()).toContain('tab https://wiki.team.example/')
    expect(world.reads.some((read) => read.startsWith('history'))).toBe(false)
  })

  it('asks the stores by the text without its scheme, and at most a few hundred entries', () => {
    const world = harness()
    world.suggest({ text: 'https://www.Wiki' })
    expect(world.reads).toContain('history:wiki:300')
    expect(world.reads).toContain('bookmarks:wiki')
  })
})

describe('omnibox:suggest — stale numbers, arrows and closing', () => {
  it('drops a request whose number is not newer than the list on screen', () => {
    const world = harness()
    world.suggest({ seq: 5, text: 'wiki' })
    const reads = world.reads.length
    world.suggest({ seq: 4, text: 'wik' })
    world.suggest({ seq: 5, text: 'w' })
    expect(listOf(world.window).text).toBe('wiki')
    expect(listOf(world.window).seq).toBe(5)
    expect(world.reads).toHaveLength(reads)
  })

  it('accepts any number once the list has gone, so a reloaded field starts over', () => {
    const world = harness()
    world.suggest({ seq: 9, text: 'wiki' })
    world.close()
    world.suggest({ seq: 1, text: 'wiki' })
    expect(listOf(world.window).seq).toBe(1)
  })

  it('moves only the highlight on an arrow key, without asking the stores again', () => {
    const world = harness()
    world.suggest({ text: 'wiki' })
    const before = listOf(world.window)
    const reads = world.reads.length
    world.suggest({ text: 'wiki', selected: 2 })
    const after = listOf(world.window)
    expect(after.rows).toBe(before.rows)
    expect(after.selected).toBe(2)
    expect(world.reads).toHaveLength(reads)
  })

  it('keeps the highlight inside the list', () => {
    const world = harness()
    world.suggest({ text: 'wiki', selected: 99 })
    expect(listOf(world.window).selected).toBe(listOf(world.window).rows.length)
  })

  it('closes the list for text that would do nothing', () => {
    const world = harness()
    world.suggest({ text: 'wiki' })
    world.suggest({ text: '   ' })
    expect(world.window.shown).toBeNull()
  })

  it('closes the list on Escape, and nothing else', () => {
    const world = harness()
    world.suggest({ text: 'wiki' })
    world.close()
    expect(world.window.shown).toBeNull()

    const find: OverlayPresentation = {
      kind: 'find-bar',
      sessionId: 'find-1',
      tileIndex: 0,
      bounds: { x: 900, y: 96, width: FIND_BAR_WIDTH, height: FIND_BAR_HEIGHT },
      tabId: 'front',
      query: 'needle',
      matches: 1,
      activeMatch: 1
    }
    world.window.shown = find
    world.close()
    expect(world.window.shown).toBe(find)
  })

  it('does not displace an open find bar; the list waits for it to close', () => {
    const world = harness()
    const find: OverlayPresentation = {
      kind: 'find-bar',
      sessionId: 'find-1',
      tileIndex: 0,
      bounds: { x: 900, y: 96, width: FIND_BAR_WIDTH, height: FIND_BAR_HEIGHT },
      tabId: 'front',
      query: 'needle',
      matches: 1,
      activeMatch: 1
    }
    world.window.shown = find
    world.suggest({ text: 'wiki' })
    expect(world.window.shown).toBe(find)
    world.window.shown = null
    world.suggest({ text: 'wiki' })
    expect(listOf(world.window).text).toBe('wiki')
  })

  it('ranks against the real clock when it is given none', () => {
    const world = harness({ realClock: true })
    world.suggest({ text: 'wiki' })
    expect(world.rows()).toContain('history https://en.wikipedia.org/wiki/Main_Page')
  })

  it('does nothing for a sender with no window', () => {
    const world = harness({ window: undefined })
    world.suggest({ text: 'wiki' })
    world.close()
    expect(world.reads).toEqual([])
  })
})

describe('omnibox:suggest — a keystroke against a full history', () => {
  it('narrows ten thousand entries in the store, so a keystroke stays cheap', () => {
    /*
      History holds up to ten thousand entries and the ranker parses every address it is handed. The
      store narrows first (substring, most recent first, at most `HISTORY_CANDIDATES`), which keeps this
      cheap: the whole test, ten thousand entries built and five keystrokes ranked, ran in about 12 ms on
      the development machine (24.09.2026), so a keystroke costs two or three. The bound below is loose
      on purpose, so a slow CI runner does not fail it; what it catches is a keystroke that stops being
      narrowed.
    */
    const history = Array.from({ length: 10_000 }, (_, index) =>
      visit(
        `https://site${index}.example/wiki/page-${index}`,
        `Wiki page ${index}`,
        1 + (index % 7),
        index % 90
      )
    )
    const world = harness({ stores: { history } })
    // Five different texts, so every one of them is ranked afresh rather than kept as an arrow key's.
    const texts = ['w', 'wi', 'wik', 'wiki', 'wiki p']
    const started = performance.now()
    for (const text of texts) world.suggest({ text })
    const perKeystroke = (performance.now() - started) / texts.length
    expect(world.reads.filter((read) => read.startsWith('history'))[3]).toBe('history:wiki:300')
    expect(listOf(world.window).rows.length).toBeLessThanOrEqual(8)
    expect(perKeystroke).toBeLessThan(100)
  })
})
