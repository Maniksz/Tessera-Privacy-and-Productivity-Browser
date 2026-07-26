import { TAB_GROUP_COLORS, type TabGroupColor } from './palette.js'

/**
 * Tab groups — named, coloured, collapsible sets of tabs in one window's tab strip.
 *
 * ## Why this file has no zod import
 *
 * The tab strip is a renderer, so every value import here lands in a bundle the user
 * waits for. Co-locating schemas with a pure helper dragged the whole validation
 * library into the UI bundle once already — about half a megabyte of startup parse
 * work — and an architecture test now keeps it out. The persistence schema therefore
 * lives with the store in the main process (`src/main/data/TabGroupStore.ts`), next to
 * the four typed assignments that keep it from drifting from these interfaces. See
 * `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`.
 *
 * ## A group is not a tile assignment
 *
 * These are three independent facts about a tab, and keeping them independent is the
 * whole design:
 *
 *   - its **position** in the tab strip — an index in the window's ordered tab list;
 *   - its **tile**, or none — which region of the split layout displays it;
 *   - its **group**, or none — this file.
 *
 * A group says nothing about where a tab is shown. Grouping four tabs does not put
 * them in four tiles, and a `2x2` layout does not make a group. The one place the two
 * touch is `collapsed`: a tab the strip is not showing must not be holding a tile, and
 * `tabsHiddenByCollapse` is how the core is told which those are. Even there the rule
 * is spec 2's — *detach, never close*.
 *
 * ## Why membership lives on the group
 *
 * A tab is a runtime object owned by the window (`BrowserWindowController`), not a row
 * in this document, so there is nowhere to hang a `groupId` that would survive being
 * written down. The group therefore holds an ordered list of tab ids, and — as with
 * quick links — that array *is* the order. There is no position field: two sources of
 * ordering truth drift, and a reorder then has to repair state instead of moving an
 * element.
 *
 * The tab strip's order stays where it already is, in the window. It is *derived* from
 * these arrays by `contiguousOrder`, so each ordering has exactly one owner: the group
 * owns the order of its own members, the window owns everything else.
 *
 * ## Why every operation is pure
 *
 * Each takes the current groups and returns new ones, so the invariants — one tab in
 * at most one group, no tab twice in a group, no empty group — exist in one testable
 * place rather than being re-implemented across a store, an IPC handler and a drag
 * handler.
 */

/**
 * Names are cut here. Long enough for "Steuererklärung 2026", short enough that a
 * group cannot push every tab off the strip, and short enough to be a *label* — the
 * chip is drawn inline with the tabs, not on a line of its own.
 */
export const MAX_TAB_GROUP_NAME_LENGTH = 40

/**
 * Groups kept at most.
 *
 * Well past any believable window: fifty groups would need fifty tabs at the absolute
 * minimum, and the strip stops being usable long before that. It exists so a bug in a
 * caller, or a hand-edited file, cannot grow the document without bound.
 */
export const MAX_TAB_GROUPS = 50

export interface TabGroup {
  id: string
  /**
   * May be empty. An unnamed group is drawn as a bare colour, which is the useful
   * state while the user is still deciding — and refusing to create a group until it
   * has a name would mean a rename dialogue before the group exists.
   */
  name: string
  /** A slot in the fixed palette, never a colour value. See `palette.ts`. */
  color: TabGroupColor
  /**
   * Collapsed groups keep their tabs loaded and running; only the strip stops showing
   * them. See `tabsHiddenByCollapse` for what follows for tiles.
   */
  collapsed: boolean
  /**
   * Member tab ids, in the order the group shows them. Never empty and never
   * duplicated — see `withoutMembers` and `repairGroups`.
   */
  tabIds: string[]
  createdAt: number
}

export interface TabGroupDocument {
  version: 1
  /**
   * Array order is *not* display order. Where a group appears is decided by where its
   * members sit in the window's tab strip (`contiguousOrder`), so storing a rank here
   * would be the second source of ordering truth this design exists to avoid.
   */
  groups: TabGroup[]
}

export function emptyTabGroupDocument(): TabGroupDocument {
  return { version: 1, groups: [] }
}

// --- errors ------------------------------------------------------------------
// Named types rather than bare strings, so an IPC handler can map them to a message
// the user can act on instead of a generic failure.

export class TabGroupNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Tab group not found: ${id}`)
    this.name = 'TabGroupNotFoundError'
  }
}

export class TabGroupLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Cannot hold more than ${limit} tab groups`)
    this.name = 'TabGroupLimitError'
  }
}

