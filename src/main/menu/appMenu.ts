import { Menu, app, type MenuItemConstructorOptions } from 'electron'
import { translate, type Locale, type MessageKey } from '@shared/i18n/catalog.js'
import { acceleratorFor, type ShortcutAction } from '@shared/shortcuts/bindings.js'
import { openReaderMode } from '../reader/reader-mode.js'
import type { Platform } from '@shared/model.js'
import { HOME_URL } from '@shared/url/omnibox.js'
import type { WindowRegistry } from '../browser/WindowRegistry.js'
import type { BrowserWindowController } from '../browser/BrowserWindowController.js'
import type { SettingsStore } from '../settings/SettingsStore.js'
import { internalUrl } from '@shared/product.js'
import { LAYOUT_IDS } from '@shared/split/layout.js'
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
          if (tab) tab.setZoomPercent(tab.zoomPercent + 10)
        }
      },
      {
        label: t('menu.view.zoomOut'),
        accelerator: accel('zoomOut'),
        click: () => {
          const tab = focused()?.activeTab()
          if (tab) tab.setZoomPercent(tab.zoomPercent - 10)
        }
      },
      {
        label: t('menu.view.zoomReset'),
        accelerator: accel('zoomReset'),
        click: () => focused()?.activeTab()?.setZoomPercent(settings.get('appearance.defaultZoom'))
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
        click: () => {
          const win = focused()?.window
          if (win) win.setFullScreen(!win.isFullScreen())
        }
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
      }
    ]
  }

  const helpMenu: MenuItemConstructorOptions = {
    label: t('menu.help'),
    role: 'help',
    submenu: [
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
  if (isMac) template.push(windowMenu)
  template.push(helpMenu)

  return Menu.buildFromTemplate(template)
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
