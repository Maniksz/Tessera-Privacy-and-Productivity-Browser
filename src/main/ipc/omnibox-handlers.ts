import type { IpcMainInvokeEvent } from 'electron'
import type { InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { OverlayState } from '@shared/overlay/surface.js'
import type { SettingsKey, SettingValue } from '@shared/settings/definitions.js'
import type { HistoryQuery, HistoryVisit } from '@shared/history/model.js'
import type { Bookmark, BookmarkQuery } from '@shared/bookmarks/model.js'
import type { QuickLink } from '@shared/quicklinks/model.js'
import type { OmniboxSuggestionsPresentation } from '@shared/omnibox/model.js'
import {
  BOOKMARK_CANDIDATES,
  HISTORY_CANDIDATES,
  answerOmniboxRequest,
  omniboxNeedle,
  omniboxRows,
  omniboxSourcesWanted,
  type OmniboxPreferences
} from '@shared/omnibox/suggest.js'

/**
 * `omnibox:suggest` and `omnibox:close`: the address bar's suggestion list, filled by the core (U18, KTD12).
 *
 * ## Why this is not in `handlers.ts`
 *
 * For `site-handlers.ts`'s reasons: that file may only gain call sites (KTD21), and it imports the router,
 * so nothing in it can be tested. Handed the registrar, this is an ordinary function a test calls with a
 * fake window and fake stores.
 *
 * ## What is read, and when
 *
 * The switches and the private window decide which stores are asked at all (`omniboxSourcesWanted`), so a
 * switched-off source is not read rather than read and discarded. Each store narrows by text before the
 * ranker sees anything — history holds up to ten thousand entries — and nothing is read for a request
 * that is stale or that only moves the highlight (`answerOmniboxRequest`). The open tabs are this window's
 * own, less the one the address bar speaks for: switching to the tab already in front does nothing.
 *
 * Nothing here leaves the device (R28); `search.remoteSuggestions` stays unread, and says so.
 */

type OmniboxChannel = 'omnibox:suggest' | 'omnibox:close'
type OmniboxChannelContract = {
  [C in OmniboxChannel]: { request: InvokeHandlerArg<C>; response: InvokeResponse<C> }
}

/** The shape of `ipc/router.ts`'s `handle`, narrowed to these channels. See `SiteHandle`. */
export type OmniboxHandle = <C extends OmniboxChannel>(
  channel: C,
  handler: (
    payload: OmniboxChannelContract[C]['request'],
    event: IpcMainInvokeEvent
  ) => OmniboxChannelContract[C]['response']
) => void

/** A tab, as far as a suggestion needs one. `Tab` satisfies this. */
export interface OmniboxTab {
  readonly id: string
  toState(): { readonly url: string; readonly title: string }
}

/** One window. `BrowserWindowController` satisfies this. */
export interface OmniboxWindow {
  readonly privateMode: boolean
  readonly tabs: readonly OmniboxTab[]
  /** The active tile's tab: the one the address bar speaks for. */
  activeTab(): OmniboxTab | undefined
  overlayPresentation(): OverlayState
  presentOverlay(presentation: OmniboxSuggestionsPresentation): void
  dismissOverlayKind(kind: 'omnibox-suggestions'): boolean
}

export interface OmniboxHandlerDeps<W extends OmniboxWindow> {
  /** `handle` from `ipc/router.ts`, passed rather than imported; see `OmniboxHandle`. */
  readonly handle: OmniboxHandle
  readonly windows: { resolve(event: IpcMainInvokeEvent): W | undefined }
  readonly settings: { get<K extends SettingsKey>(key: K): SettingValue<K> }
  /** `HistoryStore`, `BookmarkStore` and `QuickLinkStore` satisfy these. */
  readonly history: { query(criteria: HistoryQuery): readonly HistoryVisit[] }
  readonly bookmarks: { query(criteria: BookmarkQuery): readonly Bookmark[] }
  readonly quickLinks: { list(): readonly QuickLink[] }
  /** The ranker's clock; a parameter so a test gives the same rows every time. */
  readonly now?: () => number
}

const OK = { ok: true } as const

export function registerOmniboxHandlers<W extends OmniboxWindow>(
  deps: OmniboxHandlerDeps<W>
): void {
  const { handle, windows, settings } = deps
  const now = deps.now ?? Date.now

  const preferencesFor = (window: W): OmniboxPreferences => ({
    suggestFromHistory: settings.get('search.suggestFromHistory'),
    suggestFromBookmarks: settings.get('search.suggestFromBookmarks'),
    suggestFromOpenTabs: settings.get('search.suggestFromOpenTabs'),
    engine: settings.get('search.defaultEngine'),
    customUrl: settings.get('search.customEngineUrl'),
    privateMode: window.privateMode
  })

  handle('omnibox:suggest', (request, event) => {
    const window = windows.resolve(event)
    if (window === undefined) return OK
    const shown = window.overlayPresentation()
    const current = shown?.kind === 'omnibox-suggestions' ? shown : null
    const preferences = preferencesFor(window)

    const answer = answerOmniboxRequest(request, current, preferences, () => {
      const wanted = omniboxSourcesWanted(preferences)
      const text = omniboxNeedle(request.text)
      const front = window.activeTab()?.id
      return omniboxRows(
        {
          history: wanted.history ? deps.history.query({ text, limit: HISTORY_CANDIDATES }) : [],
          bookmarks: wanted.bookmarks
            ? deps.bookmarks.query({ text, limit: BOOKMARK_CANDIDATES })
            : [],
          quickLinks: wanted.bookmarks ? deps.quickLinks.list() : [],
          tabs: wanted.openTabs
            ? window.tabs
                .filter((tab) => tab.id !== front)
                .map((tab) => {
                  const { url, title } = tab.toState()
                  return { id: tab.id, url, title }
                })
            : []
        },
        request.text,
        now()
      )
    })

    if (answer.action === 'present') window.presentOverlay(answer.presentation)
    else if (answer.action === 'close') window.dismissOverlayKind('omnibox-suggestions')
    return OK
  })

  // By kind, so an Escape that arrives after something else took the layer cannot take that down.
  handle('omnibox:close', (_payload, event) => {
    windows.resolve(event)?.dismissOverlayKind('omnibox-suggestions')
    return OK
  })
}
