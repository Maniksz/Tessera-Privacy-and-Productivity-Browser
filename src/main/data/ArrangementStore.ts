import {
  arrangementOfTab,
  cloneArrangements,
  emptyArrangementDocument,
  forgetArrangement,
  recordArrangement,
  repairArrangements,
  retainTabs,
  type Arrangement,
  type ArrangementDocument,
  type WindowTabs
} from '@shared/arrangements/model.js'
import { arrangementDocumentSchema } from '@shared/arrangements/schema.js'
import type { LayoutId } from '@shared/split/layout.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
// The same named pair, imported rather than redeclared, so `'private'` means one thing across
// the core. `recorderFor` there, `bookFor` in `TabGroupStore` and `bookFor` here are one idea.
import type { BrowsingMode } from './HistoryStore.js'

/**
 * Persistence for the tilings a window has put away.
 *
 * All the rules live in `@shared/arrangements/model.ts` as pure functions; this class supplies
 * identity and time — the two things the pure layer cannot produce without becoming untestable
 * — decides who may write, and puts the result on disk. The same division `TabGroupStore`,
 * `QuickLinkStore` and `HistoryStore` use.
 *
 * The file belongs in the user-data directory, never the cache one: a recording is how a user
 * gets their panes back, and a cache clear or a disk cleaner must not take it. `paths.ts` keeps
 * that decision, which is why no path is assembled here.
 *
 * ## Where the schema is, and why it is not in this file
 *
 * `TabGroupStore` declares its storage schema inline, and this one does not. The reason is the
 * `model.ts` / `schema.ts` split the arrangements module was built with (KTD4): the split view
 * is a renderer, zod must not reach its bundle, so the pure model and its validation already
 * live in two files next to each other with `SameShape` holding them together. A second copy of
 * that schema here would be a second account of what `arrangements.json` may contain, free to
 * disagree with the first — which is precisely the failure the two-way assertion over there
 * exists to prevent. The agreement is still checked in both directions on every build: it is
 * asserted by `SameShape` in `schema.ts`, and `JsonStore.open<ArrangementDocument>` below will
 * not accept a schema whose output is not that document.
 *
 * ## Window scoping is carried, never assumed
 *
 * Every recording of every ordinary window lives in one document, so which tabs the caller owns
 * and which of them are hidden cannot be read off the document. They arrive as a `WindowTabs`
 * on each call and are handed straight to the model. This store must not default them, fill
 * them in, or drop them: doing so would let one window evict or apply another's recording,
 * which is the whole of R16.
 */

/**
 * Everything a window may do with arrangements.
 *
 * Named as an interface rather than used as the class directly, so a caller cannot quietly
 * depend on holding the persisting implementation. A private window is handed one of these that
 * writes nothing, and nothing at the call site has to know.
 *
 * Mutations return nothing on purpose. The interface is fed by `onChange` with the whole list,
 * so returning the changed recording would create a second, narrower path for the same
 * information to travel down and disagree on. There is no exception here — unlike a tab group,
 * whose creation hands back an id so the strip can open a rename field, a recording is invisible
 * and nobody has an id to be told.
 *
 * `record` in particular answers nothing even when it *declines*: the model refuses a draft that
 * names another window's tab, and refuses to evict a protected recording to make room. Both are
 * ordinary outcomes of a pass that runs on every settle, not errors a caller could act on.
 */
export interface ArrangementBook {
  list(): Arrangement[]
  /** The recording a click on this tab should bring back, if there is one that may be applied. */
  arrangementOfTab(tabId: string, window: WindowTabs): Arrangement | undefined
  /** Writes down a tiling the window has just put away, evicting for it if it has to. */
  record(draft: ArrangementInput, window: WindowTabs): void
  forget(id: string): void
  /** Reconciles a loaded document with the tabs a session actually brought back. */
  retainTabs(liveTabIds: readonly string[]): void
  onChange(listener: (arrangements: Arrangement[]) => void): () => void
  flush(): Promise<void>
  readonly recoveredFromInvalidFile: boolean
}

/**
 * A tiling as a caller describes it: the model's draft without the two fields the store owns.
 *
 * `id` and `recordedAt` are not asked for, so no controller can invent either and no test of a
 * controller has to. That is the same reason `CreateGroupInput` exists next to `TabGroup`.
 */
export interface ArrangementInput {
  layoutId: LayoutId
  seats: ReadonlyArray<string | null>
}

/**
 * Where a book keeps its recordings.
 *
 * The seam that makes "a private window stores nothing" structural. There are exactly two
 * implementations: one backed by a `JsonStore`, one by a variable. Everything else — every rule,
 * every method of `ArrangementBook` — is written once against this interface, so the private path
 * cannot drift from the normal one by being the less exercised of two copies.
 */
interface ArrangementCell {
  read(): readonly Arrangement[]
  write(mutate: (arrangements: readonly Arrangement[]) => Arrangement[]): void
  onChange(listener: (arrangements: Arrangement[]) => void): () => void
  flush(): Promise<void>
  readonly recoveredFromInvalidFile: boolean
}

export interface ArrangementStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so ids and timestamps are predictable. */
  generateId?: () => string
  now?: () => number
  debounceMs?: number
}

export class ArrangementStore implements ArrangementBook {
  readonly #cell: ArrangementCell
  readonly #generateId: () => string
  readonly #now: () => number

  private constructor(cell: ArrangementCell, generateId: () => string, now: () => number) {
    this.#cell = cell
    this.#generateId = generateId
    this.#now = now
  }

