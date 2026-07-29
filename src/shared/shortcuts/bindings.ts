import type { Platform } from '../model.js'
import type { MessageKey } from '../i18n/catalog.js'

/**
 * Keyboard bindings (spec 9).
 *
 * Three hand-maintained tables, deliberately not derived from one another.
 * Mechanically swapping Ctrl for Command produces collisions — tile switching
 * would land on Cmd+Alt+Arrow on macOS and clobber tab switching, which is why
 * macOS uses Ctrl+Alt+Arrow there instead.
 *
 * The first accelerator of an action is the primary binding shown in menus;
 * the rest are equivalent alternatives.
 */

export const SHORTCUT_ACTIONS = [
  // tabs & windows
  'newTab',
  'closeTab',
  'reopenClosedTab',
  'newWindow',
  'newPrivateWindow',
  'closeWindow',
  'nextTab',
  'previousTab',
  'lastTab',
  // navigation
  'back',
  'forward',
  'reload',
  'reloadIgnoringCache',
  'stop',
  'home',
  // view
  'focusAddressBar',
  'findInPage',
  'findNext',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'windowFullscreen',
  'print',
  'devTools',
  // data
  'addBookmark',
  'toggleBookmarksBar',
  'downloads',
  'history',
  'clearData',
  'settings',
  /** Arms the element picker for the active tile: the next click on the page writes a hiding rule. */
  'blockElement',
  // split view
  'splitLayout1',
  'splitLayout2',
  'splitLayout3',
  'splitLayout4',
  'tileLeft',
  'tileRight',
  'tileUp',
  'tileDown',
  'toggleTileMaximized',
  /**
   * Reveals the active tile's own navigation bar and puts the focus in it.
   *
   * The bar's other route is a hover, which is pointer-only — and spec 7 requires complete keyboard
   * operation, so this is not a convenience but the thing that makes the feature admissible.
   */
  'focusTileBar',
  /** Reader mode for the active tile. An accelerator only fires where a menu item declares it. */
  'readerMode',
  'escape'
] as const

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]

type Table = Readonly<Record<ShortcutAction, readonly string[]>>

/** Ctrl+1 … Ctrl+8 select a tab by position; generated to avoid eight rows. */
export const TAB_BY_INDEX_ACCELERATORS: Readonly<Record<Platform, readonly string[]>> = {
  win32: ['Control+1', 'Control+2', 'Control+3', 'Control+4', 'Control+5', 'Control+6', 'Control+7', 'Control+8'],
  linux: ['Control+1', 'Control+2', 'Control+3', 'Control+4', 'Control+5', 'Control+6', 'Control+7', 'Control+8'],
  darwin: ['Command+1', 'Command+2', 'Command+3', 'Command+4', 'Command+5', 'Command+6', 'Command+7', 'Command+8']
}

const windowsTable = {
  newTab: ['Control+T'],
  closeTab: ['Control+W'],
  reopenClosedTab: ['Control+Shift+T'],
  newWindow: ['Control+N'],
  newPrivateWindow: ['Control+Shift+N'],
  closeWindow: ['Alt+F4'],
  nextTab: ['Control+Tab', 'Control+PageDown'],
  previousTab: ['Control+Shift+Tab', 'Control+PageUp'],
  lastTab: ['Control+9'],

  back: ['Alt+Left'],
  forward: ['Alt+Right'],
  reload: ['F5', 'Control+R'],
  reloadIgnoringCache: ['Control+F5', 'Control+Shift+R'],
  stop: ['Escape'],
  home: ['Alt+Home'],

  focusAddressBar: ['Control+L', 'Alt+D', 'F6'],
  findInPage: ['Control+F'],
  findNext: ['F3'],
  /*
    `=` as well as `Plus`, and it is the one that actually gets pressed.

    `Plus` is the *shifted* key on every layout this ships to, so `Control+Plus` means Ctrl+Shift+=.
    Zoom out kept working because `-` is unshifted, and that asymmetry is what the bug report looked
    like: minus zooms, plus does nothing. Chrome and Firefox both bind the unshifted key for exactly
    this reason. `Plus` stays first because `accel()` hands the first binding to the menu, and the
    menu should print what the keycap says.
  */
  zoomIn: ['Control+Plus', 'Control+=', 'Control+numadd'],
  zoomOut: ['Control+-', 'Control+numsub'],
  zoomReset: ['Control+0'],
  windowFullscreen: ['F11'],
  print: ['Control+P'],
  devTools: ['F12', 'Control+Shift+I'],

  addBookmark: ['Control+D'],
  toggleBookmarksBar: ['Control+Shift+B'],
  downloads: ['Control+J'],
  history: ['Control+H'],
  clearData: ['Control+Shift+Delete'],
  settings: ['Control+,'],
  blockElement: ['Control+Shift+E'],

  splitLayout1: ['Control+Shift+1'],
  splitLayout2: ['Control+Shift+2'],
  splitLayout3: ['Control+Shift+3'],
  splitLayout4: ['Control+Shift+4'],
  tileLeft: ['Control+Alt+Left'],
  tileRight: ['Control+Alt+Right'],
  tileUp: ['Control+Alt+Up'],
  tileDown: ['Control+Alt+Down'],
  toggleTileMaximized: ['Control+Shift+Return'],
  focusTileBar: ['Control+Shift+L'],
  readerMode: ['Control+Alt+R'],
  escape: ['Escape']
} as const satisfies Table

