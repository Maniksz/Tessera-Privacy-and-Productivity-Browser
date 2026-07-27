import type { OverlayPresentation } from '@shared/overlay/surface.js'
import type { PromptKey } from '@shared/passwords/prompt.js'

/**
 * Keystrokes the overlay layer took out of the input pipeline before its renderer could have them.
 *
 * ## Why the layer takes them at all
 *
 * One surface on that layer collects the master password, and the guarantee this feature rests on is
 * that no renderer ever holds it and no channel ever carries it. That is only achievable if the
 * characters are intercepted where they already are — in the main process, on
 * `webContents.on('before-input-event')` — and stopped there. `OverlayLayer` does the stopping,
 * for the kinds `capturesKeyboard` names and no others.
 *
 * ## Why a module-level registry rather than a constructor option
 *
 * The same argument `permissions/vacancy.ts` makes, and it applies more sharply here. The layer is
 * created by the window controller, which knows nothing about passwords and must not have to; the
 * thing that needs the keystrokes is one prompt service for the whole application. Threading a
 * callback from there through the window registry and the window controller would put a password
 * concern into two option bags with no other reason to mention it — and `BrowserWindowController` is
 * a coordinator that is already at its size budget.
 *
 * The cost is a mutable module-level set, so `onOverlayKey` returns its own unsubscribe and tests use
 * it. Unlike the vacancy registry there is a second cost worth naming: **anything that subscribes here
 * receives characters of a master password.** There is exactly one subscriber, it is
 * `MasterPasswordPrompt`, and an architecture test holds that line — a registry this sensitive is only
 * as narrow as the list of people allowed to listen to it.
 */

export type OverlayKeyListener = (presentation: OverlayPresentation, input: PromptKey) => void

const listeners = new Set<OverlayKeyListener>()

export function onOverlayKey(listener: OverlayKeyListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Hands one keystroke to whoever is collecting it.
 *
 * A copy of the set is iterated so a listener that unsubscribes while being called cannot make the
 * next one be skipped, and each call is guarded — but the guard here logs *only* that a listener
 * threw. Never the input: the thing that threw was handed a character of a master password, and an
 * error message is the most-copied string in any program.
 */
export function notifyOverlayKey(presentation: OverlayPresentation, input: PromptKey): void {
  for (const listener of [...listeners]) {
    try {
      listener(presentation, input)
    } catch {
      console.error('[passwords] an overlay key listener threw')
    }
  }
}
