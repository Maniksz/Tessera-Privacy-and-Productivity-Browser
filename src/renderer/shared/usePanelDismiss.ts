import { useEffect, type RefObject } from 'react'

/**
 * Escape closes and Tab stays inside — in a panel, and never on a page.
 *
 * ## Why this is a hook rather than two copies
 *
 * `SettingsView` had it and `ExtensionsView` did not, while *both* set `role="dialog"` and
 * `aria-modal` when hosted as a panel. `ExtensionsView` even kept the `panelRef` the trap needs,
 * assigned to its root and read by nothing — the residue of the behaviour having been dropped. So the
 * extensions panel told assistive technology the rest of the window was unavailable and then let Tab
 * walk straight out of it into content the same announcement had just declared unreachable. Claiming
 * `aria-modal` without trapping focus is worse than claiming neither, because a screen reader user is
 * told they cannot leave and a keyboard user silently does.
 *
 * One hook, so the two panels cannot disagree again, and so the next panel gets it by construction.
 *
 * ## Why it does nothing without `onClose`
 *
 * `onClose === undefined` is how both views spell "I am a page, not a panel", and a page must have
 * neither half of this. Spec 7 asks for focus management, and a *tab* that trapped Tab would take the
 * key away from the browser's own chrome — the opposite of accessible. Escape likewise belongs to the
 * page and the browser there: stopping a load, leaving a full-screen video. Consuming it to close
 * nothing spends a key and returns nothing.
 */
export function usePanelDismiss<T extends HTMLElement>(
  panelRef: RefObject<T | null>,
  onClose: (() => void) | undefined
): void {
  useEffect(() => {
    if (onClose === undefined) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      // Queried on each keystroke rather than once: the settings panel's list changes as the search
      // box filters it, so a captured first/last pair would wrap to a control no longer on screen.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'input, select, button:not([disabled]), textarea'
      )
      if (focusable === undefined || focusable.length === 0) return
      const ordered = [...focusable]
      const first = ordered[0]
      const last = ordered[ordered.length - 1]
      if (first === undefined || last === undefined) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [panelRef, onClose])
}
