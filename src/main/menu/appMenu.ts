import { Menu, app, type MenuItemConstructorOptions } from 'electron'
import { translate, type Locale, type MessageKey } from '@shared/i18n/catalog.js'
import { acceleratorFor, type ShortcutAction } from '@shared/shortcuts/bindings.js'
import { withAlternativeAccelerators } from './alternative-accelerators.js'
import { tabPositionAccelerators } from './tab-position-accelerators.js'
import { openReaderMode } from '../reader/reader-mode.js'
import type { Platform } from '@shared/model.js'
import { HOME_URL } from '@shared/url/omnibox.js'
import type { WindowRegistry } from '../browser/WindowRegistry.js'
import type { BrowserWindowController } from '../browser/BrowserWindowController.js'
import type { SettingsStore } from '../settings/SettingsStore.js'
import { internalUrl } from '@shared/product.js'
import { LAYOUT_IDS } from '@shared/split/layout.js'
import { nextZoomPercent } from '@shared/gestures/zoom.js'
import { LAYOUT_LABELS, LAYOUT_SHORTCUTS } from '@shared/split/labels.js'

/**
 * Application menu (spec 10).
 *
 * A real menu matters beyond mouse users: assistive technology reads it to
 * discover what the application can do, so the usual entries have to exist even
 * when every one of them also has a shortcut.
 *
 * macOS gets the system-wide menu bar with the application menu first; Windows
 * and Linux get an in-window menu bar. Same commands either way — no feature is
 * reachable on one platform only (spec 10).
 */

export interface MenuDeps {
  windows: WindowRegistry
  settings: SettingsStore
  locale: Locale
  platform: Platform
  /**
   * Asks for an update check, now, because a person said so.
   *
   * A callback rather than the service itself, so this file keeps knowing nothing about updates —
   * and so the menu cannot reach the other things the service can do. `UpdateService.checkNow`
   * returns `void` and never rejects, which a menu handler needs: a promise nobody holds ends the
   * process when it rejects.
   */
  checkForUpdates: () => void
}

