import { z } from 'zod'
import { LAYOUT_IDS } from '../split/layout.js'
import type { SameShape } from '../ipc/same-shape.js'
import type { KnownFields } from '../known-fields.js'
import {
  MAX_WORKSPACE_NAME,
  SAVE_OUTCOMES,
  type Workspace,
  type WorkspaceDocument,
  type WorkspaceMenu
} from './model.js'

/**
 * What `workspaces.json` must look like, and what the layout menu's four channels carry (U21).
 *
 * Separate from `model.ts` for the reason the arrangements give: the overlay is a renderer, and zod must
 * not reach its bundle.
 *
 * ## One workspace this build cannot read costs that one
 *
 * The store parses the list entry by entry (`tolerant`, as for bookmarks), so a workspace a newer build
 * wrote with a layout this one does not have is kept raw and written back, never listed. That is why
 * `layoutId` does not heal: a `2x3` read as `1x1` would open as something the user never saved. The
 * quantities — a name too long, seats that do not match the layout, dividers it does not have — pass
 * here and are healed by `repairWorkspaces`.
 */
export const workspaceSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  layoutId: z.enum(LAYOUT_IDS),
  fractions: z.record(z.string(), z.number()),
  seats: z.array(z.string().nullable()),
  savedAt: z.number()
})

export const workspaceDocumentSchema = z.looseObject({
  version: z.literal(1),
  workspaces: z.array(workspaceSchema)
})

const menuSchema = z.strictObject({
  workspaces: z.array(
    z.strictObject({ id: z.string(), name: z.string(), layoutId: z.enum(LAYOUT_IDS) })
  ),
  canSave: z.boolean(),
  readOnly: z.boolean()
})

/** A name is checked again in the core; the bound here is only on what crosses. */
const id = z.string().min(1).max(200)

export const workspaceInvokeContract = {
  'workspaces:list': { request: z.void(), response: menuSchema },
  'workspaces:save': {
    request: z.strictObject({ name: z.string().max(MAX_WORKSPACE_NAME * 4), replace: z.boolean() }),
    response: z.strictObject({ outcome: z.enum(SAVE_OUTCOMES) })
  },
  'workspaces:open': {
    request: z.strictObject({ id }),
    response: z.strictObject({ outcome: z.enum(['opened', 'missing']) })
  },
  'workspaces:remove': {
    request: z.strictObject({ id }),
    response: z.strictObject({ outcome: z.enum(['removed', 'read-only']) })
  }
}

const _workspaceMatchesModel: SameShape<
  KnownFields<z.output<typeof workspaceSchema>>,
  Workspace
> = true
const _documentMatchesModel: SameShape<
  KnownFields<z.output<typeof workspaceDocumentSchema>>,
  WorkspaceDocument
> = true
const _menuMatchesModel: SameShape<z.output<typeof menuSchema>, WorkspaceMenu> = true
void _workspaceMatchesModel
void _documentMatchesModel
void _menuMatchesModel
