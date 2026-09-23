import { useEffect, useRef, useState } from 'react'
import { DOWNLOAD_STATE_LABELS } from '@shared/downloads/presentation.js'
import {
  NO_DOWNLOAD_BUTTON,
  type DownloadButtonSummary,
  type DownloadMarker
} from '@shared/downloads/summary.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import type { OverlayKind, OverlayState } from '@shared/overlay/surface.js'
import type { Rect } from '@shared/ui/anchor.js'
import { invoke, subscribe } from '../bridge.js'
import { useI18n } from '../i18n.js'

/**
 * The toolbar's download button.
 *
 * It says one thing at a time, and the core has already chosen which (KTD6, see
 * `summarizeWindowDownloads`): how far the window's running downloads have got, or — once nothing
 * runs — the heaviest outcome nobody has looked at yet. This file only draws that statement and says
 * it in words. It is never told a file name, which is why it can sit in every window's toolbar,
 * private ones included, without the list travelling any further than the downloads page.
 *
 * Absent until the window's first download, and gone again once the list no longer holds anything
 * the window started. Hidden rather than disabled for the zoom badge's reason: a button that could
 * only ever open an empty panel is a promise with nothing behind it.
 *
 * Quiet, too. A finished download opens nothing and raises nothing; the mark is on the button, and
 * whether to look is the user's call.
 *
 * Like `LayoutMenu`, the button does not draw its own panel — a popover in this renderer would sit
 * behind the tab views — and does not keep its own `open` flag: the core dismisses surfaces on its
 * own, and a button that remembered opening one would keep claiming it after it was gone.
 */

/**
 * The overlay kind the panel is presented as.
 *
 * One name, exported, so the button, `App` and the surface agree on it by import rather than by
 * spelling — and checked against `OverlayKind`, so a rename in the overlay tables fails here.
 */
export const DOWNLOADS_PANEL_KIND = 'downloads-panel' satisfies OverlayKind

/** Whether what the overlay layer shows is the downloads panel — what `open` is derived from. */
export function isDownloadsPanel(overlay: OverlayState): boolean {
  return overlay?.kind === DOWNLOADS_PANEL_KIND
}

/**
 * Puts the downloads panel up, anchored to the button.
 *
 * Kind and anchor, and no rows: this renderer is never sent the list, and the core fills the panel
 * from the window's own snapshot — `overlay:present` refuses a request that brings rows (KTD2).
 */
export function presentDownloadsPanel(anchor: Rect): void {
  void invoke('overlay:present', { kind: DOWNLOADS_PANEL_KIND, anchor })
}

/**
 * The window's button summary: the one it has now, then every change.
 *
 * Asked for first and listened to second, the pairing `window:getState` has with
 * `window:stateChanged`. The push carries changes only, so a chrome UI that mounts or reloads after a
 * download began would otherwise draw nothing until the next tick moved the bar. Whichever answer
 * arrives later is the newer one — the reply and the events travel down the same pipe in order — so
 * both are simply applied as they come.
 */
