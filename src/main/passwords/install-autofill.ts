import { app, type IpcMainEvent, type WebContents } from 'electron'
import {
  AUTOFILL_FILL_CHANNEL,
  AUTOFILL_OFFER_CHANNEL,
  AUTOFILL_SAVE_ANSWER_CHANNEL,
  AUTOFILL_SUBMIT_CHANNEL
} from '@shared/passwords/wire.js'
import type { AutofillFrame, AutofillService } from './AutofillService.js'

/**
 * The wiring, and only the wiring.
 *
 * Every decision lives in `AutofillService`, which knows nothing about Electron so that it can be
 * tested. What is left here is the part that can only happen here: reading the frame tree, and
 * attaching per-view listeners.
 *
 * ## Why per-`webContents` listeners rather than `ipcMain`
 *
 * A listener attached to a view dies with the view that could have used it, so there is nothing to
 * accumulate and nothing to clean up on the wrong side. It also means the sender *is* the view the
 * listener belongs to, so there is no sender check to write by hand — and a sender check written by
 * hand on the password channels is the one this project would least like to get wrong. Same
 * construction as `CosmeticInjector` and `ElementPicker`.
 *
 * ## Why the frame facts are read here and not sent
 *
 * `event.senderFrame` is Chromium's own account of which frame spoke. The preload could claim
 * anything about its address and its depth; a compromised renderer is precisely the case the
 * cross-origin-frame rule exists for, so neither is taken from the message.
 */

/**
 * The frame that sent a message, as the core sees it.
 *
 * `senderFrame` is `null` when the frame has already navigated or been destroyed — a real race, not
 * a defensive branch. It becomes a frame with no top-level URL, which every policy in
 * `shared/passwords` treats as a refusal. The contents' own URL is *not* substituted: the whole
 * value of this function is that it can report a frame whose address differs from the view's.
 */
function frameOf(event: IpcMainEvent): AutofillFrame {
  const frame = event.senderFrame
  if (frame === null) return { url: '', isTopLevel: false, topLevelUrl: null }
  // `parent === null` is the definition of the top frame in Electron's tree. Comparing against
  // `frame.top` would be equivalent for a live tree and misleading for a detached one.
  const isTopLevel = frame.parent === null
  const top = frame.top
  return { url: frame.url, isTopLevel, topLevelUrl: top === null ? null : top.url }
}

/**
 * Starts answering autofill messages. Installed once for the application, not once per session.
 *
 * The subscription set is the interesting part:
 *
 *   - `input-event` is the *only* source of the gesture the fill rules require. It fires for input
 *     the browser process dispatched, so a page calling `.click()` cannot produce one.
 *   - `did-start-navigation` drops a pending save that has left its site, and deliberately not one
 *     that is merely following the redirect a sign-in caused — that navigation is the one the save
 *     bar has to survive.
 *   - `dom-ready` re-raises a surviving pending save on the page the sign-in landed on. Without it
 *     the bar would be drawn into a document that is already gone and the question would never be
 *     asked, which is the shape this feature fails in silently.
 */
export function installAutofill(service: AutofillService): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.on('input-event', (_ipcEvent, input) => {
      service.noteInput(contents.id, input)
    })

    contents.on('ipc-message-sync', (event, channel, ...args) => {
      if (channel === AUTOFILL_OFFER_CHANNEL) {
        event.returnValue = service.offerFor(contents, frameOf(event), args[0])
        return
      }
      if (channel === AUTOFILL_FILL_CHANNEL) {
        event.returnValue = service.fillFor(contents, frameOf(event), args[0])
      }
    })

    contents.on('ipc-message', (event, channel, ...args) => {
      if (channel === AUTOFILL_SUBMIT_CHANNEL) {
        service.reportSubmission(contents, frameOf(event), args[0])
        return
      }
      if (channel === AUTOFILL_SAVE_ANSWER_CHANNEL) {
        service.answerSave(contents, args[0])
      }
    })

    contents.on('did-start-navigation', (details) => {
      // Main frame only, and `details.url` rather than the deprecated positional argument. A
      // subframe navigating says nothing about where the user is, and a same-document navigation
      // — the shape a single-page application signs in with — must not drop the offer either.
      if (!details.isMainFrame) return
      service.noteNavigation(contents.id, details.url)
    })

    contents.on('dom-ready', () => {
      service.documentReady(contents, {
        url: contents.getURL(),
        // `dom-ready` is a main-frame event, so the document that just loaded is the top-level one.
        isTopLevel: true,
        topLevelUrl: contents.getURL()
      })
    })

    contents.once('destroyed', () => {
      service.forget(contents.id)
    })
  })
}
