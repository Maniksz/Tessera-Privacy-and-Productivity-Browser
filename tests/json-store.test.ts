import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  JsonStore,
  UnreadableDocumentError,
  plainJsonDocumentCodec,
  type DocumentCodec
} from '@main/data/JsonStore.js'
import { QuickLinkStore } from '@main/data/QuickLinkStore.js'

/**
 * `JsonStore` and `QuickLinkStore`.
 *
 * The behaviour worth testing here is the failure behaviour: a corrupt file, a
 * write that races a shutdown, an update that would produce an invalid document.
 * Those are the cases where the wrong choice loses a user's data, and the only way
 * to know the choice is right is to cause the failure.
 */

const docSchema = z.object({ version: z.literal(1), items: z.array(z.string()) })
type Doc = z.output<typeof docSchema>

const fallback = (): Doc => ({ version: 1, items: [] })

async function tempPath(name = 'doc.json'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-json-'))
  return join(dir, name)
}

/**
 * A codec whose on-disk format has moved on, so old files are readable but stale.
 *
 * Stands in for the encrypted codec at this level: the store's contract is about a
 * format that changed, not about encryption.
 */
function versionedCodec(): DocumentCodec {
  const prefix = 'v2:'
  const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
  return {
    encode: (data) => new TextEncoder().encode(prefix + JSON.stringify(data)),
    decode: (bytes) => {
      const body = text(bytes)
      return JSON.parse(body.startsWith(prefix) ? body.slice(prefix.length) : body) as unknown
    },
    isStaleEncoding: (bytes) => !text(bytes).startsWith(prefix)
  }
}

async function open(filePath: string, codec?: DocumentCodec): Promise<JsonStore<Doc>> {
  return JsonStore.open<Doc>({
    filePath,
    schema: docSchema,
    fallback,
    debounceMs: 0,
    ...(codec === undefined ? {} : { codec })
  })
}

