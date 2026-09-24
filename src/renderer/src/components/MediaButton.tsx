import { useEffect, useState } from 'react'
import type { MediaFindingList } from '@shared/media/wire.js'
import { invoke, subscribe } from '../bridge.js'
import { useI18n } from '../i18n.js'
import type { MediaPort } from './MediaPanel.js'

/**
 * The toolbar's way to the media panel (media plan R2, R3; roadmap U16).
 *
 * ## Why always there, and quiet when empty
 *
 * Always, because the panel is also where "this page is playing nothing this browser recognises" is
 * said in words, and a button that appeared only with a find would leave somebody who expected one
 * with nothing to press. Quiet, because most pages play nothing: dim and without a number until the
 * active tab has a find, then the number itself — the count is the information, the way the zoom
 * badge's percentage is.
 *
 * ## Why the count is pulled per tab and then pushed
 *
 * `media:changed` carries one tab's whole list, for every tab of the window. The count follows the
 * active tab: asked once when the tab changes, then taken from every push that names it and from no
 * other. A push for a background tile's tab is somebody else's number.
 */

/** How many finds `tabId` has: asked when it changes, then kept current by `media:changed`. */
export function useMediaFindingCount(tabId: string | undefined): number {
  const [list, setList] = useState<MediaFindingList | null>(null)
  useEffect(() => {
    if (tabId === undefined) return
    let cancelled = false
    invoke('media:list', { tabId }).then(
      (current) => {
        if (!cancelled) setList(current)
      },
      // A tab that closed between the switch and the answer; the next tab asks again.
      () => {}
    )
    const unsubscribe = subscribe('media:changed', (next) => {
      if (next.tabId === tabId) setList(next)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [tabId])
  // The tab just left's list is not the answer while the new one is being asked for. Optional
  // chaining although the type says otherwise: a stub bridge that answers nothing must not throw.
  return list?.tabId === tabId ? (list?.findings.length ?? 0) : 0
}

/**
 * The panel's four operations and its subscription, each naming `tabId`.
 *
 * Named rather than left to the core's "active tile" default, so the panel and the core cannot
 * mean different pages in the moment between a tab switch and the panel's next render.
 */
export function mediaPortFor(tabId: string | undefined): MediaPort {
  const scope = tabId === undefined ? {} : { tabId }
  return {
    list: () => invoke('media:list', scope),
    describe: (findingId) => invoke('media:describe', { ...scope, findingId }),
    download: (findingId, variantId) =>
      invoke('media:download', { ...scope, findingId, variantId }),
    cancel: (findingId) => invoke('media:cancel', { ...scope, findingId }),
    subscribe: (listener) => subscribe('media:changed', listener)
  }
}

export function MediaButton({
  count,
  open,
  onOpen
}: {
  /** The active tab's finds, from `useMediaFindingCount`. */
  count: number
  /** Whether the media panel is up. */
  open: boolean
  onOpen: () => void
}): React.ReactNode {
  const { t } = useI18n()
  const label = t('toolbar.media', { count })
  return (
    <button
      type="button"
      className="iconbutton media-button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={label}
      // No key in the tooltip: no shortcut opens this panel, and a tooltip must not invent one.
      title={label}
      data-found={count > 0 ? '' : undefined}
      onClick={onOpen}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="3" y="4.5" width="14" height="11" rx="2" />
        <path d="M8.5 7.6v4.8l4-2.4z" />
      </svg>
      {count > 0 && <span data-part="count">{count}</span>}
    </button>
  )
}
