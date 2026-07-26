import { z } from 'zod'
import {
  DOWNLOAD_STATES,
  addDownload,
  clearFinishedDownloads,
  discardingDownloadRecorder,
  emptyDownloadDocument,
  isTerminalDownloadState,
  patchDownload,
  recordFor,
  removeDownload,
  repairDownloads,
  type DownloadDocument,
  type DownloadPatch,
  type DownloadRecord,
  type DownloadRecorder,
  type StartedDownload
} from '@shared/downloads/model.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
import type { BrowsingMode } from './HistoryStore.js'

/**
 * Persistence for the download list.
 *
 * The rules live in `@shared/downloads/model.ts` as pure functions; this class supplies the
 * clock, decides who may write, and puts the result on disk — the same division
 * `HistoryStore` uses, and for the same reason: a download record says what the user
 * fetched, which is browsing history by another route.
 *
 * ## What is deliberately *not* here
 *
 * Progress. A running download reports received bytes several times a second, and each
 * report through this store would mean re-serialising, re-encrypting and rewriting the whole
 * document. So the store learns about a download twice — when it starts and when it
 * finishes — and `DownloadManager` holds the bytes in between. The consequence is stated in
 * `repairDownloads`: a record found in a non-terminal state at startup is one whose writer is
 * gone, and it is marked interrupted rather than left looking live.
 */

/**
 * What the file must look like to be usable.
 *
 * Wrong *kinds* of data are rejected, wrong *amounts* are healed — the line `HistoryStore`
 * draws, for the same reason. A `.max()` on the array here would turn "more records than we
 * expected" into "lost the whole download list", so the cap is enforced by `repairDownloads`
 * instead.
 *
 * `interruptReason` is a plain string with no enum, matching the model: the reasons come from
 * Chromium and the set grows between versions. Validating against a list this build knows
 * would discard the entire document the first time a newer Chromium invented a reason.
 */
const downloadRecordSchema = z.object({
  id: z.string().min(1),
  url: z.string(),
  fileName: z.string().min(1),
  savePath: z.string(),
  mimeType: z.string(),
  totalBytes: z.number().int().nonnegative(),
  receivedBytes: z.number().int().nonnegative(),
  state: z.enum(DOWNLOAD_STATES),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  interruptReason: z.string()
})

const downloadDocumentSchema = z.object({
  version: z.literal(1),
  downloads: z.array(downloadRecordSchema)
})

/**
 * Keeps the schema and the interface from drifting apart in either direction — two
 * assignments per shape, one each way. A single one would only catch drift one way, and the
 * schema cannot live beside the interface because the downloads page is a renderer and zod
 * must not reach its bundle.
 */
type SchemaRecord = z.output<typeof downloadRecordSchema>
type SchemaDocument = z.output<typeof downloadDocumentSchema>

const _recordMatchesModel: SchemaRecord = null as unknown as DownloadRecord
const _modelMatchesRecord: DownloadRecord = null as unknown as SchemaRecord
const _documentMatchesModel: SchemaDocument = null as unknown as DownloadDocument
const _modelMatchesDocument: DownloadDocument = null as unknown as SchemaDocument
void _recordMatchesModel
void _modelMatchesRecord
void _documentMatchesModel
void _modelMatchesDocument

export interface DownloadStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so timestamps do not depend on when the test ran. */
  now?: () => number
  debounceMs?: number
}

export class DownloadStore {
  readonly #store: JsonStore<DownloadDocument>
  readonly #now: () => number

  private constructor(store: JsonStore<DownloadDocument>, now: () => number) {
    this.#store = store
    this.#now = now
  }

