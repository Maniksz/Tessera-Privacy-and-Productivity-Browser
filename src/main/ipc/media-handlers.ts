import type { IpcMainInvokeEvent } from 'electron'
import type { Locale } from '@shared/i18n/catalog.js'
import type { InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { MediaFindingList } from '@shared/media/wire.js'
import type { MediaService } from '../media/MediaService.js'
import type { MediaSession, MediaSessions } from '../media/MediaSessions.js'

/**
 * The `media:*` channels.
 *
 * ## Why these are not in `handlers.ts`
 *
 * Because of what `handle` drags in. `ipc/router.ts` imports `ipcMain`, so anything that
 * imports it can only run inside a live Electron process — which is why `handlers.ts` is
 * excluded from coverage and has no unit tests at all. Taking the registrar as an
 * argument instead of importing it turns these handler bodies into ordinary functions a
 * test can call, and the media channels are the ones where that matters most: they
 * resolve a tab, pick a session, and translate a refusal, and each of those is a decision
 * rather than a forward.
 *
 * The registrar is typed against the same four shapes the contract validates — the
 * request types are `z.output` of the very schemas the contract entries use — so a
 * handler cannot drift from the channel it is registered on without failing to compile at
 * the call site.
 *
 * ## What resolves what
 *
 * Every channel takes an optional tab and defaults to the tab in the active tile, the
 * same rule the navigation channels use. The tab is resolved from the *sending window*
 * and never from a window id in the request: the sender is the one thing a renderer
 * cannot lie about, and a media panel that could name another window's tab could ask the
 * core to list, and then download, what somebody else is watching.
 *
 * The tab then decides the session, and the session decides the service. That order is
 * the privacy-relevant part — see `MediaService` for why a manifest must be fetched
 * through the session that played the media.
 */

/**
 * The four channels, derived from the shared contract rather than restated.
 *
 * Restating them compiled and was still wrong: `InvokeHandlerArg` is not simply the request type — it
 * normalises a `void` request and carries the contract's own inference — so a hand-written twin was
 * assignable to nothing at the call site that hands `handle` over. Deriving both sides means the two can
 * no longer say different things, which is the property the restatement was trying to have.
 */
type MediaChannelContract = {
  [C in 'media:list' | 'media:describe' | 'media:download' | 'media:cancel']: {
    request: InvokeHandlerArg<C>
    response: InvokeResponse<C>
  }
}

export type MediaInvokeChannel = keyof MediaChannelContract

/**
 * The shape of `ipc/router.ts`'s `handle`, narrowed to the media channels.
 *
 * Deliberately structural. `handle` itself is generic over `InvokeChannel`, so passing it
 * in satisfies this the moment the four names are in the contract — and until then the
 * mismatch is a compile error at the one call site that hands it over, rather than
 * something that spreads through this file.
 */
export type MediaHandle = <C extends MediaInvokeChannel>(
  channel: C,
  handler: (
    payload: MediaChannelContract[C]['request'],
    event: IpcMainInvokeEvent
  ) => Promise<MediaChannelContract[C]['response']> | MediaChannelContract[C]['response']
) => void

/** A tab, as far as this file needs one: an identity and the session it browses in. */
export interface MediaHandlerTab {
  readonly id: string
  readonly view: { readonly webContents: { readonly session: MediaSession } }
}

/** One window. `BrowserWindowController` satisfies this. */
export interface MediaHandlerWindow {
  /** Undefined for an id this window does not hold; no argument means the active tile's tab. */
  resolveTab(tabId?: string): MediaHandlerTab | undefined
  tab(tabId: string): { readonly id: string } | undefined
  emit(channel: 'media:changed', payload: MediaFindingList): void
}

/** The window registry, as far as this file needs one. */
export interface MediaHandlerWindows {
  resolve(event: IpcMainInvokeEvent): MediaHandlerWindow | undefined
  readonly controllers: readonly MediaHandlerWindow[]
}

export interface MediaHandlerDeps {
  /** `handle` from `ipc/router.ts`. See `MediaHandle` for why it is passed rather than imported. */
  readonly handle: MediaHandle
  readonly media: MediaSessions
  readonly windows: MediaHandlerWindows
  /** Read per call, so a language change reaches the next refusal rather than the next restart. */
  readonly locale: () => Locale
}

export function registerMediaHandlers(deps: MediaHandlerDeps): void {
  const { handle, media, windows, locale } = deps

  /**
   * The tab this request is about, and the service that speaks for its session.
   *
   * Throws rather than answering emptily for a tab that is not there. An empty finding
   * list would read as "this page is playing nothing", which is a different statement from
   * "the tab you named is gone" — and the second one is the one a panel needs in order to
   * refresh itself instead of showing an empty list for as long as the user leaves it open.
   */
  const target = (
    tabId: string | undefined,
    event: IpcMainInvokeEvent
  ): { service: MediaService; tabId: string } => {
    const window = windows.resolve(event)
    if (window === undefined) throw new Error('No window for this request')
    const tab = window.resolveTab(tabId)
    if (tab === undefined) throw new Error(`No tab for this request: ${tabId ?? '(active tile)'}`)
    return { service: media.forSession(tab.view.webContents.session), tabId: tab.id }
  }

  handle('media:list', (payload, event) => {
    const { service, tabId } = target(payload.tabId, event)
    return service.list(tabId)
  })

  /*
    Reading the manifest is what this channel is for, and it is the only thing in the
    feature that makes a second request to an address the page already asked for. That is
    why it is a channel of its own instead of part of `media:list`: it happens when
    somebody asks to see the qualities, not when a panel opens.
  */
  handle('media:describe', async (payload, event) => {
    const { service, tabId } = target(payload.tabId, event)
    return service.describe(tabId, payload.findingId, locale())
  })

  /*
    Resolves when the file is on disk, or when the refusal is known. A download of a film
    keeps this promise pending for minutes, which is the honest representation: there is
    one answer and it arrives when it arrives. `media:cancel` is how the user takes it back.
  */
  handle('media:download', async (payload, event) => {
    const { service, tabId } = target(payload.tabId, event)
    return service.download(tabId, payload.findingId, payload.variantId ?? null, locale())
  })

  handle('media:cancel', (payload, event) => {
    const { service } = target(payload.tabId, event)
    return { stopped: service.cancel(payload.findingId) }
  })

  /*
    Findings change without anybody asking: a player starts a second stream, a page
    navigates, a tab closes. Pushed to the window that owns the tab and to no other — the
    list names the addresses a page fetched, which is browsing history by another route,
    and there is no reason for a second window to see it.

    The unsubscribe is dropped on purpose: handlers are registered once for the life of the
    process, so there is no teardown for it to belong to. A `MediaService` that goes away
    with its session takes its own listeners with it.
  */
  media.onChange((list) => {
    for (const window of windows.controllers) {
      if (window.tab(list.tabId) === undefined) continue
      window.emit('media:changed', list)
    }
  })
}
