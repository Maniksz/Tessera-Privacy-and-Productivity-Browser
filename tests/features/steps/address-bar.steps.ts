import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import {
  classifyOmniboxInput,
  resolveOmniboxInput,
  type OmniboxIntent,
  type SearchEngineId
} from '@shared/url/omnibox.js'
import { cleanUrl } from '@shared/url/tracking-params.js'
import {
  registerOmniboxHandlers,
  type OmniboxHandle,
  type OmniboxTab,
  type OmniboxWindow
} from '@main/ipc/omnibox-handlers.js'
import { queryHistory, type HistoryVisit } from '@shared/history/model.js'
import { queryBookmarks, type Bookmark } from '@shared/bookmarks/model.js'
import { omniboxChoice, type OmniboxSuggestionsPresentation } from '@shared/omnibox/model.js'
import { mayPresentOver, type OverlayState } from '@shared/overlay/surface.js'
import { scope } from './world.js'

/**
 * Steps for `address-bar.feature`.
 *
 * Both the classification and the resolution are exercised, because they answer
 * different questions: whether the browser *thinks* something is an address, and
 * where it actually ends up going. A scenario that only checked the first would
 * pass while navigating somewhere wrong.
 */

interface OmniboxScratch {
  intent: OmniboxIntent
  resolved: string | null
  engine: SearchEngineId
  customUrl: string
}

function omnibox(state: unknown): OmniboxScratch {
  const current = scope(state)
  let existing = current.scratch['omnibox'] as OmniboxScratch | undefined
  if (existing === undefined) {
    existing = { intent: { kind: 'empty' }, resolved: null, engine: 'duckduckgo', customUrl: '' }
    current.scratch['omnibox'] = existing
  }
  return existing
}

// --- given -------------------------------------------------------------------

Given('the search engine is {string}', (state: unknown, engine: string) => {
  omnibox(state).engine = engine as SearchEngineId
})

Given('the search engine is custom with template {string}', (state: unknown, template: string) => {
  const current = omnibox(state)
  current.engine = 'custom'
  current.customUrl = template
})

// --- when --------------------------------------------------------------------

When('I type {string} into the address bar', (state: unknown, input: string) => {
  const current = omnibox(state)
  current.intent = classifyOmniboxInput(input)
  current.resolved = resolveOmniboxInput(input, {
    engine: current.engine,
    customUrl: current.customUrl
  })
  // And the list the core would present for it, one keystroke at a time as the field sends it.
  const list = suggestions(state)
  for (let end = 1; end <= input.length; end += 1) ask(state, input.slice(0, end), 0)
  list.typed = input
})

When('the URL {string} is cleaned', (state: unknown, url: string) => {
  scope(state).scratch['cleaned'] = cleanUrl(url)
})

// --- then --------------------------------------------------------------------

Then('it is treated as an address', (state: unknown) => {
  expect(omnibox(state).intent.kind).toBe('url')
})

Then('it is treated as a search', (state: unknown) => {
  expect(omnibox(state).intent.kind).toBe('search')
})

Then('it navigates to {string}', (state: unknown, url: string) => {
  expect(omnibox(state).resolved).toBe(url)
})

Then('the search term is {string}', (state: unknown, term: string) => {
  const intent = omnibox(state).intent
  expect(intent.kind).toBe('search')
  if (intent.kind !== 'search') return
  expect(intent.query).toBe(term)
})

Then('nothing happens', (state: unknown) => {
  const current = omnibox(state)
  expect(current.intent.kind).toBe('empty')
  // `null` rather than an empty string, so the caller can leave the page alone.
  expect(current.resolved).toBeNull()
})

Then('the result is {string}', (state: unknown, expected: string) => {
  expect(scope(state).scratch['cleaned']).toBe(expected)
})

// --- suggestions (U18) --------------------------------------------------------

/**
 * The address bar's list, run through the real handler (`omnibox-handlers.ts`) with the stores and the
 * window a scenario describes, and the real overlay precedence deciding whether it may take the layer.
 */
interface SuggestScratch {
  history: HistoryVisit[]
  bookmarks: Bookmark[]
  tabs: OmniboxTab[]
  shown: OverlayState
  seq: number
  typed: string
  /** What Enter or a choice did: the channel the field would have invoked, and its payload. */
  outcome: { tabId: string } | { input: string } | null
  /** Where the field's selection is, as it keeps it while the core answers. */
  selected: number
}

function suggestions(state: unknown): SuggestScratch {
  const current = scope(state)
  let existing = current.scratch['suggest'] as SuggestScratch | undefined
  if (existing === undefined) {
    existing = {
      history: [],
      bookmarks: [],
      // The tab the address bar speaks for, which is never offered.
      tabs: [{ id: 'front', toState: () => ({ url: 'https://front.example/', title: 'Front' }) }],
      shown: null,
      seq: 0,
      typed: '',
      outcome: null,
      selected: 0
    }
    current.scratch['suggest'] = existing
  }
  return existing
}

