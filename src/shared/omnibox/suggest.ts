import { rankCandidates, type RankCandidate } from '../search/rank.js'
import { SEARCH_ENGINES, classifyOmniboxInput, type SearchEngineId } from '../url/omnibox.js'
import {
  OMNIBOX_MAX_TEXT,
  clampSelection,
  omniboxListBounds,
  type OmniboxLead,
  type OmniboxRow,
  type OmniboxSuggestRequest,
  type OmniboxSuggestionsPresentation
} from './model.js'

/**
 * How the core answers one keystroke in the address bar (U18): which stores it asks, what it ranks, and
 * whether it presents, closes or ignores.
 *
 * Pure, so every rule here is a table of cases: the switches and the private window (R28, R29), the stale
 * number, the arrow key that must not re-rank what the user is walking. The stores are read by the caller
 * (`main/ipc/omnibox-handlers.ts`) through a thunk, so nothing is queried for an answer that is ignored or
 * only moves the highlight.
 *
 * Nothing here reaches the network (R28). The ranker is held to that by a fitness test, and this module
 * adds only the address classification the core already navigates with.
 */

/**
 * How many history entries a keystroke hands the ranker, at most.
 *
 * History holds up to ten thousand entries and the ranker parses every address it is given, so the store
 * narrows first: entries whose address or title contains the text, most recent first. Three hundred is far
 * more than eight rows need, and it keeps a keystroke at a few milliseconds (`tests/omnibox-handlers.test.ts`).
 */
export const HISTORY_CANDIDATES = 300
/** The same ceiling for the bookmark tree, which a store can also narrow by text. */
export const BOOKMARK_CANDIDATES = 100

/** The three switches and the one fact that overrides one of them. */
export interface OmniboxPreferences {
  suggestFromHistory: boolean
  suggestFromBookmarks: boolean
  suggestFromOpenTabs: boolean
  engine: SearchEngineId
  customUrl: string
  privateMode: boolean
}

/**
 * Which stores a keystroke may read.
 *
 * History never in a private window (R29): what that window visits is not recorded, and what the normal
 * profile visited is not the private window's to be reminded of. Quick links follow the bookmarks switch —
 * both are pages the user chose to keep, and a fourth switch for the start page's tiles would be a setting
 * nobody could tell apart from the third.
 */
export function omniboxSourcesWanted(preferences: OmniboxPreferences): {
  history: boolean
  bookmarks: boolean
  openTabs: boolean
} {
  return {
    history: preferences.suggestFromHistory && !preferences.privateMode,
    bookmarks: preferences.suggestFromBookmarks,
    openTabs: preferences.suggestFromOpenTabs
  }
}

/**
 * The text a store narrows by: lowercased, without a scheme and a leading `www.`.
 *
 * The ranker compares addresses the same way, so a store asked for the text as typed would drop
 * `https://github.com` for somebody typing `www.github` — which the ranker would have offered first. When
 * nothing is left (`https://` alone), the text as typed is the needle.
 */
export function omniboxNeedle(text: string): string {
  const lowered = text.trim().toLowerCase()
  const bare = lowered.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '')
  return bare === '' ? lowered : bare
}

/** What the stores returned, in the shapes they return it. Empty for a store that was not asked. */
export interface OmniboxSources {
  history: readonly { url: string; title: string; visitCount: number; lastVisitedAt: number }[]
  bookmarks: readonly { kind: string; title: string; url: string }[]
  quickLinks: readonly { kind: string; title: string; url: string }[]
  tabs: readonly { id: string; title: string; url: string }[]
}

