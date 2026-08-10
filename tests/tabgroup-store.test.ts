import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TabGroupStore, type TabGroupBook } from '@main/data/TabGroupStore.js'
import { plainJsonDocumentCodec, type DocumentCodec } from '@main/data/JsonStore.js'
import {
  MAX_TAB_GROUPS,
  MAX_TAB_GROUP_NAME_LENGTH,
  TabGroupNotFoundError,
  type TabGroup,
  type TabGroupDocument
} from '@shared/tabgroups/model.js'

/**
 * The tab-group store: identity, the clock, the write path, and who is allowed to use
 * it.
 *
 * Ids and the clock are injected in every test but the two that are *about* the
 * defaults, so nothing depends on when the run happened or how many tests ran before it.
 *
 * Assertions about "nothing was written" read the filesystem rather than trusting the
 * in-memory answer: a private window leaving no trace is the requirement, and the trace
 * would be on disk.
 */

const T0 = 1_700_000_000_000

interface Fixture {
  store: TabGroupStore
  filePath: string
}

async function openStore(
  options: { debounceMs?: number; seed?: unknown; codec?: boolean } = {}
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-tabgroups-'))
  const filePath = join(dir, 'tabgroups.json')
  if (options.seed !== undefined) {
    await writeFile(filePath, JSON.stringify(options.seed), 'utf8')
  }

  let sequence = 0
  const store = await TabGroupStore.open({
    filePath,
    // No debounce by default: the assertions read the file straight after a write.
    debounceMs: options.debounceMs ?? 0,
    generateId: () => {
      sequence += 1
      return `g${sequence}`
    },
    now: () => T0 + sequence * 1_000,
    ...(options.codec === true ? { codec: plainJsonDocumentCodec } : {})
  })
  return { store, filePath }
}

async function storedGroups(filePath: string): Promise<TabGroup[]> {
  const text = await readFile(filePath, 'utf8')
  return (JSON.parse(text) as TabGroupDocument).groups
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
 * Not encryption — base64 hides nothing from anyone trying — but it stands in for the
 * real codec in the one respect that matters to a store: the bytes on disk are not the
 * document. A test using the *plain* codec cannot tell a store that forwards its codec
 * from one that ignores it, which is how the forwarding stayed unasserted.
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
      return JSON.parse(Buffer.from(text.slice(marker.length), 'base64').toString('utf8')) as unknown
    }
  }
}

/** A stored group as the file holds one, so a fixture can be deliberately broken. */
function stored(id: string, tabIds: string[], overrides: Record<string, unknown> = {}): unknown {
  return { id, name: '', color: 'blue', collapsed: false, tabIds, createdAt: T0, ...overrides }
}

