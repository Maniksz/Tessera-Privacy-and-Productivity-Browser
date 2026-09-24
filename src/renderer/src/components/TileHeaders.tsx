import type { SplitState, TabState } from '@shared/model.js'
import type { Rect } from '@shared/split/layout.js'
import { headerRectOf } from '@shared/split/tile-header.js'
import { useI18n } from '../i18n.js'
import { Icon } from '../../shared/Icon.js'

/**
 * The header strip above each tile's page (U20, R34): favicon, title, and a mark when it is muted.
 *
 * Chrome DOM in the gap the core leaves: with `splitView.showTileHeaders` on, `planViews` moves each
 * view below its tile's header, and this draws in the strip it gave up. Nothing here is interactive —
 * the hover tile bar under the header keeps the controls, and a header that took clicks would be one
 * more thing competing with the divider handles in the gutters beside it.
 *
 * ## Why it measures nothing
 *
 * The active-tile ring that was removed from `SplitDividers` measured its own element from an effect
 * that ran once, before a split existed, and never again. This takes its rectangles and flags from
 * `useTileRects` in `App`, which measures the content element that is always mounted, and has no
 * hook that an early return could skip: every tile decides for itself whether it draws.
 */
export function TileHeaders({
  split,
  tabs,
  rects,
  headers
}: {
  split: SplitState
  tabs: readonly TabState[]
  /** The tiles' rectangles in the content element's own space, from `useTileRects`. */
  rects: readonly Rect[]
  /** Which tiles carry a header, from `useTileRects`. */
  headers: readonly boolean[]
}): React.ReactNode {
  const { t } = useI18n()
  return split.tileTabIds.map((tabId, index) => {
    const rect = rects[index]
    if (tabId === null || rect === undefined || headers[index] !== true) return null
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (tab === undefined) return null
    const { x, y, width, height } = headerRectOf(rect)
    return (
      <div
        key={tabId}
        className="tile-header"
        data-tile-index={index}
        style={{ left: x, top: y, width, height }}
      >
        <span className="tab__favicon" aria-hidden="true">
          {tab.faviconUrl !== null && (
            <img
              // Keyed, not draggable, hidden on a miss: the same three reasons as in `TabBar`.
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
        <span className="tile-header__title">{tab.title || t('tab.untitled')}</span>
        {tab.muted && (
          <span className="tile-header__muted" role="img" aria-label={t('split.muted')}>
            <Icon name="volume-off" size={12} />
          </span>
        )}
      </div>
    )
  })
}
