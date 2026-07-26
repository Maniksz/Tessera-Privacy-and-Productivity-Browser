import type { PermissionArbiter } from '../permissions/PermissionArbiter.js'
import { onOverlayVacancy } from '../permissions/vacancy.js'
import { handle, OK } from './router.js'

/**
 * The permission prompt's two connections to Electron.
 *
 * Separate from `handlers.ts` because both are the *same* wiring seen from two sides, and
 * splitting them across files would hide that: one channel carries the answer a person gave, and
 * one subscription carries every way the dialogue can leave the screen without one. A build that
 * registered the first and forgot the second would work perfectly until a user resized a window
 * mid-prompt, and then a page would hang.
 *
 * Nothing here decides anything. The arbiter does, and it is deliberately free of Electron so that
 * queueing, coalescing and refusing can be tested without a window.
 */

export function registerPermissionHandlers(deps: { permissions: PermissionArbiter }): void {
  const { permissions } = deps

  /*
    Chrome-only by construction: the channel is on no internal page's allowlist, and the sender
    policy classifies every sender independently of what the preload believes. It has to be — the
    request id is the only thing standing between a page and the ability to answer a dialogue on
    the user's behalf, and a page that could reach this channel would not need to guess for long.
  */
  handle('permissions:answer', ({ requestId, answer }) => {
    permissions.answer(requestId, answer)
    return OK
  })

  /*
    Never unsubscribed, and that is correct rather than an oversight: there is one arbiter for the
    life of the process, and the layer it listens to outlives every individual window.
  */
  onOverlayVacancy((presentation, reason) => {
    permissions.overlayVacated(presentation, reason)
  })
}
