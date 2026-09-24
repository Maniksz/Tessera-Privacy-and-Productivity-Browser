import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import type { TabState } from '@shared/model.js'
import { tabSearchRows } from '@shared/search/tab-search.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'
import { Icon } from '../../shared/Icon.js'

/**
 * The tab search: this window's tabs, found by title or address (U22, R31).
 *
 * ## A full-window panel, not the overlay layer (KTD16)
 *
 * The chrome already holds every tab's `TabState`, so the list needs nothing from the core — and the
 * window's one overlay surface stays free for the address bar's suggestions and the find bar, which a
 * list drawn there would have to take turns with. The price is the panel's: the content views are
 * suspended while it is up (`window:setOverlay` in `App`), which is also what lets it cover the page.
 *
 * ## The keyboard
 *
 * The caret never leaves the field. The arrows move a highlighted row (`aria-activedescendant`, the
 * combobox pattern), Enter opens the highlighted row — the first one until the arrows move it — and
 * Escape closes. Handled on the field rather than on the window, so App's own Escape, which steps a
 * split layout back and ignores text fields, never sees this one.
 *
 * ## A tab in a folded group
 *
 * Listed like any other: the candidates are `state.tabs`, which is `displayOrder()` with a folded
 * group's members still in it. Choosing one asks the core to activate it, and the core's `activateTab`
 * opens the group on the way (`TabDiscards.wake` → `unfoldGroupOf`), the same rule every other route
 * to a hidden tab takes. So this panel does not fold or unfold anything itself.
 */

export interface TabSearchPanelProps {
  /** This window's tabs in strip order, including the members of a folded group. */
  tabs: readonly TabState[]
  onClose: () => void
}

export function TabSearchPanel({ tabs, onClose }: TabSearchPanelProps): React.ReactNode {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [selected, setSelected] = useState(0)
  const listId = useId()
  const headingId = useId()

  const rows = tabSearchRows(tabs, text)
  const current = Math.min(selected, rows.length - 1)
  const optionId = (index: number): string => `${listId}-${index}`

  // The list scrolls under the field; the row the arrows reach is kept in it.
  useEffect(() => {
    if (current < 0) return
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' })
  })

  const activate = (tab: TabState | undefined): void => {
    if (tab === undefined) return
    void invoke('tabs:activate', { tabId: tab.id })
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        if (rows.length === 0) return
        const step = event.key === 'ArrowDown' ? 1 : -1
        setSelected((current + step + rows.length) % rows.length)
        break
      }
      case 'Enter':
        event.preventDefault()
        activate(rows[current])
        break
      case 'Escape':
        event.preventDefault()
        onClose()
        break
      default:
        break
    }
  }

  return (
    <div
      className="overlay"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="panel panel--narrow tabsearch"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <header className="panel__header">
          <h2 className="panel__heading" id={headingId}>
            {t('tabsearch.title')}
          </h2>
          <input
            className="panel__search"
            role="combobox"
            type="text"
            /*
              Focused on appearance: the panel exists because somebody pressed the key to type into it,
              so a second click to reach the field would be a step they already took.
            */
            autoFocus
            aria-label={t('tabsearch.title')}
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            {...(rows.length > 0 ? { 'aria-activedescendant': optionId(current) } : {})}
            placeholder={t('tabsearch.placeholder')}
            spellCheck={false}
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="iconbutton"
            aria-label={t('tabsearch.close')}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="panel__body">
          {rows.length === 0 ? (
            <p className="panel__empty">{t('tabsearch.empty')}</p>
          ) : (
            <ul className="tabsearch__list" id={listId} role="listbox" aria-labelledby={headingId}>
              {rows.map((tab, index) => (
                <li
                  key={tab.id}
                  id={optionId(index)}
                  className="tabsearch__row"
                  role="option"
                  aria-selected={index === current}
                  data-tab-id={tab.id}
                  // Keeps the caret in the field, so the arrows still work after a pointer was used.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    if (index !== current) setSelected(index)
                  }}
                  onClick={() => activate(tab)}
                >
                  <span className="tab__favicon" aria-hidden="true">
                    {tab.faviconUrl !== null && (
                      <img
                        // The strip's rules for the same icon; see `TabBar`.
                        key={tab.faviconUrl}
                        className="tab__faviconImage"
                        src={tab.faviconUrl}
                        alt=""
                        draggable={false}
                        onError={(event) => {
                          event.currentTarget.hidden = true
                        }}
                      />
                    )}
                  </span>
                  <span className="tabsearch__title">{tab.title || t('tab.untitled')}</span>
                  <span className="tabsearch__url">{tab.url}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
