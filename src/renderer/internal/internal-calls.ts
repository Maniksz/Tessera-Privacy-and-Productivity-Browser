import type { Bookmark, BookmarkKind } from '@shared/bookmarks/model.js'
import type { DownloadEntry } from '@shared/downloads/model.js'

/**
 * The bookmarks and downloads pages' calls into the core.
 *
 * ## Why this file exists rather than `bridge.ts`
 *
 * `bridge.ts` types `invoke` over `InternalInvokeChannel`, which is derived from
 * `INTERNAL_PAGE_INVOKE_CHANNELS` in `shared/ipc/channels.ts`. The two pages below were built
 * alongside the channel table rather than after it, so their channels are not in that table
 * yet — and a page that called them through `bridge.ts` would not compile.
 *
 * So the channel names and payload shapes are declared here, once, behind the one cast in
 * this file. Every call site stays fully typed, and the component tests drive the same
 * `window.tesseraInternal` seam the real pages use, which is what makes them worth having.
 *
 * ## How this file disappears
 *
 * The moment `bookmarks` and `downloads` appear in `INTERNAL_PAGE_INVOKE_CHANNELS` with their
 * channels, and those channels appear in `contract.ts`, the bodies below become
 * `invoke('bookmarks:list')` from `bridge.ts` and this module goes. The signatures are
 * deliberately identical to what the generic `invoke` would infer, so that change touches no
 * call site. The exact contract entries needed are listed in the handover notes.
 */

/**
 * The bridge as this module needs to see it.
 *
 * Deliberately minimal, and deliberately *not* `OwnBrowserInternalBridge`: that interface is
 * generic over the channel union, which is the very thing this module exists to work around.
 * A narrow structural shape makes the single cast below small enough to read.
 */
interface UntypedBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  on(channel: string, listener: (payload: unknown) => void): () => void
}

function bridge(): UntypedBridge | undefined {
  // The one cast in this file. `window.tesseraInternal` really does have these two methods —
  // `internal-api.d.ts` declares them, generically over the channel union — so this widens
  // the channel type and nothing else.
  return window.tesseraInternal
}

export function internalBridgeAvailable(): boolean {
  return bridge() !== undefined
}

class MissingBridgeError extends Error {
  constructor(channel: string) {
    super(`this page cannot reach the browser core (${channel})`)
    this.name = 'MissingBridgeError'
  }
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const target = bridge()
  if (target === undefined) throw new MissingBridgeError(channel)
  const answer = await target.invoke(channel, payload)
  // The core validated the response against the contract before it was sent; this restores
  // the type that validation established rather than asserting anything new.
  return answer as T
}

/*
   `T` appears once in the signature, which the linter flags — and here it is load-bearing rather than decorative:
   it ties the caller's listener to the payload type it declares at the call site. Silenced rather than removed,
   because the alternative is `unknown` at every subscription.
*/
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function listen<T>(channel: string, listener: (payload: T) => void): () => void {
  const target = bridge()
  // A no-op unsubscribe keeps callers from having to special-case an absent bridge in their
  // cleanup path — the same choice `bridge.ts` makes for `subscribeQuickLinks`.
  if (target === undefined) return () => {}
  return target.on(channel, (payload) => {
    listener(payload as T)
  })
}

// --- bookmarks ---------------------------------------------------------------

export interface CreateBookmarkRequest {
  kind: BookmarkKind
  title: string
  url?: string
  parentId?: string
  index?: number
}

export interface BookmarkImportResult {
  imported: number
  skipped: number
  /** True when the user closed the file picker; not an error, and not "nothing imported". */
  cancelled: boolean
}

export interface RemovedCount {
  removed: number
}

export const bookmarksApi = {
  list: () => call<Bookmark[]>('bookmarks:list'),
  create: (request: CreateBookmarkRequest) => call<Bookmark>('bookmarks:create', request),
  update: (request: { id: string; title?: string }) => call<Bookmark>('bookmarks:update', request),
  /** The "this page has moved" operation; keeps the title, folder and position. */
  relocate: (request: { id: string; url: string }) => call<Bookmark>('bookmarks:relocate', request),
  remove: (id: string) => call<RemovedCount>('bookmarks:remove', { id }),
  move: (request: { id: string; parentId: string; toIndex: number }) =>
    call<Bookmark[]>('bookmarks:move', request),
  /** Resolved to the tab that asked, exactly as `history:open` is. Never `nav:navigate`. */
  open: (url: string) => call<{ url: string }>('bookmarks:open', { url }),
  /**
   * Opens the OS file picker in the core and reads what the user chose.
   *
   * The path is never passed in — the same rule `extensions:load` follows, so a compromised
   * renderer cannot ask the core to read an arbitrary file and hand back its contents.
   */
  import: () => call<BookmarkImportResult>('bookmarks:import')
}

// --- downloads ---------------------------------------------------------------

export interface DownloadListing {
  downloads: DownloadEntry[]
  /**
   * True when the asking window is private.
   *
   * Sent because the page cannot know it and the difference is visible: a private window's own
   * downloads are shown while they exist and are written nowhere, so without this the page
   * could not explain why a finished download left no row behind.
   */
  privateWindow: boolean
}

export const downloadsApi = {
  list: () => call<DownloadListing>('downloads:list'),
  pause: (id: string) => call<{ changed: boolean }>('downloads:pause', { id }),
  resume: (id: string) => call<{ changed: boolean }>('downloads:resume', { id }),
  cancel: (id: string) => call<{ changed: boolean }>('downloads:cancel', { id }),
  remove: (id: string) => call<{ removed: boolean }>('downloads:remove', { id }),
  clear: () => call<RemovedCount>('downloads:clear'),
  open: (id: string) => call<{ opened: boolean }>('downloads:open', { id }),
  reveal: (id: string) => call<{ revealed: boolean }>('downloads:reveal', { id }),
  /** Coalesced by the core to a few a second; see `DownloadManager`. */
  subscribe: (listener: (payload: DownloadListing) => void) =>
    listen<DownloadListing>('downloads:changed', listener)
}
