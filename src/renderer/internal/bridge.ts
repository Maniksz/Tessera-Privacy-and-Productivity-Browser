import type { InternalEventChannel, InternalInvokeChannel } from '@shared/ipc/channels.js'
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

/**
 * Subscribes to an event, if this page is one of the pages granted it.
 *
 * The grant is per page — `INTERNAL_PAGE_EVENT_CHANNELS` gives `settings:changed` to the settings
 * page and to nothing else — so a helper that simply called `on` would work on one page and be
 * refused by the preload on the rest. That matters because the caller is sometimes shared code:
 * `useInternalI18n` runs on all seven pages and wants to re-read its catalogue when the language
 * changes, which only the settings page can be told about.
 *
 * So the grant is consulted rather than assumed. The bridge publishes what this page may hear in
 * `channels.event` — the preload puts the page's own row there — and a channel not in it yields the
 * same no-op unsubscribe as an absent bridge. The caller writes one subscription and gets nothing on
 * the pages where nothing is possible, instead of a refusal it would have to catch.
 *
 * This is a convenience gate and not the security one. The preload checks again, and the core checks
 * a third time from the frame URL, because a compromised renderer is exactly the case where this
 * object's own answer cannot be trusted.
 */
export function subscribe<C extends InternalEventChannel>(
  channel: C,
  listener: (payload: EventPayload<C>) => void
): () => void {
  const bridge = window.tesseraInternal
  if (bridge === undefined) return () => {}
  if (!bridge.channels.event.includes(channel)) return () => {}
  return bridge.on(channel, listener)
}
