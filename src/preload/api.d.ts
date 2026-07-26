import type { EventChannel, InvokeChannel } from '../shared/ipc/channels.js'
import type { EventPayload, InvokeRequest, InvokeResponse } from '../shared/ipc/contract.js'

/**
 * The renderer's view of the bridge.
 *
 * Types come from the same contract the main process validates against, so a
 * renaming or a changed argument breaks the build on both sides at once
 * (spec 6). These are type-only declarations: the zod schemas never reach the
 * renderer bundle.
 *
 * The conditional overloads exist so channels whose request is `void` are
 * called without a second argument, while the rest require one — a missing
 * payload is a compile error, not an `undefined` arriving in a handler.
 */
export interface OwnBrowserBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeRequest<C> extends void | undefined ? [] : [payload: InvokeRequest<C>]
  ): Promise<InvokeResponse<C>>

  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void

  readonly channels: {
    readonly invoke: readonly InvokeChannel[]
    readonly event: readonly EventChannel[]
  }
}

declare global {
  interface Window {
    readonly tessera: OwnBrowserBridge
  }
}
