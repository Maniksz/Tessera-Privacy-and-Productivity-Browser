import type { ArrangementSummary } from '../arrangements/screen.js'
import { contiguousOrder, type TabGroup } from '../tabgroups/model.js'

/**
 * The tab strip as a model: its order and the entries it draws, from tabs, groups and tiled views
 * together (U5, KTD6).
 *
 * The strip is not a list of tabs. A group is a chip followed by its members, a folded group is a chip
 * alone, and a tiled view is one entry however many pages it holds (R1). Turning "tabs plus groups
 * plus tiled views" into that sequence is a decision, and it is here rather than in the component for
 * the usual reason — a second implementation of it (in the positional keys, in Ctrl+Tab, in the chip
 * counter, in a test) would eventually disagree with the first. So all of them read the same entries:
 * `stripEntries` is what `Ctrl+1`…`9` count (R13), what `nextStripEntry` steps through, and what a
 * folded chip counts (R11).
 *
 * ## Two runs, one inside the other
 *
 * A group is one run of tabs (`contiguousOrder`); a tiled view is one run too, at the place of its
 * first member, its members in tile order. The view's run is nested in its group's run, never across
 * it: R10 keeps a view's members in one group or none, and the day that does not hold — a document
 * from before U8, a race — the group's run wins, because splitting a group into two brackets would
 * make folding it hide half of what the user put in it. A member held by another group stays in that
 * group's run as a plain tab, and the view's entry holds what its first member's group holds.
 *
 * ## Why no zod, and only a type from the arrangements
 *
 * The chrome UI imports this, so every value import here lands in the bundle the user waits for; see
 * the note in `tabgroups/model.ts`. The tiled views arrive as the `arrangements:changed` summaries
 * (KTD5), and of those only the members and the active tab matter here, which is `StripArrangement`.
 */

/** Where an entry sits within its group, which is what lets the band have rounded ends. */
export type GroupPosition = 'only' | 'first' | 'middle' | 'last'

/**
 * What the strip needs of a tiled view: an `ArrangementSummary` does, and so does anything narrower.
 * `tabIds` in tile order, as the summary carries them.
 */
export type StripArrangement = Pick<ArrangementSummary, 'id' | 'tabIds' | 'activeTabId'>

export interface GroupStripItem {
  kind: 'group'
  group: TabGroup
  /** Entries not drawn, so a folded chip can say "3" — a tiled view is one. Zero while open. */
  hiddenCount: number
}

export interface TabStripItem {
  kind: 'tab'
  tabId: string
  /** The group this tab belongs to, or `null` for a loose tab. */
  group: TabGroup | null
  /** Only meaningful inside a group. */
  position: GroupPosition | null
}

export interface SplitStripItem {
  kind: 'split'
  arrangementId: string
  /** The members this strip has, in tile order: the favicons, left to right (R2). */
  tabIds: string[]
  /**
   * The member the entry is titled with and brings back focused (R2, R4): the view's active tab, or
   * its first member here when that one is not — the close of it raced the summary.
   */
  activeTabId: string
  group: TabGroup | null
  position: GroupPosition | null
}

export type StripItem = GroupStripItem | TabStripItem | SplitStripItem

/** One place in the strip: what a click, a positional key or Ctrl+Tab lands on. A chip is not one. */
export type StripEntry = TabStripItem | SplitStripItem

/** A tab or a tiled view, placed, before the groups are drawn round it. */
type Unit =
  | { kind: 'tab'; tabId: string; group: TabGroup | null }
  | { kind: 'split'; arrangement: StripArrangement; tabIds: string[]; group: TabGroup | null }

/**
 * The strip's order: every group one run, every tiled view one run inside it.
 *
 * What the core sends as `tabs:changed` and writes back as the window's order, so it is idempotent —
 * the second pass over its own answer moves nothing. Total, and a permutation of `tabOrder` with
 * duplicates dropped: a view member the window does not have is skipped rather than conjured, as
 * `contiguousOrder` does for a group.
 */
