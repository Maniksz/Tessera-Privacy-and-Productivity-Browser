import { Menu, type BaseWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * Turns a tab's, a group chip's or a tiled view's entry's template into a menu over the window it was
 * asked from.
 *
 * Four lines, and separate from `tab-context-items.ts` for one reason: `Menu` cannot be loaded outside
 * a browser process, so anything sharing a file with it is unreachable from a unit test. The decisions
 * about *which* items appear live next door, where they are tested; the channels that ask for either
 * menu are in `ipc/tabgroup-handlers.ts`, which is handed this function rather than importing it and is
 * tested for the same reason. This holds only the call that needs Electron and is therefore covered by
 * the smoke test instead.
 *
 * An empty template opens nothing. The chip's menu answers one for a group that went between the
 * strip drawing its chip and the right-click arriving, and an empty native menu is a flicker at the
 * pointer with nothing in it. The entry's menu (`arrangement-items.ts`, `ipc/arrangement-handlers.ts`)
 * comes through here too, for the same reasons.
 */
export function popupTabMenu(template: MenuItemConstructorOptions[], window: BaseWindow): void {
  if (template.length === 0) return
  Menu.buildFromTemplate(template).popup({ window })
}
