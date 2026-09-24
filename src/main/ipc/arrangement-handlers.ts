import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import type { Locale } from '@shared/i18n/catalog.js'
import type { InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { arrangementInvokeContract } from '@shared/arrangements/schema.js'
import type { LayoutId } from '@shared/split/layout.js'
import type { ArrangementController } from '../browser/ArrangementController.js'
import type { SplitController } from '../browser/SplitController.js'
import type { TabGroupController } from '../browser/TabGroupController.js'
import type { TileOccupancyController } from '../browser/TileOccupancyController.js'
import { arrangementMenuTemplate } from '../menu/arrangement-items.js'

/**
 * The `arrangements:*` channels and the entry's menu: what a tiled view's entry in the tab strip can
 * do (U6, R4–R7).
 *
 * Out of `handlers.ts` for `tabgroup-handlers.ts`'s reasons: that file may only gain call sites, and
 * handed the registrar, the windows and the way to put a menu up, this is an ordinary function a test
 * drives against a fake window. Every channel resolves the *sending* window, the only source a
 * renderer cannot lie about, and acts on that window's views alone (R16).
 *
 * ## The order of the steps is the point
 *
 * Each operation is one or two calls, and which comes first is what makes it right:
 *
 *   - **Change Layout** on a view that is put away brings it back *first* (KTD12): a layout only
 *     changes on screen, through the same `setLayout` the toolbar uses, so the start pages a smaller
 *     layout closes are chosen by the same rule (R8).
 *   - **End Tiled View** on the view on screen is choosing the single layout; on one that is put away
 *     it runs off screen (`ArrangementController.endArrangement`), and the view on screen stays.
 *   - **Close All Tabs** dissolves the view *before* the first tab is asked (KTD13), so a page that
 *     asks to stay is brought forward as the ordinary tab it then is, rather than bringing its view
 *     back; and the view on screen is put away first, so no close pulls a page in or closes ranks.
 *   - **The speaker** writes the same per-tile mute either way (KTD11): through the tiles for the view
 *     on screen, into the record and onto the tabs for one that is put away.
 *   - **Release**, from a tile bar: the entry lets go of the tab before the panes close ranks (U10).
 */

type ArrangementChannel = keyof typeof arrangementInvokeContract

type ArrangementChannelContract = {
  [C in ArrangementChannel]: { request: InvokeHandlerArg<C>; response: InvokeResponse<C> }
}

/** The shape of `ipc/router.ts`'s `handle`, narrowed to these channels. See `TabGroupHandle`. */
export type ArrangementHandle = <C extends ArrangementChannel>(
  channel: C,
  handler: (
    payload: ArrangementChannelContract[C]['request'],
    event: IpcMainInvokeEvent
  ) => ArrangementChannelContract[C]['response']
) => void

/** One window, as far as its tiled views go. `BrowserWindowController` satisfies this. */
export interface ArrangementWindow {
  readonly arrangements: Pick<
    ArrangementController,
    'liveId' | 'summaries' | 'restore' | 'endArrangement' | 'dissolve' | 'setMuted' | 'releaseTab'
  >
  readonly groups: Pick<TabGroupController, 'groups' | 'create' | 'addTab' | 'removeTab'>
  readonly split: Pick<SplitController, 'layout' | 'tileCount' | 'activeTabId' | 'tabIdAt'>
  readonly occupancy: Pick<TileOccupancyController, 'afterTabClosed' | 'releaseTab'>
  setLayout(layout: LayoutId): void
  setTileMuted(tileIndex: number, muted: boolean): void
  activateTab(tabId: string): void
  closeTab(tabId: string): void
  resolveTab(tabId: string): { setMuted(muted: boolean): void } | undefined
  /**
   * Schedules the window's broadcast round, for a change that moved nothing on screen and closed
   * nothing — ending a put-away view whose tiles held no start page — so the strip still hears the
   * entry went.
   */
  publish(): void
}

export interface ArrangementHandlerDeps<W extends ArrangementWindow> {
  /** `handle` from `ipc/router.ts`, passed rather than imported; see `ArrangementHandle`. */
  readonly handle: ArrangementHandle
  readonly windows: { resolve(event: IpcMainInvokeEvent): W | undefined }
  /** Read per call, so a language change reaches the next menu rather than the next restart. */
  readonly locale: () => Locale
  /** `popupTabMenu` over the window, which needs Electron. */
  readonly showMenu: (template: MenuItemConstructorOptions[], window: W) => void
}

const OK = { ok: true } as const

export function registerArrangementHandlers<W extends ArrangementWindow>(
  deps: ArrangementHandlerDeps<W>
): void {
  const { handle, windows } = deps

  handle('arrangements:activate', ({ id }, event) => {
    const window = windows.resolve(event)
    if (window !== undefined) bringBack(window, id)
    return OK
  })

  handle('arrangements:close', ({ id }, event) => {
    const window = windows.resolve(event)
    if (window !== undefined) closeAll(window, id)
    return OK
  })

  handle('arrangements:setMuted', ({ id, muted }, event) => {
    const window = windows.resolve(event)
    if (window !== undefined) setMuted(window, id, muted)
    return OK
  })

  handle('arrangements:contextMenu', ({ id }, event) => {
    const window = windows.resolve(event)
    if (window === undefined) return OK
    const groups = window.groups
    const template = arrangementMenuTemplate({
      locale: deps.locale(),
      id,
      arrangements: window.arrangements.summaries(),
      groups: groups.groups(),
      onChangeLayout: (target, layout) => changeLayout(window, target, layout),
      onEnd: (target) => end(window, target),
      onCreateGroup: (tabId) => {
        groups.create({ tabIds: [tabId] })
      },
      onAddToGroup: (groupId, tabId) => groups.addTab(groupId, tabId),
      onRemoveFromGroup: (tabId) => groups.removeTab(tabId),
      onCloseAll: (target) => closeAll(window, target)
    })
    // An entry that went between the strip drawing it and the right-click: nothing to open.
    if (template.length > 0) deps.showMenu(template, window)
    return OK
  })

  handle('arrangements:releaseTab', ({ tabId }, event) => {
    const window = windows.resolve(event)
    if (window !== undefined) release(window, tabId)
    return OK
  })
}

/**
 * Puts a view on screen, with its last active tile, and gives that tile the window's focus (R4).
 *
 * `restore` decides whether it may come back at all; `activateTab` on the tab it made active is the
 * window's own way of focusing, relaying out and telling the strip, and it finds that tab in a tile
 * so it brings nothing else back. Answers whether the view is on screen now.
 */
function bringBack(window: ArrangementWindow, id: string): boolean {
  window.arrangements.restore(id)
  if (window.arrangements.liveId !== id) return false
  const focus = window.split.activeTabId()
  if (focus !== null) window.activateTab(focus)
  return true
}

function changeLayout(window: ArrangementWindow, id: string, layout: LayoutId): void {
  if (bringBack(window, id)) window.setLayout(layout)
}

function end(window: ArrangementWindow, id: string): void {
  if (window.arrangements.liveId === id) {
    window.setLayout('1x1')
    return
  }
  window.arrangements.endArrangement(id)
  window.publish()
}

/**
 * Closes every tab of a view, dissolved first (KTD13, R5).
 *
 * The view on screen leaves one empty pane behind when it is put away, and none of its closes vacates
 * a pane, so nothing would fill it. Once every close has been asked for it is the single pane whose
 * page has gone, and the window's rule for that decides what it shows (`afterTabClosed`, KTD10): the
 * first loose tab, else another view. A page still asking may be that tab — it is an ordinary one now,
 * and its question brings it forward anyway.
 */
function closeAll(window: ArrangementWindow, id: string): void {
  const wasOnScreen = window.arrangements.liveId === id
  const members = window.arrangements.dissolve(id)
  for (const tabId of members) window.closeTab(tabId)
  if (!wasOnScreen || members.length === 0) return
  if (window.split.layout === '1x1' && window.split.tabIdAt(0) === null) {
    window.occupancy.afterTabClosed(0)
  }
}

/**
 * Takes one tab out of the view on screen (U10, R9): the entry lets go of it first, then the panes close
 * ranks around the gap and the tab stands behind the entry. In that order because the entry is what
 * says whether the tab is a member of the view on screen at all, and because a view of two has to be
 * forgotten before its last page is alone in a pane — a settle in between would find one page and keep
 * the record, and a click on either would bring the view back.
 */
function release(window: ArrangementWindow, tabId: string): void {
  if (window.arrangements.releaseTab(tabId)) window.occupancy.releaseTab(tabId)
}

function setMuted(window: ArrangementWindow, id: string, muted: boolean): void {
  if (window.arrangements.liveId === id) {
    for (let tile = 0; tile < window.split.tileCount; tile++) window.setTileMuted(tile, muted)
    return
  }
  for (const tabId of window.arrangements.setMuted(id, muted)) {
    window.resolveTab(tabId)?.setMuted(muted)
  }
}
