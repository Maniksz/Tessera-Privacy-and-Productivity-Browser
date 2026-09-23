import * as nodeFs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  JsonStore,
  ReadOnlyStoreError,
  UnreadableDocumentError,
  plainJsonDocumentCodec,
  type DocumentCodec,
  type JsonStoreOptions
} from '@main/data/JsonStore.js'
import { HistoryStore } from '@main/data/HistoryStore.js'
import { QuickLinkStore } from '@main/data/QuickLinkStore.js'
import type { CopyFileSystem } from '@main/data/quarantine.js'
import { createEncryptedDocumentCodec } from '@main/data/encrypted-codec.js'

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
    migrations: [],
    criticality: 'degradable',
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

  it('copies a document that fails its schema aside before defaults replace it', async () => {
    // What this test used to accept was the data loss itself: defaults in memory, and the next write
    // putting them over the file. The original has to be on disk under another name first.
    const filePath = await tempPath()
    const original = JSON.stringify({ version: 1, items: 'nope' })
    await writeFile(filePath, original)
    const store = await open(filePath)

    expect(store.get()).toEqual({ version: 1, items: [] })
    expect(store.diagnostics.recoveredFromInvalidFile).toBe(true)
    expect(await readFile(`${filePath}.unreadable`, 'utf8')).toBe(original)
    expect(store.diagnostics.load).toMatchObject({
      kind: 'invalid',
      copy: `${filePath}.unreadable`
    })
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
      migrations: [],
      criticality: 'degradable',
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
      migrations: [],
      criticality: 'degradable',
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
    // truncated one, which is what write-then-rename buys. The listing, not one
    // guessed name: temporaries are uniquely named now (`atomic-write.ts`).
    expect(await readdir(dirname(filePath))).toEqual([basename(filePath)])
  })

  it('removes the temporaries a crash left behind when it opens', async () => {
    // Two, because a unique name per write means every interrupted write leaves its own, and a fixed
    // `.tmp` from before the names became unique. Each is a copy of the document nothing would ever
    // remove otherwise.
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 1, items: ['kept'] }), 'utf8')
    await writeFile(`${filePath}.4242-0a1b2c3d4e5f.tmp`, 'interrupted', 'utf8')
    await writeFile(`${filePath}.tmp`, 'interrupted', 'utf8')

    const store = await open(filePath)

    expect(store.get().items).toEqual(['kept'])
    expect(await readdir(dirname(filePath))).toEqual([basename(filePath)])
  })

  it('still opens when the temporaries cannot be looked for', async () => {
    // A parent that is a file: neither the listing nor the read can work. The read already falls back
    // to defaults for that, and cleaning up must not be what stops the browser from starting instead.
    const parent = await tempPath('not-a-directory')
    await writeFile(parent, 'a file', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = await open(join(parent, 'doc.json'))
      expect(store.get()).toEqual(fallback())
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not remove temporary files beside'),
        expect.anything()
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('coalesces debounced writes and still resolves on flush', async () => {
    const filePath = await tempPath()
    const store = await JsonStore.open<Doc>({
      filePath,
      schema: docSchema,
      fallback,
      migrations: [],
      criticality: 'degradable',
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

  it('copies a file it could not use verbatim before writing defaults in the new encoding', async () => {
    // Rewriting here used to mean encrypting the defaults over a file the user may still want to
    // inspect or repair by hand. That file is now kept, byte for byte, before anything replaces it —
    // and the encoding migration does not claim a document it never loaded.
    const filePath = await tempPath()
    const original = JSON.stringify({ version: 1, items: 'nope' })
    await writeFile(filePath, original)
    const store = await open(filePath, versionedCodec())

    expect(store.diagnostics.recoveredFromInvalidFile).toBe(true)
    expect(store.diagnostics.migratedEncodingOnLoad).toBe(false)
    expect(await readFile(`${filePath}.unreadable`, 'utf8')).toBe(original)
    expect(await readFile(filePath, 'utf8')).toBe(`v2:${JSON.stringify({ version: 1, items: [] })}`)
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
    // And the file it refused to read is untouched, with no copy beside it: this is not a broken
    // file but one behind a key, and it stays exactly where the key will find it.
    expect(await readFile(filePath, 'utf8')).toBe('sealed with a key we do not have')
    expect(await readdir(dirname(filePath))).toEqual([basename(filePath)])
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

/**
 * The load pipeline as a store sees it: which copies exist afterwards, what the file holds, and
 * whether anything was written. The decisions themselves are `store-load.test.ts`'s; these are about
 * the reading, the copying and the one write that follows.
 */

/** Version 2 of the test document: `items` became `entries`. */
const v2Schema = z.looseObject({ version: z.literal(2), entries: z.array(z.string()) })
type V2 = z.output<typeof v2Schema>

const toV2 = (document: Readonly<Record<string, unknown>>): unknown => {
  const { items, ...rest } = document
  return { ...rest, version: 2, entries: items }
}

/** The plain codec, counting its writes — "exactly one flush" is a count of encodes. */
function countingCodec(): DocumentCodec & { readonly encodes: () => number } {
  let encodes = 0
  return {
    encode: (data) => {
      encodes += 1
      return plainJsonDocumentCodec.encode(data)
    },
    decode: plainJsonDocumentCodec.decode,
    encodes: () => encodes
  }
}

function failure(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`simulated ${code}`)
  error.code = code
  return error
}

/** The real file system for copies, except that creating one fails as a full disk does. */
function fullDisk(): CopyFileSystem {
  return {
    rm: nodeFs.rm,
    readdir: (path) => nodeFs.readdir(path),
    readFile: (path) => nodeFs.readFile(path),
    writer: {
      open: (path, flags, mode) =>
        flags === 'wx' ? Promise.reject(failure('ENOSPC')) : nodeFs.open(path, flags, mode),
      rename: nodeFs.rename,
      rm: nodeFs.rm,
      readdir: (path) => nodeFs.readdir(path)
    }
  }
}

async function openV2(
  filePath: string,
  overrides: Partial<JsonStoreOptions<V2>> = {}
): Promise<JsonStore<V2>> {
  return JsonStore.open<V2>({
    filePath,
    schema: v2Schema,
    fallback: () => ({ version: 2, entries: [] }),
    migrations: [toV2],
    criticality: 'degradable',
    debounceMs: 0,
    ...overrides
  })
}

async function listing(filePath: string): Promise<string[]> {
  return (await readdir(dirname(filePath))).sort()
}

const posixModes = process.platform !== 'win32'

describe('JsonStore loading an older file', () => {
  it('migrates it, keeps the original bytes as a backup, and writes once', async () => {
    const filePath = await tempPath()
    const original = JSON.stringify({ version: 1, items: ['a'] })
    await writeFile(filePath, original)
    const codec = countingCodec()

    const store = await openV2(filePath, { codec })

    expect(store.get()).toEqual({ version: 2, entries: ['a'] })
    expect(store.diagnostics.load).toEqual({
      kind: 'migrated',
      fromVersion: 1,
      backup: `${filePath}.v1.bak`
    })
    expect(await readFile(`${filePath}.v1.bak`, 'utf8')).toBe(original)
    if (posixModes) expect((await stat(`${filePath}.v1.bak`)).mode & 0o777).toBe(0o600)
    // One write for the migration, and it is on disk once `open` resolves.
    expect(codec.encodes()).toBe(1)
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 2, entries: ['a'] })
  })

  it('writes the migration and a stale encoding in the same single write', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 1, items: ['a'] }))
    let encodes = 0
    const base = versionedCodec()
    const codec: DocumentCodec = {
      ...base,
      encode: (data) => {
        encodes += 1
        return base.encode(data)
      }
    }

    const store = await openV2(filePath, { codec })

    expect(store.diagnostics.migratedEncodingOnLoad).toBe(true)
    expect(encodes).toBe(1)
    expect(await readFile(filePath, 'utf8')).toBe(
      `v2:${JSON.stringify({ version: 2, entries: ['a'] })}`
    )
  })

  it('keeps the migrated document in memory only when the backup cannot be made', async () => {
    const filePath = await tempPath()
    const original = JSON.stringify({ version: 1, items: ['a'] })
    await writeFile(filePath, original)
    const codec = countingCodec()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = await openV2(filePath, { codec, copies: fullDisk() })

      expect(store.get()).toEqual({ version: 2, entries: ['a'] })
      expect(store.readOnly).toBe(true)
      expect(store.diagnostics.load).toEqual({ kind: 'migrated', fromVersion: 1, backup: null })

      store.update((doc) => ({ ...doc, entries: ['b'] }))
      await store.flush()
      expect(codec.encodes()).toBe(0)
      expect(await readFile(filePath, 'utf8')).toBe(original)
      expect(await listing(filePath)).toEqual([basename(filePath)])
    } finally {
      warn.mockRestore()
    }
  })

  it('copies the file aside and starts from defaults when a migration throws', async () => {
    const filePath = await tempPath()
    const original = JSON.stringify({ version: 1, items: ['a'] })
    await writeFile(filePath, original)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = await openV2(filePath, {
        migrations: [
          () => {
            throw new Error('wrong turn')
          }
        ]
      })

      expect(store.get()).toEqual({ version: 2, entries: [] })
      expect(await readFile(`${filePath}.unreadable`, 'utf8')).toBe(original)
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 2, entries: [] })
    } finally {
      warn.mockRestore()
    }
  })

  it('backs up an encrypted file under the same codec, byte for byte', async () => {
    const filePath = await tempPath()
    const codec = createEncryptedDocumentCodec(new Uint8Array(32).fill(7))
    const sealed = await codec.encode({ version: 1, items: ['secret'] })
    await writeFile(filePath, sealed)

    await openV2(filePath, { codec })

    const backup = await readFile(`${filePath}.v1.bak`)
    expect(Buffer.compare(backup, Buffer.from(sealed))).toBe(0)
    // Still sealed, and still the version-1 document: restoring it gives back exactly what was there.
    expect(backup.toString('utf8')).not.toContain('secret')
    expect(await codec.decode(backup)).toEqual({ version: 1, items: ['secret'] })
  })
})

