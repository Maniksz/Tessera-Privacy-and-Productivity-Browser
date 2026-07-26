import { z } from 'zod'
import type { Session } from 'electron'
import {
  emptyExtensionDocument,
  withPath,
  withoutPath,
  type ExtensionDocument,
  type ExtensionInfo
} from '@shared/extensions/model.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'

/**
 * Loads unpacked extensions and remembers which folders to reload.
 *
 * Uses `session.extensions.*` rather than the `session.*` methods, which Electron 43
 * deprecates in favour of the namespaced API.
 *
 * Electron does not persist extensions across restarts, so the folder paths are stored
 * and re-loaded at startup. Without that, an extension would silently disappear on
 * every launch, which reads as a bug rather than as a platform limit.
 *
 * Extensions go into the normal browsing session only. A private window uses an
 * in-memory session that is discarded with the window (spec 4), and loading an
 * extension there would put third-party code into a session whose whole purpose is to
 * leave nothing behind.
 */

const extensionDocumentSchema = z.object({
  version: z.literal(1),
  paths: z.array(z.string())
})

export interface ExtensionStoreOptions {
  filePath: string
  codec?: DocumentCodec
  debounceMs?: number
}

export class ExtensionStore {
  readonly #store: JsonStore<ExtensionDocument>
  #session: Session | null = null

  private constructor(store: JsonStore<ExtensionDocument>) {
    this.#store = store
  }

  static async open(options: ExtensionStoreOptions): Promise<ExtensionStore> {
    const store = await JsonStore.open<ExtensionDocument>({
      filePath: options.filePath,
      schema: extensionDocumentSchema,
      fallback: emptyExtensionDocument,
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })
    return new ExtensionStore(store)
  }

  /**
   * Binds the browsing session and reloads the remembered folders.
   *
   * A folder that no longer loads is dropped from the list rather than retried on
   * every launch: an extension the user deleted from disk should stop being an error
   * they see forever.
   */
  async attach(session: Session): Promise<string[]> {
    this.#session = session
    const failures: string[] = []

    for (const path of this.#store.get().paths) {
      try {
        await session.extensions.loadExtension(path, { allowFileAccess: false })
      } catch (error) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
        this.#store.update((document) => ({ ...document, paths: withoutPath(document.paths, path) }))
      }
    }

    return failures
  }

  list(): ExtensionInfo[] {
    if (this.#session === null) return []
    return this.#session.extensions.getAllExtensions().map((extension) => ({
      id: extension.id,
      name: extension.name,
      version: extension.version,
      path: extension.path
    }))
  }

  /** Loads a folder and remembers it. Throws with the platform's reason on failure. */
  async load(path: string): Promise<ExtensionInfo> {
    const session = this.#requireSession()
    const extension = await session.extensions.loadExtension(path, { allowFileAccess: false })
    this.#store.update((document) => ({ ...document, paths: withPath(document.paths, path) }))
    return {
      id: extension.id,
      name: extension.name,
      version: extension.version,
      path: extension.path
    }
  }

  remove(id: string): void {
    const session = this.#requireSession()
    const existing = session.extensions.getAllExtensions().find((extension) => extension.id === id)
    session.extensions.removeExtension(id)
    if (existing !== undefined) {
      this.#store.update((document) => ({
        ...document,
        paths: withoutPath(document.paths, existing.path)
      }))
    }
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  #requireSession(): Session {
    if (this.#session === null) {
      throw new Error('extensions are not available before the browsing session exists')
    }
    return this.#session
  }
}
