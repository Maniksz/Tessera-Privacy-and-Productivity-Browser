import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Extension, Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionStore } from '@main/data/ExtensionStore.js'
import type { DocumentCodec } from '@main/data/JsonStore.js'

/**
 * Loading unpacked extensions and remembering which folders to reload.
 *
 * Driven through a stand-in session rather than a real one. The store's own rules are
 * what matter here and none of them need Chromium: which folders get remembered, that a
 * folder which no longer loads is dropped instead of retried forever, and that nothing
 * touches the session before one exists.
 *
 * The stand-in records its calls with their arguments, so the assertions can be about
 * *what* the store told the session — which folder, with which options, for which id —
 * rather than about whether it said anything at all.
 */

interface FakeSession {
  session: Session
  loaded: string[]
  /** The options each `loadExtension` call was given, in call order. */
  loadOptions: Array<Record<string, unknown> | undefined>
  removed: string[]
  /** Folders that reject when loaded, simulating a folder deleted from disk. */
  failing: Set<string>
}

/** Only the four fields the store reads; the rest of `Extension` is irrelevant here. */
interface FakeExtension {
  id: string
  name: string
  version: string
  path: string
}

/**
 * Widens a stand-in to `Extension`.
 *
 * Takes a parameter rather than asserting on an object literal, which keeps the
 * "annotate, do not assert" lint rule satisfied without pretending the stand-in is
 * complete.
 */
function asExtension(fake: FakeExtension): Extension {
  return fake as unknown as Extension
}

function fakeSession(initial: FakeExtension[] = []): FakeSession {
  const installed = new Map<string, Extension>()
  for (const extension of initial) {
    installed.set(extension.id, asExtension(extension))
  }

  const state: FakeSession = {
    loaded: [],
    loadOptions: [],
    removed: [],
    failing: new Set<string>(),
    session: undefined as unknown as Session
  }

  state.session = {
    extensions: {
      // Not `async`: nothing here awaits, and an async function without an await is
      // exactly what the lint rule flags.
      loadExtension: (path: string, options?: Record<string, unknown>): Promise<Extension> => {
        if (state.failing.has(path)) {
          return Promise.reject(new Error(`cannot load ${path}`))
        }
        state.loaded.push(path)
        state.loadOptions.push(options)
        const extension = asExtension({
          id: `id-${path}`,
          name: `Extension ${path}`,
          version: '1.0.0',
          path
        })
        installed.set(extension.id, extension)
        return Promise.resolve(extension)
      },
      getAllExtensions: (): Extension[] => [...installed.values()],
      removeExtension: (id: string): void => {
        state.removed.push(id)
        installed.delete(id)
      }
    }
  } as unknown as Session

  return state
}

async function openStore(
  codec?: DocumentCodec
): Promise<{ store: ExtensionStore; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-ext-'))
  const filePath = join(dir, 'extensions.json')
  // No debounce: the assertions read the file straight after a write.
  const store = await ExtensionStore.open({
    filePath,
    debounceMs: 0,
    ...(codec === undefined ? {} : { codec })
  })
  return { store, filePath }
}

async function storedPaths(filePath: string): Promise<string[]> {
  const text = await readFile(filePath, 'utf8')
  return (JSON.parse(text) as { paths: string[] }).paths
}

/**
 * A codec that is unmistakably not plain JSON.
 *
 * Spec 3 wants these files encrypted at rest, which happens by swapping the codec. A
 * store that dropped the codec on the way to `JsonStore` would keep working and write
 * the paths in clear text, so the marker is what makes that visible.
 */
function markerCodec(): DocumentCodec {
  const marker = 'sealed:'
  return {
    encode: (data) => new TextEncoder().encode(`${marker}${JSON.stringify(data)}`),
    decode: (bytes) => {
      const text = new TextDecoder().decode(bytes)
      if (!text.startsWith(marker)) throw new Error('not written by this codec')
      return JSON.parse(text.slice(marker.length)) as unknown
    }
  }
}


