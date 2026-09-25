/**
 * `ref={focusOnMount}` where React would have read `autoFocus`.
 *
 * Preact sets `autoFocus` as the element's `autofocus` property and focuses nothing, and Chromium only
 * honours that attribute for the first element a document is loaded with — a field that appears on a
 * double-click, or a panel's search box, would come up without the keys. React closed that gap by
 * calling `focus()` itself when the element was inserted; this is that call.
 *
 * One function for the module, so it is the same ref on every render: Preact calls it once with the
 * element when it is inserted and once with `null` when it goes, never in between.
 */
export function focusOnMount(element: HTMLElement | null): void {
  element?.focus()
}
