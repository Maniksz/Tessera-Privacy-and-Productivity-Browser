import type { SplitState, TabState } from '@shared/model.js'
import type { Rect } from '@shared/split/layout.js'
import {
  failureMessage,
  offersOpenAnyway,
  type TabFailure as Failure
} from '@shared/browser/tab-failure.js'
import { placeView } from '@shared/browser/view-visibility.js'
import { withSiteExemption } from '@shared/filters/site-exemption.js'
import { invoke, setSetting } from '../bridge.js'
import { useI18n } from '../i18n.js'

/**
 * What a tile shows while its page failed or its renderer is gone (U9, KTD4).
 *
 * Drawn by the chrome in the tile's rectangle, over a view the core has hidden — not a page loaded into
 * the tab. So the tab keeps its real address the whole time: the omnibox, the history, Strg+D and the
 * session all go on naming the page that failed, and "reload" reloads that page rather than an error
 * page. Several tiles can show one at once, which a single overlay surface could not.
 */
export function TabFailure({
  tabId,
  failure,
  exemptSites
}: {
  tabId: string
  failure: Failure
  /** `privacy.blockerOffForSites`, for "open anyway". */
  exemptSites: readonly string[]
}): React.ReactNode {
  const { t } = useI18n()
  const message = failureMessage(failure)

  const reload = (): void => {
    void invoke('nav:reload', { tabId })
  }

  /*
    The blocker's own per-site switch, written through the same pure function the blocker menu uses, so
    "open anyway" and "blocking on this site: off" are one exemption and not two. Offered for the blocker
    alone — see `BLOCK_SOURCES` for why telemetry and the kill switch have no way through.
  */
  const openAnyway = async (): Promise<void> => {
    const next = withSiteExemption(exemptSites, failure.host, true)
    if (next !== exemptSites) await setSetting('privacy.blockerOffForSites', [...next])
    await invoke('nav:reload', { tabId })
  }

  return (
    <div className="tab-failure" role="alert">
      <p className="tab-failure__message">{t(message.key, message.params)}</p>
      <p className="tab-failure__code">{failure.code}</p>
      <div className="tab-failure__actions">
        <button type="button" className="dialog__button dialog__button--primary" onClick={reload}>
          {t('toolbar.reload')}
        </button>
        {offersOpenAnyway(failure) && (
          <button type="button" className="dialog__button" onClick={() => void openAnyway()}>
            {t('error.openAnyway')}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * One `TabFailure` per tile whose tab has one, each in that tile's rectangle.
 *
 * Where to draw comes from `placeView`, the rule the core hides the view with, so the panel and the
 * hidden view cannot disagree. A maximised tile covers the whole content area, as the core lays it out.
 */
export function TileFailures({
  split,
  tabs,
  rects,
  exemptSites
}: {
  split: SplitState
  tabs: readonly TabState[]
  rects: readonly Rect[]
  exemptSites: readonly string[]
}): React.ReactNode {
  return split.tileTabIds.map((tabId, index) => {
    const maximized = split.maximizedTile
    if (tabId === null || (maximized !== null && maximized !== index)) return null
    const tab = tabs.find((candidate) => candidate.id === tabId)
    const rect = rects[index] ?? null
    if (tab?.failure === undefined || !placeView(rect, tab).showsFailure || rect === null) {
      return null
    }
    const style =
      maximized === index
        ? { inset: 0 }
        : { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
    return (
      <div key={tabId} className="content__tile" data-tile-index={index} style={style}>
        <TabFailure tabId={tabId} failure={tab.failure} exemptSites={exemptSites} />
      </div>
    )
  })
}
