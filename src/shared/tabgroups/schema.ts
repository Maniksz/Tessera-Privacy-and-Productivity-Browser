import { z } from 'zod'
import { LAYOUT_IDS } from '../split/layout.js'
import { TAB_GROUP_COLORS } from './palette.js'
import type { TabGroup } from './model.js'

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
 * The displaced arrangement, if the group is carrying one.
 *
 * Crosses the boundary because `tabgroups:changed` carries whole groups and the two-way
 * assertion below is what stops the core and the strip from disagreeing about their shape.
 * Nothing in the strip draws it today — the arrangement is acted on in the core, by a
 * click the core already receives — so this is the shape being kept honest rather than a
 * capability being handed to a renderer.
 */
const tabGroupLayoutSchema = z.object({
  id: z.enum(LAYOUT_IDS),
  tiles: z.array(z.string().min(1).nullable())
})

export const tabGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.enum(TAB_GROUP_COLORS),
  collapsed: z.boolean(),
  tabIds: z.array(z.string().min(1)),
  createdAt: z.number().int().nonnegative(),
  layout: tabGroupLayoutSchema.optional()
})

export const tabGroupColorSchema = z.enum(TAB_GROUP_COLORS)

// Keeps the schema and the interface from drifting apart in either direction. One assignment each
// way; a single one would only catch drift on one side.
type SchemaGroup = z.output<typeof tabGroupSchema>
const _schemaMatchesModel: SchemaGroup = null as unknown as TabGroup
const _modelMatchesSchema: TabGroup = null as unknown as SchemaGroup
void _schemaMatchesModel
void _modelMatchesSchema