describe('JsonStore', () => {
  it('starts from the fallback when there is no file', async () => {
    const store = await open(await tempPath())
    expect(store.get()).toEqual({ version: 1, items: [] })
    expect(store.diagnostics.recoveredFromInvalidFile).toBe(false)
  })

  it('reads a valid document', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 1, items: ['a'] }))
    const store = await open(filePath)
    expect(store.get().items).toEqual(['a'])
  })

  it('falls back and reports when the file is not valid JSON', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, '{ not json')
    const store = await open(filePath)
    // A corrupt file must not stop the browser from starting.
    expect(store.get()).toEqual({ version: 1, items: [] })
    expect(store.diagnostics.recoveredFromInvalidFile).toBe(true)
  })

  it('falls back and reports when the document fails its schema', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 9, items: 'nope' }))
    const store = await open(filePath)
    expect(store.get()).toEqual({ version: 1, items: [] })
    expect(store.diagnostics.recoveredFromInvalidFile).toBe(true)
  })

  it('does not report a missing file as a recovery', async () => {
    // "No file yet" is the normal first run, not a fault worth surfacing.
    const store = await open(await tempPath())
    expect(store.diagnostics.recoveredFromInvalidFile).toBe(false)
  })

  it('applies a repair pass and reports it', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 1, items: ['a', 'a'] }))
    const store = await JsonStore.open<Doc>({
      filePath,
      schema: docSchema,
      fallback,
      debounceMs: 0,
      repair: (doc) => ({ ...doc, items: [...new Set(doc.items)] })
    })
    expect(store.get().items).toEqual(['a'])
    expect(store.diagnostics.repairedOnLoad).toBe(true)
  })

  it('does not report a repair that changed nothing', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 1, items: ['a'] }))
    const store = await JsonStore.open<Doc>({
      filePath,
      schema: docSchema,
      fallback,
      debounceMs: 0,
      repair: (doc) => doc
    })
    expect(store.diagnostics.repairedOnLoad).toBe(false)
  })

  it('stores an update and persists it', async () => {
    const filePath = await tempPath()
    const store = await open(filePath)
    store.update((doc) => ({ ...doc, items: ['x'] }))
    await store.flush()

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Doc
    expect(raw.items).toEqual(['x'])
  })

  it('refuses an update that would produce an invalid document', async () => {
    const store = await open(await tempPath())
    expect(() =>
      // @ts-expect-error deliberately wrong shape: the guard has to be a runtime one
      store.update(() => ({ version: 1, items: 'not an array' }))
    ).toThrow(/invalid document/i)
  })

  it('leaves the document unchanged after a refused update', async () => {
    const store = await open(await tempPath())
    store.update((doc) => ({ ...doc, items: ['keep'] }))
    try {
      // @ts-expect-error deliberately wrong shape
      store.update(() => ({ version: 1, items: 42 }))
    } catch {
      // expected
    }
    expect(store.get().items).toEqual(['keep'])
  })

  it('notifies listeners and can unsubscribe', async () => {
    const store = await open(await tempPath())
    const seen: number[] = []
    const off = store.onChange((doc) => seen.push(doc.items.length))

    store.update((doc) => ({ ...doc, items: ['a'] }))
    off()
    store.update((doc) => ({ ...doc, items: ['a', 'b'] }))

    expect(seen).toEqual([1])
  })

  it('keeps going when one listener throws', async () => {
    const store = await open(await tempPath())
    const seen: string[] = []
    store.onChange(() => {
      throw new Error('bad listener')
    })
    store.onChange(() => seen.push('second'))

    expect(() => store.update((doc) => ({ ...doc, items: ['a'] }))).not.toThrow()
    expect(seen).toEqual(['second'])
  })

  it('writes atomically and leaves no temporary file behind', async () => {
    const filePath = await tempPath()
    const store = await open(filePath)
    store.update((doc) => ({ ...doc, items: ['a'] }))
    await store.flush()

    // A crash mid-write must leave the previous file intact rather than a
    // truncated one, which is what write-then-rename buys.
    await expect(access(`${filePath}.tmp`)).rejects.toThrow()
  })

  it('coalesces debounced writes and still resolves on flush', async () => {
    const filePath = await tempPath()
    const store = await JsonStore.open<Doc>({
      filePath,
      schema: docSchema,
      fallback,
      debounceMs: 50
    })
    store.update((doc) => ({ ...doc, items: ['a'] }))
    store.update((doc) => ({ ...doc, items: ['a', 'b'] }))
    await store.flush()

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Doc
    expect(raw.items).toEqual(['a', 'b'])
  })

  it('survives a codec that cannot encode', async () => {
    // A write failure must not take the process down; the in-memory document is
    // still correct and the next flush can succeed.
    const broken: DocumentCodec = {
      encode: () => {
        throw new Error('encode failed')
      },
      decode: plainJsonDocumentCodec.decode
    }
    const store = await open(await tempPath(), broken)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.update((doc) => ({ ...doc, items: ['a'] }))
    await store.flush()
    expect(store.get().items).toEqual(['a'])
    spy.mockRestore()
  })

  it('rewrites a file the codec reports as stale, at open', async () => {
    // Migration in the abstract: the encrypted codec uses this to replace the
    // plain-text files from before spec 3 was implemented, but the store only knows
    // "this encoding is out of date, write it again".
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 1, items: ['a'] }))
    const store = await open(filePath, versionedCodec())

    expect(store.get().items).toEqual(['a'])
    expect(store.diagnostics.migratedEncodingOnLoad).toBe(true)
    // Awaited inside `open`, so the new form is already on disk.
    expect(await readFile(filePath, 'utf8')).toBe(
      `v2:${JSON.stringify({ version: 1, items: ['a'] })}`
    )
  })

  it('leaves a file alone when the codec has no opinion on its encoding', async () => {
    // The two-method codec is the contract another store may already be built
    // against; adding the hook must not change what happens without it.
    const filePath = await tempPath()
    const original = JSON.stringify({ version: 1, items: ['a'] })
    await writeFile(filePath, original)
    const store = await open(filePath, {
      encode: plainJsonDocumentCodec.encode,
      decode: plainJsonDocumentCodec.decode
    })

    expect(store.diagnostics.migratedEncodingOnLoad).toBe(false)
    expect(await readFile(filePath, 'utf8')).toBe(original)
  })

  it('does not migrate a file it could not use', async () => {
    // Rewriting here would encrypt the defaults over a file the user may still want
    // to inspect or repair by hand.
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 9, items: 'nope' }))
    const store = await open(filePath, versionedCodec())

    expect(store.diagnostics.recoveredFromInvalidFile).toBe(true)
    expect(store.diagnostics.migratedEncodingOnLoad).toBe(false)
    expect(await readFile(filePath, 'utf8')).toBe(JSON.stringify({ version: 9, items: 'nope' }))
  })

  it('fails to open when the codec calls a file unreadable, rather than resetting', async () => {
    // The one decode failure that is not recovered from: the document is still
    // there, so defaults plus the next write would destroy it.
    const filePath = await tempPath()
    await writeFile(filePath, 'sealed with a key we do not have')
    const refusing: DocumentCodec = {
      encode: plainJsonDocumentCodec.encode,
      decode: () => {
        throw new UnreadableDocumentError('no key')
      }
    }

    await expect(open(filePath, refusing)).rejects.toThrow(UnreadableDocumentError)
    // And the file it refused to read is untouched.
    expect(await readFile(filePath, 'utf8')).toBe('sealed with a key we do not have')
  })

  it('uses an injected codec for both directions', async () => {
    // Proves the seam the encrypted store will drop into is actually used.
    const calls: string[] = []
    const codec: DocumentCodec = {
      encode: (data) => {
        calls.push('encode')
        return new TextEncoder().encode(JSON.stringify(data))
      },
      decode: (bytes) => {
        calls.push('decode')
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown
      }
    }
    const filePath = await tempPath()
    const first = await open(filePath, codec)
    first.update((doc) => ({ ...doc, items: ['a'] }))
    await first.flush()
    await open(filePath, codec)

    expect(calls).toContain('encode')
    expect(calls).toContain('decode')
  })
})

