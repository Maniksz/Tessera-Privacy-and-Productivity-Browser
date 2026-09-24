import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ArrangementStore, type ArrangementBook } from '@main/data/ArrangementStore.js'
import { plainJsonDocumentCodec, type DocumentCodec } from '@main/data/JsonStore.js'
import {
  MAX_ARRANGEMENTS,
  type Arrangement,
  type ArrangementDocument,
  type WindowTabs
} from '@shared/arrangements/model.js'

/**
 * The arrangement store: identity, the clock, the write path, and who is allowed to use it.
 *
 * Every rule about *what* an arrangement may be is asserted in `arrangements-model.test.ts`
 * against the pure functions. What is left for this file is the three things the model cannot
 * do — make an id, read the clock, reach the disk — plus the one thing only the store can get
 * wrong: handing a private window a book that writes.
 *
 * Ids and the clock are injected everywhere except the two tests that are *about* the
 * defaults, so nothing here depends on when the run happened or how many tests preceded it.
 *
 * "Nothing was written" is asserted against the filesystem rather than against the store's own
 * answer: a private window leaving no trace is the requirement, and the trace would be on disk.
 */

const T0 = 1_700_000_000_000

/** A window that owns these tabs and is hiding none of them. */
function windowWith(...liveTabIds: string[]): WindowTabs {
  return { liveTabIds, hiddenTabIds: [] }
}

interface Fixture {
  store: ArrangementStore
  filePath: string
}

async function openStore(
  options: { debounceMs?: number; seed?: unknown; codec?: boolean } = {}
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-arrangements-'))
  const filePath = join(dir, 'arrangements.json')
  if (options.seed !== undefined) {
    await writeFile(filePath, JSON.stringify(options.seed), 'utf8')
  }

  let sequence = 0
  const store = await ArrangementStore.open({
    filePath,
    // No debounce by default: the assertions read the file straight after a write.
    debounceMs: options.debounceMs ?? 0,
    generateId: () => {
      sequence += 1
      return `a${sequence}`
    },
    now: () => T0 + sequence * 1_000,
    ...(options.codec === true ? { codec: plainJsonDocumentCodec } : {})
  })
  return { store, filePath }
}

