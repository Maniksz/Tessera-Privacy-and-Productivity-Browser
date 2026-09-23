import type { DownloadAction } from '@shared/downloads/presentation.js'
import type { IconName } from './Icon.js'

/**
 * The icon each download action's button shows.
 *
 * One table for the page and the panel, because both draw the same buttons and one action that
 * looked different in the two places would read as two different actions. The button's name is its
 * translated `aria-label`; the icon is only the picture.
 *
 * Here rather than beside `DownloadAction` in `shared`: the names belong to the renderer's icon set,
 * and `shared` does not import from the renderer.
 */
export const DOWNLOAD_ACTION_ICONS: Readonly<Record<DownloadAction, IconName>> = {
  open: 'open-file',
  reveal: 'folder',
  pause: 'pause',
  resume: 'play',
  cancel: 'stop',
  remove: 'close'
}
