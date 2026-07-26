import { z } from 'zod'
import {
  BOOKMARK_KINDS,
  bookmarksForUrl,
  createBookmark,
  emptyBookmarkDocument,
  isBookmarked,
  moveBookmark,
  queryBookmarks,
  relocateBookmark,
  removeBookmark,
  repairBookmarks,
  updateBookmark,
  type Bookmark,
  type BookmarkDocument,
  type BookmarkQuery,
  type CreateBookmarkInput,
  type UpdateBookmarkPatch
} from '@shared/bookmarks/model.js'
import { graftImportedBookmarks, parseNetscapeBookmarks } from '@shared/bookmarks/import.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'

/**
 * Persistence for bookmarks.
 *
 * Every tree rule lives in `@shared/bookmarks/model.ts` as a pure function; this class
 * supplies identity and the clock — the two things the pure layer cannot produce and stay
 * testable — and writes the result down. The same division `QuickLinkStore` and
 * `HistoryStore` use.
 *
 * ## Why there is no `recorderFor(mode)` here
 *
 * Every other store in this directory that a window can write to hands out a mode-bound
 * writer, so a private window physically holds an object that discards. Bookmarks
 * deliberately do not, and the difference is what the data *is*.
 *
 * History, favicons, thumbnails and downloads are records of what happened — the browser
 * noticing things on the user's behalf, which is precisely what a private window must not
 * do. A bookmark is the opposite: an explicit act, performed once, whose entire purpose is
 * to outlive the session. A private window that quietly dropped a bookmark the user asked
 * for would not be protecting them; it would be losing their work while looking like it had
 * succeeded, which is the failure mode this codebase treats as worse than any other.
 *
 * So the asymmetry is intentional and it is stated here rather than inferred from an absent
 * method. The line is: *observed* data is mode-bound, *requested* data is not.
 *
 * ## Where the file goes
 *
 * `paths.ts` decides, and `bookmarksFile()` exists there rather than a path being assembled
 * here. It belongs in the user-data directory and never the cache one: `cacheDir()` maps to
 * `sessionData`, which Electron and every platform treat as discardable, and a disk cleaner
 * silently erasing a collection somebody curated for years is exactly the line that
 * directory draws.
 */

/**
 * What the file must look like to be usable.
 *
 * The same line `HistoryStore` draws, for the same reason: wrong *kinds* of data are
 * rejected, wrong *amounts* are healed. A string where a number belongs means the file is
 * not ours and defaults are the only safe answer. Too many nodes, a title longer than we
 * would write, a `parentId` naming nothing — those are quantities and inconsistencies, and
 * since a validation failure throws the whole document away, a `.max()` here would turn
 * "grew larger than expected" into "lost every bookmark". Those go to `repairBookmarks`.
 *
 * `parentId` is `min(1)` rather than nullable, which is the schema half of the decision
 * documented in the model: the two roots are reserved ids and never stored nodes, so there
 * is no top level for a `null` to mean.
 */
const bookmarkNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(BOOKMARK_KINDS),
  title: z.string(),
  url: z.string(),
  parentId: z.string().min(1),
  createdAt: z.number().int().nonnegative()
})

const bookmarkDocumentSchema = z.object({
  version: z.literal(1),
  nodes: z.array(bookmarkNodeSchema)
})

/**
 * Keeps the schema and the interface from drifting apart in either direction — two
 * assignments per shape, one each way. A single one would only catch drift one way, and the
 * schema cannot live next to the interface because the bookmarks page is a renderer and zod
 * must not reach its bundle.
 */
type SchemaNode = z.output<typeof bookmarkNodeSchema>
type SchemaDocument = z.output<typeof bookmarkDocumentSchema>

const _nodeMatchesModel: SchemaNode = null as unknown as Bookmark
const _modelMatchesNode: Bookmark = null as unknown as SchemaNode
const _documentMatchesModel: SchemaDocument = null as unknown as BookmarkDocument
const _modelMatchesDocument: BookmarkDocument = null as unknown as SchemaDocument
void _nodeMatchesModel
void _modelMatchesNode
void _documentMatchesModel
void _modelMatchesDocument

export interface BookmarkStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so ids and timestamps are predictable. */
  generateId?: () => string
  now?: () => number
  debounceMs?: number
}

/** What an import did, plus how much of the file was refused. */
export interface BookmarkImportSummary {
  imported: number
  skipped: number
}

export class BookmarkStore {
  readonly #store: JsonStore<BookmarkDocument>
  readonly #generateId: () => string
  readonly #now: () => number

  private constructor(
    store: JsonStore<BookmarkDocument>,
    generateId: () => string,
    now: () => number
  ) {
    this.#store = store
    this.#generateId = generateId
    this.#now = now
  }