describe('JsonStore loading a newer file', () => {
  it('runs a degradable store on defaults and never writes the file', async () => {
    const filePath = await tempPath()
    const newer = JSON.stringify({ version: 2, entries: ['from the future'] })
    await writeFile(filePath, newer)
    const codec = countingCodec()
    const warn = vi.spyOn(console, 'warn')

    const store = await open(filePath, codec)

    expect(store.get()).toEqual(fallback())
    expect(store.readOnly).toBe(true)
    expect(store.loadReport).toEqual({
      outcome: { kind: 'newer', version: 2 },
      criticality: 'degradable'
    })
    expect(store.diagnostics.recoveredFromInvalidFile).toBe(false)

    // The run goes on in memory, and nothing reaches the disk or the console per change: the one
    // warning is `index.ts`'s, at startup.
    const seen: string[][] = []
    store.onChange((doc) => seen.push(doc.items))
    store.update((doc) => ({ ...doc, items: ['this run'] }))
    expect(store.get().items).toEqual(['this run'])
    expect(seen).toEqual([['this run']])
    await store.flush()
    expect(codec.encodes()).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    expect(await readFile(filePath, 'utf8')).toBe(newer)
    expect(await listing(filePath)).toEqual([basename(filePath)])
    warn.mockRestore()
  })

  it('resolves flush at once, so a shutdown never waits on it', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 2 }))
    const store = await open(filePath)
    const settled = await Promise.race([
      store.flush().then(() => 'flushed'),
      Promise.resolve().then(() => 'waiting')
    ])
    expect(settled).toBe('flushed')
  })

  it('shows a critical store what it can read, and refuses every write before it changes anything', async () => {
    // AE1: an older build shows the bookmarks it can read, refuses a new one, and leaves the file be.
    const filePath = await tempPath()
    const newer = JSON.stringify({ version: 2, items: ['kept'], added: 'later' })
    await writeFile(filePath, newer)
    const store = await JsonStore.open<Doc>({
      filePath,
      schema: docSchema,
      fallback,
      migrations: [],
      criticality: 'critical',
      debounceMs: 0
    })

    expect(store.get().items).toEqual(['kept'])
    expect(() => store.update((doc) => ({ ...doc, items: ['new'] }))).toThrow(ReadOnlyStoreError)
    expect(store.get().items).toEqual(['kept'])
    expect(() => store.discardUnreadableEntries()).toThrow(ReadOnlyStoreError)
    await store.flush()
    expect(await readFile(filePath, 'utf8')).toBe(newer)
  })
})

