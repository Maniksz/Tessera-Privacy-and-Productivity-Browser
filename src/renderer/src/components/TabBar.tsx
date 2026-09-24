import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type WheelEvent
} from 'react'
import type { TabState } from '@shared/model.js'
import type { ArrangementSummary } from '@shared/arrangements/screen.js'
import { stripEntryOf, stripItems, type SplitStripItem } from '@shared/strip/model.js'
import { resolveStripDrop, type StripDropTarget } from '@shared/strip/drop.js'
import { MAX_TAB_GROUP_NAME_LENGTH, type TabGroup } from '@shared/tabgroups/model.js'
import { tabGroupColorToken, type TabGroupColor } from '@shared/tabgroups/palette.js'
import type { ShortcutTitle } from '@shared/shortcuts/format.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { useTabDrag, type StripSpot, type TabDrag } from '../useTabDrag.js'
import { Icon } from '../../shared/Icon.js'
import { TabFavicon } from './TabFavicon.js'

/**
 * Tab strip.
 *
 * Loose tabs, group chips, and one entry per tiled view (U7, R1): the pages of a tiled view are
 * drawn together as that entry rather than as tabs of their own, so the strip needs no tile numbers
 * to say which pages belong together. `stripItems` decides the sequence.
 *
 * Dragging is pointer-based rather than HTML5 drag and drop; see `useTabDrag` for why. One
 * gesture serves both purposes: released over the strip it reorders — into a group, out of one, or
 * within the strip (U9, R12) — and released over a tile it moves the tab there. A tiled view's entry
 * drags too, but only within the strip.
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
  /** The window's tiled views, as `arrangements:changed` summarises them (KTD5). */
  arrangements: ArrangementSummary[]
  activeTabId: string | null
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

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/**
 * What an element offers as a drop target, as `useTabDrag` reads it back (`stripSpotAt`). Folded is
 * said separately, because most of a folded chip is "onto" it rather than its right half (KTD7).
 */
function stripTargetProps(
  kind: Exclude<StripDropTarget['kind'], 'end'>,
  id: string,
  folded = false
): Record<string, string> {
  return {
    'data-strip-target': kind,
    'data-strip-id': id,
    ...(folded ? { 'data-strip-folded': 'true' } : {})
  }
}

/** One key per target, so the marker can find the element the pointer is over. */
function targetKey(target: StripDropTarget): string {
  switch (target.kind) {
    case 'tab':
      return `tab:${target.tabId}`
    case 'split':
      return `split:${target.arrangementId}`
    case 'group':
      return `group:${target.groupId}`
    case 'end':
      return 'end'
  }
}

/**
 * The insertion marker's classes for one target: which side the drop lands on, and whether it joins a
 * group there (U9). Nothing for a target the pointer is not over, or for a drop that moves nothing.
 *
 * The same `resolveStripDrop` the core applies the drop with answers "joins", so the marker cannot
 * promise a group the drop will not give.
 */
