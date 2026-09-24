import { isDeepStrictEqual } from 'node:util'
import {
  arrangementOfTab,
  cloneArrangements,
  createArrangement,
  defaultArrangementView,
  emptyArrangementDocument,
  forgetArrangement,
  forgetArrangementsOfTabs,
  reconcileArrangements,
  removeTabFromArrangements,
  repairArrangements,
  retainTabs,
  seatedTabs,
  updateArrangement,
  type Arrangement,
  type ArrangementDocument,
  type ArrangementPatch,
  type ArrangementView,
  type WindowTabs
} from '@shared/arrangements/model.js'
import { arrangementDocumentSchema } from '@shared/arrangements/schema.js'
import { LAYOUT_IDS, type LayoutId } from '@shared/split/layout.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
import type { StoreLoadReport, StoreMigrations } from './store-load.js'
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
 * Membership changes only through the named operations below (KTD2): `create`, `update`,
 * `removeTab`, `forgetTabs`, `forget` and `retainTabs`. There is no `record` that replaces an
 * overlapping arrangement any more — see the header of `@shared/arrangements/model.ts`.
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
 * them in, or drop them: doing so would let one window change or apply another's recording,
 * which is the whole of R16.
 */

/**
 * Everything a window may do with arrangements.
 *
 * Named as an interface rather than used as the class directly, so a caller cannot quietly
 * depend on holding the persisting implementation. A private window is handed one of these that
 * writes nothing, and nothing at the call site has to know.
 *
 * Mutations return nothing on purpose, with one exception. The interface is fed by `onChange`
 * with the whole list, so returning the changed arrangement would create a second, narrower path
 * for the same information to travel down and disagree on. The exception is `create`, for the
 * reason `TabGroupBook.create` has one: the window that creates an arrangement is showing it and
 * has to know which entry in the strip is the visible one (KTD1). It answers `undefined` when the
 * model refuses — a tab of another window, a tab already in another arrangement — which on the
 * settle path is an ordinary outcome, not an error.
 *
 * Nothing here makes room. There is no cap and no eviction (KTD3), so a window that tiles forty
 * times holds forty arrangements until it closes them, closes their tabs or closes itself.
 */
export interface ArrangementBook {
  list(): Arrangement[]
  /** The recording a click on this tab should bring back, if there is one that may be applied. */
  arrangementOfTab(tabId: string, window: WindowTabs): Arrangement | undefined
  /** A new arrangement for a tiling that has just come into being; its id, or `undefined` if refused. */
  create(draft: ArrangementInput, window: WindowTabs): string | undefined
  /** Changes one arrangement under the id it has; see `updateArrangement`. */
  update(id: string, patch: ArrangementPatch, window: WindowTabs): void
  /** A tab has closed: its tile goes empty, and an arrangement left too thin goes. */
  removeTab(tabId: string): void
  /** Forgets every arrangement that seats one of these tabs, for a window that has closed. */
  forgetTabs(tabIds: readonly string[]): void
  forget(id: string): void
  /** Reconciles a loaded document with the tabs a session actually brought back. */
  retainTabs(liveTabIds: readonly string[]): void
  /**
   * Drops every arrangement that reaches over a boundary of these member sets; see
   * `reconcileArrangements`. Plain sets of tab ids, so the book learns nothing about what made
   * them (KTD15).
   */
  reconcile(memberSets: ReadonlyArray<readonly string[]>): void
  onChange(listener: (arrangements: Arrangement[]) => void): () => void
  flush(): Promise<void>
  readonly recoveredFromInvalidFile: boolean
  readonly loadReport: StoreLoadReport
}

/**
 * A tiling as a caller describes it: the model's draft without the two fields the store owns.
 *
 * `id` and `recordedAt` are not asked for, so no controller can invent either and no test of a
 * controller has to. That is the same reason `CreateGroupInput` exists next to `TabGroup`. The
 * view is optional and starts from `defaultArrangementView` when left out.
 */
export interface ArrangementInput extends Partial<ArrangementView> {
  layoutId: LayoutId
  seats: ReadonlyArray<string | null>
}

/**
 * The steps from each older `arrangements.json` to the version this build writes. See
 * `StoreMigrations`.
 *
 * 1 → 2 gives every arrangement the view it starts with — `activeTile` 0, the layout's default
 * dividers, every tile loud — and nothing else (KTD15, step 1). Only what is missing is added, so
 * an entry that already carries a field keeps it. Deliberately nothing about groups or overlaps:
 * the file is read before any tab or group exists, so those are `reconcileArrangements`' to judge
 * at session restore, where both are known. The id stays, which is the point of migrating rather
 * than starting afresh — a session slot naming an arrangement must still name it.
 *
 * As a migration rather than schema healing because of what a migration brings with it: the
 * original kept as `arrangements.json.v1.bak`, and a file from a newer build left alone. Anything
 * that is not an arrangement with a layout this build knows is passed on untouched for the schema
 * and `repairArrangements` to judge, so this step never decides on its own that a file is broken.
 */
export const ARRANGEMENT_MIGRATIONS: StoreMigrations = [
  (document) => ({
    ...document,
    version: 2,
    arrangements: Array.isArray(document['arrangements'])
      ? document['arrangements'].map((entry: unknown) => withStartingView(entry))
      : document['arrangements']
  })
]

