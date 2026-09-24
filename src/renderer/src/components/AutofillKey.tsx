import { useEffect, useRef, useState } from 'react'
import type { AutofillKeyState } from '@shared/passwords/model.js'
import type { ShortcutTitle } from '@shared/shortcuts/format.js'
import { invoke, subscribe } from '../bridge.js'
import { useI18n } from '../i18n.js'

/**
 * The toolbar's password key (R10, R11, R13): whether the vault is locked, whether anything is saved
 * for the page in the active tile, and the way to both unlock and fill from browser chrome.
 *
 * Three states the eye can tell apart without colour — a padlock on the key while locked, a dot while
 * something is saved for this page, the bare key otherwise — and absent altogether with autofill
 * switched off, for the zoom badge's reason: a control that could only say "off" is noise.
 *
 * It draws nothing itself beyond the button. The picker is a surface on the overlay layer, placed by
 * the core under this button (`autofillSuggestBoundsAt`), and the state comes from the core too, so
 * the key cannot claim a list or a lock the core has long since dropped
 * (`docs/solutions/ui-issues/chrome-popups-behind-content-views.md`). It is never told a name: the
 * state is three words and a count.
 */

/** What the key shows before the core has said anything: no key. */
const NO_KEY: AutofillKeyState = { vault: 'off', matches: 0 }

/**
 * The key's state for the active tile: asked for whenever `page` changes, and pushed on a lock.
 *
 * `page` is whatever should make the answer different — the tab, its address, the overlay surface on
 * screen (the master-password prompt leaving is how an unlock shows), the setting. The push covers
 * the one change nothing here can see: the vault locking itself after fifteen idle minutes.
 */
export function useAutofillKeyState(page: string): AutofillKeyState {
  const [state, setState] = useState<AutofillKeyState>(NO_KEY)
  useEffect(() => {
    let cancelled = false
    void invoke('passwords:autofillState').then((current) => {
      if (!cancelled) setState(current)
    })
    return () => {
      cancelled = true
    }
  }, [page])
  useEffect(() => {
    const unsubscribe = subscribe('passwords:autofillStateChanged', setState)
    return unsubscribe
  }, [])
  return state
}

export function AutofillKey({
  state,
  titleWithShortcut
}: {
  state: AutofillKeyState
  titleWithShortcut: ShortcutTitle
}): React.ReactNode {
  const { t } = useI18n()
  const buttonRef = useRef<HTMLButtonElement>(null)
  if (state.vault === 'off') return null

  const locked = state.vault === 'locked'
  const label = locked
    ? t('toolbar.autofillLocked')
    : state.matches > 0
      ? t('toolbar.autofillMatches', { count: state.matches })
      : t('toolbar.autofillNone')

  const press = (): void => {
    // Locked: the master-password prompt, never the list (R13). The picker would only say "locked".
    if (locked) {
      void invoke('passwords:requestUnlock')
      return
    }
    const element = buttonRef.current
    if (element === null) return
    // Window coordinates, for `LayoutMenu`'s reason: this renderer fills the window at zoom 1.
    const box = element.getBoundingClientRect()
    void invoke('passwords:fillFromToolbar', {
      anchor: { x: box.x, y: box.y, width: box.width, height: box.height }
    })
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className="iconbutton autofill-key"
      data-vault={state.vault}
      data-matches={state.matches > 0 ? state.matches : undefined}
      aria-label={label}
      // The key only while it fills: the shortcut opens the picker, and a locked key opens the prompt.
      title={locked ? label : titleWithShortcut(label, 'fillPassword')}
      onClick={press}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="7" cy="10" r="3.2" />
        <path d="M10.2 10H17M14.5 10v2.6M16.6 10v1.8" />
        {locked && <path data-part="lock" d="M12 3.5h5v3.6h-5zM13 3.5V2.4a1.5 1.5 0 0 1 3 0v1.1" />}
        {state.matches > 0 && <circle data-part="dot" cx="16" cy="4" r="2.4" />}
      </svg>
    </button>
  )
}