/**
 * Linux mirrors Windows for the familiar bindings, which is what users of both
 * expect — but the tile-switching row is a known casualty of desktop
 * environments, flagged below rather than silently broken.
 */
const linuxTable = {
  ...windowsTable,
  closeWindow: ['Control+Shift+W']
} as const satisfies Table

const macTable = {
  newTab: ['Command+T'],
  closeTab: ['Command+W'],
  reopenClosedTab: ['Command+Shift+T'],
  newWindow: ['Command+N'],
  newPrivateWindow: ['Command+Shift+N'],
  closeWindow: ['Command+Shift+W'],
  nextTab: ['Control+Tab', 'Command+Alt+Right'],
  previousTab: ['Control+Shift+Tab', 'Command+Alt+Left'],
  lastTab: ['Command+9'],

  back: ['Command+['],
  forward: ['Command+]'],
  reload: ['Command+R'],
  reloadIgnoringCache: ['Command+Shift+R'],
  stop: ['Command+.', 'Escape'],
  home: ['Command+Shift+H'],

  focusAddressBar: ['Command+L'],
  findInPage: ['Command+F'],
  findNext: ['Command+G'],
  // See the PC table: `Command+Plus` is ⌘⇧=, and ⌘= is what a Mac user presses.
  zoomIn: ['Command+Plus', 'Command+='],
  zoomOut: ['Command+-'],
  zoomReset: ['Command+0'],
  /*
    `Control+Command+F` first, because it is what every other macOS application uses and what the
    menu should therefore show. `F11` is here as well because people arrive from Windows with it in
    their hands — and on a Mac it costs nothing to answer to both.
  */
  windowFullscreen: ['Control+Command+F', 'F11'],
  print: ['Command+P'],
  devTools: ['Command+Alt+I'],

  addBookmark: ['Command+D'],
  toggleBookmarksBar: ['Command+Shift+B'],
  downloads: ['Command+Shift+J'],
  history: ['Command+Y'],
  clearData: ['Command+Shift+Backspace'],
  settings: ['Command+,'],
  blockElement: ['Command+Shift+E'],

  splitLayout1: ['Command+Shift+1'],
  splitLayout2: ['Command+Shift+2'],
  splitLayout3: ['Command+Shift+3'],
  splitLayout4: ['Command+Shift+4'],
  // Deliberately Ctrl+Alt, not Cmd+Alt: Cmd+Alt+Arrow is tab switching above,
  // and bare Ctrl+Arrow belongs to macOS window management.
  tileLeft: ['Control+Alt+Left'],
  tileRight: ['Control+Alt+Right'],
  tileUp: ['Control+Alt+Up'],
  tileDown: ['Control+Alt+Down'],
  toggleTileMaximized: ['Command+Shift+Return'],
  focusTileBar: ['Command+Shift+L'],
  readerMode: ['Command+Alt+R'],
  escape: ['Escape']
} as const satisfies Table

export const DEFAULT_BINDINGS: Readonly<Record<Platform, Table>> = {
  win32: windowsTable,
  linux: linuxTable,
  darwin: macTable
}