/** One `omnibox:suggest`, answered by the handler against the scenario's window and stores. */
function ask(state: unknown, text: string, selected: number, seq?: number): void {
  const list = suggestions(state)
  const settings = scope(state).settings
  const window: OmniboxWindow = {
    privateMode: scope(state).privateWindow,
    tabs: list.tabs,
    activeTab: () => list.tabs[0],
    overlayPresentation: () => list.shown,
    presentOverlay: (presentation) => {
      if (mayPresentOver(presentation.kind, list.shown)) list.shown = presentation
    },
    dismissOverlayKind: (kind) => {
      if (list.shown?.kind !== kind) return false
      list.shown = null
      return true
    }
  }
  let handler: ((payload: unknown, event: never) => unknown) | undefined
  const handle = ((channel: string, registered: typeof handler) => {
    if (channel === 'omnibox:suggest') handler = registered
  }) as unknown as OmniboxHandle
  registerOmniboxHandlers({
    handle,
    windows: { resolve: () => window },
    settings: { get: (key) => settings[key] },
    history: { query: (criteria) => queryHistory(list.history, criteria) },
    bookmarks: { query: (criteria) => queryBookmarks(list.bookmarks, criteria) },
    quickLinks: { list: () => [] },
    now: () => Date.UTC(2026, 8, 24, 12)
  })
  list.seq = seq ?? list.seq + 1
  const anchor = { x: 200, y: 44, width: 600, height: 28 }
  handler?.({ seq: list.seq, text, anchor, selected }, undefined as never)
}

function shownList(state: unknown): OmniboxSuggestionsPresentation {
  const shown = suggestions(state).shown
  if (shown?.kind !== 'omnibox-suggestions') throw new Error('no suggestion list is up')
  return shown
}

Given(
  'the history holds {string} titled {string}',
  (state: unknown, url: string, title: string) => {
    const at = Date.UTC(2026, 8, 23, 12)
    suggestions(state).history.push({
      url,
      title,
      firstVisitedAt: at,
      lastVisitedAt: at,
      visitCount: 3
    })
  }
)

Given('a bookmark {string} titled {string}', (state: unknown, url: string, title: string) => {
  const list = suggestions(state)
  list.bookmarks.push({
    id: `b${list.bookmarks.length + 1}`,
    kind: 'bookmark',
    title,
    url,
    parentId: 'bar',
    createdAt: 0
  })
})

Given('a tab is open at {string} titled {string}', (state: unknown, url: string, title: string) => {
  const list = suggestions(state)
  list.tabs.push({ id: `t${list.tabs.length + 1}`, toState: () => ({ url, title }) })
})

Given('the find bar is open', (state: unknown) => {
  suggestions(state).shown = {
    kind: 'find-bar',
    sessionId: 'find-1',
    tileIndex: 0,
    bounds: { x: 900, y: 96, width: 360, height: 44 },
    tabId: 'front',
    query: 'needle',
    matches: 1,
    activeMatch: 1
  }
})

When('a request for the older text {string} arrives late', (state: unknown, text: string) => {
  const list = suggestions(state)
  ask(state, text, 0, list.seq - 1)
})

When('I press the down arrow once and Enter', (state: unknown) => {
  const list = suggestions(state)
  list.selected = 1
  ask(state, list.typed, list.selected)
  list.outcome = omniboxChoice(shownList(state), list.selected)
})

When('I press Enter without choosing a suggestion', (state: unknown) => {
  const list = suggestions(state)
  list.outcome = omniboxChoice(shownList(state), list.selected)
})

Then(
  'the first suggestion searches for {string} with {string}',
  (state: unknown, text: string, engine: string) => {
    const shown = shownList(state)
    expect(shown.text).toBe(text)
    expect(shown.lead).toEqual({ action: 'search', engine })
    expect(shown.selected).toBe(0)
  }
)

Then('the suggestions offer the history entry {string}', (state: unknown, url: string) => {
  expect(shownList(state).rows).toContainEqual(expect.objectContaining({ source: 'history', url }))
})

Then('the suggestions offer the bookmark {string}', (state: unknown, url: string) => {
  expect(shownList(state).rows).toContainEqual(expect.objectContaining({ source: 'bookmark', url }))
})

Then('the suggestions offer the open tab {string}', (state: unknown, url: string) => {
  expect(shownList(state).rows).toContainEqual(expect.objectContaining({ source: 'tab', url }))
})

Then('no suggestion comes from the history', (state: unknown) => {
  expect(shownList(state).rows.filter((row) => row.source === 'history')).toEqual([])
})

Then('the suggestions still describe {string}', (state: unknown, text: string) => {
  const shown = shownList(state)
  expect(shown.text).toBe(text)
  expect(shown.seq).toBe(text.length)
})

Then('the tab showing {string} is activated', (state: unknown, url: string) => {
  const list = suggestions(state)
  const tab = list.tabs.find((candidate) => candidate.toState().url === url)
  expect(tab).toBeDefined()
  // `tabs:activate` with this id is what the field invokes for the outcome; see `chooseSuggestion`.
  expect(list.outcome).toEqual({ tabId: tab?.id })
})

Then('the typed text {string} is navigated to', (state: unknown, text: string) => {
  // `nav:navigate` with the text as typed, which the core resolves exactly as it always has.
  expect(suggestions(state).outcome).toEqual({ input: text })
})

Then('the find bar is still on the layer', (state: unknown) => {
  expect(suggestions(state).shown?.kind).toBe('find-bar')
})

Then('no suggestion list is shown', (state: unknown) => {
  expect(suggestions(state).shown?.kind).not.toBe('omnibox-suggestions')
})