async function storedArrangements(filePath: string): Promise<Arrangement[]> {
  const text = await readFile(filePath, 'utf8')
  return (JSON.parse(text) as ArrangementDocument).arrangements
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * A codec that leaves nothing readable in the file.
 *
 * Not encryption — base64 hides nothing from anyone trying — but it stands in for the real
 * codec in the one respect that matters to a store: the bytes on disk are not the document. A
 * test using the *plain* codec cannot tell a store that forwards its codec from one that
 * ignores it, which is how such a forwarding stays unasserted.
 */
function sealingCodec(): DocumentCodec {
  const marker = 'sealed:'
  return {
    encode: (data) =>
      new TextEncoder().encode(
        `${marker}${Buffer.from(JSON.stringify(data), 'utf8').toString('base64')}`
      ),
    decode: (bytes) => {
      const text = new TextDecoder().decode(bytes)
      if (!text.startsWith(marker)) throw new Error('not written by this codec')
      return JSON.parse(
        Buffer.from(text.slice(marker.length), 'base64').toString('utf8')
      ) as unknown
    }
  }
}

/** A recording as the file holds one, so a fixture can be deliberately broken. */
function stored(
  id: string,
  layoutId: string,
  seats: unknown[],
  overrides: Record<string, unknown> = {}
): unknown {
  return { id, layoutId, seats, recordedAt: T0, ...overrides }
}

describe('ArrangementStore basics', () => {
  it('starts empty when there is no file yet', async () => {
    const { store, filePath } = await openStore()
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(false)
    expect(await exists(filePath)).toBe(false)
  })

  it('records a tiling and puts it on disk with its layout and seating', async () => {
    const { store, filePath } = await openStore()
    store.record(
      { layoutId: '2x2', seats: ['tab-1', null, 'tab-2', null] },
      windowWith('tab-1', 'tab-2')
    )
    await store.flush()

    expect(await storedArrangements(filePath)).toEqual([
      { id: 'a1', layoutId: '2x2', seats: ['tab-1', null, 'tab-2', null], recordedAt: T0 + 1_000 }
    ])
  })

  it('brings a recording back, whole, after reopening the same file', async () => {
    /*
      The point of the store existing at all (R8/KD3). Both halves of a recording are asserted:
      the layout id and the seating *by position*, because a store that flattened the empty
      tiles away would still round-trip a list of tab ids and would restore the panes in the
      wrong places.
    */
    const { store, filePath } = await openStore()
    store.record({ layoutId: '1+2', seats: ['tab-1', null, 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    await store.flush()

    const reopened = await ArrangementStore.open({ filePath, debounceMs: 0 })
    expect(reopened.list()).toEqual([
      { id: 'a1', layoutId: '1+2', seats: ['tab-1', null, 'tab-2'], recordedAt: T0 + 1_000 }
    ])
  })

  it('hands out copies, so a caller cannot reseat the document', async () => {
    // `seats` is the array that makes a shallow copy a bug: a window holding a snapshot could
    // otherwise move a page between panes without going through a rule.
    const { store } = await openStore()
    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))

    store.list()[0]!.seats[0] = 'smuggled'
    store.arrangementOfTab('tab-2', windowWith('tab-1', 'tab-2'))!.seats[1] = 'smuggled'

    expect(store.list()).toEqual([
      { id: 'a1', layoutId: '1x2', seats: ['tab-1', 'tab-2'], recordedAt: T0 + 1_000 }
    ])
  })

  it('looks a recording up by a tab, and only for the window that owns it', async () => {
    // The window-scoping parameters have to survive the trip through the store: dropped, a
    // click in one window would re-tile another (R16).
    const { store } = await openStore()
    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))

    expect(store.arrangementOfTab('tab-1', windowWith('tab-1', 'tab-2'))?.id).toBe('a1')
    expect(store.arrangementOfTab('tab-9', windowWith('tab-1', 'tab-2'))).toBeUndefined()
    expect(store.arrangementOfTab('tab-1', windowWith('tab-1'))).toBeUndefined()
    expect(
      store.arrangementOfTab('tab-1', { liveTabIds: ['tab-1', 'tab-2'], hiddenTabIds: ['tab-2'] })
    ).toBeUndefined()
  })

  it('refuses a draft naming a tab the calling window does not own', async () => {
    /*
      The rule is the model's; what is asserted here is that the store passes the window through
      instead of quietly recording on behalf of everybody. Dropped, one window's settle would
      write down an arrangement over tabs it does not own (R16).

      The refusal still reaches the disk as an unchanged document, and deliberately so: this
      store writes on every call because "did anything change" is the caller's question —
      `arrangementIsCurrent` is the gate, and it lives in the controller that settles, not here.
    */
    const { store, filePath } = await openStore()
    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1'))
    await store.flush()

    expect(store.list()).toEqual([])
    expect(await storedArrangements(filePath)).toEqual([])
  })

  it('forgets one recording by id and writes the removal down', async () => {
    const { store, filePath } = await openStore()
    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    store.record({ layoutId: '1x2', seats: ['tab-3', 'tab-4'] }, windowWith('tab-3', 'tab-4'))
    await store.flush()
    expect(await storedArrangements(filePath)).toHaveLength(2)

    store.forget('a1')
    await store.flush()
    expect((await storedArrangements(filePath)).map((entry) => entry.id)).toEqual(['a2'])
  })

  it('keeps only the tabs a session brought back', async () => {
    const { store, filePath } = await openStore()
    store.record(
      { layoutId: '2x2', seats: ['tab-1', 'tab-2', 'tab-3', null] },
      windowWith('tab-1', 'tab-2', 'tab-3')
    )
    store.record({ layoutId: '1x2', seats: ['tab-4', 'tab-5'] }, windowWith('tab-4', 'tab-5'))

    store.retainTabs(['tab-1', 'tab-2'])
    await store.flush()
    // The second recording fell below `MIN_ARRANGED_TILES` and went; the first kept its tiles
    // rather than closing the gap, which is what makes the pages come back where they were.
    expect(await storedArrangements(filePath)).toEqual([
      { id: 'a1', layoutId: '2x2', seats: ['tab-1', 'tab-2', null, null], recordedAt: T0 + 1_000 }
    ])
  })

  it('tells every listener about a change with the whole list, and stops when unsubscribed', async () => {
    const { store } = await openStore()
    const seen: string[][] = []
    const unsubscribe = store.onChange((arrangements) => seen.push(arrangements.map((a) => a.id)))

    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    store.record({ layoutId: '1x2', seats: ['tab-3', 'tab-4'] }, windowWith('tab-3', 'tab-4'))
    store.retainTabs(['tab-1', 'tab-2', 'tab-3', 'tab-4'])
    store.forget('a1')
    unsubscribe()
    store.forget('a2')

    // Every write operation, and each one carrying the full list rather than the entry that moved.
    expect(seen).toEqual([['a1'], ['a1', 'a2'], ['a1', 'a2'], ['a2']])
  })

  it('coalesces writes when a debounce is set, and flush gets them out', async () => {
    const { store, filePath } = await openStore({ debounceMs: 50 })
    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    expect(await exists(filePath)).toBe(false)

    await store.flush()
    expect(await storedArrangements(filePath)).toHaveLength(1)
  })

  it('uses the coalescing window it was given, not the default one', async () => {
    /*
      `debounceMs: 0` means "write on every change", and `JsonStore` honours it without a timer
      at all. A store that dropped the option would fall back to 250 ms and still pass every
      other test here, because they all call `flush` first — so nothing would notice that a
      caller asking for an immediate write got a coalesced one, which on a shutdown path is the
      difference between the last change being on disk and being lost.
    */
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    try {
      const { store, filePath } = await openStore()
      // `open` is not what this is about; only the write the change triggers.
      scheduled.mockClear()
      store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
      expect(scheduled, 'the write was put behind a timer').not.toHaveBeenCalled()

      await store.flush()
      expect(await exists(filePath)).toBe(true)
    } finally {
      scheduled.mockRestore()
    }
  })

  it('works through an injected codec', async () => {
    const { store, filePath } = await openStore({ codec: true })
    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    await store.flush()
    expect(await storedArrangements(filePath)).toHaveLength(1)
  })

  it('puts the codec between the recordings and the disk, not beside it', async () => {
    /*
      KTD9, and the reason it is a decision rather than a detail: `codec` is optional in the
      store options and `JsonStore` falls back to plain text without a word, so an omission
      produces neither a type error nor a red test anywhere else.

      The test above passes the *plain* codec, so the file looks identical whether the store
      forwards the codec or drops it. This one uses a codec whose output cannot be mistaken for
      JSON, and asserts that fact the way the plan states it: `JSON.parse` on the bytes fails.

      What is at stake is the same class of data the group file holds — which pages a person had
      open beside which, and when — sitting in the profile directory in clear text while the
      browser reports local data as encrypted.
    */
    const dir = await mkdtemp(join(tmpdir(), 'tessera-arrangements-sealed-'))
    const filePath = join(dir, 'arrangements.json')
    const store = await ArrangementStore.open({
      filePath,
      codec: sealingCodec(),
      debounceMs: 0,
      generateId: () => 'a1',
      now: () => T0
    })
    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    await store.flush()

    const raw = await readFile(filePath, 'utf8')
    expect(
      () => {
        JSON.parse(raw)
      },
      raw.slice(0, 40)
    ).toThrow()
    expect(raw).not.toContain('tab-1')

    // And it reads its own writing back, so the codec is used in both directions.
    const reopened = await ArrangementStore.open({ filePath, codec: sealingCodec(), debounceMs: 0 })
    expect(reopened.list().map((entry) => entry.seats)).toEqual([['tab-1', 'tab-2']])
  })
})

