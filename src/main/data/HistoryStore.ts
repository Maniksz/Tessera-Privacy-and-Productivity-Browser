import { z } from 'zod'
import {
  discardingHistoryRecorder,
  emptyHistoryDocument,
  historyUrlOf,
  noteTitle,
  queryHistory,
  recordVisit,
  removeDomain,
  removeRange,
  removeVisit,
  repairHistory,
  type HistoryDocument,
  type HistoryQuery,
  type HistoryRecorder,
  type HistoryVisit,
  type TitleInput,
  type VisitInput
} from '@shared/history/model.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'

/**
 * Persistence for the browsing history.
 *
 * All the rules live in `@shared/history/model.ts` as pure functions; this class
 * supplies the clock, decides who may write, and puts the result on disk — the same
 * division `QuickLinkStore` uses.
 *
 * The file belongs in the user-data directory, never the cache one: `paths.ts` keeps
 * that decision, and it is why `historyFile()` exists there rather than a path being
 * assembled here.
 */

/**
 * What the file must look like to be usable.
 *
 * The line drawn here is deliberate: wrong *kinds* of data are rejected, wrong
 * *amounts* are healed. A string where a number belongs means the file is not ours and
 * defaults are the only safe answer, so the schema catches it. Too many entries, or a
 * title longer than we would write, is a quantity — and since a validation failure
 * throws the whole document away, a `.max()` here would turn "grew larger than
 * expected" into "lost the user's entire history". Those cases go to `repairHistory`
 * instead, which trims and merges.
 */
const historyVisitSchema = z.object({
  url: z.string().min(1),
  title: z.string(),
  firstVisitedAt: z.number().int().nonnegative(),
  lastVisitedAt: z.number().int().nonnegative(),
  visitCount: z.number().int().nonnegative()
})

const historyDocumentSchema = z.object({
  version: z.literal(1),
  visits: z.array(historyVisitSchema)
})

/**
 * Keeps the schema and the interface from drifting apart in either direction — two
 * assignments per shape, one each way. A single one would only catch drift in one
 * direction, and the schema cannot live next to the interface here because the history
 * page is a renderer and zod must not reach its bundle.
 */
type SchemaVisit = z.output<typeof historyVisitSchema>
type SchemaDocument = z.output<typeof historyDocumentSchema>

const _visitMatchesModel: SchemaVisit = null as unknown as HistoryVisit
const _modelMatchesVisit: HistoryVisit = null as unknown as SchemaVisit
const _documentMatchesModel: SchemaDocument = null as unknown as HistoryDocument
const _modelMatchesDocument: HistoryDocument = null as unknown as SchemaDocument
void _visitMatchesModel
void _modelMatchesVisit
void _documentMatchesModel
void _modelMatchesDocument

/**
 * Which session a recorder is for.
 *
 * A named pair rather than a boolean: `recorderFor(true)` reads as nothing at all at
 * the call site, and this is the one argument that must not be got backwards.
 */
export type BrowsingMode = 'normal' | 'private'

export interface HistoryStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so timestamps do not depend on when the test ran. */
  now?: () => number
  debounceMs?: number
}

export class HistoryStore {
  readonly #store: JsonStore<HistoryDocument>
  readonly #now: () => number

  private constructor(store: JsonStore<HistoryDocument>, now: () => number) {
    this.#store = store
    this.#now = now
  }

  static async open(options: HistoryStoreOptions): Promise<HistoryStore> {
    const store = await JsonStore.open<HistoryDocument>({
      filePath: options.filePath,
      schema: historyDocumentSchema,
      fallback: emptyHistoryDocument,
      // A file written by an older build, edited by hand, or cut short by a crash
      // must not leave duplicate entries or an unordered list, because the write path
      // relies on both.
      repair: (document) => ({ ...document, visits: repairHistory(document.visits) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new HistoryStore(store, options.now ?? (() => Date.now()))
  }

  /**
   * The only way to obtain a writer, and it cannot be obtained without saying which
   * kind of session it is for.
   *
   * A private window gets `discardingHistoryRecorder`, an object with no reference to
   * this store — so a private window physically holds no path to the file, rather than
   * holding one it is expected to leave alone. That is the difference between an
   * invariant and a convention: no call site can forget a check it does not have to
   * make, and a future `recordVisit` call added anywhere in the window's code inherits
   * the guarantee for free.
   *
   * Deletion is deliberately *not* behind this. Clearing history from a private window
   * acts on the normal session's history, which is exactly what the user asking for it
   * means.
   */
  recorderFor(mode: BrowsingMode): HistoryRecorder {
    if (mode === 'private') return discardingHistoryRecorder
    return {
      recordVisit: (input: VisitInput) => this.#recordVisit(input),
      noteTitle: (input: TitleInput) => this.#noteTitle(input)
    }
  }

  /** Matching entries, most recent first. Everything when asked for nothing. */
  query(criteria: HistoryQuery = {}): HistoryVisit[] {
    return queryHistory(this.#store.get().visits, criteria)
  }

  /** Number of entries removed, so a caller can report what happened. */
  removeVisit(url: string): number {
    return this.#replace((visits) => removeVisit(visits, url))
  }

  removeDomain(domainOrUrl: string): number {
    return this.#replace((visits) => removeDomain(visits, domainOrUrl))
  }

  removeRange(from: number, to: number): number {
    return this.#replace((visits) => removeRange(visits, from, to))
  }

  /** Everything. This is what `clearData.onExitCategories` containing `history` runs. */
  clear(): number {
    return this.#replace(() => [])
  }

  onChange(listener: (visits: HistoryVisit[]) => void): () => void {
    return this.#store.onChange((document) => listener([...document.visits]))
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#store.diagnostics.recoveredFromInvalidFile
  }

  #recordVisit(input: VisitInput): void {
    // Asked here as well as inside the pure function, and not redundantly: without
    // this, a navigation to `about:blank` would still schedule a file write and wake
    // every listener to deliver an unchanged list.
    if (historyUrlOf(input.url) === null) return
    this.#store.update((document) => ({
      ...document,
      visits: recordVisit(document.visits, input, { now: this.#now() })
    }))
  }

  #noteTitle(input: TitleInput): void {
    const url = historyUrlOf(input.url)
    if (url === null) return
    // A title can arrive for a page that has no entry: the user cleared the history
    // between the navigation and the title, or the entry was pruned. Same reason as
    // above — nothing to change means no write and no listener woken.
    if (!this.#store.get().visits.some((visit) => visit.url === url)) return
    this.#store.update((document) => ({
      ...document,
      visits: noteTitle(document.visits, input)
    }))
  }

  /**
   * Applies a deletion and reports how many entries went.
   *
   * The count is taken by difference rather than by the pure functions returning it:
   * every one of them would then have to carry a count through, and the store already
   * holds both lists.
   *
   * Unlike the recording path, a deletion that matches nothing still writes. Deletions
   * come from a person clicking something, not from every navigation, so one redundant
   * write is cheaper than a guard that has to be right.
   */
  #replace(remove: (visits: readonly HistoryVisit[]) => HistoryVisit[]): number {
    const before = this.#store.get().visits.length
    const after = this.#store.update((document) => ({
      ...document,
      visits: remove(document.visits)
    }))
    return before - after.visits.length
  }
}
