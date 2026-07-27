import { TILE_COUNT, type LayoutId } from '../split/layout.js'
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
 * them in four tiles, and a `2x2` layout does not make a group. The two places the two
 * touch are both narrow. `collapsed`: a tab the strip is not showing must not be
 * holding a tile, and `tabsHiddenByCollapse` is how the core is told which those are.
 * And `layout`, below — which is a *recording* of tiles the group's tabs have left, not
 * a claim on tiles they hold. Even there the rule is spec 2's — *detach, never close*.
 *
 * ## Why the group is where a displaced arrangement lives
 *
 * Asking for a new tab puts the grid away: the new tab gets the whole window and the
 * pages that were in the panes stay loaded and stay in the strip
 * (`TileOccupancyController.claimTileForNewTab`). What used to be lost in that moment
 * was the *arrangement* — which layout it was and who sat in which tile — and there was
 * no way back to it.
 *
 * A group is the one thing in this design that already means "these tabs belong
 * together", survives being written down, and has a place in the strip the user can
 * click. So the arrangement is recorded on it, and activating a member puts it back.
 * The alternative — a nameless stack of previous layouts kept by the window — would be
 * invisible, unclickable and would not survive the window closing.
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

/**
 * Tiles that must still hold one of the group's tabs for its arrangement to be worth
 * keeping.
 *
 * Two, because one page in one pane is not an arrangement — it is the single view the
 * browser is about to switch to anyway, and recording it would make a group out of
 * every new tab opened from a window that happened to have one pane filled. Also the
 * floor on the way back down: a group whose members have closed until one is left has
 * nothing left to restore, and applying a four-tile layout to seat one page would put
 * three empty panes on screen — the one outcome `TileOccupancyController` exists to
 * prevent.
 */
export const MIN_ARRANGED_TILES = 2

/**
 * Where the group's tabs sat, the last time the browser took their tiles away.
 *
 * A recording of one displacement, not a preference and not a live assignment. `tiles`
 * is one entry per tile of `id`, in tile order, naming the member that was in it or
 * `null` for a tile that was empty — so restoring is "apply this layout, put these tabs
 * back where they were" and nothing has to be guessed.
 *
 * Positional rather than a list of tab ids, because the position *is* the information: a
 * member that has closed since must leave its tile empty rather than let the others
 * shift along, or coming back to a `2x2` would rearrange the three pages that survived.
 */
export interface TabGroupLayout {
  id: LayoutId
  /** Member tab id per tile; `null` for an empty tile. */
  tiles: Array<string | null>
}

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
  /**
   * The arrangement these tabs were displaced from, while there is one to go back to.
   *
   * Absent is the normal state: a group the user made by hand has never been displaced,
   * and a group whose arrangement has been restored has handed it back. Every invariant
   * it has to obey is enforced in one place — see `sanitisedLayout`.
   *
   * Declared `| undefined` rather than plain optional because the wire and storage
   * schemas express it with zod's `.optional()`, whose output type carries `undefined`;
   * the two-way assignments that keep those schemas honest would not compile otherwise.
   * Callers still write it with a conditional spread, so absent stays absent on disk.
   */
  layout?: TabGroupLayout | undefined
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

// --- arrangements ------------------------------------------------------------

/** The members an arrangement seats, in tile order, skipping the empty tiles. */
export function arrangedTabs(layout: TabGroupLayout): string[] {
  return layout.tiles.filter((tabId): tabId is string => tabId !== null)
}

/**
 * Which group an arrangement being put away should be recorded on.
 *
 * `reuse` names a group that already holds every seated tab, `create` asks for a new one
 * over exactly them, and `none` means this arrangement is not to be kept.
 */
export type ArrangementHolder =
  { kind: 'reuse'; groupId: string } | { kind: 'create' } | { kind: 'none' }

