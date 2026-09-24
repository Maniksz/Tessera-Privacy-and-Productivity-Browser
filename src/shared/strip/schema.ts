import { z } from 'zod'
import type { SameShape } from '../ipc/same-shape.js'
import { STRIP_DROP_SIDES, type StripDrop } from './drop.js'

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
