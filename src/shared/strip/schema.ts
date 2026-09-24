import { z } from 'zod'
import type { SameShape } from '../ipc/same-shape.js'
import { STRIP_DROP_SIDES, type StripDrop } from './drop.js'
import type { TileDragReport } from './tile-drag.js'

/**
 * A drop in the tab strip as it crosses the UI/core boundary (U9, KTD7).
 *
 * Apart from `drop.ts` for the usual reason: the strip is a renderer, and a value import of zod there
 * lands in a bundle the user waits for. Strict, as every request is: an empty id or an unknown side is
 * a strip and a core that disagree, not something to guess at.
 */

const id = z.string().min(1)

const subjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tab'), tabId: id }),
  z.object({ kind: z.literal('split'), arrangementId: id })
])

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tab'), tabId: id }),
  z.object({ kind: z.literal('split'), arrangementId: id }),
  z.object({ kind: z.literal('group'), groupId: id }),
  z.object({ kind: z.literal('end') })
])

export const stripDropSchema = z.object({
  subject: subjectSchema,
  target: targetSchema,
  side: z.enum(STRIP_DROP_SIDES)
})

/**
 * A place in the strip without a subject: where a tab released from its tiled view by a drag goes
 * (U10). The request of `arrangements:releaseTab` carries it as `at`.
 */
export const stripSpotSchema = z.object({ target: targetSchema, side: z.enum(STRIP_DROP_SIDES) })

/**
 * `drag:start`. `fromTile` for a drag begun at a tile bar's grip (U10): only such a drag can be let go
 * over the strip as a release, and only it is reported to the strip (`TileDragReport`). Absent for the
 * strip's own drag, which sees its whole stay over the strip itself.
 */
export const dragStartSchema = z.object({ tabId: z.string(), fromTile: z.boolean().optional() })

/** The `strip:tileDrag` event; see `TileDragReport`. */
export const tileDragReportSchema = z.object({
  tabId: id,
  point: z.object({ x: z.number(), y: z.number() }).nullable(),
  released: z.boolean()
})

const ok = z.object({ ok: z.literal(true) })

/**
 * The `strip:*` channels, spread into `invokeContract` like the groups' and the tiled views'.
 *
 * `strip:drop` replaces `tabs:move`: the strip names what the pointer is over and on which side, and
 * the core resolves that against its own order (`resolveStripDrop`) and applies it through the
 * groups, the owner of the strip's order. Chrome-only, like every channel that rearranges the strip.
 */
export const stripInvokeContract = {
  'strip:drop': { request: stripDropSchema, response: ok }
}

// Both directions at once; see `SameShape`.
const _dropWireMatchesModel: SameShape<z.output<typeof stripDropSchema>, StripDrop> = true
void _dropWireMatchesModel
const _tileDragWireMatchesModel: SameShape<
  z.output<typeof tileDragReportSchema>,
  TileDragReport
> = true
void _tileDragWireMatchesModel
