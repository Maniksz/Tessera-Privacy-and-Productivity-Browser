import { PANIC_CATEGORIES } from '@shared/data/inventory.js'
import { pendingClearText, type NoteFile } from '../shutdown.js'
import {
  clearFilesOf,
  nodeClearingFiles,
  type ClearableCache,
  type FileClearing
} from './clear-data.js'

/**
 * "Delete Everything and Quit" (R15): the browsing traces of the inventory's panic column, then the
 * quit, in a fixed order (KTD7).
 *
 * ## The order, and what each step is for
 *
 *   1. **The note**, naming everything panic deletes. From here on a crash, a kill or a locked file
 *      still owes the next start the whole panic, which `catchUpPendingClears` does before any store
 *      opens — so a panic interrupted anywhere below restores no tab.
 *   2. **The downloads**, cancelled with their partial files, so nothing is writing a file any more.
 *   3. **The stores**, stopped for good (`abandon`), then **the windows** closed without asking — a
 *      page that is gone cannot set a cookie after Chromium was cleared — then **the files** of every
 *      panic category with every copy (`.v<N>.bak`, `.unreadable`, temporaries) and Chromium's part,
 *      by the inventory, so a file a category gains later is deleted without anybody adding it here.
 *   4. **No write-back.** An abandoned store's flush writes nothing, so the shutdown's flushes —
 *      the session's above all — cannot put an open window back into the file just deleted.
 *   5. **The quit**, through `app.quit()`, whose `before-quit` is what silences `beforeunload`.
 *   6. **The note goes last**, and only when every step before it finished. The shutdown waits for
 *      this through `whenIdle`, which `index.ts` registers among its flushes.
 *
 * Every step is tried even when one before it failed: the promise was that the data goes, and a
 * locked file must not keep the rest of the history on disk. What failed keeps the note.
 *
 * ## What is not here
 *
 * The confirmation (`menu-actions.ts`) and Electron. Stores, windows, the session and the quit are
 * handed in, so the order is a test rather than a claim.
 */

/** A store of a panic category, as panic stops it: `SessionStore`, `HistoryStore` and the rest. */
export interface AbandonableStore {
  abandon(): Promise<void>
}

export interface PanicDeps {
  /** The panic note; `noteFileAt(panicPendingFile)`. */
  readonly note: NoteFile
  /** `DownloadManager.cancelUnfinished`: cancels, and answers the partial files to remove. */
  readonly downloads: { cancelUnfinished(): readonly string[] }
  readonly stores: readonly AbandonableStore[]
  /** The favicon and thumbnail caches, whose images go before their directories do. */
  readonly caches: readonly ClearableCache[]
  /** Every window, torn down without `beforeunload`; `WindowRegistry.closeAll`. */
  readonly closeWindows: () => void
  /** The default session and the paths, as the catch-up at the next start uses them. */
  readonly clearing: FileClearing
  readonly quit: () => void
}

/** `incomplete` keeps the note, and the next start finishes what this run could not. */
export type PanicOutcome = 'complete' | 'incomplete'

export class Panic {
  readonly #deps: PanicDeps
  #running: Promise<PanicOutcome> | null = null

  constructor(deps: PanicDeps) {
    this.#deps = deps
  }

  /** Runs the panic once; a second press while it runs is answered with the first run. */
  run(): Promise<PanicOutcome> {
    this.#running ??= this.#sequence()
    return this.#running
  }

  /** Settles when a running panic has finished; at once when none was started. */
  async whenIdle(): Promise<void> {
    await this.#running
  }

  async #sequence(): Promise<PanicOutcome> {
    const { note, downloads, stores, caches, closeWindows, clearing, quit } = this.#deps
    const files = clearing.files ?? nodeClearingFiles
    const failed: string[] = []
    const step = async (name: string, work: () => unknown): Promise<void> => {
      try {
        await work()
      } catch (error) {
        failed.push(name)
        console.error(`[panic] ${name} failed; the next start finishes it:`, error)
      }
    }

    await step('writing the note', () => note.write(pendingClearText(PANIC_CATEGORIES)))
    await step('cancelling the downloads', async () => {
      for (const partial of downloads.cancelUnfinished()) await files.removeFile(partial)
    })
    await step('stopping the stores', () => Promise.all(stores.map((store) => store.abandon())))
    await step('emptying the caches', async () => {
      for (const cache of caches) cache.seal()
      for (const cache of caches) await cache.clear()
      await Promise.all(caches.map((cache) => cache.discardCopies()))
    })
    await step('closing the windows', closeWindows)
    await step('deleting the files', () => clearFilesOf(PANIC_CATEGORIES, clearing))
    await step('quitting', quit)
    if (failed.length === 0) await step('removing the note', () => note.remove())
    return failed.length === 0 ? 'complete' : 'incomplete'
  }
}
