import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { z } from 'zod'
import { removeTempFilesOf, writeFileAtomically } from './atomic-write.js'
import {
  backupBeforeMigration,
  quarantineCopy,
  removeCopiesOf,
  type CopyFileSystem
} from './quarantine.js'
import {
  isReadOnlyLoad,
  restoreEntries,
  settleStoreDocument,
  type SettledDocument,
  type StoreCriticality,
  type StoreLoadOutcome,
  type StoreLoadReport,
  type StoreMigrations,
  type TolerantEntries,
  type UnreadableEntry
} from './store-load.js'

/**
 * A validated JSON document on disk, with atomic writes and change notification.
 *
 * Extracted so that quick links, and later history, bookmarks and downloads, do
 * not each reimplement the same four things — schema validation on read,
 * write-then-rename, debounced flush, and a flush that can be awaited during
 * shutdown. The last one matters: spec 4 warns that work started at exit but not
 * awaited runs into nothing.
 */

/**
 * Serialisation seam, shared with `SettingsStore`.
 *
 * Spec 3 requires every local file encrypted at rest. The plain codec is the
 * scaffold's implementation; `createEncryptedDocumentCodec` is the one that meets
 * the requirement, and it drops in here without any caller changing.
 */
export interface DocumentCodec {
  encode(data: unknown): Promise<Uint8Array> | Uint8Array
  /** May return a promise; `unknown` already covers both and awaiting is safe. */
  decode(bytes: Uint8Array): unknown
  /**
   * True when the bytes on disk are readable but not in the form `encode` produces
   * now, so the file should be rewritten.
   *
   * Optional, and absent means "nothing ever needs rewriting" — a codec written
   * against the two-method version of this interface keeps working unchanged. It
   * exists because migrating the pre-encryption plain-text files has to happen at
   * startup: waiting for the user's next change would leave a readable
   * `settings.json` lying there indefinitely, which is the very thing spec 3
   * forbids.
   */
  isStaleEncoding?(bytes: Uint8Array): boolean
}

/**
 * A codec throws this when it recognises the stored bytes but cannot turn them
 * back into a document — the file is intact, the means to read it is not.
 *
 * `JsonStore.open` lets it out instead of falling back to defaults, which is a
 * deliberate departure from how every other bad file is handled here. The reason
 * is what the two failures mean. Unparseable JSON is a document that is gone; the
 * fallback loses nothing that still existed. An undecryptable file is a document
 * that is still *there*, behind a key the process could not get hold of — a
 * keychain entry lost to an OS reinstall, a profile copied between machines. Start
 * from defaults and the next write replaces it, so a recoverable file becomes an
 * unrecoverable one and the user sees what looks exactly like a factory reset.
 * Failing loudly keeps the file and leaves the recovery possible.
 */
export class UnreadableDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnreadableDocumentError'
  }
}

