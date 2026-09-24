import { app, type Event, type InputEvent, type IpcMainEvent, type WebContents } from 'electron'
import type { Locale } from '@shared/i18n/catalog.js'
import type { AutofillKeyState } from '@shared/passwords/model.js'
import type { Rect } from '@shared/ui/anchor.js'
import type { BrowserWindowController } from '../browser/BrowserWindowController.js'
import { AutofillService, type AutofillFrame, type AutofillVault } from './AutofillService.js'
import { AutofillSuggest } from './AutofillSuggest.js'
import type { MasterPasswordPrompt } from './MasterPasswordPrompt.js'
import { wireAutofillView, type AutofillHost } from './autofill-wiring.js'
import { liveContentsOf } from '../browser/view-contents.js'

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

/** The windows, as autofill asks about them. `WindowRegistry` satisfies it. */
export interface AutofillWindows {
  readonly controllers: readonly BrowserWindowController[]
  controllerForWebContents(webContentsId: number): BrowserWindowController | undefined
}

/** What the rest of the core holds of autofill once it is running. */
export interface AutofillParts {
  readonly service: AutofillService
  readonly suggest: AutofillSuggest
  /** The toolbar key's state for a window's active tile (R10). */
  keyStateFor(window: BrowserWindowController | undefined): AutofillKeyState
  /**
   * A fill asked for from browser chrome, for a window's active tile: the key, the shortcut (R11,
   * R12). `anchor` is the key's rectangle, or `null` to hang the list from the field.
   */
  fillActiveTab(window: BrowserWindowController | undefined, anchor: Rect | null): void
}

/**
 * Starts answering autofill messages, and returns what the rest of the core holds of it.
 *
 * Installed once for the application, not once per session. Everything Electron-shaped autofill
 * needs is read here, from the thing that owns it, and never recomputed:
 *
 *   - `modeFor` is what makes a private window fill without recording that it did, and it answers
 *     `null` for a view this browser cannot place — a devtools window, something being torn down —
 *     because the default for anything unaccounted for has to be "no".
 *   - `onLock` is what keeps a lock from being a half-truth: without it the key would be gone from the
 *     vault while a password the user typed two minutes ago sat in the save bar state for the rest of
 *     its two minutes (`AutofillService.dropPendingSaves`). It also tells every toolbar key.
 *   - `targetFor` gives the picker the tile from the tab, the rectangle from the view the window
 *     positioned, and the zoom from the tab's own ladder. A second opinion about where a tile is would
 *     eventually disagree with the first, and the symptom would be a list of somebody's account names
 *     floating over the wrong pane.
 *   - `requestUnlock` is a closure rather than the prompt itself, and it is the reason R9 is a property
 *     of the program rather than a comment: the picker can raise the master-password prompt and can do
 *     nothing else with it.
 *
 * `AutofillService` and the old `installAutofill` were once complete, tested and called by nothing —
 * which is why this returns the parts rather than leaving them for a caller to remember to build.
 */
export function installAutofill(deps: {
  readonly vault: AutofillVault & { onLock(listener: () => void): () => void }
  readonly prompt: Pick<MasterPasswordPrompt, 'requestUnlock'>
  /** Read per call: the registry is built after autofill, and outlives nothing it is asked about. */
  readonly windows: () => AutofillWindows | null
  /** `passwords.autofill`, per call, so switching it off reaches the form already on screen. */
  readonly enabled: () => boolean
  readonly locale: () => Locale
}): AutofillParts {
  const { vault, windows } = deps
  const service = new AutofillService({
    vault,
    enabled: deps.enabled,
    modeFor: (viewId) => {
      const controller = windows()?.controllerForWebContents(viewId)
      if (controller === undefined) return null
      return controller.privateMode ? 'private' : 'normal'
    },
    locale: deps.locale,
    now: () => Date.now()
  })
  const suggest = new AutofillSuggest({
    service,
    targetFor: (viewId) => {
      const controller = windows()?.controllerForWebContents(viewId)
      if (controller === undefined) return null
      const tab = controller.tabForWebContents(viewId)
      // A tab loaded but not on screen has no tile, and a list has to be drawn in one.
      if (tab?.tileIndex == null) return null
      return {
        window: controller,
        tileIndex: tab.tileIndex,
        // A factor, not a percentage, so the arithmetic in `suggest-bounds.ts` is one step.
        geometry: { bounds: tab.view.getBounds(), pageZoom: tab.zoomPercent / 100 }
      }
    },
    requestUnlock: (window) => deps.prompt.requestUnlock(window)
  })

  const keyStateFor = (window: BrowserWindowController | undefined): AutofillKeyState =>
    service.keyState(window?.activeTab()?.currentUrl ?? null)
  vault.onLock(() => {
    service.dropPendingSaves()
    for (const window of windows()?.controllers ?? []) {
      window.emit('passwords:autofillStateChanged', keyStateFor(window))
    }
  })

  app.on('web-contents-created', (_event, contents: WebContents) => {
    wireAutofillView(service, suggest, hostFor(contents))
  })

  return {
    service,
    suggest,
    keyStateFor,
    fillActiveTab: (window, anchor) => {
      suggest.requestFromChrome(liveContentsOf(window?.activeTab()?.view), anchor)
    }
  }
}