describe('ExtensionStore before a session exists', () => {
  it('lists nothing rather than throwing', async () => {
    // The settings UI may ask for the list before the browsing session is up.
    const { store } = await openStore()
    expect(store.list()).toEqual([])
  })

  it('refuses to load, naming the reason', async () => {
    const { store } = await openStore()
    await expect(store.load('/tmp/whatever')).rejects.toThrow(/before the browsing session/)
  })

  it('refuses to remove, naming the reason', async () => {
    const { store } = await openStore()
    expect(() => store.remove('some-id')).toThrow(/before the browsing session/)
  })
})

describe('ExtensionStore with a session', () => {
  it('loads a folder and remembers it', async () => {
    const { store, filePath } = await openStore()
    const fake = fakeSession()
    await store.attach(fake.session)

    const info = await store.load('/ext/one')
    expect(info.path).toBe('/ext/one')
    expect(fake.loaded).toEqual(['/ext/one'])

    await store.flush()
    expect(await storedPaths(filePath)).toEqual(['/ext/one'])
  })

  it('never loads with file access, whatever the folder', async () => {
    // An unpacked extension granted file access can read the user's disk; spec 4's point
    // is that third-party code gets the least it can work with. The whole options object
    // is asserted, so neither a flipped flag nor a dropped argument passes.
    const { store } = await openStore()
    const fake = fakeSession()
    await store.attach(fake.session)

    await store.load('/ext/one')
    expect(fake.loadOptions).toEqual([{ allowFileAccess: false }])
  })

  it('does not remember the same folder twice', async () => {
    const { store, filePath } = await openStore()
    await store.attach(fakeSession().session)

    await store.load('/ext/one')
    await store.load('/ext/one')

    await store.flush()
    expect(await storedPaths(filePath)).toEqual(['/ext/one'])
  })

  it('lists what the session reports, not what it stored', async () => {
    // The session is the truth about what is running; the file only says what to reload.
    const { store } = await openStore()
    const fake = fakeSession([{ id: 'a', name: 'A', version: '2.0', path: '/ext/a' }])
    await store.attach(fake.session)

    expect(store.list()).toEqual([{ id: 'a', name: 'A', version: '2.0', path: '/ext/a' }])
  })

  it('removes from the session and forgets the folder', async () => {
    const { store, filePath } = await openStore()
    const fake = fakeSession()
    await store.attach(fake.session)
    const info = await store.load('/ext/one')

    store.remove(info.id)

    expect(fake.removed).toEqual([info.id])
    await store.flush()
    expect(await storedPaths(filePath)).toEqual([])
  })

  it('forgets only the folder of the extension it removed', async () => {
    // Matching the id is what keeps the two lists aligned. Taking whichever extension
    // came first would drop a surviving extension's folder from the reload list, and it
    // would then be gone after the next restart — with nothing to point at as the cause.
    const { store, filePath } = await openStore()
    const fake = fakeSession()
    await store.attach(fake.session)
    const first = await store.load('/ext/one')
    const second = await store.load('/ext/two')

    store.remove(second.id)

    expect(fake.removed).toEqual([second.id])
    expect(store.list().map((extension) => extension.id)).toEqual([first.id])
    await store.flush()
    expect(await storedPaths(filePath)).toEqual(['/ext/one'])
  })

  it('still asks the session to remove an id it does not know', async () => {
    // The stored list and the session can disagree; the session's copy is the one that
    // affects the user, so the removal is attempted either way.
    const { store } = await openStore()
    const fake = fakeSession()
    await store.attach(fake.session)

    store.remove('never-loaded')
    expect(fake.removed).toEqual(['never-loaded'])
  })
})

