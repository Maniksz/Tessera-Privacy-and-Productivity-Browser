import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  canOpenDownload,
  downloadFraction,
  fileWentMissing,
  isActiveDownload,
  type DownloadEntry
} from '@shared/downloads/model.js'
import {
  DOWNLOAD_STATE_LABELS,
  downloadNumberFormat,
  downloadProgressText,
  downloadSizeText,
  type DownloadAction
} from '@shared/downloads/presentation.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { DOWNLOADS_PANEL_ROWS, type DownloadsPanelPresentation } from '@shared/overlay/surface.js'
import { internalUrl } from '@shared/product.js'
import { anchorSurface, type Rect } from '@shared/ui/anchor.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'
import { Icon } from '../../shared/Icon.js'
import { DOWNLOAD_ACTION_ICONS } from '../../shared/download-icons.js'

/**
 * The toolbar's downloads panel, drawn on the overlay layer.
 *
 * ## Why it is here and not beside its button
 *
 * For the layout menu's reason: the button's renderer sits beneath the tab views, so a popover drawn
 * there is painted behind the page and receives no clicks. The button describes where it is and the core
 * presents this — and puts the rows in, which the button never sees (KTD2).
 *
 * ## Whose rows these are
 *
 * The core's, all of them. The panel draws the newest few of exactly the list the downloads page shows
 * this window (KTD7), in the page's words — the state names and the size and progress text come from
 * `shared/downloads/presentation.ts` — and each action goes over the channel the page uses, by id. Nothing
 * here edits a row. When an answer means the rows are stale (a file that has gone), the panel asks for
 * itself again and the core answers with a freshly probed list.
 *
 * ## Where the keyboard is
 *
 * The core re-presents this panel on every coalesced download change, up to four times a second, and
 * those updates are the same surface to the layer: the component stays mounted and React keeps each row's
 * element by download id. So focus follows the download rather than the position without doing anything —
 * a new row above the focused one moves the row, not the focus. The work is in the two cases where the
 * focused element goes: a button that its row's new state no longer offers (Cancel, once the download has
 * ended) hands the focus to its row, and a row that has left the list hands it to the row that took its
 * place (KTD8). The first presentation puts it on the newest row.
 *
 * Tab and Shift+Tab wrap inside the panel, and Escape and a click outside are the layer's
 * (`OverlaySurface`), as for every surface nothing is waiting on.
 */

/** The row's actions, by the key that names them. Each is a `downloads.*` key taking `{name}`. */
const ACTION_LABELS = {
  open: 'downloads.open',
  reveal: 'downloads.reveal',
  pause: 'downloads.pause',
  resume: 'downloads.resume',
  cancel: 'downloads.cancel',
  remove: 'downloads.remove'
} as const satisfies Readonly<Record<DownloadAction, MessageKey>>

/**
 * What a row offers, in the order it draws them: the page's rules, plus one of the panel's own.
 *
 * Pause and resume only where the transfer can pause at all (`canPause`). The page offers them on state
 * alone; a transfer from outside Chromium may be unable to, and a button that could only ever answer
 * "nothing changed" is not one to put in a panel. Remove is on every row, failed ones included — the page
 * offers it everywhere, and it is how a row that says nothing useful any more goes away.
 */
function actionsFor(entry: DownloadEntry): DownloadAction[] {
  const actions: DownloadAction[] = []
  if (canOpenDownload(entry)) actions.push('open', 'reveal')
  if (entry.canPause && entry.state === 'progressing') actions.push('pause')
  if (entry.canPause && entry.state === 'paused') actions.push('resume')
  if (isActiveDownload(entry)) actions.push('cancel')
  actions.push('remove')
  return actions
}

/** Where the keyboard was, by what it was on rather than where: a download, and one of its buttons. */
interface FocusMark {
  id: string
  /** `null` for the row itself. */
  action: DownloadAction | null
  /** The row's position then, for the one case the id cannot answer: the row itself has gone. */
  index: number
}

const ROW = '[data-download-id]'
/** Everything Tab stops at, in document order: each row, then its buttons, then the way to the page. */
const STOPS = `${ROW}, button`

