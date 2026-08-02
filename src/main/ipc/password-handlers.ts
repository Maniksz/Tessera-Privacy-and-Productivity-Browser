import type { MasterPasswordHost, MasterPasswordPrompt } from '../passwords/MasterPasswordPrompt.js'
import type { PasswordApi } from '../passwords/PasswordApi.js'
import { onOverlayKey } from '../passwords/overlay-keys.js'
import { onOverlayVacancy } from '../permissions/vacancy.js'
import type { WindowRegistry } from '../browser/WindowRegistry.js'
import { internalUrl } from '@shared/product.js'
import { handle, OK } from './router.js'

/**
 * The vault channels, and the three subscriptions the prompt cannot work without.
 *
 * Separate from `handlers.ts` for the reason `permission-handlers.ts` is: these are one mechanism seen
 * from several sides, and splitting them across files would hide that a build can register some and
 * forget the rest. Concretely, forgetting any one of the three below produces a *different* silent
 * failure, and none of them is a crash:
 *
 *   - no `onOverlayKey` — the prompt appears and typing does nothing at all, for ever;
 *   - no `onOverlayVacancy` — a prompt taken down by a window resize leaves `passwords:requestUnlock`
 *     pending, so the passwords page waits on a promise that will never settle;
 *   - no `passwords:answerPrompt` — the prompt works by keyboard and its two buttons are dead.
 *
 * Nothing here decides anything. `PasswordApi` and `MasterPasswordPrompt` do, and both are free of
 * Electron so that the sequence, the refusals and the reset ordering are tests rather than claims.
 */

export function registerPasswordHandlers(deps: {
  passwords: PasswordApi
  prompt: MasterPasswordPrompt
  windows: WindowRegistry
}): void {
  const { passwords, prompt, windows } = deps

  /*
    The window the prompt appears in, resolved from the *sender* and never from "the focused window".

    A prompt drawn in a window the request did not come from would be a master-password field appearing
    over somebody else's page, which is both alarming and the shape a phishing attempt wants. `null` when
    the sender belongs to no window of ours — a view being torn down — and there is then nowhere to draw
    a dialogue, so nobody can answer it, so it is cancelled.
  */
  const hostFor = (event: { sender: { id: number } }): MasterPasswordHost | null =>
    windows.controllerForWebContents(event.sender.id) ?? null

  // --- the list and one secret ----------------------------------------------
  /*
    Six one-line forwards. Every decision lives in `PasswordApi`, which is free of Electron and therefore
    measurable — and the operations that touch a password vault are the ones this project would least like
    to have only in a file no test reaches.

    `update` is rebuilt key by key, which here is not pedantry: `exactOptionalPropertyTypes` treats an
    absent field and one holding `undefined` as different types, and a request that crossed IPC has the
    second shape — so spreading it would hand the vault `{ password: undefined }` and claim an edit nobody
    asked for, and the edit in question overwrites a password.
  */
  handle('passwords:list', () => passwords.list())
  handle('passwords:reveal', ({ id }) => passwords.reveal({ id }))
  handle('passwords:create', ({ url, username, password }) =>
    passwords.create({ url, username, password })
  )
  handle('passwords:update', ({ id, username, password }) =>
    passwords.update({
      id,
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password })
    })
  )
  handle('passwords:remove', ({ id }) => passwords.remove({ id }))
  handle('passwords:forgetNeverSaved', ({ origin }) => passwords.forgetNeverSaved({ origin }))

  // --- the lock -------------------------------------------------------------
  handle('passwords:vaultStatus', () => passwords.vaultStatus())
  /*
    Resolves when the person answers, which may be minutes.

    Deliberately not given a timeout. A prompt that gave up on its own would settle the request while the
    field was still on screen collecting characters, and the next keystroke would land in a surface nobody
    was waiting on. Every way the prompt can *leave* settles it, which is the bound that matters.
  */
  handle('passwords:requestUnlock', (_payload, event) => passwords.requestUnlock(hostFor(event)))
  handle('passwords:lock', () => passwords.lock())
  handle('passwords:beginSetMasterPassword', ({ intent }, event) =>
    passwords.beginSetMasterPassword({ intent }, hostFor(event))
  )
  handle('passwords:resetVault', ({ confirmation }) => passwords.resetVault({ confirmation }))
  handle('passwords:import', () => passwords.import())

  /*
    Continue and Cancel. Chrome-only by construction: the channel is on no internal page allowlist, and
    the sender policy classifies every sender independently of what the preload believes.

    The request id is checked against the prompt actually pending, so a stale or invented one resolves
    nothing. There is no candidate in the payload to forge — the worst a forged call can do is spend or
    abandon what the person at the keyboard has already typed.
  */
  handle('passwords:answerPrompt', ({ requestId, action }) => {
    prompt.answer(requestId, action)
    return OK
  })

  /*
    The settings page's way to the passwords page, and the reason it needs one.

    An `<a href="tessera://passwords">` there is not merely unfashionable — `navigation-policy.ts`
    refuses it. Page content may not navigate to an internal address, and the settings page *is* page
    content; the rule exists so a visited site cannot reach an address whose privileges it would then
    inherit, and it cannot make an exception for our own pages without making one for every page.

    The address is written here rather than taken from the request, so this channel has exactly one
    destination however it is called. The window comes from the sender, so a settings tab opens the
    passwords tab beside itself rather than in whichever window happens to be focused — the same rule
    the master-password prompt follows one screen up, and for a milder version of the same reason.
  */
  handle('passwords:openManager', (_payload, event) => {
    windows.controllerForWebContents(event.sender.id)?.createTab({ url: internalUrl('passwords') })
    return OK
  })

  /*
    Never unsubscribed, and that is correct rather than an oversight: there is one prompt service for the
    life of the process, and the layer it listens to outlives every individual window.
  */
  onOverlayKey((presentation, input) => {
    prompt.key(presentation, input)
  })
  onOverlayVacancy((presentation, reason) => {
    prompt.overlayVacated(presentation, reason)
  })
}