/**
 * The whole decision behind "which group keeps this arrangement", in one function.
 *
 * Here rather than in `TileOccupancyController` because it is the part with the
 * interesting cases, and a condition buried in a controller can only be tested through a
 * window's worth of state. Three answers, and the third is the one that is easy to miss:
 *
 *   - **Every seated tab is already in one and the same group** — record it there. This
 *     is what stops the feature from being group spam: a window collapsed, restored and
 *     collapsed again reuses the group it made the first time, keeping its colour and
 *     whatever name the user has since given it, instead of leaving a trail of
 *     one-per-displacement chips down the strip.
 *   - **No seated tab is in any group** — the ordinary case, and the only one that may
 *     create. The new group is over exactly the seated tabs.
 *   - **Anything else** — some seated tabs grouped and some not, or spread over two
 *     groups — and nothing is kept. Creating a group here would be destructive:
 *     `addGroup` takes its members away from whatever held them, so remembering a layout
 *     would shrink the user's own "Steuererklärung 2026" and dissolve it outright if the
 *     arrangement held all of it. Adding the loose tabs to the group instead is no
 *     better — it hands them a colour and a bracket the user did not ask for, and
 *     reorders the strip to make the run contiguous. Forgetting a layout is recoverable
 *     in one drag; silently editing a group the user built is not, and the browser must
 *     not do the second in order to achieve the first. The stated cost: after dropping an
 *     ungrouped tab into a restored arrangement, the next displacement is not recorded.
 *
 * Also the place `MIN_ARRANGED_TILES` is applied, so "is this worth keeping at all" and
 * "where would it go" cannot answer differently.
 */