describe('ExtensionStore.attach', () => {
  it('reloads every remembered folder', async () => {
    const { store, filePath } = await openStore()
    await store.attach(fakeSession().session)
    await store.load('/ext/one')
    await store.load('/ext/two')
    await store.flush()

    // A fresh store over the same file is what a restart looks like.
    const restarted = await ExtensionStore.open({ filePath, debounceMs: 0 })
    const fake = fakeSession()
    const failures = await restarted.attach(fake.session)

    expect(failures).toEqual([])
    expect(fake.loaded).toEqual(['/ext/one', '/ext/two'])
    // The reload path is a second call site for the same rule as `load`, and the one that
    // runs unattended at every start: file access must be off here too.
    expect(fake.loadOptions).toEqual([{ allowFileAccess: false }, { allowFileAccess: false }])
  })

  it('drops a folder that no longer loads instead of retrying it forever', async () => {
    const { store, filePath } = await openStore()
    await store.attach(fakeSession().session)
    await store.load('/ext/gone')
    await store.load('/ext/kept')
    await store.flush()

    const restarted = await ExtensionStore.open({ filePath, debounceMs: 0 })
    const fake = fakeSession()
    fake.failing.add('/ext/gone')
    const failures = await restarted.attach(fake.session)

    expect(failures.length).toBe(1)
    expect(failures[0]).toContain('/ext/gone')
    // The reason is carried through, not swallowed: the UI has to be able to say why.
    expect(failures[0]).toContain('cannot load')

    await restarted.flush()
    expect(await storedPaths(filePath)).toEqual(['/ext/kept'])
    expect(fake.loaded).toEqual(['/ext/kept'])
  })

  it('reports every failure, not just the first', async () => {
    const { store, filePath } = await openStore()
    await store.attach(fakeSession().session)
    await store.load('/ext/a')
    await store.load('/ext/b')
    await store.flush()

    const restarted = await ExtensionStore.open({ filePath, debounceMs: 0 })
    const fake = fakeSession()
    fake.failing.add('/ext/a')
    fake.failing.add('/ext/b')

    expect((await restarted.attach(fake.session)).length).toBe(2)
    await restarted.flush()
    expect(await storedPaths(filePath)).toEqual([])
  })

  it('starts from an empty list when the file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-ext-'))
    const store = await ExtensionStore.open({ filePath: join(dir, 'missing.json'), debounceMs: 0 })
    const fake = fakeSession()
    expect(await store.attach(fake.session)).toEqual([])
    expect(fake.loaded).toEqual([])
  })
})

describe('ExtensionStore.open', () => {
  it('writes and reads the folder list through the codec it was given', async () => {
    // The codec is the seam spec 3's encryption arrives through. A store that accepted it
    // and then wrote plain JSON would look perfectly healthy while leaving the list
    // readable on disk, so the bytes themselves are asserted.
    const codec = markerCodec()
    const { store, filePath } = await openStore(codec)
    await store.attach(fakeSession().session)
    await store.load('/ext/one')
    await store.flush()

    expect(await readFile(filePath, 'utf8')).toBe(
      `sealed:${JSON.stringify({ version: 1, paths: ['/ext/one'] })}`
    )

    // And the same codec reads it back: a restart must find the folder again, which it
    // cannot do if only the write side honoured the codec.
    const restarted = await ExtensionStore.open({ filePath, codec, debounceMs: 0 })
    const fake = fakeSession()
    expect(await restarted.attach(fake.session)).toEqual([])
    expect(fake.loaded).toEqual(['/ext/one'])
  })

  it('schedules no timer for a zero debounce, and one for the default', async () => {
    /*
      `debounceMs: 0` is a promise the shutdown path depends on: the change is on its way to disk
      when it is made, so a quit that only awaits `flush` cannot outrun it.

      Asserted on the timer, not on the file. An earlier version of this test polled the
      filesystem while timers were frozen, reasoning that each failed read is a turn of the event
      loop and an already-started write would land within fifty of them. Under a full parallel
      suite it does not, and the test failed for load rather than for behaviour — which is the
      worst kind of test, because it teaches people to re-run instead of to look. Whether a timer
      was scheduled is the actual difference between the two settings, and it is exact.
    */
    const withDebounce = async (debounceMs: number): Promise<number> => {
      const dir = await mkdtemp(join(tmpdir(), 'tessera-ext-'))
      const store = await ExtensionStore.open({ filePath: join(dir, 'extensions.json'), debounceMs })
      await store.attach(fakeSession().session)

      vi.useFakeTimers()
      try {
        await store.load('/ext/one')
        return vi.getTimerCount()
      } finally {
        vi.useRealTimers()
        await store.flush()
      }
    }

    expect(await withDebounce(0), 'a zero debounce must not wait for a timer').toBe(0)
    expect(await withDebounce(250), 'a debounced write must be scheduled, not immediate').toBe(1)
  })
})
