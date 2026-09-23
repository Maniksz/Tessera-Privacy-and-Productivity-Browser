import { describe, expect, it } from 'vitest'
import {
  CLEAR_TIMEOUT_MS,
  FLUSH_TIMEOUT_MS,
  FlushRegistry,
  ShutdownSequence,
  catchUpPendingClear,
  pendingClearText,
  readPendingClear,
  type ShutdownReport,
  type ShutdownWork
} from '@main/shutdown.js'

/**
 * Quitting: `idle → running → done`, and what the sequence owes the user on the way.
 *
 * Each group names the damage it is here to prevent:
 *
 *   - **A second `before-quit` while the first is still running starts nothing.** Electron sends one
 *     for every `app.quit()`, and the last window closing on Windows produces one while a menu Quit
 *     may already have; two runs would clear twice and race two flushes of the same files.
 *   - **A write that never finishes does not keep the browser alive.** After ten seconds the sequence
 *     is done and says which store it gave up on, instead of a process the user has to kill.
 *   - **A clearing that never finishes is not forgotten.** After thirty seconds the quit goes ahead and
 *     the next start does the clearing before any page loads.
 *   - **A store with nothing to write is never the one that hangs.** A read-only store answers its
 *     flush at once, and the sequence must not wait out the deadline on its account.
 *
 * The timers are the sequence's own seam, so no test here waits for a real second.
 */

interface FakeTimers {
  readonly after: (ms: number, callback: () => void) => () => void
  /** Moves the clock and runs every timer that is due. */
  readonly advance: (ms: number) => void
  /** How many timers are still waiting to fire. */
  readonly live: () => number
}

