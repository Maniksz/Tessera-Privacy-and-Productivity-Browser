import { Menu } from 'electron'
import { tabContextMenuTemplate, type TabContextMenuDeps } from './tab-context-items.js'

/**
 * Turns the template into a menu.
 *
 * Four lines, and separate from `tab-context-items.ts` for one reason: `Menu` cannot be loaded outside
 * a browser process, so anything sharing a file with it is unreachable from a unit test. The decisions
 * about *which* items appear live next door, where they are tested; this holds only the call that
 * needs Electron and is therefore covered by the smoke test instead.
 */
export function buildTabContextMenu(deps: TabContextMenuDeps): Menu {
  return Menu.buildFromTemplate(tabContextMenuTemplate(deps))
}

export type { TabContextMenuDeps }