/**
 * Refuses to create a group with no members.
 *
 * The counterpart of dissolving a group whose last tab leaves: if an empty group
 * cannot be created and cannot survive, it cannot exist, and the strip never has to
 * draw a chip with nothing in it.
 */
export class EmptyTabGroupError extends Error {
  constructor() {
    super('A tab group needs at least one tab')
    this.name = 'EmptyTabGroupError'
  }
}

// --- reads -------------------------------------------------------------------

export function findGroup(groups: readonly TabGroup[], id: string): TabGroup | undefined {
  return groups.find((group) => group.id === id)
}

/** The group holding a tab, or `undefined` when it is ungrouped. */
export function groupOfTab(groups: readonly TabGroup[], tabId: string): TabGroup | undefined {
  return groups.find((group) => group.tabIds.includes(tabId))
}

/**
 * Tabs the strip is currently not showing, because their group is collapsed.
 *
 * This is the one place a group touches the split layout, and the rule it serves is
 * spec 2's: a tab that loses its place is **detached, never closed**. Collapsing is a
 * display state — the tabs keep loading, keep playing and keep their scroll position,
 * exactly as tabs that lose a tile when the layout shrinks do. So the core unassigns
 * the tiles of these tabs and leaves the tabs alone.
 *
 * Expanding deliberately does *not* restore the tiles. The tile may hold another tab
 * by now, and re-taking it would displace whatever the user put there — one surprise
 * (the tile emptied) is better than two (the tile emptied, then stole something back).
 * An expanded tab is simply visible again and unassigned; clicking it assigns it to
 * the active tile through the path every unassigned tab already uses.
 */
export function tabsHiddenByCollapse(groups: readonly TabGroup[]): string[] {
  return groups.filter((group) => group.collapsed).flatMap((group) => [...group.tabIds])
}

/** True when this tab's group is collapsed, so it must hold no tile. */
export function isTabHidden(groups: readonly TabGroup[], tabId: string): boolean {
  return groupOfTab(groups, tabId)?.collapsed === true
}

/**
 * Tab-strip order with every group's members side by side.
 *
 * ## Why contiguity is enforced at all
 *
 * A group is drawn as a bracket around a run of tabs. A group scattered across the
 * strip either cannot be drawn or has to be drawn as several brackets, which reads as
 * several groups — and the user has no way to tell that from actually having several.
 *
 * The deciding argument is collapsing, though. Collapsing removes a *run* from the
 * strip. If a group were scattered, collapsing it would close holes all over the strip
 * and every tab would move: the strip would rearrange itself as a side effect of a
 * button that claims only to hide something. Reordering once, when the user puts a tab
 * into a group, is far better: it happens because of an action they just took, at the
 * moment they took it.
 *
 * So this is a decision about **reordering**, not about rendering — the same one
 * Chrome makes, and for the same reason.
 *
 * ## Where a group lands
 *
 * At the position of its earliest present member, and its members follow in the
 * group's own order. That means the group stays where it is and the joining tab is
 * pulled *to* the group, rather than the group jumping to the joining tab.
 *
 * Total, and a permutation of `order`: a member the window does not have — a group
 * whose tabs live in another window, or a stale id from the file — is skipped rather
 * than conjured into this strip. A duplicate in `order` is dropped, which is a repair
 * and not a case the strip can produce.
 */
export function contiguousOrder(order: readonly string[], groups: readonly TabGroup[]): string[] {
  const owner = ownerIndex(groups)
  const present = new Set(order)
  const placed = new Set<string>()
  const result: string[] = []

  for (const tabId of order) {
    if (placed.has(tabId)) continue
    const group = owner.get(tabId)
    if (group === undefined) {
      placed.add(tabId)
      result.push(tabId)
      continue
    }
    for (const member of group.tabIds) {
      if (!present.has(member) || placed.has(member)) continue
      placed.add(member)
      result.push(member)
    }
  }

  return result
}

/**
 * True when every group's present members already occupy consecutive positions.
 *
 * Not a test-only predicate: the core reorders and broadcasts only when this is false,
 * so a drag that happens to land in the right place does not make the whole strip
 * re-render. Says nothing about the order *within* a run — that is the group's own
 * array, and normalising it is `contiguousOrder`'s job.
 */
export function isContiguous(order: readonly string[], groups: readonly TabGroup[]): boolean {
  const owner = ownerIndex(groups)
  const finished = new Set<string>()
  let current: TabGroup | undefined

  for (const tabId of order) {
    const group = owner.get(tabId)
    // Still inside the same run — including a stretch of ungrouped tabs, where both
    // sides of this comparison are `undefined`.
    if (group === current) continue
    if (group !== undefined && finished.has(group.id)) return false
    if (current !== undefined) finished.add(current.id)
    current = group
  }

  return true
}

