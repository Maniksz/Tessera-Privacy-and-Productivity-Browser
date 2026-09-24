import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import type { Locale } from '@shared/i18n/catalog.js'
import type { InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { tabGroupInvokeContract } from '@shared/tabgroups/schema.js'
import type { TabGroupController } from '../browser/TabGroupController.js'
import { tabContextMenuTemplate, tabGroupMenuTemplate } from '../menu/tab-context-items.js'

/**
 * The `tabgroups:*` channels and the two menus they are reached through: a tab's, and a group chip's.
 *
 * ## Why this is not in `handlers.ts`
 *
 * For `site-handlers.ts`'s reasons: that file may only gain call sites (KTD21) and imports the router,
 * so nothing in it can be tested — and the chip's menu was a channel it would otherwise have gained.
 * Handed the registrar, the windows and the way to put a menu up, this is an ordinary function a test
 * drives against a fake window.
 *
 * ## What resolves what
 *
 * Every one of these resolves the *sending window* and acts on its groups.
 *
 * A group is window state: it decides which tabs the strip draws and which of them may hold a tile.
 * Taking a window id in the request instead would let one window fold away another window's tabs,
 * and the sender is the only source a renderer cannot lie about. Same rule as the tab handlers in
 * `handlers.ts`. A private window's groups are its own for the same reason: its controller is bound to
 * the book of its browsing mode, which discards.
 *
 * The store's errors — no such group, too many groups, a group with no tabs — travel back as
 * rejections rather than being swallowed, because each one is something the user did and can undo.
 *
 * ## The menus are built here, because this is where the locale lives
 *
 * Every action is a closure over the same controller the channels above use, so a menu item and a
 * keyboard-driven call cannot end up doing different things — which is exactly what a second code
 * path for the same operations would produce.
 */

type TabGroupChannel = keyof typeof tabGroupInvokeContract | 'tabs:contextMenu'

type TabGroupChannelContract = {
  [C in TabGroupChannel]: { request: InvokeHandlerArg<C>; response: InvokeResponse<C> }
}

/** The shape of `ipc/router.ts`'s `handle`, narrowed to these channels. See `MediaHandle`. */
export type TabGroupHandle = <C extends TabGroupChannel>(
  channel: C,
  handler: (
    payload: TabGroupChannelContract[C]['request'],
    event: IpcMainInvokeEvent
  ) => TabGroupChannelContract[C]['response']
) => void

/** One window, as far as its groups and its tab menu go. `BrowserWindowController` satisfies this. */
export interface TabGroupWindow {
  readonly groups: Pick<
    TabGroupController,
    | 'groups'
    | 'create'
    | 'rename'
    | 'recolor'
    | 'setCollapsed'
    | 'dissolve'
    | 'addTab'
    | 'removeTab'
  >
  closeTab(tabId: string): void
  setTabPinned(tabId: string, pinned: boolean): void
  resolveTab(tabId: string): { readonly pinned: boolean } | undefined
}

export interface TabGroupHandlerDeps<W extends TabGroupWindow> {
  /** `handle` from `ipc/router.ts`. See `TabGroupHandle` for why it is passed rather than imported. */
  readonly handle: TabGroupHandle
  readonly windows: { resolve(event: IpcMainInvokeEvent): W | undefined }
  /** Read per call, so a language change reaches the next menu rather than the next restart. */
  readonly locale: () => Locale
  /** `popupTabMenu` over the window, which needs Electron. An empty template opens nothing. */
  readonly showMenu: (template: MenuItemConstructorOptions[], window: W) => void
}

const OK = { ok: true } as const

export function registerTabGroupHandlers<W extends TabGroupWindow>(
  deps: TabGroupHandlerDeps<W>
): void {
  const { handle, windows } = deps

  handle('tabgroups:create', ({ tabIds, name, color }, event) => {
    const controller = windows.resolve(event)
    if (controller === undefined) throw new Error('no window for this sender')
    return controller.groups.create({
      tabIds,
      ...(name === undefined ? {} : { name }),
      ...(color === undefined ? {} : { color })
    })
  })

  handle('tabgroups:rename', ({ id, name }, event) => {
    windows.resolve(event)?.groups.rename(id, name)
    return OK
  })

  handle('tabgroups:recolor', ({ id, color }, event) => {
    windows.resolve(event)?.groups.recolor(id, color)
    return OK
  })

  handle('tabgroups:setCollapsed', ({ id, collapsed }, event) => {
    windows.resolve(event)?.groups.setCollapsed(id, collapsed)
    return OK
  })

  handle('tabgroups:dissolve', ({ id }, event) => {
    windows.resolve(event)?.groups.dissolve(id)
    return OK
  })

  handle('tabgroups:addTab', ({ groupId, tabId, index }, event) => {
    windows.resolve(event)?.groups.addTab(groupId, tabId, index)
    return OK
  })

  handle('tabgroups:removeTab', ({ tabId }, event) => {
    windows.resolve(event)?.groups.removeTab(tabId)
    return OK
  })

  handle('tabs:contextMenu', ({ tabId }, event) => {
    const controller = windows.resolve(event)
    if (controller === undefined) return OK
    const groups = controller.groups
    const template = tabContextMenuTemplate({
      locale: deps.locale(),
      tabId,
      groups: groups.groups(),
      onCreateGroup: (tabIds, color) => {
        groups.create({ tabIds, ...(color === undefined ? {} : { color }) })
      },
      onAddToGroup: (groupId, id) => groups.addTab(groupId, id),
      onRemoveFromGroup: (id) => groups.removeTab(id),
      onRecolor: (groupId, color) => groups.recolor(groupId, color),
      onDissolve: (groupId) => groups.dissolve(groupId),
      onCloseTab: (id) => controller.closeTab(id),
      onSetPinned: (id, pinned) => controller.setTabPinned(id, pinned),
      isPinned: (id) => controller.resolveTab(id)?.pinned === true
    })
    deps.showMenu(template, controller)
    return OK
  })

  /*
    The chip's menu, over the same controller. Dissolving from here is `tabgroups:dissolve` by another
    door: the tabs stay open and where they are, their tiles untouched, and nothing brings the group
    back — the tiling is recorded on its own carrier, which cannot make one (R1, R2).
  */
  handle('tabgroups:contextMenu', ({ id }, event) => {
    const controller = windows.resolve(event)
    if (controller === undefined) return OK
    const groups = controller.groups
    const template = tabGroupMenuTemplate({
      locale: deps.locale(),
      groupId: id,
      groups: groups.groups(),
      onRecolor: (groupId, color) => groups.recolor(groupId, color),
      onDissolve: (groupId) => groups.dissolve(groupId)
    })
    deps.showMenu(template, controller)
    return OK
  })
}