describe('TabGroupStore basics', () => {
  it('starts empty when there is no file yet', async () => {
    const { store, filePath } = await openStore()
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(false)
    expect(await exists(filePath)).toBe(false)
  })

  it('creates a group and puts it on disk', async () => {
    const { store, filePath } = await openStore()
    const created = store.create({ tabIds: ['tab-1', 'tab-2'], name: 'Work' })
    await store.flush()

    expect(created).toEqual({
      id: 'g1',
      name: 'Work',
      color: 'blue',
      collapsed: false,
      tabIds: ['tab-1', 'tab-2'],
      createdAt: T0 + 1_000
    })
    expect(await storedGroups(filePath)).toEqual([created])
  })

  it('gives consecutive groups different colours', async () => {
    const { store } = await openStore()
    store.create({ tabIds: ['tab-1'] })
    store.create({ tabIds: ['tab-2'] })
    expect(store.list().map((group) => group.color)).toEqual(['blue', 'cyan'])
  })

  it('finds a group by id and by member', async () => {
    const { store } = await openStore()
    store.create({ tabIds: ['tab-1'] })
    expect(store.group('g1')?.tabIds).toEqual(['tab-1'])
    expect(store.group('nope')).toBeUndefined()
    expect(store.groupOfTab('tab-1')?.id).toBe('g1')
    expect(store.groupOfTab('tab-9')).toBeUndefined()
  })

  it('hands out copies, so a caller cannot edit the document', async () => {
    const { store } = await openStore()
    store.create({ tabIds: ['tab-1'] })

    store.list()[0]!.tabIds.push('smuggled')
    store.group('g1')!.tabIds.push('smuggled')
    store.groupOfTab('tab-1')!.name = 'renamed behind the store’s back'

    expect(store.list()).toEqual([
      {
        id: 'g1',
        name: '',
        color: 'blue',
        collapsed: false,
        tabIds: ['tab-1'],
        createdAt: T0 + 1_000
      }
    ])
  })

  it('renames, recolours, collapses and dissolves, and writes each one down', async () => {
    const { store, filePath } = await openStore()
    store.create({ tabIds: ['tab-1'] })

    store.rename('g1', '  Reise  ')
    store.recolor('g1', 'orange')
    store.setCollapsed('g1', true)
    await store.flush()
    expect(await storedGroups(filePath)).toEqual([
      {
        id: 'g1',
        name: 'Reise',
        color: 'orange',
        collapsed: true,
        tabIds: ['tab-1'],
        createdAt: T0 + 1_000
      }
    ])

    store.dissolve('g1')
    await store.flush()
    expect(await storedGroups(filePath)).toEqual([])
  })

  it('adds and removes members', async () => {
    const { store } = await openStore()
    store.create({ tabIds: ['tab-1'] })
    store.addTab('g1', 'tab-2')
    store.addTab('g1', 'tab-3', 0)
    expect(store.group('g1')?.tabIds).toEqual(['tab-3', 'tab-1', 'tab-2'])

    store.removeTab('tab-1')
    expect(store.group('g1')?.tabIds).toEqual(['tab-3', 'tab-2'])
  })

  it('dissolves a group when its last member is removed', async () => {
    const { store, filePath } = await openStore()
    store.create({ tabIds: ['tab-1'] })
    store.removeTab('tab-1')
    await store.flush()
    expect(store.list()).toEqual([])
    expect(await storedGroups(filePath)).toEqual([])
  })


  it('leaves the document untouched when an operation is refused', async () => {
    const { store } = await openStore()
    store.create({ tabIds: ['tab-1'], name: 'Work' })
    expect(() => store.rename('missing', 'x')).toThrow(TabGroupNotFoundError)
    expect(() => store.addTab('missing', 'tab-2')).toThrow(TabGroupNotFoundError)
    expect(store.list().map((group) => group.name)).toEqual(['Work'])
  })

  it('keeps only the tabs a window brought back', async () => {
    const { store, filePath } = await openStore()
    store.create({ tabIds: ['tab-1', 'tab-2'] })
    store.create({ tabIds: ['tab-3'] })

    store.retainTabs(['tab-2'])
    await store.flush()
    expect(await storedGroups(filePath)).toEqual([
      {
        id: 'g1',
        name: '',
        color: 'blue',
        collapsed: false,
        tabIds: ['tab-2'],
        createdAt: T0 + 1_000
      }
    ])
  })

  it('tells every listener about a change, and stops when unsubscribed', async () => {
    const { store } = await openStore()
    const seen: number[] = []
    const unsubscribe = store.onChange((groups) => seen.push(groups.length))

    store.create({ tabIds: ['tab-1'] })
    store.create({ tabIds: ['tab-2'] })
    unsubscribe()
    store.create({ tabIds: ['tab-3'] })

    expect(seen).toEqual([1, 2])
  })

  it('coalesces writes when a debounce is set', async () => {
    const { store, filePath } = await openStore({ debounceMs: 50 })
    store.create({ tabIds: ['tab-1'] })
    expect(await exists(filePath)).toBe(false)
    await store.flush()
    expect(await storedGroups(filePath)).toHaveLength(1)
  })

  it('works through an injected codec', async () => {
    const { store, filePath } = await openStore({ codec: true })
    store.create({ tabIds: ['tab-1'] })
    await store.flush()
    expect(await storedGroups(filePath)).toHaveLength(1)
  })

  it('puts the codec between the group names and the disk, not beside it', async () => {
    /*
      The test above passes the *plain* codec, so the file looks identical whether the
      store forwards the codec or quietly drops it on the way to `JsonStore`. This one
      uses a codec whose output cannot be mistaken for JSON.

      A group name is something the user typed — "Steuererklärung 2026", "Wohnung
      suchen" — and it is exactly as revealing as a history entry. Dropped, it would sit
      in the profile directory in clear text while the browser reported local data as
      encrypted, which is the gap spec 3 exists to close.
    */
    const dir = await mkdtemp(join(tmpdir(), 'tessera-tabgroups-'))
    const filePath = join(dir, 'tabgroups.json')
    const store = await TabGroupStore.open({
      filePath,
      codec: sealingCodec(),
      debounceMs: 0,
      now: () => T0
    })
    store.create({ tabIds: ['tab-1'], name: 'Steuererklärung 2026' })
    await store.flush()

    const raw = await readFile(filePath, 'utf8')
    expect(raw.startsWith('sealed:'), raw.slice(0, 40)).toBe(true)
    expect(raw).not.toContain('Steuererklärung')

    // And it reads its own writing back, so the codec is used in both directions.
    const reopened = await TabGroupStore.open({ filePath, codec: sealingCodec(), debounceMs: 0 })
    expect(reopened.list().map((group) => group.name)).toEqual(['Steuererklärung 2026'])
  })

  it('uses the coalescing window it was given, not the default one', async () => {
    /*
      `debounceMs: 0` means "write on every change", and `JsonStore` honours it without a
      timer at all. A store that dropped the option would fall back to 250 ms and still
      pass every other test here, because they all call `flush` first — so nothing would
      notice that a caller asking for an immediate write got a coalesced one, which on a
      shutdown path is the difference between the last change being on disk and being lost.

      The observable is that no timer was scheduled, not how soon the file appears. An
      earlier version installed fake timers and spun the event loop a hundred times waiting
      for the file — a wall-clock budget in disguise, which passed on its own and failed in
      a full run, where a queued write does not get its turn that soon.
    */
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    try {
      const { store, filePath } = await openStore()
      // `open` is not what this is about; only the write the change triggers.
      scheduled.mockClear()
      store.create({ tabIds: ['tab-1'] })
      expect(scheduled, 'the write was put behind a timer').not.toHaveBeenCalled()

      // Awaited on the store's own queue: the write is already on it, so this resolves once
      // *that* write is on disk rather than starting a second one.
      await store.flush()
      expect(await exists(filePath)).toBe(true)
    } finally {
      scheduled.mockRestore()
    }
  })
})

