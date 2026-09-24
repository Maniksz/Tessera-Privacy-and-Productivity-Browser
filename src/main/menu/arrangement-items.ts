import type { MenuItemConstructorOptions } from 'electron'
import type { Locale } from '@shared/i18n/catalog.js'
import type { ArrangementSummary } from '@shared/arrangements/screen.js'
import { LAYOUT_IDS, type LayoutId } from '@shared/split/layout.js'
import { LAYOUT_LABELS } from '@shared/split/labels.js'
import { groupOfTab, type TabGroup } from '@shared/tabgroups/model.js'
import { menuLabel, type MenuLabelKey } from './menu-text.js'
// How a tab's own "Add to group ▸" names an unnamed group, so one group is not called two things.
import { COLOR_LABELS } from './tab-context-items.js'

/**
 * The menu a right-click on a tiled view's entry in the tab strip opens (R7, KTD12).
 *
 * Native for the reasons `tab-context-items.ts` gives — plain text items, above every view, read by
 * the platform's assistive technology — and pure for the same reason too: `tabContextMenu.ts` holds
 * the one line that needs Electron, and every decision here is an ordinary unit test.
 *
 * ## What is on it
 *
 * "Change Layout ▸" lists every layout but the single one: choosing one tile is ending the view, which
 * has its own item and its own wording, so offering it twice would be two names for one act. A radio,
 * so the view's layout is visible without remembering it — the stored one for a view that is put away,
 * because that is the layout it comes back in.
 *
 * The group actions are the view's, not a tab's (R10): new group, add to another, remove from its own.
 * Each is asked through the view's **first member**, and the group side widens a member to the whole
 * view (`TabGroupController`, KTD4) — so this menu and a member's own menu cannot disagree about what
 * grouping a tiled view means. Recolouring and ungrouping are the chip's, where a group is addressed as
 * a group; a view is not one.
 *
 * Built fresh on every right-click from the summaries of this round, and empty for an entry that has
 * gone since the strip drew it — the caller opens nothing then.
 */

export interface ArrangementMenuDeps {
  locale: Locale
  /** The entry the menu was opened on. */
  id: string
  /** The window's views, as `arrangements:changed` carries them. */
  arrangements: readonly ArrangementSummary[]
  groups: readonly TabGroup[]
  onChangeLayout(id: string, layout: LayoutId): void
  onEnd(id: string): void
  onCreateGroup(tabId: string): void
  onAddToGroup(groupId: string, tabId: string): void
  onRemoveFromGroup(tabId: string): void
  onCloseAll(id: string): void
}

export function arrangementMenuTemplate(deps: ArrangementMenuDeps): MenuItemConstructorOptions[] {
  const arrangement = deps.arrangements.find((summary) => summary.id === deps.id)
  if (arrangement === undefined) return []
  const t = (key: MenuLabelKey): string => menuLabel(deps.locale, key)
  const { id } = arrangement

  return [
    {
      label: t('arrangement.changeLayout'),
      submenu: LAYOUT_IDS.filter((layout) => layout !== '1x1').map((layout) => ({
        label: t(LAYOUT_LABELS[layout]),
        type: 'radio' as const,
        checked: arrangement.layoutId === layout,
        click: () => deps.onChangeLayout(id, layout)
      }))
    },
    { label: t('arrangement.end'), click: () => deps.onEnd(id) },
    { type: 'separator' },
    ...groupItems(t, arrangement, deps),
    { type: 'separator' },
    { label: t('arrangement.closeAll'), click: () => deps.onCloseAll(id) }
  ]
}

/** New group, another group, out of its own: all through the view's first member. */
function groupItems(
  t: (key: MenuLabelKey) => string,
  arrangement: ArrangementSummary,
  deps: ArrangementMenuDeps
): MenuItemConstructorOptions[] {
  const member = arrangement.tabIds[0]
  if (member === undefined) return []
  const own = groupOfTab(deps.groups, member)
  const others = deps.groups.filter((group) => group.id !== own?.id)

  const items: MenuItemConstructorOptions[] = [
    { label: t('tabgroup.new'), click: () => deps.onCreateGroup(member) }
  ]
  if (others.length > 0) {
    items.push({
      label: t('tabgroup.addTo'),
      submenu: others.map((group) => ({
        label: group.name === '' ? t(COLOR_LABELS[group.color]) : group.name,
        click: () => deps.onAddToGroup(group.id, member)
      }))
    })
  }
  if (own !== undefined) {
    items.push({ label: t('tabgroup.removeTab'), click: () => deps.onRemoveFromGroup(member) })
  }
  return items
}
