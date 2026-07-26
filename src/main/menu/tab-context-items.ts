import type { MenuItemConstructorOptions } from 'electron'
import { translate, type Locale, type MessageKey } from '@shared/i18n/catalog.js'
import { groupOfTab, type TabGroup } from '@shared/tabgroups/model.js'
import { TAB_GROUP_COLORS, type TabGroupColor } from '@shared/tabgroups/palette.js'

/**
 * The menu a right-click on a tab opens.
 *
 * A **native** menu, and this is the one place in this project where that is the right answer rather
 * than the tempting one. The layout picker is drawn on the overlay layer because it needs custom
 * graphics — nine little diagrams of tile arrangements — and a native menu cannot show those. This
 * menu is plain text items, so a native menu costs nothing in design and gains three things a DOM one
 * cannot have here: it is genuinely above every native view, it is what the platform's assistive
 * technology already knows how to read, and it dismisses the way the user's other applications do.
 *
 * Renaming is deliberately absent. A native menu has no text field, and the alternatives — a modal
 * dialogue, or a second overlay surface — are both heavier than the answer the strip already affords:
 * double-clicking a group's chip turns its label into an input. That lives in `TabBar.tsx`.
 *
 * Built fresh on every right-click rather than kept and patched. The items depend on this tab's
 * membership and on which groups exist, both of which change constantly; a cached menu is a menu
 * offering "add to group Work" after Work is gone.
 *
 * ## Why the template is separate from the menu
 *
 * `Menu.buildFromTemplate` is the one line here that needs Electron, and it is a line with no decision
 * in it. Everything else *is* decisions — which items a grouped tab gets that an ungrouped one does
 * not, which colour shows as checked, how an unnamed group is identified — and each of those can be
 * wrong in a way that still produces a perfectly ordinary-looking menu. Kept in this file they are
 * ordinary unit tests; kept next to the `Menu` import they would be unreachable from a test at all.
 * `tabContextMenu.ts` is the four-line wrapper.
 */

export interface TabContextMenuDeps {
  locale: Locale
  tabId: string
  groups: readonly TabGroup[]
  /** Every tab id in the window, so "group with the others" can be offered meaningfully. */
  onCreateGroup(tabIds: readonly string[], color?: TabGroupColor): void
  onAddToGroup(groupId: string, tabId: string): void
  onRemoveFromGroup(tabId: string): void
  onRecolor(groupId: string, color: TabGroupColor): void
  onDissolve(groupId: string): void
  onCloseTab(tabId: string): void
  onSetPinned(tabId: string, pinned: boolean): void
  isPinned(tabId: string): boolean
}

/** A colour's own name, so the submenu reads as colours rather than as eight identical rows. */
const COLOR_LABELS: Readonly<Record<TabGroupColor, MessageKey>> = {
  blue: 'tabgroup.color.blue',
  cyan: 'tabgroup.color.cyan',
  green: 'tabgroup.color.green',
  yellow: 'tabgroup.color.yellow',
  orange: 'tabgroup.color.orange',
  red: 'tabgroup.color.red',
  pink: 'tabgroup.color.pink',
  grey: 'tabgroup.color.grey'
}

export function tabContextMenuTemplate(
  deps: TabContextMenuDeps
): MenuItemConstructorOptions[] {
  const t = (key: MessageKey, params?: Record<string, string | number>): string =>
    translate(deps.locale, key, params)

  const own = groupOfTab(deps.groups, deps.tabId)
  const others = deps.groups.filter((group) => group.id !== own?.id)

  const template: MenuItemConstructorOptions[] = [
    {
      label: t('tabgroup.new'),
      click: () => deps.onCreateGroup([deps.tabId])
    }
  ]

  if (others.length > 0) {
    template.push({
      label: t('tabgroup.addTo'),
      submenu: others.map((group) => ({
        // An unnamed group would be a blank row; its colour is the only thing identifying it.
        label: group.name === '' ? t(COLOR_LABELS[group.color]) : group.name,
        click: () => deps.onAddToGroup(group.id, deps.tabId)
      }))
    })
  }

  if (own !== undefined) {
    template.push(
      { label: t('tabgroup.removeTab'), click: () => deps.onRemoveFromGroup(deps.tabId) },
      {
        label: t('tabgroup.recolor'),
        submenu: TAB_GROUP_COLORS.map((color) => ({
          label: t(COLOR_LABELS[color]),
          // A radio rather than a plain item, so the group's current colour is visible without
          // having to remember it.
          type: 'radio' as const,
          checked: own.color === color,
          click: () => deps.onRecolor(own.id, color)
        }))
      },
      { label: t('tabgroup.dissolve'), click: () => deps.onDissolve(own.id) }
    )
  }

  const pinned = deps.isPinned(deps.tabId)
  template.push(
    { type: 'separator' },
    {
      label: t(pinned ? 'tab.unpin' : 'tab.pin'),
      click: () => deps.onSetPinned(deps.tabId, !pinned)
    },
    { label: t('tab.close'), click: () => deps.onCloseTab(deps.tabId) }
  )

  return template
}