  static async open(options: DownloadStoreOptions): Promise<DownloadStore> {
    const store = await JsonStore.open<DownloadDocument>({
      filePath: options.filePath,
      schema: downloadDocumentSchema,
      fallback: emptyDownloadDocument,
      // A record left mid-flight by a crash or a quit has to be resolved on load: nothing is
      // writing that file any more, and a row that claims otherwise has a cancel button
      // wired to nothing.
      repair: (document) => ({ ...document, downloads: repairDownloads(document.downloads) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new DownloadStore(store, options.now ?? (() => Date.now()))
  }

  /**
   * The only way to obtain a writer, and it cannot be obtained without saying which kind of
   * session it is for.
   *
   * A private window gets `discardingDownloadRecorder`, an object with no reference to this
   * store — so a private window physically holds no path to the file rather than holding one
   * it is expected to leave alone. That is the difference between an invariant and a
   * convention: no call site can forget a check it does not have to make, and a `start` call
   * added anywhere in the download plumbing later inherits the guarantee for free.
   *
   * Deletion is deliberately *not* behind this, exactly as in `HistoryStore`: clearing the
   * list from a private window acts on the stored list, which is what the person asking for
   * it means.
   */
  recorderFor(mode: BrowsingMode): DownloadRecorder {
    if (mode === 'private') return discardingDownloadRecorder
    return {
      start: (started: StartedDownload) => this.#start(started),
      update: (id: string, patch: DownloadPatch) => this.#update(id, patch),
      remembers: (id: string) => this.#store.get().downloads.some((record) => record.id === id)
    }
  }

  /** Most recently started first. */
  list(): DownloadRecord[] {
    return [...this.#store.get().downloads]
  }

  find(id: string): DownloadRecord | undefined {
    return this.#store.get().downloads.find((record) => record.id === id)
  }

  /** Forgets one record. The file it names is left alone; see `DownloadManager.remove`. */
  remove(id: string): number {
    return this.#replace((downloads) => removeDownload(downloads, id))
  }

  /**
   * Forgets every finished download.
   *
   * What `clearData.onExitCategories` containing `downloads` runs, and what the page's
   * "clear list" button calls. Anything still running stays, because a record removed from
   * under a live download would leave a file being written that the interface does not admit
   * to and offers no way to stop.
   */
  clear(): number {
    return this.#replace((downloads) => clearFinishedDownloads(downloads))
  }

  onChange(listener: (downloads: DownloadRecord[]) => void): () => void {
    return this.#store.onChange((document) => listener([...document.downloads]))
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#store.diagnostics.recoveredFromInvalidFile
  }

  #start(started: StartedDownload): void {
    this.#store.update((document) => ({
      ...document,
      downloads: addDownload(document.downloads, recordFor(started))
    }))
  }

  #update(id: string, patch: DownloadPatch): void {
    // Asked before writing, and not redundantly with `patchDownload`'s own tolerance: without
    // this, a `done` event for a record the user already removed would still schedule a file
    // write and wake every listener to deliver an unchanged list. The same guard
    // `HistoryStore.#noteTitle` makes, for the same reason.
    if (!this.#store.get().downloads.some((record) => record.id === id)) return
    /*
      The end time is stamped here rather than by the caller.

      The clock is this class's business — the same reason `HistoryStore` owns `now` — and it
      keeps the manager from having to pass one on every terminal transition, which is the
      kind of parameter that gets forgotten on the third of four code paths. The model has its
      own fallback for a caller that reaches it directly, and that fallback stays: a pure
      function has to be total on its own input.
    */
    const stamped: DownloadPatch =
      patch.state !== undefined && isTerminalDownloadState(patch.state) && patch.endedAt === undefined
        ? { ...patch, endedAt: this.#now() }
        : patch
    this.#store.update((document) => ({
      ...document,
      downloads: patchDownload(document.downloads, id, stamped)
    }))
  }

  /**
   * Applies a removal and reports how many records went.
   *
   * Counted by difference rather than by the pure functions returning it: every one of them
   * would otherwise have to carry a count through, and the store already holds both lists.
   */
  #replace(remove: (downloads: readonly DownloadRecord[]) => DownloadRecord[]): number {
    const before = this.#store.get().downloads.length
    const after = this.#store.update((document) => ({
      ...document,
      downloads: remove(document.downloads)
    }))
    return before - after.downloads.length
  }
}
