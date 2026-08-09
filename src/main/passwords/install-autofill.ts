import { app, type Event, type InputEvent, type IpcMainEvent, type WebContents } from 'electron'
import type { AutofillFrame, AutofillService } from './AutofillService.js'
import { wireAutofillView, type AutofillHost } from './autofill-wiring.js'

/**
 * The Electron half of autofill's wiring, and only that.
 *
 * Every decision lives in `AutofillService`; what each of a view's events *means* lives in
 * `autofill-wiring.ts`. What is left here is the part that can only happen here: reading the frame
 * tree, and translating Electron's events into the host that file subscribes through.
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
 *
 * ## Why the meaning of the events is not here
 *
 * Because the defect was in the meaning, not in the plumbing. `input-event` was attached only once
 * an offer had been served, and an offer could not be served until an input event had been seen — a
 * circle that made autofill unable to fill anything, that no test could reach, and that reading the
 * two halves separately does not reveal. Behind the host below, the whole chain is drivable from a
 * test. See `autofill-wiring.ts`.
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

/** Electron's account of one view, in the shape the wiring subscribes through. */
function hostFor(contents: WebContents): AutofillHost {
  return {
    view: contents,
    onSyncMessage: (listener) => {
      contents.on('ipc-message-sync', (event, channel, ...args) => {
        const reply = listener(channel, frameOf(event), args[0])
        // Only when the channel was autofill's. Other features listen for their own synchronous
        // channels on this same view, and assigning here unconditionally would answer theirs.
        if (reply !== null) event.returnValue = reply.answer
      })
    },
    onMessage: (listener) => {
      contents.on('ipc-message', (event, channel, ...args) => {
        listener(channel, frameOf(event), args[0])
      })
    },
    onInput: (listener) => {
      const subscription = (_event: Event, input: InputEvent): void => {
        listener(input)
      }
      contents.on('input-event', subscription)
      // The listener itself is what `removeListener` needs — a fresh arrow function would not match
      // the one `.on()` was given — so the way off is closed over rather than looked up again.
      return () => contents.removeListener('input-event', subscription)
    },
    onMainFrameNavigation: (listener) => {
      contents.on('did-start-navigation', (details) => {
        // `details.url` rather than the deprecated positional argument, and the main frame only: a
        // subframe navigating says nothing about where the user is.
        if (!details.isMainFrame) return
        listener(details.url)
      })
    },
    onDocumentReady: (listener) => {
      contents.on('dom-ready', () => {
        listener(contents.getURL())
      })
    },
    onDestroyed: (listener) => {
      contents.once('destroyed', listener)
    }
  }
}

/** Starts answering autofill messages. Installed once for the application, not once per session. */
export function installAutofill(service: AutofillService): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    wireAutofillView(service, hostFor(contents))
  })
}
