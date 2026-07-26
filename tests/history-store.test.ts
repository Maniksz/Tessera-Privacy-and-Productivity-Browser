import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HistoryStore } from '@main/data/HistoryStore.js'
import { plainJsonDocumentCodec } from '@main/data/JsonStore.js'
import {
  MAX_HISTORY_ENTRIES,
  discardingHistoryRecorder,
  type HistoryDocument,
  type HistoryVisit
} from '@shared/history/model.js'

/**
 * The history store: the clock, the write path, and who is allowed to use it.
 *
 * The clock is injected in every test but one, so nothing depends on when the run
 * happened. The exception is the test for the default clock itself, which is the only
 * place `Date.now()` is legitimately the subject.
 *
 * Assertions about "nothing was written" read the file from disk rather than trusting
 * the in-memory answer: private mode leaving no trace is the requirement, and the trace
 * is on disk.
 */

const T0 = 1_700_000_000_000

interface Fixture {
  store: HistoryStore
  filePath: string
}

async function openStore(options: { debounceMs?: number; codec?: boolean } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-history-'))
  const filePath = join(dir, 'history.json')
  // A second per call, so ordering assertions are about the code and not the runtime.
  let step = 0
  const tick = (): number => {
    step += 1
    return T0 + step * 1_000
  }

  const store = await HistoryStore.open({
    filePath,
    // No debounce by default: the assertions read the file straight after a write.
    debounceMs: options.debounceMs ?? 0,
    now: tick,
    ...(options.codec === true ? { codec: plainJsonDocumentCodec } : {})
  })
  return { store, filePath }
}

async function storedVisits(filePath: string): Promise<HistoryVisit[]> {
  const text = await readFile(filePath, 'utf8')
  return (JSON.parse(text) as HistoryDocument).visits
}

async function writeDocument(filePath: string, document: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(document), 'utf8')
}

describe('HistoryStore recording', () => {
  it('starts empty when there is no file yet', async () => {
    const { store } = await openStore()
    expect(store.query()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('records a visit and puts it on disk', async () => {
    const { store, filePath } = await openStore()
    store.recorderFor('normal').recordVisit({ url: 'https://example.com', title: 'Example' })

    expect(store.query()).toEqual([
      {
        url: 'https://example.com/',
        title: 'Example',
        firstVisitedAt: T0 + 1_000,
        lastVisitedAt: T0 + 1_000,
        visitCount: 1
      }
    ])

    await store.flush()
    expect(await storedVisits(filePath)).toHaveLength(1)
  })

  it('counts a repeat visit on the existing entry', async () => {
    const { store } = await openStore()
    const recorder = store.recorderFor('normal')
    recorder.recordVisit({ url: 'https://example.com', title: 'Example' })
    recorder.recordVisit({ url: 'https://example.com/', title: 'Example' })

    expect(store.query()).toEqual([
      {
        url: 'https://example.com/',
        title: 'Example',
        firstVisitedAt: T0 + 1_000,
        lastVisitedAt: T0 + 2_000,
        visitCount: 2
      }
    ])
  })

  it('fills in a title that arrives after the visit', async () => {
    const { store } = await openStore()
    const recorder = store.recorderFor('normal')
    recorder.recordVisit({ url: 'https://example.com' })
    recorder.noteTitle({ url: 'https://example.com', title: 'Example Domain' })

    expect(store.query().map((visit) => visit.title)).toEqual(['Example Domain'])
    // A title is not a visit.
    expect(store.query().map((visit) => visit.visitCount)).toEqual([1])
  })

  it('writes nothing for an address it does not keep', async () => {
    const { store } = await openStore()
    const seen: HistoryVisit[][] = []
    store.onChange((visits) => seen.push(visits))

    store.recorderFor('normal').recordVisit({ url: 'tessera://start' })

    // Not merely absent from the list: no listener was woken and no write scheduled,
    // which is what keeps a start-page navigation from costing a file write.
    expect(seen).toEqual([])
    expect(store.query()).toEqual([])
  })

  it('writes nothing for a title about an address it never recorded', async () => {
    const { store } = await openStore()
    const seen: HistoryVisit[][] = []
    store.onChange((visits) => seen.push(visits))

    store.recorderFor('normal').noteTitle({ url: 'https://never.example/', title: 'Never' })
    store.recorderFor('normal').noteTitle({ url: 'about:blank', title: 'Blank' })

    expect(seen).toEqual([])
  })

  it('uses the real clock when no clock is injected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-history-'))
    const before = Date.now()
    const store = await HistoryStore.open({ filePath: join(dir, 'history.json'), debounceMs: 0 })
    store.recorderFor('normal').recordVisit({ url: 'https://example.com' })

    const stamp = store.query().at(0)?.lastVisitedAt ?? 0
    expect(stamp).toBeGreaterThanOrEqual(before)
    expect(stamp).toBeLessThanOrEqual(Date.now())
  })

  it('notifies listeners until they unsubscribe', async () => {
    const { store } = await openStore()
    const seen: number[] = []
    const unsubscribe = store.onChange((visits) => seen.push(visits.length))

    const recorder = store.recorderFor('normal')
    recorder.recordVisit({ url: 'https://a.example/' })
    unsubscribe()
    recorder.recordVisit({ url: 'https://b.example/' })

    expect(seen).toEqual([1])
  })
})

