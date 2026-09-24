import { describe, expect, it } from 'vitest'
import {
  OMNIBOX_LIST_GAP,
  OMNIBOX_LIST_PADDING,
  OMNIBOX_MAX_TEXT,
  OMNIBOX_ROW_HEIGHT,
  clampSelection,
  nextSelection,
  omniboxChoice,
  omniboxListBounds,
  type OmniboxRow,
  type OmniboxSuggestionsPresentation
} from '@shared/omnibox/model.js'
import {
  answerOmniboxRequest,
  omniboxCandidates,
  omniboxLead,
  omniboxNeedle,
  omniboxRows,
  omniboxSourcesWanted,
  type OmniboxPreferences,
  type OmniboxSources
} from '@shared/omnibox/suggest.js'
import { invokeContract } from '@shared/ipc/contract.js'

/**
 * The pure half of the address bar's suggestions (U18): what a request is answered with, what row
 * zero says, and what a choice does. The handler that reads the stores is `tests/omnibox-handlers.test.ts`.
 */

const NOW = Date.UTC(2026, 8, 24, 12)
const ANCHOR = { x: 100, y: 40, width: 500, height: 28 }

const PREFERENCES: OmniboxPreferences = {
  suggestFromHistory: true,
  suggestFromBookmarks: true,
  suggestFromOpenTabs: true,
  engine: 'duckduckgo',
  customUrl: '',
  privateMode: false
}

const NONE: OmniboxSources = { history: [], bookmarks: [], quickLinks: [], tabs: [] }

const ROWS: OmniboxRow[] = [
  { source: 'tab', title: 'Team wiki', url: 'https://wiki.team.example/', tabId: 't2' },
  { source: 'history', title: 'Wikipedia', url: 'https://en.wikipedia.org/', tabId: null }
]

function list(
  overrides: Partial<OmniboxSuggestionsPresentation> = {}
): OmniboxSuggestionsPresentation {
  return {
    kind: 'omnibox-suggestions',
    seq: 3,
    bounds: omniboxListBounds(ANCHOR, ROWS.length),
    text: 'wiki',
    lead: { action: 'search', engine: 'DuckDuckGo' },
    rows: ROWS,
    selected: 0,
    ...overrides
  }
}

describe('the list rectangle', () => {
  it('hangs under the field, as wide as it, tall enough for row zero and every row', () => {
    expect(omniboxListBounds(ANCHOR, 2)).toEqual({
      x: 100,
      y: 40 + 28 + OMNIBOX_LIST_GAP,
      width: 500,
      height: 3 * OMNIBOX_ROW_HEIGHT + 2 * OMNIBOX_LIST_PADDING
    })
    expect(omniboxListBounds(ANCHOR, 0).height).toBe(OMNIBOX_ROW_HEIGHT + 2 * OMNIBOX_LIST_PADDING)
  })
})

describe('walking the list', () => {
  it('keeps the selection between row zero and the last row', () => {
    expect(clampSelection(-3, 2)).toBe(0)
    expect(clampSelection(1.8, 2)).toBe(1)
    expect(clampSelection(9, 2)).toBe(2)
  })

  it('stops at both ends rather than wrapping', () => {
    expect(nextSelection(0, 2, 'down')).toBe(1)
    expect(nextSelection(2, 2, 'down')).toBe(2)
    expect(nextSelection(1, 2, 'up')).toBe(0)
    expect(nextSelection(0, 2, 'up')).toBe(0)
  })
})

describe('what a choice does', () => {
  it('opens the typed text for row zero, and for a row that is no longer there', () => {
    expect(omniboxChoice(list(), 0)).toEqual({ input: 'wiki' })
    expect(omniboxChoice(list(), 7)).toEqual({ input: 'wiki' })
  })

  it('switches to an open tab, and opens every other row by its address', () => {
    expect(omniboxChoice(list(), 1)).toEqual({ tabId: 't2' })
    expect(omniboxChoice(list(), 2)).toEqual({ input: 'https://en.wikipedia.org/' })
  })
})

describe('which stores a keystroke reads (R28, R29)', () => {
  it('follows the three switches', () => {
    expect(omniboxSourcesWanted(PREFERENCES)).toEqual({
      history: true,
      bookmarks: true,
      openTabs: true
    })
    expect(
      omniboxSourcesWanted({
        ...PREFERENCES,
        suggestFromHistory: false,
        suggestFromBookmarks: false,
        suggestFromOpenTabs: false
      })
    ).toEqual({ history: false, bookmarks: false, openTabs: false })
  })

  it('never reads history for a private window, whatever the switch says', () => {
    expect(omniboxSourcesWanted({ ...PREFERENCES, privateMode: true })).toEqual({
      history: false,
      bookmarks: true,
      openTabs: true
    })
  })

  it('narrows the stores by the text without its scheme and leading www.', () => {
    expect(omniboxNeedle('  HTTPS://www.GitHub ')).toBe('github')
    expect(omniboxNeedle('wiki')).toBe('wiki')
    expect(omniboxNeedle('https://')).toBe('https://')
  })
})