/** Everything the stores returned, as the ranker takes it. Folders carry no address and are left out. */
export function omniboxCandidates(sources: OmniboxSources): RankCandidate[] {
  return [
    ...sources.history.map((visit): RankCandidate => ({
      source: 'history',
      title: visit.title,
      url: visit.url,
      visitCount: visit.visitCount,
      lastVisitedAt: visit.lastVisitedAt
    })),
    ...sources.bookmarks
      .filter((node) => node.kind === 'bookmark')
      .map((node): RankCandidate => ({ source: 'bookmark', title: node.title, url: node.url })),
    ...sources.quickLinks
      .filter((link) => link.kind === 'link')
      .map((link): RankCandidate => ({ source: 'quicklink', title: link.title, url: link.url })),
    ...sources.tabs.map((tab): RankCandidate => ({
      source: 'tab',
      title: tab.title,
      url: tab.url,
      tabId: tab.id
    }))
  ]
}

/** The ranked rows for `text`, in the shape the list draws. */
export function omniboxRows(sources: OmniboxSources, text: string, now: number): OmniboxRow[] {
  return rankCandidates(omniboxCandidates(sources), text, now).map((row) => ({
    source: row.source,
    title: row.title,
    url: row.url,
    tabId: row.tabId ?? null
  }))
}

/**
 * Row zero: what Enter does with the text as typed, or `null` for text that does nothing.
 *
 * The engine is named the way `buildSearchUrl` resolves it, so the row cannot promise one engine while
 * Enter searches with another: a custom address without `{query}` falls back to DuckDuckGo there, and is
 * named DuckDuckGo here. A custom address is named by its host, which is what the user typed into it.
 */
export function omniboxLead(
  text: string,
  engine: SearchEngineId,
  customUrl: string
): OmniboxLead | null {
  const intent = classifyOmniboxInput(text)
  if (intent.kind === 'empty') return null
  if (intent.kind === 'url') return { action: 'open', url: intent.url }
  return { action: 'search', engine: engineLabel(engine, customUrl) }
}

function engineLabel(engine: SearchEngineId, customUrl: string): string {
  if (engine !== 'custom') return SEARCH_ENGINES[engine].label
  if (!customUrl.includes('{query}')) return SEARCH_ENGINES.duckduckgo.label
  try {
    return new URL(customUrl.replace('{query}', '')).host || SEARCH_ENGINES.custom.label
  } catch {
    return SEARCH_ENGINES.custom.label
  }
}

/** What the core does with one request. */
export type OmniboxAnswer =
  | { action: 'present'; presentation: OmniboxSuggestionsPresentation }
  | { action: 'close' }
  /** A request older than the list on screen: it describes text the field no longer holds. */
  | { action: 'ignore' }

/**
 * The answer to `request`, given the list currently up (`current`, or `null`).
 *
 * Stale first: a number no newer than the one on screen is dropped, so a slow answer can never replace a
 * newer one. Then close for text that would do nothing — empty, or past `OMNIBOX_MAX_TEXT`. Then the rows:
 * for the text already on screen they are kept as they are, because an arrow key re-sends the same text
 * with a new selection and a list that re-ranked under the highlight would move the row being reached
 * for. Only new text asks the stores, through `rank`.
 */
export function answerOmniboxRequest(
  request: OmniboxSuggestRequest,
  current: OmniboxSuggestionsPresentation | null,
  preferences: Pick<OmniboxPreferences, 'engine' | 'customUrl'>,
  rank: () => OmniboxRow[]
): OmniboxAnswer {
  if (current !== null && request.seq <= current.seq) return { action: 'ignore' }
  if (request.text.length > OMNIBOX_MAX_TEXT) return { action: 'close' }
  const lead = omniboxLead(request.text, preferences.engine, preferences.customUrl)
  if (lead === null) return { action: 'close' }
  const rows = current !== null && current.text === request.text ? current.rows : rank()
  return {
    action: 'present',
    presentation: {
      kind: 'omnibox-suggestions',
      seq: request.seq,
      bounds: omniboxListBounds(request.anchor, rows.length),
      text: request.text,
      lead,
      rows,
      selected: clampSelection(request.selected, rows.length)
    }
  }
}
