import { Menu } from 'electron'
import { blockerMenuTemplate, type BlockerMenuDeps } from './blocker-menu-items.js'

/**
 * Turns the template into a menu.
 *
 * Separate from `blocker-menu-items.ts` because `Menu` cannot be loaded outside a browser process, so
 * anything sharing a file with it is unreachable from a unit test. Same split as the tab and page menus.
 */
export function buildBlockerMenu(deps: BlockerMenuDeps): Menu {
  return Menu.buildFromTemplate(blockerMenuTemplate(deps))
}

export type { BlockerMenuDeps }
