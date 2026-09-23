import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BookmarkStore } from '@main/data/BookmarkStore.js'
import { plainJsonDocumentCodec } from '@main/data/JsonStore.js'
import {
  BOOKMARK_BAR_ID,
  BOOKMARK_OTHER_ID,
  childrenOf,
  type Bookmark,
  type BookmarkDocument
} from '@shared/bookmarks/model.js'

/**
 * The bookmark store: identity, the clock, the write path and the file.
 *
 * Ids and timestamps are injected in every test but one, so nothing depends on when the run
 * happened; the exception is the test for the default generator, which is the only place a
 * real clock is legitimately the subject.
 *
 * Assertions about what was written read the file from disk rather than trusting the
 * in-memory answer — that is the difference between "the store agrees with itself" and "the
 * next launch will see this".
 */

const T0 = 1_700_000_000_000

interface Fixture {
  store: BookmarkStore
  filePath: string
}

async function openStore(options: { debounceMs?: number; codec?: boolean } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-bookmarks-'))
  const filePath = join(dir, 'bookmarks.json')
  let step = 0
  const tick = (): number => {
    step += 1
    return T0 + step * 1_000
  }
  let ids = 0

  const store = await BookmarkStore.open({
    filePath,
    // No debounce by default: the assertions read the file straight after a write.
    debounceMs: options.debounceMs ?? 0,
    now: tick,
    generateId: () => {
      ids += 1
      return `b${ids}`
    },
    ...(options.codec === true ? { codec: plainJsonDocumentCodec } : {})
  })
  return { store, filePath }
}

async function storedNodes(filePath: string): Promise<Bookmark[]> {
  const text = await readFile(filePath, 'utf8')
  return (JSON.parse(text) as BookmarkDocument).nodes
}

async function writeDocument(filePath: string, document: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(document), 'utf8')
}

describe('opening', () => {
  it('starts empty when there is no file yet', async () => {
    const { store } = await openStore()
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('falls back to an empty collection when the file is not ours', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-bookmarks-'))
    const filePath = join(dir, 'bookmarks.json')
    // A *kind* error in the envelope, not an amount: a string where the version belongs means the
    // file was not written by us, and defaults are the only safe answer. The same error in one node
    // costs only that node; see "an entry this version cannot read".
    await writeDocument(filePath, { version: 'one', nodes: [] })

    const store = await BookmarkStore.open({ filePath, debounceMs: 0 })
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)
  })

  it('repairs a document rather than discarding it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-bookmarks-'))
    const filePath = join(dir, 'bookmarks.json')
    await writeDocument(filePath, {
      version: 1,
      nodes: [
        { id: 'a', kind: 'bookmark', title: 'A', url: 'https://a.example/', parentId: 'ghost', createdAt: T0 }
      ]
    })

    const store = await BookmarkStore.open({ filePath, debounceMs: 0 })
    // An amount or an inconsistency is healed, not rejected: losing somebody's whole
    // collection because one `parentId` was wrong would be the worst possible reading of it.
    expect(store.recoveredFromInvalidFile).toBe(false)
    expect(store.list()[0]?.parentId).toBe(BOOKMARK_OTHER_ID)
  })

  it('reads a document back through the codec it was written with', async () => {
    const { store, filePath } = await openStore({ codec: true })
    store.create({ kind: 'bookmark', title: 'A', url: 'https://a.example/' })
    await store.flush()

    const reopened = await BookmarkStore.open({
      filePath,
      debounceMs: 0,
      codec: plainJsonDocumentCodec
    })
    expect(reopened.list().map((node) => node.title)).toEqual(['A'])
  })
})