/**
 * Combinations the OS is known to intercept before the application sees them
 * (spec 9). The settings page must show the note and the alternative rather
 * than presenting a binding that appears set but never fires.
 *
 * Nothing in production reads this table today, and deleting it on that ground would be the
 * wrong call twice over. The `shortcuts:getBindings` channel that used to translate it fed no
 * renderer at all and was removed rather than kept warm — but what the table *holds* is not
 * code, it is knowledge that cannot be rediscovered by reading any of this: that GNOME, KDE
 * and Xfce all take Ctrl+Alt+Arrow, and what to offer in its place. Two tests hold it to being
 * true rather than merely present, which is why it can wait without rotting:
 * `ipc-contract.test.ts` refuses a default binding that sits on an accelerator flagged here,
 * and `shortcut-format.test.ts` requires every `alternative` to be a key the formatter can
 * print for a person.
 *
 * `messageKey` stays for the same reason. Without it the table would record *that* a binding is
 * swallowed and nothing about what anyone would be told, and the three `shortcuts.conflict.*`
 * catalogue entries would be orphaned — this is their only reference, and it is a typed one, so
 * removing a key here is the only thing that would let those sentences be deleted by accident.
 */
export interface KnownConflict {
  accelerator: string
  messageKey: MessageKey
  alternative: string
}

export const KNOWN_CONFLICTS: Readonly<Record<Platform, readonly KnownConflict[]>> = {
  linux: [
    // GNOME, KDE and Xfce all bind these to workspace switching by default.
    { accelerator: 'Control+Alt+Left', messageKey: 'shortcuts.conflict.linuxWorkspace', alternative: 'Control+Alt+H' },
    { accelerator: 'Control+Alt+Right', messageKey: 'shortcuts.conflict.linuxWorkspace', alternative: 'Control+Alt+L' },
    { accelerator: 'Control+Alt+Up', messageKey: 'shortcuts.conflict.linuxWorkspace', alternative: 'Control+Alt+K' },
    { accelerator: 'Control+Alt+Down', messageKey: 'shortcuts.conflict.linuxWorkspace', alternative: 'Control+Alt+J' }
  ],
  darwin: [
    { accelerator: 'Control+Left', messageKey: 'shortcuts.conflict.macosMissionControl', alternative: 'Control+Alt+Left' },
    { accelerator: 'Control+Right', messageKey: 'shortcuts.conflict.macosMissionControl', alternative: 'Control+Alt+Right' },
    { accelerator: 'Control+Up', messageKey: 'shortcuts.conflict.macosMissionControl', alternative: 'Control+Alt+Up' },
    { accelerator: 'Control+Down', messageKey: 'shortcuts.conflict.macosMissionControl', alternative: 'Control+Alt+Down' }
  ],
  win32: [
    {
      accelerator: 'Control+Shift+Left',
      messageKey: 'shortcuts.conflict.windowsTextSelection',
      alternative: 'Control+Alt+Left'
    },
    {
      accelerator: 'Control+Shift+Right',
      messageKey: 'shortcuts.conflict.windowsTextSelection',
      alternative: 'Control+Alt+Right'
    }
  ]
}

/** Primary accelerator for an action, after applying user overrides. */
export function acceleratorFor(
  platform: Platform,
  action: ShortcutAction,
  overrides: Readonly<Record<string, string>> = {}
): string {
  const override = overrides[action]
  if (override) return override
  return DEFAULT_BINDINGS[platform][action][0] ?? ''
}

export function allAcceleratorsFor(
  platform: Platform,
  action: ShortcutAction,
  overrides: Readonly<Record<string, string>> = {}
): readonly string[] {
  const override = overrides[action]
  if (override) return [override]
  return DEFAULT_BINDINGS[platform][action]
}

export interface BindingConflict {
  accelerator: string
  actions: ShortcutAction[]
}

/**
 * Finds accelerators bound to more than one action, so the settings page can
 * refuse a duplicate assignment instead of leaving two actions fighting over
 * one key (spec 9).
 */
export function findBindingConflicts(
  platform: Platform,
  overrides: Readonly<Record<string, string>> = {}
): BindingConflict[] {
  const byAccelerator = new Map<string, ShortcutAction[]>()
  for (const action of SHORTCUT_ACTIONS) {
    for (const accelerator of allAcceleratorsFor(platform, action, overrides)) {
      if (accelerator === '') continue
      const existing = byAccelerator.get(accelerator)
      if (existing) existing.push(action)
      else byAccelerator.set(accelerator, [action])
    }
  }

  const conflicts: BindingConflict[] = []
  for (const [accelerator, actions] of byAccelerator) {
    // `Escape` is intentionally shared between `stop` and `escape`: which one
    // applies depends on whether a load is in flight, and the window resolves
    // that at press time.
    if (accelerator === 'Escape') continue
    if (actions.length > 1) conflicts.push({ accelerator, actions })
  }
  return conflicts
}
