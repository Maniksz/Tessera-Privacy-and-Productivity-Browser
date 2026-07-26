import { useEffect, useRef, useState } from 'react'
import type { FindBarPresentation } from '@shared/overlay/surface.js'
import { findWording, type FindWording } from '@shared/find/status.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { invoke } from '@renderer/bridge.js'
import { useI18n } from '@renderer/i18n.js'
import './find-bar.css'

/**
 * Find in page for one tile (Ctrl+F, spec 9).
 *
 * ## What must be true of this component, and would look true if it were not
 *
 * - **Every message names the tab.** `find:query` without a `tabId` would search whichever tile
 *   happened to be active, so typing into a bar opened over tile 2 could highlight tile 1 — and the
 *   highlight would then be on a page whose bar nobody can close. The id comes from the presentation,
 *   fixed when the bar opened.
 * - **The field owns what is in it.** Every keystroke goes to the core and the core answers with a
 *   count, so the presentation arrives again while the user is still typing. Rendering
 *   `presentation.query` directly would mean the field's contents making a round trip through another
 *   process on every letter: characters typed during the trip are lost and the caret jumps to the
 *   end. So the field holds a draft and takes the core's query only when the *search* changes, which
 *   is what `sessionId` marks.
 * - **Escape is stopped here.** The layer's root dismisses on Escape too, and letting both run sends
 *   the same dismissal twice — the second arriving at a layer that is already empty. The dismissal is
 *   also all Escape has to do: clearing the page's highlight hangs off the bar *leaving* the layer,
 *   not off this keystroke, because Escape is only one of half a dozen ways the bar can go.
 * - **Tab stays inside.** Past the last control the browser would move focus into the transparent
 *   remainder of a layer that holds nothing else, leaving a keyboard user somewhere they cannot see.
 *   Same reason and same shape as the permission dialogue's trap.
 *
 * The layer is sized to this box, so the component *is* the bar: there is no backdrop and no outside
 * to click, which is what keeps the rest of the page live while a search is running.
 */

/**
 * The wordings that are a fixed phrase.
 *
 * `nothing` renders no text and `ordinal` needs its two numbers, so both are handled at the call
 * site; the rest map one to one. Derived from the union rather than listed, so a new wording is a
 * build error here instead of a count that silently renders as nothing.
 */
const WORDING_KEYS = {
  searching: 'find.searching',
  'no-matches': 'find.noMatches',
  'one-match': 'find.oneMatch'
} as const satisfies Record<Exclude<FindWording['say'], 'nothing' | 'ordinal'>, MessageKey>

export function FindBarSurface({
  presentation
}: {
  presentation: FindBarPresentation
}): React.ReactNode {
  const { t } = useI18n()
  const barRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)

  const { tabId, tileIndex, sessionId } = presentation

  /*
    The field's own contents, and the one point at which they are replaced by the core's.

    Adjusted during render rather than in an effect, which is React's own answer for state that has
    to follow a prop: an effect would render one frame of the previous search's text into the new
    search's bar.
  */
  const [shownSession, setShownSession] = useState(sessionId)
  const [draft, setDraft] = useState(presentation.query)
  if (shownSession !== sessionId) {
    setShownSession(sessionId)
    setDraft(presentation.query)
  }

  /*
    Focus lands in the field, once per search.

    Keyed on the session rather than run once on mount: the shortcut pressed again opens a new
    session, and putting the caret back in the field — with the previous term selected, so typing
    replaces it — is what that press means. Keyed on anything that changes with a match count, it
    would reset the caret on every answer from the page.
  */
  useEffect(() => {
    const field = fieldRef.current
    if (field === null) return
    field.focus()
    field.select()
  }, [sessionId])

  const wording = findWording(presentation)
  const count =
    wording.say === 'nothing'
      ? ''
      : wording.say === 'ordinal'
        ? t('find.ordinal', { active: wording.active, total: wording.total })
        : t(WORDING_KEYS[wording.say])

  const step = (forward: boolean): void => {
    void invoke('find:step', { tabId, forward })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      // Owned here, and stopped here; see the docblock.
      event.stopPropagation()
      void invoke('overlay:dismiss')
      return
    }

    if (event.key === 'Enter') {
      // Return walks forward, Shift+Return back — the convention every browser's find bar uses, and
      // the reason this is not a form: Return here means "next match", not "submit a search".
      event.preventDefault()
      step(!event.shiftKey)
      return
    }

    if (event.key !== 'Tab') return
    event.preventDefault()
    const items = [
      ...(barRef.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])
    ]
    if (items.length === 0) return
    const index = items.findIndex((item) => item === document.activeElement)
    const delta = event.shiftKey ? -1 : 1
    const position = (index + delta + items.length) % items.length
    const [next] = items.slice(position, position + 1)
    next?.focus()
  }

  /* Nothing to walk through until the page has reported a match. */
  const canStep = presentation.matches !== null && presentation.matches > 0

  return (
    <div
      ref={barRef}
      className="findbar"
      role="group"
      aria-label={t('find.label', { index: tileIndex + 1 })}
      onKeyDown={onKeyDown}
    >
      <input
        ref={fieldRef}
        type="text"
        className="findbar__input"
        aria-label={t('find.field', { index: tileIndex + 1 })}
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          const query = event.target.value
          setDraft(query)
          /*
            Sent on every change rather than on Return, because a find bar that only searched when
            asked would be a search box that does not search. The core decides what a changed query
            means — restart, or stop when it is emptied — so this stays a plain report.
          */
          void invoke('find:query', { tabId, query })
        }}
      />

      {/*
        A live region that is always in the tree, even while it is empty.

        Rendered conditionally it would be inserted and removed as the field is filled and cleared,
        and a live region that appears at the same moment as its text is not announced at all — the
        one user who most needs the count would be the one who never hears it.
      */}
      <p className="findbar__count" role="status">
        {count}
      </p>

      <button
        type="button"
        className="findbar__button"
        aria-label={t('find.previous')}
        title={t('find.previous')}
        disabled={!canStep}
        onClick={() => step(false)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 12.5 10 6.5l6 6" />
        </svg>
      </button>

      <button
        type="button"
        className="findbar__button"
        aria-label={t('find.next')}
        title={t('find.next')}
        disabled={!canStep}
        onClick={() => step(true)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 7.5 10 13.5l6-6" />
        </svg>
      </button>

      <button
        type="button"
        className="findbar__button"
        aria-label={t('find.close')}
        title={t('find.close')}
        /*
          A dismissal, not a "close find" message. The highlight is taken off the page by the bar
          leaving the layer, so this button and Escape and a window resize all end the search the
          same way — one path out rather than one per exit.
        */
        onClick={() => void invoke('overlay:dismiss')}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
        </svg>
      </button>
    </div>
  )
}
