import { z } from 'zod'
import { LAYOUT_IDS } from '@shared/split/layout.js'
import {
  addGroup,
  addTabToGroup,
  cloneGroups,
  dissolveGroup,
  emptyTabGroupDocument,
  findGroup,
  groupOfTab,
  newTabGroup,
  recolorGroup,
  removeTabFromGroup,
  renameGroup,
  repairGroups,
  retainTabs,
  setGroupCollapsed,
  setGroupLayout,
  type CreateGroupInput,
  type TabGroup,
  type TabGroupDocument,
  type TabGroupLayout
} from '@shared/tabgroups/model.js'
import {
  FALLBACK_TAB_GROUP_COLOR,
  TAB_GROUP_COLORS,
  type TabGroupColor
} from '@shared/tabgroups/palette.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
// The same named pair, imported rather than redeclared, so `'private'` means one thing
// across the core. `recorderFor` there and `bookFor` here are the same idea.
import type { BrowsingMode } from './HistoryStore.js'

/**
 * Persistence for tab groups.
 *
 * All the rules live in `@shared/tabgroups/model.ts` as pure functions; this class
 * supplies identity and time — the two things the pure layer cannot produce without
 * becoming untestable — decides who may write, and puts the result on disk. The same
 * division `QuickLinkStore` and `HistoryStore` use.
 *
 * The file belongs in the user-data directory, never the cache one: a cache clear or a
 * disk cleaner must not erase the groups a user arranged. `paths.ts` keeps that
 * decision, which is why no path is assembled here.
 */

/**
 * What the file must look like to be usable.
 *
 * The line is the one `HistoryStore` draws: wrong *kinds* of data are rejected, wrong
 * *amounts* and wrong *values* are healed. A validation failure replaces the whole
 * document with defaults, so anything a future version might legitimately change has
 * to heal instead of failing:
 *
 *   - An unrecognised **colour** heals to grey. Dropping a slot from the palette in a
 *     later version would otherwise delete every group that used it.
 *   - A missing or non-boolean **collapsed**, a missing **name**, a nonsense
 *     **createdAt** heal to their defaults. None of them identifies the group, so none
 *     is worth the whole document.
 *   - **Name length** and **group count** are quantities and are trimmed by
 *     `repairGroups`, never capped here. `.max()` in a schema turns "grew larger than
 *     expected" into "lost every group".
 *   - A **layout** that is not of this shape heals to nothing. It is the one field that is
 *     pure convenience: losing it costs the user one arrangement they can rebuild with a
 *     drag, and rejecting the document over it would cost them every group they have. The
 *     cross-field facts it also has to obey — the tile count matching the layout, the
 *     members being members — cannot be stated here at all and belong to `repairGroups`.
 *
 * What stays strict is identity: `id` and the member ids. A group whose id is a number
 * is not a document this browser wrote, and defaults are the only safe answer.
 *
 * The healing also applies on the way *out*, because `JsonStore.update` re-validates
 * what it is about to store. That is harmless — the types make a bad colour
 * unreachable from a caller — but it does mean this schema is a repair pass rather than
 * a second assertion of the model's invariants. Those are asserted by the model.
 */
const tabGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().catch(''),
  color: z.enum(TAB_GROUP_COLORS).catch(FALLBACK_TAB_GROUP_COLOR),
  collapsed: z.boolean().catch(false),
  tabIds: z.array(z.string().min(1)),
  createdAt: z.number().int().nonnegative().catch(0),
  layout: z
    .object({ id: z.enum(LAYOUT_IDS), tiles: z.array(z.string().min(1).nullable()) })
    .optional()
    // Placed on the whole object rather than on its fields, because half an arrangement is
    // not a lesser arrangement: a layout id with no tiles, or tiles with no layout, would
    // move pages on the next click. Either it is one or it is not there.
    .catch(undefined)
})

const tabGroupDocumentSchema = z.object({
  version: z.literal(1),
  groups: z.array(tabGroupSchema)
})

/**
 * Keeps the schema and the interfaces from drifting apart in either direction — two
 * assignments per shape, one each way. A single one would only catch drift in one
 * direction, and the schema cannot live next to the interfaces: the tab strip is a
 * renderer, and zod must not reach its bundle.
 */
type SchemaGroup = z.output<typeof tabGroupSchema>
type SchemaDocument = z.output<typeof tabGroupDocumentSchema>

