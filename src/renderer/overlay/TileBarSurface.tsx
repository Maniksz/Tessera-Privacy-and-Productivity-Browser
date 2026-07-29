import { useEffect, useRef, useState } from 'react'
import type { TileBarPresentation } from '@shared/overlay/surface.js'
import { TILE_BAR_POINTER_AWAY } from '@shared/split/tile-bar.js'
import { HOME_URL } from '@shared/url/omnibox.js'
import { invoke } from '@renderer/bridge.js'
import { useI18n } from '@renderer/i18n.js'
import './tile-bar.css'

/**
 * One tile's navigation bar: back, forward, reload, home, that tile's address, and close (spec 2).
 *
 * ## The order the controls are in, which is a decision and not an accident
 *
 * Back, forward, reload, home is the main toolbar's order, kept here so the muscle memory transfers
 * — a user who has learned that home is the fourth thing on the left does not have to learn it twice.
 * Close is on the far side of the address field, as far from those four as the bar allows, because it
 * is the only action here that cannot be undone: a close that lands one button off shuts a page the
 * user is currently reading, while every other misfire in this bar costs a back-press. Both new
 * buttons exist because the alternative is hunting for the right tab in the strip above, which is the
 * thing this bar exists to make unnecessary.
 *
 * ## What must be true of this component, and would look true if it were not
 *
 * - **Every control names the tab.** `nav:goBack` without a `tabId` acts on the *active* tile,
 *   which in a split layout is routinely not this one. A bar whose buttons omitted the id would
 *   look and feel complete, and would navigate the neighbour — the exact complaint this feature
 *   exists to answer, reintroduced by an omission of four characters. Close is the one where that
 *   omission is not recoverable, and `tabs:close` makes `tabId` required rather than optional, so
 *   there is no shape of the call that quietly means "the active one".
 * - **The pointer's departure is reported, not inferred.** The bar covers the strip the core
 *   watches for pointer moves, so once it is up the core cannot see the pointer leave; it can only
 *   be told. Nothing else takes the bar down when the mouse simply moves away.
 * - **The keyboard route is complete on its own.** A hover-only control fails spec 7. When the bar
 *   was asked for by key, focus starts in the address field, Tab stays inside the bar and Escape
 *   dismisses. Tab is trapped for the same reason as in the permission dialogue: past the last
 *   control the browser would move focus into the transparent remainder of a layer with nothing on
 *   it, and a keyboard user would be left in a surface they cannot see or reach.
 *
 * The layer is sized to the strip, so this component *is* the bar — there is no outside to click,
 * and no room for a backdrop. That is what keeps the rest of the page live while the bar is up.
 */

