import type { PermissionArbiter } from '../permissions/PermissionArbiter.js'
import type { WindowRegistry } from '../browser/WindowRegistry.js'
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

export function registerPermissionHandlers(deps: {
  permissions: PermissionArbiter
  /**
   * Every window, for the second prompt that lives on this layer.
   *
   * The popup-and-redirect prompt is per window — it holds a callback that re-issues a navigation in one
   * particular view — while the vacancy announcement is application-wide. So the departure is offered to
   * every window and each one ignores an id that is not the question it has on screen.
   */
  windows: WindowRegistry
}): void {
  const { permissions, windows } = deps

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
  /*
    The answer to "this page wants to open something".

    Chrome-only for the reason above, and checked twice: the channel is on no internal page's allowlist,
    and the controller passes the id to the prompt, which ignores a reply for a question it is not asking.
  */
  handle('navigation:answer', ({ requestId, permitted }, event) => {
    windows.resolve(event)?.answerNavigationPrompt(requestId, permitted)
    return OK
  })

  onOverlayVacancy((presentation, reason) => {
    permissions.overlayVacated(presentation, reason)
    /*
      The other surface on this layer that something is waiting on.

      Offered to every window because the announcement carries a presentation and not a window; each
      controller compares the id with what it is asking and ignores the rest. A page whose prompt was
      displaced or dismissed stays where it is, which is the stated fallback.
    */
    if (presentation.kind === 'navigation-request') {
      for (const controller of windows.controllers) {
        controller.navigationPromptVacated(presentation.requestId)
      }
    }
  })
}
