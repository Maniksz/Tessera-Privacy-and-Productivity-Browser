import type { LayoutId } from './layout.js'
import type { MessageKey } from '../i18n/catalog.js'
import type { ShortcutAction } from '../shortcuts/bindings.js'

/**
 * What each split arrangement is called, and which shortcut reaches it.
 *
 * Shared because three surfaces need it: the toolbar button, the layout menu on the overlay
 * layer, and the application menu in the main process. The first two are renderers and the third
 * is not, so it cannot live with either.
 *
 * That split is not academic. The application menu used to spell its five entries out by hand,
 * and when two column layouts were added they were reachable from the toolbar and by dragging but
 * **not** from the menu — a feature that existed and could not be found. Both surfaces now walk
 * `LAYOUT_IDS`, so a new arrangement appears in every one of them or in none.
 *
 * Type-only imports throughout, so this stays free of runtime weight and of zod.
 */

export const LAYOUT_LABELS: Readonly<Record<LayoutId, MessageKey>> = {
  '1x1': 'menu.split.layout1',
  '1x2': 'menu.split.layout2Columns',
  '1x3': 'menu.split.layout3Columns',
  '1x4': 'menu.split.layout4Columns',
  '2x1': 'menu.split.layout2Rows',
  '2x2': 'menu.split.layout4',
  '1+2': 'menu.split.layout3'
}

/**
 * The arrangements that have a keyboard shortcut.
 *
 * Deliberately partial. Not every layout earns a chord — `2x1` never had one either — and
 * inventing four more would crowd out shortcuts users want for something else. Absent here means
 * "reachable from the menu and the toolbar", not "unreachable".
 */
export const LAYOUT_SHORTCUTS: Readonly<Partial<Record<LayoutId, ShortcutAction>>> = {
  '1x1': 'splitLayout1',
  '1x2': 'splitLayout2',
  '1+2': 'splitLayout3',
  '2x2': 'splitLayout4'
}