describe('ArrangementStore defaults', () => {
  it('generates ids that do not collide', async () => {
    // The one place the default id generator is the subject rather than an obstacle.
    const dir = await mkdtemp(join(tmpdir(), 'tessera-arrangements-ids-'))
    const filePath = join(dir, 'arrangements.json')
    // Also the one place the default debounce is used, so the two writes are coalesced the way
    // they are in a running browser. `flush` cancels the pending timer.
    const store = await ArrangementStore.open({ filePath, now: () => T0 })
    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    store.record({ layoutId: '1x2', seats: ['tab-3', 'tab-4'] }, windowWith('tab-3', 'tab-4'))

    const [first, second] = store.list()
    expect(first!.id).not.toBe(second!.id)
    // The whole shape, not just the prefix. Two recordings made in the same millisecond differ
    // only in the counter, so the counter is the part that has to move *forward*: `counter -= 1`
    // also produces distinct ids, and produces them as `ar-mabc--1` — still unique, still
    // stored, and no longer the readable `ar-<time>-<n>` the file is meant to be inspectable as.
    expect(first!.id).toMatch(/^ar-[0-9a-z]+-[0-9a-z]+$/)
    expect(second!.id).toMatch(/^ar-[0-9a-z]+-[0-9a-z]+$/)

    expect(await exists(filePath)).toBe(false)
    await store.flush()
    expect(await storedArrangements(filePath)).toHaveLength(2)
  })

  it('falls back to the real clock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-arrangements-clock-'))
    const store = await ArrangementStore.open({
      filePath: join(dir, 'arrangements.json'),
      debounceMs: 0,
      generateId: () => 'a1'
    })
    const before = Date.now()
    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    const recordedAt = store.list()[0]!.recordedAt
    expect(recordedAt).toBeGreaterThanOrEqual(before)
    expect(recordedAt).toBeLessThanOrEqual(Date.now())
  })
})