const _groupMatchesModel: SchemaGroup = null as unknown as TabGroup
const _modelMatchesGroup: TabGroup = null as unknown as SchemaGroup
const _documentMatchesModel: SchemaDocument = null as unknown as TabGroupDocument
const _modelMatchesDocument: TabGroupDocument = null as unknown as SchemaDocument
void _groupMatchesModel
void _modelMatchesGroup
void _documentMatchesModel
void _modelMatchesDocument

/**
 * Everything a window may do with tab groups.
 *
 * Named as an interface rather than used as the class directly, so a caller cannot
 * quietly depend on holding the persisting implementation. A private window is handed
 * one of these that writes nothing, and nothing at the call site has to know.
 *
 * Mutations return nothing on purpose. The interface is fed by `onChange` with the
 * whole list — the same shape `tabs:changed` already uses — so returning the changed
 * group would create a second, narrower path for the same information to travel down
 * and disagree on. `create` is the exception: the caller needs the new group's id in
 * order to open the rename field on it.
 */
export interface TabGroupBook {
  list(): TabGroup[]
  group(id: string): TabGroup | undefined
  groupOfTab(tabId: string): TabGroup | undefined
  create(input: CreateGroupInput): TabGroup
  rename(id: string, name: string): void
  recolor(id: string, color: TabGroupColor): void
  setCollapsed(id: string, collapsed: boolean): void
  /**
   * Writes the arrangement the group's tabs are sitting in, rewriting whatever was there.
   *
   * Called on every settle that changes something, which is why the caller checks first
   * whether anything did: this reaches a debounced file. `null` clears the arrangement and
   * has no caller in the browser any more — see `setGroupLayout` in the model for why the
   * primitive stays.
   */
  setLayout(id: string, layout: TabGroupLayout | null): void
  dissolve(id: string): void
  addTab(groupId: string, tabId: string, index?: number): void
  /** Also the close path: a closed tab leaves its group like any other departure. */
  removeTab(tabId: string): void
  /** Reconciles a loaded document with the tabs a window actually has. */
  retainTabs(liveTabIds: readonly string[]): void
  onChange(listener: (groups: TabGroup[]) => void): () => void
  flush(): Promise<void>
  readonly recoveredFromInvalidFile: boolean
}

/**
 * Where a book keeps its groups.
 *
 * The seam that makes "a private window stores nothing" structural. There are exactly
 * two implementations: one backed by a `JsonStore`, one by a variable. Everything else
 * — every rule, every invariant, every method of `TabGroupBook` — is written once
 * against this interface, so the private path cannot drift from the normal one by
 * being the less exercised of two copies.
 */
interface GroupCell {
  read(): readonly TabGroup[]
  write(mutate: (groups: readonly TabGroup[]) => TabGroup[]): void
  onChange(listener: (groups: TabGroup[]) => void): () => void
  flush(): Promise<void>
  readonly recoveredFromInvalidFile: boolean
}

export interface TabGroupStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so ids and timestamps are predictable. */
  generateId?: () => string
  now?: () => number
  debounceMs?: number
}

export class TabGroupStore implements TabGroupBook {
  readonly #cell: GroupCell
  readonly #generateId: () => string
  readonly #now: () => number

  private constructor(cell: GroupCell, generateId: () => string, now: () => number) {
    this.#cell = cell
    this.#generateId = generateId
    this.#now = now
  }