  static async open(options: ArrangementStoreOptions): Promise<ArrangementStore> {
    const store = await JsonStore.open<ArrangementDocument>({
      filePath: options.filePath,
      schema: arrangementDocumentSchema,
      fallback: emptyArrangementDocument,
      // A file written by an older build, edited by hand or cut short by a crash must not leave
      // a seating that does not match its layout, a tab in two tiles, or more recordings than
      // the cap — the apply path and the eviction rule both rely on none of those existing.
      repair: (document) => ({ ...document, arrangements: repairArrangements(document.arrangements) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new ArrangementStore(
      persistedCell(store),
      options.generateId ?? defaultIdGenerator,
      options.now ?? (() => Date.now())
    )
  }

  /**
   * The only way to obtain a book, and it cannot be obtained without saying which kind of
   * session it is for.
   *
   * A private window gets a book over a `memoryCell` — an object with no reference to this
   * store, no file path and no `JsonStore`. So a private window physically holds no path to the
   * file, rather than holding one it is expected to leave alone. That is the difference between
   * an invariant and a convention: no call site can forget a check it does not have to make, and
   * a `record` call added anywhere in a private window's code inherits the guarantee for free.
   * Exactly what `HistoryStore.recorderFor` and `TabGroupStore.bookFor` do.
   *
   * A fresh book per call, so two private windows do not share recordings and neither sees the
   * normal session's — a private window that could bring back the normal session's panes would
   * leak it through the very interface that is supposed to keep nothing.
   *
   * Normal windows share this store, which is deliberate and is why `WindowTabs` travels on
   * every call: one document holds every window's recordings, and the caller's own tabs are what
   * keeps a window's activity confined to its own (R16).
   */
  bookFor(mode: BrowsingMode): ArrangementBook {
    if (mode === 'private') return new ArrangementStore(memoryCell(), this.#generateId, this.#now)
    return this
  }

  list(): Arrangement[] {
    return snapshot(this.#cell.read())
  }

  /**
   * Looks up in a snapshot rather than in the live list, so the recording handed out cannot be
   * mutated into the document. Costs a copy of a list capped at `MAX_ARRANGEMENTS` and read when
   * a person clicks something.
   */
  arrangementOfTab(tabId: string, window: WindowTabs): Arrangement | undefined {
    return arrangementOfTab(this.list(), tabId, window)
  }

  record(draft: ArrangementInput, window: WindowTabs): void {
    const complete = {
      id: this.#generateId(),
      layoutId: draft.layoutId,
      seats: draft.seats,
      recordedAt: this.#now()
    }
    this.#cell.write((arrangements) => recordArrangement(arrangements, complete, window))
  }

  forget(id: string): void {
    this.#cell.write((arrangements) => forgetArrangement(arrangements, id))
  }

  retainTabs(liveTabIds: readonly string[]): void {
    this.#cell.write((arrangements) => retainTabs(arrangements, liveTabIds))
  }

  onChange(listener: (arrangements: Arrangement[]) => void): () => void {
    return this.#cell.onChange(listener)
  }

  flush(): Promise<void> {
    return this.#cell.flush()
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#cell.recoveredFromInvalidFile
  }
}

/** A cell over the document on disk. */
function persistedCell(store: JsonStore<ArrangementDocument>): ArrangementCell {
  return {
    read: () => store.get().arrangements,
    write: (mutate) => {
      store.update((document) => ({ ...document, arrangements: mutate(document.arrangements) }))
    },
    onChange: (listener) => store.onChange((document) => listener(snapshot(document.arrangements))),
    flush: () => store.flush(),
    // Fixed at open: `JsonStore` decides it while reading the file and never revisits it.
    recoveredFromInvalidFile: store.diagnostics.recoveredFromInvalidFile
  }
}

/**
 * A cell that keeps its recordings in a variable, for private windows.
 *
 * It holds no file path and no `JsonStore`, which is the point: forgetting to check
 * `privateMode` cannot leak which pages sat beside which, because there is nothing here to leak
 * it into.
 */
function memoryCell(): ArrangementCell {
  let arrangements: readonly Arrangement[] = []
  const listeners = new Set<(arrangements: Arrangement[]) => void>()

  return {
    read: () => arrangements,
    write: (mutate) => {
      arrangements = mutate(arrangements)
      for (const listener of listeners) {
        try {
          listener(snapshot(arrangements))
        } catch (error) {
          // One bad listener must not stop the others, same as in `JsonStore`.
          console.error('[arrangements] listener threw:', error)
        }
      }
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    // Nothing to write and nothing to wait for. Present so shutdown can await every book it
    // holds without first asking which kind each one is.
    flush: () => Promise.resolve(),
    recoveredFromInvalidFile: false
  }
}

/**
 * A copy nobody else holds, seatings included.
 *
 * A shallow `[...arrangements]` would hand out the stored `seats` arrays, and a caller that
 * reseated one would have moved a page between panes without going through a rule.
 * `cloneArrangements` rather than a copy written out here, for the reason its own docblock
 * gives: the model owns how deep a recording is.
 */
function snapshot(arrangements: readonly Arrangement[]): Arrangement[] {
  return cloneArrangements(arrangements)
}

let counter = 0

/**
 * Ids only have to be unique within this file, so a counter plus the clock is enough — and
 * unlike `crypto.randomUUID()` it stays readable in a document a user might open to inspect.
 */
function defaultIdGenerator(): string {
  counter += 1
  return `ar-${Date.now().toString(36)}-${counter.toString(36)}`
}
