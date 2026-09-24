import type { IpcMainInvokeEvent } from 'electron'
import type { InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { LayoutId } from '@shared/split/layout.js'
import {
  fractionsOf,
  planOpening,
  seatsFor,
  workspaceName,
  type WORKSPACE_CHANNELS
} from '@shared/workspaces/model.js'
import type { WorkspaceStore } from '../data/WorkspaceStore.js'

/**
 * The layout menu's workspaces (U21, R35): list, save the window's tiling under a name, open one, and
 * remove one.
 *
 * ## Why this is not in `handlers.ts`
 *
 * For `import-handlers.ts`'s reasons: that file may only gain call sites (KTD21) and imports the router,
 * so nothing in it can be tested. Handed the registrar, the windows and the store, this is an ordinary
 * function a test drives against a real store and the real tile controllers.
 *
 * ## Opening closes nothing
 *
 * Each seat takes an open tab showing its address, or a new tab opened in the background; every tab
 * that gets no seat leaves the grid and stays in the strip (spec 2). Tiles are cleared *before* the
 * layout changes, so a shrink orphans no tab — which is what keeps `afterLayoutChange` from closing a
 * start page the browser opened as a filler. The layout is then put up through the same path a
 * recorded arrangement takes (`restoreArrangement`: no filling, no rehoming), and the dividers last,
 * because they belong to that layout.
 *
 * ## Private windows open and never save
 *
 * A private window's pages must not reach a file, so `save` answers `private` and the list says so, which
 * is what greys the entry out. Opening reads the file and writes nothing.
 */

type WorkspaceChannel = (typeof WORKSPACE_CHANNELS)[number]

type WorkspaceChannelContract = {
  [C in WorkspaceChannel]: { request: InvokeHandlerArg<C>; response: InvokeResponse<C> }
}

/** The shape of `ipc/router.ts`'s `handle`, narrowed to these channels. See `ImportHandle`. */
export type WorkspaceHandle = <C extends WorkspaceChannel>(
  channel: C,
  handler: (
    payload: WorkspaceChannelContract[C]['request'],
    event: IpcMainInvokeEvent
  ) => WorkspaceChannelContract[C]['response'] | Promise<WorkspaceChannelContract[C]['response']>
) => void

/** What a window has to offer for this; `BrowserWindowController` is one. */
export interface WorkspaceWindow {
  readonly privateMode: boolean
  readonly split: {
    readonly layout: LayoutId
    toState(): { fractions: Readonly<Record<string, number>>; tileTabIds: Array<string | null> }
  }
  readonly tabs: ReadonlyArray<{ readonly id: string; toState(): { url: string } }>
  /** Whether a collapsed group hides a tab, which may then not be put in a tile. */
  readonly groups: { isHidden(tabId: string): boolean }
  readonly occupancy: {
    restoreArrangement(
      layoutId: LayoutId,
      seats: ReadonlyArray<string | null>,
      activatedTabId: string
    ): void
  }
  createTab(options: { url: string; background: boolean; tileIndex: null }): { readonly id: string }
  assignTabToTile(tabId: string, tileIndex: number | null): void
  setFractions(fractions: Readonly<Record<string, number>>): void
  dismissOverlayKind(kind: 'layout-menu'): boolean
}

export interface WorkspaceHandlerDeps {
  readonly handle: WorkspaceHandle
  readonly windows: { resolve(event: IpcMainInvokeEvent): WorkspaceWindow | undefined }
  readonly workspaces: WorkspaceStore
}

export function registerWorkspaceHandlers(deps: WorkspaceHandlerDeps): void {
  const { handle, windows, workspaces } = deps

  handle('workspaces:list', (_payload, event) => ({
    workspaces: workspaces.summaries(),
    canSave: windows.resolve(event)?.privateMode === false,
    readOnly: workspaces.readOnly
  }))

  handle('workspaces:save', ({ name: raw, replace }, event) => {
    const window = windows.resolve(event)
    const name = workspaceName(raw)
    if (window === undefined || name === null) return { outcome: 'invalid' }
    if (window.privateMode) return { outcome: 'private' }
    const { layout } = window.split
    const state = window.split.toState()
    const urlOf = (tabId: string | null): string | null =>
      window.tabs.find((tab) => tab.id === tabId)?.toState().url ?? null
    const seats = seatsFor(layout, state.tileTabIds.map(urlOf))
    const draft = { name, layoutId: layout, fractions: fractionsOf(layout, state.fractions), seats }
    return { outcome: workspaces.save(draft, replace) }
  })

  handle('workspaces:open', ({ id }, event) => {
    const workspace = workspaces.get(id)
    const window = windows.resolve(event)
    if (workspace === undefined || window === undefined) return { outcome: 'missing' }

    const candidates = window.tabs
      .filter((tab) => !window.groups.isHidden(tab.id))
      .map((tab) => ({ id: tab.id, url: tab.toState().url }))
    const seats = planOpening(workspace.seats, candidates).map((seat) => {
      if (seat === null) return null
      if ('tabId' in seat) return seat.tabId
      return window.createTab({ url: seat.url, background: true, tileIndex: null }).id
    })
    // Cleared first, so the layout change orphans nothing; see "Opening closes nothing" above.
    for (const [index, tabId] of window.split.toState().tileTabIds.entries()) {
      if (tabId !== null && seats[index] !== tabId) window.assignTabToTile(tabId, null)
    }
    const first = seats.find((tabId) => tabId !== null) ?? ''
    window.occupancy.restoreArrangement(workspace.layoutId, seats, first)
    window.setFractions(workspace.fractions)
    window.dismissOverlayKind('layout-menu')
    return { outcome: 'opened' }
  })

  handle('workspaces:remove', ({ id }) => ({ outcome: workspaces.remove(id) }))
}
