import type { PickerChrome } from '@shared/filters/picker-wire.js'

/**
 * How the element picker's highlight looks.
 *
 * On this side of the boundary rather than in the preload because the preload's size budget is the
 * tightest in the project — it is parsed before every page in every tab — and a stylesheet for a
 * feature most pages never use does not belong in it.
 *
 * There used to be words here as well: a hint, a "no rule for this element", and a sentence for each
 * selector warning, because the picker drew a confirmation bar inside the page and the preload cannot
 * read the i18n catalogue. The bar is an overlay surface now (KTD1), so those sentences are read there
 * under `picker.bar.*` and `picker.outcome.*`, in the renderer's own language. What is left is the one
 * thing that is genuinely in the page.
 *
 * The colours are literals rather than `var(--…)` references, and that is the one unavoidable duplication
 * here: this stylesheet is injected into a *page*, where the browser's own custom properties do not exist.
 * They are the same values as `tokens.css`, and an architecture test keeps the two in step.
 */

const PICKER_STYLES = `
  .box {
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    border: 2px solid #6da8ff;
    background: rgba(109, 168, 255, 0.14);
    border-radius: 2px;
  }
`

/**
 * The picker's chrome.
 *
 * No locale any more, because nothing here is language. It took one until the bar moved out, and the
 * parameter is dropped rather than ignored so that a future sentence has to be a deliberate decision to
 * send prose into a page again.
 */
export function pickerChrome(): PickerChrome {
  return { styles: PICKER_STYLES }
}