describe('TabGroupStore defaults', () => {
  it('generates ids that do not collide', async () => {
    // The one place the default id generator is the subject rather than an obstacle.
    const dir = await mkdtemp(join(tmpdir(), 'tessera-tabgroups-ids-'))
    const filePath = join(dir, 'tabgroups.json')
    // Also the one place the default debounce is used, so the two writes are coalesced
    // the way they are in a running browser. `flush` cancels the pending timer.
    const store = await TabGroupStore.open({ filePath, now: () => T0 })
    const first = store.create({ tabIds: ['tab-1'] })
    const second = store.create({ tabIds: ['tab-2'] })
    expect(first.id).not.toBe(second.id)
    // The whole shape, not just the prefix. Two groups made in the same millisecond
    // differ only in the counter, so the counter is the part that has to move *forward*:
    // `counter -= 1` also produces distinct ids, and produces them as `tg-mabc--1` — a
    // string that is still unique, still stored, and no longer the readable
    // `tg-<time>-<n>` the file is meant to be inspectable as.
    expect(first.id).toMatch(/^tg-[0-9a-z]+-[0-9a-z]+$/)
    expect(second.id).toMatch(/^tg-[0-9a-z]+-[0-9a-z]+$/)

    expect(await exists(filePath)).toBe(false)
    await store.flush()
    expect(await storedGroups(filePath)).toHaveLength(2)
  })

  it('falls back to the real clock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-tabgroups-clock-'))
    const store = await TabGroupStore.open({
      filePath: join(dir, 'tabgroups.json'),
      debounceMs: 0,
      generateId: () => 'g1'
    })
    const before = Date.now()
    const created = store.create({ tabIds: ['tab-1'] })
    expect(created.createdAt).toBeGreaterThanOrEqual(before)
    expect(created.createdAt).toBeLessThanOrEqual(Date.now())
  })
})

