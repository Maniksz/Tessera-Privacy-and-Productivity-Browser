import type { ReaderOutcome } from '@shared/reader/outcome.js'
import { ReaderService, type ReaderHost } from './ReaderService.js'

/**
 * The two calls the rest of the core makes into reader mode.
 *
 * A module-level instance, which the rest of this project does not do — every other service is
 * constructed in `main/index.ts` and passed down — so the reason has to be good. It is this: reader
 * mode has no configuration, no per-window state and nothing to dispose. What it holds is a bounded
 * cache of the last few extractions, which is process-wide by nature: the reader tab that reads an
 * extraction is a *different* tab from the one it was taken from, and may be in a different window.
 * Threading it through `MenuDeps`, `WindowRegistry` and the IPC dependency object would add three
 * parameters to reach the same object.
 *
 * The two exports are deliberately the smallest possible surface, because the menu builder and the
 * IPC handler table are the two files this had to be wired into and both belong to somebody else: one
 * import and one line each.
 */

const service = new ReaderService()

/**
 * Extracts the active tab's article and opens the reader view on it.
 *
 * Returns nothing, so a menu item's `click` handler needs no promise handling — a floating promise in
 * a menu callback is the shape that makes a failure disappear entirely.
 *
 * A refusal is *not* a failure and does not come out here: the reader tab opens either way and words
 * its own refusal. What is caught below is the case where the tab could not be opened at all, which
 * leaves nothing on screen to explain itself and is therefore the one thing worth a log line.
 */
export function openReaderMode(host: ReaderHost | undefined): void {
  if (host === undefined) return
  void service.open(host).catch((cause: unknown) => {
    console.error('reader mode could not open a tab', cause)
  })
}

/** What `reader:get` answers with. Never throws: an id the core is not holding is `expired`. */
export function readerOutcomeFor(id: string): ReaderOutcome {
  return service.outcomeFor(id)
}