export function buildApplicationMenu(deps: MenuDeps): Menu {
  const { windows, settings, locale, platform } = deps
  const overrides = settings.get('advanced.customShortcuts')
  const t = (key: MessageKey): string => translate(locale, key)
  const accel = (action: ShortcutAction): string => acceleratorFor(platform, action, overrides)

  /** Runs a command against the window the user is actually looking at. */
  const focused = (): BrowserWindowController | undefined =>
    windows.focused() ?? windows.controllers[0]

  const isMac = platform === 'darwin'

  const fileMenu: MenuItemConstructorOptions = {
    label: t('menu.file'),
    submenu: [
      {
        label: t('menu.file.newTab'),
        accelerator: accel('newTab'),
        click: () => focused()?.createTab({})
      },
      {
        label: t('menu.file.newWindow'),
        accelerator: accel('newWindow'),
        click: () => windows.createWindow({ privateMode: false }).createTab({})
      },
      {
        label: t('menu.file.newPrivateWindow'),
        accelerator: accel('newPrivateWindow'),
        click: () => windows.createWindow({ privateMode: true }).createTab({})
      },
      { type: 'separator' },
      {
        label: t('menu.file.closeTab'),
        accelerator: accel('closeTab'),
        click: () => {
          const controller = focused()
          const tabId = controller?.split.activeTabId()
          if (controller && tabId !== null && tabId !== undefined) controller.closeTab(tabId)
        }
      },
      {
        label: t('menu.file.reopenClosedTab'),
        accelerator: accel('reopenClosedTab'),
        click: () => focused()?.reopenClosedTab()
      },
      { type: 'separator' },
      {
        label: t('menu.file.print'),
        accelerator: accel('print'),
        click: () => focused()?.activeTab()?.view.webContents.print()
      },
      { type: 'separator' },
      isMac
        ? { label: t('menu.file.closeWindow'), accelerator: accel('closeWindow'), role: 'close' }
        : { label: t('menu.file.quit'), accelerator: accel('closeWindow'), role: 'quit' }
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: t('menu.edit'),
    submenu: [
      // Roles, not custom handlers: the platform's own editing behaviour must
      // survive intact inside text fields (spec 9).
      { label: t('menu.edit.undo'), role: 'undo' },
      { label: t('menu.edit.redo'), role: 'redo' },
      { type: 'separator' },
      { label: t('menu.edit.cut'), role: 'cut' },
      { label: t('menu.edit.copy'), role: 'copy' },
      { label: t('menu.edit.paste'), role: 'paste' },
      { label: t('menu.edit.selectAll'), role: 'selectAll' },
      { type: 'separator' },
      {
        label: t('menu.edit.findInPage'),
        accelerator: accel('findInPage'),
        click: () => focused()?.emit('shortcut:triggered', { action: 'findInPage' })
      },
      {
        label: t('menu.edit.findNext'),
        accelerator: accel('findNext'),
        click: () => focused()?.emit('shortcut:triggered', { action: 'findNext' })
      },
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            {
              label: t('menu.edit.settings'),
              accelerator: accel('settings'),
              click: () => focused()?.emit('shortcut:triggered', { action: 'settings' })
            }
          ] satisfies MenuItemConstructorOptions[]))
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: t('menu.view'),
    submenu: [
      {
        label: t('menu.view.reload'),
        accelerator: accel('reload'),
        click: () => focused()?.activeTab()?.reload(false)
      },
      {
        label: t('menu.view.reloadIgnoringCache'),
        accelerator: accel('reloadIgnoringCache'),
        click: () => focused()?.activeTab()?.reload(true)
      },
      { type: 'separator' },
      {
        label: t('menu.view.zoomIn'),
        accelerator: accel('zoomIn'),
        click: () => {
          const tab = focused()?.activeTab()
          // The same ladder the pinch gesture walks. Two step sizes in one browser means zooming in
          // with the keyboard and out with the trackpad does not return to where it started.
          if (tab) tab.setZoomPercent(nextZoomPercent(tab.zoomPercent, 'in'))
        }
      },
      {
        label: t('menu.view.zoomOut'),
        accelerator: accel('zoomOut'),
        click: () => {
          const tab = focused()?.activeTab()
          if (tab) tab.setZoomPercent(nextZoomPercent(tab.zoomPercent, 'out'))
        }
      },
      {
        label: t('menu.view.zoomReset'),
        accelerator: accel('zoomReset'),
        // `resetZoom` rather than setting the number the setting holds right now: reset puts the
        // pane back to *following* `appearance.defaultZoom`, which is the state it was in before
        // anyone zoomed it and the only way back to it. See `PaneZoom`.
        click: () => focused()?.activeTab()?.resetZoom()
      },
      { type: 'separator' },
      {
        label: t('menu.view.bookmarksBar'),
        type: 'checkbox',
        checked: settings.get('appearance.showBookmarksBar'),
        accelerator: accel('toggleBookmarksBar'),
        click: (item) => settings.set('appearance.showBookmarksBar', item.checked)
      },
      { type: 'separator' },
      {
        label: t('menu.view.fullscreen'),
        accelerator: accel('windowFullscreen'),
        /*
          Through the window, not straight at `setFullScreen`.

          In a split layout with the fullscreen scope set to the tile — the default — the window is
          deliberately not fullscreenable, so `setFullScreen` was ignored and the key did nothing at
          all. Which of the two things the key means is a decision about the layout, and it lives with
          the rest of them in `TileFullscreenController`.
        */
        click: () => focused()?.toggleFullscreen()
      },
      { type: 'separator' },
      /*
        The address bar, which had a shortcut and no way to fire it.

        `Ctrl+L`, `Alt+D` and `F6` were all in the binding table, appeared in the settings list, and did
        nothing at all — because an accelerator only exists where a menu item declares it. A fitness test now
        holds every action to having one.
      */
      {
        label: t('menu.view.focusAddressBar'),
        accelerator: accel('focusAddressBar'),
        click: () => focused()?.emit('shortcut:triggered', { action: 'focusAddressBar' })
      },
      /*
        "Block element" needs a menu item even though the context menu is where people will find it.

        An accelerator only fires if a menu item declares it, so a shortcut with no item is a shortcut that
        compiles, appears in the settings list, and does nothing. This item is what makes `Ctrl+Shift+E` real —
        and it is also the discoverable route for somebody who never opens a context menu.
      */
      {
        label: t('menu.view.focusTileBar'),
        accelerator: accel('focusTileBar'),
        click: () => focused()?.requestTileBar({ invokedBy: 'keyboard', tileIndex: focused()?.split.activeTile ?? 0 })
      },
      {
        label: t('reader.title'),
        accelerator: accel('readerMode'),
        click: () => openReaderMode(focused())
      },
      {
        label: t('page.blockElement'),
        accelerator: accel('blockElement'),
        click: () => focused()?.emit('shortcut:triggered', { action: 'blockElement' })
      },
      {
        label: t('menu.view.devTools'),
        accelerator: accel('devTools'),
        click: () => focused()?.activeTab()?.toggleDevTools()
      }
    ]
  }

  const historyMenu: MenuItemConstructorOptions = {
    label: t('menu.history'),
    submenu: [
      {
        label: t('menu.history.back'),
        accelerator: accel('back'),
        click: () => focused()?.activeTab()?.goBack()
      },
      {
        label: t('menu.history.forward'),
        accelerator: accel('forward'),
        click: () => focused()?.activeTab()?.goForward()
      },
      { type: 'separator' },
      {
        label: t('menu.history.home'),
        accelerator: accel('home'),
        click: () => focused()?.activeTab()?.loadUrl(HOME_URL)
      },
      {
        label: t('menu.history.showAll'),
        accelerator: accel('history'),
        click: () => focused()?.createTab({ url: internalUrl('history') })
      }
    ]
  }

  const bookmarksMenu: MenuItemConstructorOptions = {
    label: t('menu.bookmarks'),
    submenu: [
      {
        label: t('menu.bookmarks.add'),
        accelerator: accel('addBookmark'),
        click: () => focused()?.emit('shortcut:triggered', { action: 'addBookmark' })
      },
      {
        label: t('menu.bookmarks.manage'),
        click: () => focused()?.createTab({ url: internalUrl('bookmarks') })
      }
    ]
  }

  const splitMenu: MenuItemConstructorOptions = {
    label: t('menu.split'),
    submenu: [
      /*
        Generated from `LAYOUT_IDS` rather than listed.

        Five entries used to be spelled out here, and when two column layouts arrived they were
        reachable from the toolbar and by dragging but not from this menu — a feature that existed
        and could not be found. Walking the list means a new arrangement cannot be added to one
        surface and forgotten in the other.
      */
      ...LAYOUT_IDS.map((layout) => {
        const shortcut = LAYOUT_SHORTCUTS[layout]
        return {
          label: t(LAYOUT_LABELS[layout]),
          // Absent means menu-only, not unreachable; see `LAYOUT_SHORTCUTS`.
          ...(shortcut === undefined ? {} : { accelerator: accel(shortcut) }),
          click: () => focused()?.setLayout(layout)
        }
      }),
      { type: 'separator' },
      {
        label: t('menu.split.tileLeft'),
        accelerator: accel('tileLeft'),
        click: () => focused()?.moveActiveTile('left')
      },
      {
        label: t('menu.split.tileRight'),
        accelerator: accel('tileRight'),
        click: () => focused()?.moveActiveTile('right')
      },
      {
        label: t('menu.split.tileUp'),
        accelerator: accel('tileUp'),
        click: () => focused()?.moveActiveTile('up')
      },
      {
        label: t('menu.split.tileDown'),
        accelerator: accel('tileDown'),
        click: () => focused()?.moveActiveTile('down')
      },
      { type: 'separator' },
      {
        label: t('menu.split.maximizeTile'),
        accelerator: accel('toggleTileMaximized'),
        click: () => focused()?.toggleTileMaximized()
      }
    ]
  }

  const toolsMenu: MenuItemConstructorOptions = {
    label: t('menu.tools'),
    submenu: [
      {
        label: t('menu.tools.downloads'),
        accelerator: accel('downloads'),
        click: () => focused()?.createTab({ url: internalUrl('downloads') })
      },
      {
        label: t('menu.tools.passwords'),
        click: () => focused()?.createTab({ url: internalUrl('passwords') })
      },
      { type: 'separator' },
      /*
        Settings and extensions as tabs, alongside the panels that Ctrl+, and the toolbar open.

        Both entry points exist by choice — a panel is one click away, a tab can be zoomed, linked to,
        and put in a split tile, which a surface drawn over the window never can. They render the same
        component (`SettingsView`, `ExtensionsView`), so having two ways in costs nothing but these two
        menu items.
      */
      {
        label: t('menu.tools.settingsTab'),
        click: () => focused()?.createTab({ url: internalUrl('settings') })
      },
      {
        label: t('menu.tools.extensionsTab'),
        click: () => focused()?.createTab({ url: internalUrl('extensions') })
      },
      { type: 'separator' },
      {
        label: t('menu.tools.clearData'),
        accelerator: accel('clearData'),
        click: () => focused()?.emit('shortcut:triggered', { action: 'clearData' })
      },
      {
        label: t('menu.tools.panic'),
        click: () => focused()?.emit('shortcut:triggered', { action: 'panic' })
      }
    ]
  }

  const windowMenu: MenuItemConstructorOptions = {
    label: t('menu.window'),
    submenu: [
      { label: t('menu.window.minimize'), role: 'minimize' },
      ...(isMac ? ([{ label: t('menu.window.zoom'), role: 'zoom' }] satisfies MenuItemConstructorOptions[]) : []),
      { type: 'separator' },
      {
        label: t('menu.window.nextTab'),
        accelerator: accel('nextTab'),
        click: () => focused()?.emit('shortcut:triggered', { action: 'nextTab' })
      },
      {
        label: t('menu.window.previousTab'),
        accelerator: accel('previousTab'),
        click: () => focused()?.emit('shortcut:triggered', { action: 'previousTab' })
      },
      /*
        `Ctrl+1`…`Ctrl+8` and `Ctrl+9`, as nine hidden items.

        Here rather than nowhere because an accelerator only fires where a menu item declares it, and
        hidden because "Tab 3" is not an entry a menu can meaningfully name. Beside next and previous
        tab because that is what they are: the same feature reached by position instead of by step.
        See `tab-position-accelerators.ts` for why the eight cannot be rebound and what that costs.
      */
      ...tabPositionAccelerators({
        platform,
        lastTabAccelerator: accel('lastTab'),
        select: (position) => focused()?.activateTabAtStripPosition(position)
      })
    ]
  }

  const helpMenu: MenuItemConstructorOptions = {
    label: t('menu.help'),
    role: 'help',
    submenu: [
      /*
        The only way to ask for an update check on purpose.

        No accelerator, and none in the binding table either — this is the direction that is fine: the
        fitness test in `tests/architecture.test.ts` holds every `ShortcutAction` to *having* an item,
        because an accelerator without one is a key that silently does nothing. An item without a key
        is just a menu item.

        Deliberately not the settings screen and not a button in the chrome: a check is the one update
        operation that takes no argument and needs no state, and the menu is where every other browser
        puts it. There is no IPC channel for it either, which is what keeps a web page from being able
        to make this browser talk to GitHub — see `UpdateService`.
      */
      {
        label: t('updates.checkNow'),
        click: () => deps.checkForUpdates()
      },
      { type: 'separator' },
      {
        label: t('menu.help.about'),
        click: () => focused()?.createTab({ url: internalUrl('about') })
      }
    ]
  }

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    // macOS expects the application menu first, with Settings and Quit in it.
    template.push({
      label: app.name,
      submenu: [
        { label: t('menu.help.about'), click: () => focused()?.createTab({ url: internalUrl('about') }) },
        { type: 'separator' },
        {
          label: t('menu.edit.settings'),
          accelerator: accel('settings'),
          click: () => focused()?.emit('shortcut:triggered', { action: 'settings' })
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: t('menu.file.quit'), role: 'quit' }
      ]
    })
  }

  template.push(fileMenu, editMenu, viewMenu, historyMenu, bookmarksMenu, splitMenu, toolsMenu)
  /*
    On every platform, not only macOS.

    This used to be `if (isMac)`, and the two items inside it that are not roles — next tab and previous
    tab — were therefore the only route by which `Control+Tab` and `Control+Shift+Tab` were registered.
    So on Windows and Linux those keys did nothing at all, while the settings screen listed them and the
    renderer sat waiting for the action they never sent. That contradicts the rule stated at the top of
    this file: no feature reachable on one platform only (spec 10).

    A Window menu is unremarkable on Windows and Linux — every browser has one — and the one item in it
    that really is macOS-only, the `zoom` role, is already gated inside.
  */
  template.push(windowMenu)
  template.push(helpMenu)

  // The second key of every action that has one, as a hidden sibling of the item carrying the first.
  // Without this the whole right-hand side of the binding table is decoration; see there.
  return Menu.buildFromTemplate(withAlternativeAccelerators(template, platform, overrides))
}

export function installApplicationMenu(deps: MenuDeps): void {
  const menu = buildApplicationMenu(deps)
  if (deps.platform === 'darwin') {
    Menu.setApplicationMenu(menu)
  } else {
    // In-window menu bar on Windows and Linux (spec 10).
    Menu.setApplicationMenu(menu)
  }
}