/**
 * What the tab strip actually renders: contiguous order, minus the members of
 * collapsed groups.
 *
 * The collapsed group's chip is still drawn — the strip knows it from the group list —
 * but its tabs are not, which is what makes a collapsed group take one slot instead of
 * eleven.
 */
export function visibleTabOrder(order: readonly string[], groups: readonly TabGroup[]): string[] {
  const hidden = new Set(tabsHiddenByCollapse(groups))
  return contiguousOrder(order, groups).filter((tabId) => !hidden.has(tabId))
}

/**
 * The colour a new group gets.
 *
 * The first slot not already in use, so two groups made in a row are told apart
 * without the user choosing anything. Once all eight are in use it starts over: a
 * colour is a label the user can change, not an identity, so reuse is better than
 * refusing to make a group or inventing a ninth colour nobody checked for contrast.
 */
export function nextTabGroupColor(groups: readonly TabGroup[]): TabGroupColor {
  const used = new Set<TabGroupColor>(groups.map((group) => group.color))
  const unused = TAB_GROUP_COLORS.filter((color) => !used.has(color))
  return unused[0] ?? TAB_GROUP_COLORS[0]
}

// --- writes ------------------------------------------------------------------

export interface CreateGroupInput {
  /**
   * The tabs the group is formed from. Required, and required to be non-empty: see
   * `EmptyTabGroupError`.
   */
  tabIds: readonly string[]
  /** Defaults to empty — an unnamed group shows its colour only. */
  name?: string
  /** Defaults to the next unused palette slot. */
  color?: TabGroupColor
}

export interface CreateContext {
  id: string
  now: number
}

/**
 * Builds a group without placing it.
 *
 * Split from `addGroup` so a caller that needs the created object — the store, which
 * has to tell the interface which group to open the rename field on — has it in hand
 * instead of searching the result for it. Searching would mean a "the group I just
 * created is missing" branch that cannot happen and cannot be tested.
 */
export function newTabGroup(
  groups: readonly TabGroup[],
  input: CreateGroupInput,
  context: CreateContext
): TabGroup {
  if (groups.length >= MAX_TAB_GROUPS) throw new TabGroupLimitError(MAX_TAB_GROUPS)

  // A selection can name the same tab twice — a ctrl-click that toggled back on, a
  // caller concatenating two lists. Deduplicating is the forgiving reading, and it
  // happens here so no later operation has to cope with it.
  const tabIds = [...new Set(input.tabIds)]
  if (tabIds.length === 0) throw new EmptyTabGroupError()

  return {
    id: context.id,
    name: cleanGroupName(input.name ?? ''),
    color: input.color ?? nextTabGroupColor(groups),
    collapsed: false,
    tabIds,
    createdAt: context.now
  }
}

/**
 * Places a group, taking its members away from whatever group held them.
 *
 * A group already stored under the same id is replaced rather than duplicated, so
 * applying the same creation twice — a retried IPC call, a replayed action — cannot
 * produce two groups claiming one id.
 */
export function addGroup(groups: readonly TabGroup[], group: TabGroup): TabGroup[] {
  const others = groups.filter((existing) => existing.id !== group.id)
  return [...withoutMembers(others, new Set(group.tabIds)), cloneGroup(group)]
}

export function renameGroup(groups: readonly TabGroup[], id: string, name: string): TabGroup[] {
  return patchGroup(groups, id, (group) => ({ ...group, name: cleanGroupName(name) }))
}

export function recolorGroup(
  groups: readonly TabGroup[],
  id: string,
  color: TabGroupColor
): TabGroup[] {
  return patchGroup(groups, id, (group) => ({ ...group, color }))
}

export function setGroupCollapsed(
  groups: readonly TabGroup[],
  id: string,
  collapsed: boolean
): TabGroup[] {
  return patchGroup(groups, id, (group) => ({ ...group, collapsed }))
}

/**
 * Removes the group and leaves its tabs ungrouped — "ungroup all", not "close all".
 *
 * Nothing here can close a tab, which is deliberate rather than an omission. Spec 2
 * settled the question for the layout: shrinking it detaches tabs and never closes
 * them. A group is a weaker relationship than a tile, so it cannot have a stronger
 * consequence, and a menu entry called *Ungroup* that destroyed eleven loaded pages
 * would be unrecoverable in a way nothing else in this browser is.
 */