  static async open(options: TabGroupStoreOptions): Promise<TabGroupStore> {
    const store = await JsonStore.open<TabGroupDocument>({
      filePath: options.filePath,
      schema: tabGroupDocumentSchema,
      fallback: emptyTabGroupDocument,
      // A file written by an older build, edited by hand, or cut short by a crash must
      // not leave an empty group, a tab in two groups or a tab twice in one — the write
      // path and the tab strip both rely on none of those existing.
      repair: (document) => ({ ...document, groups: repairGroups(document.groups) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new TabGroupStore(
      persistedCell(store),
      options.generateId ?? defaultIdGenerator,
      options.now ?? (() => Date.now())
    )
  }

  /**
   * The only way to obtain a book, and it cannot be obtained without saying which kind
   * of session it is for.
   *
   * A private window gets a book over a `memoryCell` — an object with no reference to
   * this store, no file path and no `JsonStore`. So a private window physically holds
   * no path to the file, rather than holding one it is expected to leave alone. That is
   * the difference between an invariant and a convention: no call site can forget a
   * check it does not have to make, and a `create` call added anywhere in a private
   * window's code inherits the guarantee for free. Exactly what
   * `HistoryStore.recorderFor` does.
   *
   * A fresh book per call, so two private windows do not share groups and neither sees
   * the normal session's — a private window listing "Steuererklärung 2026" would leak
   * the normal session through the very interface that is supposed to keep nothing.
   *
   * Normal windows share this store, which is deliberate: tab ids are unique across
   * windows, and a window only ever renders the groups whose members it owns, so one
   * document is coherent and a group survives a tab moving between windows.
   */
  bookFor(mode: BrowsingMode): TabGroupBook {
    if (mode === 'private') return new TabGroupStore(memoryCell(), this.#generateId, this.#now)
    return this
  }

  list(): TabGroup[] {
    return snapshot(this.#cell.read())
  }

  /**
   * Looks up in a snapshot rather than in the live list, so the group handed out cannot
   * be mutated into the document. Costs a copy of a list that has at most fifty
   * entries and is read when a person clicks something.
   */
  group(id: string): TabGroup | undefined {
    return findGroup(this.list(), id)
  }

  groupOfTab(tabId: string): TabGroup | undefined {
    return groupOfTab(this.list(), tabId)
  }

  create(input: CreateGroupInput): TabGroup {
    const group = newTabGroup(this.#cell.read(), input, {
      id: this.#generateId(),
      now: this.#now()
    })
    this.#cell.write((groups) => addGroup(groups, group))
    return group
  }

  rename(id: string, name: string): void {
    this.#cell.write((groups) => renameGroup(groups, id, name))
  }

  recolor(id: string, color: TabGroupColor): void {
    this.#cell.write((groups) => recolorGroup(groups, id, color))
  }

  setCollapsed(id: string, collapsed: boolean): void {
    this.#cell.write((groups) => setGroupCollapsed(groups, id, collapsed))
  }

  setLayout(id: string, layout: TabGroupLayout | null): void {
    this.#cell.write((groups) => setGroupLayout(groups, id, layout))
  }

  dissolve(id: string): void {
    this.#cell.write((groups) => dissolveGroup(groups, id))
  }

  addTab(groupId: string, tabId: string, index?: number): void {
    this.#cell.write((groups) => addTabToGroup(groups, groupId, tabId, index))
  }

  removeTab(tabId: string): void {
    this.#cell.write((groups) => removeTabFromGroup(groups, tabId))
  }

  retainTabs(liveTabIds: readonly string[]): void {
    this.#cell.write((groups) => retainTabs(groups, liveTabIds))
  }

  onChange(listener: (groups: TabGroup[]) => void): () => void {
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
function persistedCell(store: JsonStore<TabGroupDocument>): GroupCell {
  return {
    read: () => store.get().groups,
    write: (mutate) => {
      store.update((document) => ({ ...document, groups: mutate(document.groups) }))
    },
    onChange: (listener) => store.onChange((document) => listener(snapshot(document.groups))),
    flush: () => store.flush(),
    // Fixed at open: `JsonStore` decides it while reading the file and never revisits it.
    recoveredFromInvalidFile: store.diagnostics.recoveredFromInvalidFile
  }
}

/**
 * A cell that keeps its groups in a variable, for private windows.
 *
 * It holds no file path and no `JsonStore`, which is the point: forgetting to check
 * `privateMode` cannot leak a group, because there is nothing here to leak it into.
 */
function memoryCell(): GroupCell {
  let groups: readonly TabGroup[] = []
  const listeners = new Set<(groups: TabGroup[]) => void>()

  return {
    read: () => groups,
    write: (mutate) => {
      groups = mutate(groups)
      for (const listener of listeners) {
        try {
          listener(snapshot(groups))
        } catch (error) {
          // One bad listener must not stop the others, same as in `JsonStore`.
          console.error('[tabgroups] listener threw:', error)
        }
      }
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    // Nothing to write and nothing to wait for. Present so shutdown can await every
    // book it holds without first asking which kind each one is.
    flush: () => Promise.resolve(),
    recoveredFromInvalidFile: false
  }
}

/**
 * A copy nobody else holds, member lists and arrangements included.
 *
 * A shallow `[...groups]` would hand out the stored arrays, and a caller that pushed to
 * one would have changed the document without going through a rule. `cloneGroups` rather
 * than a copy written out here: this file had its own, and it was correct right up until a
 * group grew a second array.
 */
function snapshot(groups: readonly TabGroup[]): TabGroup[] {
  return cloneGroups(groups)
}

let counter = 0

/**
 * Ids only have to be unique within this file, so a counter plus the clock is enough —
 * and unlike `crypto.randomUUID()` it stays readable in a document a user might open to
 * inspect.
 */
function defaultIdGenerator(): string {
  counter += 1
  return `tg-${Date.now().toString(36)}-${counter.toString(36)}`
}