describe('JsonStore keeping what it does not know', () => {
  it('writes back a field a newer version added under the same version', async () => {
    const looseSchema = z.looseObject({
      version: z.literal(1),
      items: z.array(z.looseObject({ name: z.string() }))
    })
    type Loose = z.output<typeof looseSchema>
    const filePath = await tempPath()
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, items: [{ name: 'a', pinned: true }], syncedAt: 5 })
    )
    const store = await JsonStore.open<Loose>({
      filePath,
      schema: looseSchema,
      fallback: () => ({ version: 1, items: [] }),
      migrations: [],
      criticality: 'degradable',
      debounceMs: 0
    })

    store.update((doc) => ({ ...doc, items: [...doc.items, { name: 'b' }] }))
    await store.flush()

    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      items: [{ name: 'a', pinned: true }, { name: 'b' }],
      syncedAt: 5
    })
  })
})

describe('JsonStore with a file it cannot use', () => {
  it('replaces the file straight after the copy is safe', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, '{ not json')
    await open(filePath)
    expect(await readFile(`${filePath}.unreadable`, 'utf8')).toBe('{ not json')
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(fallback())
  })

  it('makes one copy of the same broken file, however often it opens', async () => {
    // A store that never manages to write: the broken file is there on every start.
    const filePath = await tempPath()
    await writeFile(filePath, '{ not json')
    const unwritable: DocumentCodec = {
      encode: () => {
        throw new Error('encode failed')
      },
      decode: plainJsonDocumentCodec.decode
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await open(filePath, unwritable)
      await open(filePath, unwritable)
    } finally {
      error.mockRestore()
    }
    expect(await listing(filePath)).toEqual([
      basename(filePath),
      `${basename(filePath)}.unreadable`
    ])
  })

  it('stays read-only with defaults when the copy fails, and still opens', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = await JsonStore.open<Doc>({
        filePath,
        schema: docSchema,
        fallback,
        migrations: [],
        criticality: 'degradable',
        debounceMs: 0,
        copies: fullDisk()
      })

      expect(store.get()).toEqual(fallback())
      expect(store.readOnly).toBe(true)
      expect(store.diagnostics.load).toMatchObject({ kind: 'invalid', copy: null })
      store.update((doc) => ({ ...doc, items: ['x'] }))
      await store.flush()
      expect(await readFile(filePath, 'utf8')).toBe('{ not json')
      expect(await listing(filePath)).toEqual([basename(filePath)])
    } finally {
      warn.mockRestore()
    }
  })

  it('stays read-only when the file is there but cannot be read at all', async () => {
    // A directory under the file's name: the read fails, so does the copy, and nothing is written
    // over something nobody has looked at.
    const filePath = await tempPath()
    await mkdir(filePath)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = await open(filePath)
      expect(store.readOnly).toBe(true)
      expect(store.diagnostics.load).toMatchObject({ kind: 'invalid', copy: null })
    } finally {
      warn.mockRestore()
    }
  })

  it('does not write because a repair changed something', async () => {
    // A repair can drop what it cannot place, and the file keeps it until the user changes something.
    const filePath = await tempPath()
    const original = JSON.stringify({ version: 1, items: ['a', 'a'] })
    await writeFile(filePath, original)
    const codec = countingCodec()
    const store = await JsonStore.open<Doc>({
      filePath,
      schema: docSchema,
      fallback,
      migrations: [],
      criticality: 'degradable',
      codec,
      debounceMs: 0,
      repair: (doc) => ({ ...doc, items: [...new Set(doc.items)] })
    })

    expect(store.diagnostics.repairedOnLoad).toBe(true)
    expect(codec.encodes()).toBe(0)
    expect(await readFile(filePath, 'utf8')).toBe(original)
  })
})

