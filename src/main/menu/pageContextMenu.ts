import { Menu } from 'electron'
import { pageContextMenuTemplate, type PageContextMenuDeps } from './page-context-items.js'

/**
 * Turns the template into a menu.
 *
 * Four lines, and separate from `page-context-items.ts` for one reason: `Menu` cannot be loaded outside a
 * browser process, so anything sharing a file with it is unreachable from a unit test. The decisions about
 * *which* items appear live next door where they are tested; this holds only the call that needs Electron,
 * and the smoke test covers it instead.
 */
export function buildPageContextMenu(deps: PageContextMenuDeps): Menu {
  return Menu.buildFromTemplate(pageContextMenuTemplate(deps))
}

export type { PageContextMenuDeps }
