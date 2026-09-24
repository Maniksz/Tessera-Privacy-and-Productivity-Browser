import {
  emptyWorkspaceDocument,
  removeWorkspace,
  repairWorkspaces,
  saveWorkspace,
  summarize,
  type Workspace,
  type WorkspaceDocument,
  type WorkspaceDraft,
  type WorkspaceSummary
} from '@shared/workspaces/model.js'
import { workspaceDocumentSchema, workspaceSchema } from '@shared/workspaces/schema.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
import type { StoreLoadReport, StoreMigrations } from './store-load.js'

/**
 * Persistence for workspaces (U21, R35): layouts with a page per tile, saved under a name.
 *
 * Every rule is in `@shared/workspaces/model.ts`; this class supplies the id and the clock and puts the
 * result in the user-data directory, which `paths.ts` decides. The division `BookmarkStore` uses.
 *
 * ## Critical, and why that took an architecture test changing
 *
 * A workspace is made by hand, like a bookmark, and nothing else can recreate it. A `degradable` store
 * would run a newer version's file on defaults and drop every save at exit while the menu said it had
 * worked. So a newer file is listed and opened, and `save` and `remove` answer `read-only` before
 * anything changes — an answer the menu shows, rather than the `ReadOnlyStoreError` a write would throw.
 *
 * ## No recorder per browsing mode
 *
 * A private window may open a workspace and may not save one. That is the save handler's refusal
 * (`workspace-handlers.ts`), not a store bound to the mode: opening reads and writes nothing here.
 */

/** Version 1 is the only one there has been; see `StoreMigrations`. Read by the backup (U23). */
export const WORKSPACE_MIGRATIONS: StoreMigrations = []

export interface WorkspaceStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so ids and timestamps are predictable. */
  generateId?: () => string
  now?: () => number
  debounceMs?: number
}

export class WorkspaceStore {
  readonly #store: JsonStore<WorkspaceDocument>
  readonly #generateId: () => string
  readonly #now: () => number

  private constructor(
    store: JsonStore<WorkspaceDocument>,
    generateId: () => string,
    now: () => number
  ) {
    this.#store = store
    this.#generateId = generateId
    this.#now = now
  }

  static async open(options: WorkspaceStoreOptions): Promise<WorkspaceStore> {
    const store = await JsonStore.open<WorkspaceDocument>({
      filePath: options.filePath,
      schema: workspaceDocumentSchema,
      fallback: emptyWorkspaceDocument,
      migrations: WORKSPACE_MIGRATIONS,
      // What the user made and cannot get back; see "Critical" above.
      criticality: 'critical',
      // One workspace this build cannot read (a layout it lacks) costs that one; see `schema.ts`.
      tolerant: { field: 'workspaces', entry: workspaceSchema },
      repair: (document) => ({ ...document, workspaces: repairWorkspaces(document.workspaces) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })
    return new WorkspaceStore(
      store,
      options.generateId ?? defaultIdGenerator,
      options.now ?? (() => Date.now())
    )
  }

  list(): Workspace[] {
    return this.#store.get().workspaces.map(copy)
  }

  get(id: string): Workspace | undefined {
    const found = this.#store.get().workspaces.find((entry) => entry.id === id)
    return found === undefined ? undefined : copy(found)
  }

  summaries(): WorkspaceSummary[] {
    return summarize(this.#store.get().workspaces)
  }

  /** `exists` changes nothing: the menu asks, and a second call with `replace` overwrites. */
  save(draft: WorkspaceDraft, replace: boolean): 'saved' | 'exists' | 'read-only' {
    if (this.#store.readOnly) return 'read-only'
    const workspace = { ...draft, id: this.#generateId(), savedAt: this.#now() }
    const result = saveWorkspace(this.#store.get().workspaces, workspace, replace)
    if (result.outcome === 'saved') {
      this.#store.update((document) => ({ ...document, workspaces: result.workspaces }))
    }
    return result.outcome
  }

  remove(id: string): 'removed' | 'read-only' {
    if (this.#store.readOnly) return 'read-only'
    this.#store.update((document) => ({
      ...document,
      workspaces: removeWorkspace(document.workspaces, id)
    }))
    return 'removed'
  }

  /** A newer version's file: listed and opened, never written. */
  get readOnly(): boolean {
    return this.#store.readOnly
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  /** What opening the file found, for the warning `index.ts` logs. See `describeStoreLoad`. */
  get loadReport(): StoreLoadReport {
    return this.#store.loadReport
  }
}

/** A copy nobody else holds, seats and dividers included. */
function copy(workspace: Workspace): Workspace {
  return { ...workspace, seats: [...workspace.seats], fractions: { ...workspace.fractions } }
}

let counter = 0

/** Unique within the file and readable in it, as `BookmarkStore`'s ids are; its own prefix. */
function defaultIdGenerator(): string {
  counter += 1
  return `ws-${Date.now().toString(36)}-${counter.toString(36)}`
}