  static async open(options: BookmarkStoreOptions): Promise<BookmarkStore> {
    const store = await JsonStore.open<BookmarkDocument>({
      filePath: options.filePath,
      schema: bookmarkDocumentSchema,
      fallback: emptyBookmarkDocument,
      // A file written by an older build, edited by hand, or cut short by a crash must not
      // leave a node orphaned, duplicated, or inside a ring of folders — the write path
      // relies on none of those existing.
      repair: (document) => ({ ...document, nodes: repairBookmarks(document.nodes) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new BookmarkStore(
      store,
      options.generateId ?? defaultIdGenerator,
      options.now ?? (() => Date.now())
    )
  }

  list(): Bookmark[] {
    return [...this.#store.get().nodes]
  }

  query(criteria: BookmarkQuery = {}): Bookmark[] {
    return queryBookmarks(this.#store.get().nodes, criteria)
  }

  /** Every bookmark pointing at a page — what the address bar's star reads. */
  forUrl(url: string): Bookmark[] {
    return bookmarksForUrl(this.#store.get().nodes, url)
  }

  isBookmarked(url: string): boolean {
    return isBookmarked(this.#store.get().nodes, url)
  }

  create(input: CreateBookmarkInput): Bookmark {
    const id = this.#generateId()
    this.#store.update((document) => ({
      ...document,
      nodes: createBookmark(document.nodes, input, { id, now: this.#now() })
    }))
    const created = this.#store.get().nodes.find((node) => node.id === id)
    // `createBookmark` either throws or produces the node, so this is an invariant rather
    // than a defensive branch.
    if (created === undefined) throw new Error('bookmark was not stored')
    return created
  }

  update(id: string, patch: UpdateBookmarkPatch): Bookmark {
    this.#store.update((document) => ({
      ...document,
      nodes: updateBookmark(document.nodes, id, patch)
    }))
    const updated = this.#store.get().nodes.find((node) => node.id === id)
    if (updated === undefined) throw new Error('bookmark disappeared during update')
    return updated
  }

  /** Points a bookmark at a new address, keeping its title, folder and position. */
  relocate(id: string, url: string): Bookmark {
    this.#store.update((document) => ({
      ...document,
      nodes: relocateBookmark(document.nodes, id, url)
    }))
    const moved = this.#store.get().nodes.find((node) => node.id === id)
    if (moved === undefined) throw new Error('bookmark disappeared during relocation')
    return moved
  }

  /** Reports how many nodes went, because deleting a folder deletes its whole subtree. */
  remove(id: string): number {
    const before = this.#store.get().nodes.length
    const after = this.#store.update((document) => ({
      ...document,
      nodes: removeBookmark(document.nodes, id)
    }))
    return before - after.nodes.length
  }

  move(id: string, parentId: string, toIndex: number): void {
    this.#store.update((document) => ({
      ...document,
      nodes: moveBookmark(document.nodes, id, parentId, toIndex)
    }))
  }

  /**
   * Reads an exported bookmark file into the tree.
   *
   * Takes the file's *text*, never a path: the path comes from the OS picker in the IPC
   * handler, exactly as `extensions:load` does, so a compromised renderer cannot ask the
   * core to read an arbitrary file and hand its contents back. Everything about what the
   * text may contain is settled in `@shared/bookmarks/import.ts`.
   */
  import(html: string, folderTitle: string): BookmarkImportSummary {
    /*
      Grafted before the update rather than inside its mutator, so the counts are available
      to return.

      Safe because `JsonStore.update` is synchronous and this process has one thread: nothing
      can change the document between the read here and the write below. Doing it inside the
      mutator would mean smuggling the counts out through a mutable local, which reads as if
      the mutator might run later — and would be wrong the day it does.
    */
    const result = graftImportedBookmarks(this.#store.get().nodes, parseNetscapeBookmarks(html), {
      nextId: () => this.#generateId(),
      now: this.#now(),
      folderTitle
    })
    this.#store.update((document) => ({ ...document, nodes: result.nodes }))
    return { imported: result.imported, skipped: result.skipped }
  }

  onChange(listener: (nodes: Bookmark[]) => void): () => void {
    return this.#store.onChange((document) => listener([...document.nodes]))
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
 * Ids only have to be unique within this file, so a counter plus the clock is enough — and
 * unlike `crypto.randomUUID()` it stays readable in a document a user might open to inspect.
 * The same generator shape `QuickLinkStore` uses, with its own prefix so the two cannot be
 * confused in a file somebody is reading by hand.
 */
function defaultIdGenerator(): string {
  counter += 1
  return `bm-${Date.now().toString(36)}-${counter.toString(36)}`
}
