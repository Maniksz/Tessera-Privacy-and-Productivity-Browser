import { useEffect, useRef } from 'react'
import type { PickerBarPresentation } from '@shared/overlay/surface.js'
import type { PickerBarAction } from '@shared/overlay/picker-bar.js'
import { interpolate } from '@shared/i18n/locale.js'
import { invoke } from '@renderer/bridge.js'
import './picker-bar.css'

/**
 * "Block this element": what has been chosen, what it would hide, and what became of it.
 *
 * ## What must be true of this component, and would look true if it were not
 *
 * - **It has no opinion about the session.** Every visible thing here is a field of the presentation:
 *   which controls exist, whether the ends of the ancestor chain have been reached, whether there is a
 *   rule to take back. The core is the only side holding a session, and a surface that derived any of
 *   this from what it last saw would be a second copy of a state that changes underneath it — the
 *   disagreement always resolves in favour of the copy the user is looking at, which is the wrong one.
 *   If a branch here ever needs to remember something, it belongs in `main/privacy/picker-presentation.ts`.
 * - **Every mode says something.** The bar exists because a picker used to close in silence, so there is
 *   no state in which the status line is empty: hovering, counting, saving, checking, and each of the
 *   eight answers. The two waiting lines are the ones that are easy to forget and the ones that most look
 *   like a hang — the find bar reached the same conclusion for the same gap and put `find.searching` in it.
 * - **Confirm is not pressable while the core is working.** `writing` and `measuring` are the window in
 *   which a second press would write a second rule, and both routes into it are closed: the button is
 *   disabled and Return is refused. A disabled button alone would leave the keyboard contract open.
 * - **The words are the presentation's.** Every sentence and label arrives in `presentation.text`,
 *   resolved in the core for the interface language (`main/privacy/picker-bar-text.ts`, which says why
 *   they are not in the renderer's catalogue). Nothing here reaches for `useI18n`: a bar that did would
 *   say English over a German presentation the moment the two disagreed.
 * - **An unknown key renders as itself.** The set of outcomes belongs to the picking session, which is
 *   where it is held to being exhaustive; the bar receives an opaque key and resolves `outcome.${outcome}`
 *   in the words it was sent. A table here would be a second list of the same eight names, and a ninth
 *   would render as an empty bar — a blank, which is the one thing that reads as reassuring while saying
 *   nothing. A missing label falls back the same way, so no control is ever unlabelled.
 * - **Escape is stopped here.** It is a *named* cancel rather than the layer's generic dismissal, because
 *   a dismissal takes down whatever is up: one that arrived a moment after a consent dialogue had claimed
 *   the layer would take the dialogue down, and the safe default turns that into a refusal nobody gave.
 *   The layer's own Escape handler is deliberately left in play behind this one — if this ever failed to
 *   stop the event, a dismissal still ends the session through the vacancy route rather than stranding a
 *   preview on the page.
 * - **Tab stays inside.** Past the last control the browser would move focus into the transparent
 *   remainder of a layer that holds nothing else. Same reason and same shape as the find bar's trap.
 *
 * The layer is sized to this box, so the component *is* the bar: there is no backdrop and no outside to
 * click, which is what keeps the rest of the tile live while a selection is being judged.
 */
