import { z } from 'zod'
import {
  emptyWindowPlacementDocument,
  samePlacement,
  type WindowPlacement,
  type WindowPlacementDocument
} from '@shared/window-placement/model.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
import type { BrowsingMode } from './HistoryStore.js'

/**
 * Persistence for where the last window was; see `@shared/window-placement/model.ts`.
 *
 * Its own file rather than a field in the session, because it has to survive a launch that restores
 * nothing — see that module's docblock. And its own small store rather than a setting, because it is
 * written every time a window is dragged and is nothing the user ever types.
 */

const boundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
})

/**
 * Strict about the rectangle and lenient about everything else.
 *
 * A rectangle with a missing or non-numeric side is not a place a window can be put, so it heals to
 * "nothing stored" — the default window, which is exactly what the user had before this file existed.
 * Losing it costs one resize; there is nothing here worth a partial repair.
 */
const documentSchema = z.object({
  version: z.literal(1),
  last: z
    .object({ bounds: boundsSchema, maximized: z.boolean().catch(false) })
    .nullable()
    .catch(null)
})

/** See `SessionStore` for why each shape is asserted in both directions. */
type SchemaDocument = z.output<typeof documentSchema>
const _documentMatchesModel: SchemaDocument = null as unknown as WindowPlacementDocument
const _modelMatchesDocument: WindowPlacementDocument = null as unknown as SchemaDocument
void _documentMatchesModel
void _modelMatchesDocument

/**
 * The write side a window is handed, already bound to its browsing mode.
 *
 * A private window gets one that keeps nothing. The size of a window says nothing about what was in
 * it, but "the placement changed while only private windows were open" is still a trace that one
 * existed — the same line `discardingSessionRecorder` draws for an empty slot.
 */
export interface PlacementRecorder {
  record(placement: WindowPlacement): void
}

const discardingPlacementRecorder: PlacementRecorder = { record: () => {} }

export interface WindowPlacementStoreOptions {
  filePath: string
  codec?: DocumentCodec
  debounceMs?: number
}

export class WindowPlacementStore {
  readonly #store: JsonStore<WindowPlacementDocument>
  readonly #recorder: PlacementRecorder = {
    record: (placement) => {
      // Focus and every step of a drag arrive here; only an actual change is worth a write.
      if (samePlacement(this.#store.get().last, placement)) return
      this.#store.update((document) => ({ ...document, last: placement }))
    }
  }

  private constructor(store: JsonStore<WindowPlacementDocument>) {
    this.#store = store
  }

  static async open(options: WindowPlacementStoreOptions): Promise<WindowPlacementStore> {
    const store = await JsonStore.open<WindowPlacementDocument>({
      filePath: options.filePath,
      schema: documentSchema,
      fallback: emptyWindowPlacementDocument,
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      // Longer than the default: a window being dragged reports a new position many times a second, and
      // only where it came to rest matters. `flush` on exit catches the last one.
      debounceMs: options.debounceMs ?? 1_000
    })
    return new WindowPlacementStore(store)
  }

  /** Where the last normal window was, or `null` before one has been placed. */
  last(): WindowPlacement | null {
    return this.#store.get().last
  }

  recorderFor(mode: BrowsingMode): PlacementRecorder {
    return mode === 'private' ? discardingPlacementRecorder : this.#recorder
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }
}