export function stripOrder(
  tabOrder: readonly string[],
  groups: readonly TabGroup[],
  arrangements: readonly StripArrangement[]
): string[] {
  return unitsOf(tabOrder, groups, arrangements).flatMap((unit) =>
    unit.kind === 'tab' ? [unit.tabId] : unit.tabIds
  )
}

/**
 * What the tab strip draws, in order.
 *
 * The order is settled first, through `stripOrder`, so what is drawn does not depend on the caller
 * having sent a settled one: a scattered group gets one chip rather than two, and a view whose members
 * are apart gets one entry. A strip that dropped a tab because an invariant was briefly untrue would
 * leave an open page unreachable, and nothing here drops one.
 *
 * A group's chip stands where its first entry is, so a group's place in the strip follows from where
 * its tabs are; nothing stores a rank. Folded, the chip is all that is drawn, and it counts the entries
 * it hides. Open, each entry knows where in the band it sits, counted by entries: a view of two pages
 * between two tabs is the middle one.
 *
 * Without tiled views the answer has no `split` entry, which the first overload says, so a caller that
 * has not been told about them yet reads only groups and tabs.
 */
export function stripItems(
  order: readonly string[],
  groups: readonly TabGroup[]
): Array<GroupStripItem | TabStripItem>
export function stripItems(
  order: readonly string[],
  groups: readonly TabGroup[],
  arrangements: readonly StripArrangement[]
): StripItem[]
export function stripItems(
  order: readonly string[],
  groups: readonly TabGroup[],
  arrangements: readonly StripArrangement[] = []
): StripItem[] {
  // Consecutive units of one group are its run; consecutive loose units are a run of no group.
  const runs: Array<{ group: TabGroup | null; units: Unit[] }> = []
  for (const unit of unitsOf(order, groups, arrangements)) {
    const last = runs[runs.length - 1]
    // `undefined` for the first unit, which no group — `null` included — equals.
    if (last?.group === unit.group) last.units.push(unit)
    else runs.push({ group: unit.group, units: [unit] })
  }

  return runs.flatMap(({ group, units }): StripItem[] => {
    if (group === null) return units.map((unit) => entryOf(unit, null))
    const chip: GroupStripItem = {
      kind: 'group',
      group,
      hiddenCount: group.collapsed ? units.length : 0
    }
    // A folded group draws its chip and nothing else. The tabs are still loaded and running.
    if (group.collapsed) return [chip]
    return [chip, ...units.map((unit, index) => entryOf(unit, positionOf(index, units.length)))]
  })
}

/** The entries of a strip: what it draws that can be landed on, chips and folded members left out. */
export function stripEntries(items: readonly StripItem[]): StripEntry[] {
  return items.filter((item): item is StripEntry => item.kind !== 'group')
}

/**
 * The entry a tab is drawn in — its own, or its tiled view's — or `null` when the strip draws it
 * nowhere: folded away, or not this window's.
 *
 * What maps the active tab to the entry that is selected (`aria-selected`, R13, R14): with the view on
 * screen, the active tab is whichever tile has focus, and the entry is the view's for all of them.
 */
export function stripEntryOf(items: readonly StripItem[], tabId: string | null): StripEntry | null {
  return stripEntries(items).find((entry) => holds(entry, tabId)) ?? null
}

/**
 * The tab that landing on an entry activates: the tab itself, or the view's active member.
 *
 * Activating that member is how a put-away view comes back with the tile it had focused (R4):
 * `activateTab` on a tab with no tile goes through `ArrangementController.restoreFor`.
 */
export function focusTabOf(entry: StripEntry): string {
  return entry.kind === 'tab' ? entry.tabId : entry.activeTabId
}

