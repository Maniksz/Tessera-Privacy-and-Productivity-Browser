import { groupOfTab, type TabGroup } from './model.js'

/**
 * What the tab strip draws, in order.
 *
 * The strip is not a list of tabs any more: a group appears as a chip followed by its members, and a
 * folded group appears as a chip alone. Turning "tabs plus groups" into that sequence is a decision,
 * and it is here rather than in the component for the usual reason — a second implementation of it
 * (in a tile bar, in a tab-switcher overlay, in a test) would eventually disagree with the first.
 *
 * Pure and DOM-free, so the sequence can be checked directly. The interesting cases are all
 * boundaries: a group at the very start, two groups touching, a folded group between two loose tabs.
 */

/** Where a tab sits within its group, which is what lets the band have rounded ends. */
export type GroupPosition = 'only' | 'first' | 'middle' | 'last'

export type StripItem =
  | {
      kind: 'group'
      group: TabGroup
      /** Members not drawn, so a folded chip can say "3". Zero while the group is open. */
      hiddenCount: number
    }
  | {
      kind: 'tab'
      tabId: string
      /** The group this tab belongs to, or `null` for a loose tab. */
      group: TabGroup | null
      /** Only meaningful inside a group. */
      position: GroupPosition | null
    }

function positionOf(index: number, total: number): GroupPosition {
  if (total === 1) return 'only'
  if (index === 0) return 'first'
  return index === total - 1 ? 'last' : 'middle'
}

/**
 * Builds the sequence from an order that already has each group as one run.
 *
 * `order` is expected to be contiguous — the core settles it with `contiguousOrder` before sending
 * it — but this does not depend on that being true. A group whose members were somehow split would
 * simply get a second chip rather than dropping a tab or throwing, because a strip that renders
 * nothing is a worse failure than a strip that renders something odd.
 *
 * A group's chip is emitted when its *first* member is reached, so a group's position in the strip
 * follows from where its tabs are. Nothing stores a rank, which is what keeps drag-to-reorder and
 * grouping from needing to agree about anything.
 */
export function stripItems(
  order: readonly string[],
  groups: readonly TabGroup[]
): StripItem[] {
  const items: StripItem[] = []
  let openGroupId: string | null = null

  for (const tabId of order) {
    const group = groupOfTab(groups, tabId) ?? null

    if (group !== null && group.id !== openGroupId) {
      // The chip, once per run. `hiddenCount` is the whole membership while folded: every member is
      // hidden, including ones this window may not have (a stale id costs a wrong number, not a crash,
      // and `retainTabs` is what keeps that from happening).
      items.push({
        kind: 'group',
        group,
        hiddenCount: group.collapsed ? group.tabIds.length : 0
      })
    }
    openGroupId = group?.id ?? null

    // A folded group draws its chip and nothing else. The tabs are still loaded and running.
    if (group?.collapsed === true) continue

    const memberIndex = group === null ? -1 : group.tabIds.indexOf(tabId)
    items.push({
      kind: 'tab',
      tabId,
      group,
      position:
        group === null || memberIndex < 0 ? null : positionOf(memberIndex, group.tabIds.length)
    })
  }

  return items
}