describe('ArrangementStore repairing a damaged file', () => {
  it('starts from defaults when the file is not JSON at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-arrangements-broken-'))
    const filePath = join(dir, 'arrangements.json')
    await writeFile(filePath, '{ not json', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = await ArrangementStore.open({ filePath, debounceMs: 0 })
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)
    warn.mockRestore()
  })

  it('starts from defaults when an id is not a string', async () => {
    // Identity is a *kind*, not an amount: a numeric id means the file is not one this browser
    // wrote, and defaults are the only safe answer.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = await openStore({
      seed: { version: 1, arrangements: [stored('a-x', '1x2', ['tab-1', 'tab-2'], { id: 7 })] }
    })
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)
    warn.mockRestore()
  })

  it('starts from defaults on a newer version, without writing over its file', async () => {
    // Degradable: a recording is one drag to rebuild, so this run works on defaults and a newer
    // build's file stays exactly as that build wrote it.
    const seed = { version: 2, arrangements: [stored('a-1', '1x2', ['tab-1', 'tab-2'])] }
    const { store, filePath } = await openStore({ seed })
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(false)
    expect(store.loadReport).toEqual({
      outcome: { kind: 'newer', version: 2 },
      criticality: 'degradable'
    })

    store.record({ layoutId: '1x2', seats: ['tab-3', 'tab-4'] }, windowWith('tab-3', 'tab-4'))
    await store.flush()
    expect(await readFile(filePath, 'utf8')).toBe(JSON.stringify(seed))
  })

  it('copies a file it cannot read aside before starting from defaults', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, filePath } = await openStore({ seed: { version: 1, arrangements: 'none' } })
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)
    expect(store.loadReport.outcome).toMatchObject({
      kind: 'invalid',
      copy: `${filePath}.unreadable`
    })
    warn.mockRestore()
  })

  it('keeps fields it does not know, so a newer build’s additions survive a save', async () => {
    const { store, filePath } = await openStore({
      seed: {
        version: 1,
        note: 'kept',
        arrangements: [{ ...(stored('a-1', '1x2', ['tab-1', 'tab-2']) as object), pinned: true }]
      }
    })
    store.record(
      { layoutId: '2x2', seats: ['tab-3', 'tab-4', null, null] },
      windowWith('tab-3', 'tab-4')
    )
    await store.flush()
    const written = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    expect(written['note']).toBe('kept')
    expect(written['arrangements']).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'a-1', pinned: true })])
    )
  })

  it('removes its copies on request, and a private book has none to remove', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store, filePath } = await openStore({ seed: { version: 1, arrangements: 'none' } })
    expect(await exists(`${filePath}.unreadable`)).toBe(true)
    await store.discardCopies()
    expect(await exists(`${filePath}.unreadable`)).toBe(false)
    const book = store.bookFor('private') as ArrangementStore
    await expect(book.discardCopies()).resolves.toBeUndefined()
    // Nor a file to give up at panic.
    await expect(book.abandon()).resolves.toBeUndefined()
    expect(book.loadReport).toEqual({ outcome: { kind: 'missing' }, criticality: 'degradable' })
    warn.mockRestore()
  })

  it('drops a recording with an unrecognised layout instead of discarding the file', async () => {
    /*
      Two hands on one repair. The schema heals `9x9` to `1x1` — a version that dropped a layout
      must not cost the user every recording — and `1x1` is the one layout no real arrangement
      fits, so `repairArrangements` discards exactly that entry on load. The neighbouring
      recording survives, and the file counts as repaired rather than rejected.
    */
    const { store } = await openStore({
      seed: {
        version: 1,
        arrangements: [
          stored('a-bad', '9x9', ['tab-1', 'tab-2']),
          stored('a-good', '1x2', ['tab-1', 'tab-2'])
        ]
      }
    })

    expect(store.list().map((entry) => entry.id)).toEqual(['a-good'])
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('repairs the invariants rather than throwing the file away', async () => {
    const { store } = await openStore({
      seed: {
        version: 1,
        arrangements: [
          // A seating of the wrong length for its layout.
          stored('a-short', '2x2', ['tab-1', 'tab-2']),
          // One tab in two tiles.
          stored('a-twice', '1x2', ['tab-3', 'tab-3']),
          // Fewer seated tabs than an arrangement needs.
          stored('a-thin', '1x2', ['tab-4', null]),
          stored('a-keep', '1x2', ['tab-5', 'tab-6']),
          // A duplicate id is one recording as far as `forget` is concerned.
          stored('a-keep', '1x2', ['tab-7', 'tab-8'])
        ]
      }
    })

    expect(store.list().map((entry) => [entry.id, entry.seats])).toEqual([
      ['a-keep', ['tab-5', 'tab-6']]
    ])
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('trims a file with more recordings than the cap', async () => {
    const arrangements = Array.from({ length: MAX_ARRANGEMENTS + 3 }, (_, index) =>
      stored(`a${index}`, '1x2', [`tab-${index}-a`, `tab-${index}-b`])
    )
    const { store } = await openStore({ seed: { version: 1, arrangements } })
    expect(store.list()).toHaveLength(MAX_ARRANGEMENTS)
  })

  it('heals a seat that is not a tab id instead of losing the recording', async () => {
    const { store } = await openStore({
      seed: {
        version: 1,
        arrangements: [stored('a-x', '1+2', ['tab-1', 42, 'tab-2'])]
      }
    })
    expect(store.list()).toEqual([
      { id: 'a-x', layoutId: '1+2', seats: ['tab-1', null, 'tab-2'], recordedAt: T0 }
    ])
    expect(store.recoveredFromInvalidFile).toBe(false)
  })
})

describe('a private window stores nothing', () => {
  it('hands a normal window the store itself', async () => {
    const { store } = await openStore()
    expect(store.bookFor('normal')).toBe(store)
  })

  it('never touches the file, however much a private window does', async () => {
    const { store, filePath } = await openStore()
    const book = store.bookFor('private')

    book.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    book.record(
      { layoutId: '2x2', seats: ['tab-3', 'tab-4', null, null] },
      windowWith('tab-3', 'tab-4')
    )
    book.retainTabs(['tab-1', 'tab-2', 'tab-3', 'tab-4'])
    book.forget(book.list()[0]!.id)
    await book.flush()

    expect(book.list()).toHaveLength(1)
    // The file was never created, and the normal session never heard about any of it.
    expect(await exists(filePath)).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('cannot see the normal session’s recordings', async () => {
    const { store } = await openStore()
    store.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    expect(store.bookFor('private').list()).toEqual([])
  })

  it('gives each private window its own recordings', async () => {
    const { store } = await openStore()
    const first = store.bookFor('private')
    const second = store.bookFor('private')

    first.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    expect(second.list()).toEqual([])
    expect(second.arrangementOfTab('tab-1', windowWith('tab-1', 'tab-2'))).toBeUndefined()
    expect(first.list()).toHaveLength(1)
  })

  it('obeys the same rules as the persisting one', async () => {
    const { store } = await openStore()
    const book = store.bookFor('private')
    // One tab in two tiles is not an arrangement, here as anywhere.
    book.record({ layoutId: '1x2', seats: ['tab-1', 'tab-1'] }, windowWith('tab-1'))
    expect(book.list()).toEqual([])

    book.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    expect(book.arrangementOfTab('tab-2', windowWith('tab-1', 'tab-2'))?.layoutId).toBe('1x2')
  })

  it('notifies and unsubscribes like the persisting one', async () => {
    const { store } = await openStore()
    const book = store.bookFor('private')
    const seen: number[] = []
    const unsubscribe = book.onChange((arrangements) => seen.push(arrangements.length))

    book.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))
    unsubscribe()
    book.record({ layoutId: '1x2', seats: ['tab-3', 'tab-4'] }, windowWith('tab-3', 'tab-4'))
    expect(seen).toEqual([1])
  })

  it('lets one bad listener not stop the others', async () => {
    const { store } = await openStore()
    const book: ArrangementBook = store.bookFor('private')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reached: string[] = []

    book.onChange(() => {
      throw new Error('listener is broken')
    })
    book.onChange(() => reached.push('second'))
    book.record({ layoutId: '1x2', seats: ['tab-1', 'tab-2'] }, windowWith('tab-1', 'tab-2'))

    expect(reached).toEqual(['second'])
    // Named, not merely logged. A private window's book is the one place a listener can throw
    // with nothing else watching, and an anonymous console line leaves the reader unable to tell
    // which subsystem swallowed the error.
    expect(error).toHaveBeenCalledWith('[arrangements] listener threw:', expect.any(Error))
    error.mockRestore()
  })

  it('has nothing to recover from, because it has no file', async () => {
    const { store } = await openStore()
    expect(store.bookFor('private').recoveredFromInvalidFile).toBe(false)
  })
})