describe('writing', () => {
  it('creates a bookmark and puts it on disk', async () => {
    const { store, filePath } = await openStore()
    const created = store.create({
      kind: 'bookmark',
      title: 'News',
      url: 'news.example',
      parentId: BOOKMARK_BAR_ID
    })
    expect(created.id).toBe('b1')
    // Normalised by the model on the way in, not by the caller.
    expect(created.url).toBe('https://news.example/')
    await store.flush()
    expect(await storedNodes(filePath)).toHaveLength(1)
  })

  it('renames and relocates without losing the folder or the position', async () => {
    const { store } = await openStore()
    const folder = store.create({ kind: 'folder', title: 'F', parentId: BOOKMARK_BAR_ID })
    store.create({ kind: 'bookmark', title: 'First', url: 'https://a.example/', parentId: folder.id })
    const moved = store.create({
      kind: 'bookmark',
      title: 'Mine',
      url: 'https://old.example/',
      parentId: folder.id
    })

    store.update(moved.id, { title: 'Still mine' })
    const relocated = store.relocate(moved.id, 'https://new.example/')
    expect(relocated.url).toBe('https://new.example/')
    expect(relocated.title).toBe('Still mine')
    expect(childrenOf(store.list(), folder.id).map((node) => node.title)).toEqual([
      'First',
      'Still mine'
    ])
  })

  it('reports how many nodes a folder deletion took', async () => {
    // The count is the only confirmation the user gets, and a folder deletion is transitive.
    const { store } = await openStore()
    const folder = store.create({ kind: 'folder', title: 'F', parentId: BOOKMARK_BAR_ID })
    const nested = store.create({ kind: 'folder', title: 'N', parentId: folder.id })
    store.create({ kind: 'bookmark', title: 'Leaf', url: 'https://a.example/', parentId: nested.id })

    expect(store.remove(folder.id)).toBe(3)
    expect(store.list()).toEqual([])
  })

  it('moves a node between roots', async () => {
    const { store } = await openStore()
    const node = store.create({ kind: 'bookmark', title: 'A', url: 'https://a.example/' })
    store.move(node.id, BOOKMARK_BAR_ID, 0)
    expect(childrenOf(store.list(), BOOKMARK_BAR_ID).map((entry) => entry.id)).toEqual([node.id])
  })

  it('answers the star and the search from what it holds', async () => {
    const { store } = await openStore()
    store.create({ kind: 'bookmark', title: 'A', url: 'https://a.example/page?utm_source=x' })
    expect(store.isBookmarked('https://a.example/page')).toBe(true)
    expect(store.forUrl('https://a.example/page')).toHaveLength(1)
    expect(store.query({ text: 'a.example' })).toHaveLength(1)
    expect(store.query()).toHaveLength(1)
  })

  it('tells listeners when the collection changed', async () => {
    const { store } = await openStore()
    const seen: number[] = []
    const unsubscribe = store.onChange((nodes) => seen.push(nodes.length))
    store.create({ kind: 'bookmark', title: 'A', url: 'https://a.example/' })
    unsubscribe()
    store.create({ kind: 'bookmark', title: 'B', url: 'https://b.example/' })
    expect(seen).toEqual([1])
  })

  it('generates a readable id of its own when none is injected', async () => {
    // The one test where a real clock is the subject. A readable id matters because a user may
    // open this file to inspect it.
    const dir = await mkdtemp(join(tmpdir(), 'tessera-bookmarks-'))
    const store = await BookmarkStore.open({ filePath: join(dir, 'bookmarks.json'), debounceMs: 0 })
    const created = store.create({ kind: 'bookmark', title: 'A', url: 'https://a.example/' })
    expect(created.id).toMatch(/^bm-[0-9a-z]+-[0-9a-z]+$/)
  })

  it('lets a refusal out rather than storing something invalid', async () => {
    const { store } = await openStore()
    expect(() => store.create({ kind: 'bookmark', title: 'X', url: 'javascript:void 0' })).toThrow()
    expect(() => store.update('ghost', { title: 'x' })).toThrow()
    expect(() => store.relocate('ghost', 'https://a.example/')).toThrow()
    expect(store.list()).toEqual([])
  })
})

