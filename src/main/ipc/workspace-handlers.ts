import type { IpcMainInvokeEvent } from 'electron'
import type { InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { LayoutId } from '@shared/split/layout.js'
import {
  fractionsOf,
  planOpeningInOneGroup,
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
 * A tiled view on screen is put away before anything else happens (U2): it keeps its entry, its
 * seats and its view, and the workspace's pages arrive in a window that is showing no tiling.
 *
 * Each seat takes an open tab showing its address, or a new tab opened in the background; every tab
 * that gets no seat leaves the grid and stays in the strip (spec 2). Tiles are cleared *before* the
 * layout changes, so a shrink orphans no tab — which is what keeps `afterLayoutChange` from closing a
 * start page the browser opened as a filler. The layout is then put up through the same path a
 * recorded arrangement takes (`restoreArrangement`: no filling), and the dividers last, because they
 * belong to that layout.
 *
 * ## It takes no tab out of a tiled view
 *
 * An open tab is reused only when it is an ordinary one: a member of a tiled view — including the one
 * just put away — gets a new tab for its address instead (KTD10). Reusing it would move a page out of
 * its view's entry into the workspace's tiling unasked (R16), and it would cost the workspace its own
 * entry as well, because the settle after it can neither adopt a view for a seating that mixes a
 * member with other tabs nor create one over a tab another view holds.
 *
 * ## It regroups nothing
 *
 * The seating becomes one tiled view, which is wholly in one group or in none (R10); a view across
 * a group boundary is dropped at the next start (R15). The first open tab taken decides which, only
 * tabs of the same group state are taken beside it, and the new tabs open in its group — so no tab
 * the user grouped, or left loose, changes group for a workspace (`planOpeningInOneGroup`).
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
  /**
   * Whether a collapsed group hides a tab, which may then not be put in a tile; the groups, to keep
   * the workspace's view in one group or none; and a new tab put in the view's group (R10).
   */
  readonly groups: {
    isHidden(tabId: string): boolean
    groups(): ReadonlyArray<{ readonly id: string; readonly tabIds: readonly string[] }>
    addTab(groupId: string, tabId: string): void
  }
  /**
   * The window's tiled views. Opening a workspace puts the visible one away first (U2), as bringing
   * another tiled view back does: its entry stays in the strip, unchanged, and none of its panes is
   * left for the workspace's seating to be read as a change to it. `isMember` is what keeps every
   * view's tabs out of the seating (KTD10).
   */
  readonly arrangements: { putAway(): void; isMember(tabId: string): boolean }
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

    window.arrangements.putAway()
    const groups = window.groups.groups()
    const candidates = window.tabs
      .filter((tab) => !window.groups.isHidden(tab.id) && !window.arrangements.isMember(tab.id))
      .map((tab) => ({
        id: tab.id,
        url: tab.toState().url,
        groupId: groups.find((group) => group.tabIds.includes(tab.id))?.id ?? null
      }))
    const { plan, groupId } = planOpeningInOneGroup(workspace.seats, candidates)
    const seats = plan.map((seat) => {
      if (seat === null) return null
      if ('tabId' in seat) return seat.tabId
      const opened = window.createTab({ url: seat.url, background: true, tileIndex: null }).id
      if (groupId !== null) window.groups.addTab(groupId, opened)
      return opened
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
