import { useRef } from 'react'
import type { LayoutId } from '@shared/split/layout.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'
import { LAYOUT_LABELS, LayoutIcon } from './LayoutIcon.js'

/**
 * One toolbar button for the split layout.
 *
 * Five permanent buttons cost five slots of toolbar width to express one choice, and a
 * toolbar is the scarcest space in the window. A single button showing the *current*
 * arrangement also answers "what am I in?" at a glance, which a row of equal-looking buttons
 * does not.
 *
 * The button does not render its own menu. It cannot: this renderer sits beneath the native
 * tab views, so a dropdown drawn here would be painted behind the page and every click on it
 * would land on the page instead. Instead it reports where it is and lets the overlay layer
 * draw the menu above the views. `open` comes from the core rather than from local state, so
 * `aria-expanded` cannot claim a menu that has already been dismissed.
 */

export function LayoutMenu({
  current,
  open
}: {
  current: LayoutId
  open: boolean
}): React.ReactNode {
  const { t } = useI18n()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const label = t('toolbar.layout', { current: t(LAYOUT_LABELS[current]) })

  const toggle = (): void => {
    if (open) {
      void invoke('overlay:dismiss')
      return
    }
    const element = buttonRef.current
    if (element === null) return

    // Viewport coordinates are window coordinates here: the chrome renderer is the window's
    // own web contents, filling it from the origin at zoom 1. The overlay layer is positioned
    // in the same space, so the rect needs no translation.
    const box = element.getBoundingClientRect()
    void invoke('overlay:present', {
      kind: 'layout-menu',
      anchor: { x: box.x, y: box.y, width: box.width, height: box.height },
      current
    })
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className="iconbutton iconbutton--wide"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      <LayoutIcon layout={current} />
      <span className="iconbutton__caret" aria-hidden="true">
        ▾
      </span>
    </button>
  )
}