describe('HistoryStore in a private window', () => {
  it('hands out a recorder that holds no store at all', async () => {
    // The structural part of the guarantee: the private recorder is not a bound
    // closure with a flag, it is an object with no reference to any file. A call site
    // that forgets to check cannot leak a visit, because there is nowhere for it to go.
    const { store } = await openStore()
    expect(store.recorderFor('private')).toBe(discardingHistoryRecorder)
  })

  it('writes nothing, in memory or on disk', async () => {
    const { store, filePath } = await openStore()
    const seen: HistoryVisit[][] = []
    store.onChange((visits) => seen.push(visits))

    const recorder = store.recorderFor('private')
    recorder.recordVisit({ url: 'https://secret.example/', title: 'Secret' })
    recorder.recordVisit({ url: 'https://secret.example/other', title: 'Also secret' })
    recorder.noteTitle({ url: 'https://secret.example/', title: 'Secret' })

    expect(store.query()).toEqual([])
    expect(seen).toEqual([])

    await store.flush()
    expect(await storedVisits(filePath)).toEqual([])
  })

  it('does not stop a normal window from recording the same address', async () => {
    // Two windows, one store: private mode is a property of the recorder, not of the
    // address or of the store.
    const { store } = await openStore()
    store.recorderFor('private').recordVisit({ url: 'https://example.com' })
    store.recorderFor('normal').recordVisit({ url: 'https://example.com' })

    expect(store.query().map((visit) => visit.visitCount)).toEqual([1])
  })

  it('still lets a private window clear the history', async () => {
    // Clearing is a user's instruction about their own data, not a write into the
    // session's own trace, so it is deliberately not behind the recorder.
    const { store } = await openStore()
    store.recorderFor('normal').recordVisit({ url: 'https://example.com' })
    expect(store.clear()).toBe(1)
    expect(store.query()).toEqual([])
  })
})

describe('HistoryStore queries', () => {
  async function seeded(): Promise<Fixture> {
    const fixture = await openStore()
    const recorder = fixture.store.recorderFor('normal')
    recorder.recordVisit({ url: 'https://news.example/world', title: 'World news' })
    recorder.recordVisit({ url: 'https://docs.example/api', title: 'API reference' })
    recorder.recordVisit({ url: 'https://shop.example/cart', title: 'Your basket' })
    return fixture
  }

  it('answers with everything, most recent first', async () => {
    const { store } = await seeded()
    expect(store.query().map((visit) => visit.url)).toEqual([
      'https://shop.example/cart',
      'https://docs.example/api',
      'https://news.example/world'
    ])
  })

  it('answers a fragment against address and title, capped', async () => {
    const { store } = await seeded()
    expect(store.query({ text: 'basket' }).map((visit) => visit.url)).toEqual([
      'https://shop.example/cart'
    ])
    expect(store.query({ text: 'example', limit: 2 })).toHaveLength(2)
  })

  it('answers a time range', async () => {
    const { store } = await seeded()
    // The three visits land at T0+1s, +2s and +3s.
    expect(store.query({ from: T0 + 2_000, to: T0 + 2_999 }).map((visit) => visit.url)).toEqual([
      'https://docs.example/api'
    ])
  })

  it('hands out copies, so a caller cannot edit the stored list', async () => {
    const { store } = await seeded()
    store.query().length = 0
    expect(store.query()).toHaveLength(3)
  })
})

