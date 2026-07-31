import { useCallback, useEffect, useRef } from 'react'
import type { NavigationRequestPresentation } from '@shared/overlay/surface.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'

/**
 * "This page wants to open something — did you ask for it?"
 *
 * Raised when a page tried to open a tab, or to send its own tab to another site, and the core saw no real
 * input event behind it. What decides that, and what it deliberately does not catch, is in
 * `main/browser/automatic-navigation.ts`.
 *
 * On the overlay surface rather than in the toolbar's renderer for the reason every over-content surface
 * here is: tab content is drawn by native views stacked above the chrome UI, so a dialogue rendered there
 * is painted *behind* the page and receives no clicks. It would look perfectly correct in a DOM snapshot
 * and be impossible to answer.
 *
 * ## Why it reuses the permission prompt's classes
 *
 * `.surface--modal` and `.prompt` already carry three decisions this dialogue needs and would otherwise
 * have to re-make: the layer is dimmed *and opaque to clicks*, so the page asking cannot receive a click
 * over its own dialogue; the address wraps rather than being elided; and neither answer is styled as the
 * obvious one. A second set of classes would be a second place for those to drift.
 *
 * ## What must be true of this component, and not merely look true
 *
 * - **Escape refuses.** Not "closes": the answer sent is `false`. The core holds a callback either way, so
 *   a dialogue that vanished without answering would leave a navigation neither performed nor refused —
 *   and the safe reading of "the user made it go away" is no. It is also the outcome the feature was asked
 *   for: the page stays where it is.
 * - **Focus starts on the refusing button and cannot leave.** A stray Return refuses rather than opens.
 *   That matters more here than for a permission prompt: this dialogue is up *because* a page acted
 *   without being asked, so the one thing it must not be is easy to agree to by accident.
 * - **The destination is shown before any button is offered.** The host leads, because it is the fact the
 *   answer turns on; the full address is below it, because a shortened one is how somebody is persuaded
 *   that `evil.test/paypal.com` is PayPal. Everything rendered comes from the presentation, so there is no
 *   state in which a button exists and the destination it agrees to does not.
 */
export function NavigationRequestSurface({
  presentation
}: {
  presentation: NavigationRequestPresentation
}): React.ReactNode {
  const { t } = useI18n()
  const refuseRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const isPopup = presentation.navigationKind === 'popup'

  const answer = useCallback(
    (permitted: boolean) => {
      void invoke('navigation:answer', { requestId: presentation.requestId, permitted })
    },
    [presentation.requestId]
  )

  /*
    Focus the refusing button, on every new question rather than only on mount.

    A second question replaces the first inside the same component, and focus left on a button the user had
    moved to would let one Return answer the *next* question. The core's id check keeps that from resolving
    the wrong request, but it would still be somebody answering something they had not read.
  */
  useEffect(() => {
    refuseRef.current?.focus()
  }, [presentation.requestId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        answer(false)
        return
      }
      if (event.key !== 'Tab') return
      /*
        A focus trap over the two buttons.

        Spec 7 requires full keyboard operation, and for a dialogue it also decides where an accidental
        keystroke lands: without this, Tab walks out of the layer into a page the user cannot see, and the
        next Return presses something in it.
      */
      const buttons = dialogRef.current?.querySelectorAll('button')
      if (buttons === undefined || buttons.length === 0) return
      const order = [...buttons]
      const index = order.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.shiftKey
        ? order[(index - 1 + order.length) % order.length]
        : order[(index + 1) % order.length]
      event.preventDefault()
      next?.focus()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [answer])

  return (
    <div className="surface surface--modal">
      <div
        className="prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="navigation-title"
        aria-describedby="navigation-url"
        ref={dialogRef}
      >
        <h2 className="prompt__title" id="navigation-title">
          {t(isPopup ? 'navigation.wantsToOpen' : 'navigation.wantsToLeave', {
            // The host, or the whole address when there is no host to name — an address this browser
            // could not parse is the one the user most needs to see, and "wants to open" with no subject
            // is not a question anybody can answer.
            host: presentation.host === '' ? presentation.url : presentation.host
          })}
        </h2>

        {/* In one piece and never elided; see `.prompt__site` for why a truncated address is a lie. */}
        <p className="prompt__site" id="navigation-url">
          {presentation.url}
        </p>

        <p className="prompt__request">{t('navigation.noGesture')}</p>

        <div className="prompt__actions">
          <button
            ref={refuseRef}
            type="button"
            className="prompt__button prompt__button--block"
            onClick={() => answer(false)}
          >
            {t(isPopup ? 'navigation.dontOpen' : 'navigation.stay')}
          </button>
          <button type="button" className="prompt__button" onClick={() => answer(true)}>
            {t(isPopup ? 'navigation.open' : 'navigation.follow')}
          </button>
        </div>

        <p className="prompt__hint">{t('navigation.keyboardHint')}</p>
      </div>
    </div>
  )
}