describe('what the ranker is handed', () => {
  it('takes every source, leaves folders out and carries the tab id', () => {
    const candidates = omniboxCandidates({
      history: [{ url: 'https://a.example/', title: 'A', visitCount: 3, lastVisitedAt: NOW }],
      bookmarks: [
        { kind: 'bookmark', title: 'B', url: 'https://b.example/' },
        { kind: 'folder', title: 'Folder', url: '' }
      ],
      quickLinks: [
        { kind: 'link', title: 'Q', url: 'https://q.example/' },
        { kind: 'folder', title: 'Tiles', url: '' }
      ],
      tabs: [{ id: 't1', title: 'T', url: 'https://t.example/' }]
    })
    expect(candidates).toEqual([
      {
        source: 'history',
        title: 'A',
        url: 'https://a.example/',
        visitCount: 3,
        lastVisitedAt: NOW
      },
      { source: 'bookmark', title: 'B', url: 'https://b.example/' },
      { source: 'quicklink', title: 'Q', url: 'https://q.example/' },
      { source: 'tab', title: 'T', url: 'https://t.example/', tabId: 't1' }
    ])
  })

  it('draws a ranked row with its tab, or with none', () => {
    const rows = omniboxRows(
      {
        ...NONE,
        bookmarks: [{ kind: 'bookmark', title: 'Wiki', url: 'https://wiki.example/' }],
        tabs: [{ id: 't1', title: 'Wiki tab', url: 'https://wiki.tab.example/' }]
      },
      'wiki',
      NOW
    )
    expect(rows).toEqual([
      { source: 'tab', title: 'Wiki tab', url: 'https://wiki.tab.example/', tabId: 't1' },
      { source: 'bookmark', title: 'Wiki', url: 'https://wiki.example/', tabId: null }
    ])
  })
})

describe('row zero', () => {
  it('opens an address and searches everything else', () => {
    expect(omniboxLead('example.com', 'duckduckgo', '')).toEqual({
      action: 'open',
      url: 'https://example.com'
    })
    expect(omniboxLead('rust traits', 'mojeek', '')).toEqual({ action: 'search', engine: 'Mojeek' })
    expect(omniboxLead('   ', 'duckduckgo', '')).toBeNull()
  })

  it('names the engine Enter will really use for a custom address', () => {
    // Without the placeholder, `buildSearchUrl` falls back to DuckDuckGo, and so does the row.
    expect(omniboxLead('x', 'custom', 'https://search.example/')).toEqual({
      action: 'search',
      engine: 'DuckDuckGo'
    })
    expect(omniboxLead('x', 'custom', 'https://search.example/?q={query}')).toEqual({
      action: 'search',
      engine: 'search.example'
    })
    expect(omniboxLead('x', 'custom', 'not a url {query}')).toEqual({
      action: 'search',
      engine: 'Custom'
    })
    expect(omniboxLead('x', 'custom', 'file:///search?q={query}')).toEqual({
      action: 'search',
      engine: 'Custom'
    })
  })
})

describe('answering one request', () => {
  const request = { seq: 4, text: 'wiki', anchor: ANCHOR, selected: 0 }
  const never = (): OmniboxRow[] => {
    throw new Error('the stores were asked')
  }

  it('ranks new text into a list under the field', () => {
    const answer = answerOmniboxRequest(request, null, PREFERENCES, () => ROWS)
    expect(answer).toEqual({
      action: 'present',
      presentation: {
        kind: 'omnibox-suggestions',
        seq: 4,
        bounds: omniboxListBounds(ANCHOR, 2),
        text: 'wiki',
        lead: { action: 'search', engine: 'DuckDuckGo' },
        rows: ROWS,
        selected: 0
      }
    })
  })

  it('ignores a number no newer than the list on screen, without asking the stores', () => {
    expect(answerOmniboxRequest({ ...request, seq: 3 }, list(), PREFERENCES, never)).toEqual({
      action: 'ignore'
    })
    expect(answerOmniboxRequest({ ...request, seq: 2 }, list(), PREFERENCES, never)).toEqual({
      action: 'ignore'
    })
  })

  it('keeps the rows for the text on screen and only moves the highlight', () => {
    const answer = answerOmniboxRequest({ ...request, selected: 2 }, list(), PREFERENCES, never)
    if (answer.action !== 'present') throw new Error('not presented')
    expect(answer.presentation.rows).toBe(ROWS)
    expect(answer.presentation.selected).toBe(2)
  })

  it('ranks again when the text changed', () => {
    const answer = answerOmniboxRequest({ ...request, text: 'wik' }, list(), PREFERENCES, () => [])
    if (answer.action !== 'present') throw new Error('not presented')
    expect(answer.presentation.rows).toEqual([])
    expect(answer.presentation.bounds.height).toBe(OMNIBOX_ROW_HEIGHT + 2 * OMNIBOX_LIST_PADDING)
  })

  it('closes for text that does nothing, and for text too long to rank', () => {
    expect(answerOmniboxRequest({ ...request, text: '  ' }, list(), PREFERENCES, never)).toEqual({
      action: 'close'
    })
    const long = 'a'.repeat(OMNIBOX_MAX_TEXT + 1)
    expect(answerOmniboxRequest({ ...request, text: long }, null, PREFERENCES, never)).toEqual({
      action: 'close'
    })
  })
})

describe('what the address bar may send', () => {
  const schema = invokeContract['omnibox:suggest'].request

  it('accepts text, the field and a number', () => {
    expect(schema.safeParse({ seq: 1, text: 'wiki', anchor: ANCHOR, selected: 0 }).success).toBe(
      true
    )
  })

  it('refuses rows in a request: the core fills them (KTD12)', () => {
    expect(
      schema.safeParse({ seq: 1, text: 'wiki', anchor: ANCHOR, selected: 0, rows: ROWS }).success
    ).toBe(false)
  })

  it('refuses text longer than is ever ranked', () => {
    const text = 'a'.repeat(OMNIBOX_MAX_TEXT + 1)
    expect(schema.safeParse({ seq: 1, text, anchor: ANCHOR, selected: 0 }).success).toBe(false)
  })
})