describe('TabGroupStore across a restart', () => {
  it('brings back the groups, their order and their members’ order', async () => {
    const seed = {
      version: 1,
      groups: [
        stored('g-work', ['tab-3', 'tab-1'], { name: 'Work', color: 'orange', collapsed: true }),
        stored('g-news', ['tab-2'], { name: 'News', color: 'green' })
      ]
    }
    const { store } = await openStore({ seed })

    expect(store.list().map((group) => group.id)).toEqual(['g-work', 'g-news'])
    expect(store.group('g-work')).toEqual({
      id: 'g-work',
      name: 'Work',
      color: 'orange',
      collapsed: true,
      tabIds: ['tab-3', 'tab-1'],
      createdAt: T0
    })
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('survives a full round trip through the file', async () => {
    const { store, filePath } = await openStore()
    store.create({ tabIds: ['tab-2', 'tab-1'], name: 'Work', color: 'pink' })
    store.create({ tabIds: ['tab-3'], name: 'News' })
    store.setCollapsed('g2', true)
    await store.flush()

    const reopened = await TabGroupStore.open({ filePath, debounceMs: 0 })
    expect(reopened.list()).toEqual(store.list())
  })
})

describe('TabGroupStore repairing a damaged file', () => {
  it('starts from defaults when the file is not JSON at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-tabgroups-broken-'))
    const filePath = join(dir, 'tabgroups.json')
    await writeFile(filePath, '{ not json', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = await TabGroupStore.open({ filePath, debounceMs: 0 })
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)
    warn.mockRestore()
  })

  it('starts from defaults when an id is not a string', async () => {
    // Identity is a *kind*, not an amount: a numeric id means the file is not one this
    // browser wrote, and defaults are the only safe answer.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = await openStore({ seed: { version: 1, groups: [stored('x', ['tab-1'])] } })
    expect(store.list()).toHaveLength(1)

    const broken = await openStore({
      seed: { version: 1, groups: [{ ...(stored('x', ['tab-1']) as object), id: 7 }] }
    })
    expect(broken.store.list()).toEqual([])
    expect(broken.store.recoveredFromInvalidFile).toBe(true)
    warn.mockRestore()
  })

  it('heals an unrecognised colour instead of discarding the groups', async () => {
    // Dropping a slot from the palette in a later version must not delete the groups
    // that used it.
    const { store } = await openStore({
      seed: { version: 1, groups: [stored('g-a', ['tab-1'], { color: 'chartreuse' })] }
    })
    expect(store.group('g-a')?.color).toBe('grey')
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('heals fields that do not identify the group', async () => {
    const { store } = await openStore({
      seed: {
        version: 1,
        groups: [{ id: 'g-a', tabIds: ['tab-1'], collapsed: 'yes', createdAt: -5 }]
      }
    })
    expect(store.group('g-a')).toEqual({
      id: 'g-a',
      name: '',
      color: 'grey',
      collapsed: false,
      tabIds: ['tab-1'],
      createdAt: 0
    })
  })

  it('repairs the invariants rather than throwing the file away', async () => {
    const { store } = await openStore({
      seed: {
        version: 1,
        groups: [
          stored('g-a', ['tab-1', 'tab-1']),
          stored('g-a', ['tab-9']),
          stored('g-b', ['tab-1', 'tab-2']),
          stored('g-c', []),
          stored('g-d', ['tab-4'], { name: ' y'.repeat(120) })
        ]
      }
    })

    expect(store.list().map((group) => [group.id, group.tabIds])).toEqual([
      ['g-a', ['tab-1']],
      ['g-b', ['tab-2']],
      ['g-d', ['tab-4']]
    ])
    expect(store.group('g-d')?.name.length).toBe(MAX_TAB_GROUP_NAME_LENGTH)
    // A repaired file is not a rejected one: nothing was lost that could be kept.
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('keeps every group of a file still carrying an arrangement, and drops only the arrangement', async () => {
    /*
      R12 / AE7: the migration off `TabGroup.layout`, and the only proof that it needs no migration code.

      The claim being tested is KTD7's: the storage schema is a plain `z.object`, zod strips the keys it
      does not know, and `JsonStore` parses before `repair` ever sees the document — so once `layout` is
      gone from the schema the field is simply absent on load. Nothing was written to make that happen,
      which is exactly why it has to be asserted: a silent behaviour has no other witness.

      Both kinds of stored group are here on purpose. An unnamed group carrying an arrangement is
      indistinguishable from an artefact the old automation created — and KD5 says it stays a group anyway,
      because the user may well have made it by hand and never named it. A named, coloured group proves the
      other half: nothing the user chose is touched on the way through.
    */
    const { store } = await openStore({
      seed: {
        version: 1,
        groups: [
          stored('g-a', ['tab-1', 'tab-2'], {
            layout: { id: '1x2', tiles: ['tab-1', 'tab-2'] }
          }),
          stored('g-b', ['tab-3', 'tab-4'], {
            name: 'Steuererklärung 2026',
            color: 'pink',
            layout: { id: '2x2', tiles: ['tab-3', null, 'tab-4', null] }
          })
        ]
      }
    })

    expect(store.list()).toEqual([
      {
        id: 'g-a',
        name: '',
        color: 'blue',
        collapsed: false,
        tabIds: ['tab-1', 'tab-2'],
        createdAt: T0
      },
      {
        id: 'g-b',
        name: 'Steuererklärung 2026',
        color: 'pink',
        collapsed: false,
        tabIds: ['tab-3', 'tab-4'],
        createdAt: T0
      }
    ])
    // Stated separately from the deep equality above, because `toEqual` ignores a key whose value is
    // `undefined` and would pass on a group that still carried the field.
    expect(store.list().every((group) => !Object.hasOwn(group, 'layout'))).toBe(true)
    // A document losing a field it no longer has is not damage, so nothing warns the user about it.
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('writes a loaded file back once, so the dropped arrangement leaves the disk at the first start', async () => {
    /*
      R12, the other half. The test above proves the field is gone from the *document*; this one is
      about the *file*. Nothing in `JsonStore` writes a document it merely loaded — the encoding
      migration is the one exception — so without a rewrite here the `layout` object would sit in
      `tab-groups.json` until the user next renamed, recoloured or dissolved a group, which for a
      profile whose groups are settled may be never.

      Asserted on the raw text rather than on the parsed groups, because parsing is what hides the
      leftover: `storedGroups` reading the file back through `JSON.parse` finds a `layout` key that
      `store.list()` would never show. And no `flush()` is called first — the claim is that opening
      the store is enough, since a start is the only moment this is known to be needed.
    */
    const { filePath } = await openStore({
      seed: {
        version: 1,
        groups: [
          stored('g-a', ['tab-1', 'tab-2'], { layout: { id: '1x2', tiles: ['tab-1', 'tab-2'] } })
        ]
      }
    })

    expect(await readFile(filePath, 'utf8')).not.toContain('layout')
    expect(await storedGroups(filePath)).toEqual([
      {
        id: 'g-a',
        name: '',
        color: 'blue',
        collapsed: false,
        tabIds: ['tab-1', 'tab-2'],
        createdAt: T0
      }
    ])
  })

  it('trims a file with more groups than the cap', async () => {
    const groups = Array.from({ length: MAX_TAB_GROUPS + 3 }, (_, index) =>
      stored(`g${index}`, [`tab-${index}`])
    )
    const { store } = await openStore({ seed: { version: 1, groups } })
    expect(store.list()).toHaveLength(MAX_TAB_GROUPS)
  })

  it('starts from defaults when the version is not one it knows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = await openStore({ seed: { version: 2, groups: [] } })
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)
    warn.mockRestore()
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

    book.create({ tabIds: ['tab-1', 'tab-2'], name: 'Geschenke' })
    book.rename('g1', 'Geschenke 2026')
    book.recolor('g1', 'red')
    book.setCollapsed('g1', true)
    book.addTab('g1', 'tab-3')
    book.removeTab('tab-3')
    await book.flush()

    expect(book.list()).toHaveLength(1)
    // The file was never created, and the normal session never heard about any of it.
    expect(await exists(filePath)).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('cannot see the normal session’s groups', async () => {
    // A private window listing "Steuererklärung 2026" would leak the normal session
    // through the very interface that is supposed to keep nothing.
    const { store } = await openStore()
    store.create({ tabIds: ['tab-1'], name: 'Steuererklärung 2026' })
    expect(store.bookFor('private').list()).toEqual([])
  })

  it('gives each private window its own groups', async () => {
    const { store } = await openStore()
    const first = store.bookFor('private')
    const second = store.bookFor('private')

    first.create({ tabIds: ['tab-1'] })
    expect(second.list()).toEqual([])
    expect(first.list()).toHaveLength(1)
  })

  it('obeys the same rules as the persisting one', async () => {
    const { store } = await openStore()
    const book = store.bookFor('private')
    const created = book.create({ tabIds: ['tab-1', 'tab-1'] })

    expect(created.tabIds).toEqual(['tab-1'])
    expect(book.group(created.id)?.color).toBe('blue')
    expect(book.groupOfTab('tab-1')?.id).toBe(created.id)
    // The ghost rule holds here too.
    book.removeTab('tab-1')
    expect(book.list()).toEqual([])
  })

  it('reconciles with the tabs it has, like any other book', async () => {
    const { store } = await openStore()
    const book = store.bookFor('private')
    book.create({ tabIds: ['tab-1', 'tab-2'] })
    book.retainTabs(['tab-2'])
    expect(book.list().map((group) => group.tabIds)).toEqual([['tab-2']])
  })

  it('notifies and unsubscribes like the persisting one', async () => {
    const { store } = await openStore()
    const book = store.bookFor('private')
    const seen: number[] = []
    const unsubscribe = book.onChange((groups) => seen.push(groups.length))

    book.create({ tabIds: ['tab-1'] })
    unsubscribe()
    book.create({ tabIds: ['tab-2'] })
    expect(seen).toEqual([1])
  })

  it('lets one bad listener not stop the others', async () => {
    const { store } = await openStore()
    const book: TabGroupBook = store.bookFor('private')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reached: string[] = []

    book.onChange(() => {
      throw new Error('listener is broken')
    })
    book.onChange(() => reached.push('second'))
    book.create({ tabIds: ['tab-1'] })

    expect(reached).toEqual(['second'])
    // Named, not merely logged. A private window's book is the one place a listener can
    // throw with nothing else watching, and an anonymous line in the console leaves the
    // reader unable to tell which subsystem swallowed the error — which is how a
    // renderer that stopped redrawing groups gets diagnosed as a rendering bug.
    expect(error).toHaveBeenCalledWith('[tabgroups] listener threw:', expect.any(Error))
    error.mockRestore()
  })

  it('has nothing to recover from, because it has no file', async () => {
    const { store } = await openStore()
    expect(store.bookFor('private').recoveredFromInvalidFile).toBe(false)
  })
})
