import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { z } from 'zod'

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

export interface JsonStoreOptions<T> {
  filePath: string
  schema: z.ZodType<T>
  /** Used when the file is missing, unreadable or fails validation. */
  fallback: () => T
  /** Last chance to fix a document that validates but is internally inconsistent. */
  repair?: (document: T) => T
  codec?: DocumentCodec
  /** Milliseconds to coalesce writes; 0 writes on every change. */
  debounceMs?: number
}

export type JsonStoreListener<T> = (document: T) => void

export interface JsonStoreDiagnostics {
  /** True when the file existed but could not be used, so defaults were taken. */
  recoveredFromInvalidFile: boolean
  /** True when `repair` changed the document on load. */
  repairedOnLoad: boolean
  /** True when the file was rewritten because the codec called its encoding stale. */
  migratedEncodingOnLoad: boolean
}

export class JsonStore<T> {
  #document: T
  readonly #listeners = new Set<JsonStoreListener<T>>()
  #writeQueue: Promise<void> = Promise.resolve()
  #pendingWrite: ReturnType<typeof setTimeout> | null = null

  readonly diagnostics: JsonStoreDiagnostics

  private constructor(
    private readonly options: Required<Pick<JsonStoreOptions<T>, 'filePath' | 'schema' | 'fallback'>> &
      JsonStoreOptions<T>,
    document: T,
    diagnostics: JsonStoreDiagnostics
  ) {
    this.#document = document
    this.diagnostics = diagnostics
  }

  /**
   * @throws UnreadableDocumentError when the codec refuses to decode an existing
   * file. See that class for why this one failure is not recovered from.
   */
  static async open<T>(options: JsonStoreOptions<T>): Promise<JsonStore<T>> {
    const diagnostics: JsonStoreDiagnostics = {
      recoveredFromInvalidFile: false,
      repairedOnLoad: false,
      migratedEncodingOnLoad: false
    }
    const codec = options.codec ?? plainJsonDocumentCodec
    let document = options.fallback()

    try {
      const bytes = await readFile(options.filePath)
      const raw = await codec.decode(bytes)
      const parsed = options.schema.safeParse(raw)
      if (parsed.success) {
        document = parsed.data
        // Only a document that actually loaded is rewritten. Migrating one that
        // fell back to defaults would encrypt the defaults over a file the user
        // might still have wanted to look at.
        diagnostics.migratedEncodingOnLoad = codec.isStaleEncoding?.(bytes) ?? false
      } else {
        // A corrupt file must not stop the browser from starting; the user can
        // recover their links from a backup, but not from an app that refuses to
        // launch.
        diagnostics.recoveredFromInvalidFile = true
        console.warn(`[store] ${options.filePath} failed validation, using defaults`)
      }
    } catch (error) {
      if (error instanceof UnreadableDocumentError) throw error
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') {
        diagnostics.recoveredFromInvalidFile = true
        console.warn(`[store] could not read ${options.filePath}:`, error)
      }
    }

    if (options.repair) {
      const repaired = options.repair(document)
      if (JSON.stringify(repaired) !== JSON.stringify(document)) {
        diagnostics.repairedOnLoad = true
        document = repaired
      }
    }

    const store = new JsonStore<T>({ ...options, codec }, document, diagnostics)
    if (diagnostics.migratedEncodingOnLoad) {
      // Awaited, so a caller that reads the file straight after `open` sees the new
      // form. `flush` reports a failed write rather than throwing, which is right
      // here too: a migration that cannot be written leaves the old file readable
      // and is retried on the next start.
      await store.flush()
    }
    return store
  }

  get(): T {
    return this.#document
  }

  /**
   * Applies a change and persists it.
   *
   * The result is validated before it is accepted, so a bug in a caller produces
   * a thrown error and an unchanged document rather than an invalid file that
   * fails to load on the next start.
   */
  update(mutate: (current: T) => T): T {
    const next = mutate(this.#document)
    const parsed = this.options.schema.safeParse(next)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      throw new Error(`Refusing to store an invalid document: ${detail}`)
    }

    this.#document = parsed.data
    this.#scheduleWrite()
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

  #scheduleWrite(): void {
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

  /** Writes pending changes and resolves once they are on disk. */
  flush(): Promise<void> {
    if (this.#pendingWrite !== null) {
      clearTimeout(this.#pendingWrite)
      this.#pendingWrite = null
    }
    const snapshot = this.#document
    const codec = this.options.codec ?? plainJsonDocumentCodec

    this.#writeQueue = this.#writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.options.filePath), { recursive: true })
        const bytes = await codec.encode(snapshot)
        // Write-then-rename: a crash mid-write leaves the previous file intact
        // instead of a truncated one.
        const temp = `${this.options.filePath}.tmp`
        await writeFile(temp, bytes, { mode: 0o600 })
        await rename(temp, this.options.filePath)
      } catch (error) {
        console.error(`[store] write to ${this.options.filePath} failed:`, error)
      }
    })
    return this.#writeQueue
  }
}