function dropMarker(
  spot: StripSpot | null,
  joins: boolean | null,
  target: StripDropTarget
): string {
  if (joins === null || spot === null || targetKey(spot.target) !== targetKey(target)) return ''
  // The end of the strip marks the new-tab button, which stands after the last target: its left side.
  const side = spot.side === 'after' && target.kind !== 'end' ? 'tab--dropafter' : 'tab--dropbefore'
  return joins ? `${side} tab--dropjoin` : side
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
  marker,
  t
}: {
  group: TabGroup
  hiddenCount: number
  /** The insertion marker's classes while a drag is over the chip; see `dropMarker`. */
  marker: string
  t: Translate
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
      className={['tabgroup', group.collapsed ? 'tabgroup--collapsed' : '', marker]
        .filter(Boolean)
        .join(' ')}
      data-tab-group-id={group.id}
      {...stripTargetProps('group', group.id, group.collapsed)}
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
      /*
        The group's own menu — its colour, and ungrouping it — opened by the core like a tab's. The
        chip is the one control a folded group has, so without this a folded group could only be
        ended by unfolding it first. See `tabGroupMenuTemplate`.
      */
      onContextMenu={(event) => {
        event.preventDefault()
        void invoke('tabgroups:contextMenu', { id: group.id })
      }}
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

/**
 * A tiled view's entry: every member's icon in tile order, the title of the tile that had focus, and
 * controls that act on the whole view by its id (R2, R5, R6).
 *
 * By id rather than through a member, because a click brings back the view as it was — its active
 * tile included — and a close ends every page in it; neither is a question about one tab. The core
 * owns both (`arrangement-handlers.ts`), so this only reports what was pressed.
 *
 * It drags as the whole view (U9): into a group, out of one, along the strip — never onto the tiles,
 * which would merge two views. A tab dropped on it is placed beside it and does not join it.
 */
function SplitEntry({
  item,
  members,
  selected,
  drag,
  marker,
  listFormat,
  t
}: {
  item: SplitStripItem
  /** The members this window has, in tile order. */
  members: TabState[]
  selected: boolean
  drag: TabDrag
  /** The insertion marker's classes while a drag is over the entry; see `dropMarker`. */
  marker: string
  listFormat: Intl.ListFormat
  t: Translate
}): React.ReactNode {
  const titleOf = (tab: TabState): string => tab.title || t('tab.untitled')
  const active = members.find((tab) => tab.id === item.activeTabId)
  const title = active === undefined ? t('tab.untitled') : titleOf(active)

  /*
    Loud unless every member making sound is muted (KTD11), so the speaker never says "muted" while
    something plays, and a click on a mixed view silences all of it rather than unmuting the page
    the user had silenced on purpose. Members with no sound have no say either way.
  */
  const audible = members.filter((tab) => tab.audible)
  const muted = audible.length > 0 && audible.every((tab) => tab.muted)

  const activate = (): void => void invoke('arrangements:activate', { id: item.arrangementId })
  const close = (): void => void invoke('arrangements:close', { id: item.arrangementId })

  return (
    <div
      data-arrangement-id={item.arrangementId}
      {...stripTargetProps('split', item.arrangementId)}
      role="tab"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected}
      aria-label={t('tab.splitEntry', {
        titles: listFormat.format(
          members.map((tab) =>
            tab === active ? t('tab.splitEntryActive', { title: titleOf(tab) }) : titleOf(tab)
          )
        )
      })}
      title={members.map(titleOf).join('\n')}
      className={[
        'tab',
        'tab--split',
        selected ? 'tab--active' : '',
        drag.dragging?.kind === 'split' && drag.dragging.arrangementId === item.arrangementId
          ? 'tab--dragging'
          : '',
        marker,
        item.group === null ? '' : 'tab--grouped',
        item.position === null ? '' : `tab--group-${item.position}`
      ]
        .filter(Boolean)
        .join(' ')}
      style={item.group === null ? undefined : groupColorStyle(item.group.color)}
      onPointerDown={(event) =>
        drag.begin(event, { kind: 'split', arrangementId: item.arrangementId })
      }
      onClick={activate}
      onAuxClick={(event) => {
        // Middle-click closes, as on a tab — here the whole view (R5).
        if (event.button === 1) {
          event.preventDefault()
          close()
        }
      }}
      /*
        The view's own native menu: change its layout, end it, its group actions, close all (R7). The
        core builds it from `arrangement-items.ts`; `preventDefault` keeps Chromium's out of the way.
      */
      onContextMenu={(event) => {
        event.preventDefault()
        void invoke('arrangements:contextMenu', { id: item.arrangementId })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      }}
    >
      <span className="tab__favicons">
        {members.map((tab) =>
          tab.loading ? (
            <span key={tab.id} className="tab__spinner" aria-hidden="true" />
          ) : (
            <TabFavicon key={tab.id} url={tab.faviconUrl} />
          )
        )}
      </span>

      <span className="tab__title">{title}</span>

      {audible.length > 0 && (
        <button
          type="button"
          className="tab__mute"
          aria-label={t(muted ? 'tab.splitEntryUnmute' : 'tab.splitEntryMute')}
          onClick={(event) => {
            event.stopPropagation()
            void invoke('arrangements:setMuted', { id: item.arrangementId, muted: !muted })
          }}
        >
          <Icon name={muted ? 'volume-off' : 'volume'} size={13} />
        </button>
      )}

      <button
        type="button"
        className="tab__close"
        aria-label={t('tab.splitEntryClose')}
        onClick={(event) => {
          event.stopPropagation()
          close()
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}

export function TabBar({
  tabs,
  groups,
  arrangements,
  activeTabId,
  leftInset,
  rightInset,
  titleWithShortcut
}: TabBarProps): React.ReactNode {
  const { t, locale } = useI18n()
  // "A, B and C" in the reader's language, for a tiled view's accessible name.
  const listFormat = useMemo(() => new Intl.ListFormat(locale, { type: 'conjunction' }), [locale])
  const stripRef = useRef<HTMLDivElement>(null)
  const drag = useTabDrag(stripRef)
  const [overflow, setOverflow] = useState<StripOverflow>({ left: false, right: false })

  /*
    The strip's contents: group chips interleaved with the tabs and tiled views they contain.

    `stripItems` decides the sequence, including which tabs a folded group hides and which tabs are one
    tiled view's entry. The lookups below
    exist because it works in tab *ids* — it is shared with anything else that draws a strip and knows
    nothing about `TabState` — while the drag reports positions as indices into `tabs`, which is the
    order the core sent. A drop is reported as the target under the pointer and a side (KTD7), so
    neither chips nor folded tabs can shift it.
  */
  const order = tabs.map((tab) => tab.id)
  const items = stripItems(order, groups, arrangements)
  const stateOf = new Map(tabs.map((tab) => [tab.id, tab]))
  // Whether the drop under the pointer joins a group, by the rule the core applies it with; `null`
  // while there is no drop, or it would move nothing.
  const dropPlan =
    drag.dragging === null || drag.spot === null
      ? null
      : resolveStripDrop(order, groups, arrangements, { subject: drag.dragging, ...drag.spot })
  /*
    Except that a tab dragged out of a tile always lands (U10): let go beside the view it came from, the
    strip moves nothing, but the tab still leaves the view and stands there. So that place is marked too,
    as one that joins nothing — the tab keeps whatever group its view was in (R10).
  */
  const tileLands = drag.fromTile && drag.spot !== null
  const joins = dropPlan === null ? (tileLands ? false : null) : dropPlan.groupId !== null
  const markerOf = (target: StripDropTarget): string => dropMarker(drag.spot, joins, target)
  // The entry the active tab is drawn in: its own, or its tiled view's whichever tile has focus.
  const activeEntry = stripEntryOf(items, activeTabId)
  const activeDrawn = activeEntry !== null

  /*
    The active tab stays in sight (R32): whenever it changes, and when a folded group that hid it opens.

    Only then, and not on every change to the strip — a tab opened in the background or a title arriving
    must not pull the strip back while somebody has scrolled away to look at other tabs. `nearest` on
    both axes, so a tab already in view does not move at all and the page itself never scrolls; the
    strip's `scroll-padding-inline` keeps the tab clear of the edge fade.
  */
  useEffect(() => {
    if (!activeDrawn) return
    // The selected entry, a tab or a tiled view, rather than a lookup by id that only a tab answers.
    const element = stripRef.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]'
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
                marker={markerOf({ kind: 'group', groupId: item.group.id })}
                t={t}
              />
            )
          }

          if (item.kind === 'split') {
            return (
              <SplitEntry
                key={`split-${item.arrangementId}`}
                item={item}
                members={item.tabIds.flatMap((tabId) => stateOf.get(tabId) ?? [])}
                selected={item === activeEntry}
                drag={drag}
                marker={markerOf({ kind: 'split', arrangementId: item.arrangementId })}
                listFormat={listFormat}
                t={t}
              />
            )
          }

          const tab = stateOf.get(item.tabId)
          // Cannot happen — the items were built from `tabs` — but a strip that threw would take the
          // whole window's UI with it, and one missing tab is recoverable.
          if (tab === undefined) return null

          const isActive = tab.id === activeTabId

          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              {...stripTargetProps('tab', tab.id)}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              title={[tab.title || t('tab.untitled'), tab.unloaded ? t('tab.unloaded') : '']
                .filter(Boolean)
                .join('\n')}
              className={[
                'tab',
                isActive ? 'tab--active' : '',
                tab.pinned ? 'tab--pinned' : '',
                tab.unloaded ? 'tab--unloaded' : '',
                drag.dragging?.kind === 'tab' && drag.dragging.tabId === tab.id
                  ? 'tab--dragging'
                  : '',
                markerOf({ kind: 'tab', tabId: tab.id }),
                item.group === null ? '' : 'tab--grouped',
                item.position === null ? '' : `tab--group-${item.position}`
              ]
                .filter(Boolean)
                .join(' ')}
              style={item.group === null ? undefined : groupColorStyle(item.group.color)}
              onPointerDown={(event) => drag.begin(event, { kind: 'tab', tabId: tab.id })}
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
          className={['tabbar__new', markerOf({ kind: 'end' })].filter(Boolean).join(' ')}
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
