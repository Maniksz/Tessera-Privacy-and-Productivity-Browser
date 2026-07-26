import { describe, expect, it } from 'vitest'
import {
  BOOKMARK_BAR_ID,
  BOOKMARK_OTHER_ID,
  BookmarkLimitError,
  BookmarkNestingError,
  BookmarkNotFoundError,
  InvalidBookmarkUrlError,
  MAX_BOOKMARKS,
  MAX_BOOKMARK_TITLE_LENGTH,
  MAX_BOOKMARK_URL_LENGTH,
  barBookmarks,
  bookmarkUrlOf,
  bookmarksForUrl,
  childrenOf,
  countChildren,
  createBookmark,
  descendantIdsOf,
  emptyBookmarkDocument,
  findBookmark,
  folderPath,
  isBookmarkKind,
  isBookmarkRootId,
  isBookmarked,
  moveBookmark,
  normalizeBookmarkUrl,
  queryBookmarks,
  relocateBookmark,
  removeBookmark,
  removeChildrenOf,
  repairBookmarks,
  rootIdOf,
  updateBookmark,
  type Bookmark
} from '@shared/bookmarks/model.js'

/**
 * The bookmark tree.
 *
 * Every test here is about a rule that is invisible from the outside until it is broken: a
 * folder that took its grandchildren with it or, worse, did not; a folder moved inside itself;
 * a file whose `parentId`s form a ring. Those are the cases a one-level model like quick links
 * never has to think about, and they are the reason this file exists rather than being covered
 * by the store's tests.
 */

const T0 = 1_700_000_000_000

interface TreeBuilder {
  nodes: Bookmark[]
  add(input: {
    kind?: 'bookmark' | 'folder'
    title?: string
    url?: string
    parentId?: string
    index?: number
  }): string
}

