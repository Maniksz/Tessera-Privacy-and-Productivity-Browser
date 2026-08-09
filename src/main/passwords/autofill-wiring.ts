import {
  AUTOFILL_FILLABLE_CHANNEL,
  AUTOFILL_FILL_CHANNEL,
  AUTOFILL_OFFER_CHANNEL,
  AUTOFILL_SAVE_ANSWER_CHANNEL,
  AUTOFILL_SUBMIT_CHANNEL
} from '@shared/passwords/wire.js'
import type { AutofillFrame, AutofillService, AutofillView } from './AutofillService.js'

/**
 * What a view's events mean to autofill, with Electron left outside.
 *
 * ## Why this is a file and not the body of `installAutofill`
 *
 * The wiring is where autofill's worst defect lived, and it was invisible for exactly as long as it
 * could only be read. `input-event` — the sole producer of the gesture every fill requires — was
 * attached only after `offerFor` returned an offer, and `offerFor` refused for want of that very
 * gesture. No gesture, no offer; no offer, no listener; no listener, no gesture. Autofill could not
 * fill anything, in any tab, ever, and every test passed: each half was correct on its own and the
 * circle was only visible in the order the two were called in. Nothing could be asserted about that
 * order, because asserting it meant starting Electron.
 *
 * With the subscriptions arriving through a host, the whole chain — a form reported, an input event
 * dispatched, an offer asked for, a fill authorised — is an object literal and a sequence of calls.
 * Same shape, and the same reason, as `window-events.ts`.
 *
 * ## What stayed in `install-autofill.ts`
 *
 * Reading the frame tree, and `app.on('web-contents-created')`. Both are Electron's own account of
 * something, which is precisely what must not be reconstructed on this side: `AutofillFrame` is
 * built from `event.senderFrame`, never from anything the message claimed about where it came from.
 */

/**
 * The answer to a synchronous message, or `null` when the channel was not autofill's.
 *
 * `null` rather than `undefined`, because `undefined` is a legitimate answer and other features
 * listen for their own synchronous channels on the same view — `CosmeticInjector`, `ElementPicker`,
 * the sandbox hardening. A host that assigned a return value for every message it saw would answer
 * theirs with nothing.
 */
export type SyncReply = { readonly answer: unknown } | null

/**
 * A view, as narrowly as autofill's wiring sees one.
 *
 * Members are the smallest shape that satisfies the use rather than the Electron types that do, so a
 * test writes an object literal instead of building a `WebContents`.
 */
export interface AutofillHost {
  /** The view itself, in the shape `AutofillService` takes one. */
  readonly view: AutofillView
  /** Synchronous messages from the page's preload, with the frame as the core read it. */
  onSyncMessage(listener: (channel: string, frame: AutofillFrame, payload: unknown) => SyncReply): void
  /** Messages that expect no answer. */
  onMessage(listener: (channel: string, frame: AutofillFrame, payload: unknown) => void): void
  /**
   * Starts reporting this view's input events, and answers the way to stop.
   *
   * The disposer is handed back rather than paired with an `offInput`, because the listener itself
   * is what an unsubscribe needs and a second lookup by name is a second chance to remove the wrong
   * one. Called again only after the previous disposer has been used.
   */
  onInput(listener: (input: unknown) => void): () => void
  /** Main-frame navigations only. A subframe navigating says nothing about where the user is. */
  onMainFrameNavigation(listener: (url: string) => void): void
  /** A main-frame document finished loading, at this address. */
  onDocumentReady(listener: (url: string) => void): void
  onDestroyed(listener: () => void): void
}

/**
 * Subscribes one view to autofill.
 *
 * The interesting part is `input-event`, which is the only subscription attached and detached on
 * demand rather than for the life of the view: every mouse press in every tab would otherwise cost a
 * main-process round trip, in tabs that will never fill anything. The gate is
 * `AUTOFILL_FILLABLE_CHANNEL` — the page reporting that a fillable password field has focus — and
 * that report is answered by the service, which refuses it outright when the feature is switched off.
 *
 * It has to be that report and not the offer. The offer is decided by `decideFill`, whose first rule
 * demands the gesture this listener exists to record, so gating the listener on it was a circle with
 * no way in. What gates it now is a fact the page can state before any rule has been applied, and
 * stating it falsely buys a listener and nothing else.
 */
export function wireAutofillView(service: AutofillService, host: AutofillHost): void {
  const view = host.view
  /**
   * The way to stop listening to input, or `null` while nothing is being listened to.
   *
   * Kept rather than a boolean, for the reason the disposer is handed back at all: it is the
   * subscription, and there is no way to name it twice.
   */
  let stopInput: (() => void) | null = null

  const trackGestures = (needed: boolean): void => {
    if (needed) {
      if (stopInput !== null) return
      stopInput = host.onInput((input) => service.noteInput(view.id, input))
      return
    }
    if (stopInput === null) return
    stopInput()
    stopInput = null
  }

  host.onSyncMessage((channel, frame, payload) => {
    if (channel === AUTOFILL_OFFER_CHANNEL) return { answer: service.offerFor(view, frame, payload) }
    if (channel === AUTOFILL_FILL_CHANNEL) return { answer: service.fillFor(view, frame, payload) }
    return null
  })

  host.onMessage((channel, frame, payload) => {
    if (channel === AUTOFILL_FILLABLE_CHANNEL) {
      trackGestures(service.noteFillableForm(payload))
      return
    }
    if (channel === AUTOFILL_SUBMIT_CHANNEL) {
      service.reportSubmission(view, frame, payload)
      return
    }
    if (channel === AUTOFILL_SAVE_ANSWER_CHANNEL) {
      service.answerSave(view, payload)
    }
  })

  host.onMainFrameNavigation((url) => {
    service.noteNavigation(view.id, url)
  })

  host.onDocumentReady((url) => {
    // A main-frame event, so the document that just loaded is the top-level one.
    service.documentReady(view, { url, isTopLevel: true, topLevelUrl: url })
  })

  host.onDestroyed(() => {
    // Before `forget`, so the subscription goes even in a host that outlives the view it describes.
    trackGestures(false)
    service.forget(view.id)
  })
}
