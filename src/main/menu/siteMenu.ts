import { Menu, type BaseWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * Turns the site menu's template into a menu over the window it was asked from.
 *
 * Separate from `site-menu-items.ts` because `Menu` cannot be loaded outside a browser process, so
 * anything sharing a file with it is unreachable from a unit test. Same split as the tab and page menus;
 * it replaced `blockerMenu.ts` when the blocker's menu became part of this one (U19).
 */
export function popupSiteMenu(template: MenuItemConstructorOptions[], window: BaseWindow): void {
  Menu.buildFromTemplate(template).popup({ window })
}