/** A builder, so a test reads as the shape of the tree rather than as six `createBookmark` calls. */
function tree(): TreeBuilder {
  let counter = 0
  const builder: TreeBuilder = {
    nodes: [],
    add: (input) => {
      counter += 1
      const id = `n${counter}`
      const kind = input.kind ?? 'bookmark'
      builder.nodes = createBookmark(
        builder.nodes,
        {
          kind,
          title: input.title ?? '',
          ...(kind === 'folder' ? {} : { url: input.url ?? `https://example.com/${id}` }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          ...(input.index === undefined ? {} : { index: input.index })
        },
        { id, now: T0 + counter }
      )
      return id
    }
  }
  return builder
}

describe('the shape of a bookmark document', () => {
  it('starts with no nodes and two roots that are not nodes', () => {
    const document = emptyBookmarkDocument()
    expect(document).toEqual({ version: 1, nodes: [] })
    // The roots exist as ids without existing as data, which is what makes them
    // undeletable and unrenameable by construction.
    expect(isBookmarkRootId(BOOKMARK_BAR_ID)).toBe(true)
    expect(isBookmarkRootId(BOOKMARK_OTHER_ID)).toBe(true)
    expect(isBookmarkRootId('n1')).toBe(false)
  })

  it('recognises its own kinds and nothing else', () => {
    expect(isBookmarkKind('folder')).toBe(true)
    expect(isBookmarkKind('bookmark')).toBe(true)
    expect(isBookmarkKind('link')).toBe(false)
    expect(isBookmarkKind(7)).toBe(false)
  })

  it('files a new bookmark under other bookmarks when no parent is named', () => {
    // Not the bar: adding to the bar changes visible chrome, so it has to be asked for.
    const book = tree()
    book.add({})
    expect(childrenOf(book.nodes, BOOKMARK_OTHER_ID)).toHaveLength(1)
    expect(barBookmarks(book.nodes)).toEqual([])
  })
})

describe('addresses', () => {
  it('accepts what the address bar would accept', () => {
    expect(bookmarkUrlOf('example.com')).toBe('https://example.com/')
    expect(bookmarkUrlOf('  https://example.com/a  ')).toBe('https://example.com/a')
    expect(bookmarkUrlOf('search terms here')).toBeNull()
    expect(bookmarkUrlOf('')).toBeNull()
  })

  it('gives one page one key however its address was typed', () => {
    /*
      A defect found by writing this test, in `classifyOmniboxInput` rather than here.

      It answers `https://example.com` for the typed text `example.com` and
      `https://example.com/` for `https://example.com` — the first is a raw concatenation, the
      second went through the URL parser. As navigation targets those are the same page, so
      nothing ever noticed. As a bookmark *identity* they are two different bookmarks: the star
      reads as off on a page that is bookmarked, and the user saves it twice.

      `bookmarkUrlOf` therefore re-parses an http(s) result. The same defect affects
      `normalizeQuickLinkUrl`, which does not — see the handover notes.
    */
    expect(bookmarkUrlOf('example.com')).toBe(bookmarkUrlOf('https://example.com'))
    expect(bookmarkUrlOf('example.com')).toBe(bookmarkUrlOf('https://example.com/'))
    expect(bookmarkUrlOf('EXAMPLE.com/a')).toBe(bookmarkUrlOf('https://example.com/a'))
  })

  it('leaves an internal address exactly as the classifier decided', () => {
    // Bookmarking the settings page is legitimate, and the internal scheme is opaque: putting
    // it through the URL parser could only change it for the worse.
    const internal = bookmarkUrlOf('tessera://settings')
    expect(internal).toBe('tessera://settings')
  })

  it('refuses a bookmarklet', () => {
    /*
      The single most important refusal in this model.

      A `javascript:` bookmark runs in the origin of whatever page is open when it is clicked,
      so importing or typing one is a stored cross-site-scripting primitive with a friendly
      name. The decision is deferred to `classifyOmniboxInput` rather than made again here.
    */
    expect(bookmarkUrlOf('javascript:alert(document.cookie)')).toBeNull()
    expect(bookmarkUrlOf('data:text/html,<script>x()</script>')).toBeNull()
    expect(() => normalizeBookmarkUrl('javascript:void 0')).toThrow(InvalidBookmarkUrlError)
  })

  it('keeps the fragment, unlike history', () => {
    // A bookmark to a heading in a long document is very often the whole point of saving it,
    // where a history entry per anchor would be noise.
    expect(bookmarkUrlOf('https://example.com/guide#installation')).toBe(
      'https://example.com/guide#installation'
    )
  })

  it('strips tracking parameters, because the address will be requested again for years', () => {
    expect(bookmarkUrlOf('https://example.com/a?utm_source=news&id=7')).toBe(
      'https://example.com/a?id=7'
    )
  })

  it('refuses an address past the length limit rather than storing a cut one', () => {
    const long = `https://example.com/${'a'.repeat(MAX_BOOKMARK_URL_LENGTH)}`
    expect(bookmarkUrlOf(long)).toBeNull()
  })

  it('answers the star from the normalised address, not the raw one', () => {
    /*
      What makes the star in the address bar stable.

      A page that adds a campaign parameter to its own URL would otherwise turn the star off,
      and the user would bookmark the same page twice.
    */
    const book = tree()
    book.add({ url: 'https://example.com/a?id=7' })
    expect(isBookmarked(book.nodes, 'https://example.com/a?id=7&utm_campaign=x')).toBe(true)
    expect(bookmarksForUrl(book.nodes, 'https://example.com/a?id=7')).toHaveLength(1)
    expect(bookmarksForUrl(book.nodes, 'javascript:x')).toEqual([])
    expect(isBookmarked(book.nodes, 'https://other.example/')).toBe(false)
  })
})

describe('titles', () => {
  it('falls back to the host when a bookmark is unnamed', () => {
    const book = tree()
    book.add({ title: '   ', url: 'https://www.example.com/deep/page' })
    expect(book.nodes[0]?.title).toBe('example.com')
  })

  it('collapses the whitespace a page or an imported file brings with it', () => {
    const book = tree()
    book.add({ title: ' Two\n\tlines ' })
    expect(book.nodes[0]?.title).toBe('Two lines')
  })

  it('leaves an unnamed folder unnamed, because there is no address to borrow', () => {
    const book = tree()
    book.add({ kind: 'folder', title: '  ' })
    expect(book.nodes[0]?.title).toBe('')
  })

  it('bounds a title a page set to a novel', () => {
    const book = tree()
    book.add({ title: 'x'.repeat(MAX_BOOKMARK_TITLE_LENGTH + 50) })
    expect(book.nodes[0]?.title).toHaveLength(MAX_BOOKMARK_TITLE_LENGTH)
  })
})

describe('folders as containers', () => {
  it('refuses to put anything inside a bookmark', () => {
    const book = tree()
    const leaf = book.add({})
    expect(() => book.add({ parentId: leaf })).toThrow(BookmarkNestingError)
  })

  it('refuses a parent that does not exist', () => {
    const book = tree()
    expect(() => book.add({ parentId: 'ghost' })).toThrow(BookmarkNotFoundError)
  })

  it('nests folders to any depth, unlike quick links', () => {
    const book = tree()
    const outer = book.add({ kind: 'folder', title: 'Outer', parentId: BOOKMARK_BAR_ID })
    const middle = book.add({ kind: 'folder', title: 'Middle', parentId: outer })
    const inner = book.add({ kind: 'folder', title: 'Inner', parentId: middle })
    const leaf = book.add({ title: 'Leaf', parentId: inner })

    expect(rootIdOf(book.nodes, leaf)).toBe(BOOKMARK_BAR_ID)
    expect(folderPath(book.nodes, leaf).map((node) => node.title)).toEqual([
      'Outer',
      'Middle',
      'Inner'
    ])
  })

  it('counts only direct children', () => {
    const book = tree()
    const folder = book.add({ kind: 'folder', parentId: BOOKMARK_BAR_ID })
    const nested = book.add({ kind: 'folder', parentId: folder })
    book.add({ parentId: nested })
    expect(countChildren(book.nodes, folder)).toBe(1)
    expect(descendantIdsOf(book.nodes, folder).size).toBe(2)
  })

  it('reports no path and no root for a node outside the tree', () => {
    expect(folderPath([], 'ghost')).toEqual([])
    expect(rootIdOf([], 'ghost')).toBeNull()
  })

  it('puts a folder’s first child next to the folder in the array', () => {
    /*
      Not cosmetic. The array order is what a person reads when they open the file, and what
      any future export walks. Scattering a nested folder's first child to the end of the
      document makes every later diff look like a rearrangement.
    */
    const book = tree()
    const first = book.add({ title: 'First', parentId: BOOKMARK_OTHER_ID })
    const folder = book.add({ kind: 'folder', title: 'Folder', parentId: BOOKMARK_OTHER_ID })
    const last = book.add({ title: 'Last', parentId: BOOKMARK_OTHER_ID })
    const child = book.add({ title: 'Child', parentId: folder })

    expect(book.nodes.map((node) => node.id)).toEqual([first, folder, child, last])
  })
})

describe('ordering among siblings', () => {
  it('appends when no index is given and inserts at one when it is', () => {
    const book = tree()
    const a = book.add({ title: 'A', parentId: BOOKMARK_BAR_ID })
    const b = book.add({ title: 'B', parentId: BOOKMARK_BAR_ID })
    const middle = book.add({ title: 'M', parentId: BOOKMARK_BAR_ID, index: 1 })
    expect(barBookmarks(book.nodes).map((node) => node.id)).toEqual([a, middle, b])
  })

  it('lands at the end when the index overshoots, rather than failing', () => {
    // A drag that overshoots the last row should land at the end. Refusing would make the
    // gesture feel broken at exactly the edge where people aim least precisely.
    const book = tree()
    const a = book.add({ title: 'A', parentId: BOOKMARK_BAR_ID })
    const b = book.add({ title: 'B', parentId: BOOKMARK_BAR_ID, index: 99 })
    expect(barBookmarks(book.nodes).map((node) => node.id)).toEqual([a, b])
  })

  it('clamps a negative index to the front', () => {
    const book = tree()
    const a = book.add({ title: 'A', parentId: BOOKMARK_BAR_ID })
    const b = book.add({ title: 'B', parentId: BOOKMARK_BAR_ID, index: -5 })
    expect(barBookmarks(book.nodes).map((node) => node.id)).toEqual([b, a])
  })

  it('reorders within a folder without touching the other root', () => {
    const book = tree()
    const barA = book.add({ title: 'A', parentId: BOOKMARK_BAR_ID })
    const barB = book.add({ title: 'B', parentId: BOOKMARK_BAR_ID })
    const other = book.add({ title: 'O', parentId: BOOKMARK_OTHER_ID })

    const moved = moveBookmark(book.nodes, barB, BOOKMARK_BAR_ID, 0)
    expect(barBookmarks(moved).map((node) => node.id)).toEqual([barB, barA])
    expect(childrenOf(moved, BOOKMARK_OTHER_ID).map((node) => node.id)).toEqual([other])
  })
})

describe('moving', () => {
  it('refuses to move a folder into itself', () => {
    const book = tree()
    const folder = book.add({ kind: 'folder', parentId: BOOKMARK_BAR_ID })
    expect(() => moveBookmark(book.nodes, folder, folder, 0)).toThrow(BookmarkNestingError)
  })

  it('refuses to move a folder into one of its own descendants', () => {
    /*
      The trap a one-level model never meets.

      Allowing it succeeds silently: the ring of folders is reachable from no root, so it
      vanishes from every listing while still counting against the limit — and any traversal
      without a `seen` set would hang rather than report it.
    */
    const book = tree()
    const outer = book.add({ kind: 'folder', parentId: BOOKMARK_BAR_ID })
    const middle = book.add({ kind: 'folder', parentId: outer })
    const inner = book.add({ kind: 'folder', parentId: middle })

    expect(() => moveBookmark(book.nodes, outer, inner, 0)).toThrow(BookmarkNestingError)
    // And a grandchild moving up into its own grandparent is fine, which is the case the
    // refusal above must not also catch.
    expect(() => moveBookmark(book.nodes, inner, BOOKMARK_BAR_ID, 0)).not.toThrow()
  })

  it('refuses to move something that is not there', () => {
    expect(() => moveBookmark([], 'ghost', BOOKMARK_BAR_ID, 0)).toThrow(BookmarkNotFoundError)
  })

  it('moves a whole subtree between roots by moving its folder', () => {
    const book = tree()
    const folder = book.add({ kind: 'folder', title: 'F', parentId: BOOKMARK_OTHER_ID })
    const child = book.add({ title: 'C', parentId: folder })

    const moved = moveBookmark(book.nodes, folder, BOOKMARK_BAR_ID, 0)
    expect(rootIdOf(moved, child)).toBe(BOOKMARK_BAR_ID)
    // The child's own `parentId` is untouched: the subtree travels with its folder rather
    // than being rewritten, which is what keeps a move O(1) in the number of descendants.
    expect(findBookmark(moved, child)?.parentId).toBe(folder)
  })
})

describe('deleting', () => {
  it('takes a folder’s grandchildren with it', () => {
    /*
      The one place bookmarks genuinely differ from quick links.

      Quick links nest one level, so deleting the direct children is complete there. Here a
      folder holds folders: taking only the direct children would leave grandchildren naming a
      parent that no longer exists — counted against the limit, listed nowhere, and brought
      back somewhere unexpected by the next repair. Data loss followed by data resurrection.
    */
    const book = tree()
    const outer = book.add({ kind: 'folder', parentId: BOOKMARK_BAR_ID })
    const middle = book.add({ kind: 'folder', parentId: outer })
    book.add({ parentId: middle })
    const survivor = book.add({ parentId: BOOKMARK_BAR_ID })

    const after = removeBookmark(book.nodes, outer)
    expect(after.map((node) => node.id)).toEqual([survivor])
  })

  it('refuses to delete something that is not there', () => {
    expect(() => removeBookmark([], 'ghost')).toThrow(BookmarkNotFoundError)
  })

  it('empties a root without deleting the root', () => {
    const book = tree()
    book.add({ parentId: BOOKMARK_BAR_ID })
    const folder = book.add({ kind: 'folder', parentId: BOOKMARK_BAR_ID })
    book.add({ parentId: folder })
    const kept = book.add({ parentId: BOOKMARK_OTHER_ID })

    const after = removeChildrenOf(book.nodes, BOOKMARK_BAR_ID)
    expect(after.map((node) => node.id)).toEqual([kept])
    expect(isBookmarkRootId(BOOKMARK_BAR_ID)).toBe(true)
  })
})

describe('editing', () => {
  it('renames a bookmark and a folder', () => {
    const book = tree()
    const folder = book.add({ kind: 'folder', title: 'Old', parentId: BOOKMARK_BAR_ID })
    const leaf = book.add({ title: 'Old leaf', parentId: folder })

    const renamed = updateBookmark(updateBookmark(book.nodes, folder, { title: 'New' }), leaf, {
      title: 'New leaf'
    })
    expect(findBookmark(renamed, folder)?.title).toBe('New')
    expect(findBookmark(renamed, leaf)?.title).toBe('New leaf')
  })

  it('refuses to give a folder an address', () => {
    const book = tree()
    const folder = book.add({ kind: 'folder', parentId: BOOKMARK_BAR_ID })
    expect(() => updateBookmark(book.nodes, folder, { url: 'https://example.com/' })).toThrow(
      BookmarkNestingError
    )
    expect(() => relocateBookmark(book.nodes, folder, 'https://example.com/')).toThrow(
      BookmarkNestingError
    )
  })

  it('refuses to edit something that is not there', () => {
    expect(() => updateBookmark([], 'ghost', { title: 'x' })).toThrow(BookmarkNotFoundError)
    expect(() => relocateBookmark([], 'ghost', 'https://example.com/')).toThrow(
      BookmarkNotFoundError
    )
  })

  it('re-derives a blanked title from the new address', () => {
    const book = tree()
    const leaf = book.add({ title: 'Name', url: 'https://example.com/a', parentId: BOOKMARK_BAR_ID })
    const updated = updateBookmark(book.nodes, leaf, { title: '', url: 'https://other.example/b' })
    expect(findBookmark(updated, leaf)?.title).toBe('other.example')
  })
})

describe('a bookmark whose page has moved', () => {
  it('keeps the title, the folder and the position', () => {
    /*
      Why `relocateBookmark` exists instead of "delete and add again".

      The obvious alternative loses the name the user typed, the folder they filed it in, and
      the row's position — and a broken bookmark is precisely the case where all three matter,
      because the user is repairing something they built.
    */
    const book = tree()
    const folder = book.add({ kind: 'folder', parentId: BOOKMARK_BAR_ID })
    const first = book.add({ title: 'First', parentId: folder })
    const moved = book.add({ title: 'My name', url: 'https://old.example/a', parentId: folder })
    const last = book.add({ title: 'Last', parentId: folder })

    const after = relocateBookmark(book.nodes, moved, 'https://new.example/b')
    const entry = findBookmark(after, moved)
    expect(entry?.url).toBe('https://new.example/b')
    expect(entry?.title).toBe('My name')
    expect(entry?.parentId).toBe(folder)
    expect(childrenOf(after, folder).map((node) => node.id)).toEqual([first, moved, last])
  })

  it('follows the address when the title was only ever the host', () => {
    // A placeholder name must not stay behind as the name of somewhere the bookmark no longer
    // goes. A name the user typed does stay, which the test above pins.
    const book = tree()
    const leaf = book.add({ title: '', url: 'https://old.example/a', parentId: BOOKMARK_BAR_ID })
    expect(findBookmark(book.nodes, leaf)?.title).toBe('old.example')

    const after = relocateBookmark(book.nodes, leaf, 'https://new.example/b')
    expect(findBookmark(after, leaf)?.title).toBe('new.example')
  })

  it('refuses an address that is not one', () => {
    const book = tree()
    const leaf = book.add({ parentId: BOOKMARK_BAR_ID })
    expect(() => relocateBookmark(book.nodes, leaf, 'not an address at all')).toThrow(
      InvalidBookmarkUrlError
    )
  })
})

describe('searching', () => {
  it('matches title and address, and keeps folders that match by name', () => {
    const book = tree()
    const folder = book.add({ kind: 'folder', title: 'Recipes', parentId: BOOKMARK_BAR_ID })
    const inside = book.add({ title: 'Bread', url: 'https://bake.example/', parentId: folder })
    book.add({ title: 'Unrelated', url: 'https://other.example/', parentId: BOOKMARK_OTHER_ID })

    // The folder is kept because somebody searching for "Recipes" is usually looking for it.
    expect(queryBookmarks(book.nodes, { text: 'recipes' }).map((node) => node.id)).toEqual([folder])
    expect(queryBookmarks(book.nodes, { text: 'bake.example' }).map((node) => node.id)).toEqual([
      inside
    ])
  })

  it('restricts to one root when asked, including nodes nested inside it', () => {
    const book = tree()
    const folder = book.add({ kind: 'folder', title: 'F', parentId: BOOKMARK_BAR_ID })
    const nested = book.add({ title: 'Deep', parentId: folder })
    const other = book.add({ title: 'Deep too', parentId: BOOKMARK_OTHER_ID })

    expect(
      queryBookmarks(book.nodes, { text: 'deep', rootId: BOOKMARK_BAR_ID }).map((node) => node.id)
    ).toEqual([nested])
    expect(
      queryBookmarks(book.nodes, { text: 'deep', rootId: BOOKMARK_OTHER_ID }).map((node) => node.id)
    ).toEqual([other])
  })

  it('returns everything for empty text and honours a limit', () => {
    const book = tree()
    book.add({ parentId: BOOKMARK_BAR_ID })
    book.add({ parentId: BOOKMARK_BAR_ID })
    expect(queryBookmarks(book.nodes, {})).toHaveLength(2)
    expect(queryBookmarks(book.nodes, { limit: 1 })).toHaveLength(1)
    expect(queryBookmarks(book.nodes, { limit: -3 })).toHaveLength(0)
  })
})

describe('the limit', () => {
  it('refuses a new bookmark once the document is full', () => {
    const nodes: Bookmark[] = Array.from({ length: MAX_BOOKMARKS }, (_unused, index) => ({
      id: `n${index}`,
      kind: 'bookmark' as const,
      title: 'x',
      url: 'https://example.com/',
      parentId: BOOKMARK_OTHER_ID,
      createdAt: T0 + index
    }))
    expect(() =>
      createBookmark(nodes, { kind: 'bookmark', title: 'one more', url: 'https://example.com/' }, {
        id: 'extra',
        now: T0
      })
    ).toThrow(BookmarkLimitError)
  })

  it('drops the newest, not the oldest, when a file arrives over the cap', () => {
    /*
      The opposite of what history does, deliberately.

      History drops the least recently visited because recency is what makes an entry useful
      there. A bookmark has no recency — it is kept because somebody chose to keep it — so an
      over-full file must lose what arrived last rather than the collection built years ago.
    */
    const nodes: Bookmark[] = Array.from({ length: MAX_BOOKMARKS + 2 }, (_unused, index) => ({
      id: `n${index}`,
      kind: 'bookmark' as const,
      title: `t${index}`,
      url: `https://example.com/${index}`,
      parentId: BOOKMARK_OTHER_ID,
      createdAt: T0 + index
    }))
    const repaired = repairBookmarks(nodes)
    expect(repaired).toHaveLength(MAX_BOOKMARKS)
    expect(repaired.some((node) => node.id === 'n0')).toBe(true)
    expect(repaired.some((node) => node.id === `n${MAX_BOOKMARKS + 1}`)).toBe(false)
  })
})

describe('repairing a document that arrived wrong', () => {
  const node = (overrides: Partial<Bookmark> & { id: string }): Bookmark => ({
    kind: 'bookmark',
    title: 'T',
    url: 'https://example.com/',
    parentId: BOOKMARK_OTHER_ID,
    createdAt: T0,
    ...overrides
  })

  it('re-parents an orphan to other bookmarks, never to the bar', () => {
    // Silently adding rows to the bar on startup would rearrange the interface in front of
    // the user. "Other bookmarks" is where something recovered belongs.
    const repaired = repairBookmarks([node({ id: 'a', parentId: 'ghost' })])
    expect(repaired[0]?.parentId).toBe(BOOKMARK_OTHER_ID)
  })

  it('re-parents a node whose parent is a bookmark rather than a folder', () => {
    const repaired = repairBookmarks([
      node({ id: 'leaf' }),
      node({ id: 'child', parentId: 'leaf' })
    ])
    expect(findBookmark(repaired, 'child')?.parentId).toBe(BOOKMARK_OTHER_ID)
  })

  it('drops a duplicate id, keeping the first', () => {
    // Two nodes with one id make every lookup answer whichever came first, so a delete
    // removes one row and an update writes to the other.
    const repaired = repairBookmarks([
      node({ id: 'a', title: 'first' }),
      node({ id: 'a', title: 'second' })
    ])
    expect(repaired).toHaveLength(1)
    expect(repaired[0]?.title).toBe('first')
  })

  it('drops a node that claims a reserved root id', () => {
    // A node with the bar's id would shadow the root, and every child of the bar would then
    // resolve to it.
    const repaired = repairBookmarks([node({ id: BOOKMARK_BAR_ID, kind: 'folder', url: '' })])
    expect(repaired).toEqual([])
  })

  it('clears an address a folder should not have', () => {
    const repaired = repairBookmarks([
      node({ id: 'f', kind: 'folder', url: 'https://example.com/' })
    ])
    expect(repaired[0]?.url).toBe('')
  })

  it('breaks a ring of folders', () => {
    /*
      The repair that is not merely tidiness.

      Without it, every traversal in the model relies on its own `seen` guard to terminate and
      those guards are silently load-bearing for ever. With it, they are a second line.
    */
    const repaired = repairBookmarks([
      node({ id: 'a', kind: 'folder', url: '', parentId: 'b' }),
      node({ id: 'b', kind: 'folder', url: '', parentId: 'a' })
    ])
    expect(repaired.map((entry) => entry.parentId)).toEqual([BOOKMARK_OTHER_ID, BOOKMARK_OTHER_ID])
    expect(rootIdOf(repaired, 'a')).toBe(BOOKMARK_OTHER_ID)
  })

  it('leaves a healthy document alone', () => {
    const book = tree()
    const folder = book.add({ kind: 'folder', parentId: BOOKMARK_BAR_ID })
    book.add({ parentId: folder })
    expect(repairBookmarks(book.nodes)).toEqual(book.nodes)
  })

  it('does not delete a bookmark whose scheme this build would refuse', () => {
    /*
      Deliberately *not* re-validating addresses.

      Narrowing what counts as an address later would then delete every affected bookmark on
      the next start — a data-loss trap disguised as a cleanup. `repairHistory` documents the
      same decision.
    */
    const repaired = repairBookmarks([node({ id: 'a', url: 'gopher://example.com/' })])
    expect(repaired[0]?.url).toBe('gopher://example.com/')
  })

  it('heals the orphans a prune creates', () => {
    /*
      Found by writing this test rather than by reading the code.

      `pruneToLimit` drops nodes by age, and nothing guarantees a folder is older than its
      contents — an imported file carries the exporting browser's timestamps. So a prune can
      take a folder and leave its children behind, which is exactly the dangling `parentId`
      the first repair pass had just fixed.
    */
    const folder = node({
      id: 'young-folder',
      kind: 'folder',
      url: '',
      // Newer than every child, so the prune takes the folder and not them.
      createdAt: T0 + 10_000_000
    })
    const children = Array.from({ length: MAX_BOOKMARKS }, (_unused, index) =>
      node({ id: `c${index}`, parentId: 'young-folder', createdAt: T0 + index })
    )

    const repaired = repairBookmarks([folder, ...children])
    expect(repaired.some((entry) => entry.id === 'young-folder')).toBe(false)
    for (const entry of repaired) {
      expect(rootIdOf(repaired, entry.id), entry.id).not.toBeNull()
    }
  })
})
