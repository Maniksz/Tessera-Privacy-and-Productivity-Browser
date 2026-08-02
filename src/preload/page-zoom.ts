import { ipcRenderer, webFrame } from 'electron'
import { PAGE_ZOOM_CHANNEL, asZoomPercent, zoomCss } from '@shared/zoom/injection.js'

/**
 * The pane's zoom, put on the document it is a pane of.
 *
 * Every decision is in `shared/zoom/injection.ts` — why zoom moved off `webContents.setZoomFactor`,
 * what CSS `zoom` costs, and why the channel is not in the IPC contract. What is left here is the part
 * that can only happen in a renderer, and the two properties of it that are not obvious.
 *
 * ## Why the value is pulled before it is ever pushed
 *
 * `sendSync` at install time, which is the one blocking call in this file. A preload runs at
 * `document-start`, and that is the last moment before the page paints anything; an awaited answer
 * arrives after the first frame, which the user sees as every page loading at 100 % and then jumping
 * to their zoom. The same argument `installSpecificStyles` makes for the cosmetic stylesheet, with a
 * larger flash — a whole page rather than one advert.
 *
 * The push is still needed and is not the same thing: it carries a zoom the user performs *while* the
 * page is open, and a change to `appearance.defaultZoom` reaching a pane that never zoomed itself.
 * The listener is registered before the pull so that a value arriving in that window is not dropped.
 *
 * ## Why `insertCSS` rather than a `<style>` element
 *
 * At `document-start` there may be no `<html>` yet, so an appended element needs a parent that does
 * not exist — `cosmetic.ts` carries the same problem and answers it with `head ?? documentElement`.
 * For a stylesheet that hides an advert, missing the earliest moment costs a flicker on one element.
 * For this one it would cost the whole page jumping size, so the route that needs no DOM at all is
 * the right one. It also leaves nothing in the document for a page's own script to find and remove.
 */

/** The pane's zoom as this document currently has it. 100 until the core says otherwise. */
let percent = 100

/** The key `webFrame.insertCSS` handed back, so the next value replaces this one instead of stacking. */
let insertedKey: string | null = null

/**
 * What the browser's own surfaces inside this page have to divide their coordinates by.
 *
 * Read by the element picker and by autofill, both of which position themselves from a
 * `getBoundingClientRect()` — see `inPageCoordinates` for why that needs translating at all. Exposed
 * as a function rather than the variable so a caller reads the value at the moment it positions
 * something, which is the only moment it is true.
 */
export function pageZoomPercent(): number {
  return percent
}

/**
 * Puts the current percentage on the document: new sheet in, old sheet out, in that order.
 *
 * ## Why the insertion comes first
 *
 * Two reasons, and the second is the one that was learned the hard way.
 *
 * There is no frame between the two states — remove-then-insert leaves a moment with no rule at all,
 * which on a slow pass is a page flashing back to its unzoomed size on every step of a pinch.
 *
 * And the removal is no longer what correctness rests on. It used to be: 100 % was *the absence of a
 * sheet*, so returning to it meant removing one, and when that did not happen the page stayed zoomed
 * with no way back — the report that led to this. Every value is a rule now (`zoomCss`), so the
 * newest insertion wins on cascade order regardless, and this call is housekeeping: it keeps one
 * sheet on the document instead of one per zoom step.
 *
 * ## Why the author origin
 *
 * `cssOrigin: 'user'` was tried, on the argument that a browser's own declaration outranks a site's
 * `!important` there. It is the sharper cascade position and it is off the documented path — the
 * pair Electron documents is `insertCSS` and `removeInsertedCSS`, and a stylesheet that goes in
 * somewhere its partner does not look for it is a stylesheet that cannot be taken out. `!important`
 * in the author origin loses only to a page that writes `zoom` on its own root with `!important`,
 * which is a page fighting the browser's zoom for a living.
 */
function apply(): void {
  const previous = insertedKey

  try {
    insertedKey = webFrame.insertCSS(zoomCss(percent))
  } catch {
    // No frame to style. The page renders at whatever it had, which is wrong but visible and
    // recoverable — the next push re-tries, and the pane's own value is unchanged in the core.
    return
  }

  if (previous === null) return
  try {
    webFrame.removeInsertedCSS(previous)
  } catch {
    // Housekeeping that did not happen. The rule just inserted still wins, so this costs a stylesheet
    // on the document and nothing the user can see.
  }
}

export function installPageZoom(): void {
  ipcRenderer.on(PAGE_ZOOM_CHANNEL, (_event, payload: unknown) => {
    const next = asZoomPercent(payload)
    // Compared before applying: a settings change asks every pane to re-assert, and most of them are
    // already at the value being asserted. Replacing an identical stylesheet is a restyle of the whole
    // document for nothing.
    if (next === percent) return
    percent = next
    apply()
  })

  let answer: unknown
  try {
    answer = ipcRenderer.sendSync(PAGE_ZOOM_CHANNEL)
  } catch {
    // No responder — an older core, or a view created outside a hardened session. 100 % is the honest
    // reading: it is the size this page would be if the feature did not exist. The listener above is
    // already installed, so a core that starts answering later still reaches this document.
    return
  }

  percent = asZoomPercent(answer)
  apply()
}
