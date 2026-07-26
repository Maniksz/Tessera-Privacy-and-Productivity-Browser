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
    // A *kind* error, not an amount: a string where a number belongs means the file was not
    // written by us, and defaults are the only safe answer.
    await writeDocument(filePath, { version: 1, nodes: [{ id: 'a', createdAt: 'yesterday' }] })

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