export const plainJsonDocumentCodec: DocumentCodec = {
  encode: (data) => new TextEncoder().encode(JSON.stringify(data, null, 2)),
  decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

/**
 * Thrown by `update` on a critical store that must not write in this run.
 *
 * Thrown before anything changes, so the call that asked — an IPC request from the bookmarks or the
 * passwords page — fails and the page shows an error. The alternative for a critical store would be
 * accepting the change in memory and losing it at exit, which reports a success the next start
 * contradicts. See `StoreCriticality` for why degradable stores do exactly that instead.
 */
export class ReadOnlyStoreError extends Error {
  constructor(filePath: string) {
    super(`${filePath} is read-only in this run; the change was not made`)
    this.name = 'ReadOnlyStoreError'
  }
}

export interface JsonStoreOptions<T> {
  filePath: string
  schema: z.ZodType<T>
  /** Used when the file is missing, unreadable or fails validation. */
  fallback: () => T
  /**
   * The steps from each older version to the next, oldest first. Empty while the store is at
   * version 1, and required anyway, so that no store can be added without its author deciding what
   * an older file means to it. See `StoreMigrations`.
   */
  migrations: StoreMigrations
  /** What a file this build cannot write back costs. See `StoreCriticality`. */
  criticality: StoreCriticality
  /** One list parsed entry by entry, keeping the entries that fail. See `TolerantEntries`. */
  tolerant?: TolerantEntries
  /**
   * Last chance to fix a document that validates but is internally inconsistent.
   *
   * Handed the `tolerant` entries that failed as well, because a repair that cannot see them would
   * heal their absence: a bookmark inside an unreadable folder looks exactly like an orphan.
   */
  repair?: (document: T, unreadable: readonly UnreadableEntry[]) => T
  codec?: DocumentCodec
  /** Milliseconds to coalesce writes; 0 writes on every change. */
  debounceMs?: number
  /** Where the backup and quarantine copies are written. A test hands in one that fails. */
  copies?: CopyFileSystem
}

export type JsonStoreListener<T> = (document: T) => void

export interface JsonStoreDiagnostics {
  /** True when the file existed but could not be used, so defaults were taken. */
  recoveredFromInvalidFile: boolean
  /** True when `repair` changed the document on load. */
  repairedOnLoad: boolean
  /** True when the file was rewritten because the codec called its encoding stale. */
  migratedEncodingOnLoad: boolean
  /** Which of the four outcomes loading had, and where the original went. See `store-load.ts`. */
  load: StoreLoadOutcome
}

export class JsonStore<T> {
  #document: T
  readonly #listeners = new Set<JsonStoreListener<T>>()
  #writeQueue: Promise<void> = Promise.resolve()
  #pendingWrite: ReturnType<typeof setTimeout> | null = null
  #unreadable: readonly UnreadableEntry[]
  readonly #readOnly: boolean
  /** Set by `abandon`: nothing of this store is written again in this run. */
  #abandoned = false

  readonly diagnostics: JsonStoreDiagnostics

  private constructor(
    private readonly options: Required<
      Pick<JsonStoreOptions<T>, 'filePath' | 'schema' | 'fallback'>
    > &
      JsonStoreOptions<T>,
    document: T,
    diagnostics: JsonStoreDiagnostics,
    unreadable: readonly UnreadableEntry[]
  ) {
    this.#document = document
    this.diagnostics = diagnostics
    this.#unreadable = unreadable
    this.#readOnly = isReadOnlyLoad(diagnostics.load)
  }

  /**
   * Reads the file and decides what it is, keeping a copy of the original before anything may
   * replace it. The decision is `settleStoreDocument`'s; what is here is the reading and the copying.
   *
   * @throws UnreadableDocumentError when the codec refuses to decode an existing
   * file. See that class for why this one failure is not recovered from.
   */
  static async open<T>(options: JsonStoreOptions<T>): Promise<JsonStore<T>> {
    const diagnostics: JsonStoreDiagnostics = {
      recoveredFromInvalidFile: false,
      repairedOnLoad: false,
      migratedEncodingOnLoad: false,
      load: { kind: 'missing' }
    }
    const codec = options.codec ?? plainJsonDocumentCodec
    let document = options.fallback()
    let unreadable: readonly UnreadableEntry[] = []
    let rewrite = false

    // Before the first write, which is the only moment nothing of this store can be mid-rename. A
    // leftover is a copy of the document from before a crash, and nothing else will ever remove it.
    // Not a reason to refuse to start: a profile this broken fails the read below as well.
    await removeTempFilesOf(options.filePath).catch((error: unknown) => {
      console.warn(`[store] could not remove temporary files beside ${options.filePath}:`, error)
    })

    let bytes: Uint8Array | null = null
    let settled: SettledDocument<T> | null = null
    try {
      bytes = await readFile(options.filePath)
      settled = settleStoreDocument(await codec.decode(bytes), options)
      if (settled.kind === 'invalid') {
        console.warn(`[store] ${options.filePath} failed validation: ${settled.reason}`)
      }
    } catch (error) {
      if (error instanceof UnreadableDocumentError) throw error
      if ((error as { code?: string }).code !== 'ENOENT') {
        // Unparseable, or unreadable for a reason other than absence. Either way not a document, and
        // the same treatment as one that fails its schema: copied aside, then replaced.
        console.warn(`[store] could not read ${options.filePath}:`, error)
        settled = { kind: 'invalid', reason: String(error) }
      }
    }

    const stale = bytes !== null && (codec.isStaleEncoding?.(bytes) ?? false)

    switch (settled?.kind) {
      case undefined:
        break
      case 'current':
        document = settled.document
        unreadable = settled.unreadable
        // Only a document that actually loaded is rewritten. Migrating one that
        // fell back to defaults would encrypt the defaults over a file the user
        // might still have wanted to look at.
        diagnostics.migratedEncodingOnLoad = stale
        diagnostics.load = { kind: 'current' }
        rewrite = stale
        break
      case 'migrated': {
        document = settled.document
        unreadable = settled.unreadable
        // The bytes as read, not re-encoded: restoring the backup must give back exactly the file
        // that was there, under the same codec and key. A migrated document always came from bytes.
        const backup = await backupBeforeMigration(
          options.filePath,
          settled.fromVersion,
          bytes!,
          options.copies
        ).catch((error: unknown) => {
          // Kept migrated in memory and never written: the upgraded document is what this build can
          // work with, and the original on disk stays the only copy of what the user had.
          console.warn(`[store] could not back up ${options.filePath} before migrating it:`, error)
          return null
        })
        diagnostics.load = { kind: 'migrated', fromVersion: settled.fromVersion, backup }
        diagnostics.migratedEncodingOnLoad = stale && backup !== null
        rewrite = backup !== null
        break
      }
      case 'newer':
        // Read-only from here on, and the file is never written; see `isReadOnlyLoad`.
        document = settled.readable ?? document
        unreadable = settled.unreadable
        diagnostics.load = { kind: 'newer', version: settled.version }
        break
      case 'invalid': {
        // A corrupt file must not stop the browser from starting; the user can recover their data
        // from the copy, but not from an app that refuses to launch.
        diagnostics.recoveredFromInvalidFile = true
        // The bytes as read when there were any; otherwise the copy reads the file itself, and a file
        // that could not be read the first time most likely fails again, which leaves the store
        // read-only rather than writing over something nobody has looked at.
        const copy = await quarantineCopy(options.filePath, {
          ...(bytes === null ? {} : { bytes }),
          ...(options.copies === undefined ? {} : { fs: options.copies })
        }).catch((error: unknown) => {
          // Read-only with defaults rather than a refusal to start, unlike `SettingsStore`: without
          // settings the browser cannot build its command line, without these it can run.
          console.warn(`[store] could not copy ${options.filePath} aside:`, error)
          return null
        })
        diagnostics.load = { kind: 'invalid', reason: settled.reason, copy }
        rewrite = copy !== null
        break
      }
    }

    if (options.repair) {
      // Never a reason to write by itself. A repair can drop what it cannot place, and the file as
      // it is keeps what was dropped until the user changes something.
      const repaired = options.repair(document, unreadable)
      if (!deepEqual(repaired, document)) {
        diagnostics.repairedOnLoad = true
        document = repaired
      }
    }

    const store = new JsonStore<T>({ ...options, codec }, document, diagnostics, unreadable)
    if (rewrite && !store.#readOnly) {
      // One write for everything open decided: the migrated document, the new encoding, the defaults
      // that replace a file now safely copied aside. Awaited, so a caller that reads the file straight
      // after `open` sees the new form. `flush` reports a failed write rather than throwing, which is
      // right here too: the old file stays readable and the same decision is made on the next start.
      await store.flush()
    }
    return store
  }

  get(): T {
    return this.#document
  }

  /**
   * True when nothing of this store is written in this run — a newer file, or an original that could
   * not be copied. See `isReadOnlyLoad`.
   */
  get readOnly(): boolean {
    return this.#readOnly
  }

  /** What `index.ts` warns about, and what the vault's status reports. See `describeStoreLoad`. */
  get loadReport(): StoreLoadReport {
    return { outcome: this.diagnostics.load, criticality: this.options.criticality }
  }

  /**
   * The entries of the `tolerant` list that failed their schema, as they were stored.
   *
   * Written back where they were on every flush, and handed to nothing else by this class: a raw
   * entry is data this build cannot interpret, so it must never be offered, exported or searched.
   */
  get unreadableEntries(): readonly UnreadableEntry[] {
    return this.#unreadable
  }

  /**
   * Forgets the unreadable entries a deletion covers — all of them by default, which is what
   * "delete every password" means.
   *
   * Without this a deletion would leave behind exactly the entries the user cannot see, and the next
   * flush would write them back into a file they believe they emptied.
   */
  discardUnreadableEntries(covers: (entry: UnreadableEntry) => boolean = () => true): void {
    this.#refuseIfReadOnly()
    const kept = this.#unreadable.filter((entry) => !covers(entry))
    if (kept.length === this.#unreadable.length) return
    this.#unreadable = kept
    if (!this.#readOnly) this.#scheduleWrite()
  }

  /**
   * Applies a change and persists it.
   *
   * The result is validated before it is accepted, so a bug in a caller produces
   * a thrown error and an unchanged document rather than an invalid file that
   * fails to load on the next start.
   *
   * On a read-only store a critical one throws `ReadOnlyStoreError` before anything changes, and a
   * degradable one applies the change in memory only — the run goes on, and the file stays as the
   * newer version or the uncopied original left it.
   */
  update(mutate: (current: T) => T): T {
    this.#refuseIfReadOnly()
    const next = mutate(this.#document)
    const parsed = this.options.schema.safeParse(next)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      throw new Error(`Refusing to store an invalid document: ${detail}`)
    }

    this.#document = parsed.data
    if (!this.#readOnly) this.#scheduleWrite()
    for (const listener of this.#listeners) {
      try {
        listener(this.#document)
      } catch (error) {
        // One bad listener must not stop the others.
        console.error('[store] listener threw:', error)
      }
    }
    return this.#document
  }

  onChange(listener: JsonStoreListener<T>): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #refuseIfReadOnly(): void {
    if (this.#readOnly && this.options.criticality === 'critical') {
      throw new ReadOnlyStoreError(this.options.filePath)
    }
  }

  #scheduleWrite(): void {
    if (this.#abandoned) return
    const delay = this.options.debounceMs ?? 250
    if (delay === 0) {
      void this.flush()
      return
    }
    if (this.#pendingWrite !== null) clearTimeout(this.#pendingWrite)
    this.#pendingWrite = setTimeout(() => {
      this.#pendingWrite = null
      void this.flush()
    }, delay)
  }

  /**
   * Writes pending changes and resolves once they are on disk.
   *
   * A read-only store resolves at once and writes nothing. That is also what keeps the shutdown from
   * waiting on it: a store that will never write has nothing a timeout could be waiting for.
   */
  flush(): Promise<void> {
    if (this.#readOnly || this.#abandoned) return Promise.resolve()
    if (this.#pendingWrite !== null) {
      clearTimeout(this.#pendingWrite)
      this.#pendingWrite = null
    }
    const snapshot = this.#forDisk(this.#document)
    const codec = this.options.codec ?? plainJsonDocumentCodec

    this.#writeQueue = this.#writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.options.filePath), { recursive: true })
        const bytes = await codec.encode(snapshot)
        // A crash mid-write leaves the previous file intact instead of a
        // truncated one. See `atomic-write.ts`.
        await writeFileAtomically(this.options.filePath, bytes, { mode: 0o600 })
      } catch (error) {
        console.error(`[store] write to ${this.options.filePath} failed:`, error)
      }
    })
    return this.#writeQueue
  }

  /**
   * Removes every backup, quarantine copy and temporary of this store's file, after writing what is
   * pending. For the deletion paths: clearing a category must take the copies of it along.
   *
   * Queued behind the store's own writes rather than run beside them, because removing temporaries
   * while a write is in flight would take the one it is about to rename. Rejects when a copy could not
   * be removed, so the caller does not report as deleted what is still on disk.
   */
  discardCopies(): Promise<void> {
    void this.flush()
    const removal = this.#writeQueue.then(() =>
      removeCopiesOf(this.options.filePath, this.options.copies)
    )
    this.#writeQueue = removal.catch(() => undefined)
    return removal
  }

  /**
   * Stops writing for good, and settles once the last write already queued has landed.
   *
   * For panic, which deletes the file from under the open store (KTD7): a debounced write still
   * pending, a flush on the way out, a change a closing window makes — any of them would put the file
   * back. The document stays readable in memory; only the disk is given up.
   */
  abandon(): Promise<void> {
    this.#abandoned = true
    if (this.#pendingWrite !== null) {
      clearTimeout(this.#pendingWrite)
      this.#pendingWrite = null
    }
    return this.#writeQueue
  }

  /** The document as the file gets it: with the unreadable entries back where they were. */
  #forDisk(document: T): unknown {
    const tolerant = this.options.tolerant
    if (tolerant === undefined || this.#unreadable.length === 0) return document
    // An array: the schema names it one, and only a document that passed the schema gets here.
    const entries = (document as Record<string, unknown>)[tolerant.field] as readonly unknown[]
    return { ...document, [tolerant.field]: restoreEntries(entries, this.#unreadable) }
  }
}

/**
 * Structural equality, used to tell whether `repair` actually changed anything.
 *
 * A reference check on `repair`'s result would be worthless: every `repair` in this codebase
 * spreads its input into a new top-level object (`{ ...document, visits: repairHistory(...) }` and
 * the like), so the result is a different reference even when nothing needed fixing. What those
 * functions *do* keep is the identity of anything they left alone — an unmerged history visit, an
 * unmoved quick link — so recursing with `===` finds that out cheaply: an untouched 2 MB history
 * document compares by walking one array of already-equal references, rather than by building two
 * ~2 MB JSON strings and comparing those. `JSON.stringify(repaired) !== JSON.stringify(document)`
 * did the latter, on every store that uses `repair`, on every startup, whether or not anything
 * needed to change.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => deepEqual(left[key], right[key]))
  }
  return false
}