export function PickerBarSurface({
  presentation
}: {
  presentation: PickerBarPresentation
}): React.ReactNode {
  const barRef = useRef<HTMLDivElement>(null)

  const {
    sessionId,
    tileIndex,
    mode,
    selector,
    matches,
    canWiden,
    canNarrow,
    outcome,
    canUndo,
    text
  } = presentation

  // The shared interpolator, so `{index}` and `{count}` mean what they mean in every catalogue sentence.
  const t = (key: string, params?: Record<string, string | number>): string =>
    interpolate(text[key] ?? key, params)

  /*
    Focus lands on the bar itself, once per attempt.

    On the bar rather than on a button, because the four keys of KTD10 are the bar's and not any one
    control's — and because the first thing Return would do on a focused Confirm is confirm, from a bar
    the user has not read yet. Keyed on the session for the find bar's reason: keyed on anything that
    moves with a measurement, every answer from the page would pull focus back.
  */
  useEffect(() => {
    barRef.current?.focus()
  }, [sessionId])

  const act = (action: PickerBarAction): void => {
    void invoke('picker:barAction', { sessionId, action })
  }

  /*
    Three questions the whole surface is arranged around, each asked of the mode alone.

    `busy` is the pair of states between a press and an answer; `refining` is every state in which a
    selection exists, so the controls that act on one keep their place instead of appearing and
    disappearing under a pointer that is already moving towards them.
  */
  const busy = mode === 'writing' || mode === 'measuring'
  const refining = mode === 'frozen' || busy
  const finished = mode === 'outcome'

  const status = (): string => {
    if (finished) {
      // `outcome` is `null` only for a bar the core would not have presented at all; the key falls
      // back to itself either way, which is a name on screen rather than a blank.
      return t(`outcome.${outcome ?? ''}`)
    }
    if (mode === 'showing') return t('choosing')
    if (mode === 'writing') return t('writing')
    if (mode === 'measuring') return t('measuring')
    /*
      Frozen, so the count is the answer — and `null` is not a count.

      Zero is the finding R6 asks for: this rule changes nothing on this page, said *before* the user
      confirms. `null` is the absence of a finding, and rendering the two the same way would announce a
      result while the measurement was still on its way.
    */
    if (matches === null) return t('counting')
    if (matches === 0) return t('matchesNone')
    if (matches === 1) return t('matchesOne')
    return t('matches', { count: matches })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      // Owned here, and stopped here; see the docblock.
      event.stopPropagation()
      act('cancel')
      return
    }

    if (event.key === 'Enter') {
      /*
        The bar's Return, not a control's. A focused button activates itself on Return, and answering
        here as well would press the button and confirm in one keystroke.
      */
      if (event.target !== event.currentTarget) return
      if (mode !== 'frozen') return
      event.preventDefault()
      act('confirm')
      return
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      /*
        Only from a frozen selection, and only towards a rung that exists.

        There is no keyboard path from `showing` into `frozen` — selecting is pointer-only by decision —
        and the chain stops below `body`, because a rule for the document empties the page. A key that
        sent an action the core would refuse would be the silent no-op this whole feature is being
        rebuilt to remove, reproduced on the keyboard.
      */
      if (mode !== 'frozen') return
      const widening = event.key === 'ArrowUp'
      if (widening ? !canWiden : !canNarrow) return
      event.preventDefault()
      act(widening ? 'widen' : 'narrow')
      return
    }

    if (event.key !== 'Tab') return
    event.preventDefault()
    const items = [
      ...(barRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
    ]
    if (items.length === 0) return
    const index = items.findIndex((item) => item === document.activeElement)
    const delta = event.shiftKey ? -1 : 1
    const position = (index + delta + items.length) % items.length
    const [next] = items.slice(position, position + 1)
    next?.focus()
  }

  return (
    <div
      ref={barRef}
      className="pickerbar"
      role="group"
      aria-label={t('label', { index: tileIndex + 1 })}
      /*
        Focusable, and out of the tab ring. It has to hold focus for the four keys to reach it, and it
        must not be a stop the trap above walks through — the trap cycles the controls, and a container
        in the cycle would be a stop that looks like nothing.
      */
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {/*
        The selector in full, elided in CSS and never in the DOM.

        A confirmation that hides half of what it is confirming is not one, so the whole text is here and
        is also the element's title — the elision has to be the kind a person can defeat.
      */}
      <code className="pickerbar__selector" title={selector}>
        {selector}
      </code>

      {/*
        A live region that is always in the tree, even between two counts.

        Rendered conditionally it would be inserted at the same moment as its text, and a live region
        that appears with its content is not announced at all — so the user who most needs to hear that
        widening now hides four things instead of one would be the one who never hears it.
      */}
      <p className="pickerbar__status" role="status">
        {status()}
      </p>

      <div className="pickerbar__controls">
        {refining && (
          <>
            <button
              type="button"
              className="pickerbar__button"
              disabled={busy || !canWiden}
              onClick={() => act('widen')}
            >
              {t('widen')}
            </button>
            <button
              type="button"
              className="pickerbar__button"
              disabled={busy || !canNarrow}
              onClick={() => act('narrow')}
            >
              {t('narrow')}
            </button>
            {/*
              Disabled rather than absent while the core is working, so the bar does not change shape
              under a pointer on its way to the button — and so the waiting state is legible as *this
              press has been taken* rather than as the control having gone away.
            */}
            <button
              type="button"
              className="pickerbar__button pickerbar__button--primary"
              disabled={busy}
              onClick={() => act('confirm')}
            >
              {t('confirm')}
            </button>
          </>
        )}

        {/* R15: the way back, offered only where this attempt actually wrote something to take back. */}
        {finished && canUndo && (
          <button type="button" className="pickerbar__button" onClick={() => act('undo')}>
            {t('undo')}
          </button>
        )}

        {/*
          R15's second way, and offered after every outcome rather than only after a success.

          The bar cannot read an opaque outcome key, and it does not have to: the rules list is where a
          duplicate is switched back on, where a full list is made room in, and where a rule just written
          is corrected. The one thing that is *not* derivable from the key arrives as `canUndo` above,
          which is why nothing similar is carried for this one.
        */}
        {finished && (
          <button type="button" className="pickerbar__button" onClick={() => act('open-rules')}>
            {t('openRules')}
          </button>
        )}

        {/*
          The way out, in every mode — including the two the user cannot otherwise act in, because a
          session that could not be abandoned mid-write is a bar with no way out.

          One action, two words: "Cancel" over a rule that was just saved reads as an offer to take it
          back, which is the button beside it.
        */}
        <button type="button" className="pickerbar__button" onClick={() => act('cancel')}>
          {finished ? t('close') : t('cancel')}
        </button>
      </div>
    </div>
  )
}