describe('importing a file', () => {
  const EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p><DT><A HREF="https://news.example/">News</A></DL><p>
  <DT><A HREF="javascript:void 0">Bookmarklet</A>
  <DT><A HREF="https://elsewhere.example/">Elsewhere</A>
</DL><p>`

  it('takes the text and never a path', async () => {
    /*
      The store is handed the file's *contents*.

      The path comes from the OS picker in the IPC handler, exactly as `extensions:load` does,
      so a compromised renderer cannot ask the core to read an arbitrary file and hand back
      what is in it.
    */
    const { store, filePath } = await openStore()
    const summary = store.import(EXPORT, 'Imported bookmarks')

    expect(summary.skipped).toBe(1)
    expect(summary.imported).toBeGreaterThan(1)
    expect(childrenOf(store.list(), BOOKMARK_BAR_ID).map((node) => node.title)).toEqual(['News'])
    // On disk, not merely in memory.
    await store.flush()
    expect(await storedNodes(filePath)).toHaveLength(summary.imported)
  })

  it('adds to what is already there rather than replacing it', async () => {
    const { store } = await openStore()
    store.create({ kind: 'bookmark', title: 'Mine', url: 'https://mine.example/', parentId: BOOKMARK_BAR_ID })
    store.import(EXPORT, 'Imported bookmarks')
    expect(childrenOf(store.list(), BOOKMARK_BAR_ID).map((node) => node.title)).toEqual([
      'Mine',
      'News'
    ])
  })
})

describe('flushing', () => {
  it('coalesces writes and still lands them', async () => {
    // The debounce is what keeps a burst of edits from rewriting and re-encrypting the whole
    // document once per keystroke; `flush` is what makes it survive a quit.
    const { store, filePath } = await openStore({ debounceMs: 50 })
    store.create({ kind: 'bookmark', title: 'A', url: 'https://a.example/' })
    store.create({ kind: 'bookmark', title: 'B', url: 'https://b.example/' })
    await store.flush()
    expect(await storedNodes(filePath)).toHaveLength(2)
  })
})

describe('a file from another version', () => {
  const node = {
    id: 'kept',
    kind: 'bookmark',
    title: 'Kept',
    url: 'https://example.com/',
    parentId: BOOKMARK_BAR_ID,
    createdAt: T0
  }

  async function seeded(document: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-bookmarks-'))
    const filePath = join(dir, 'bookmarks.json')
    await writeFile(filePath, JSON.stringify(document), 'utf8')
    return filePath
  }

  it('keeps a field a newer version added under the same version when it saves', async () => {
    // R25: running an older build must not strip what a newer one wrote.
    const filePath = await seeded({ version: 1, nodes: [{ ...node, tags: ['work'] }], sync: 'x' })
    const store = await BookmarkStore.open({ filePath, debounceMs: 0, generateId: () => 'b1' })

    store.create({
      kind: 'bookmark',
      title: 'New',
      url: 'https://example.org/',
      parentId: BOOKMARK_OTHER_ID
    })
    await store.flush()

    const written = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    expect(written['sync']).toBe('x')
    expect((written['nodes'] as Record<string, unknown>[])[0]).toMatchObject({
      id: 'kept',
      tags: ['work']
    })
  })

  it('shows a newer version’s bookmarks but refuses a new one, and leaves the file alone (AE1)', async () => {
    const newer = { version: 2, nodes: [node] }
    const filePath = await seeded(newer)
    const store = await BookmarkStore.open({ filePath, debounceMs: 0 })

    expect(store.list().map((bookmark) => bookmark.id)).toEqual(['kept'])
    expect(store.loadReport).toEqual({
      outcome: { kind: 'newer', version: 2 },
      criticality: 'critical'
    })
    expect(() =>
      store.create({
        kind: 'bookmark',
        title: 'New',
        url: 'https://example.org/',
        parentId: BOOKMARK_OTHER_ID
      })
    ).toThrow(/read-only/)
    await store.flush()
    expect(await readFile(filePath, 'utf8')).toBe(JSON.stringify(newer))
  })
})

describe('an entry this version cannot read', () => {
  /*
    R3: one broken node costs that node, not the collection. It is kept as it was stored, written
    back where it was, and never listed, searched or offered.
  */
  const at = (id: string, parentId: string, kind = 'bookmark'): Record<string, unknown> => ({
    id,
    kind,
    title: id,
    url: kind === 'folder' ? '' : `https://${id}.example/`,
    parentId,
    createdAt: T0
  })

  async function seeded(nodes: unknown[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-bookmarks-'))
    const filePath = join(dir, 'bookmarks.json')
    await writeDocument(filePath, { version: 1, nodes })
    return filePath
  }

  const newBookmark = {
    kind: 'bookmark',
    title: 'New',
    url: 'https://new.example/',
    parentId: BOOKMARK_OTHER_ID
  } as const

  it('keeps a separator raw, loads the rest and writes it back where it was', async () => {
    const separator = { id: 'sep', kind: 'separator', parentId: BOOKMARK_BAR_ID, createdAt: T0 }
    const filePath = await seeded([at('a', BOOKMARK_BAR_ID), separator, at('b', BOOKMARK_BAR_ID)])
    const store = await BookmarkStore.open({ filePath, debounceMs: 0, generateId: () => 'n1' })

    expect(store.list().map((node) => node.id)).toEqual(['a', 'b'])
    expect(store.unreadableEntryCount).toBe(1)
    expect(store.query({ text: 'sep' })).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(false)

    store.update('a', { title: 'A renamed' })
    await store.flush()
    const written = await storedNodes(filePath)
    expect(written[1]).toEqual(separator)
    expect(written.map((node) => node.id)).toEqual(['a', 'sep', 'b'])
  })

  it('leaves the readable children of an unreadable folder in it', async () => {
    const folder = { ...at('raw', BOOKMARK_BAR_ID, 'folder'), title: 42 }
    const filePath = await seeded([folder, at('child', 'raw')])
    const store = await BookmarkStore.open({ filePath, debounceMs: 0 })

    expect(store.list()).toMatchObject([{ id: 'child', parentId: 'raw' }])
    expect(store.unreadableEntryCount).toBe(1)
  })

  it('never gives a new bookmark the id an unreadable one carries', async () => {
    const filePath = await seeded([{ id: 'n1', kind: 'separator', parentId: BOOKMARK_BAR_ID }])
    const store = await BookmarkStore.open({ filePath, debounceMs: 0, generateId: () => 'n1' })

    const created = store.create(newBookmark)
    expect(created.id).not.toBe('n1')
    const second = store.create(newBookmark)
    expect(new Set([created.id, second.id, 'n1']).size).toBe(3)

    store.import('<DL><DT><A HREF="https://imported.example/">Imported</A></DL>', 'Imported')
    await store.flush()
    const ids = (await storedNodes(filePath)).map((node) => node.id)
    expect(ids).toHaveLength(5)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('takes an unreadable node along when a folder above it is deleted', async () => {
    const filePath = await seeded([
      at('top', BOOKMARK_BAR_ID, 'folder'),
      { id: 'raw', kind: 'separator', parentId: 'top' },
      at('deep', 'raw'),
      { id: 'elsewhere', kind: 'separator', parentId: BOOKMARK_OTHER_ID },
      at('kept', BOOKMARK_OTHER_ID)
    ])
    const store = await BookmarkStore.open({ filePath, debounceMs: 0 })
    expect(store.unreadableEntryCount).toBe(2)

    // The folder, the unreadable node in it and the bookmark below that.
    expect(store.remove('top')).toBe(3)
    expect(store.unreadableEntryCount).toBe(1)
    await store.flush()
    // The survivor goes back at its index, or at the end of a list that has since become shorter.
    expect((await storedNodes(filePath)).map((node) => node.id)).toEqual(['kept', 'elsewhere'])
  })

  it('refuses a move that would close a ring through an unreadable folder', async () => {
    const filePath = await seeded([
      at('a', BOOKMARK_BAR_ID, 'folder'),
      { id: 'raw', kind: 'separator', parentId: 'a' },
      at('c', 'raw', 'folder')
    ])
    const store = await BookmarkStore.open({ filePath, debounceMs: 0 })
    expect(() => store.move('a', 'c', 0)).toThrow(/own folders/)
  })

  it('copies a document aside whose node list is not a list at all', async () => {
    const filePath = await seeded([])
    await writeDocument(filePath, { version: 1, nodes: 'not a list' })
    const store = await BookmarkStore.open({ filePath, debounceMs: 0 })

    expect(store.recoveredFromInvalidFile).toBe(true)
    expect(store.unreadableEntryCount).toBe(0)
    expect(JSON.parse(await readFile(`${filePath}.unreadable`, 'utf8'))).toEqual({
      version: 1,
      nodes: 'not a list'
    })
  })
})
