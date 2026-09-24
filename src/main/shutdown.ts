/**
 * Quitting, as a state machine: `idle → running → done`.
 *
 * ## Why it is a state machine and not a flag
 *
 * Electron sends `before-quit` for every `app.quit()`, and the entry point used to guard against the
 * second one with a single `shutdownComplete` boolean that only turned true at the *end*. Every quit
 * that arrived while the first was still clearing or writing therefore started the whole sequence
 * again — a second clearing, a second round of flushes racing the first over the same files — and on
 * Windows that is not a corner case: the last window closing asks to quit while a menu Quit or the
 * vault's lock may already be under way. Here the second quit is held and nothing else happens.
 *
 * ## Why every step has a deadline
 *
 * A write that never settles used to keep the process alive for ever, with no window left to say so:
 * a browser the user had to kill from the task manager, which then lost *everything* that was still
 * buffered rather than the one store that hung. Flushes get ten seconds between them, the clearing
 * gets thirty, and after that the quit goes ahead and says what it gave up on.
 *
 * A clearing that ran out of time is not the same as one that happened, and the user asked for their
 * cookies to be gone. So there is a note, and the next start does the clearing before any page loads
 * — see `catchUpPendingClear`. It is written when the run starts, not when the quit fails (KTD7): a
 * crash, a kill or a logout has no quit to write it, and those are exactly the runs whose history
 * the user asked not to keep. The quit removes it only once the clearing and every write after it
 * are done — see `ExitNote`.
 *
 * ## What is not here
 *
 * Electron. The timers are handed in, the work is handed in per quit, and quitting for real is a
 * callback, so every answer above is testable without a process to end. `index.ts` is the wiring.
 */

export type ShutdownPhase = 'idle' | 'running' | 'done'

/** How long the flushes together may take before the quit goes ahead without the ones still going. */
export const FLUSH_TIMEOUT_MS = 10_000

/**
 * How long clearing browsing data on exit may take.
 *
 * Longer than a flush, because it is Chromium deleting a cache that can be gigabytes, and giving up
 * on it has a cost a flush does not: the data the user asked to be gone is still there until the next
 * start.
 */
export const CLEAR_TIMEOUT_MS = 30_000

/**
 * Runs `callback` after `ms` and hands back what cancels it.
 *
 * One function rather than a `setTimeout`/`clearTimeout` pair, so a test's clock and Node's timers
 * fit the same shape without a handle type between them.
 */
export type After = (ms: number, callback: () => void) => () => void

/**
 * `After` on Node's own timers: what `index.ts` hands the sequence outside a test.
 *
 * Here rather than there, beside the shape it fills, and a function declaration so that nothing depends on
 * the order this module is evaluated in: `index.ts` builds its `ShutdownSequence` at the top level.
 */
export function nodeAfter(ms: number, callback: () => void): ReturnType<After> {
  const timer = setTimeout(callback, ms)
  return () => {
    clearTimeout(timer)
  }
}

/** One store's write, under the name the log uses when it does not finish. */
export interface NamedFlush {
  readonly name: string
  readonly flush: () => Promise<unknown>
}

/** Clearing browsing data on exit, and what to leave for the next start if it does not finish. */
export interface ShutdownClear {
  readonly run: () => Promise<void>
  /** Writes the note again, for a clearing that did not finish. */
  readonly remember: () => Promise<void>
  /** Removes the note, once the clearing and every write after it are done. */
  readonly forget: () => Promise<void>
}

/** What one quit has to do, gathered at the moment it begins. */
export interface ShutdownWork {
  /** `null` when clearing on exit is off. */
  readonly clear: ShutdownClear | null
  readonly flushes: readonly NamedFlush[]
}

export type ClearOutcome = 'skipped' | 'done' | 'failed' | 'timed-out'

/** What the quit got done, for the log. */
export interface ShutdownReport {
  readonly clear: ClearOutcome
  /** The writes still going when the deadline passed. */
  readonly hung: readonly string[]
  readonly failed: ReadonlyArray<{ readonly name: string; readonly reason: unknown }>
}

export interface ShutdownOptions {
  readonly after: After
  /** Quits for real. Called once, when the sequence is done; the quit it causes goes through. */
  readonly finish: (report: ShutdownReport) => void
}

/** The name the note's own write, or its removal, is reported under when it does not finish. */
const NOTE_FLUSH_NAME = 'clear-on-exit note'

export class ShutdownSequence {
  readonly #options: ShutdownOptions
  #phase: ShutdownPhase = 'idle'

  constructor(options: ShutdownOptions) {
    this.#options = options
  }

  get phase(): ShutdownPhase {
    return this.#phase
  }

