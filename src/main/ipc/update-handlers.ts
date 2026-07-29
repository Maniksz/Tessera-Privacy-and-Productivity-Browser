import type { InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'

/**
 * The `updates:*` channel. One channel, and the smallest registrar in this directory.
 *
 * ## Why it is not in `handlers.ts`
 *
 * The same reason `media-handlers.ts` gives, and it applies here more sharply than the line count
 * that prompted the move. `ipc/router.ts` imports `ipcMain`, so `handlers.ts` can only run inside a
 * live Electron process — it is excluded from coverage and has no unit tests at all. Taking the
 * registrar as an argument makes this body an ordinary function a test can call, and this is the one
 * update operation a page can reach: the assertion that a press runs the *on-demand* check and
 * reports completion is worth being able to make without a window.
 *
 * ## What a page may and may not reach
 *
 * `checkForUpdates` is a closure, not the `UpdateService`, and that is not a taste question. Two
 * reasons, and the second is the load-bearing one:
 *
 *   - The service does not exist yet when the handlers go up. `registerIpcHandlers` is what calls
 *     `configureSenderPolicy`, so it has to run before anything schedules a network job; `index.ts`
 *     assigns the service afterwards and the closure reads it then.
 *   - A reference to the service would put `download`, `installAndRestart` and `start` one dot away
 *     from a future handler in this file. A page may cause a request to GitHub and a dialogue it
 *     answers itself. It may not cause a download, an install, or a change to the schedule. Handing
 *     over exactly the one verb keeps that from being a matter of care.
 */
export interface UpdateHandlerDeps {
  /** Registers one channel, validated by the router. */
  handle: <C extends 'updates:checkNow'>(
    channel: C,
    handler: (payload: InvokeHandlerArg<C>) => Promise<InvokeResponse<C>>
  ) => void
  /** Runs an update check the user asked for, and resolves when it is finished. */
  checkForUpdates: () => Promise<void>
  /** The contract's success value, passed in so this module needs nothing from the core. */
  ok: InvokeResponse<'updates:checkNow'>
}

export function registerUpdateHandlers(deps: UpdateHandlerDeps): void {
  /*
    Awaited rather than detached, which is the whole reason this channel is worth having.

    `UpdateService.checkNow()` is the fire-and-forget wrapper the Help menu uses — a menu item has
    nobody to report back to. A button does: the promise is what tells the page the check is over, so
    the control can stay disabled while it runs instead of guessing with a timer. `checkOnDemand`
    also answers a second press from the check already in flight, so leaning on the button produces
    one request to GitHub and one dialog however many times it is pressed.

    Nothing here consults `updates.checkAutomaticallyOnGithub`, and that is deliberate: that setting
    governs the *timer*. Somebody who switched the timer off and then pressed a button has asked, and
    a button that silently declined would be the defect spec 5 is written against.
  */
  deps.handle('updates:checkNow', async () => {
    await deps.checkForUpdates()
    return deps.ok
  })
}
