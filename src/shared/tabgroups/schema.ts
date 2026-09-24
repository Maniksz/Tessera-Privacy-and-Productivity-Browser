import { z } from 'zod'
import { TAB_GROUP_COLORS } from './palette.js'
import { MAX_TAB_GROUP_NAME_LENGTH, type TabGroup } from './model.js'

/**
 * A tab group as it crosses the UI/core boundary.
 *
 * Separate from the storage schema in `main/data/TabGroupStore.ts`, and strict where that one heals.
 * The difference is not an oversight — the two validate different things:
 *
 *   - The **storage** schema reads a file that may have been written by an older build, edited by
 *     hand or cut short by a crash. There, an unrecognised colour must become grey rather than cost
 *     the user every group, so it uses `.catch()`.
 *   - This one reads a message the core just produced from its own types. An unrecognised colour here
 *     means the core and the renderer disagree about the palette, which is a defect to surface rather
 *     than to paper over. Spec 6 asks for a typed boundary, and a boundary that quietly repairs its
 *     input is not one.
 *
 * Separate from `model.ts` for the usual reason: the tab strip is a renderer, and a value import of
 * zod there lands in a bundle the user waits for. An architecture test keeps it that way.
 */
/**
 * What crosses the boundary is what the user made, and nothing else.
 *
 * A `layout` used to be here too — the arrangement a group's tabs had been shown in. It has
 * moved off the group entirely (`src/shared/arrangements/`), and its removal lands in this
 * file alone: `src/shared/ipc/contract.ts` imports `tabGroupSchema` rather than restating
 * its fields, so `tabgroups:changed` narrows without a line of contract changing.
 */
export const tabGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.enum(TAB_GROUP_COLORS),
  collapsed: z.boolean(),
  tabIds: z.array(z.string().min(1)),
  createdAt: z.number().int().nonnegative()
})

export const tabGroupColorSchema = z.enum(TAB_GROUP_COLORS)

const ok = z.object({ ok: z.literal(true) })

/**
 * The `tabgroups:*` channels, spread into `invokeContract` the way the passwords', the omnibox's and
 * the workspaces' are.
 *
 * Here rather than in `src/shared/ipc/contract.ts` because that file is over the per-file line bar
 * and may not grow, and the chip's menu is a channel it would otherwise have had to gain. Chrome-only,
 * like every group channel: see the note in `channels.ts`.
 */
export const tabGroupInvokeContract = {
  /**
   * Groups the given tabs, in the order given.
   *
   * Takes the members up front rather than creating an empty group and filling it: a group with no
   * tabs is a chip with nothing behind it, and the model refuses one outright. The name may be
   * empty — an unnamed group draws as a bare colour, which is the useful state while the user is
   * still deciding, and demanding a name first would mean a dialogue before the group exists.
   */
  'tabgroups:create': {
    request: z.object({
      tabIds: z.array(z.string()).min(1),
      name: z.string().optional(),
      color: tabGroupColorSchema.optional()
    }),
    response: tabGroupSchema
  },
  'tabgroups:rename': {
    // Bounded here as well as trimmed by the model: a request is untrusted input, and the bound is
    // about what the strip can draw rather than about what the document may hold.
    request: z.object({ id: z.string(), name: z.string().max(MAX_TAB_GROUP_NAME_LENGTH) }),
    response: ok
  },
  'tabgroups:recolor': {
    request: z.object({ id: z.string(), color: tabGroupColorSchema }),
    response: ok
  },
  /** Folding a group hides its tabs and takes them out of their tiles; they stay loaded (spec 2). */
  'tabgroups:setCollapsed': {
    request: z.object({ id: z.string(), collapsed: z.boolean() }),
    response: ok
  },
  /** Removes the group and leaves its tabs alone, ungrouped. */
  'tabgroups:dissolve': { request: z.object({ id: z.string() }), response: ok },
  'tabgroups:addTab': {
    request: z.object({
      groupId: z.string(),
      tabId: z.string(),
      /** Position within the group; appended when omitted. */
      index: z.number().int().nonnegative().optional()
    }),
    response: ok
  },
  /** Takes one tab out. A group left with no members goes with it. */
  'tabgroups:removeTab': { request: z.object({ tabId: z.string() }), response: ok },
  /**
   * Opens the chip's own menu at the pointer: the group's colour, and ungrouping it.
   *
   * Takes the group, not a member, because a folded group has no member on screen to name. No
   * coordinates, for the reason `tabs:contextMenu` gives.
   */
  'tabgroups:contextMenu': { request: z.object({ id: z.string() }), response: ok }
}

// Keeps the schema and the interface from drifting apart in either direction. One assignment each
// way; a single one would only catch drift on one side.
type SchemaGroup = z.output<typeof tabGroupSchema>
const _schemaMatchesModel: SchemaGroup = null as unknown as TabGroup
const _modelMatchesSchema: TabGroup = null as unknown as SchemaGroup
void _schemaMatchesModel
void _modelMatchesSchema