export function dissolveGroup(groups: readonly TabGroup[], id: string): TabGroup[] {
  if (findGroup(groups, id) === undefined) throw new TabGroupNotFoundError(id)
  return cloneGroups(groups.filter((group) => group.id !== id))
}

/**
 * Puts a tab in a group, at `index` among its members or at the end.
 *
 * The tab leaves any group that held it, because a tab is in at most one group — and a
 * group left empty by that departure is dissolved, so "drag the last tab of one group
 * into another" cannot leave a ghost behind.
 *
 * Re-adding a tab to the group it is already in is a no-op unless a position was
 * asked for. Without that, "add to group" on a tab that is already a member would
 * silently send it to the end of the group.
 */
export function addTabToGroup(
  groups: readonly TabGroup[],
  groupId: string,
  tabId: string,
  index?: number
): TabGroup[] {
  const position = groups.findIndex((group) => group.id === groupId)
  if (position === -1) throw new TabGroupNotFoundError(groupId)
  if (groupOfTab(groups, tabId)?.id === groupId && index === undefined) return cloneGroups(groups)

  /*
    The target is rebuilt from `groups` and spliced back in by `flatMap`, rather than
    stripping the tab everywhere first and then inserting.

    Stripping first has a trap: if the target's only member is the tab being
    repositioned, the strip empties the target and the empty-group rule dissolves it —
    so a reorder inside a one-tab group would delete the group. Building the target
    separately means it is never momentarily empty. `slice(position, position + 1)`
    rather than an index read, so there is no "the group I just found is missing"
    branch to leave uncovered.
  */
  const target = groups.slice(position, position + 1).map((group) => {
    const without = group.tabIds.filter((id) => id !== tabId)
    const at = clampIndex(index ?? without.length, without.length)
    return { ...group, tabIds: [...without.slice(0, at), tabId, ...without.slice(at)] }
  })

  return groups.flatMap((group) => {
    if (group.id === groupId) return target
    const without = group.tabIds.filter((id) => id !== tabId)
    return without.length === 0 ? [] : [{ ...group, tabIds: without }]
  })
}

/**
 * Takes a tab out of whatever group holds it, dissolving a group left empty.
 *
 * ## Why the last tab leaving takes the group with it
 *
 * A group with no members has nothing to draw a bracket around, cannot be reached to
 * be renamed or recoloured, and cannot be dropped into except by aiming at a chip that
 * marks an empty stretch of strip. Keeping it would mean the strip permanently
 * displaying an affordance for a thing the user thought they had got rid of, and the
 * only way back would be a cleanup step nobody asked for.
 *
 * The alternative — a named empty group you can drop tabs into later — was rejected
 * for that reason: it turns "I closed the last tab in this group" into a state the user
 * has to tidy up. The cost is stated plainly: the name and colour are gone, and
 * regrouping means naming it again. That is the right trade, because losing a label is
 * recoverable in seconds and a ghost in the strip is not recoverable at all.
 *
 * Total, and the same call the close path uses: closing a tab is "that tab leaves its
 * group" plus "that tab is gone", so a closed tab cannot leave a ghost either. A tab
 * in no group yields the list unchanged rather than an error, because a window closing
 * a tab has no reason to know whether it was grouped.
 */
export function removeTabFromGroup(groups: readonly TabGroup[], tabId: string): TabGroup[] {
  return withoutMembers(groups, new Set([tabId]))
}

/**
 * Keeps only the members the window actually has, dissolving groups left empty.
 *
 * ## The trap this exists for
 *
 * Tab ids come from a counter in `Tab.ts` that starts again at `tab-1` on every
 * launch, so a stored membership of `['tab-1', 'tab-3']` names *this* run's first and
 * third tabs, whichever pages those turn out to be. Adopting a loaded document without
 * reconciling it would drop unrelated fresh tabs into the user's old groups.
 *
 * So a window calls this once, with the ids it is bringing back, before it shows
 * anything: none on a cold start, the restored ids once session restore
 * (`sessionStateFile`) exists. Deliberately not done inside `open`, which runs before
 * any tab exists and would therefore have to guess — and guessing "no tabs" there
 * would write the emptied document straight back over the groups a future session
 * restore could still have reattached.
 */
export function retainTabs(groups: readonly TabGroup[], liveTabIds: readonly string[]): TabGroup[] {
  const live = new Set(liveTabIds)
  return withMembersFiltered(groups, (tabId) => live.has(tabId))
}

// --- repair ------------------------------------------------------------------

