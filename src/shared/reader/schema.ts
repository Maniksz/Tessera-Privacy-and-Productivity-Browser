import { z } from 'zod'
import { READER_MARKS } from './content.js'
import type { ReaderBlock, ReaderInline, ReaderTableRow } from './content.js'
import { REFUSAL_REASONS } from './outcome.js'
import type { ReaderArticle, ReaderMeasurement, ReaderOutcome } from './outcome.js'

/**
 * Runtime validation for `reader:get`.
 *
 * Its own file for the reason the rest of this directory has none: the reader page imports the
 * *types* to render an article, and a value import of the validation library in that bundle is about
 * half a megabyte of parse work on every window open. An architecture test follows value imports out
 * of `src/renderer` and forbids zod anywhere they reach, so nothing but the contract and the core may
 * import this file. Same split as `media/schema.ts` and `quicklinks/schema.ts`.
 *
 * The block schema is recursive — a blockquote holds blocks, a list item holds blocks — which `z.lazy`
 * expresses and a flattened encoding would not. Flattening was the alternative: quotes carrying only
 * inline runs, list items likewise. It would have been simpler here and wrong there, because a quoted
 * passage of three paragraphs would have rendered as one, which is the sort of quiet loss this whole
 * feature is written to avoid.
 *
 * The assignments at the bottom are the guard against the model and the schema drifting apart: two per
 * shape, one in each direction, the same idiom as `media/schema.ts`. Arrays are `.readonly()` so both
 * directions are expressible at all.
 */

const readerInlineSchema = z.object({
  text: z.string(),
  marks: z.array(z.enum(READER_MARKS)).readonly(),
  href: z.string().nullable()
})

const readerInlinesSchema = z.array(readerInlineSchema).readonly()

const readerTableRowSchema = z.object({
  header: z.boolean(),
  cells: z.array(readerInlinesSchema).readonly()
})

export const readerBlockSchema: z.ZodType<ReaderBlock> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('heading'),
      level: z.number().int().min(1).max(6),
      inlines: readerInlinesSchema
    }),
    z.object({ kind: z.literal('paragraph'), inlines: readerInlinesSchema }),
    z.object({ kind: z.literal('quote'), blocks: z.array(readerBlockSchema).readonly() }),
    z.object({
      kind: z.literal('list'),
      ordered: z.boolean(),
      items: z.array(z.object({ blocks: z.array(readerBlockSchema).readonly() })).readonly()
    }),
    z.object({ kind: z.literal('code'), text: z.string() }),
    z.object({
      kind: z.literal('figure'),
      src: z.string(),
      alt: z.string(),
      caption: readerInlinesSchema
    }),
    z.object({ kind: z.literal('table'), rows: z.array(readerTableRowSchema).readonly() })
  ])
)

const readerMeasurementSchema = z.object({
  mass: z.number().int().nonnegative(),
  documentMass: z.number().int().nonnegative(),
  required: z.number().int().nonnegative(),
  blocks: z.number().int().nonnegative(),
  linkDensity: z.number().min(0).max(1),
  truncated: z.boolean()
})

const readerArticleSchema = z.object({
  title: z.string().nullable(),
  byline: z.string().nullable(),
  publishedAt: z.string().nullable(),
  lang: z.string().nullable(),
  blocks: z.array(readerBlockSchema).readonly()
})

export const readerOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('article'),
    url: z.string(),
    article: readerArticleSchema,
    measurement: readerMeasurementSchema
  }),
  z.object({
    kind: z.literal('refused'),
    url: z.string(),
    reason: z.enum(REFUSAL_REASONS),
    measurement: readerMeasurementSchema
  })
])

/**
 * Which extraction to fetch.
 *
 * The id is in the reader page's own address, put there by the core when it opened the tab. It names
 * a result the user asked for, so there is nothing to guess at and nothing to enumerate: an id the
 * core is not holding answers with the `expired` refusal rather than with somebody else's article.
 */
export const readerGetRequestSchema = z.object({ id: z.string().min(1) })

export type ReaderGetRequest = z.output<typeof readerGetRequestSchema>

// Keeps each schema and its interface from drifting apart in either direction.
type SchemaInline = z.output<typeof readerInlineSchema>
type SchemaRow = z.output<typeof readerTableRowSchema>
type SchemaMeasurement = z.output<typeof readerMeasurementSchema>
type SchemaArticle = z.output<typeof readerArticleSchema>
type SchemaOutcome = z.output<typeof readerOutcomeSchema>

const _inlineMatchesModel: SchemaInline = null as unknown as ReaderInline
const _modelMatchesInline: ReaderInline = null as unknown as SchemaInline
const _rowMatchesModel: SchemaRow = null as unknown as ReaderTableRow
const _modelMatchesRow: ReaderTableRow = null as unknown as SchemaRow
const _measurementMatchesModel: SchemaMeasurement = null as unknown as ReaderMeasurement
const _modelMatchesMeasurement: ReaderMeasurement = null as unknown as SchemaMeasurement
const _articleMatchesModel: SchemaArticle = null as unknown as ReaderArticle
const _modelMatchesArticle: ReaderArticle = null as unknown as SchemaArticle
const _outcomeMatchesModel: SchemaOutcome = null as unknown as ReaderOutcome
const _modelMatchesOutcome: ReaderOutcome = null as unknown as SchemaOutcome
void _inlineMatchesModel
void _modelMatchesInline
void _rowMatchesModel
void _modelMatchesRow
void _measurementMatchesModel
void _modelMatchesMeasurement
void _articleMatchesModel
void _modelMatchesArticle
void _outcomeMatchesModel
void _modelMatchesOutcome
