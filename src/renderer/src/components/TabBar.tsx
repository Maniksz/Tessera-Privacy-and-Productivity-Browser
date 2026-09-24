import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type WheelEvent
} from 'react'
import type { SplitState, TabState } from '@shared/model.js'
import { stripItems } from '@shared/tabgroups/strip.js'
import { MAX_TAB_GROUP_NAME_LENGTH, type TabGroup } from '@shared/tabgroups/model.js'
import { tabGroupColorToken, type TabGroupColor } from '@shared/tabgroups/palette.js'
import type { ShortcutTitle } from '@shared/shortcuts/format.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { useTabDrag } from '../useTabDrag.js'
import { Icon } from '../../shared/Icon.js'
import { TabFavicon } from './TabFavicon.js'

/**
 * Tab strip.
 *
 * Shows which tile each tab occupies, which is what makes a split layout
 * legible — without it there is no way to tell a hidden-but-loaded tab from a
 * visible one (spec 2).
 *
 * Dragging is pointer-based rather than HTML5 drag and drop; see `useTabDrag` for why. One
 * gesture serves both purposes: released over the strip it reorders, released over a tile it
 * moves the tab there.
 */

interface TabBarProps {
  /**
   * Every tab in group order, including the members of a folded group.
   *
   * The folded ones arrive so the chip can say how many are hidden; `stripItems` decides which are
   * actually drawn, and it is the same function the core settles the order with.
   */
  tabs: TabState[]
  groups: TabGroup[]
  activeTabId: string | null
  split: SplitState | null
  leftInset: number
  rightInset: number
  /** Joins a label to the key that also presses the button; see `shortcutTitles`. */
  titleWithShortcut: ShortcutTitle
}

/**
 * A style carrying a group's colour as a custom property.
 *
 * A custom property rather than a class per colour: eight colours times four band positions would be
 * thirty-two rules for one idea. The slot name still comes from the fixed palette, so this is a
 * reference to a token and never a colour a group could store.
 *
 * Named rather than written inline at each of the two call sites, so the property's name is spelled
 * once — a typo in it produces no colour at all and no error anywhere.
 */
function groupColorStyle(color: TabGroupColor): CSSProperties {
  /*
    Through a variable, and not a type assertion.

    `CSSProperties` refuses a `--custom` key in an object *literal* — the excess-property check — but
    accepts a plain record, because a record has an index signature. So this is an ordinary assignment
    rather than a cast, and it stays type-checked: `Record<string, string>` still rules out handing
    React a number or an object where a CSS value belongs.
  */
  const style: Record<string, string> = { '--tab-group-current': tabGroupColorToken(color) }
  return style
}

/** Which ends of the strip have tabs scrolled past them. */
interface StripOverflow {
  left: boolean
  right: boolean
}

/**
 * Whether there is more to either side (U22, R32).
 *
 * A pixel of slack at each end, because Chromium reports a fractional scroll position as a rounded one
 * at some zoom levels, and a strip scrolled exactly to its end would otherwise keep its fade.
 */
function overflowOf(strip: HTMLElement): StripOverflow {
  return {
    left: strip.scrollLeft > 1,
    right: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1
  }
}

/**
 * A group's chip: its colour, its name, and — while folded — how many tabs are behind it.
 *
 * The chip is the only control a folded group has, so it carries `aria-expanded` and the count. A
 * chip that said nothing while three tabs were hidden would read as an empty group, and the tabs
 * would look closed when they are still loaded and running (spec 2).
 */
