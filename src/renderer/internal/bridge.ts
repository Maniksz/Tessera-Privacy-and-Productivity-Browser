import type { InternalInvokeChannel } from '@shared/ipc/channels.js'
import type { EventPayload, InvokeRequest, InvokeResponse } from '@shared/ipc/contract.js'

/**
 * Internal pages' access to the core.
 *
 * The bridge is absent when this code somehow runs outside an `tessera://`
 * document — the preload only installs it for internal origins. Rather than
 * crashing on a missing global, the helpers below fail loudly with a message that
 * names the actual cause, which is the difference between a five-minute and a
 * two-hour diagnosis.
 */

export class MissingInternalBridgeError extends Error {
  constructor() {
    super(
      'tessera internal bridge is unavailable — this page is not running on an tessera:// origin'
    )
    this.name = 'MissingInternalBridgeError'
  }
}

export function bridgeAvailable(): boolean {
  return typeof window.tesseraInternal === 'object' && window.tesseraInternal !== null
}

export function invoke<C extends InternalInvokeChannel>(
  channel: C,
  ...args: InvokeRequest<C> extends void | undefined ? [] : [payload: InvokeRequest<C>]
): Promise<InvokeResponse<C>> {
  const bridge = window.tesseraInternal
  if (bridge === undefined) return Promise.reject(new MissingInternalBridgeError())
  return bridge.invoke(channel, ...args)
}

export function subscribeQuickLinks(
  listener: (payload: EventPayload<'quicklinks:changed'>) => void
): () => void {
  const bridge = window.tesseraInternal
  // A no-op unsubscribe keeps callers from having to special-case the absence of
  // the bridge in their cleanup path.
  if (bridge === undefined) return () => {}
  return bridge.on('quicklinks:changed', listener)
}