export function useDownloadSummary(): DownloadButtonSummary {
  // What the chrome UI draws before the core has said anything: no button.
  const [summary, setSummary] = useState<DownloadButtonSummary>(NO_DOWNLOAD_BUTTON)
  useEffect(() => {
    let cancelled = false
    void invoke('downloads:summary').then((current) => {
      if (!cancelled) setSummary(current)
    })
    const unsubscribe = subscribe('downloads:summaryChanged', setSummary)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return summary
}

/**
 * Each mark's word, borrowed from the downloads page's state names so the button and the list call
 * one outcome the same thing. A record over the markers, so a new one fails the build here.
 */
const MARKER_LABELS = {
  failed: DOWNLOAD_STATE_LABELS.interrupted,
  paused: DOWNLOAD_STATE_LABELS.paused,
  completed: DOWNLOAD_STATE_LABELS.completed
} as const satisfies Readonly<Record<DownloadMarker, MessageKey>>

/**
 * Each mark's glyph, drawn inside the badge. Three different shapes rather than one dot in three
 * colours, so the outcome survives a colour-blind eye and a greyscale screen: an exclamation mark,
 * two bars, a tick.
 */
const MARKER_GLYPHS: Readonly<Record<DownloadMarker, string>> = {
  failed: 'M16 2.2v2.2M16 6.1v.01',
  paused: 'M15 2.7v2.6M17 2.7v2.6',
  completed: 'M14.5 4.1l1.1 1.1 2-2.2'
}

/**
 * Whole percent, and never 100 while something still runs.
 *
 * Rounded rather than floored — a floor turns the floating-point `0.29 * 100` into 28 — and then
 * capped, because 99.6 % rounds to a "100 %" that the download has not reached. A button saying
 * "done" beside a download that is not is the one rounding error worth guarding against.
 */
function percentOf(fraction: number): number {
  const percent = Math.round(fraction * 100)
  return fraction < 1 ? Math.min(percent, 99) : 100
}

/** The tray line under the arrow, which doubles as the progress track. */
const TRAY = 'M4 16h12'

export function DownloadsButton({
  summary,
  open
}: {
  summary: DownloadButtonSummary
  /** Whether the overlay layer is showing the downloads panel; see `isDownloadsPanel`. */
  open: boolean
}): React.ReactNode {
  const { t } = useI18n()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(open)

  /*
    The focus comes back to the button when the panel goes.

    The layer hands the focus back to the chrome UI's web contents, not to any element in it, so
    without this a keyboard user who closed the panel with Escape would be left at the top of the
    document. Only when nothing else holds it, though: if the user has already moved on — into the
    address bar, say — taking it back would undo what they just did.
  */
  useEffect(() => {
    const closed = wasOpen.current && !open
    wasOpen.current = open
    const button = buttonRef.current
    if (!closed || button === null) return
    const active = document.activeElement
    if (active !== null && active !== document.body && active !== button) return
    button.focus()
  }, [open])

  if (!summary.visible) return null

  const { activity, marker } = summary
  // In the order the button draws them: progress first, then the mark, then just its name.
  const labelOf = (): string => {
    if (activity?.kind === 'fraction') {
      return t('toolbar.downloadsProgress', { percent: percentOf(activity.fraction) })
    }
    if (activity?.kind === 'indeterminate') {
      return t('toolbar.downloadsStatus', { status: t(DOWNLOAD_STATE_LABELS.progressing) })
    }
    if (marker !== null) return t('toolbar.downloadsStatus', { status: t(MARKER_LABELS[marker]) })
    return t('downloads.title')
  }
  const label = labelOf()

  const toggle = (): void => {
    if (open) {
      void invoke('overlay:dismiss')
      return
    }
    const element = buttonRef.current
    if (element === null) return
    // Window coordinates, for the reason `LayoutMenu` gives: this renderer fills the window at zoom 1.
    const box = element.getBoundingClientRect()
    presentDownloadsPanel({ x: box.x, y: box.y, width: box.width, height: box.height })
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className="iconbutton downloads"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={label}
      /*
        No key in the tooltip. The downloads shortcut opens the downloads *page*, and this button opens
        the panel; printing the key here would promise that pressing it does what clicking does.
      */
      title={label}
      data-activity={activity?.kind}
      data-marker={marker ?? undefined}
      onClick={toggle}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 3.5V12" />
        <path d="M6.5 8.5 10 12l3.5-3.5" />
        {/*
          The tray is the track. A share fills it from the left; unknown sweeps a short segment across
          it instead, so "running, size unknown" can never be mistaken for "stuck at some percent".
        */}
        <path className="downloads__track" d={TRAY} pathLength={1} />
        {activity?.kind === 'fraction' && (
          <path
            className="downloads__fill"
            data-part="fill"
            d={TRAY}
            pathLength={1}
            strokeDasharray={`${activity.fraction} 1`}
          />
        )}
        {activity?.kind === 'indeterminate' && (
          <path className="downloads__sweep" data-part="sweep" d={TRAY} pathLength={1} />
        )}
        {marker !== null && (
          <g className="downloads__badge" data-part="badge">
            <circle cx="16" cy="4" r="3.6" />
            <path data-part="glyph" d={MARKER_GLYPHS[marker]} />
          </g>
        )}
      </svg>
    </button>
  )
}
