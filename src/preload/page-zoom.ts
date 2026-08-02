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

function apply(): void {
  if (insertedKey !== null) {
    try {
      webFrame.removeInsertedCSS(insertedKey)
    } catch {
      // The document went, or the key belongs to one that did. Nothing to remove and nothing to fix.
    }
    insertedKey = null
  }

  const css = zoomCss(percent)
  // Nothing inserted at 100 %, which is what makes the default leave no trace: `zoom` reads back as
  // the page left it, rather than as a rule of ours that happens to be a no-op.
  if (css === '') return

  try {
    /*
      The user cascade origin, which is where a *browser's* own declaration belongs.

      With `!important`, a user-origin declaration outranks an author-origin `!important` one — that is
      the one place in the cascade where the user wins outright, and it exists for exactly this: a
      preference the person has expressed about how they want to see the page. In the author origin,
      a site with `html { zoom: 1 !important }` would silently pin the pane at 100 % and nothing in
      the browser would say why.
    */
    insertedKey = webFrame.insertCSS(css, { cssOrigin: 'user' })
  } catch {
    // No frame to style. The page renders unzoomed, which is wrong but visible and recoverable —
    // the next push re-tries.
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
