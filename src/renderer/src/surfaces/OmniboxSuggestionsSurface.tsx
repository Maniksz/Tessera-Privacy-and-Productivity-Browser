import type { PointerEvent } from 'react'
import {
  OMNIBOX_LIST_PADDING,
  OMNIBOX_ROW_HEIGHT,
  type OmniboxSuggestionsPresentation
} from '@shared/omnibox/model.js'
import { useI18n } from '../i18n.js'
import { chooseSuggestion } from '../omnibox-choice.js'

/**
 * The address bar's suggestion list, drawn on the overlay layer (U18, KTD12).
 *
 * ## Why here and not under the field
 *
 * The field's renderer sits beneath the tab views, so a list drawn there is painted behind the page and
 * receives no clicks — which is exactly what the old hint under the field was. The field describes where
 * it is and what it holds; the core ranks and presents; this draws.
 *
 * ## Why a choice is made on `pointerdown`
 *
 * This layer never takes the keyboard (`takesFocus`), so the caret stays in the field while the list
 * follows it. A press on a row does move the keyboard here, and the field sees `blur` before any `click`
 * would arrive. Choosing on the press, and never closing the list on the field's blur, is what lets the
 * press land at all. `preventDefault` keeps the press from starting a text selection in the row.
 *
 * Row zero is what Enter does with the text as typed; `selected` is the row the arrow keys have reached,
 * held by the field and drawn here.
 *
 * The choice goes out over `chooseSuggestion` unless a test hands in its own. Called from here rather than
 * passed down by `OverlaySurface`, so the code behind it arrives with this chunk and not in the layer's
 * budgeted bundle.
 */
export function OmniboxSuggestionsSurface({
  presentation,
  onChoose = (index) => chooseSuggestion(presentation, index)
}: {
  presentation: OmniboxSuggestionsPresentation
  onChoose?: (index: number) => void
}): React.ReactNode {
  const { t } = useI18n()
  const { lead, rows, selected, text } = presentation

  const press = (index: number) => (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    onChoose(index)
  }

  return (
    <div
      className="omnibox-suggestions"
      role="listbox"
      aria-label={t('omnibox.suggestions')}
      style={{ padding: `${OMNIBOX_LIST_PADDING}px` }}
    >
      <div
        className="omnibox-suggestions__row omnibox-suggestions__row--lead"
        role="option"
        aria-selected={selected === 0}
        style={{ height: OMNIBOX_ROW_HEIGHT }}
        onPointerDown={press(0)}
      >
        <span className="omnibox-suggestions__title">
          {lead.action === 'search' ? text : lead.url}
        </span>
        <span className="omnibox-suggestions__detail">
          {lead.action === 'search'
            ? t('omnibox.searchWith', { engine: lead.engine })
            : t('omnibox.openUrl', { url: lead.url })}
        </span>
      </div>
      {rows.map((row, position) => {
        const index = position + 1
        return (
          <div
            key={`${row.source}:${row.url}`}
            className={`omnibox-suggestions__row omnibox-suggestions__row--${row.source}`}
            role="option"
            aria-selected={selected === index}
            style={{ height: OMNIBOX_ROW_HEIGHT }}
            onPointerDown={press(index)}
          >
            <span className="omnibox-suggestions__title">{row.title || row.url}</span>
            <span className="omnibox-suggestions__detail">
              {row.tabId !== null ? t('omnibox.switchToTab') : row.url}
            </span>
          </div>
        )
      })}
    </div>
  )
}
