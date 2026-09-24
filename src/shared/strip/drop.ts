import {
  addTabToGroup,
  groupInsertionSteps,
  groupOfTab,
  removeTabFromGroup,
  type TabGroup
} from '../tabgroups/model.js'
import { stripOrder, viewOfTab, type StripArrangement } from './model.js'

/**
 * A drop in the tab strip, resolved (U9, R12, KTD7): where a dragged tab or tiled view goes, and which
 * group it is in afterwards.
 *
 * ## A target and a side, not an index
 *
 * The strip used to send "insert at index n", counted over the tabs it drew, and the core spliced that
 * into its own order — which holds the tabs a folded group hides, and now the members of every tiled
 * view as well. The two counts disagreed by one place per hidden tab. So the strip says what the
 * pointer is over — a tab, a view's entry, a group's chip, or the end of the strip — and on which side,
 * and this decides the rest against the order the core actually has. Nothing is counted twice.
 *
 * ## The rule for groups
 *
 * The drop's place decides the group, so a drop never lands somewhere the settle then pulls it out of:
 *
 *   - beside a tab or an entry in a group: into that group, at that place;
 *   - just behind an open chip: first in its group;
 *   - onto a folded chip (its after side): last in its group, and folded away with it;
 *   - before any chip, beside a loose tab or entry, or at the end of the strip: in no group.
 *
 * A tiled view moves as one — its members in tile order, into or out of the group together (R10) —
 * whether the entry was dragged or one of its tabs was named. Dropping anything on a view's entry only
 * places it beside the view; it never joins the view (the plan's scope boundary: no merging).
 *
 * Pure and zod-free, because the strip imports it too: it asks the same question to mark whether the
 * drop under the pointer would join a group.
 */

export const STRIP_DROP_SIDES = ['before', 'after'] as const
export type StripDropSide = (typeof STRIP_DROP_SIDES)[number]

/** What is being dragged: a tab, or a tiled view's entry by its id. */
export type StripDropSubject =
  { kind: 'tab'; tabId: string } | { kind: 'split'; arrangementId: string }

/** What the pointer is over. `end` is past the last entry, where nothing is but the new-tab button. */
export type StripDropTarget =
  StripDropSubject | { kind: 'group'; groupId: string } | { kind: 'end' }

export interface StripDrop {
  subject: StripDropSubject
  target: StripDropTarget
  /** Ignored for `end`, which has only one side. */
  side: StripDropSide
}

export interface StripDropPlan {
  /** The tabs that move: the one tab, or every member of its view in tile order. */
  tabIds: string[]
  /** The window's order afterwards, settled as `stripOrder` settles it. */
  order: string[]
  /** The group the moved tabs are in afterwards, or `null` for none. */
  groupId: string | null
  /** Where in that group, counted among its members that did not move; `0` for no group. */
  index: number
}

/** Where the moved tabs go: a place in the order without them, and a group or none. */
interface Place {
  at: number
  groupId: string | null
  index: number
}

/**
 * The drop, applied to the order and the groups — or `null` when it moves nothing: a subject or target
 * this window does not have, or a subject dropped on itself.
 */
export function resolveStripDrop(
  tabOrder: readonly string[],
  groups: readonly TabGroup[],
  arrangements: readonly StripArrangement[],
  drop: StripDrop
): StripDropPlan | null {
  const order = stripOrder(tabOrder, groups, arrangements)
  const moving = subjectTabs(drop.subject, order, arrangements)
  if (moving.length === 0) return null
  const rest = order.filter((tabId) => !moving.includes(tabId))
  // Where the subject stood, counted in `rest`: every tab before its first one stays.
  const slot = order.findIndex((tabId) => moving.includes(tabId))

  const place = placeOf(drop, rest, slot, moving, groups, arrangements)
  if (place === null) return null

  const next = [...rest.slice(0, place.at), ...moving, ...rest.slice(place.at)]
  const regrouped =
    place.groupId === null
      ? moving.reduce<TabGroup[]>((held, tabId) => removeTabFromGroup(held, tabId), [...groups])
      : joined(groups, place.groupId, moving, place.index)
  return {
    tabIds: moving,
    order: stripOrder(next, regrouped, arrangements),
    groupId: place.groupId,
    index: place.index
  }
}

