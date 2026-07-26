import { z } from 'zod'
import { LAYOUT_IDS } from '@shared/split/layout.js'
import {
  captureWindow,
  discardingSessionRecorder,
  emptySessionDocument,
  finishedRestore,
  forgetWindow,
  recordWindow,
  repairSession,
  startedRun,
  type CapturedWindow,
  type SessionDocument,
  type SessionRecorder,
  type SessionTab,
  type SessionWindow
} from '@shared/session/model.js'
import { planRestore, type RestorePlan, type RestoreSettings } from '@shared/session/restore.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
// The same named pair, imported rather than redeclared, so `'private'` means one thing
// across the core. `recorderFor` here and there are the same idea.
import type { BrowsingMode } from './HistoryStore.js'

/**
 * Persistence for the session: which tabs were open, where, and in which tile.
 *
 * All the rules live in `@shared/session/model.ts` and `@shared/session/restore.ts` as
 * pure functions; this class supplies identity, the filesystem and a clock, decides who
 * may write, and owns the ordering that the crash-loop guard depends on. The same
 * division `HistoryStore` and `TabGroupStore` use.
 *
 * The file belongs in the user-data directory, never the cache one: a cache clear or a
 * disk cleaner must not lose the arrangement a user had open. `paths.ts` keeps that
 * decision, which is why no path is assembled here.
 */

/**
 * What the file must look like to be usable.
 *
 * The line is the one `HistoryStore` and `TabGroupStore` draw: wrong *kinds* of data are
 * rejected, wrong *amounts* and wrong *values* are healed. A validation failure replaces
 * the whole document with defaults, so anything a future version might legitimately
 * change has to heal instead of failing:
 *
 *   - An unrecognised **layout** heals to `1x1`. Retiring a layout in a later version
 *     would otherwise delete every window that used it, tabs and all — the same argument
 *     as an unrecognised tab-group colour healing to grey.
 *   - A missing **pendingUrl**, **pinned**, **title**, **open**, **activeTile** or
 *     **fractions** heals to its default. None of them identifies a tab or a window, so
 *     none is worth the whole document, and each of them is a field an older build might
 *     simply not have written.
 *   - **Title length**, **window count** and **tab count** are quantities and are trimmed
 *     by `repairSession`, never capped here. `.max()` in a schema turns "grew larger than
 *     expected" into "lost the whole session".
 *
 * What stays strict is identity: the window id and the tab ids. A tab whose id is a
 * number is not a document this browser wrote, and defaults are the only safe answer —
 * and an id that is not a string is precisely the input that could produce two tabs
 * answering to one name once ids start coming back across a restart.
 */
const sessionTabSchema = z.object({
  id: z.string().min(1),
  url: z.string().catch(''),
  pendingUrl: z.string().nullable().catch(null),
  title: z.string().catch(''),
  pinned: z.boolean().catch(false),
  tileIndex: z.number().int().nullable().catch(null)
})

const sessionWindowSchema = z.object({
  id: z.string().min(1),
  open: z.boolean().catch(false),
  layout: z.enum(LAYOUT_IDS).catch('1x1'),
  fractions: z.record(z.string(), z.number()).catch({}),
  activeTile: z.number().int().catch(0),
  tabs: z.array(sessionTabSchema)
})

const sessionDocumentSchema = z.object({
  version: z.literal(1),
  windows: z.array(sessionWindowSchema),
  pendingRestores: z.number().int().nonnegative().catch(0)
})

/**
 * Keeps the schema and the interfaces from drifting apart in either direction — two
 * assignments per shape, one each way. A single one would only catch drift in one
 * direction, and the schema cannot live next to the interfaces: a restored strip is drawn
 * by a renderer, and zod must not reach its bundle.
 */
type SchemaTab = z.output<typeof sessionTabSchema>
type SchemaWindow = z.output<typeof sessionWindowSchema>
type SchemaDocument = z.output<typeof sessionDocumentSchema>

const _tabMatchesModel: SchemaTab = null as unknown as SessionTab
const _modelMatchesTab: SessionTab = null as unknown as SchemaTab
const _windowMatchesModel: SchemaWindow = null as unknown as SessionWindow
const _modelMatchesWindow: SessionWindow = null as unknown as SchemaWindow
const _documentMatchesModel: SchemaDocument = null as unknown as SessionDocument
const _modelMatchesDocument: SessionDocument = null as unknown as SchemaDocument
void _tabMatchesModel
void _modelMatchesTab
void _windowMatchesModel
void _modelMatchesWindow
void _documentMatchesModel
void _modelMatchesDocument

/**
 * How long the browser must stay up before a restore stops counting as unfinished.
 *
 * Long enough that a page which brings the process down has had its chance — a renderer
 * crash or an out-of-memory kill from twenty restored tabs happens while they are
 * loading, not half a minute later. Short enough that a user who quits deliberately soon
 * after starting is not treated as a crash: they would have to quit inside thirty
 * seconds twice in a row to lose the session, and the honest cost of getting that wrong
 * is one launch without a restore.
 */
export const RESTORE_SETTLE_MS = 30_000

export interface SessionStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so window slot ids are predictable. */
  generateId?: () => string
  debounceMs?: number
  /** Injected in tests so a run can settle without waiting half a minute. */
  settleMs?: number
}

export class SessionStore {
  readonly #store: JsonStore<SessionDocument>
  readonly #generateId: () => string
  readonly #settleMs: number
  #settleTimer: ReturnType<typeof setTimeout> | null = null
  #sealed = false

