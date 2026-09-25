import { act } from '@testing-library/preact'

/**
 * Picks an option of a `<select>` the way Chromium reports it: `input`, then `change`.
 *
 * `fireEvent.change` cannot stand in for that under Preact. `@testing-library/preact` renames every
 * `change` to `input`, because `preact/compat` listens for `input` on a text field — but not on a
 * `<select>`, which keeps its `change` listener and so never hears the renamed event.
 */
export function choose(select: Element, value: string): void {
  void act(() => {
    ;(select as HTMLSelectElement).value = value
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