/**
 * The entry Ctrl+Tab (`step` 1) or Ctrl+Shift+Tab (`step` -1) lands on, from the active tab's entry.
 *
 * Entries rather than tabs, so a tiled view is one step (R13) and a folded group's members are none —
 * landing on one would put a page on screen the strip shows nothing for. Wraps round at both ends.
 * An active tab with no entry — hidden, gone, or `null` — starts from an end: forwards the first entry,
 * backwards the last. `null` only for a strip that draws no entry at all.
 */
export function nextStripEntry(
  items: readonly StripItem[],
  activeTabId: string | null,
  step: 1 | -1
): StripEntry | null {
  const entries = stripEntries(items)
  const current = entries.findIndex((entry) => holds(entry, activeTabId))
  // From "before the first" forwards, and from the first backwards — which wraps to the last.
  const from = current === -1 && step === -1 ? 0 : current
  // An empty strip makes this `NaN`, which indexes nothing: the one way to `null`.
  return entries[(from + step + entries.length) % entries.length] ?? null
}

function holds(entry: StripEntry, tabId: string | null): boolean {
  return entry.kind === 'tab' ? entry.tabId === tabId : entry.tabIds.some((id) => id === tabId)
}

function entryOf(unit: Unit, position: GroupPosition | null): StripEntry {
  if (unit.kind === 'tab') return { kind: 'tab', tabId: unit.tabId, group: unit.group, position }
  const { arrangement, tabIds } = unit
  return {
    kind: 'split',
    arrangementId: arrangement.id,
    tabIds: [...tabIds],
    // `tabIds` holds at least the member the run was started from.
    activeTabId: tabIds.find((tabId) => tabId === arrangement.activeTabId) ?? tabIds[0]!,
    group: unit.group,
    position
  }
}

function positionOf(index: number, total: number): GroupPosition {
  if (total === 1) return 'only'
  if (index === 0) return 'first'
  return index === total - 1 ? 'last' : 'middle'
}

/**
 * The strip as units — a tab, or a tiled view's run — over the group order.
 *
 * Every tab and every view is claimed once, the first claim winning, which matches `groupOfTab` and
 * `repairGroups` for groups and keeps a summary that names a tab twice from drawing it twice. A view
 * is started by the first of its members the group order reaches; its run is its members in tile
 * order that are here, not claimed by an earlier view, and in the same group as that first member
 * (or loose with it). A member left out of the run — held by another group — is a plain tab where
 * the group order put it.
 */
function unitsOf(
  tabOrder: readonly string[],
  groups: readonly TabGroup[],
  arrangements: readonly StripArrangement[]
): Unit[] {
  const grouped = contiguousOrder(tabOrder, groups)
  const present = new Set(grouped)

  const groupOf = new Map<string, TabGroup>()
  for (const group of groups) {
    for (const tabId of group.tabIds) if (!groupOf.has(tabId)) groupOf.set(tabId, group)
  }
  const viewOf = new Map<string, StripArrangement>()
  for (const arrangement of arrangements) {
    for (const tabId of arrangement.tabIds) {
      if (present.has(tabId) && !viewOf.has(tabId)) viewOf.set(tabId, arrangement)
    }
  }

  const placed = new Set<string>()
  const started = new Set<StripArrangement>()
  const units: Unit[] = []
  for (const tabId of grouped) {
    if (placed.has(tabId)) continue
    const group = groupOf.get(tabId) ?? null
    const arrangement = viewOf.get(tabId)
    if (arrangement === undefined || started.has(arrangement)) {
      placed.add(tabId)
      units.push({ kind: 'tab', tabId, group })
      continue
    }
    started.add(arrangement)
    const tabIds: string[] = []
    for (const member of arrangement.tabIds) {
      if (placed.has(member) || viewOf.get(member) !== arrangement) continue
      if ((groupOf.get(member) ?? null) !== group) continue
      placed.add(member)
      tabIds.push(member)
    }
    units.push({ kind: 'split', arrangement, tabIds, group })
  }
  return units
}