describe('JsonStore with tolerant entries', () => {
  async function openTolerant(filePath: string): Promise<JsonStore<Doc>> {
    return JsonStore.open<Doc>({
      filePath,
      schema: docSchema,
      fallback,
      migrations: [],
      criticality: 'critical',
      tolerant: { field: 'items', entry: z.string() },
      debounceMs: 0
    })
  }

  it('loads the readable entries and writes the unreadable ones back where they were', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 1, items: ['a', 5, 'b'] }))

    const store = await openTolerant(filePath)
    expect(store.get().items).toEqual(['a', 'b'])
    expect(store.unreadableEntries).toEqual([{ index: 1, value: 5 }])

    store.update((doc) => ({ ...doc, items: [...doc.items, 'c'] }))
    await store.flush()
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      items: ['a', 5, 'b', 'c']
    })
  })

  it('forgets the unreadable entries a deletion covers, and only those', async () => {
    const filePath = await tempPath()
    await writeFile(filePath, JSON.stringify({ version: 1, items: [1, 'a', 2] }))
    const store = await openTolerant(filePath)

    store.discardUnreadableEntries((entry) => entry.value === 99)
    expect(store.unreadableEntries).toHaveLength(2)

    store.discardUnreadableEntries((entry) => entry.value === 1)
    await store.flush()
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 1, items: ['a', 2] })

    store.discardUnreadableEntries()
    await store.flush()
    expect(store.unreadableEntries).toEqual([])
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 1, items: ['a'] })
  })

  it('forgets them in memory only on a degradable store that may not write', async () => {
    // Migrated, but without a backup: read-only, and a deletion must not sneak a write in.
    const filePath = await tempPath()
    const original = JSON.stringify({ version: 1, items: ['a', 5] })
    await writeFile(filePath, original)
    const codec = countingCodec()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = await openV2(filePath, {
        codec,
        copies: fullDisk(),
        tolerant: { field: 'entries', entry: z.string() }
      })
      expect(store.unreadableEntries).toEqual([{ index: 1, value: 5 }])

      store.discardUnreadableEntries()
      await store.flush()
      expect(store.unreadableEntries).toEqual([])
      expect(codec.encodes()).toBe(0)
      expect(await readFile(filePath, 'utf8')).toBe(original)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('JsonStore removing its copies', () => {
  it('takes every copy of the data along when a category is cleared (AE8)', async () => {
    const filePath = await tempPath('history.json')
    const visit = {
      url: 'https://old.example/',
      title: 'Old',
      firstVisitedAt: 1,
      lastVisitedAt: 1,
      visitCount: 1
    }
    await writeFile(filePath, JSON.stringify({ version: 1, visits: [visit] }))
    // What a migration and an earlier broken start would have left beside it.
    await writeFile(`${filePath}.v1.bak`, JSON.stringify({ version: 1, visits: [visit] }))
    await writeFile(`${filePath}.unreadable`, 'old.example')

    const history = await HistoryStore.open({ filePath, debounceMs: 60_000 })
    history.clear()
    await history.discardCopies()

    expect(await listing(filePath)).toEqual(['history.json'])
    // Written before the copies went, although the debounce had not fired yet.
    expect(await readFile(filePath, 'utf8')).not.toContain('old.example')
  })

  it('removes the copies of a read-only store without writing its file', async () => {
    const filePath = await tempPath()
    const newer = JSON.stringify({ version: 2 })
    await writeFile(filePath, newer)
    await writeFile(`${filePath}.v1.bak`, 'older')
    const store = await open(filePath)

    await store.discardCopies()

    expect(await listing(filePath)).toEqual([basename(filePath)])
    expect(await readFile(filePath, 'utf8')).toBe(newer)
  })

  it('rejects when a copy cannot be removed, and keeps working afterwards', async () => {
    const filePath = await tempPath()
    const store = await JsonStore.open<Doc>({
      filePath,
      schema: docSchema,
      fallback,
      migrations: [],
      criticality: 'degradable',
      debounceMs: 0,
      copies: { ...fullDisk(), readdir: () => Promise.reject(failure('EACCES')) }
    })

    await expect(store.discardCopies()).rejects.toMatchObject({ code: 'EACCES' })
    // The failure is not left in the write queue for the next write to trip over.
    store.update((doc) => ({ ...doc, items: ['after'] }))
    await store.flush()
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ version: 1, items: ['after'] })
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
