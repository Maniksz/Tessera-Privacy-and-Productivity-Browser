import { useEffect, useRef, useState } from 'react'
import type {
  AutofillSuggestContent,
  AutofillSuggestEntry,
  AutofillSuggestPresentation
} from '@shared/overlay/surface.js'
import type { FillRefusal } from '@shared/passwords/fill-policy.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { useI18n } from '../i18n.js'

/**
 * The account picker one password field opens (R5).
 *
 * ## Why it is drawn here at all
 *
 * A list of the user's account names, drawn in the page's own document, shows no password — and is
 * still a leak. It teaches the page which account the user expects on this form, and a page that
 * knows that can build its mask to match. The chrome is the one place a page can neither read nor
 * imitate into, which is the step this browser can take that a password-manager extension cannot.
 *
 * ## What must be true of this component, and would look true if it were not
 *
 * - **Every state says something.** Pressing the badge produces a visible answer or the feature is
 *   indistinguishable from a broken browser (R8). So the four ways there is nothing to offer are
 *   four sentences here, not four reasons to render an empty box.
 * - **A refusal keeps its reason.** `FillRefusal` carries one value per rule, and the difference
 *   between "this page is not encrypted" and "this is not the site the password was saved for" is
 *   the whole of KTD6: one of them the user can act on, and neither of them is "nothing found".
 * - **A choice carries two opaque ids.** The request id and the entry id, and nothing else. A
 *   username in the answer would put an account name back on the wire this surface exists to keep
 *   it off, and would be invisible on screen.
 * - **The keyboard does all of it.** Arrows walk, Return chooses, Escape leaves (KTD12, R3). A
 *   password manager that needs a pointer is unusable for the people who most need one.
 * - **Nothing closes on a click outside.** Region `tile` cuts the layer to this rectangle, so a
 *   press beside the list lands in the page view and never arrives here — the find bar has no such
 *   handler for the same reason. Closing from outside is the core's, which is also the only side
 *   that can take the badge's open state back in the page.
 *
 * ## Why the actions are props rather than channels
 *
 * The surface reports a choice, an unlock and a dismissal to whoever renders it. It is deliberately
 * ignorant of how they travel: the channel that carries the choice is one handler in the core, and
 * writing it here — with nothing on the other end yet — would be exactly the wired-and-dead shape
 * this feature has a guard against.
 */

/** What the user picked. Two opaque ids: never a name, never a secret. */
export interface AutofillSuggestChoice {
  requestId: string
  entryId: string
}

/** The request an unlock or a dismissal is about. Named so the two cannot be called with a bare id. */
export interface AutofillSuggestRequest {
  requestId: string
}

/**
 * One sentence per refusal, derived from the union so a ninth rule is a build error here.
 *
 * The failure it prevents is quiet: a new `FillRefusal` with no entry would fall through to an empty
 * notice, which is the "nothing happened" answer this surface was built to abolish, appearing again
 * by omission.
 */
const REFUSAL_KEYS = {
  'no-user-gesture': 'autofill.refusal.noUserGesture',
  'unsupported-scheme': 'autofill.refusal.unsupportedScheme',
  'insecure-page': 'autofill.refusal.insecurePage',
  'scheme-downgrade': 'autofill.refusal.schemeDowngrade',
  'different-site': 'autofill.refusal.differentSite',
  'cross-origin-frame': 'autofill.refusal.crossOriginFrame',
  'cross-origin-form-action': 'autofill.refusal.crossOriginFormAction',
  'no-password-field': 'autofill.refusal.noPasswordField'
} as const satisfies Record<FillRefusal, MessageKey>

/**
 * The sentence for a state, or no sentence because there is a list instead.
 *
 * Exhaustive, and `entries` is in it twice over: an offer that arrived with nothing in it reads as
 * the `empty` state rather than as a listbox with no options. The core does not send that shape —
 * it sends `empty` — which is precisely why the fallback is here and not left to be discovered.
 */
function noticeKeyFor(content: AutofillSuggestContent): MessageKey | null {
  switch (content.state) {
    case 'entries':
      return content.entries.length > 0 ? null : 'autofill.suggest.empty'
    case 'locked':
      return 'autofill.suggest.locked'
    case 'empty':
      return 'autofill.suggest.empty'
    case 'disabled':
      return 'autofill.suggest.disabled'
    case 'refused':
      return REFUSAL_KEYS[content.reason]
  }
}