function withStartingView(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
  const record = entry as Record<string, unknown>
  const layoutId = LAYOUT_IDS.find((id) => id === record['layoutId'])
  if (layoutId === undefined) return entry
  return { ...defaultArrangementView(layoutId), ...record }
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
  discardCopies(): Promise<void>
  abandon(): Promise<void>
  readonly recoveredFromInvalidFile: boolean
  readonly loadReport: StoreLoadReport
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
      migrations: ARRANGEMENT_MIGRATIONS,
      // A recording is one drag to rebuild, so a file this build cannot write back costs this run's
      // recordings and nothing a user made by hand.
      criticality: 'degradable',
      // A file written by an older build, edited by hand or cut short by a crash must not leave
      // a seating that does not match its layout, a tab in two tiles, or a view that does not
      // fit its layout — the apply path relies on none of those existing.
      repair: (document) => ({
        ...document,
        arrangements: repairArrangements(document.arrangements)
      }),
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
   * mutated into the document. Costs a copy of a short list, read when a person clicks something.
   */
  arrangementOfTab(tabId: string, window: WindowTabs): Arrangement | undefined {
    return arrangementOfTab(this.list(), tabId, window)
  }

  /**
   * The only place an id is made (KTD1).
   *
   * A refusal writes nothing, and neither does an update that changes nothing (U2). Both are asked
   * from the window's broadcast round, on every round while the screen shows a tiling: a refusal
   * that stands — a seating that mixes two arrangements — or a view already written would otherwise
   * hand the file a document on every pass. `ArrangementController.keep` gates the common steady
   * state before it reaches here; this is the net for the states its gates cannot see, decided by
   * what the model answered rather than by a second opinion about what it would answer.
   */
  create(draft: ArrangementInput, window: WindowTabs): string | undefined {
    const complete = { ...draft, id: this.#generateId(), recordedAt: this.#now() }
    const next = createArrangement(this.#cell.read(), complete, window)
    if (!next.some((held) => held.id === complete.id)) return undefined
    this.#cell.write(() => next)
    return complete.id
  }

  update(id: string, patch: ArrangementPatch, window: WindowTabs): void {
    const current = this.#cell.read()
    const next = updateArrangement(current, id, patch, window)
    if (isDeepStrictEqual(next, current)) return
    this.#cell.write(() => next)
  }

  /**
   * Every tab that closes in any window reaches this, and almost none sits in an arrangement.
   * A write publishes, so the store is left alone unless there is a seat to empty — gated here
   * rather than at each caller, because the question is only "does any arrangement seat it".
   */
  removeTab(tabId: string): void {
    if (!this.#seatsAny([tabId])) return
    this.#cell.write((arrangements) => removeTabFromArrangements(arrangements, tabId))
  }

  /** Gated like `removeTab`: a window closing with no arrangement writes nothing. */
  forgetTabs(tabIds: readonly string[]): void {
    if (!this.#seatsAny(tabIds)) return
    this.#cell.write((arrangements) => forgetArrangementsOfTabs(arrangements, tabIds))
  }

  forget(id: string): void {
    this.#cell.write((arrangements) => forgetArrangement(arrangements, id))
  }

  retainTabs(liveTabIds: readonly string[]): void {
    this.#cell.write((arrangements) => retainTabs(arrangements, liveTabIds))
  }

  reconcile(memberSets: ReadonlyArray<readonly string[]>): void {
    this.#cell.write((arrangements) => reconcileArrangements(arrangements, memberSets))
  }

  onChange(listener: (arrangements: Arrangement[]) => void): () => void {
    return this.#cell.onChange(listener)
  }

  flush(): Promise<void> {
    return this.#cell.flush()
  }

  /**
   * Removes the file's backup and quarantine copies and its temporaries, after writing what is
   * pending, for a deletion path that empties the recordings. See `JsonStore.discardCopies`.
   */
  discardCopies(): Promise<void> {
    return this.#cell.discardCopies()
  }

  /** The file given up for good, for panic; see `JsonStore.abandon`. */
  abandon(): Promise<void> {
    return this.#cell.abandon()
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#cell.recoveredFromInvalidFile
  }

  /** What opening the file found, for the warning `index.ts` logs. See `describeStoreLoad`. */
  get loadReport(): StoreLoadReport {
    return this.#cell.loadReport
  }

  #seatsAny(tabIds: readonly string[]): boolean {
    return this.#cell
      .read()
      .some((held) => seatedTabs(held.seats).some((tabId) => tabIds.includes(tabId)))
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
    discardCopies: () => store.discardCopies(),
    abandon: () => store.abandon(),
    // Fixed at open: `JsonStore` decides it while reading the file and never revisits it.
    recoveredFromInvalidFile: store.diagnostics.recoveredFromInvalidFile,
    loadReport: store.loadReport
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
    discardCopies: () => Promise.resolve(),
    abandon: () => Promise.resolve(),
    recoveredFromInvalidFile: false,
    loadReport: { outcome: { kind: 'missing' }, criticality: 'degradable' }
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