/**
 * Makes a loaded document obey the invariants the write path maintains.
 *
 * Runs when the file is read, and heals rather than rejects — a file written by an
 * older build, edited by hand or cut short by a crash must not cost the user their
 * groups. What it fixes, and why each is a repair and not a rejection:
 *
 *   - **A duplicate group id.** Two entries claiming one id are one group as far as
 *     every lookup here is concerned; the later one is dropped rather than silently
 *     shadowing the earlier one in half the operations.
 *   - **A tab claimed by two groups.** First claim wins, matching the order every
 *     other read uses, so `groupOfTab` and the strip cannot disagree about who owns a
 *     tab.
 *   - **A tab listed twice in one group.** The strip would draw it twice and the
 *     second one would be unreachable.
 *   - **An empty group.** Same ghost as a group whose last tab left.
 *   - **An over-long name**, and **more groups than the cap**. Both are quantities,
 *     and a quantity must never reach the schema: validation failure replaces the
 *     whole document with defaults, so a `.max()` there would turn "grew larger than
 *     expected" into "lost every group".
 */
export function repairGroups(groups: readonly TabGroup[]): TabGroup[] {
  const seenIds = new Set<string>()
  const claimed = new Set<string>()
  const repaired: TabGroup[] = []

  for (const group of groups) {
    if (repaired.length >= MAX_TAB_GROUPS) break
    if (seenIds.has(group.id)) continue

    const tabIds: string[] = []
    for (const tabId of group.tabIds) {
      if (claimed.has(tabId)) continue
      claimed.add(tabId)
      tabIds.push(tabId)
    }
    if (tabIds.length === 0) continue

    seenIds.add(group.id)
    repaired.push({ ...group, name: cleanGroupName(group.name), tabIds })
  }

  return repaired
}

// --- internals ---------------------------------------------------------------

/**
 * Which group owns each tab, first claim winning.
 *
 * Built once per pass because the ordering functions ask for every tab in the strip,
 * and `groups.find(...)` per tab is quadratic in a window with many tabs. First claim
 * matches `groupOfTab` and `repairGroups`, so the three cannot disagree about a
 * document that slipped past repair.
 */
function ownerIndex(groups: readonly TabGroup[]): Map<string, TabGroup> {
  const owner = new Map<string, TabGroup>()
  for (const group of groups) {
    for (const tabId of group.tabIds) {
      if (!owner.has(tabId)) owner.set(tabId, group)
    }
  }
  return owner
}

/**
 * Drops the named tabs from every group, dissolving any group left empty.
 *
 * The empty-group rule lives here, in the one function every departure goes through —
 * leaving a group, being taken by another group, being closed, not coming back from a
 * restore — so there is no path that produces one.
 */
function withoutMembers(groups: readonly TabGroup[], doomed: ReadonlySet<string>): TabGroup[] {
  return withMembersFiltered(groups, (tabId) => !doomed.has(tabId))
}

function withMembersFiltered(
  groups: readonly TabGroup[],
  keep: (tabId: string) => boolean
): TabGroup[] {
  return groups
    .map((group) => ({ ...group, tabIds: group.tabIds.filter(keep) }))
    .filter((group) => group.tabIds.length > 0)
}

/**
 * Applies a change to one group, in place in the array.
 *
 * `slice(index, index + 1).map(...)` rather than an index read and a null check: the
 * `findIndex` above already established the group exists, so a guard here would be a
 * branch no test can reach and every coverage run would report.
 */
function patchGroup(
  groups: readonly TabGroup[],
  id: string,
  patch: (group: TabGroup) => TabGroup
): TabGroup[] {
  const index = groups.findIndex((group) => group.id === id)
  if (index === -1) throw new TabGroupNotFoundError(id)
  return [
    ...cloneGroups(groups.slice(0, index)),
    ...groups.slice(index, index + 1).map((group) => cloneGroup(patch(group))),
    ...cloneGroups(groups.slice(index + 1))
  ]
}

/**
 * Copies a group, member list included.
 *
 * Every operation returns groups whose arrays no caller already holds, so a result
 * cannot be mutated into the value it was derived from — the bug class where a store's
 * "previous" and "next" documents turn out to be the same object.
 */
function cloneGroup(group: TabGroup): TabGroup {
  return { ...group, tabIds: [...group.tabIds] }
}

function cloneGroups(groups: readonly TabGroup[]): TabGroup[] {
  return groups.map(cloneGroup)
}

/**
 * Names arrive from a text field, so they arrive with newlines and padding in them.
 * The chip shows a single line, so the whitespace is collapsed once here rather than
 * in every view that draws it.
 */
function cleanGroupName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_TAB_GROUP_NAME_LENGTH)
}

/** Keeps an index inside `[0, max]`, treating anything non-numeric as the front. */
function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.trunc(value), 0), max)
}