/**
 * The tabs a drag moves, in the order they move in: a view's members in tile order — for its entry,
 * and for one of its tabs, since a view is only ever moved whole — or the tab alone. Empty for what the
 * strip does not have.
 */
function subjectTabs(
  subject: StripDropSubject,
  order: readonly string[],
  arrangements: readonly StripArrangement[]
): string[] {
  const view =
    subject.kind === 'split'
      ? arrangements.find((arrangement) => arrangement.id === subject.arrangementId)
      : viewOfTab(arrangements, subject.tabId)
  const tabIds = view?.tabIds ?? (subject.kind === 'tab' ? [subject.tabId] : [])
  return [...new Set(tabIds)].filter((tabId) => order.includes(tabId))
}

function placeOf(
  drop: StripDrop,
  rest: readonly string[],
  slot: number,
  moving: readonly string[],
  groups: readonly TabGroup[],
  arrangements: readonly StripArrangement[]
): Place | null {
  const { target, side } = drop
  if (target.kind === 'end') return { at: rest.length, groupId: null, index: 0 }
  if (target.kind === 'group') {
    const group = groups.find((candidate) => candidate.id === target.groupId)
    return group === undefined ? null : besideChip(group, side, rest, slot, moving)
  }

  /*
    A tab or an entry: its whole unit, so nothing lands between a view's members. Read from `rest`, so
    a target that is moving — the subject itself, or its own view — has no unit and moves nothing.
  */
  const unit = subjectTabs(target, rest, arrangements)
  if (unit.length === 0) return null

  const seats = unit.map((tabId) => rest.indexOf(tabId))
  const from = Math.min(...seats)
  const to = Math.max(...seats) + 1
  const at = side === 'before' ? from : to
  const group = groupOfTab(groups, rest[from]!)
  if (group === undefined) return { at, groupId: null, index: 0 }

  const others = group.tabIds.filter((tabId) => !moving.includes(tabId))
  const inGroup = unit.map((tabId) => others.indexOf(tabId)).filter((seat) => seat !== -1)
  const index = side === 'before' ? Math.min(...inGroup) : Math.max(...inGroup) + 1
  return { at, groupId: group.id, index }
}

/**
 * Before a chip is outside its group; behind an open one is first in it; behind a folded one — onto
 * it, as the strip reads the pointer — is last in it.
 */
function besideChip(
  group: TabGroup,
  side: StripDropSide,
  rest: readonly string[],
  slot: number,
  moving: readonly string[]
): Place {
  const seats = group.tabIds.map((tabId) => rest.indexOf(tabId)).filter((seat) => seat !== -1)
  // A group whose members are all moving stands where they stood.
  const from = seats.length === 0 ? slot : Math.min(...seats)
  const to = seats.length === 0 ? slot : Math.max(...seats) + 1
  if (side === 'before') return { at: from, groupId: null, index: 0 }
  if (!group.collapsed) return { at: from, groupId: group.id, index: 0 }
  const others = group.tabIds.filter((tabId) => !moving.includes(tabId))
  return { at: to, groupId: group.id, index: others.length }
}

/**
 * The groups with these tabs placed in one of them, from `index` among its members that are not
 * moving, as `TabGroupController.addTab` places them: the same `groupInsertionSteps`, applied here to
 * the groups instead of the book. See there for why a tiled view takes two passes.
 */
function joined(
  groups: readonly TabGroup[],
  groupId: string,
  tabIds: readonly string[],
  index: number
): TabGroup[] {
  let next = [...groups]
  for (const step of groupInsertionSteps(tabIds, index)) {
    next = addTabToGroup(next, groupId, step.tabId, step.index)
  }
  return next
}