function fakeTimers(): FakeTimers {
  let now = 0
  const timers: Array<{ at: number; callback: () => void; live: boolean }> = []
  return {
    after: (ms, callback) => {
      const timer = { at: now + ms, callback, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
    advance: (ms) => {
      now += ms
      for (const timer of timers) {
        if (timer.live && timer.at <= now) {
          timer.live = false
          timer.callback()
        }
      }
    },
    live: () => timers.filter((timer) => timer.live).length
  }
}

/** Lets every promise that can settle now do so. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
}

/** A promise the test resolves by hand, which is how a hanging write is spelled. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

/** A write that records that it ran and succeeds at once. */
function resolving(effect: () => unknown): () => Promise<void> {
  return () => {
    effect()
    return Promise.resolve()
  }
}

function sequence(timers: FakeTimers): {
  readonly shutdown: ShutdownSequence
  readonly reports: ShutdownReport[]
} {
  const reports: ShutdownReport[] = []
  const shutdown = new ShutdownSequence({
    after: timers.after,
    finish: (report) => reports.push(report)
  })
  return { shutdown, reports }
}

describe('the shutdown sequence', () => {
  it('holds the first quit, runs the work once, then lets the next quit through', async () => {
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)
    const calls: string[] = []
    const work: ShutdownWork = {
      clear: null,
      flushes: [{ name: 'settings', flush: resolving(() => calls.push('settings')) }]
    }

    expect(shutdown.phase).toBe('idle')
    expect(
      shutdown.beforeQuit(() => work),
      'the first quit must be held'
    ).toBe(false)
    expect(shutdown.phase).toBe('running')
    await settle()

    expect(calls).toEqual(['settings'])
    expect(shutdown.phase).toBe('done')
    expect(reports).toEqual([{ clear: 'skipped', hung: [], failed: [] }])
    // The quit `finish` asks for arrives as another `before-quit`, and that one goes through.
    expect(shutdown.beforeQuit(() => work)).toBe(true)
    expect(calls).toEqual(['settings'])
    expect(reports).toHaveLength(1)
  })

  it('does nothing but hold a second quit that arrives while the first is running', async () => {
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)
    const clearing = deferred()
    let begun = 0
    let cleared = 0
    let flushed = 0
    const begin = (): ShutdownWork => {
      begun += 1
      return {
        clear: {
          run: () => {
            cleared += 1
            return clearing.promise
          },
          remember: () => Promise.resolve()
        },
        flushes: [{ name: 'history', flush: resolving(() => (flushed += 1)) }]
      }
    }

    expect(shutdown.beforeQuit(begin)).toBe(false)
    expect(shutdown.beforeQuit(begin), 'a second quit while running must still be held').toBe(false)
    expect(shutdown.beforeQuit(begin)).toBe(false)
    clearing.resolve()
    await settle()

    expect(begun).toBe(1)
    expect(cleared).toBe(1)
    expect(flushed).toBe(1)
    expect(reports).toHaveLength(1)
  })

  it('clears before it flushes, so what the clearing changed is what gets written', async () => {
    const timers = fakeTimers()
    const { shutdown } = sequence(timers)
    const order: string[] = []
    const clearing = deferred()

    shutdown.beforeQuit(() => ({
      clear: {
        run: () => {
          order.push('clear')
          return clearing.promise
        },
        remember: () => Promise.resolve()
      },
      flushes: [{ name: 'history', flush: resolving(() => order.push('flush')) }]
    }))
    await settle()
    expect(order, 'a flush started while the clearing was still running').toEqual(['clear'])

    clearing.resolve()
    await settle()
    expect(order).toEqual(['clear', 'flush'])
  })

  it('gives up on a write after ten seconds and names the store it gave up on', async () => {
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)
    const hanging = deferred()

    shutdown.beforeQuit(() => ({
      clear: null,
      flushes: [
        { name: 'settings', flush: () => Promise.resolve() },
        { name: 'passwords', flush: () => hanging.promise },
        { name: 'history', flush: () => Promise.resolve() }
      ]
    }))
    await settle()
    timers.advance(FLUSH_TIMEOUT_MS - 1)
    await settle()
    expect(shutdown.phase, 'gave up before the deadline').toBe('running')
    expect(reports).toEqual([])

    timers.advance(1)
    await settle()
    expect(shutdown.phase).toBe('done')
    expect(reports).toEqual([{ clear: 'skipped', hung: ['passwords'], failed: [] }])
    expect(FLUSH_TIMEOUT_MS).toBe(10_000)

    // A write that finishes after the deadline changes nothing: the sequence has already ended.
    hanging.resolve()
    await settle()
    expect(reports).toHaveLength(1)
  })

  it('never counts a store that answers at once as hanging, and does not wait on its account', async () => {
    /*
      A store opened read-only has nothing it may write and resolves its flush immediately. If the
      deadline were the only way out, every quit with such a store open would take ten seconds.
    */
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)

    shutdown.beforeQuit(() => ({
      clear: null,
      flushes: [{ name: 'bookmarks (read-only)', flush: () => Promise.resolve() }]
    }))
    await settle()

    expect(shutdown.phase).toBe('done')
    expect(reports).toEqual([{ clear: 'skipped', hung: [], failed: [] }])
    expect(timers.live(), 'the deadline was left running after everything had finished').toBe(0)
  })

  it('is done at once when nothing has registered yet, as in a quit during startup', async () => {
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)

    shutdown.beforeQuit(() => ({ clear: null, flushes: [] }))
    await settle()

    expect(shutdown.phase).toBe('done')
    expect(reports).toEqual([{ clear: 'skipped', hung: [], failed: [] }])
    expect(timers.live()).toBe(0)
  })

  it('lets every other store write when one cannot, and says which one failed', async () => {
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)
    const written: string[] = []
    const refusal = new Error('disk full')

    shutdown.beforeQuit(() => ({
      clear: null,
      flushes: [
        { name: 'settings', flush: () => Promise.reject(refusal) },
        {
          name: 'thrower',
          flush: () => {
            throw refusal
          }
        },
        { name: 'history', flush: resolving(() => written.push('history')) }
      ]
    }))
    await settle()

    expect(written).toEqual(['history'])
    expect(reports).toEqual([
      {
        clear: 'skipped',
        hung: [],
        failed: [
          { name: 'settings', reason: refusal },
          { name: 'thrower', reason: refusal }
        ]
      }
    ])
  })

  it('stops waiting for the clearing after thirty seconds and leaves a note for the next start', async () => {
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)
    const order: string[] = []

    shutdown.beforeQuit(() => ({
      clear: {
        run: () => new Promise<void>(() => undefined),
        remember: resolving(() => order.push('remember'))
      },
      flushes: [{ name: 'history', flush: resolving(() => order.push('history')) }]
    }))
    await settle()
    timers.advance(CLEAR_TIMEOUT_MS - 1)
    await settle()
    expect(order, 'the flushes started before the clearing had its thirty seconds').toEqual([])
    expect(shutdown.phase).toBe('running')

    timers.advance(1)
    await settle()
    expect(CLEAR_TIMEOUT_MS).toBe(30_000)
    expect(order.sort()).toEqual(['history', 'remember'])
    expect(shutdown.phase).toBe('done')
    expect(reports).toEqual([{ clear: 'timed-out', hung: [], failed: [] }])
  })

  it('leaves the same note when the clearing fails outright', async () => {
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)
    let remembered = 0
    const refusal = new Error('storage partition busy')

    shutdown.beforeQuit(() => ({
      clear: { run: () => Promise.reject(refusal), remember: resolving(() => (remembered += 1)) },
      flushes: []
    }))
    await settle()

    expect(remembered).toBe(1)
    expect(reports).toEqual([{ clear: 'failed', hung: [], failed: [] }])
    expect(timers.live(), 'the clearing deadline outlived the clearing').toBe(0)
  })

  it('leaves no note when the clearing finished', async () => {
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)
    let remembered = 0

    shutdown.beforeQuit(() => ({
      clear: { run: () => Promise.resolve(), remember: resolving(() => (remembered += 1)) },
      flushes: []
    }))
    await settle()

    expect(remembered).toBe(0)
    expect(reports).toEqual([{ clear: 'done', hung: [], failed: [] }])
    expect(timers.live(), 'the clearing deadline outlived the clearing').toBe(0)
  })

  it('bounds writing the note by the same ten seconds as every other write', async () => {
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)

    shutdown.beforeQuit(() => ({
      clear: {
        run: () => Promise.reject(new Error('no')),
        remember: () => new Promise<void>(() => undefined)
      },
      flushes: []
    }))
    await settle()
    expect(shutdown.phase).toBe('running')
    timers.advance(FLUSH_TIMEOUT_MS)
    await settle()

    expect(shutdown.phase).toBe('done')
    expect(reports).toEqual([{ clear: 'failed', hung: ['clear-on-exit note'], failed: [] }])
  })

  it('still ends when gathering the work throws, rather than holding every quit for ever', async () => {
    /*
      `beforeQuit` has already moved to `running` when it asks for the work. Were a throw there to
      escape, every later quit would be held by a sequence that never started — a browser that cannot
      be closed.
    */
    const timers = fakeTimers()
    const { shutdown, reports } = sequence(timers)
    const broken = new Error('settings gone')

    expect(
      shutdown.beforeQuit(() => {
        throw broken
      })
    ).toBe(false)
    await settle()

    expect(shutdown.phase).toBe('done')
    expect(reports).toEqual([
      { clear: 'skipped', hung: [], failed: [{ name: 'shutdown', reason: broken }] }
    ])
    expect(shutdown.beforeQuit(() => ({ clear: null, flushes: [] }))).toBe(true)
  })
})