  /**
   * What `before-quit` does, and whether the quit may go ahead: `false` means `preventDefault`.
   *
   * `begin` is asked for the work on the first quit only, so what it does besides — sealing the
   * session, stopping timers — happens once, and a store that registers after this moment is not
   * waited for: it has had no chance to buffer anything.
   */
  beforeQuit(begin: () => ShutdownWork): boolean {
    if (this.#phase === 'done') return true
    if (this.#phase === 'running') return false
    this.#phase = 'running'

    let work: ShutdownWork
    try {
      work = begin()
    } catch (error) {
      /*
        Still ended, and through `finish`. The phase is already `running`, so a throw let out here
        would leave every later quit held by a sequence that never started — a browser that cannot be
        closed, which is a worse answer to any error than quitting without the work.

        After this handler has returned, as on the normal path: `finish` quits, and a quit asked for
        from inside the `before-quit` that is about to be cancelled would be cancelled with it.
      */
      const failed = [{ name: 'shutdown', reason: error }]
      void Promise.resolve().then(() => {
        this.#end({ clear: 'skipped', hung: [], failed })
      })
      return false
    }
    void this.#run(work)
    return false
  }

  async #run(work: ShutdownWork): Promise<void> {
    const flushes = [...work.flushes]
    let clear: ClearOutcome = 'skipped'
    // Before the flushes, so whatever the clearing changes is what they write.
    if (work.clear !== null) {
      clear = await within(CLEAR_TIMEOUT_MS, this.#options.after, work.clear.run)
      // Failed and ran out of time alike: either way the data the user asked to be gone is not.
      // Written as one of the flushes, so it has the same deadline and cannot hang the quit either.
      if (clear !== 'done') flushes.push({ name: NOTE_FLUSH_NAME, flush: work.clear.remember })
    }
    const { hung, failed } = await flushAll(flushes, this.#options.after)
    /*
      The note goes last, and only when nothing was left undone. A flush that hangs may be the history
      being written empty; the note is what makes the next start empty it anyway (KTD7).
    */
    if (work.clear !== null && clear === 'done' && hung.length === 0 && failed.length === 0) {
      const removal = [{ name: NOTE_FLUSH_NAME, flush: work.clear.forget }]
      const { hung: stuck, failed: refused } = await flushAll(removal, this.#options.after)
      this.#end({ clear, hung: stuck, failed: refused })
      return
    }
    this.#end({ clear, hung, failed })
  }

  #end(report: ShutdownReport): void {
    this.#phase = 'done'
    this.#options.finish(report)
  }
}

/**
 * Starts `task` now, even when it throws instead of returning a promise.
 *
 * A flush that throws synchronously is a flush that failed, not a shutdown that did.
 */
function start(task: () => Promise<unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    resolve(task())
  })
}

/** Runs `task` against a deadline and says how it ended. */
function within(ms: number, after: After, task: () => Promise<unknown>): Promise<ClearOutcome> {
  return new Promise((resolve) => {
    const cancel = after(ms, () => {
      resolve('timed-out')
    })
    start(task).then(
      () => {
        cancel()
        resolve('done')
      },
      () => {
        cancel()
        resolve('failed')
      }
    )
  })
}

/**
 * Every flush at once, under one deadline.
 *
 * `allSettled` in spirit: one store that cannot write must not stop the others from trying. And the
 * deadline is cancelled the moment the last one settles, so a store that has nothing to write — one
 * opened read-only answers its flush at once — never makes a quit wait out the ten seconds.
 */
function flushAll(
  flushes: readonly NamedFlush[],
  after: After
): Promise<Pick<ShutdownReport, 'hung' | 'failed'>> {
  return new Promise((resolve) => {
    const pending = new Set(flushes)
    const failures = new Map<NamedFlush, unknown>()
    // In the order the stores registered, rather than the order they happened to settle in.
    const report = (): void => {
      resolve({
        hung: flushes.filter((entry) => pending.has(entry)).map(({ name }) => name),
        failed: flushes
          .filter((entry) => failures.has(entry))
          .map((entry) => ({ name: entry.name, reason: failures.get(entry) }))
      })
    }
    if (pending.size === 0) {
      report()
      return
    }
    const cancel = after(FLUSH_TIMEOUT_MS, report)
    for (const entry of flushes) {
      const settled = (): void => {
        pending.delete(entry)
        if (pending.size > 0) return
        cancel()
        report()
      }
      start(entry.flush).then(settled, (reason: unknown) => {
        failures.set(entry, reason)
        settled()
      })
    }
  })
}

/**
 * Everything that must finish writing before the process exits, each under a name for the log.
 *
 * A registry rather than a list at the shutdown site, because that list was already wrong once: four
 * stores arrived with a `flush()` and none reached `before-quit`. Registering at the point of opening
 * puts the two lines next to each other, and the architecture test asserts that every store with a
 * `flush` is in here — which is why `push` takes the flush first, in the shape that test reads.
 */
export class FlushRegistry {
  readonly #entries: NamedFlush[] = []

  push(flush: () => Promise<unknown>, name: string): void {
    this.#entries.push({ name, flush })
  }