export function groupToHoldArrangement(
  groups: readonly TabGroup[],
  layout: TabGroupLayout
): ArrangementHolder {
  const seated = arrangedTabs(layout)
  if (seated.length < MIN_ARRANGED_TILES) return { kind: 'none' }

  const owners = new Set(seated.map((tabId) => groupOfTab(groups, tabId)?.id))
  if (owners.size !== 1) return { kind: 'none' }

  // Exactly one owner, so the single entry is either a group id or the `undefined` that
  // stands for "ungrouped". Destructured rather than indexed: there is no third case to
  // guard against and a guard for one would be a branch no test can reach.
  const [only] = [...owners]
  if (only !== undefined) return { kind: 'reuse', groupId: only }

  /*
    The cap, checked here rather than walked into.

    `newTabGroup` throws past `MAX_TAB_GROUPS`, and this caller is not a user pressing a
    button: the refusal would travel up through `claimTileForNewTab` into `createTab`, so a
    window that had somehow collected fifty groups could no longer open a tab at all.
    Remembering a layout is never worth that, and a window at the cap has fifty groups the
    user can dissolve.
  */
  return groups.length >= MAX_TAB_GROUPS ? { kind: 'none' } : { kind: 'create' }
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
  /**
   * The arrangement the group is being formed to remember, for the one caller that has
   * one: a displacement that found none of these tabs grouped. Set here rather than by a
   * `setGroupLayout` straight after, so the group reaches the strip complete instead of
   * being broadcast once without it and once with.
   */
  layout?: TabGroupLayout
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

  return withLayout(
    {
      id: context.id,
      name: cleanGroupName(input.name ?? ''),
      color: input.color ?? nextTabGroupColor(groups),
      collapsed: false,
      tabIds,
      createdAt: context.now
    },
    // Validated against the deduplicated member list, not the caller's: an arrangement
    // may only name tabs the group actually has.
    sanitisedLayout(input.layout, tabIds)
  )
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
 * Records an arrangement on a group, or takes the one it carries away.
 *
 * `null` is not a failure but the *other* half of the feature: a restore consumes the
 * recording it used. See `TabGroupController.takeArrangementFor` for why replaying one
 * twice would fight the user.
 *
 * An arrangement that does not describe this group — the wrong number of tiles for its
 * layout, a tab the group does not have, one tab in two tiles — is dropped rather than
 * stored. A caller cannot reach that through the types, but the same check has to run on
 * a file read from disk, and one implementation of an invariant is the point of this
 * file.
 */
export function setGroupLayout(
  groups: readonly TabGroup[],
  id: string,
  layout: TabGroupLayout | null
): TabGroup[] {
  return patchGroup(groups, id, (group) =>
    withLayout(group, layout === null ? null : sanitisedLayout(layout, group.tabIds))
  )
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
 *   - **An arrangement that does not describe its group.** A `tiles` array of the wrong
 *     length for its layout, a tile naming a tab the group does not have, the same tab in
 *     two tiles. Each would be honoured on the next click and would move real pages:
 *     a short `tiles` would leave the last panes empty, a stale id would seat nothing
 *     while the tab that *is* there is evicted. The group and its tabs survive; only the
 *     unusable recording goes, which costs the user a layout and never a page.
 *
 * A document with no `layout` anywhere is the normal case, not a repair — that is every
 * file this browser has written so far.
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
    repaired.push(
      withLayout(
        { ...group, name: cleanGroupName(group.name), tabIds },
        // Against the repaired member list: a tile naming a tab this pass has just taken
        // away from the group would otherwise survive as a seat nobody can fill.
        sanitisedLayout(group.layout, tabIds)
      )
    )
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
  return groups.map((group) => keptMembers(group, keep)).filter((group) => group.tabIds.length > 0)
}

/**
 * One group with the departing members gone, from its list *and* from its arrangement.
 *
 * The tile of a member that left is emptied rather than closed up, which is the whole
 * reason `tiles` is positional: closing it up would move the pages that are still there,
 * so coming back to a `2x2` after one of four tabs closed would rearrange the other
 * three. `sanitisedLayout` then decides whether what is left is still an arrangement —
 * below `MIN_ARRANGED_TILES` there is nothing worth restoring, and the recording goes.
 */
function keptMembers(group: TabGroup, keep: (tabId: string) => boolean): TabGroup {
  const tabIds = group.tabIds.filter(keep)
  const emptied =
    group.layout === undefined
      ? undefined
      : {
          ...group.layout,
          tiles: group.layout.tiles.map((tabId) => (tabId !== null && keep(tabId) ? tabId : null))
        }
  return withLayout({ ...group, tabIds }, sanitisedLayout(emptied, tabIds))
}

/**
 * An arrangement a group may legally carry, or `null` when what it was handed is not
 * one.
 *
 * The single gate. Everything that can put a `layout` on a group goes through it — a
 * creation, a later recording, a member leaving, a file read off disk — so there is one
 * account of what makes an arrangement usable rather than four that can disagree. What it
 * insists on, and what each rules out:
 *
 *   - **One entry per tile of its own layout.** A short array would leave the last panes
 *     empty and a long one would silently drop members; `2x2` and `1x4` both have four
 *     tiles, so the count cannot be inferred from the array and the id cannot be inferred
 *     from the count.
 *   - **Every named tab is a member.** A tile naming a tab the group does not have is a
 *     seat nobody can take, and it would still evict whatever is in that tile on restore.
 *   - **No tab in two tiles.** One tab cannot be in two places; `SplitController.assignTab`
 *     would move it, so the earlier tile would end up empty and the arrangement would not
 *     be the one that was recorded.
 *   - **At least `MIN_ARRANGED_TILES` tabs left to seat.** See there.
 *
 * Returns a copy, so a stored arrangement is never the array a caller still holds.
 */
function sanitisedLayout(
  layout: TabGroupLayout | undefined,
  tabIds: readonly string[]
): TabGroupLayout | null {
  if (layout === undefined) return null
  if (layout.tiles.length !== TILE_COUNT[layout.id]) return null

  const members = new Set(tabIds)
  const seated = new Set<string>()
  for (const tabId of layout.tiles) {
    if (tabId === null) continue
    if (!members.has(tabId) || seated.has(tabId)) return null
    seated.add(tabId)
  }
  if (seated.size < MIN_ARRANGED_TILES) return null

  return { id: layout.id, tiles: [...layout.tiles] }
}

/**
 * A copy of the group carrying the given arrangement, or none at all.
 *
 * `delete` rather than assigning `undefined`, because `exactOptionalPropertyTypes` is on
 * and the two are not the same thing here: a key present with an `undefined` value is
 * written to the document as a key, and every file this browser has produced so far has
 * no `layout` key at all. Keeping "absent" absent is what makes the storage schema's
 * `.optional()` mean what it says.
 */
function withLayout(group: TabGroup, layout: TabGroupLayout | null): TabGroup {
  const next = { ...group }
  if (layout === null) delete next.layout
  else next.layout = layout
  return next
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
 * Copies a group, member list and arrangement included.
 *
 * Every operation returns groups whose arrays no caller already holds, so a result
 * cannot be mutated into the value it was derived from — the bug class where a store's
 * "previous" and "next" documents turn out to be the same object. `tiles` needs the same
 * treatment as `tabIds` and for the same reason: it is the second array on a group.
 */
function cloneGroup(group: TabGroup): TabGroup {
  const clone: TabGroup = { ...group, tabIds: [...group.tabIds] }
  if (clone.layout !== undefined) clone.layout = { ...clone.layout, tiles: [...clone.layout.tiles] }
  return clone
}

/**
 * Exported because the store hands snapshots out to windows and needs the same depth.
 * It had its own shallow copy of this rule, which was correct until a group grew a second
 * array.
 */
export function cloneGroups(groups: readonly TabGroup[]): TabGroup[] {
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