describe('the flush registry', () => {
  it('hands back every flush with its name, in the order they were registered', () => {
    const registry = new FlushRegistry()
    const first = (): Promise<void> => Promise.resolve()
    const second = (): Promise<void> => Promise.resolve()
    registry.push(first, 'settings')
    registry.push(second, 'history')

    const entries = registry.entries()
    expect(entries).toEqual([
      { name: 'settings', flush: first },
      { name: 'history', flush: second }
    ])
    // A copy: a store registering after the shutdown began cannot change the list being worked on.
    registry.push(first, 'late')
    expect(entries).toHaveLength(2)
    expect(registry.entries()).toHaveLength(3)
  })
})

describe('the clearing the last quit did not finish', () => {
  const FALLBACK = ['cookies', 'cache', 'storage'] as const

  it('is written as the categories and read back as the same', () => {
    expect(readPendingClear(pendingClearText(['cookies', 'cache']), FALLBACK)).toEqual([
      'cookies',
      'cache'
    ])
    expect(pendingClearText([])).toBe('{\n  "categories": []\n}\n')
  })

  it('reads a note it cannot make sense of as the full clearing, not as none', () => {
    // The note exists because the user asked for their data to go; a damaged one must not undo that.
    expect(readPendingClear('not json', FALLBACK)).toEqual(FALLBACK)
    expect(readPendingClear('null', FALLBACK)).toEqual(FALLBACK)
    expect(readPendingClear('[]', FALLBACK)).toEqual(FALLBACK)
    expect(readPendingClear('{"categories":"cookies"}', FALLBACK)).toEqual(FALLBACK)
    // Entries that are not names are dropped, the rest kept.
    expect(readPendingClear('{"categories":["cookies",3,null]}', FALLBACK)).toEqual(['cookies'])
  })

  it('is done at the next start and the note removed afterwards', async () => {
    const timers = fakeTimers()
    const order: string[] = []
    const outcome = await catchUpPendingClear({
      read: () => Promise.resolve(pendingClearText(['cookies'])),
      clear: (categories) => resolving(() => order.push(`clear:${categories.join(',')}`))(),
      forget: resolving(() => order.push('forget')),
      fallback: FALLBACK,
      after: timers.after
    })

    expect(outcome).toBe('cleared')
    expect(order).toEqual(['clear:cookies', 'forget'])
    expect(timers.live()).toBe(0)
  })

  it('does nothing when no note was left', async () => {
    const timers = fakeTimers()
    const order: string[] = []
    const outcome = await catchUpPendingClear({
      read: () => Promise.resolve(null),
      clear: resolving(() => order.push('clear')),
      forget: resolving(() => order.push('forget')),
      fallback: FALLBACK,
      after: timers.after
    })

    expect(outcome).toBe('none')
    expect(order).toEqual([])
  })

  it('keeps the note when the clearing fails again, so the start after tries once more', async () => {
    const timers = fakeTimers()
    let forgotten = 0
    const outcome = await catchUpPendingClear({
      read: () => Promise.resolve(pendingClearText(['cache'])),
      clear: () => Promise.reject(new Error('still busy')),
      forget: resolving(() => (forgotten += 1)),
      fallback: FALLBACK,
      after: timers.after
    })

    expect(outcome).toBe('still-pending')
    expect(forgotten).toBe(0)
    expect(timers.live()).toBe(0)
  })

  it('keeps the note and lets the start go on when the clearing hangs for thirty seconds', async () => {
    const timers = fakeTimers()
    let forgotten = 0
    const running = catchUpPendingClear({
      read: () => Promise.resolve(pendingClearText(['cache'])),
      clear: () => new Promise<void>(() => undefined),
      forget: resolving(() => (forgotten += 1)),
      fallback: FALLBACK,
      after: timers.after
    })
    let outcome: string | null = null
    void running.then((value) => {
      outcome = value
    })

    await settle()
    timers.advance(CLEAR_TIMEOUT_MS - 1)
    await settle()
    expect(outcome).toBeNull()

    timers.advance(1)
    await settle()
    expect(outcome).toBe('still-pending')
    expect(forgotten).toBe(0)
  })
})
