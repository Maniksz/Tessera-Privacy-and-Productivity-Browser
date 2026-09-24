import { TILE_COUNT, withDefaults, type LayoutId } from '../split/layout.js'

/**
 * Workspaces (U21, R35, KTD15): a layout, where its dividers were and which page sat in each tile,
 * under a name the user gave it.
 *
 * ## Not an arrangement
 *
 * `shared/arrangements/model.ts` records the same shape with tab ids, which live for one run unless the
 * session is restored, and that is off by default; its recordings are invisible and evicted. A workspace
 * names each tile by the address it showed, so it opens after a restart, and it is made on purpose like
 * a bookmark: nothing evicts it, and the store is `critical`.
 *
 * ## Why this file has no zod import
 *
 * The overlay surface lists and saves workspaces, and it is a renderer; the wire and file schemas live
 * in `schema.ts` beside this, with `SameShape` holding the two together, as for the arrangements.
 */

/**
 * The layout menu's four channels. `channels.ts` spreads them into its list; named here, beside the
 * shapes they carry, so that file stays under its bar. Chrome-only: no internal page is granted them.
 */
export const WORKSPACE_CHANNELS = [
  'workspaces:list',
  'workspaces:save',
  'workspaces:open',
  'workspaces:remove'
] as const

/** Longest name a workspace may have: what the menu shows on one line. */
export const MAX_WORKSPACE_NAME = 60

export interface Workspace {
  id: string
  name: string
  layoutId: LayoutId
  /** The layout's own dividers and no others; see `fractionsOf`. */
  fractions: Record<string, number>
  /** An address per tile, in tile order, `null` for an empty one. Exactly `TILE_COUNT[layoutId]`. */
  seats: Array<string | null>
  savedAt: number
}

export interface WorkspaceDocument {
  version: 1
  /** In the order they were first saved; the menu sorts by name. */
  workspaces: Workspace[]
}

/** What a caller saves: a workspace without the two fields the store owns. */
export type WorkspaceDraft = Omit<Workspace, 'id' | 'savedAt'>

/** One row of the layout menu's list. */
export interface WorkspaceSummary {
  id: string
  name: string
  layoutId: LayoutId
}

/** The answer to `workspaces:list`. */
export interface WorkspaceMenu {
  workspaces: WorkspaceSummary[]
  /** False in a private window: it may open a workspace and never save one. */
  canSave: boolean
  /** The file is a newer version's: listed and opened, never written. */
  readOnly: boolean
}

/**
 * What `workspaces:save` did. `exists` changes nothing and asks for confirmation; `private` is a
 * private window; `invalid` is a name with nothing in it or too long, or a window that is gone.
 */
export const SAVE_OUTCOMES = ['saved', 'exists', 'read-only', 'private', 'invalid'] as const

export type SaveOutcome = (typeof SAVE_OUTCOMES)[number]

export function emptyWorkspaceDocument(): WorkspaceDocument {
  return { version: 1, workspaces: [] }
}

/** The name as it is kept: trimmed, runs of white space made one; `null` for none or too long. */
export function workspaceName(raw: string): string | null {
  const name = tidy(raw)
  return name === '' || name.length > MAX_WORKSPACE_NAME ? null : name
}

function tidy(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/** Two names are one when they differ only in case, which is how a person reads a menu. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * One seat per tile of the layout, from the addresses the tiles show. Positional, so an empty tile
 * stays where it was rather than letting the others shift along; a blank page is an empty tile.
 */
export function seatsFor(
  layoutId: LayoutId,
  tileUrls: ReadonlyArray<string | null | undefined>
): Array<string | null> {
  return Array.from({ length: TILE_COUNT[layoutId] }, (_, index) => {
    const url = tileUrls[index]
    return url === undefined || url === null || url === '' || url === 'about:blank' ? null : url
  })
}

/** The layout's own dividers, each as it was or at its default; a divider it lacks is dropped. */
export function fractionsOf(
  layoutId: LayoutId,
  fractions: Readonly<Record<string, number>>
): Record<string, number> {
  return { ...withDefaults(layoutId, fractions) }
}

/**
 * Saves under the workspace's name. A name already taken (in any case) is `exists` and changes
 * nothing until `replace` confirms it; the replaced workspace then keeps its place and its id.
 */
export function saveWorkspace(
  workspaces: readonly Workspace[],
  workspace: Workspace,
  replace: boolean
): { outcome: 'saved' | 'exists'; workspaces: Workspace[] } {
  const taken = workspaces.findIndex((entry) => sameName(entry.name, workspace.name))
  if (taken === -1) return { outcome: 'saved', workspaces: [...workspaces, workspace] }
  if (!replace) return { outcome: 'exists', workspaces: [...workspaces] }
  return {
    outcome: 'saved',
    workspaces: workspaces.map((entry, index) =>
      index === taken ? { ...workspace, id: entry.id } : entry
    )
  }
}

export function removeWorkspace(workspaces: readonly Workspace[], id: string): Workspace[] {
  return workspaces.filter((entry) => entry.id !== id)
}

/** The menu's list: names and layouts only, by name as a person sorts them. */
export function summarize(workspaces: readonly Workspace[]): WorkspaceSummary[] {
  return workspaces
    .map(({ id, name, layoutId }) => ({ id, name, layoutId }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** What a seat becomes when a workspace opens: an open tab, a new one for an address, or nothing. */
export type SeatPlan = { tabId: string } | { url: string } | null

/**
 * Which tab each seat gets. An open tab showing the seat's address is taken before a new one is
 * opened, in strip order, and no tab is taken twice. The caller passes only tabs it may put in a
 * tile (not those a collapsed group hides); every tab that gets no seat stays open.
 */
export function planOpening(
  seats: ReadonlyArray<string | null>,
  tabs: ReadonlyArray<{ id: string; url: string }>
): SeatPlan[] {
  const taken = new Set<string>()
  return seats.map((url) => {
    if (url === null) return null
    const open = tabs.find((tab) => tab.url === url && !taken.has(tab.id))
    if (open === undefined) return { url }
    taken.add(open.id)
    return { tabId: open.id }
  })
}

/**
 * A loaded document made consistent: a name tidied and cut to length (a quantity is healed, not a
 * reason to lose the workspace), dropped only when nothing is left of it; one seat per tile; the
 * layout's own dividers; and the first of two with one id or one name kept. Unknown fields stay.
 */
export function repairWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  const kept: Workspace[] = []
  for (const entry of workspaces) {
    const name = tidy(entry.name).slice(0, MAX_WORKSPACE_NAME)
    if (name === '') continue
    if (kept.some((other) => other.id === entry.id || sameName(other.name, name))) continue
    kept.push({
      ...entry,
      name,
      seats: seatsFor(entry.layoutId, entry.seats),
      fractions: fractionsOf(entry.layoutId, entry.fractions)
    })
  }
  return kept
}
