import {
  createLink,
  emptyQuickLinkDocument,
  moveLink,
  removeLink,
  repairTree,
  updateLink,
  type CreateLinkInput,
  type QuickLink,
  type QuickLinkDocument,
  type UpdateLinkPatch
} from '@shared/quicklinks/model.js'
import { quickLinkDocumentSchema } from '@shared/quicklinks/schema.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'

/**
 * Persistence for the start page's quick links (spec 1).
 *
 * All the tree rules live in `@shared/quicklinks/model.ts` as pure functions;
 * this class only supplies identity and time — the two things the pure layer
 * cannot produce without becoming untestable — and writes the result down.
 */

export interface QuickLinkStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so ids and timestamps are predictable. */
  generateId?: () => string
  now?: () => number
  debounceMs?: number
}

export class QuickLinkStore {
  readonly #store: JsonStore<QuickLinkDocument>
  readonly #generateId: () => string
  readonly #now: () => number

  private constructor(
    store: JsonStore<QuickLinkDocument>,
    generateId: () => string,
    now: () => number
  ) {
    this.#store = store
    this.#generateId = generateId
    this.#now = now
  }

  static async open(options: QuickLinkStoreOptions): Promise<QuickLinkStore> {
    const store = await JsonStore.open<QuickLinkDocument>({
      filePath: options.filePath,
      schema: quickLinkDocumentSchema,
      fallback: emptyQuickLinkDocument,
      // A hand-edited or partially written file must not leave items orphaned
      // and therefore invisible.
      repair: (document) => ({ ...document, links: repairTree(document.links) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new QuickLinkStore(
      store,
      options.generateId ?? defaultIdGenerator,
      options.now ?? (() => Date.now())
    )
  }

  list(): QuickLink[] {
    return [...this.#store.get().links]
  }

  create(input: CreateLinkInput): QuickLink {
    const id = this.#generateId()
    this.#store.update((document) => ({
      ...document,
      links: createLink(document.links, input, { id, now: this.#now() })
    }))
    const created = this.#store.get().links.find((link) => link.id === id)
    // `createLink` either throws or produces the entry, so this is a real
    // invariant rather than a defensive branch.
    if (created === undefined) throw new Error('quick link was not stored')
    return created
  }

  update(id: string, patch: UpdateLinkPatch): QuickLink {
    this.#store.update((document) => ({
      ...document,
      links: updateLink(document.links, id, patch)
    }))
    const updated = this.#store.get().links.find((link) => link.id === id)
    if (updated === undefined) throw new Error('quick link disappeared during update')
    return updated
  }

  remove(id: string): void {
    this.#store.update((document) => ({
      ...document,
      links: removeLink(document.links, id)
    }))
  }

  move(id: string, parentId: string | null, toIndex: number): void {
    this.#store.update((document) => ({
      ...document,
      links: moveLink(document.links, id, parentId, toIndex)
    }))
  }

  onChange(listener: (links: QuickLink[]) => void): () => void {
    return this.#store.onChange((document) => listener([...document.links]))
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#store.diagnostics.recoveredFromInvalidFile
  }
}

let counter = 0

/**
 * Ids only have to be unique within this file, so a counter plus the clock is
 * enough — and unlike `crypto.randomUUID()` it stays readable in a document a
 * user might open to inspect.
 */
function defaultIdGenerator(): string {
  counter += 1
  return `ql-${Date.now().toString(36)}-${counter.toString(36)}`
}
