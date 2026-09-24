import { ipcRenderer } from 'electron'
import { UNSAVED_INPUT_CHANNEL } from '@shared/session/unload-policy.js'

/**
 * Tells the core that something was typed into this page and not yet sent (U15), so the tab is not unloaded.
 *
 * `input` fires only on editable things — fields, text areas, selects, `contenteditable` — and only in the
 * frame that has them; this preload runs in the top frame alone, so it hears the main frame's. Trusted only,
 * so a page cannot keep itself loaded by dispatching events. One message when typing starts and one when a
 * form is submitted; a navigation starts a new document, whose preload starts clean, and the core clears its
 * own flag at the same commit.
 */
export function installUnsavedInput(): void {
  let dirty = false
  const report = (next: boolean): void => {
    if (next === dirty) return
    dirty = next
    ipcRenderer.send(UNSAVED_INPUT_CHANNEL, next)
  }
  window.addEventListener('input', (event) => event.isTrusted && report(true), {
    capture: true,
    passive: true
  })
  window.addEventListener('submit', () => report(false), { capture: true, passive: true })
}