  private constructor(
    store: JsonStore<SessionDocument>,
    generateId: () => string,
    settleMs: number
  ) {
    this.#store = store
    this.#generateId = generateId
    this.#settleMs = settleMs
  }

  static async open(options: SessionStoreOptions): Promise<SessionStore> {
    const store = await JsonStore.open<SessionDocument>({
      filePath: options.filePath,
      schema: sessionDocumentSchema,
      fallback: emptySessionDocument,
      // A file written by an older build, edited by hand, or cut short by a crash must
      // not leave two tabs claiming one id, two tabs claiming one tile, or a tile the
      // layout does not have — the restore path and the split layout both rely on none
      // of those existing.
      repair: repairSession,
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new SessionStore(
      store,
      options.generateId ?? defaultSlotIdGenerator,
      options.settleMs ?? RESTORE_SETTLE_MS
    )
  }

  /**
   * Reads out the plan and opens a fresh run, in that order and in one call.
   *
   * One method rather than a `plan()` and a `beginRun()`, because the order between them
   * is the whole thing and an ordering rule is a convention someone can get wrong.
   * Reading after clearing yields an empty plan — a restore that silently does nothing —
   * and clearing late leaves the previous run's slots beside this run's, so the launch
   * after that opens every window twice.
   *
   * The write is **awaited**. The crash-loop counter is only a guard if it reaches the
   * disk before the first restored page is allowed to load; incremented afterwards it
   * would be written by every launch that survives and by none that does not, which is
   * precisely backwards.
   *
   * Called exactly once per process, before any window exists.
   */
  async beginRun(settings: RestoreSettings): Promise<RestorePlan> {
    const plan = planRestore(this.#store.get(), settings)
    const restoring = plan.kind === 'restore'
    this.#write((document) => startedRun(document, restoring))
    await this.#store.flush()
    if (restoring) this.#scheduleSettle()
    return plan
  }

  /**
   * The only way to obtain a writer, and it cannot be obtained without saying which kind
   * of session it is for.
   *
   * A private window gets `discardingSessionRecorder`, an object with no reference to this
   * store and with no slot allocated for it — so a private window physically holds no path
   * to the file rather than holding one it is expected to leave alone. That is the
   * difference between an invariant and a convention: no call site can forget a check it
   * does not have to make, and a `record` call added anywhere in a private window's code
   * inherits the guarantee for free. Exactly what `HistoryStore.recorderFor` does.
   *
   * The slot id is allocated *here* rather than passed in, which is what binds a recorder
   * to one window for its lifetime: two recorders can never write into each other's slot,
   * and a window cannot be talked into overwriting another's by a caller that got an
   * argument wrong.
   */
  recorderFor(mode: BrowsingMode): SessionRecorder {
    if (mode === 'private') return discardingSessionRecorder

    const slotId = this.#generateId()
    return {
      record: (window: CapturedWindow) => {
        this.#write((document) => recordWindow(document, captureWindow(slotId, window)))
      },
      close: () => {
        this.#write((document) => forgetWindow(document, slotId))
      }
    }
  }

  /**
   * Stops accepting writes, for shutdown.
   *
   * `before-quit` flushes the document while every window is still open, and only then
   * does the application quit — at which point each window closes and would ask its
   * recorder to drop its slot. Those writes are for a session that is over: they would
   * turn "three windows were open" into "one window, closed" on the way out, and whether
   * they landed at all would come down to whether the process outlived a debounce timer.
   * A shutdown whose result depends on that is a shutdown that behaves differently on a
   * slow machine.
   *
   * The settle timer goes with it, so a quit inside the settle window neither writes nor
   * holds the process.
   */
  seal(): void {
    this.#sealed = true
    if (this.#settleTimer !== null) {
      clearTimeout(this.#settleTimer)
      this.#settleTimer = null
    }
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#store.diagnostics.recoveredFromInvalidFile
  }

  /**
   * Every write goes through here, so the seal is checked in one place.
   *
   * A flag rather than a swapped-out cell, and the distinction from the private-mode seam
   * is worth naming: this one is about *when*, is set once at shutdown, and is read by two
   * call sites in this file. The private-mode guarantee is about *who*, and would be
   * unenforceable as a flag because it has to hold for code nobody has written yet.
   */
  #write(mutate: (document: SessionDocument) => SessionDocument): void {
    if (this.#sealed) return
    this.#store.update(mutate)
  }

  /**
   * Marks the restore finished once the browser has stayed up.
   *
   * Inside the store rather than a `restoreSucceeded()` for the entry point to remember,
   * because that is the shape of omission this project has already paid for: four stores
   * arrived with a `flush()` and none of them was registered at shutdown, each omission in
   * a different file from the store. A guard that a caller has to arm is a guard that is
   * eventually not armed — and an unarmed one here means the counter never clears and the
   * *third* launch refuses a session that is perfectly fine.
   */
  #scheduleSettle(): void {
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null
      this.#write(finishedRestore)
    }, this.#settleMs)
  }
}

let counter = 0

/**
 * Slot ids only have to be unique within one run of one process — nothing reads them
 * across a restart — so a counter plus the clock is enough, and unlike
 * `crypto.randomUUID()` it stays readable in a document a user might open to inspect.
 */
function defaultSlotIdGenerator(): string {
  counter += 1
  return `win-${Date.now().toString(36)}-${counter.toString(36)}`
}