describe('HistoryStore deletion', () => {
  async function seeded(): Promise<Fixture> {
    const fixture = await openStore()
    const recorder = fixture.store.recorderFor('normal')
    recorder.recordVisit({ url: 'https://www.example.com/one' })
    recorder.recordVisit({ url: 'https://blog.example.com/two' })
    recorder.recordVisit({ url: 'https://other.org/three' })
    return fixture
  }

  it('removes a single entry and reports the count', async () => {
    const { store, filePath } = await seeded()
    expect(store.removeVisit('https://other.org/three')).toBe(1)
    expect(store.removeVisit('https://other.org/three')).toBe(0)

    await store.flush()
    expect((await storedVisits(filePath)).map((visit) => visit.url)).toEqual([
      'https://blog.example.com/two',
      'https://www.example.com/one'
    ])
  })

  it('removes everything belonging to a site', async () => {
    const { store } = await seeded()
    expect(store.removeDomain('example.com')).toBe(2)
    expect(store.query().map((visit) => visit.url)).toEqual(['https://other.org/three'])
  })

  it('removes a window of time', async () => {
    const { store } = await seeded()
    // The first two visits, at T0+1s and T0+2s.
    expect(store.removeRange(T0 + 500, T0 + 2_500)).toBe(2)
    expect(store.query().map((visit) => visit.url)).toEqual(['https://other.org/three'])
  })

  it('removes everything, which is what clearing on exit does', async () => {
    const { store, filePath } = await seeded()
    expect(store.clear()).toBe(3)
    expect(store.query()).toEqual([])

    // Awaited on purpose: work started at exit but not awaited runs into nothing, and
    // "clear history on exit" that leaves the file behind is the worst kind of failure.
    await store.flush()
    expect(await storedVisits(filePath)).toEqual([])
  })
})

describe('HistoryStore on disk', () => {
  it('reads back what a previous run wrote', async () => {
    const { store, filePath } = await openStore()
    store.recorderFor('normal').recordVisit({ url: 'https://example.com', title: 'Example' })
    await store.flush()

    const restarted = await HistoryStore.open({ filePath, debounceMs: 0 })
    expect(restarted.query().map((visit) => visit.url)).toEqual(['https://example.com/'])
    expect(restarted.recoveredFromInvalidFile).toBe(false)
  })

  it('works through an injected codec', async () => {
    // The seam encryption at rest will use; the store must not care which codec it got.
    const { store, filePath } = await openStore({ codec: true })
    store.recorderFor('normal').recordVisit({ url: 'https://example.com' })
    await store.flush()

    const restarted = await HistoryStore.open({
      filePath,
      codec: plainJsonDocumentCodec,
      debounceMs: 0
    })
    expect(restarted.query()).toHaveLength(1)
  })

  it('writes with the default debounce when none is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-history-'))
    const filePath = join(dir, 'history.json')
    const store = await HistoryStore.open({ filePath, now: () => T0 })
    store.recorderFor('normal').recordVisit({ url: 'https://example.com' })

    // `flush` exists so a pending debounced write can be forced and awaited.
    await store.flush()
    expect(await storedVisits(filePath)).toHaveLength(1)
  })

  it('merges duplicates a hand-edited file left behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-history-'))
    const filePath = join(dir, 'history.json')
    await writeDocument(filePath, {
      version: 1,
      visits: [
        {
          url: 'https://example.com/',
          title: '',
          firstVisitedAt: T0,
          lastVisitedAt: T0,
          visitCount: 1
        },
        {
          url: 'https://example.com/',
          title: 'Example',
          firstVisitedAt: T0 - 50,
          lastVisitedAt: T0 + 50,
          visitCount: 4
        }
      ]
    })

    const store = await HistoryStore.open({ filePath, debounceMs: 0 })
    expect(store.query()).toEqual([
      {
        url: 'https://example.com/',
        title: 'Example',
        firstVisitedAt: T0 - 50,
        lastVisitedAt: T0 + 50,
        visitCount: 5
      }
    ])
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('trims a file that grew past the cap instead of discarding it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-history-'))
    const filePath = join(dir, 'history.json')
    const visits = Array.from({ length: MAX_HISTORY_ENTRIES + 3 }, (_unused, index) => ({
      url: `https://example.com/page-${index}`,
      title: `Page ${index}`,
      firstVisitedAt: T0,
      lastVisitedAt: T0 + MAX_HISTORY_ENTRIES - index,
      visitCount: 1
    }))
    await writeDocument(filePath, { version: 1, visits })

    const store = await HistoryStore.open({ filePath, debounceMs: 0 })
    expect(store.query()).toHaveLength(MAX_HISTORY_ENTRIES)
    // The most recent survive; the three oldest are what went.
    expect(store.query().at(0)?.url).toBe('https://example.com/page-0')
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('falls back to an empty history when the file is not ours', async () => {
    // A wrong *kind* of value means the file cannot be interpreted, and a browser that
    // refuses to start is worse than one that starts with no history.
    const dir = await mkdtemp(join(tmpdir(), 'tessera-history-'))
    const filePath = join(dir, 'history.json')
    await writeDocument(filePath, { version: 1, visits: [{ url: 42, title: null }] })

    const store = await HistoryStore.open({ filePath, debounceMs: 0 })
    expect(store.query()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)

    // And the recovered store is usable, not wedged.
    store.recorderFor('normal').recordVisit({ url: 'https://example.com' })
    expect(store.query()).toHaveLength(1)
  })
})
