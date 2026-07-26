import { z } from 'zod'
import { MAX_QUICK_LINKS, MAX_TITLE_LENGTH, QUICK_LINK_KINDS } from './model.js'
import type { QuickLink, QuickLinkDocument } from './model.js'
import type { QuickLinkCard } from './cards.js'

/**
 * Runtime validation for quick links.
 *
 * Separate from `model.ts` on purpose: only the core and the IPC contract import
 * this, so zod never reaches a renderer bundle. See the note at the top of
 * `model.ts` — the split is worth about half a megabyte of startup parse work,
 * which matters most on the machines that can least afford it.
 *
 * The four typed assignments below are the guard against the split becoming a lie:
 * two per shape, one in each direction. If `model.ts` gains a field the schema does
 * not describe, or the schema describes a shape the interface does not have, the
 * type check fails. A single assignment would only catch drift in one direction.
 */

export const quickLinkKindSchema = z.enum(QUICK_LINK_KINDS)

export const quickLinkSchema = z.object({
  id: z.string().min(1),
  kind: quickLinkKindSchema,
  title: z.string().max(MAX_TITLE_LENGTH),
  url: z.string(),
  parentId: z.string().nullable(),
  createdAt: z.number().int().nonnegative()
})

/**
 * A link as the start page receives it: the stored fields plus where its picture comes from.
 *
 * Separate from `quickLinkSchema` on purpose. That one describes what goes on disk, and the two
 * addresses must never end up there — they are derived from caches that expire, so a stored copy
 * could only ever be wrong. See `quicklinks/cards.ts`.
 */
export const quickLinkCardSchema = quickLinkSchema.extend({
  thumbnailUrl: z.string().nullable(),
  faviconUrl: z.string().nullable()
})

export const quickLinkDocumentSchema = z.object({
  version: z.literal(1),
  links: z.array(quickLinkSchema).max(MAX_QUICK_LINKS)
})

// Keeps the schema and the interface from drifting apart in either direction.
type SchemaLink = z.output<typeof quickLinkSchema>
type SchemaDocument = z.output<typeof quickLinkDocumentSchema>

type SchemaCard = z.output<typeof quickLinkCardSchema>

const _cardMatchesModel: SchemaCard = null as unknown as QuickLinkCard
const _modelMatchesCard: QuickLinkCard = null as unknown as SchemaCard
void _cardMatchesModel
void _modelMatchesCard

const _linkMatchesModel: SchemaLink = null as unknown as QuickLink
const _modelMatchesLink: QuickLink = null as unknown as SchemaLink
const _documentMatchesModel: SchemaDocument = null as unknown as QuickLinkDocument
const _modelMatchesDocument: QuickLinkDocument = null as unknown as SchemaDocument
void _linkMatchesModel
void _modelMatchesLink
void _documentMatchesModel
void _modelMatchesDocument