export function TileBarSurface({
  presentation
}: {
  presentation: TileBarPresentation
}): React.ReactNode {
  const { t } = useI18n()
  const barRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<string | null>(null)

  const { tabId, tileIndex, invokedBy } = presentation
  const label = t('tileBar.label', { index: tileIndex + 1 })

  /*
    Focus lands in the address field, and only for a bar that was asked for by key.

    Keyed on the tile and the invocation rather than run once: the core re-sends the presentation
    when the tab navigates, and re-focusing there would drop the caret back to the start of the
    field while the user was typing in it.
  */
  useEffect(() => {
    if (invokedBy !== 'keyboard') return
    const field = addressRef.current
    if (field === null) return
    field.focus()
    // Selected rather than merely focused: the first thing a keyboard user does with an address is
    // replace it, and a caret parked mid-URL makes that a chore.
    field.select()
  }, [invokedBy, tileIndex])

  /*
    A navigation in this tab replaces what the user has half-typed — unless they are typing, which
    is what the draft is. Dropping it on every re-send would erase an address in the middle of
    being entered, because a page finishing its load is enough to re-send.
  */
  const address = draft ?? presentation.url

  const leave = (): void => {
    void invoke('tiles:pointerAt', { tileIndex, y: TILE_BAR_POINTER_AWAY })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      /*
        Handled here and stopped here. The layer's root has a window-level Escape handler that
        dismisses whatever is up, and letting both run would send the same dismissal twice — the
        second one arriving at a layer that is already empty. Owning it also keeps the way out of
        the address field in the component that put the caret there.
      */
      event.stopPropagation()
      void invoke('overlay:dismiss')
      return
    }

    if (event.key !== 'Tab') return
    event.preventDefault()
    const items = [
      ...(barRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])
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
      className="tilebar"
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      /*
        The only signal the core gets that the pointer has gone. `onPointerLeave` rather than a
        move threshold inside the bar: the bar is forty pixels tall, so "moved far enough away"
        would have to be measured in a space that does not extend that far.
      */
      onPointerLeave={leave}
    >
      <button
        type="button"
        className="tilebar__button"
        aria-label={t('toolbar.back')}
        title={t('toolbar.back')}
        disabled={!presentation.canGoBack}
        onClick={() => void invoke('nav:goBack', { tabId })}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M12.5 4 6.5 10l6 6" />
        </svg>
      </button>

      <button
        type="button"
        className="tilebar__button"
        aria-label={t('toolbar.forward')}
        title={t('toolbar.forward')}
        disabled={!presentation.canGoForward}
        onClick={() => void invoke('nav:goForward', { tabId })}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M7.5 4l6 6-6 6" />
        </svg>
      </button>

      <button
        type="button"
        className="tilebar__button"
        aria-label={t(presentation.loading ? 'toolbar.stop' : 'toolbar.reload')}
        title={t(presentation.loading ? 'toolbar.stop' : 'toolbar.reload')}
        onClick={() => {
          if (presentation.loading) void invoke('nav:stop', { tabId })
          else void invoke('nav:reload', { tabId })
        }}
      >
        {presentation.loading ? (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M16 10a6 6 0 1 1-2.2-4.65" />
            <path d="M16 4.2V6.4h-2.2" />
          </svg>
        )}
      </button>

      {/*
        `HOME_URL` rather than a literal, and the `tabId` the main toolbar's copy does not send.

        The toolbar's home button omits it deliberately — there is one active tab and it is the one
        the user means. Here the bar under the pointer is routinely not the active tile, so the same
        omission would send a neighbouring page to the start page while this one sat unchanged.
      */}
      <button
        type="button"
        className="tilebar__button"
        aria-label={t('toolbar.home')}
        title={t('toolbar.home')}
        onClick={() => void invoke('nav:navigate', { input: HOME_URL, tabId })}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3.5 9.2 10 4l6.5 5.2" />
          <path d="M5.4 8.6V16h9.2V8.6" />
        </svg>
      </button>

      <form
        className="tilebar__address"
        onSubmit={(event) => {
          event.preventDefault()
          /*
            Raw text, not a URL. Deciding address-versus-search happens in the core so the rule is
            applied in one place (spec 1) — and with the tab named, so this tile's address bar can
            never navigate the tile next to it.
          */
          void invoke('nav:navigate', { input: address, tabId })
          setDraft(null)
        }}
      >
        <input
          ref={addressRef}
          type="text"
          className="tilebar__input"
          aria-label={t('tileBar.address', { index: tileIndex + 1 })}
          spellCheck={false}
          value={address}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>

      {/*
        A ring around the cross, and the ring is the whole reason for drawing it by hand.

        The bare cross is taken. `M5.5 5.5l9 9M14.5 5.5l-9 9` is the reload button's stop state, so a
        close drawn the plain way — which is what the tab strip's own `×` is, and the obvious thing to
        copy — would put two identical crosses in one forty-pixel bar meaning "cancel this load" and
        "destroy this page", side by side for the whole of every load. That the strip gets away with
        the plain glyph is not an argument for using it here; the strip has no stop button beside it.

        `r=6.5` is where the stop cross's arms end, so the two cover the same optical area and the row
        keeps its rhythm at 1.6 stroke — the close reads as heavier only because it is a closed shape,
        which is the distinction being drawn.
      */}
      <button
        type="button"
        className="tilebar__button tilebar__button--close"
        aria-label={t('tab.close')}
        title={t('tab.close')}
        onClick={() => void invoke('tabs:close', { tabId })}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="6.5" />
          <path d="M7.5 7.5l5 5M12.5 7.5l-5 5" />
        </svg>
      </button>
    </div>
  )
}