export function DownloadsPanelSurface({
  presentation
}: {
  presentation: DownloadsPanelPresentation
}): React.ReactNode {
  const { locale, t } = useI18n()
  const panelRef = useRef<HTMLDivElement>(null)
  const focusMark = useRef<FocusMark | null>(null)
  const focusedOnce = useRef(false)
  const [rect, setRect] = useState<Rect | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * Whether the layer still shows this panel, for an answer that arrives after it was taken down.
   *
   * The panel is dismissed without being asked — Escape, a click outside, the window losing focus — so an
   * action can still be waiting on the core when it goes. What that answer would do next must then not
   * happen: asking for fresh rows is presenting the panel, and would put back, and give the keyboard to,
   * the panel the user has just closed. `useDownloadSummary`'s `cancelled` and `useShortcutContext`'s
   * `live` guard the same way; this one is a ref because the answers land in handlers, not an effect.
   */
  const live = useRef(true)
  const numberFormat = useMemo(() => downloadNumberFormat(locale), [locale])

  // The core sends at most this many; a longer list is not this surface's to lay out.
  const rows = presentation.downloads.slice(0, DOWNLOADS_PANEL_ROWS)

  useEffect(() => {
    // Set here as well as initially, so a remount under Strict Mode's double effect is live again.
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  /**
   * Measure, then place — on every presentation and every notice, because the height follows the rows.
   *
   * `LayoutMenuSurface`'s approach: natural size first, then `anchorSurface` against the button's rect.
   * Only the very first pass is hidden; a later one keeps the panel where it was until the new place is
   * known, so a progress tick never blinks it.
   *
   * Natural means without the cap the last placement left on the element. Measured with it, the box can
   * be no taller than it was, `anchorSurface` keeps the smaller of that and the room there is, and a row
   * or a notice added while the panel is open would go into a scroll inside it rather than make it grow.
   * The cap is lifted only for the reading and put straight back — React will not restore it itself when
   * the place comes out the same — and all of it happens before paint, so nothing is drawn uncapped.
   */
  useLayoutEffect(() => {
    const element = panelRef.current
    if (element === null) return
    const cap = element.style.maxHeight
    element.style.maxHeight = ''
    const natural = element.getBoundingClientRect()
    element.style.maxHeight = cap
    const placed = anchorSurface(
      presentation.anchor,
      { width: natural.width, height: natural.height },
      { width: window.innerWidth, height: window.innerHeight }
    )
    setRect((previous) =>
      previous !== null &&
      previous.x === placed.rect.x &&
      previous.y === placed.rect.y &&
      previous.height === placed.rect.height
        ? previous
        : placed.rect
    )
  }, [presentation, notice])

  // The first placement, and only that one, puts the keyboard on the newest row.
  useEffect(() => {
    if (rect === null || focusedOnce.current) return
    focusedOnce.current = true
    const panel = panelRef.current
    ;(
      panel?.querySelector<HTMLElement>(ROW) ??
      panel?.querySelector<HTMLElement>('[data-part="all"]')
    )?.focus()
  }, [rect])

  /*
    After every update: if what had the keyboard was taken out of the document, put it on what took its
    place. Nothing to do while the focused element is still there — React kept it, by download id.
  */
  useLayoutEffect(() => {
    const panel = panelRef.current
    const mark = focusMark.current
    if (panel === null || mark === null) return
    if (panel.contains(document.activeElement)) return
    const rowsNow = [...panel.querySelectorAll<HTMLElement>(ROW)]
    const row = rowsNow.find((candidate) => candidate.dataset.downloadId === mark.id)
    if (row !== undefined) {
      const button =
        mark.action === null
          ? null
          : row.querySelector<HTMLElement>(`[data-action="${mark.action}"]`)
      ;(button ?? row).focus()
      return
    }
    const neighbour = rowsNow[Math.min(mark.index, rowsNow.length - 1)]
    ;(neighbour ?? panel.querySelector<HTMLElement>('[data-part="all"]'))?.focus()
  }, [presentation])

  /** Remembers what the keyboard is on, so an update that removes it knows where it was. */
  const onFocus = (event: React.FocusEvent<HTMLDivElement>): void => {
    const target = event.target
    const row = target.closest<HTMLElement>(ROW)
    const id = row?.dataset.downloadId
    if (row === null || id === undefined) {
      focusMark.current = null
      return
    }
    const action =
      target === row ? null : ((target.dataset.action ?? null) as DownloadAction | null)
    const index = [...(panelRef.current?.querySelectorAll(ROW) ?? [])].indexOf(row)
    focusMark.current = { id, action, index }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const panel = panelRef.current
    if (panel === null) return
    const active = document.activeElement
    if (event.key === 'Tab') {
      /*
        Handled rather than left to the browser, so the wrap is the panel's and not the page's: the layer
        is a web contents of its own, and a Tab past the last button would otherwise leave the panel for
        the document around it — which is empty, and gives the keyboard nowhere to be.
      */
      event.preventDefault()
      const stops = [...panel.querySelectorAll<HTMLElement>(STOPS)]
      if (stops.length === 0) return
      const index = stops.findIndex((stop) => stop === active)
      const step = event.shiftKey ? -1 : 1
      const next = index === -1 ? (event.shiftKey ? stops.length - 1 : 0) : index + step
      stops[(next + stops.length) % stops.length]?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    // Row to row, as in any list; Tab reaches the buttons inside one.
    const rowElements = [...panel.querySelectorAll<HTMLElement>(ROW)]
    if (rowElements.length === 0) return
    event.preventDefault()
    const current = active instanceof HTMLElement ? active.closest<HTMLElement>(ROW) : null
    const index = current === null ? -1 : rowElements.indexOf(current)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = index === -1 ? 0 : Math.min(Math.max(index + step, 0), rowElements.length - 1)
    rowElements[next]?.focus()
  }

  /*
    One place for what every action shares with the page: the notice is cleared as the next action starts,
    and an error becomes the notice rather than a promise nobody handles — while there is still a panel
    to show it in (`live`).
  */
  const run = (action: () => Promise<void>): void => {
    setNotice(null)
    action().catch((cause: unknown) => {
      if (live.current) setNotice(cause instanceof Error ? cause.message : String(cause))
    })
  }

  /** The rows are stale, so the panel asks for itself again; the core answers with a fresh list. */
  const askForFreshRows = (): Promise<unknown> =>
    invoke('overlay:present', { kind: 'downloads-panel', anchor: presentation.anchor })

  const perform = (action: DownloadAction, entry: DownloadEntry): void => {
    const { id } = entry
    run(async () => {
      switch (action) {
        case 'open':
        case 'reveal': {
          // The file can go between the row being drawn and this click; the core checks again and says.
          const found =
            action === 'open'
              ? (await invoke('downloads:open', { id })).opened
              : (await invoke('downloads:reveal', { id })).revealed
          // Closed meanwhile, the panel stays closed: fresh rows would present it again (`live`).
          if (found || !live.current) return
          setNotice(t('downloads.openFailed'))
          await askForFreshRows()
          return
        }
        case 'pause':
          await invoke('downloads:pause', { id })
          return
        case 'resume': {
          const { changed } = await invoke('downloads:resume', { id })
          // A resume the server cannot serve would restart the file; the core refuses, and the panel says so.
          if (!changed && live.current) setNotice(t('downloads.cannotResume'))
          return
        }
        case 'cancel':
          await invoke('downloads:cancel', { id })
          return
        case 'remove':
          await invoke('downloads:remove', { id })
          return
      }
    })
  }

  /*
    The page, in a new tab, the way the menu opens it (KTD9). The panel goes first, so the new tab is what
    the keyboard lands on rather than a layer about to disappear. Finding a tab where the page is already
    open is logic of its own with nothing to follow, and waits.
  */
  const openPage = (): void => {
    run(async () => {
      await invoke('overlay:dismiss')
      await invoke('tabs:create', { url: internalUrl('downloads') })
    })
  }

  return (
    <div
      ref={panelRef}
      className="downloads-panel"
      role="dialog"
      aria-modal="true"
      aria-label={t('downloads.title')}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      style={
        rect === null
          ? // Hidden for the measuring pass only; `useLayoutEffect` replaces this before paint.
            { visibility: 'hidden' }
          : { left: rect.x, top: rect.y, maxHeight: rect.height }
      }
    >
      {notice !== null && (
        <p className="downloads-panel__notice" role="status">
          {notice}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="downloads-panel__empty">{t('downloads.empty')}</p>
      ) : (
        <ul className="downloads-panel__list">
          {rows.map((entry) => {
            const fraction = downloadFraction(entry)
            const state = t(DOWNLOAD_STATE_LABELS[entry.state])
            // A finished row says how big the file is; every other row says how far it got.
            const amount =
              entry.state === 'completed'
                ? downloadSizeText(entry.receivedBytes, t, numberFormat)
                : downloadProgressText(entry, t, numberFormat)
            return (
              <li
                key={entry.id}
                className="downloads-panel__row"
                data-download-id={entry.id}
                data-state={entry.state}
                tabIndex={0}
              >
                <span className="downloads-panel__name">{entry.fileName}</span>
                <span className="downloads-panel__meta">{`${state} · ${amount}`}</span>
                {isActiveDownload(entry) && (
                  <progress
                    className="downloads-panel__progress"
                    aria-label={state}
                    // Indeterminate when the size is unknown; a bar at nought would look stalled.
                    {...(fraction === null ? {} : { value: fraction, max: 1 })}
                  />
                )}
                {fileWentMissing(entry) && (
                  <span className="downloads-panel__missing">{t('downloads.fileMissing')}</span>
                )}
                <span className="downloads-panel__actions">
                  {actionsFor(entry).map((action) => (
                    <button
                      key={action}
                      type="button"
                      className="downloads-panel__action"
                      data-action={action}
                      aria-label={t(ACTION_LABELS[action], { name: entry.fileName })}
                      title={t(ACTION_LABELS[action], { name: entry.fileName })}
                      onClick={() => perform(action, entry)}
                    >
                      <Icon name={DOWNLOAD_ACTION_ICONS[action]} />
                    </button>
                  ))}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <button type="button" className="downloads-panel__all" data-part="all" onClick={openPage}>
        {t('menu.tools.downloads')}
      </button>
    </div>
  )
}