export function AutofillSuggestSurface({
  presentation,
  onChoose,
  onUnlock,
  onDismiss
}: {
  presentation: AutofillSuggestPresentation
  onChoose: (choice: AutofillSuggestChoice) => void
  onUnlock: (request: AutofillSuggestRequest) => void
  onDismiss: (request: AutofillSuggestRequest) => void
}): React.ReactNode {
  const { t } = useI18n()
  const { requestId, tileIndex, content } = presentation

  const rootRef = useRef<HTMLDivElement>(null)
  const unlockRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLLIElement | null>>([])

  const entries: readonly AutofillSuggestEntry[] =
    content.state === 'entries' ? content.entries : []
  const noticeKey = noticeKeyFor(content)

  /*
    Which row Return would choose, and the one point at which it goes back to the top.

    Adjusted during render rather than in an effect, which is React's own answer for state that has
    to follow a prop: an effect would leave one frame in which the new request's list is showing the
    previous one's position. It matters more here than in most places — the core replaces the
    presentation in place, so unlocking the vault turns `locked` into a list under the same component,
    and an inherited position is a user one keystroke away from filling in an account they never saw.
  */
  const [shownRequest, setShownRequest] = useState(requestId)
  const [active, setActive] = useState(0)
  if (shownRequest !== requestId) {
    setShownRequest(requestId)
    setActive(0)
  }

  /*
    Clamped rather than reset when the list shrinks within one request: the same question with fewer
    answers is still the same question, so the cursor stays as near where the user put it as the list
    allows instead of jumping back to the top under their hands.
  */
  const at = entries.length === 0 ? 0 : Math.min(active, entries.length - 1)

  /*
    Focus lands on the one thing there is to do, and lands again whenever that changes.

    Keyed on the request as well as the position, so a second presentation puts the focus back rather
    than leaving it on a row of a list that has been replaced. Roving tabindex rather than
    `aria-activedescendant`: with real focus on the row, Return means what it says to the browser as
    well as to a screen reader, and Tab leaves by the ordinary route.
  */
  useEffect(() => {
    if (content.state === 'locked') {
      unlockRef.current?.focus()
      return
    }
    if (entries.length > 0) {
      optionRefs.current[at]?.focus()
      return
    }
    // A notice with no control in it still has to hear Escape, which means something must hold focus.
    rootRef.current?.focus()
  }, [requestId, content.state, entries.length, at])

  const choose = (entry: AutofillSuggestEntry): void => {
    onChoose({ requestId, entryId: entry.id })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      /*
        Stopped here. The layer's root has a window-level Escape handler that dismisses whatever is
        up, and both running would send the dismissal twice — the second arriving at a layer that is
        already empty. This surface's exit has more to take back than a generic dismissal knows
        about, so it owns the keystroke.
      */
      event.stopPropagation()
      onDismiss({ requestId })
      return
    }

    // Everything below walks or chooses a row, and the notice states have no rows. Returning here
    // also keeps Return and Space away from the unlock button, which handles both itself.
    if (entries.length === 0) return

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      // Wrapping, because a list of three is walked with three presses of one key: stopping at the
      // end makes the user work out which key they should have pressed instead.
      setActive((at + delta + entries.length) % entries.length)
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      setActive(0)
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      setActive(entries.length - 1)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const entry = entries[at]
      if (entry !== undefined) choose(entry)
    }
  }

  return (
    <div
      ref={rootRef}
      className="autofill-suggest"
      role="group"
      aria-label={t('autofill.suggest.label', { index: tileIndex + 1 })}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {/*
        A live region that stays in the tree even while it is empty.

        Rendered only when there is something to say, it would be inserted at the same moment as its
        text — and a live region that appears with its content is not announced at all. The state
        change that most needs to be heard is "the vault is locked" arriving where a list was, so it
        is exactly the announcement conditional rendering would swallow.
      */}
      <div className="autofill-suggest__notice" role="status" aria-live="polite">
        {noticeKey === null ? '' : t(noticeKey)}
      </div>

      {entries.length > 0 && (
        <ul
          className="autofill-suggest__list"
          role="listbox"
          aria-label={t('autofill.suggest.accounts')}
        >
          {entries.map((entry, index) => (
            <li
              key={entry.id}
              ref={(element) => {
                optionRefs.current[index] = element
              }}
              className="autofill-suggest__option"
              role="option"
              aria-selected={index === at}
              tabIndex={index === at ? 0 : -1}
              onClick={() => choose(entry)}
            >
              {/* Some sites sign in on a password alone, and a blank row is one nobody can choose
                  between or tell from a rendering fault. */}
              {entry.username === '' ? t('autofill.suggest.noUsername') : entry.username}
            </li>
          ))}
        </ul>
      )}

      {content.state === 'locked' && (
        <div className="autofill-suggest__actions">
          <button
            ref={unlockRef}
            type="button"
            className="autofill-suggest__button"
            onClick={() => onUnlock({ requestId })}
          >
            {t('passwords.unlock')}
          </button>
        </div>
      )}
    </div>
  )
}