describe('plainJsonDocumentCodec', () => {
  it('round-trips a document', async () => {
    const bytes = await plainJsonDocumentCodec.encode({ a: 1 })
    expect(await plainJsonDocumentCodec.decode(bytes)).toEqual({ a: 1 })
  })

  it('throws on invalid JSON rather than returning something odd', () => {
    const bytes = new TextEncoder().encode('{ not json')
    // Synchronous by design: the codec parses eagerly so a bad file is reported at
    // the call site rather than as an unhandled rejection later.
    expect(() => plainJsonDocumentCodec.decode(bytes)).toThrow()
  })
})

describe('QuickLinkStore', () => {
  async function store(): Promise<QuickLinkStore> {
    let counter = 0
    return QuickLinkStore.open({
      filePath: await tempPath('quicklinks.json'),
      generateId: () => `id-${++counter}`,
      now: () => 1_700_000_000_000,
      debounceMs: 0
    })
  }

  it('returns the created entry', async () => {
    const links = await store()
    const created = links.create({ kind: 'link', title: 'X', url: 'example.com' })
    expect(created.id).toBe('id-1')
    expect(created.url).toBe('https://example.com')
    expect(created.createdAt).toBe(1_700_000_000_000)
  })

  it('returns a copy of the list rather than its own array', async () => {
    const links = await store()
    links.create({ kind: 'link', title: 'X', url: 'example.com' })
    const list = links.list()
    list.pop()
    expect(links.list()).toHaveLength(1)
  })

  it('returns the updated entry', async () => {
    const links = await store()
    const created = links.create({ kind: 'link', title: 'X', url: 'example.com' })
    expect(links.update(created.id, { title: 'Y' }).title).toBe('Y')
  })

  it('propagates a rejected create rather than storing a partial entry', async () => {
    const links = await store()
    expect(() => links.create({ kind: 'link', title: 'X', url: 'not a url' })).toThrow()
    expect(links.list()).toHaveLength(0)
  })

  it('notifies on change and can unsubscribe', async () => {
    const links = await store()
    let count = 0
    const off = links.onChange(() => (count += 1))
    links.create({ kind: 'link', title: 'X', url: 'example.com' })
    off()
    links.create({ kind: 'link', title: 'Y', url: 'other.example' })
    expect(count).toBe(1)
  })

  it('generates distinct ids by default', async () => {
    const links = await QuickLinkStore.open({ filePath: await tempPath('q.json'), debounceMs: 0 })
    const a = links.create({ kind: 'link', title: 'A', url: 'a.example' })
    const b = links.create({ kind: 'link', title: 'B', url: 'b.example' })
    expect(a.id).not.toBe(b.id)
  })

  it('repairs an orphaned entry when reading', async () => {
    const filePath = await tempPath('quicklinks.json')
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        links: [
          {
            id: 'orphan',
            kind: 'link',
            title: 'Orphan',
            url: 'https://example.com',
            parentId: 'ghost',
            faviconPath: null,
            createdAt: 1
          }
        ]
      })
    )
    const links = await QuickLinkStore.open({ filePath, debounceMs: 0 })
    // Re-parented to the top level rather than left invisible.
    expect(links.list()[0]?.parentId).toBeNull()
  })
})