function GroupChip({
  group,
  hiddenCount,
  t
}: {
  group: TabGroup
  hiddenCount: number
  t: (key: MessageKey, params?: Record<string, string | number>) => string
}): React.ReactNode {
  const [draft, setDraft] = useState<string | null>(null)
  const name = group.name === '' ? t('tabgroup.unnamed') : group.name

  /*
    Renaming happens here rather than in the context menu.

    A native menu has no text field, and the two alternatives — a modal dialogue or a second overlay
    surface — are both heavier than what the strip already affords. The chip is in the chrome area,
    which sits *above* the content views, so an inline input needs no layer of its own.
  */
  if (draft !== null) {
    const commit = (): void => {
      const trimmed = draft.trim()
      // An empty name is legal: an unnamed group draws as a bare colour, which is a state the user
      // may want back. So this sends whatever is there, including nothing.
      void invoke('tabgroups:rename', { id: group.id, name: trimmed })
      setDraft(null)
    }
    return (
      <input
        className="tabgroup__input"
        /*
          Focused on appearance. The input exists only because the user just double-clicked to
          rename it, so not taking focus would mean a second click to do what they already asked
          for — the case where autofocus is right rather than the case where it steals attention.
        */
        autoFocus
        aria-label={t('tabgroup.rename')}
        value={draft}
        maxLength={MAX_TAB_GROUP_NAME_LENGTH}
        style={groupColorStyle(group.color)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          // Escape abandons the edit. Without it the only way out is to accept a name.
          if (event.key === 'Escape') setDraft(null)
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className={`tabgroup${group.collapsed ? ' tabgroup--collapsed' : ''}`}
      data-tab-group-id={group.id}
      aria-expanded={!group.collapsed}
      aria-label={
        group.collapsed
          ? t('tabgroup.expand', { name, count: hiddenCount })
          : t('tabgroup.collapse', { name })
      }
      title={name}
      style={groupColorStyle(group.color)}
      onClick={() =>
        void invoke('tabgroups:setCollapsed', { id: group.id, collapsed: !group.collapsed })
      }
      onDoubleClick={() => setDraft(group.name)}
    >
      <span className="tabgroup__dot" aria-hidden="true" />
      {group.name !== '' && <span className="tabgroup__name">{group.name}</span>}
      {group.collapsed && (
        <span className="tabgroup__count" aria-hidden="true">
          {hiddenCount}
        </span>
      )}
    </button>
  )
}

export function TabBar({
  tabs,
  groups,
  activeTabId,
  split,
  leftInset,
  rightInset,
  titleWithShortcut
}: TabBarProps): React.ReactNode {
  const { t } = useI18n()
  const stripRef = useRef<HTMLDivElement>(null)
  const drag = useTabDrag(stripRef)
  const [overflow, setOverflow] = useState<StripOverflow>({ left: false, right: false })

  const tileCount = split?.tileTabIds.length ?? 1

  /*
    The strip's contents: group chips interleaved with the tabs they contain.

    `stripItems` decides the sequence, including which tabs a folded group hides. The lookups below
    exist because it works in tab *ids* — it is shared with anything else that draws a strip and knows
    nothing about `TabState` — while the drag reports positions as indices into `tabs`, which is the
    order the core sent. Keeping the drag on that index means group chips cannot shift a drop target.
  */
  const items = stripItems(
    tabs.map((tab) => tab.id),
    groups
  )
  const stateOf = new Map(tabs.map((tab) => [tab.id, tab]))
  const indexOf = new Map(tabs.map((tab, index) => [tab.id, index]))
  const activeDrawn = items.some((item) => item.kind === 'tab' && item.tabId === activeTabId)

  /*
    The active tab stays in sight (R32): whenever it changes, and when a folded group that hid it opens.

    Only then, and not on every change to the strip — a tab opened in the background or a title arriving
    must not pull the strip back while somebody has scrolled away to look at other tabs. `nearest` on
    both axes, so a tab already in view does not move at all and the page itself never scrolls; the
    strip's `scroll-padding-inline` keeps the tab clear of the edge fade.
  */
  useEffect(() => {
    if (!activeDrawn) return
    const strip = stripRef.current
    const element = [...(strip?.querySelectorAll<HTMLElement>('[data-tab-id]') ?? [])].find(
      (candidate) => candidate.dataset.tabId === activeTabId
    )
    element?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeTabId, activeDrawn])

  /*
    Whether to fade either end: measured after every render, on every scroll, and when the window
    resizes the strip. After every render because a tab opening, closing or taking a longer title all
    change the width, and a list of what might is longer than the read is expensive. The state only
    changes when an answer does, so the render this can cause is the one that draws the fade.
  */
  const measure = useCallback((): void => {
    const strip = stripRef.current
    if (strip === null) return
    const next = overflowOf(strip)
    setOverflow((previous) =>
      previous.left === next.left && previous.right === next.right ? previous : next
    )
  }, [])

  useLayoutEffect(measure)

  useEffect(() => {
    const strip = stripRef.current
    if (strip === null) return
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [measure])

  /*
    A vertical wheel scrolls the strip sideways, which is the only way along it for a mouse without a
    tilt wheel. A mostly-sideways gesture — a trackpad, a tilt wheel — is Chromium's already, and a strip
    that fits has nowhere to go, so both are left alone.
  */
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const strip = event.currentTarget
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    if (strip.scrollWidth <= strip.clientWidth) return
    strip.scrollLeft += event.deltaY
  }

  const onAuxClick = (event: MouseEvent, tabId: string): void => {
    // Middle-click closes (spec 1).
    if (event.button === 1) {
      event.preventDefault()
      void invoke('tabs:close', { tabId })
    }
  }

  return (
    <div
      className="tabbar"
      role="tablist"
      aria-label={t('menu.window')}
      // Leaves the OS window controls uncovered (spec 10).
      style={{ paddingLeft: leftInset, paddingRight: rightInset }}
    >
      <div
        className={[
          'tabbar__strip',
          overflow.left ? 'tabbar__strip--more-left' : '',
          overflow.right ? 'tabbar__strip--more-right' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        ref={stripRef}
        onScroll={measure}
        onWheel={onWheel}
      >
        {items.map((item) => {
          if (item.kind === 'group') {
            return (
              <GroupChip
                key={`group-${item.group.id}`}
                group={item.group}
                hiddenCount={item.hiddenCount}
                t={t}
              />
            )
          }

          const tab = stateOf.get(item.tabId)
          const index = indexOf.get(item.tabId) ?? 0
          // Cannot happen — the items were built from `tabs` — but a strip that threw would take the
          // whole window's UI with it, and one missing tab is recoverable.
          if (tab === undefined) return null

          const isActive = tab.id === activeTabId
          const tileLabel =
            tab.tileIndex === null
              ? t('tab.unassigned')
              : t('tab.inTile', { index: tab.tileIndex + 1 })

          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              title={[
                tab.title || t('tab.untitled'),
                tileLabel,
                tab.unloaded ? t('tab.unloaded') : ''
              ]
                .filter(Boolean)
                .join('\n')}
              className={[
                'tab',
                isActive ? 'tab--active' : '',
                tab.pinned ? 'tab--pinned' : '',
                tab.tileIndex === null ? 'tab--unassigned' : '',
                tab.unloaded ? 'tab--unloaded' : '',
                drag.draggingId === tab.id ? 'tab--dragging' : '',
                drag.draggingId !== null && drag.reorderIndex === index ? 'tab--dropbefore' : '',
                item.group === null ? '' : 'tab--grouped',
                item.position === null ? '' : `tab--group-${item.position}`
              ]
                .filter(Boolean)
                .join(' ')}
              style={item.group === null ? undefined : groupColorStyle(item.group.color)}
              onPointerDown={(event) => drag.begin(event, tab.id)}
              onClick={() => void invoke('tabs:activate', { tabId: tab.id })}
              onAuxClick={(event) => onAuxClick(event, tab.id)}
              /*
                The only way to reach tab groups, so it is not a nicety.

                A native menu, opened by the core — see `menu/tabContextMenu.ts`. `preventDefault`
                stops Chromium's own menu appearing behind it.
              */
              onContextMenu={(event) => {
                event.preventDefault()
                void invoke('tabs:contextMenu', { tabId: tab.id })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void invoke('tabs:activate', { tabId: tab.id })
                }
              }}
            >
              {tab.loading ? (
                <span className="tab__spinner" aria-hidden="true" />
              ) : (
                <TabFavicon url={tab.faviconUrl} />
              )}

              <span className="tab__title">{tab.title || t('tab.untitled')}</span>

              {tab.audible && (
                <button
                  type="button"
                  className="tab__mute"
                  aria-label={t(tab.muted ? 'tab.unmute' : 'tab.mute')}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (tab.tileIndex !== null) {
                      void invoke('media:setTileMuted', {
                        tileIndex: tab.tileIndex,
                        muted: !tab.muted
                      })
                    }
                  }}
                >
                  <Icon name={tab.muted ? 'volume-off' : 'volume'} size={13} />
                </button>
              )}

              {/* Which tile, so the mapping is visible at a glance (spec 2). */}
              {tab.tileIndex !== null && tileCount > 1 && (
                <span className="tab__tile" aria-label={tileLabel}>
                  {tab.tileIndex + 1}
                </span>
              )}

              <button
                type="button"
                className="tab__close"
                aria-label={t('tab.close')}
                onClick={(event) => {
                  event.stopPropagation()
                  void invoke('tabs:close', { tabId: tab.id })
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )
        })}

        <button
          type="button"
          className="tabbar__new"
          aria-label={t('tab.newTab')}
          title={titleWithShortcut(t('tab.newTab'), 'newTab')}
          onClick={() => void invoke('tabs:create', {})}
        >
          +
        </button>
      </div>
    </div>
  )
}