  /** A copy: a store registering after the quit began cannot change the list being worked on. */
  entries(): readonly NamedFlush[] {
    return [...this.#entries]
  }
}

// --- the clearing a quit did not finish --------------------------------------------------------

/** The note's contents: which categories the unfinished clearing was for. */
export function pendingClearText(categories: readonly string[]): string {
  return `${JSON.stringify({ categories }, null, 2)}\n`
}

/**
 * The categories a note asks for, or `fallback` when it cannot be read.
 *
 * A note that exists but makes no sense still means the user asked for their data to go, so it is
 * read as the full clearing rather than as none — the error that deletes a cookie too many is the
 * one to make here.
 */
export function readPendingClear(text: string, fallback: readonly string[]): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fallback
  }
  // `null` is the one JSON value a property cannot be read from; every other kind simply has none.
  const categories = (parsed as { categories?: unknown } | null)?.categories
  if (!Array.isArray(categories)) return fallback
  return categories.filter((category): category is string => typeof category === 'string')
}

export interface PendingClearOptions {
  /** The note's text, or `null` when the last quit left none. */
  readonly read: () => Promise<string | null>
  readonly clear: (categories: readonly string[]) => Promise<void>
  /** Removes the note. */
  readonly forget: () => Promise<void>
  /** What to clear when the note cannot be read. */
  readonly fallback: readonly string[]
  readonly after: After
}

export type PendingClearOutcome = 'none' | 'cleared' | 'still-pending'

/**
 * Does the clearing the last quit ran out of time for, and removes the note once it is done.
 *
 * Under the same thirty seconds as on the way out, because this runs before the first window: a
 * clearing that hangs here would otherwise be a browser that never opens. One that fails or runs out
 * keeps its note, so the start after tries again — the promise was that the data goes, and one more
 * attempt is cheaper than breaking it quietly.
 */
export async function catchUpPendingClear(
  options: PendingClearOptions
): Promise<PendingClearOutcome> {
  const text = await options.read()
  if (text === null) return 'none'
  const categories = readPendingClear(text, options.fallback)
  const outcome = await within(CLEAR_TIMEOUT_MS, options.after, () => options.clear(categories))
  if (outcome !== 'done') return 'still-pending'
  await options.forget()
  return 'cleared'
}

// --- the note while the browser runs -------------------------------------------------------------

/** The note's file, as `ExitNote` needs it. `read` answers `null` when there is none. */
export interface NoteFile {
  readonly read: () => Promise<string | null>
  readonly write: (text: string) => Promise<void>
  readonly remove: () => Promise<void>
}

/**
 * The exit note from the start of a run to its end (KTD7).
 *
 * Armed at the start when clearing on exit is on, so a run that never reaches its quit — a crash, a
 * kill, a logout — still leaves the promise on disk for `catchUpPendingClear`. Kept in step with
 * `clearData.onExit` and `onExitCategories`: rewritten when they change, removed when clearing is
 * switched off. Removed for good by the quit that did the clearing (`clearing().forget`).
 *
 * A note the catch-up could not finish is merged, never overwritten: its categories are a promise an
 * earlier quit made, and switching clearing off during this run takes back this run's wish, not that
 * one. Every write goes through one queue, so a burst of settings changes lands in its own order.
 */
export class ExitNote {
  readonly #file: NoteFile
  readonly #fallback: readonly string[]
  #leftover: readonly string[] = []
  #wanted: readonly string[] = []
  #done = false
  #queue: Promise<void> = Promise.resolve()

  constructor(file: NoteFile, fallback: readonly string[]) {
    this.#file = file
    this.#fallback = fallback
  }

  /** Reads what an earlier run left, merges it and writes the note as this run's settings want. */
  arm(onExit: boolean, categories: readonly string[]): Promise<void> {
    this.#wanted = onExit ? [...categories] : []
    return this.#enqueue(async () => {
      const text = await this.#file.read()
      this.#leftover = text === null ? [] : readPendingClear(text, this.#fallback)
      await this.#sync()
    })
  }

  /** Follows a settings change. One that leaves both settings as they were writes nothing. */
  want(onExit: boolean, categories: readonly string[]): Promise<void> {
    const wanted = onExit ? [...categories] : []
    if (sameNames(wanted, this.#wanted)) return this.#queue
    this.#wanted = wanted
    return this.#enqueue(() => this.#sync())
  }

  /** Every category owed: the earlier run's first, then this run's, each once. */
  owed(): readonly string[] {
    return [...new Set([...this.#leftover, ...this.#wanted])]
  }

  /** What a quit clears and how it keeps or removes the note; `null` when nothing is owed. */
  clearing(clear: (categories: readonly string[]) => Promise<void>): ShutdownClear | null {
    const owed = this.owed()
    if (owed.length === 0) return null
    return {
      run: () => clear(owed),
      remember: () => this.#enqueue(() => this.#file.write(pendingClearText(owed))),
      forget: () => {
        // For good: a settings change that arrives after the quit removed the note must not write it.
        this.#done = true
        return this.#enqueue(() => this.#file.remove())
      }
    }
  }

  #sync(): Promise<void> {
    if (this.#done) return Promise.resolve()
    const owed = this.owed()
    return owed.length === 0 ? this.#file.remove() : this.#file.write(pendingClearText(owed))
  }

  /** Runs `task` after every earlier one; a failure is the caller's, not the queue's. */
  #enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(task)
    this.#queue = run.catch(() => undefined)
    return run
  }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}
