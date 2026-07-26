import type { InternalEventChannel, InternalInvokeChannel } from '../shared/ipc/channels.js'
import type { EventPayload, InvokeRequest, InvokeResponse } from '../shared/ipc/contract.js'

/**
 * What internal pages (`tessera://…`) see.
 *
 * Types come from the same contract the main process validates against, so the
 * start page cannot drift from the core either (spec 6). The channel type is
 * narrowed to `InternalInvokeChannel`, which means calling a chrome-only channel
 * from an internal page is a compile error — not just a refusal at runtime.
 */
export interface OwnBrowserInternalBridge {
  invoke<C extends InternalInvokeChannel>(
    channel: C,
    ...args: InvokeRequest<C> extends void | undefined ? [] : [payload: InvokeRequest<C>]
  ): Promise<InvokeResponse<C>>

  /**
   * Subscribes to one of the events this page's own allowlist grants.
   *
   * Typed over `InternalEventChannel` rather than a single literal. It was `'quicklinks:changed'` alone, which
   * meant the settings page could not subscribe to `settings:changed` without a cast even though the table
   * grants it and the preload installs it — so the settings panel updated live and the settings tab did not.
   *
   * Still narrower than the chrome bridge's `on`: this union is what *some* internal page may hear, and the
   * preload refuses a channel this particular page was not granted. Two gates, as everywhere on this boundary.
   */
  on<C extends InternalEventChannel>(
    channel: C,
    listener: (payload: EventPayload<C>) => void
  ): () => void

  readonly channels: {
    readonly invoke: readonly InternalInvokeChannel[]
    readonly event: readonly string[]
  }
}

declare global {
  interface Window {
    /** Present only on `tessera://` pages; `undefined` on visited web pages. */
    readonly tesseraInternal?: OwnBrowserInternalBridge
  }
}
